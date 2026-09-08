import { type Response, Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { portalAuth } from '../middleware/portal-auth.js';
import { requireOperatorAdmin } from '../middleware/role-gate.js';
import {
  revokeCredentialImmediately,
  rotateCredential,
} from '../services/CredentialRotation.js';
import { getEngineRegistry } from '../services/EngineRegistry.js';
import {
  getRpsTournamentService,
  normalisePrizeTable,
  RPS_CURRENCY,
} from '../services/RpsTournamentService.js';
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  disableMfa,
} from '../services/Mfa.js';
import {
  beginRegistration,
  confirmRegistration,
  deleteCredential,
  listCredentials,
} from '../services/Webauthn.js';
import {
  CSV_HEADER,
  computeDailyTotals,
  type OperatorDailyTotals,
  totalsToCsvRow,
} from '../services/ReconciliationJob.js';
import {
  createInvite,
  listInvites,
  revokeInvite,
} from '../services/UserInvites.js';
import { encryptSecret } from '../utils/secrets.js';
import { newUuid } from '../utils/uuid.js';

export const adminRouter = Router();

adminRouter.use(portalAuth);

function operatorId(req: Parameters<Parameters<typeof adminRouter.get>[1]>[0]): string {
  return req.operator!.id;
}

adminRouter.get('/overview', async (req, res) => {
  const opId = operatorId(req);
  const currency = req.operator!.defaultCurrency;
  const since = new Date(Date.now() - 86_400_000);

  const [activeSessions, betAgg, winAgg] = await Promise.all([
    prisma.gameSession.count({
      where: { operatorId: opId, terminatedAt: null, expiresAt: { gt: new Date() } },
    }),
    prisma.bet.aggregate({
      where: {
        operatorId: opId,
        currency,
        status: { in: ['ACCEPTED', 'SETTLED'] },
        placedAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { amountMicro: true },
    }),
    prisma.bet.aggregate({
      where: {
        operatorId: opId,
        currency,
        won: true,
        settledAt: { gte: since },
      },
      _count: { _all: true },
      _sum: { wonAmountMicro: true },
    }),
  ]);

  const betsVolume = betAgg._sum.amountMicro ?? 0n;
  const winsVolume = winAgg._sum.wonAmountMicro ?? 0n;
  const ggrMicro = betsVolume - winsVolume;

  // 24 hourly buckets ending at the current hour (UTC). Uses raw SQL because
  // Prisma's `groupBy` does not support `date_trunc` expressions. We compute
  // bets (sum amountMicro WHERE status IN (ACCEPTED,SETTLED)) and wins (sum
  // wonAmountMicro WHERE won=true) side-by-side, then zero-fill missing hours.
  const hourNow = new Date();
  hourNow.setUTCMinutes(0, 0, 0);
  const windowStart = new Date(hourNow.getTime() - 23 * 3_600_000);

  const rawBuckets = await prisma.$queryRaw<
    Array<{ hour: Date; bets_micro: bigint; wins_micro: bigint }>
  >`
    SELECT
      date_trunc('hour', "placed_at") AS hour,
      COALESCE(
        SUM(CASE WHEN status IN ('ACCEPTED', 'SETTLED') THEN amount_micro END),
        0
      )::bigint AS bets_micro,
      COALESCE(
        SUM(CASE WHEN won = true THEN won_amount_micro END),
        0
      )::bigint AS wins_micro
    FROM bets
    WHERE operator_id = ${opId}::uuid
      AND currency = ${currency}
      AND placed_at >= ${windowStart}
      AND placed_at < ${new Date(hourNow.getTime() + 3_600_000)}
    GROUP BY hour
    ORDER BY hour
  `;

  const byHour = new Map<number, { bets: bigint; wins: bigint }>();
  for (const row of rawBuckets) {
    byHour.set(new Date(row.hour).getTime(), {
      bets: row.bets_micro,
      wins: row.wins_micro,
    });
  }

  const trend24h = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(hourNow.getTime() - (23 - i) * 3_600_000);
    const b = byHour.get(d.getTime());
    return {
      t: `${String(d.getUTCHours()).padStart(2, '0')}:00`,
      betsMicro: (b?.bets ?? 0n).toString(),
      winsMicro: (b?.wins ?? 0n).toString(),
    };
  });

  res.json({
    bets: { count: betAgg._count._all, volumeMicro: betsVolume.toString() },
    wins: { count: winAgg._count._all, volumeMicro: winsVolume.toString() },
    ggrMicro: ggrMicro.toString(),
    ngrMicro: ggrMicro.toString(),
    activeSessions,
    currency,
    trend24h,
  });
});

adminRouter.get('/game-config', async (req, res) => {
  const rows = await prisma.operatorGameConfig.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { currency: 'asc' },
  });
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      gameCode: r.gameCode,
      currency: r.currency,
      enabled: r.enabled,
      configJson: r.configJson,
      configVersion: r.configVersion,
      minBetMicro: r.minBetMicro.toString(),
      maxBetMicro: r.maxBetMicro.toString(),
      commissionMicro: r.commissionMicro.toString(),
      bettingWindowMs: r.bettingWindowMs,
      rollingWindowMs: r.rollingWindowMs,
      cooldownMs: r.cooldownMs,
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

const PrizeRowSchema = z.object({
  rank: z.number().int().min(1),
  amountMicro: z.union([z.string(), z.number(), z.bigint()]).transform((v) => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'number') return BigInt(Math.round(v)).toString();
    return BigInt(v).toString();
  }),
});

const RpsTournamentCreate = z.object({
  title: z.string().min(1).max(140),
  scheduledStartAt: z.string().datetime(),
  minPlayers: z.number().int().min(2).default(2),
  choiceWindowMs: z.number().int().min(3000).max(60000).default(12000),
  roundBreakMs: z.number().int().min(0).max(30000).default(3000),
  prizeTable: z.array(PrizeRowSchema).default([]),
});

