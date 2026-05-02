// PendingWalletJob lifecycle — win/rollback retries after operator-side failure.
//
// INVARIANTS (see B2B_ROADMAP.md §8 + §14):
//   1. A /wallet/win that times out is persisted as a PendingWalletJob and
//      eventually completes once the operator wallet recovers.
//   2. Retries follow the schedule in PendingJobRunner (1000 * 2^min(attempts, 8)
//      ms, capped at 5 minutes). WalletCall rows have monotonically increasing
//      attempt numbers for the same transactionUuid.
//   3. After MAX_ATTEMPTS (12) failures, a job is left marked as exhausted —
//      currently via a 1h nextAttemptAt bump + a structured `wallet_job_exhausted`
//      log line. A future `deadLetterAt` column is documented below.
//   4. If the wallet already recognises the transactionUuid (DUPLICATE_TRANSACTION),
//      the RGS treats that as success immediately — no further retries.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { prisma } from '../../apps/rgs-server/src/db.js';
import { PendingJobRunner } from '../../apps/rgs-server/src/services/PendingJobRunner.js';
import { fetchInitialBalanceWithRetry } from '../../apps/rgs-server/src/socket/gameSocket.js';
import { newUuid } from '../../apps/rgs-server/src/utils/uuid.js';
import { HttpWalletAdapter } from '../../apps/rgs-server/src/wallet/HttpWalletAdapter.js';
import { WalletClient } from '../../apps/rgs-server/src/wallet/WalletClient.js';
import { RsStatus } from '../../apps/rgs-server/src/wallet/types.js';
import {
  awaitJobCompletion,
  cleanDb,
  createFakeWallet,
  seedOperator,
  type FakeWallet,
  type SeededOperator,
} from './harness.js';

