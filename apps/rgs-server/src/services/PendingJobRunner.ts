import { config } from '../config.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { decryptSecret } from '../utils/secrets.js';
import { HttpWalletAdapter } from '../wallet/HttpWalletAdapter.js';
import { WalletClient } from '../wallet/WalletClient.js';
import {
  type BalanceRequest,
  type AwardRequest,
  type BetRequest,
  type RollbackRequest,
  isSuccessOrDuplicate,
  type WinRequest,
} from '../wallet/types.js';

interface JobPayload {
  requestUuid: string;
  transactionUuid: string;
  referenceTransactionUuid?: string;
  playerRef: string;
  currency: string;
  gameCode: string;
  amountMicro?: string;
  roundId?: string;
  tournamentId?: string;
  prizeRef?: string;
  rank?: number;
}

const POLL_INTERVAL_MS = 5000;
const LOCK_TTL_MS = 60_000;
const MAX_ATTEMPTS = 12;

export class PendingJobRunner {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('PendingJobRunner started');
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Execute a single attempt against one job id.
   *
   * @internal — tests use this to avoid the 5-second polling tick; production
   * code always goes through `start()` and the scheduler. Takes the row lock,
   * runs the wallet call, reschedules on failure, marks completed on success.
   */
  async runJobOnce(jobId: string): Promise<void> {
    await this.runJob(jobId);
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => logger.error('PendingJobRunner tick error', { err: err.message }))
        .finally(() => this.schedule());
    }, POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const jobs = await prisma.pendingWalletJob.findMany({
      where: {
        completedAt: null,
        nextAttemptAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      take: 10,
    });
    for (const job of jobs) {
      try {
        await this.runJob(job.id);
      } catch (err) {
        logger.error('job run failed', { jobId: job.id, err: (err as Error).message });
      }
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const lockedUntil = new Date(Date.now() + LOCK_TTL_MS);
    const locked = await prisma.pendingWalletJob.updateMany({
      where: { id: jobId, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      data: { lockedUntil },
    });
    if (locked.count === 0) return;

    const job = await prisma.pendingWalletJob.findUnique({ where: { id: jobId } });
    if (!job || job.completedAt) return;

    const payload = job.payload as unknown as JobPayload;
    const adapter = await this.buildAdapter(job.operatorId);
    if (!adapter) {
      await this.reschedule(jobId, job.attempts + 1, 'no_outbound_credential');
      logger.warn('job cannot find outbound credential', { jobId, operatorId: job.operatorId });
      return;
    }
    const client = new WalletClient(job.operatorId, adapter);

    const common = {
      requestUuid: payload.requestUuid,
      operatorId: job.operatorId,
      playerRef: payload.playerRef,
      currency: payload.currency,
      gameCode: payload.gameCode,
    };

    try {
      let status: string;
      if (job.endpoint === 'WIN' && payload.amountMicro && payload.referenceTransactionUuid && payload.roundId) {
        const req: WinRequest = {
          ...common,
          transactionUuid: payload.transactionUuid,
          referenceTransactionUuid: payload.referenceTransactionUuid,
          amountMicro: BigInt(payload.amountMicro),
          roundId: payload.roundId,
        };
        const res = await client.win(req, { roundId: job.roundId ?? undefined, attempt: job.attempts + 1 });
        status = res.status;
      } else if (job.endpoint === 'ROLLBACK' && payload.referenceTransactionUuid) {
        const req: RollbackRequest = {
          ...common,
          transactionUuid: payload.transactionUuid,
          referenceTransactionUuid: payload.referenceTransactionUuid,
          roundId: payload.roundId,
        };
        const res = await client.rollback(req, { roundId: job.roundId ?? undefined, attempt: job.attempts + 1 });
        status = res.status;
      } else if (job.endpoint === 'BET' && payload.amountMicro && payload.roundId) {
        const req: BetRequest = {
          ...common,
          transactionUuid: payload.transactionUuid,
          amountMicro: BigInt(payload.amountMicro),
          roundId: payload.roundId,
        };
        const res = await client.bet(req, { roundId: job.roundId ?? undefined, attempt: job.attempts + 1 });
        status = res.status;
      } else if (job.endpoint === 'AWARD' && payload.amountMicro && payload.prizeRef) {
        const req: AwardRequest = {
          ...common,
          transactionUuid: payload.transactionUuid,
          amountMicro: BigInt(payload.amountMicro),
          prizeRef: payload.prizeRef,
          tournamentId: payload.tournamentId,
          rank: payload.rank,
        };
        const res = await client.award(req, { attempt: job.attempts + 1 });
        status = res.status;
      } else if (job.endpoint === 'BALANCE') {
        const req: BalanceRequest = common;
        const res = await client.balance(req, { attempt: job.attempts + 1 });
        status = res.status;
      } else {
        status = 'MALFORMED_JOB';
      }

      if (isSuccessOrDuplicate(status as never) || status === 'RS_ERROR_TRANSACTION_DOES_NOT_EXIST') {
        await prisma.pendingWalletJob.update({
          where: { id: jobId },
          data: { completedAt: new Date(), lockedUntil: null, attempts: job.attempts + 1 },
        });
        // wallet_job_succeeded_total
        logger.info('wallet_job_succeeded', { jobId, endpoint: job.endpoint, attempt: job.attempts + 1 });
      } else {
        await this.reschedule(jobId, job.attempts + 1, status);
      }
    } catch (err) {
      await this.reschedule(jobId, job.attempts + 1, (err as Error).message);
    }
  }

  private async reschedule(jobId: string, attempts: number, lastError: string): Promise<void> {
    if (attempts >= MAX_ATTEMPTS) {
      await prisma.pendingWalletJob.update({
        where: { id: jobId },
        data: { attempts, lastError, lockedUntil: null, nextAttemptAt: new Date(Date.now() + 3600_000) },
      });
      logger.error('wallet_job_exhausted', { jobId, attempts, lastError });
      return;
    }
    const delayMs = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
    await prisma.pendingWalletJob.update({
      where: { id: jobId },
      data: {
        attempts,
        lastError,
        nextAttemptAt: new Date(Date.now() + delayMs),
        lockedUntil: null,
      },
    });
    logger.warn('wallet_job_retry', { jobId, attempts, delayMs, lastError });
  }

  private async buildAdapter(operatorId: string) {
    const op = await prisma.operator.findUnique({ where: { id: operatorId } });
    if (!op) return null;
    const cred = await prisma.operatorCredential.findFirst({
      where: { operatorId, type: 'WALLET_HMAC_OUTBOUND', revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (!cred || !op.walletCallbackUrl) return null;
    return new HttpWalletAdapter({
      operatorId,
      kid: cred.kid,
      secret: decryptSecret(Buffer.from(cred.cipherBlob)),
      walletCallbackUrl: op.walletCallbackUrl,
      timeoutMs: config.walletCallTimeoutMs,
    });
  }
}

export const pendingJobRunner = new PendingJobRunner();