const RpsTournamentPatch = RpsTournamentCreate.partial();

function serialiseRpsTournament(t: {
  id: string;
  title: string;
  currency: string;
  status: string;
  scheduledStartAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  minPlayers: number;
  choiceWindowMs: number;
  roundBreakMs: number;
  prizeTable: unknown;
  currentRound: number;
  seedHash: string;
  createdAt: Date;
  updatedAt: Date;
  participants?: Array<{ id: string; playerRef: string; displayName: string | null; status: string; rank: number | null; registeredAt: Date }>;
  matches?: Array<{ id: string; roundNumber: number; attemptNumber: number; participantAId: string | null; participantBId: string | null; winnerId: string | null; status: string; resultReason: string | null; startsAt: Date; endsAt: Date; resolvedAt: Date | null }>;
  prizeAwards?: Array<{ id: string; participantId: string; rank: number; amountMicro: bigint; currency: string; status: string; awardedAt: Date | null; lastError: string | null }>;
}) {
  return {
    id: t.id,
    title: t.title,
    currency: t.currency,
    status: t.status,
    scheduledStartAt: t.scheduledStartAt.toISOString(),
    startedAt: t.startedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
    cancelledReason: t.cancelledReason,
    minPlayers: t.minPlayers,
    choiceWindowMs: t.choiceWindowMs,
    roundBreakMs: t.roundBreakMs,
    prizeTable: normalisePrizeTable(t.prizeTable),
    currentRound: t.currentRound,
    seedHash: t.seedHash,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    participantCount: t.participants?.length,
    participants: t.participants?.map((p) => ({
      id: p.id,
      playerRef: p.displayName ?? `${p.playerRef.slice(0, 2)}***${p.playerRef.slice(-2)}`,
      status: p.status,
      rank: p.rank,
      registeredAt: p.registeredAt.toISOString(),
    })),
    matches: t.matches?.map((m) => ({
      id: m.id,
      roundNumber: m.roundNumber,
      attemptNumber: m.attemptNumber,
      participantAId: m.participantAId,
      participantBId: m.participantBId,
      winnerId: m.winnerId,
      status: m.status,
      resultReason: m.resultReason,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      resolvedAt: m.resolvedAt?.toISOString() ?? null,
    })),
    prizeAwards: t.prizeAwards?.map((a) => ({
      id: a.id,
      participantId: a.participantId,
      rank: a.rank,
      amountMicro: a.amountMicro.toString(),
      currency: a.currency,
      status: a.status,
      awardedAt: a.awardedAt?.toISOString() ?? null,
      lastError: a.lastError,
    })),
  };
}

adminRouter.get('/rps-tournaments', async (req, res) => {
  const rows = await prisma.rpsTournament.findMany({
    where: { operatorId: operatorId(req), currency: RPS_CURRENCY },
    orderBy: [{ scheduledStartAt: 'desc' }],
    take: 100,
    include: { participants: true },
  });
  res.json({ items: rows.map(serialiseRpsTournament) });
});

adminRouter.post('/rps-tournaments', requireOperatorAdmin, async (req, res) => {
  const parsed = RpsTournamentCreate.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const t = await getRpsTournamentService().createTournament({
    operatorId: operatorId(req),
    title: parsed.data.title,
    scheduledStartAt: new Date(parsed.data.scheduledStartAt),
    minPlayers: parsed.data.minPlayers,
    choiceWindowMs: parsed.data.choiceWindowMs,
    roundBreakMs: parsed.data.roundBreakMs,
    prizeTable: parsed.data.prizeTable,
    actor: req.portalClaims?.email,
  });
  res.status(201).json({ tournament: serialiseRpsTournament(t) });
});

adminRouter.get('/rps-tournaments/:id', async (req, res) => {
  const t = await prisma.rpsTournament.findUnique({
    where: { id: req.params.id as string },
    include: {
      participants: { orderBy: [{ rank: 'asc' }, { registeredAt: 'asc' }] },
      matches: { orderBy: [{ roundNumber: 'asc' }, { createdAt: 'asc' }] },
      prizeAwards: { orderBy: { rank: 'asc' } },
    },
  });
  if (!t || t.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'tournament_not_found' });
    return;
  }
  res.json({ tournament: serialiseRpsTournament(t) });
});

adminRouter.patch('/rps-tournaments/:id', requireOperatorAdmin, async (req, res) => {
  const parsed = RpsTournamentPatch.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.rpsTournament.findUnique({ where: { id: req.params.id as string } });
  if (!existing || existing.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'tournament_not_found' });
    return;
  }
  if (!['DRAFT', 'SCHEDULED', 'REGISTERING'].includes(existing.status)) {
    res.status(409).json({ error: 'tournament_locked' });
    return;
  }
  const patch = parsed.data;
  const updated = await prisma.rpsTournament.update({
    where: { id: existing.id },
    data: {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.scheduledStartAt !== undefined && { scheduledStartAt: new Date(patch.scheduledStartAt) }),
      ...(patch.minPlayers !== undefined && { minPlayers: patch.minPlayers }),
      ...(patch.choiceWindowMs !== undefined && { choiceWindowMs: patch.choiceWindowMs }),
      ...(patch.roundBreakMs !== undefined && { roundBreakMs: patch.roundBreakMs }),
      ...(patch.prizeTable !== undefined && { prizeTable: patch.prizeTable as object }),
      updatedBy: req.portalClaims?.email ?? null,
    },
  });
  res.json({ tournament: serialiseRpsTournament(updated) });
});

