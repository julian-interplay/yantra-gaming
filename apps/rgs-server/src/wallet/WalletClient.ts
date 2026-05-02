import { prisma } from '../db.js';
import { logger } from '../logger.js';
import {
  hashRow,
  latestWalletCallTip,
  walletCallHashInput,
} from '../services/AuditChain.js';
import {
  circuitBreakerState,
  walletAuditWriteFailures,
  walletCallErrorsTotal,
  walletCallLatencyMs,
  walletCallTotal,
} from '../telemetry/index.js';
import { CircuitBreaker, type CircuitState } from './CircuitBreaker.js';
import type { WalletAdapter } from './WalletAdapter.js';
import {
  type BalanceRequest,
  type BetRequest,
  isRejectStatus,
  type RollbackRequest,
  RsStatus,
  type WalletResponse,
  type WinRequest,
} from './types.js';

const STATE_TO_NUMBER: Record<CircuitState, number> = {
  CLOSED: 0,
  HALF_OPEN: 1,
  OPEN: 2,
};

export interface AuditContext {
  sessionId?: string;
  roundId?: string;
  attempt?: number;
}

/**
 * Wraps a WalletAdapter with:
 *   • an append-only audit row (WalletCall) written before AND after the call
 *   • a per-(operator, endpoint) circuit breaker that short-circuits to a
 *     synthetic TIMEOUT when the operator endpoint is sustained-broken
 *
 * The game engine uses this, not the adapter directly. Short-circuited
 * requests route through the same "rollback + retry queue" path as real
 * timeouts — no special handling needed upstream.
 */
export class WalletClient {
  private readonly breaker: CircuitBreaker;

  constructor(
    public readonly operatorId: string,
    private readonly adapter: WalletAdapter,
    breakerOptions?: { failureThreshold?: number; cooldownMs?: number },
  ) {
    this.breaker = new CircuitBreaker({
      failureThreshold: breakerOptions?.failureThreshold ?? 5,
      cooldownMs: breakerOptions?.cooldownMs ?? 30_000,
    });
  }

  /** Observability — snapshot circuit state per endpoint. */
  breakerSnapshot() {
    return this.breaker.snapshot();
  }

  async balance(req: BalanceRequest, audit: AuditContext = {}): Promise<WalletResponse> {
    return this.invoke('BALANCE', req, audit, () => this.adapter.balance(req));
  }

  async bet(req: BetRequest, audit: AuditContext = {}): Promise<WalletResponse> {
    return this.invoke('BET', req, audit, () => this.adapter.bet(req), {
      transactionUuid: req.transactionUuid,
      amountMicro: req.amountMicro,
      roundId: req.roundId,
    });
  }

  async win(req: WinRequest, audit: AuditContext = {}): Promise<WalletResponse> {
    return this.invoke('WIN', req, audit, () => this.adapter.win(req), {
      transactionUuid: req.transactionUuid,
      referenceTransactionUuid: req.referenceTransactionUuid,
      amountMicro: req.amountMicro,
      roundId: req.roundId,
    });
  }

  async rollback(req: RollbackRequest, audit: AuditContext = {}): Promise<WalletResponse> {
    return this.invoke('ROLLBACK', req, audit, () => this.adapter.rollback(req), {
      transactionUuid: req.transactionUuid,
      referenceTransactionUuid: req.referenceTransactionUuid,
      roundId: req.roundId,
    });
  }

