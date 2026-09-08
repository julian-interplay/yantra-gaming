import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, EndpointStubError, apiRequest } from './client';

// Tiny useQuery-alike. Good enough for Phase 0 — no caching, no
// deduplication, no focus refetch. When we outgrow it we can swap in
// TanStack Query without touching callers (same return shape).

export interface QueryResult<T> {
  data: T | null;
  loading: boolean;
  error: ApiError | null;
  isStub: boolean;
  refetch: () => void;
}

export interface QueryOptions {
  pollMs?: number;
  // When true, a 404 falls back to the caller-provided `fallback` value and
  // flags `isStub`. When false (default), 404 is treated as an error.
  fallbackOnStub?: boolean;
}

export function useQuery<T>(
  path: string,
  query: object | undefined,
  fallback: T | null,
  opts: QueryOptions = {},
): QueryResult<T> {
  const [data, setData] = useState<T | null>(fallback ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [isStub, setIsStub] = useState(false);
  const [nonce, setNonce] = useState(0);

  // Stable query key for effect deps without re-fetching on every render.
  const queryKey = query ? JSON.stringify(query) : '';
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);

    apiRequest<T>(path, {
      query: query as Record<string, string | number | undefined> | undefined,
      signal: controller.signal,
    })
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setIsStub(res.isStub);
      })
      .catch((err: unknown) => {
        if (cancelled || (err as Error).name === 'AbortError') return;
        if (err instanceof EndpointStubError && opts.fallbackOnStub) {
          setData(fallbackRef.current ?? null);
          setIsStub(true);
          setError(null);
        } else if (err instanceof ApiError) {
          setError(err);
        } else {
          setError(new ApiError(0, 'Unknown error', err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey, nonce]);

  // Polling — opt-in per caller. Only polls after initial load settles.
  useEffect(() => {
    if (!opts.pollMs || opts.pollMs <= 0) return;
    const id = setInterval(() => setNonce((n) => n + 1), opts.pollMs);
    return () => clearInterval(id);
  }, [opts.pollMs]);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  return { data, loading, error, isStub, refetch };
}

// ─── Endpoint-specific hooks ─────────────────────────────────────────

export interface OverviewKpis {
  bets: { count: number; volumeMicro: string };
  wins: { count: number; volumeMicro: string };
  ggrMicro: string;
  ngrMicro: string;
  activeSessions: number;
  trend24h: Array<{ t: string; betsMicro: string; winsMicro: string }>;
  currency: string;
}

export function useOverview() {
  return useQuery<OverviewKpis>('/v1/admin/overview', undefined, null, {
    pollMs: 10_000,
    fallbackOnStub: true,
  });
}

export interface GameConfigRow {
  id: string;
  gameCode: string;
  currency: string;
  enabled: boolean;
  lowWeight: number;
  highWeight: number;
  minBetMicro: string;
  maxBetMicro: string;
  bettingWindowMs: number;
  rollingWindowMs: number;
  cooldownMs: number;
  updatedAt: string;
}

export function useGameConfigs() {
  return useQuery<{ items: GameConfigRow[] }>('/v1/admin/game-config', undefined, null, {
    fallbackOnStub: true,
  });
}

export interface RoundSummary {
  id: string;
  gameCode: string;
  currency: string;
  nonce: number;
  state: string;
  outcomeSum: number | null;
  outcomeSide: 'LOW' | 'HIGH' | null;
  totalBetsMicro: string;
  totalPayoutsMicro: string;
  settled: boolean;
  startedAt: string | null;
  settledAt: string | null;
}

export interface RoundsPage {
  items: RoundSummary[];
  nextCursor: string | null;
}

export interface RoundsFilters {
  cursor?: string;
  from?: string;
  to?: string;
  state?: string;
  currency?: string;
}

export function useRounds(filters: RoundsFilters) {
  return useQuery<RoundsPage>('/v1/admin/rounds', filters, null, { fallbackOnStub: true });
}

export interface RoundDetail {
  round: RoundSummary & {
    serverSeed: string;
    serverSeedHash: string;
    clientSeed: string;
    diceValues: number[];
    lowWeight: number;
    highWeight: number;
  };
  bets: Array<{
    id: string;
    playerRef: string;
    side: 'LOW' | 'HIGH';
    amountMicro: string;
    wonAmountMicro: string | null;
    status: string;
    betTransactionUuid: string;
    winTransactionUuid: string | null;
  }>;
  walletCalls: Array<WalletCallRow>;
}

export function useRoundDetail(id: string | undefined) {
  return useQuery<RoundDetail>(id ? `/v1/admin/rounds/${id}` : '', undefined, null, {
    fallbackOnStub: true,
  });
}

export interface WalletCallRow {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  endpoint: 'BALANCE' | 'BET' | 'WIN' | 'ROLLBACK' | 'END_ROUND';
  requestUuid: string;
  transactionUuid: string | null;
  roundId: string | null;
  playerRef: string | null;
  amountMicro: string | null;
  currency: string | null;
  httpStatus: number | null;
  responseStatus: string | null;
  latencyMs: number | null;
  attempt: number;
  succeeded: boolean;
  createdAt: string;
}

export interface WalletCallsFilters {
  cursor?: string;
  from?: string;
  to?: string;
  endpoint?: string;
  succeeded?: string;
  roundId?: string;
}

export function useWalletCalls(filters: WalletCallsFilters) {
  return useQuery<{ items: WalletCallRow[]; nextCursor: string | null }>(
    '/v1/admin/wallet-calls',
    filters,
    null,
    { fallbackOnStub: true },
  );
}

export interface SessionRow {
  id: string;
  playerRef: string;
  currency: string;
  mode: 'REAL' | 'DEMO';
  betCount: number;
  netPositionMicro: string;
  createdAt: string;
  expiresAt: string;
  terminatedAt: string | null;
}

export function useSessions() {
  return useQuery<{ items: SessionRow[] }>('/v1/admin/sessions', undefined, null, {
    pollMs: 10_000,
    fallbackOnStub: true,
  });
}

export interface DailyReport {
  date: string;
  currency: string;
  bets: { count: number; volumeMicro: string };
  wins: { count: number; volumeMicro: string };
  ggrMicro: string;
  ngrMicro: string;
  rtpPct: number;
}

export function useReportsDaily(range: { from: string; to: string }) {
  return useQuery<{ items: DailyReport[] }>('/v1/admin/reports/daily', range, null, {
    fallbackOnStub: true,
  });
}

export interface CredentialRow {
  id: string;
  kid: string;
  type: 'API_KEY_INBOUND' | 'WALLET_HMAC_OUTBOUND';
  label: string | null;
  notBefore: string;
  notAfter: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function useCredentials() {
  return useQuery<{ items: CredentialRow[] }>('/v1/admin/credentials', undefined, null, {
    fallbackOnStub: true,
  });
}

// ── Circuit breakers (GET /v1/admin/circuit-breakers) ───────────────────

export type CircuitState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export interface CircuitBreakerRow {
  operatorId: string;
  gameCode: string;
  currency: string;
  breakers: Record<
    string,
    { state: CircuitState; consecutiveFailures: number; openedAt: number }
  >;
}

export function useCircuitBreakers() {
  return useQuery<{ items: CircuitBreakerRow[]; collectedAt: string }>(
    '/v1/admin/circuit-breakers',
    undefined,
    null,
    { pollMs: 15_000, fallbackOnStub: true },
  );
}

// ── Engines (GET /v1/admin/engines) ─────────────────────────────────────

export interface EngineRow {
  operatorId: string;
  gameCode: string;
  currency: string;
  phase: string;
  currentRoundId: string | null;
  currentNonce: number | null;
  bettingWindowMs: number;
}

export function useEngines() {
  return useQuery<{ items: EngineRow[] }>('/v1/admin/engines', undefined, null, {
    pollMs: 15_000,
    fallbackOnStub: true,
  });
}

// ── Pending jobs (GET /v1/admin/pending-jobs) ───────────────────────────

export interface PendingJobRow {
  id: string;
  endpoint: 'BET' | 'WIN' | 'ROLLBACK' | 'BALANCE' | 'END_ROUND';
  betId: string | null;
  roundId: string | null;
  attempts: number;
  nextAttemptAt: string;
  lockedUntil: string | null;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface PendingJobsFilters {
  endpoint?: string;
  includeCompleted?: string;
  cursor?: string;
}

export function usePendingJobs(filters: PendingJobsFilters) {
  return useQuery<{ items: PendingJobRow[]; nextCursor: string | null }>(
    '/v1/admin/pending-jobs',
    filters,
    null,
    { pollMs: 10_000, fallbackOnStub: true },
  );
}

// ── Session detail (GET /v1/admin/sessions/:id) ─────────────────────────

export interface SessionDetail {
  session: {
    id: string;
    playerRef: string;
    gameCode: string;
    currency: string;
    lang: string;
    jurisdiction: string;
    mode: 'REAL' | 'DEMO';
    rgLimits: Record<string, unknown> | null;
    serverSeedHash: string;
    clientSeed: string;
    nonce: number;
    createdAt: string;
    expiresAt: string;
    terminatedAt: string | null;
    terminationReason: string | null;
  };
  summary: {
    roundCount: number;
    betCount: number;
    betsMicro: string;
    winsMicro: string;
    netMicro: string;
  };
  rounds: Array<{
    id: string;
    nonce: number;
    state: string;
    outcomeSum: number | null;
    outcomeSide: 'LOW' | 'HIGH' | null;
    totalBetsMicro: string;
    totalPayoutsMicro: string;
    startedAt: string | null;
    settledAt: string | null;
  }>;
  bets: Array<{
    id: string;
    roundId: string;
    side: 'LOW' | 'HIGH';
    amountMicro: string;
    wonAmountMicro: string | null;
    status: string;
    placedAt: string;
    settledAt: string | null;
  }>;
}

export function useSessionDetail(id: string | undefined) {
  return useQuery<SessionDetail>(
    id ? `/v1/admin/sessions/${id}` : '',
    undefined,
    null,
    { fallbackOnStub: true },
  );
}