adminRouter.post('/rps-tournaments/:id/start', requireOperatorAdmin, async (req, res) => {
  const result = await getRpsTournamentService().manualStart(
    req.params.id as string,
    operatorId(req),
    req.portalClaims?.email,
  );
  if (!result.ok) {
    res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
    return;
  }
  res.json({ ok: true });
});

adminRouter.post('/rps-tournaments/:id/cancel', requireOperatorAdmin, async (req, res) => {
  const body = z.object({ reason: z.string().max(256).default('operator_cancelled') }).safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: 'invalid_body', details: body.error.flatten() });
    return;
  }
  const result = await getRpsTournamentService().cancel(
    req.params.id as string,
    operatorId(req),
    body.data.reason,
    req.portalClaims?.email,
  );
  if (!result.ok) {
    res.status(result.reason === 'not_found' ? 404 : 409).json({ error: result.reason });
    return;
  }
  res.json({ ok: true });
});

const UpdateConfigBody = z.object({
  gameCode: z.string().default('ketapola-dice'),
  enabled: z.boolean().optional(),
  // Game-math patch — validated by the plugin's configSchema at engine reload.
  configJson: z.record(z.unknown()).optional(),
  minBetMicro: z.string().optional(),
  maxBetMicro: z.string().optional(),
  commissionMicro: z.string().optional(),
  bettingWindowMs: z.number().int().positive().optional(),
  rollingWindowMs: z.number().int().positive().optional(),
  cooldownMs: z.number().int().positive().optional(),
});

adminRouter.patch('/game-config/:currency', async (req, res) => {
  const parsed = UpdateConfigBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const patch = parsed.data;
  const currency = req.params.currency as string;
  const existing = await prisma.operatorGameConfig.findUnique({
    where: {
      operatorId_gameCode_currency: {
        operatorId: operatorId(req),
        gameCode: patch.gameCode,
        currency,
      },
    },
  });
  if (!existing) {
    res.status(404).json({ error: 'config_not_found' });
    return;
  }
  const updated = await prisma.operatorGameConfig.update({
    where: { id: existing.id },
    data: {
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(patch.configJson !== undefined && {
        configJson: patch.configJson as import('../generated/prisma/index.js').Prisma.InputJsonValue,
      }),
      ...(patch.minBetMicro !== undefined && { minBetMicro: BigInt(patch.minBetMicro) }),
      ...(patch.maxBetMicro !== undefined && { maxBetMicro: BigInt(patch.maxBetMicro) }),
      ...(patch.commissionMicro !== undefined && {
        commissionMicro: BigInt(patch.commissionMicro),
      }),
      ...(patch.bettingWindowMs !== undefined && { bettingWindowMs: patch.bettingWindowMs }),
      ...(patch.rollingWindowMs !== undefined && { rollingWindowMs: patch.rollingWindowMs }),
      ...(patch.cooldownMs !== undefined && { cooldownMs: patch.cooldownMs }),
    },
  });
  await prisma.operatorConfigAuditLog.create({
    data: {
      operatorId: operatorId(req),
      gameCode: patch.gameCode,
      field: 'bulk_update',
      oldValue: JSON.stringify({
        configJson: existing.configJson,
        enabled: existing.enabled,
      }),
      newValue: JSON.stringify(patch),
      changedBy: req.portalUser!.id,
    },
  });
  res.json({ ok: true, id: updated.id });
});

const ListPagination = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

adminRouter.get('/rounds', async (req, res) => {
  const p = ListPagination.safeParse(req.query);
  if (!p.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const rows = await prisma.round.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { startedAt: 'desc' },
    take: p.data.limit + 1,
    ...(p.data.cursor ? { cursor: { id: p.data.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > p.data.limit ? rows.pop()!.id : null;
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      nonce: r.nonce,
      state: r.state,
      outcomeType: r.outcomeType,
      outcome: r.outcomeData,
      totalBetsMicro: r.totalBetsMicro.toString(),
      totalPayoutsMicro: r.totalPayoutsMicro.toString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      settledAt: r.settledAt?.toISOString() ?? null,
    })),
    nextCursor,
  });
});

