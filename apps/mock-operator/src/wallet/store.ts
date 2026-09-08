// In-memory wallet store for the mock operator.
//
// The real operator would back this with their PAM database. For dev we just
// hold balances in a Map keyed by `${operatorId}:${playerRef}`.
//
// Idempotency is enforced per the wallet-spec contract:
//   * bet / win / rollback each carry a stable `transactionUuid` that must
//     return the same result on replay (DUPLICATE_TRANSACTION on conflicting
//     retries of unknown shape, or just re-return the recorded result).
//   * We also remember which bet transactionUuids have already been rolled
//     back so a second rollback returns cleanly instead of double-crediting.

import { RsStatus, type RsStatus as RsStatusT } from '@yantra/wallet-spec';

type Key = string; // `${operatorId}:${playerRef}`

function keyOf(operatorId: string, playerRef: string): Key {
  return `${operatorId}:${playerRef}`;
}

// Initial balance: LKR 10,000 expressed in micro-units (× 100,000).
const SEED_BALANCE_MICRO = 1_000_000_000n;

const SEED_PLAYERS = ['p-alice', 'p-bob', 'p-charlie'] as const;

interface Wallet {
  balanceMicro: bigint;
}

// What kind of ledger entry a transactionUuid represents.
type TxKind = 'bet' | 'win' | 'award';

interface LedgerEntry {
  kind: TxKind;
  key: Key;
  amountMicro: bigint;
  // Set once a rollback has reversed this entry — prevents a second rollback
  // from moving funds again (second call returns RS_OK idempotently).
  rolledBack: boolean;
}

class WalletStore {
  private readonly wallets = new Map<Key, Wallet>();

  // Ledger of completed bet/win entries, keyed by their transactionUuid.
  // Used for idempotency and rollback lookups.
  private readonly ledger = new Map<string, LedgerEntry>();

  // Any requestUuid we've already answered, mapped to the balance we returned.
  // Idempotent replays get the same numbers back.
  private readonly processed = new Map<string, bigint>();

  // Rollback transactionUuids we've seen — rollback itself must be idempotent.
  private readonly rollbackTxs = new Set<string>();

  constructor(operatorId: string) {
    for (const p of SEED_PLAYERS) {
      this.wallets.set(keyOf(operatorId, p), { balanceMicro: SEED_BALANCE_MICRO });
    }
  }

  /** Seeded player refs — lobby uses this to render the roster. */
  seededPlayers(): readonly string[] {
    return SEED_PLAYERS;
  }

  /** Look up or lazily create a wallet for this key. */
  private getOrInit(key: Key): Wallet {
    let w = this.wallets.get(key);
    if (!w) {
      w = { balanceMicro: SEED_BALANCE_MICRO };
      this.wallets.set(key, w);
    }
    return w;
  }

  /** Read-only balance (for /balance endpoint and the lobby debug dump). */
  balance(operatorId: string, playerRef: string): bigint {
    return this.getOrInit(keyOf(operatorId, playerRef)).balanceMicro;
  }

  /** Snapshot for the lobby UI / debug endpoint. */
  dump(): Array<{ key: string; balanceMicro: string }> {
    return [...this.wallets.entries()].map(([key, w]) => ({
      key,
      balanceMicro: w.balanceMicro.toString(),
    }));
  }

  /**
   * Debit for a bet. Result shape follows the RS_* error code semantics in
   * wallet-spec.
   */
  bet(
    operatorId: string,
    playerRef: string,
    transactionUuid: string,
    amountMicro: bigint,
  ): { status: RsStatusT; balanceMicro: bigint } {
    const key = keyOf(operatorId, playerRef);
    const wallet = this.getOrInit(key);

    // Idempotent replay of the same bet transactionUuid.
    const existing = this.ledger.get(transactionUuid);
    if (existing) {
      if (existing.kind !== 'bet' || existing.key !== key || existing.amountMicro !== amountMicro) {
        // Same UUID reused for a different operation — reject.
        return { status: RsStatus.DUPLICATE_TRANSACTION, balanceMicro: wallet.balanceMicro };
      }
      // Replay: just re-return current balance. No double-debit.
      return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
    }

    if (amountMicro <= 0n) {
      return { status: RsStatus.WRONG_SYNTAX, balanceMicro: wallet.balanceMicro };
    }
    if (wallet.balanceMicro < amountMicro) {
      return { status: RsStatus.NOT_ENOUGH_MONEY, balanceMicro: wallet.balanceMicro };
    }

    wallet.balanceMicro -= amountMicro;
    this.ledger.set(transactionUuid, { kind: 'bet', key, amountMicro, rolledBack: false });
    return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
  }