describe('wallet timeout + retry', () => {
  let fake: FakeWallet;
  let operator: SeededOperator;
  let client: WalletClient;
  let runner: PendingJobRunner;

  const playerRef = 'player-retry-1';
  const currency = 'LKR';

  beforeAll(async () => {
    fake = await createFakeWallet();
  });

  afterAll(async () => {
    await fake.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanDb();
    fake.resetHits();
    fake.setHandler('balance', undefined);
    fake.setHandler('bet', undefined);
    fake.setHandler('win', undefined);
    fake.setHandler('rollback', undefined);

    operator = await seedOperator({ walletCallbackUrl: fake.url });
    fake.seed(playerRef, currency, 10_000_000n);

    const adapter = new HttpWalletAdapter({
      operatorId: operator.operatorId,
      kid: operator.outboundKid,
      secret: operator.outboundSecret,
      walletCallbackUrl: fake.url,
      // Short timeout so the "takes > timeout" test runs fast.
      timeoutMs: 500,
    });
    client = new WalletClient(operator.operatorId, adapter);

    runner = new PendingJobRunner();
  });

  it('initial balance retries after a transient timeout before telling the client it is unavailable', async () => {
    let attempts = 0;
    fake.setHandler('balance', async (body) => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 200,
          delayMs: 1_500,
          body: {
            status: 'RS_OK',
            requestUuid: body.requestUuid,
            balanceMicro: '0',
            currency: body.currency,
          },
        };
      }
      return {
        status: 200,
        body: {
          status: 'RS_OK',
          requestUuid: body.requestUuid,
          balanceMicro: '10000000',
          currency: body.currency,
        },
      };
    });

    const res = await fetchInitialBalanceWithRetry(client, {
      sessionId: newUuid(),
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      maxAttempts: 2,
      retryDelayMs: 1,
    });

    expect(res?.status).toBe(RsStatus.OK);
    expect(res?.balanceMicro).toBe(10_000_000n);
    expect(fake.hits('balance')).toBe(2);

    const calls = await prisma.walletCall.findMany({
      where: { endpoint: 'BALANCE', playerRef },
      orderBy: { createdAt: 'asc' },
    });
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
  });

  it('a win that times out is enqueued as a PendingWalletJob and settles when the wallet recovers', async () => {
    // Make the first WIN call hang past the adapter timeout.
    let attempts = 0;
    fake.setHandler('win', async (body) => {
      attempts += 1;
      if (attempts === 1) {
        // Exceed the 500ms adapter timeout → the adapter aborts → RS_ERROR_TIMEOUT.
        return {
          status: 200,
          delayMs: 1_500,
          body: {
            status: 'RS_OK',
            requestUuid: body.requestUuid,
            balanceMicro: '0',
            currency: body.currency,
          },
        };
      }
      // Subsequent attempts succeed through the default handler.
      return {
        status: 200,
        body: {
          status: 'RS_OK',
          requestUuid: body.requestUuid,
          balanceMicro: '0',
          currency: body.currency,
        },
      };
    });

    const winTx = newUuid();
    const requestUuid = newUuid();
    const res = await client.win({
      requestUuid,
      transactionUuid: winTx,
      referenceTransactionUuid: newUuid(),
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 2_000_000n,
      roundId: newUuid(),
    });
    expect(res.status).toBe(RsStatus.TIMEOUT);

    // The engine, when integrating WalletClient, enqueues a PendingWalletJob on
    // any !isSuccessOrDuplicate response. In this direct-client test we mirror
    // that handoff manually — what the test asserts is PendingJobRunner behaviour.
    const job = await prisma.pendingWalletJob.create({
      data: {
        operatorId: operator.operatorId,
        endpoint: 'WIN',
        payload: {
          requestUuid: newUuid(),
          transactionUuid: winTx,
          referenceTransactionUuid: newUuid(),
          playerRef,
          currency,
          gameCode: 'yantra',
          amountMicro: '2000000',
          roundId: newUuid(),
        },
        lastError: 'RS_ERROR_TIMEOUT',
      },
    });

    runner.start();
    const waited = await awaitJobCompletion(job.id, 30_000);
    runner.stop();

    expect(waited.completed).toBe(true);
    expect(waited.attempts).toBeGreaterThanOrEqual(1);
  });

  it('retry backoff follows the exponential schedule in PendingJobRunner', async () => {
    // The schedule is: delayMs = min(300_000, 1000 * 2^min(attempts, 8))
    // attempts=1 → 2s, attempts=2 → 4s, attempts=3 → 8s, attempts=8 → 256s, cap 300s.
    // We don't wall-clock-wait through retries — we poke the DB state and assert
    // that the runner's reschedule math matches the expected value.
    const job = await prisma.pendingWalletJob.create({
      data: {
        operatorId: operator.operatorId,
        endpoint: 'ROLLBACK',
        payload: {
          requestUuid: newUuid(),
          transactionUuid: newUuid(),
          referenceTransactionUuid: newUuid(),
          playerRef,
          currency,
          gameCode: 'yantra',
          roundId: newUuid(),
        },
        lastError: 'seed',
      },
    });

    // Force the wallet to always fail so the runner reschedules.
    fake.setHandler('rollback', async (body) => ({
      status: 200,
      body: {
        status: 'RS_ERROR_UNKNOWN',
        requestUuid: body.requestUuid,
        message: 'permanent_fault',
      },
    }));

    // Drive one tick manually. We cannot simply .start() and wait because each
    // tick is on a 5s interval and we don't want the test to be wall-clock-bound.
    await runner.runJobOnce(job.id);

    const after1 = await prisma.pendingWalletJob.findUnique({ where: { id: job.id } });
    expect(after1?.attempts).toBe(1);
    // delay for attempts=1 = 1000 * 2^1 = 2000ms; allow 500ms tolerance.
    const delay1 = (after1?.nextAttemptAt?.getTime() ?? 0) - Date.now();
    expect(delay1).toBeGreaterThanOrEqual(1_500);
    expect(delay1).toBeLessThanOrEqual(2_500);

    // Rewind so the runner picks it up again immediately.
    await prisma.pendingWalletJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null },
    });
    await runner.runJobOnce(job.id);

    const after2 = await prisma.pendingWalletJob.findUnique({ where: { id: job.id } });
    expect(after2?.attempts).toBe(2);
    // delay for attempts=2 = 1000 * 2^2 = 4000ms
    const delay2 = (after2?.nextAttemptAt?.getTime() ?? 0) - Date.now();
    expect(delay2).toBeGreaterThanOrEqual(3_500);
    expect(delay2).toBeLessThanOrEqual(4_500);
  });

  it('WalletCall.attempt is monotonically increasing for the same transactionUuid', async () => {
    const txUuid = newUuid();
    // Force the wallet to fail so each runner tick re-issues the call.
    fake.setHandler('rollback', async (body) => ({
      status: 200,
      body: {
        status: 'RS_ERROR_UNKNOWN',
        requestUuid: body.requestUuid,
        message: 'fault',
      },
    }));

    const job = await prisma.pendingWalletJob.create({
      data: {
        operatorId: operator.operatorId,
        endpoint: 'ROLLBACK',
        payload: {
          requestUuid: newUuid(),
          transactionUuid: txUuid,
          referenceTransactionUuid: newUuid(),
          playerRef,
          currency,
          gameCode: 'yantra',
          roundId: newUuid(),
        },
      },
    });

    // Three retry ticks.
    for (let i = 0; i < 3; i++) {
      await prisma.pendingWalletJob.update({
        where: { id: job.id },
        data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null },
      });
      await runner.runJobOnce(job.id);
    }

    const calls = await prisma.walletCall.findMany({
      where: { transactionUuid: txUuid, endpoint: 'ROLLBACK' },
      orderBy: { createdAt: 'asc' },
    });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    // Each successive row has a higher `attempt`.
    let prev = 0;
    for (const c of calls) {
      expect(c.attempt).toBeGreaterThan(prev);
      prev = c.attempt;
    }
  });

  it('after MAX_ATTEMPTS failures the job surfaces as dead-letter', async () => {
    // PendingJobRunner's MAX_ATTEMPTS is 12. After that, the job is left with
    // completedAt=null and nextAttemptAt pushed out by one hour. The operator
    // portal's /reports endpoint treats that pattern as "stuck > 1h" and
    // surfaces the row.
    //
    // TODO: depends on an explicit `deadLetterAt` / `deadLetterReason` pair
    //       landing in prisma/schema.prisma PendingWalletJob. For now this
    //       test asserts the observable proxy: attempts >= 12 AND completedAt
    //       is null AND nextAttemptAt is > 30 minutes in the future.
    const job = await prisma.pendingWalletJob.create({
      data: {
        operatorId: operator.operatorId,
        endpoint: 'ROLLBACK',
        attempts: 11,
        payload: {
          requestUuid: newUuid(),
          transactionUuid: newUuid(),
          referenceTransactionUuid: newUuid(),
          playerRef,
          currency,
          gameCode: 'yantra',
          roundId: newUuid(),
        },
      },
    });

    fake.setHandler('rollback', async (body) => ({
      status: 200,
      body: {
        status: 'RS_ERROR_UNKNOWN',
        requestUuid: body.requestUuid,
      },
    }));

    await prisma.pendingWalletJob.update({
      where: { id: job.id },
      data: { nextAttemptAt: new Date(Date.now() - 1000), lockedUntil: null },
    });
    await runner.runJobOnce(job.id);

    const after = await prisma.pendingWalletJob.findUnique({ where: { id: job.id } });
    expect(after?.attempts).toBe(12);
    expect(after?.completedAt).toBeNull();
    // nextAttemptAt is pushed out by ~1h in reschedule() when attempts >= MAX_ATTEMPTS.
    const pushoutMs = (after?.nextAttemptAt?.getTime() ?? 0) - Date.now();
    expect(pushoutMs).toBeGreaterThan(30 * 60 * 1000);
  });

  it('win for an already-committed transactionUuid returns DUPLICATE_TRANSACTION, treated as success', async () => {
    // Pre-commit the tx on the fake wallet side.
    const winTx = newUuid();
    fake.setHandler('win', async (body) => {
      if (body.transactionUuid === winTx) {
        return {
          status: 200,
          body: {
            status: 'RS_ERROR_DUPLICATE_TRANSACTION',
            requestUuid: body.requestUuid,
            balanceMicro: '12000000',
            currency: body.currency,
          },
        };
      }
      return {
        status: 200,
        body: { status: 'RS_OK', requestUuid: body.requestUuid },
      };
    });

    const res = await client.win({
      requestUuid: newUuid(),
      transactionUuid: winTx,
      referenceTransactionUuid: newUuid(),
      operatorId: operator.operatorId,
      playerRef,
      currency,
      gameCode: 'yantra',
      amountMicro: 1_000_000n,
      roundId: newUuid(),
    });

    expect(res.status).toBe(RsStatus.DUPLICATE_TRANSACTION);
    // And a runner working this job would mark it completed (not retry forever).
    // See PendingJobRunner.runJobOnce's `isSuccessOrDuplicate` branch.
  });
});