adminRouter.get('/wallet-calls', async (req, res) => {
  const p = ListPagination.safeParse(req.query);
  if (!p.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const rows = await prisma.walletCall.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
    take: p.data.limit + 1,
    ...(p.data.cursor ? { cursor: { id: p.data.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > p.data.limit ? rows.pop()!.id : null;
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      direction: r.direction,
      endpoint: r.endpoint,
      requestUuid: r.requestUuid,
      transactionUuid: r.transactionUuid,
      roundId: r.roundId,
      playerRef: r.playerRef,
      amountMicro: r.amountMicro?.toString() ?? null,
      currency: r.currency,
      responseStatus: r.responseStatus,
      httpStatus: r.httpStatus,
      latencyMs: r.latencyMs,
      attempt: r.attempt,
      succeeded: r.succeeded,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor,
  });
});

adminRouter.get('/sessions', async (req, res) => {
  const p = ListPagination.safeParse(req.query);
  if (!p.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const rows = await prisma.gameSession.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
    take: p.data.limit + 1,
    ...(p.data.cursor ? { cursor: { id: p.data.cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > p.data.limit ? rows.pop()!.id : null;
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      playerRef: r.playerRef,
      gameCode: r.gameCode,
      currency: r.currency,
      mode: r.mode,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      terminatedAt: r.terminatedAt?.toISOString() ?? null,
    })),
    nextCursor,
  });
});

// ─── GET /v1/admin/sessions/:id ────────────────────────────────────────────
//
// Session detail + aggregated rounds + player bets for the portal
// drill-down view. Tenant-scoped.

adminRouter.get('/sessions/:id', async (req, res) => {
  const id = req.params.id as string;
  const s = await prisma.gameSession.findUnique({ where: { id } });
  if (!s || s.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const [rounds, bets] = await Promise.all([
    prisma.round.findMany({
      where: { sessionId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    prisma.bet.findMany({
      where: { sessionId: id },
      orderBy: { placedAt: 'desc' },
      take: 50,
    }),
  ]);

  let betsTotal = 0n;
  let winsTotal = 0n;
  for (const b of bets) {
    betsTotal += b.amountMicro;
    winsTotal += b.wonAmountMicro ?? 0n;
  }
  const netMicro = betsTotal - winsTotal;

  res.json({
    session: {
      id: s.id,
      playerRef: s.playerRef,
      gameCode: s.gameCode,
      currency: s.currency,
      lang: s.lang,
      jurisdiction: s.jurisdiction,
      mode: s.mode,
      rgLimits: s.rgLimits ?? null,
      serverSeedHash: s.serverSeedHash,
      clientSeed: s.clientSeed,
      nonce: s.nonce,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      terminatedAt: s.terminatedAt?.toISOString() ?? null,
      terminationReason: s.terminationReason,
    },
    summary: {
      roundCount: rounds.length,
      betCount: bets.length,
      betsMicro: betsTotal.toString(),
      winsMicro: winsTotal.toString(),
      netMicro: netMicro.toString(),
    },
    rounds: rounds.map((r) => ({
      id: r.id,
      nonce: r.nonce,
      state: r.state,
      outcomeType: r.outcomeType,
      outcome: r.outcomeData,
      totalBetsMicro: r.totalBetsMicro.toString(),
      totalPayoutsMicro: r.totalPayoutsMicro.toString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      settledAt: r.settledAt?.toISOString() ?? null,
    })),
    bets: bets.map((b) => ({
      id: b.id,
      roundId: b.roundId,
      selection: b.selection,
      selectionType: b.selectionType,
      amountMicro: b.amountMicro.toString(),
      wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
      status: b.status,
      placedAt: b.placedAt.toISOString(),
      settledAt: b.settledAt?.toISOString() ?? null,
    })),
  });
});

// ─── POST /v1/admin/sessions/:id/terminate ─────────────────────────────────
//
// Portal-authenticated force-terminate. Distinct from the operator-HMAC
// /v1/session/:id/terminate on the player-side router — this one is for
// the back-office operator user clicking "Terminate" on the session detail.

const AdminTerminateBody = z.object({
  reason: z.string().max(64).default('portal_admin_terminate'),
});

adminRouter.post('/sessions/:id/terminate', async (req, res) => {
  const parsed = AdminTerminateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const id = req.params.id as string;
  const s = await prisma.gameSession.findUnique({ where: { id } });
  if (!s || s.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  if (s.terminatedAt) {
    res.json({ id, terminatedAt: s.terminatedAt.toISOString(), alreadyTerminated: true });
    return;
  }
  const updated = await prisma.gameSession.update({
    where: { id },
    data: {
      terminatedAt: new Date(),
      terminationReason: parsed.data.reason,
    },
  });
  res.json({
    id,
    terminatedAt: updated.terminatedAt?.toISOString() ?? null,
    reason: parsed.data.reason,
  });
});

adminRouter.get('/credentials', async (req, res) => {
  const rows = await prisma.operatorCredential.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      kid: r.kid,
      label: r.label,
      notBefore: r.notBefore.toISOString(),
      notAfter: r.notAfter?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

const RotateBody = z.object({
  type: z.enum(['API_KEY_INBOUND', 'WALLET_HMAC_OUTBOUND']),
  label: z.string().max(100).optional(),
});

adminRouter.post('/credentials/rotate', async (req, res) => {
  const parsed = RotateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const kid = `kid_${newUuid().slice(0, 16)}`;
  const secret = newUuid() + newUuid();
  const cipherBlob = encryptSecret(secret);

  const cred = await prisma.operatorCredential.create({
    data: {
      operatorId: operatorId(req),
      type: parsed.data.type,
      kid,
      cipherBlob,
      label: parsed.data.label,
    },
  });

  // NOTE: the plaintext secret is returned ONCE. The operator must store it.
  res.json({
    id: cred.id,
    kid,
    type: cred.type,
    secret,
    createdAt: cred.createdAt.toISOString(),
  });
});

// ─── DELETE /v1/admin/credentials/:id (item 6) ─────────────────────────────
//
// Revokes a credential. Revocation is soft (sets revokedAt); we never DROP
// audit rows. Existing signed requests bearing the revoked kid start failing
// within the ±30s signature window.
adminRouter.delete('/credentials/:id', async (req, res) => {
  const id = req.params.id as string;
  const cred = await prisma.operatorCredential.findUnique({ where: { id } });
  if (!cred || cred.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'credential_not_found' });
    return;
  }
  if (cred.revokedAt) {
    res.json({ id, revokedAt: cred.revokedAt.toISOString(), alreadyRevoked: true });
    return;
  }
  const updated = await prisma.operatorCredential.update({
    where: { id },
    data: { revokedAt: new Date() },
  });
  res.json({ id, revokedAt: updated.revokedAt?.toISOString() ?? null });
});

// ─── GET /v1/admin/circuit-breakers (item 2) ───────────────────────────────
//
// Snapshots every running engine's WalletClient circuit-breaker state. The
// operator uses this to see if their wallet endpoint is degraded (OPEN
// breakers) or probing recovery (HALF_OPEN). Data is in-memory per-process;
// in a multi-process deployment each instance returns its own view.
adminRouter.get('/circuit-breakers', async (req, res) => {
  const snapshot = getEngineRegistry().snapshot({ operatorId: operatorId(req) });
  res.json({
    items: snapshot.map((s) => ({
      operatorId: s.operatorId,
      gameCode: s.gameCode,
      currency: s.currency,
      breakers: s.breakers,
    })),
    collectedAt: new Date().toISOString(),
  });
});

// ─── GET /v1/admin/engines (item 4) ────────────────────────────────────────
//
// Which game-engine instances are running for this operator, their current
// round, and the phase of the state machine. Cheap view — reads from the
// registry's in-memory Map.
adminRouter.get('/engines', async (req, res) => {
  const snapshot = getEngineRegistry().snapshot({ operatorId: operatorId(req) });
  res.json({
    items: snapshot.map((s) => ({
      operatorId: s.operatorId,
      gameCode: s.gameCode,
      currency: s.currency,
      phase: s.phase,
      currentRoundId: s.currentRoundId,
      currentNonce: s.currentNonce,
      bettingWindowMs: s.bettingWindowMs,
    })),
  });
});

// ─── GET /v1/admin/pending-jobs (item 3a) ──────────────────────────────────
//
// Lists open durable-retry jobs (failed wallet wins / rollbacks) for this
// operator. Supports filtering by endpoint + a page cursor.
const PendingJobsQuery = z.object({
  endpoint: z.enum(['BET', 'WIN', 'ROLLBACK', 'BALANCE', 'END_ROUND']).optional(),
  includeCompleted: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});

adminRouter.get('/pending-jobs', async (req, res) => {
  const parsed = PendingJobsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { endpoint, includeCompleted, limit, cursor } = parsed.data;
  const rows = await prisma.pendingWalletJob.findMany({
    where: {
      operatorId: operatorId(req),
      ...(endpoint ? { endpoint } : {}),
      ...(includeCompleted ? {} : { completedAt: null }),
    },
    orderBy: [{ completedAt: 'asc' }, { nextAttemptAt: 'asc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const nextCursor = rows.length > limit ? rows.pop()!.id : null;

  res.json({
    items: rows.map((j) => ({
      id: j.id,
      endpoint: j.endpoint,
      betId: j.betId,
      roundId: j.roundId,
      attempts: j.attempts,
      nextAttemptAt: j.nextAttemptAt.toISOString(),
      lockedUntil: j.lockedUntil?.toISOString() ?? null,
      lastError: j.lastError,
      completedAt: j.completedAt?.toISOString() ?? null,
      createdAt: j.createdAt.toISOString(),
    })),
    nextCursor,
  });
});

// ─── POST /v1/admin/jobs/:id/retry (item 3b) ───────────────────────────────
//
// Forces an immediate retry attempt: nextAttemptAt = now, clears the lock.
// The background poll tick picks it up within POLL_INTERVAL_MS. Does NOT
// reset the attempt counter — we still want exponential backoff to apply on
// subsequent failures.
adminRouter.post('/jobs/:id/retry', async (req, res) => {
  const id = req.params.id as string;
  const job = await prisma.pendingWalletJob.findUnique({ where: { id } });
  if (!job || job.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }
  if (job.completedAt) {
    res.status(409).json({ error: 'job_already_completed' });
    return;
  }
  const updated = await prisma.pendingWalletJob.update({
    where: { id },
    data: { nextAttemptAt: new Date(), lockedUntil: null },
  });
  res.json({
    id,
    nextAttemptAt: updated.nextAttemptAt.toISOString(),
    attempts: updated.attempts,
  });
});

// ─── POST /v1/admin/jobs/:id/cancel (item 3c) ──────────────────────────────
//
// Marks a job as completed with cancellation reason. The wallet call is NOT
// issued — use this when you've reconciled the transaction manually with the
// operator and the automated retry would double-process.
const CancelJobBody = z.object({
  reason: z.string().max(200).default('cancelled_by_operator'),
});

adminRouter.post('/jobs/:id/cancel', async (req, res) => {
  const parsed = CancelJobBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const id = req.params.id as string;
  const job = await prisma.pendingWalletJob.findUnique({ where: { id } });
  if (!job || job.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'job_not_found' });
    return;
  }
  if (job.completedAt) {
    res.status(409).json({ error: 'job_already_completed' });
    return;
  }
  const updated = await prisma.pendingWalletJob.update({
    where: { id },
    data: {
      completedAt: new Date(),
      lockedUntil: null,
      lastError: `cancelled: ${parsed.data.reason}`,
    },
  });
  res.json({
    id,
    completedAt: updated.completedAt?.toISOString() ?? null,
    reason: parsed.data.reason,
  });
});

// ─── GET /v1/admin/reports/:period (item 5) ────────────────────────────────
//
// `daily`  — one day, one CSV row per currency.
// `weekly` — seven days ending at `?date=` (default today), per-day rows.
// `monthly` — calendar month of `?date=`, per-day rows.
//
// ?format=csv returns text/csv; default is JSON. Pulls from the same
// computeDailyTotals used by the reconciliation service, so numbers match
// the nightly reconciliation log byte-for-byte.

const PeriodQuery = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().min(1).max(8).optional(),
  format: z.enum(['json', 'csv']).optional(),
});

function utcDay(iso?: string): Date {
  const base = iso ? new Date(`${iso}T00:00:00.000Z`) : new Date();
  return new Date(`${base.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function collectTotals(
  opId: string,
  dates: Date[],
  currencies: string[],
): Promise<OperatorDailyTotals[]> {
  const all = await Promise.all(
    dates.flatMap((d) => currencies.map((c) => computeDailyTotals(opId, c, d))),
  );
  return all;
}

async function operatorCurrencies(opId: string, filter?: string): Promise<string[]> {
  if (filter) return [filter];
  const rows = await prisma.operatorGameConfig.findMany({
    where: { operatorId: opId, enabled: true },
    select: { currency: true },
  });
  return Array.from(new Set(rows.map((r) => r.currency)));
}

function respondReport(
  res: Response,
  totals: OperatorDailyTotals[],
  format: 'json' | 'csv',
): void {
  if (format === 'csv') {
    const rows = [CSV_HEADER, ...totals.map(totalsToCsvRow)];
    res.type('text/csv').send(`${rows.join('\n')}\n`);
    return;
  }
  res.json({
    items: totals.map((t) => ({
      date: t.date,
      currency: t.currency,
      counts: {
        bets: t.betsCount,
        wins: t.winsCount,
        rollbacks: t.rollbacksCount,
        failedCalls: t.failedCallsCount,
        pendingJobs: t.pendingJobsCount,
      },
      amountsMicro: {
        bets: t.betsAmountMicro.toString(),
        wins: t.winsAmountMicro.toString(),
        rollbacks: t.rollbacksAmountMicro.toString(),
        net: t.netRevenueMicro.toString(),
      },
    })),
  });
}

adminRouter.get('/reports/daily', async (req, res) => {
  const parsed = PeriodQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const opId = operatorId(req);
  const day = utcDay(parsed.data.date);
  const currencies = await operatorCurrencies(opId, parsed.data.currency);
  const totals = await collectTotals(opId, [day], currencies);
  respondReport(res, totals, parsed.data.format ?? 'json');
});

adminRouter.get('/reports/weekly', async (req, res) => {
  const parsed = PeriodQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const opId = operatorId(req);
  const end = utcDay(parsed.data.date);
  const days = Array.from(
    { length: 7 },
    (_, i) => new Date(end.getTime() - (6 - i) * 86_400_000),
  );
  const currencies = await operatorCurrencies(opId, parsed.data.currency);
  const totals = await collectTotals(opId, days, currencies);
  respondReport(res, totals, parsed.data.format ?? 'json');
});

adminRouter.get('/reports/monthly', async (req, res) => {
  const parsed = PeriodQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const opId = operatorId(req);
  const ref = parsed.data.date ? new Date(`${parsed.data.date}T00:00:00.000Z`) : new Date();
  const monthStart = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const monthEnd = new Date(
    Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  );
  const days: Date[] = [];
  for (let t = monthStart.getTime(); t < monthEnd.getTime(); t += 86_400_000) {
    days.push(new Date(t));
  }
  const currencies = await operatorCurrencies(opId, parsed.data.currency);
  const totals = await collectTotals(opId, days, currencies);
  respondReport(res, totals, parsed.data.format ?? 'json');
});

// ── Credential self-rotation (operator-scoped) ────────────────
//
// Operator admins rotate their own API keys without waiting for us.
// Plaintext returned once; audit-log row captures who rotated what.
// Grace window defaults to 1h — the previous credential continues to
// verify during the window so zero-downtime cut-over is possible.

const OperatorRotateBody = z.object({
  type: z.enum(['API_KEY_INBOUND', 'WALLET_HMAC_OUTBOUND']),
  graceMs: z.number().int().min(0).max(24 * 60 * 60_000).optional(),
  label: z.string().max(100).optional(),
});

adminRouter.post(
  '/credentials:rotate',
  requireOperatorAdmin,
  async (req, res) => {
    const parsed = OperatorRotateBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
      return;
    }
    const result = await rotateCredential({
      operatorId: operatorId(req),
      type: parsed.data.type,
      actorUserId: req.portalUser!.id,
      actorEmail: req.portalUser!.email,
      graceMs: parsed.data.graceMs,
      label: parsed.data.label,
    });
    res.status(201).json({
      kid: result.kid,
      secret: result.secret,
      algorithm: 'HMAC-SHA256',
      previousKid: result.previousKid,
      previousCredentialRetiresAt: result.previousCredentialRetiresAt,
      warning: 'SAVE THE SECRET NOW — it will never be shown again.',
    });
  },
);

adminRouter.post(
  '/credentials/:id/revoke',
  requireOperatorAdmin,
  async (req, res) => {
    // Verify the credential belongs to the calling operator — protects
    // against a compromised portal token for tenant A being used to
    // revoke tenant B's credentials.
    const cred = await prisma.operatorCredential.findUnique({
      where: { id: req.params.id as string },
    });
    if (!cred || cred.operatorId !== operatorId(req)) {
      res.status(404).json({ error: 'credential_not_found' });
      return;
    }
    await revokeCredentialImmediately(
      cred.id,
      req.portalUser!.id,
      req.portalUser!.email,
    );
    res.json({ ok: true });
  },
);

adminRouter.get('/credentials', requireOperatorAdmin, async (req, res) => {
  const rows = await prisma.operatorCredential.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      kid: true,
      type: true,
      label: true,
      notBefore: true,
      notAfter: true,
      revokedAt: true,
      createdAt: true,
    },
  });
  res.json({ credentials: rows });
});

// ── User management: list, invite, revoke invite, disable user ───────

adminRouter.get('/users', requireOperatorAdmin, async (req, res) => {
  const users = await prisma.operatorUser.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      displayName: true,
      role: true,
      lastLoginAt: true,
      createdAt: true,
      mfaEnrolledAt: true,
      disabledAt: true,
      disabledBy: true,
    },
  });
  res.json({ users });
});

const InviteBody = z.object({
  email: z.string().email(),
  role: z.enum([
    'OPERATOR_ADMIN',
    'OPERATOR_FINANCE',
    'OPERATOR_SUPPORT',
    'OPERATOR_VIEWER',
  ]),
  ttlMs: z.number().int().min(60_000).max(30 * 24 * 60 * 60_000).optional(),
});

adminRouter.post('/invites', requireOperatorAdmin, async (req, res) => {
  const parsed = InviteBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  try {
    const out = await createInvite({
      operatorId: operatorId(req),
      email: parsed.data.email,
      role: parsed.data.role,
      invitedByEmail: req.portalUser!.email,
      ttlMs: parsed.data.ttlMs,
    });
    res.status(201).json({
      inviteId: out.inviteId,
      token: out.token,
      expiresAt: out.expiresAt,
      warning:
        'Deliver the token to the invited user out-of-band (email). It is shown once and cannot be re-emitted.',
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'invalid_email' || msg === 'email_already_in_use') {
      res.status(400).json({ error: msg });
      return;
    }
    throw err;
  }
});

adminRouter.get('/invites', requireOperatorAdmin, async (req, res) => {
  const invites = await listInvites(operatorId(req));
  res.json({ invites });
});

adminRouter.post('/invites/:id/revoke', requireOperatorAdmin, async (req, res) => {
  const ok = await revokeInvite({
    operatorId: operatorId(req),
    inviteId: req.params.id as string,
    actorEmail: req.portalUser!.email,
  });
  if (!ok) {
    res.status(404).json({ error: 'invite_not_found' });
    return;
  }
  res.json({ ok: true });
});

const DisableUserBody = z.object({ userId: z.string().uuid() });

adminRouter.post('/users/:id/disable', requireOperatorAdmin, async (req, res) => {
  const _ = DisableUserBody; // suppress unused-import warning if body is empty
  const target = await prisma.operatorUser.findUnique({
    where: { id: req.params.id as string },
  });
  if (!target || target.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'user_not_found' });
    return;
  }
  if (target.id === req.portalUser!.id) {
    res.status(400).json({ error: 'cannot_disable_self' });
    return;
  }
  await prisma.operatorUser.update({
    where: { id: target.id },
    data: { disabledAt: new Date(), disabledBy: req.portalUser!.email },
  });
  res.json({ ok: true });
});

// ── MFA self-enrollment (per-user) ─────────────────────────────────

adminRouter.post('/mfa:begin', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  try {
    const result = await beginMfaEnrollment({
      userId: user.id,
      operatorSlug: req.operator!.slug,
      userEmail: user.email,
    });
    res.json({
      ...result,
      warning:
        'Save the recovery codes now — they are shown ONCE. The secret is also shown once; do not screenshot it on untrusted devices.',
    });
  } catch (err) {
    if ((err as Error).message === 'mfa_already_enrolled') {
      res.status(409).json({ error: 'mfa_already_enrolled' });
      return;
    }
    throw err;
  }
});

const ConfirmBody = z.object({ code: z.string().regex(/^\d{6}$/) });
adminRouter.post('/mfa:confirm', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  const parsed = ConfirmBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  try {
    const { ok } = await confirmMfaEnrollment({
      userId: user.id,
      code: parsed.data.code,
    });
    if (!ok) {
      res.status(401).json({ error: 'invalid_code' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if ((err as Error).message === 'mfa_not_begun') {
      res.status(400).json({ error: 'mfa_not_begun' });
      return;
    }
    throw err;
  }
});

// ── WebAuthn self-enrolment ─────────────────────────────────────────
//
// Same mental model as TOTP: :begin returns the options the browser
// hands to navigator.credentials.create(); :confirm takes the attestation
// back. A user can enrol MULTIPLE authenticators (yubikey + phone, etc).

adminRouter.post('/webauthn/register:begin', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  const out = await beginRegistration({
    userId: user.id,
    userEmail: user.email,
    userDisplayName: user.displayName ?? user.email,
  });
  res.json(out);
});

const ConfirmRegister = z.object({
  challengeId: z.string().uuid(),
  response: z.record(z.unknown()),
  deviceName: z.string().max(100).optional(),
});
adminRouter.post('/webauthn/register:confirm', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  const parsed = ConfirmRegister.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  try {
    const out = await confirmRegistration({
      userId: user.id,
      challengeId: parsed.data.challengeId,
      response: parsed.data.response as unknown as import('@simplewebauthn/server').RegistrationResponseJSON,
      deviceName: parsed.data.deviceName,
    });
    if (!out.ok) {
      res.status(400).json({ error: 'verification_failed' });
      return;
    }
    res.json({ ok: true, credentialId: out.credentialId });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adminRouter.get('/webauthn/credentials', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  res.json({ credentials: await listCredentials(user.id) });
});

adminRouter.delete('/webauthn/credentials/:id', async (req, res) => {
  const user = req.portalUser;
  if (!user) {
    res.status(401).json({ error: 'no_actor' });
    return;
  }
  const ok = await deleteCredential({
    userId: user.id,
    credentialRowId: req.params.id as string,
  });
  if (!ok) {
    res.status(404).json({ error: 'credential_not_found' });
    return;
  }
  res.json({ ok: true });
});

adminRouter.post('/mfa:disable', requireOperatorAdmin, async (req, res) => {
  // Disable MFA on self OR on another user (admin-only). The privileged
  // path matters when a user loses their authenticator and the admin
  // must reset them.
  const body = req.body as { userId?: string };
  const target = body?.userId && typeof body.userId === 'string'
    ? body.userId
    : req.portalUser!.id;
  const user = await prisma.operatorUser.findUnique({ where: { id: target } });
  if (!user || user.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'user_not_found' });
    return;
  }
  await disableMfa({ userId: target, actorEmail: req.portalUser!.email });
  res.json({ ok: true });
});

// ── Webhook subscription self-service ──────────────────────────────

const WEBHOOK_EVENT_ENUM = [
  'round.settled',
  'round.voided',
  'session.terminated',
  'session.rg_limit_tripped',
  'reconciliation.discrepancy',
  'credential.rotated',
  'credential.revoked',
  'webhook.test',
] as const;

const WebhookSubscribeBody = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_ENUM)).default([]),
  description: z.string().max(200).optional(),
});

adminRouter.post('/webhooks', requireOperatorAdmin, async (req, res) => {
  const parsed = WebhookSubscribeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    return;
  }
  const { randomBytes } = await import('node:crypto');
  const secret = randomBytes(32).toString('hex');
  const sub = await prisma.webhookSubscription.create({
    data: {
      operatorId: operatorId(req),
      url: parsed.data.url,
      eventTypes: parsed.data.eventTypes,
      description: parsed.data.description,
      secretCipher: encryptSecret(secret),
    },
  });
  res.status(201).json({
    id: sub.id,
    url: sub.url,
    eventTypes: sub.eventTypes,
    secret,
    secretVersion: sub.secretVersion,
    warning: 'SAVE THE SECRET NOW — it will never be shown again. Rotate via /webhooks/:id:rotate-secret.',
  });
});

adminRouter.get('/webhooks', requireOperatorAdmin, async (req, res) => {
  const subs = await prisma.webhookSubscription.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      url: true,
      eventTypes: true,
      enabled: true,
      description: true,
      secretVersion: true,
      failureCount: true,
      lastSuccessAt: true,
      lastFailureAt: true,
      lastFailureReason: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  res.json({ subscriptions: subs });
});

const WebhookPatchBody = z.object({
  url: z.string().url().optional(),
  eventTypes: z.array(z.enum(WEBHOOK_EVENT_ENUM)).optional(),
  enabled: z.boolean().optional(),
  description: z.string().max(200).optional(),
});

adminRouter.patch('/webhooks/:id', requireOperatorAdmin, async (req, res) => {
  const parsed = WebhookPatchBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const existing = await prisma.webhookSubscription.findUnique({
    where: { id: req.params.id as string },
  });
  if (!existing || existing.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'subscription_not_found' });
    return;
  }
  const updated = await prisma.webhookSubscription.update({
    where: { id: existing.id },
    data: parsed.data,
  });
  res.json({
    id: updated.id,
    url: updated.url,
    eventTypes: updated.eventTypes,
    enabled: updated.enabled,
    description: updated.description,
  });
});

adminRouter.delete('/webhooks/:id', requireOperatorAdmin, async (req, res) => {
  const existing = await prisma.webhookSubscription.findUnique({
    where: { id: req.params.id as string },
  });
  if (!existing || existing.operatorId !== operatorId(req)) {
    res.status(404).json({ error: 'subscription_not_found' });
    return;
  }
  await prisma.webhookSubscription.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

adminRouter.post(
  '/webhooks/:id:rotate-secret',
  requireOperatorAdmin,
  async (req, res) => {
    const existing = await prisma.webhookSubscription.findUnique({
      where: { id: req.params.id as string },
    });
    if (!existing || existing.operatorId !== operatorId(req)) {
      res.status(404).json({ error: 'subscription_not_found' });
      return;
    }
    const { randomBytes } = await import('node:crypto');
    const secret = randomBytes(32).toString('hex');
    // Bump the version suffix. Simple numeric increment — receivers
    // use the version header to know which key produced a signature.
    const currentVersion = existing.secretVersion;
    const n = /^v(\d+)$/.exec(currentVersion);
    const nextVersion = n ? `v${Number(n[1]) + 1}` : 'v2';
    await prisma.webhookSubscription.update({
      where: { id: existing.id },
      data: {
        secretCipher: encryptSecret(secret),
        secretVersion: nextVersion,
      },
    });
    res.json({
      secret,
      secretVersion: nextVersion,
      warning: 'SAVE THE SECRET NOW — not shown again.',
    });
  },
);

// Replay a dead-lettered delivery — moves it back into the retry queue
// with attempt=1. Use-case: operator fixes a crashed receiver and asks
// to re-try the backlog.
adminRouter.post(
  '/webhooks/deliveries/:id:replay',
  requireOperatorAdmin,
  async (req, res) => {
    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: req.params.id as string },
    });
    if (!delivery || delivery.operatorId !== operatorId(req)) {
      res.status(404).json({ error: 'delivery_not_found' });
      return;
    }
    const { webhookDispatcher } = await import('../services/WebhookDispatcher.js');
    const ok = await webhookDispatcher.replay(delivery.id);
    if (!ok) {
      res.status(409).json({ error: 'not_dead_lettered' });
      return;
    }
    res.json({ ok: true });
  },
);

// Delivery log — the operator's view of what we tried to send and what
// happened. Pageable by createdAt DESC.
const DeliveryQuery = z.object({
  state: z
    .enum(['PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_RETRY', 'DEAD_LETTERED'])
    .optional(),
  subscriptionId: z.string().uuid().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Signing keys self-service (asymmetric launch JWT) ───────────

adminRouter.get('/signing-keys', requireOperatorAdmin, async (req, res) => {
  const keys = await prisma.operatorSigningKey.findMany({
    where: { operatorId: operatorId(req) },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      kid: true,
      algorithm: true,
      status: true,
      notBefore: true,
      notAfter: true,
      createdAt: true,
      publicJwk: true,
    },
  });
  res.json({ keys });
});

adminRouter.post('/signing-keys:rotate', requireOperatorAdmin, async (req, res) => {
  const { rotateSigningKey } = await import('../services/SigningKeys.js');
  const result = await rotateSigningKey(operatorId(req));
  res.status(201).json(result);
});

adminRouter.get('/webhooks/deliveries', requireOperatorAdmin, async (req, res) => {
  const parsed = DeliveryQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_query' });
    return;
  }
  const { state, subscriptionId, cursor, limit } = parsed.data;
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      operatorId: operatorId(req),
      ...(state ? { state } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      subscriptionId: true,
      eventId: true,
      eventType: true,
      state: true,
      attempt: true,
      httpStatus: true,
      latencyMs: true,
      nextAttemptAt: true,
      completedAt: true,
      deadLetteredAt: true,
      createdAt: true,
    },
  });
  const nextCursor = rows.length > limit ? rows.pop()!.id : null;
  res.json({ items: rows, nextCursor });
});
