import type { WalletAdapter } from './WalletAdapter.js';
import {
  type BalanceRequest,
  type AwardRequest,
  type BetRequest,
  type RollbackRequest,
  RsStatus,
  type WalletResponse,
  type WinRequest,
} from './types.js';

/**
 * In-memory wallet for local dev, tests, and Shape-B "internal" operation.
 * Keyed by `${operatorId}::${playerRef}` → balance in micro-units.
 *
 * Idempotency is enforced per transactionUuid. Re-submitting the same tx
 * returns the original result without touching the balance.
 */
export interface InternalWalletSeed {
  operatorId: string;
  playerRef: string;
  currency: string;
  balanceMicro: bigint;
}

export class InternalWalletAdapter implements WalletAdapter {
  private balances = new Map<string, { balance: bigint; currency: string }>();
  private committedTxs = new Map<string, { kind: 'bet' | 'win' | 'award' | 'rollback'; delta: bigint }>();

  constructor(seed: InternalWalletSeed[] = []) {
    for (const s of seed) this.seed(s);
  }

  seed(s: InternalWalletSeed): void {
    this.balances.set(this.key(s.operatorId, s.playerRef), {
      balance: s.balanceMicro,
      currency: s.currency,
    });
  }

  private key(operatorId: string, playerRef: string): string {
    return `${operatorId}::${playerRef}`;
  }

  private getOrCreate(
    operatorId: string,
    playerRef: string,
    currency: string,
  ): { balance: bigint; currency: string } {
    const k = this.key(operatorId, playerRef);
    let row = this.balances.get(k);
    if (!row) {
      row = { balance: 0n, currency };
      this.balances.set(k, row);
    }
    return row;
  }

  async balance(req: BalanceRequest): Promise<WalletResponse> {
    const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
    return {
      status: RsStatus.OK,
      requestUuid: req.requestUuid,
      balanceMicro: row.balance,
      currency: row.currency,
    };
  }

  async bet(req: BetRequest): Promise<WalletResponse> {
    const dup = this.committedTxs.get(req.transactionUuid);
    if (dup) {
      const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
      return {
        status: RsStatus.DUPLICATE_TRANSACTION,
        requestUuid: req.requestUuid,
        balanceMicro: row.balance,
        currency: row.currency,
      };
    }
    const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
    if (row.balance < req.amountMicro) {
      return {
        status: RsStatus.NOT_ENOUGH_MONEY,
        requestUuid: req.requestUuid,
        balanceMicro: row.balance,
        currency: row.currency,
      };
    }
    row.balance -= req.amountMicro;
    this.committedTxs.set(req.transactionUuid, { kind: 'bet', delta: -req.amountMicro });
    return {
      status: RsStatus.OK,
      requestUuid: req.requestUuid,
      balanceMicro: row.balance,
      currency: row.currency,
    };
  }

  async win(req: WinRequest): Promise<WalletResponse> {
    const dup = this.committedTxs.get(req.transactionUuid);
    if (dup) {
      const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
      return {
        status: RsStatus.DUPLICATE_TRANSACTION,
        requestUuid: req.requestUuid,
        balanceMicro: row.balance,
        currency: row.currency,
      };
    }
    const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
    row.balance += req.amountMicro;
    this.committedTxs.set(req.transactionUuid, { kind: 'win', delta: req.amountMicro });
    return {
      status: RsStatus.OK,
      requestUuid: req.requestUuid,
      balanceMicro: row.balance,
      currency: row.currency,
    };
  }

  async award(req: AwardRequest): Promise<WalletResponse> {
    const dup = this.committedTxs.get(req.transactionUuid);
    if (dup) {
      const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
      return {
        status: RsStatus.DUPLICATE_TRANSACTION,
        requestUuid: req.requestUuid,
        balanceMicro: row.balance,
        currency: row.currency,
      };
    }
    const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
    row.balance += req.amountMicro;
    this.committedTxs.set(req.transactionUuid, { kind: 'award', delta: req.amountMicro });
    return {
      status: RsStatus.OK,
      requestUuid: req.requestUuid,
      balanceMicro: row.balance,
      currency: row.currency,
    };
  }

  async rollback(req: RollbackRequest): Promise<WalletResponse> {
    const ref = this.committedTxs.get(req.referenceTransactionUuid);
    if (!ref) {
      return {
        status: RsStatus.TRANSACTION_NOT_FOUND,
        requestUuid: req.requestUuid,
        message: 'unknown_reference_transaction',
      };
    }
    const dup = this.committedTxs.get(req.transactionUuid);
    if (dup) {
      const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
      return {
        status: RsStatus.DUPLICATE_TRANSACTION,
        requestUuid: req.requestUuid,
        balanceMicro: row.balance,
        currency: row.currency,
      };
    }
    const row = this.getOrCreate(req.operatorId, req.playerRef, req.currency);
    // Reverse the referenced transaction.
    row.balance -= ref.delta;
    this.committedTxs.set(req.transactionUuid, { kind: 'rollback', delta: -ref.delta });
    // Invalidate the referenced tx so a subsequent re-rollback fails.
    this.committedTxs.delete(req.referenceTransactionUuid);
    return {
      status: RsStatus.OK,
      requestUuid: req.requestUuid,
      balanceMicro: row.balance,
      currency: row.currency,
    };
  }
}