  /**
   * Credit for a win. Must reference a known bet transactionUuid — but we
   * don't enforce that the bet existed here, because in the wild the RGS may
   * (legitimately) send wins that reference bets the operator has already
   * pruned. We log the win regardless.
   */
  win(
    operatorId: string,
    playerRef: string,
    transactionUuid: string,
    amountMicro: bigint,
  ): { status: RsStatusT; balanceMicro: bigint } {
    const key = keyOf(operatorId, playerRef);
    const wallet = this.getOrInit(key);

    const existing = this.ledger.get(transactionUuid);
    if (existing) {
      if (existing.kind !== 'win' || existing.key !== key || existing.amountMicro !== amountMicro) {
        return { status: RsStatus.DUPLICATE_TRANSACTION, balanceMicro: wallet.balanceMicro };
      }
      return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
    }

    if (amountMicro < 0n) {
      return { status: RsStatus.WRONG_SYNTAX, balanceMicro: wallet.balanceMicro };
    }

    wallet.balanceMicro += amountMicro;
    this.ledger.set(transactionUuid, { kind: 'win', key, amountMicro, rolledBack: false });
    return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
  }

  award(
    operatorId: string,
    playerRef: string,
    transactionUuid: string,
    amountMicro: bigint,
  ): { status: RsStatusT; balanceMicro: bigint } {
    const key = keyOf(operatorId, playerRef);
    const wallet = this.getOrInit(key);

    const existing = this.ledger.get(transactionUuid);
    if (existing) {
      if (existing.kind !== 'award' || existing.key !== key || existing.amountMicro !== amountMicro) {
        return { status: RsStatus.DUPLICATE_TRANSACTION, balanceMicro: wallet.balanceMicro };
      }
      return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
    }

    if (amountMicro < 0n) {
      return { status: RsStatus.WRONG_SYNTAX, balanceMicro: wallet.balanceMicro };
    }

    wallet.balanceMicro += amountMicro;
    this.ledger.set(transactionUuid, { kind: 'award', key, amountMicro, rolledBack: false });
    return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
  }

  /**
   * Rollback a previous bet or win. Idempotent: replaying with the same
   * `transactionUuid` returns OK without moving funds again.
   */
  rollback(
    operatorId: string,
    playerRef: string,
    rollbackTxUuid: string,
    referenceTxUuid: string,
  ): { status: RsStatusT; balanceMicro: bigint } {
    const key = keyOf(operatorId, playerRef);
    const wallet = this.getOrInit(key);

    // Replay of the rollback itself.
    if (this.rollbackTxs.has(rollbackTxUuid)) {
      return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
    }

    const original = this.ledger.get(referenceTxUuid);
    if (!original) {
      return { status: RsStatus.TRANSACTION_NOT_FOUND, balanceMicro: wallet.balanceMicro };
    }
    if (original.key !== key) {
      // Player/operator mismatch on the referenced tx.
      return { status: RsStatus.TRANSACTION_NOT_FOUND, balanceMicro: wallet.balanceMicro };
    }
    if (original.rolledBack) {
      // Already reversed by a previous (differently-UUID'd) rollback — still
      // idempotent-success so the RGS retry loop can settle.
      this.rollbackTxs.add(rollbackTxUuid);
      return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
    }

    // Reverse the original movement.
    if (original.kind === 'bet') {
      wallet.balanceMicro += original.amountMicro;
    } else {
      wallet.balanceMicro -= original.amountMicro;
      if (wallet.balanceMicro < 0n) {
        // The operator already paid the win out to the player; we can't
        // un-spend money they've since spent. In real life this triggers an
        // ops ticket. For the mock we clamp to zero and flag the state.
        wallet.balanceMicro = 0n;
      }
    }
    original.rolledBack = true;
    this.rollbackTxs.add(rollbackTxUuid);
    return { status: RsStatus.OK, balanceMicro: wallet.balanceMicro };
  }

  /** Request-level idempotency: same requestUuid → same balance reply. */
  rememberRequest(requestUuid: string, balanceMicro: bigint): void {
    this.processed.set(requestUuid, balanceMicro);
  }

  recallRequest(requestUuid: string): bigint | undefined {
    return this.processed.get(requestUuid);
  }
}

// Singleton store — the whole app is one-process by design.
let _store: WalletStore | null = null;

export function getStore(operatorId: string): WalletStore {
  if (!_store) _store = new WalletStore(operatorId);
  return _store;
}
