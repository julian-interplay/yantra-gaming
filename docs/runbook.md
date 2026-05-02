# Operator Runbook

> Day-2 operations for Yantra Gaming. What to do on first deploy, what to do
> when things break, how to rotate keys, how to back up money-path data.

**Audience:** SRE / ops engineer / infra lead at a licensee.

**Companions:**

- [architecture.md](./architecture.md), what the system is
- [incidents.md](./incidents.md), what to do when it's on fire
- [security.md](./security.md), threat model + published SLOs
- [change-management.md](./change-management.md), RNG / math change gating
- [observability.md](./observability.md), metrics, alerts, RTP drift monitor

---

## 1. Deployment topologies

### 1.1 Local dev (reference)

`docker compose up -d` starts Postgres on `:5434`. `bun run dev` runs all four
apps. See [README.md Quickstart](https://github.com/dinethlive/yantra-gaming#quickstart).

### 1.2 Single-region production

Minimum viable prod:

```
                        ┌──── TLS/HSTS ────┐
   Internet ──▶ WAF ──▶ │ Load balancer    │ ──▶ rgs-server × N (3+)
                        └──────────────────┘          │
                                                      ▼
                                         Postgres 16 (primary + 2 replicas)
                                                      │
                                                      ▼
                                         Daily pg_dump → object storage
```

**Stateful components:**
- Postgres 16+ with logical replication to at least one hot replica.
- Persistent volume for `pg_data`.
- Encrypted object storage for pg_dump output (retention per §5).

**Stateless components:**
- `rgs-server`: horizontally scalable, sharded on `operatorId` if >10k
  concurrent sessions. See §1.4 for sharding notes.
- `operator-portal`, `game-client`: static builds served from CDN.

### 1.3 Multi-region

Cert-lab jurisdictions (Germany, Malta) require in-country data residency.
Pattern:

- Primary region with writer Postgres.
- Per-jurisdiction read replica + local rgs-server cluster.
- Round writes go to the primary; proof reads serve from the nearest replica.
- Session JWTs carry `jurisdiction`; the engine honours the claim when
  selecting which replica to read from.

Full multi-region is on the v1.1 roadmap (see
[B2B_ROADMAP.md §17](../B2B_ROADMAP.md#17-versioning-and-delivery)); the
schema already supports it (no region-local auto-increment keys; every ID
is a UUID).

### 1.4 Horizontal scale

A single `rgs-server` process owns the game-engine loop for **one**
`(operatorId, gameCode, currency)` tuple at a time. To scale past one node:

1. Shard on `operatorId` hash → assign each shard range to a distinct
   `rgs-server` pod.
2. Use a leader-lock (advisory lock in Postgres or Redis) to guarantee
   single-writer per shard.
3. Keep socket connections sticky to the owning shard (load balancer:
   consistent-hash by `operatorId` from the session JWT).

Not implemented in this repo. `EngineRegistry.startAllEnabled()` currently
starts every enabled engine on boot, which is correct for single-node
deployments and the dev loop.

---

## 2. Docker

The repo ships `docker-compose.yml` for Postgres only. A production
`Dockerfile` for `rgs-server` is a licensee-specific artefact, but a minimal
reference:

```dockerfile
FROM oven/bun:1.3.10-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/rgs-server ./apps/rgs-server
COPY packages ./packages
RUN bun install --frozen-lockfile
RUN cd apps/rgs-server && bun run build

FROM oven/bun:1.3.10-alpine AS runtime
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/rgs-server
EXPOSE 4500
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:4500/readyz || exit 1
CMD ["bun", "dist/index.js"]
```

Pin Bun to the version in `.tool-versions` (`1.3.10` at time of writing).
Never use `oven/bun:latest` in a production build.

---

## 3. Environment variables

Every variable the RGS reads. Source: `apps/rgs-server/src/config.ts`.

### 3.1 Required

| Var | Type | Purpose | Failure mode |
| --- | --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | DB connection for Prisma | Boot fails |
| `SESSION_JWT_SECRET` | ≥ 16-char string | HS256 signing key for player session JWTs | Boot fails |
| `PORTAL_JWT_SECRET` | ≥ 16-char string | HS256 signing key for operator-portal login cookies | Boot fails |
| `SECRETS_MASTER_KEY_B64` | 32-byte base64 | AES-GCM key for encrypting `OperatorCredential.cipherBlob` | Boot fails; rotating this requires re-encrypting every credential (§6) |

### 3.2 Optional (with defaults)

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4500` | HTTP + Socket.IO bind port |
| `CORS_ORIGIN` | `http://localhost:3100,http://localhost:3101,http://localhost:3102` | Comma-separated allowed origins. Set to production domains in prod. |
| `SIGNATURE_WINDOW_SECONDS` | `30` | Max clock skew on inbound HMAC requests. Do not exceed 60. |
| `GAME_CLIENT_BASE_URL` | `http://localhost:3100` | Base URL used in launch responses. |
| `WALLET_CALL_TIMEOUT_MS` | `5000` | Outbound wallet-call timeout. Beyond this → synthetic rollback. |
| `MOCK_WALLET_CALLBACK_URL` | `http://localhost:4300/wallet` locally; required for production seed | Seeded mock operator wallet callback base. Never use localhost on Railway. |
| `NODE_ENV` | `development` | `development` / `production` / `test`. |
| `TURNSTILE_SECRET_KEY` | (unset → disabled) | Cloudflare Turnstile secret. When set, `/v1/session` requires a valid token. |
| `TURNSTILE_SITEVERIFY_URL` | `https://challenges.cloudflare.com/turnstile/v0/siteverify` | Override for self-hosted siteverify. |

### 3.3 Railway Wallet Callback Check

After every Railway deploy that runs `bun src/seed.ts`, verify the seeded mock operator did not point back to localhost:

```sql
SELECT id, wallet_callback_url
FROM operators
WHERE id = '00000000-0000-4000-8000-000000000001';
```

For the Lempi pilot, the value must be:

```text
https://hondudev.testinterplay.com/api/integrations/casino/interplay/wallet
```

Then verify `/healthz`, `/readyz`, refresh the game once, and confirm a `BALANCE` row in `wallet_calls` has `succeeded = true`.

### 3.4 Observability (optional)

| Var | Default | Purpose |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset → disabled) | OTLP collector endpoint |
| `OTEL_SERVICE_NAME` | `yantra-rgs` | Service name for traces |
| `OTEL_LOG_LEVEL` | `info` | OTel SDK log verbosity |

### 3.5 Secret-strength guidance

- `SESSION_JWT_SECRET` / `PORTAL_JWT_SECRET`: ≥ 32 random bytes, base64 or hex. Generate:
  ```bash
  openssl rand -base64 48
  ```
- `SECRETS_MASTER_KEY_B64`: exactly 32 bytes, base64-encoded:
  ```bash
  openssl rand -base64 32
  ```

In production, all three of these should come from a KMS (AWS KMS,
HashiCorp Vault, GCP Secret Manager) injected at boot, never from a static
env file. The dev `.env.example` placeholders are zero bytes, rotate them
before any non-dev use.

---

## 4. Health checks

The RGS exposes three HTTP paths for liveness/readiness:

| Path | Purpose | Fails when |
| --- | --- | --- |
| `/healthz` | Liveness, process can answer HTTP | Never fails once listening |
| `/readyz` | Readiness, DB reachable, seed operators started | DB unreachable, engine registry not initialised |
| `/metrics` | Prometheus scrape endpoint | Returns empty metrics if OTel disabled |

**Kubernetes probe recommendations:**

```yaml
readinessProbe:
  httpGet: { path: /readyz, port: 4500 }
  initialDelaySeconds: 5
  periodSeconds: 3
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /healthz, port: 4500 }
  initialDelaySeconds: 30
  periodSeconds: 10
  failureThreshold: 5
```

`/readyz` should fail closed during graceful shutdown so the load balancer
drains traffic before the process exits. The shipping `shutdown` handler in
`index.ts` does this.

---

## 5. Backup and restore

### 5.1 What to back up

Every money-path table. Specifically:

- `Operator`, `OperatorCredential` (secrets are encrypted in the blob; still back up)
- `OperatorGameConfig`, `OperatorConfigAuditLog`
- `GameSession`, `Round`, `Bet`, `PendingRoundBet`
- `WalletCall`, `PendingWalletJob`, `InboundIdempotency`
- `OperatorUser`

`inbound_idempotency` can be pruned after 24h in principle; in production
retain at least 30 days for dispute investigation.

### 5.2 Daily dump

```bash
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="yantra_$(date -u +%Y%m%d).dump"

# encrypt before upload
age -r age1... -o yantra_$(date -u +%Y%m%d).dump.age yantra_$(date -u +%Y%m%d).dump
```

Upload the encrypted blob to object storage with **object lock** enabled so
it cannot be tampered with before retention expires.

### 5.3 Retention

| Jurisdiction | Minimum retention |
| --- | --- |
| Unregulated / pre-launch | 90 days |
| Curaçao LOK | 5 years (for money-path and audit tables) |
| MGA Malta | 7 years |
| UKGC | 7 years |

Purging only kicks in when the longest applicable jurisdiction permits. In
practice: never purge money-path rows older than the longest retention
among onboarded operators.

### 5.4 Restore drill

**Run a restore drill every quarter.** Untested backups are worse than no
backups, you'll find out they're corrupted when you need them.

```bash
# 1. Fresh DB
createdb yantra_restore_drill
pg_restore --dbname=yantra_restore_drill --no-owner yantra_YYYYMMDD.dump

# 2. Schema sanity
psql yantra_restore_drill -c 'SELECT count(*) FROM wallet_calls;'
psql yantra_restore_drill -c 'SELECT count(*) FROM rounds WHERE settled=false;'

# 3. Application smoke: boot the rgs-server against this DB, hit /readyz
DATABASE_URL=postgres://localhost:5432/yantra_restore_drill bun run dev:rgs
curl http://localhost:4500/readyz    # must be 200
```

Document the drill outcome. Failed restores are incidents, file per
[incidents.md](./incidents.md).

---

## 6. Key rotation

### 6.1 Operator credentials

Each `OperatorCredential` row carries `notBefore`, `notAfter`, and
`revokedAt`. The inbound-auth middleware accepts any credential for which
`notBefore ≤ now < notAfter AND revokedAt IS NULL`.

To rotate:

```
1. Portal → Operator Settings → Credentials → "Add new credential"
2. Overlap window: new credential notBefore = now; old credential notAfter = now + 7d
3. Distribute new (kid, secret) to the operator via secure channel (1Password, Vault, PGP)
4. After the operator confirms they're signing with the new credential, set
   old credential revokedAt = now
5. Reject any inbound request using the old credential
```

**Emergency rotation** (suspected compromise): skip the overlap window.
Revoke immediately, alert the operator, expect a brief integration outage.

### 6.2 `SECRETS_MASTER_KEY_B64`

This key encrypts every `OperatorCredential.cipherBlob`. Rotating it
requires re-encrypting every row:

```
1. Generate new key:  openssl rand -base64 32
2. Write a one-shot script:
   - Boot with OLD key
   - SELECT every OperatorCredential → decrypt to plaintext
   - Switch to NEW key
   - Re-encrypt → UPDATE OperatorCredential.cipherBlob
3. Deploy with new key
4. Old key retained for read-only access to ciphertext older than the
   rotation (backups, archived rows) for the retention window (§5.3)
```

Script skeleton lives in `scripts/rotate-master-key.ts` *(not yet
implemented, add on first production rotation)*. Until then, this is a
manual procedure with a compliance lead present.

### 6.3 Session / portal JWT secrets

Rotating `SESSION_JWT_SECRET` invalidates every live player session ,
players will be kicked out mid-round. Mitigate by:

1. Maintain a short JWT lifetime (≤ 60 min, already the default).
2. Deploy the rotation at a low-traffic window.
3. Optionally support dual-key verification during a rollover window by
   patching the session-auth middleware (not shipped by default).

`PORTAL_JWT_SECRET` rotation forces operator-portal users to re-login, a
brief, acceptable impact.

---

## 7. Database maintenance

### 7.1 Migrations

```bash
# Dev:
bun run db:migrate

# Prod (apply only, never `dev`):
cd apps/rgs-server && bunx --bun prisma migrate deploy
```

Migrations that change money-path tables are regated, see
[change-management.md §1.2](./change-management.md#12-schema).

### 7.2 Index health

Watch these indexes:

- `wallet_calls (operator_id, direction, endpoint, request_uuid)`: the
  dedupe unique index; if bloated, dedupe performance drops.
- `rounds (operator_id, settled, created_at)`: crash-recovery scan.
- `pending_wallet_jobs (completed_at, next_attempt_at)`: retry queue.

`REINDEX CONCURRENTLY` these quarterly or when `pg_stat_user_indexes.idx_scan`
reveals a slowdown.

### 7.3 Vacuum

Autovacuum defaults are adequate for volumes up to ~10M bets/day. Above
that, tune `autovacuum_vacuum_scale_factor` on the high-churn tables
(`wallet_calls`, `rounds`, `bets`).

---

## 8. Graceful shutdown

The RGS handles `SIGTERM` / `SIGINT`:

1. Stop accepting new sessions (`/readyz` → 503).
2. `PendingJobRunner.stop()`: current iteration finishes; no new jobs pulled.
3. `reconciliationJob.stop()`.
4. `EngineRegistry.stopAll()`: every engine finishes its current round to
   SETTLED or VOIDED. New rounds blocked.
5. `httpServer.close()` + `io.close()`: wait for active HTTP and WebSocket
   connections to drain.
6. `prisma.$disconnect()`.
7. Exit.

**Do not `kill -9` a running RGS.** Crash recovery is safe, but unnecessary
voided rounds are bad player experience. The graceful path respects
in-flight rounds.

**Drain SLO:** graceful shutdown completes in ≤ 60 seconds under normal
load. If it doesn't, the orchestrator's kill-after timeout should be set
accordingly (e.g. Kubernetes `terminationGracePeriodSeconds: 75`).

---

## 9. Daily reconciliation

Run `scripts/reconcile.ts` against the operator's daily settlement file:

```bash
bun scripts/reconcile.ts \
  --operator op_abc123 \
  --currency LKR \
  --date 2026-04-22 \
  --file operator-settlement-2026-04-22.csv
```

CSV format, one row per `(operatorId, date, currency)`:

```csv
operatorId,date,currency,betsAmountMicro,winsAmountMicro,rollbacksAmountMicro
op_abc123,2026-04-22,LKR,12500000000000,11675000000000,0
```

Exit codes:

- `0`: MATCH (drift == 0)
- `1`: MINOR_DRIFT (< 0.1 %; log warning, do not page)
- `2`: MAJOR_DRIFT (≥ 0.1 %; page oncall immediately)
- `3`: input parse error

Wire into cron at 01:00 UTC daily, piping exit code to your alerting.

---

## 10. Monitoring dashboards

See [observability.md](./observability.md) for the full metrics catalogue.
The minimum set you must have a dashboard on:

1. `wallet_call_latency_ms{endpoint="bet"}`: p50 / p99 / p99.9
2. `wallet_call_errors_total{endpoint="win", rs_status != "RS_OK"}`: any
   non-zero rate pages oncall
3. `pending_wallet_jobs` gauge, alert if any row is older than 5 min
4. `rtp_actual_rolling_24h{operator, currency}`: alert at |drift| > 3σ
5. `round_state_transitions_total{to_state="VOIDED"}`: spike indicates
   crash-recovery or operator-terminate activity
6. `/readyz` probe success rate, Kubernetes readiness

---

## 11. Runbook version

| Field | Value |
| --- | --- |
| Runbook version | 1.0.0 |
| Last reviewed | 2026-04-23 |
| Review cadence | Every major release, or after any incident that exposes a gap |