  private async invoke(
    endpoint: 'BALANCE' | 'BET' | 'WIN' | 'ROLLBACK',
    req: BalanceRequest | BetRequest | WinRequest | RollbackRequest,
    audit: AuditContext,
    run: () => Promise<WalletResponse>,
    extra?: {
      transactionUuid?: string;
      referenceTransactionUuid?: string;
      amountMicro?: bigint;
      roundId?: string;
    },
  ): Promise<WalletResponse> {
    // Circuit-breaker short-circuit for state-changing wallet calls. BALANCE is
    // read-only display data; failures should be logged/audited, but must not
    // suppress later balance refreshes or affect gameplay settlement behavior.
    const useCircuitBreaker = endpoint !== 'BALANCE';
    const breakerKey = `${this.operatorId}:${endpoint}`;
    if (useCircuitBreaker) {
      const decision = this.breaker.tryAcquire(breakerKey);
      circuitBreakerState.set(
        { operator: this.operatorId, endpoint },
        STATE_TO_NUMBER[decision.state],
      );
      if (!decision.allow) {
        logger.warn('wallet_circuit_short_circuit', {
          operatorId: this.operatorId,
          endpoint,
          state: decision.state,
        });
        walletCallTotal.inc({
          operator: this.operatorId,
          endpoint,
          status: 'SHORT_CIRCUIT',
        });
        return {
          status: RsStatus.TIMEOUT,
          requestUuid: req.requestUuid,
          message: decision.state === 'OPEN' ? 'circuit_open' : 'circuit_probing',
        };
      }
    }

    const started = Date.now();
    let call: Awaited<ReturnType<typeof prisma.walletCall.create>> | null = null;
    try {
      call = await prisma.walletCall.create({
        data: {
          operatorId: this.operatorId,
          direction: 'OUTBOUND',
          endpoint,
          requestUuid: req.requestUuid,
          transactionUuid: extra?.transactionUuid,
          referenceTransactionUuid: extra?.referenceTransactionUuid,
          sessionId: audit.sessionId,
          roundId: audit.roundId ?? extra?.roundId,
          playerRef: req.playerRef,
          amountMicro: extra?.amountMicro,
          currency: req.currency,
          requestBody: serialiseBody(req),
          attempt: audit.attempt ?? 1,
        },
      });
    } catch (err) {
      // If the audit row fails we still must NOT block the wallet call, but we must log.
      // The metric is alertable — a non-zero rate means the ledger is dropping
      // rows, which breaks reconciliation guarantees.
      logger.error('wallet audit pre-write failed', { err: (err as Error).message, endpoint });
      walletAuditWriteFailures.inc({
        operator: this.operatorId,
        endpoint,
        phase: 'pre',
      });
    }

    const response = await run();
    const latencyMs = Date.now() - started;
    const succeeded = response.status === RsStatus.OK;

    // Emit telemetry — the latency/status breakdown is what SLO dashboards query.
    const labels = { operator: this.operatorId, endpoint };
    walletCallLatencyMs.observe(labels, latencyMs);
    walletCallTotal.inc({ ...labels, status: response.status });
    if (!succeeded && !isRejectStatus(response.status)) {
      walletCallErrorsTotal.inc({ ...labels, rs_status: response.status });
    }

    // Record circuit-breaker outcome. Operator-side business rejects (insufficient
    // funds, limit reached, user disabled, duplicate tx) are NOT infrastructure
    // failures — they're valid answers from a healthy wallet. Don't punish them.
    if (useCircuitBreaker) {
      if (succeeded || isRejectStatus(response.status) || response.status === RsStatus.DUPLICATE_TRANSACTION) {
        this.breaker.recordSuccess(breakerKey);
      } else {
        this.breaker.recordFailure(breakerKey);
      }
    }

    if (call) {
      try {
        // Tamper-evident audit chain: compute rowHash over the FINAL row
        // (request + response + latency + succeeded) linked to the
        // per-operator tip. We intentionally chain at post-write time —
        // the regulator cares about the final evidence, not the in-flight
        // intermediate state. A separate re-chain job (AuditChain.backfill)
        // covers any row where post-write failed below.
        const prevRowHash = await latestWalletCallTip(this.operatorId).catch(
          () => null,
        );
        const finalRow = {
          ...call,
          responseStatus: response.status,
          responseBody: serialiseBody(response),
          httpStatus: null,
          latencyMs,
          succeeded,
        };
        const rowHash = hashRow(prevRowHash, walletCallHashInput(finalRow));
        await prisma.walletCall.update({
          where: { id: call.id },
          data: {
            responseStatus: response.status,
            responseBody: serialiseBody(response),
            latencyMs,
            succeeded,
            prevRowHash,
            rowHash,
          },
        });
      } catch (err) {
        logger.error('wallet audit post-write failed', {
          err: (err as Error).message,
          endpoint,
          requestUuid: req.requestUuid,
        });
        walletAuditWriteFailures.inc({
          operator: this.operatorId,
          endpoint,
          phase: 'post',
        });
      }
    }

    return response;
  }
}

function serialiseBody(obj: unknown): object {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as object;
}
