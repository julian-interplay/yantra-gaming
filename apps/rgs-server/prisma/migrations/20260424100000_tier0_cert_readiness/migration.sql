-- Tier-0 cert-readiness:
--   * RNG algorithm identifier stamped on every round + certificate
--   * Runtime build hash + monotonic clock anchor stamped on every round
--   * Tamper-evident hash chain columns on rounds + wallet_calls
--   * Daily signed audit-chain anchors (audit_anchors table)

-- ── Certificate: rng_version ─────────────────────────────────
ALTER TABLE "certificates"
  ADD COLUMN "rng_version" VARCHAR(32);

-- ── Round: rng_version, build_hash, started_at_mono_ns, row-hash chain
ALTER TABLE "rounds"
  ADD COLUMN "rng_version" VARCHAR(32) NOT NULL DEFAULT 'ketapola-rng-v1',
  ADD COLUMN "build_hash" VARCHAR(64),
  ADD COLUMN "started_at_mono_ns" BIGINT,
  ADD COLUMN "prev_row_hash" VARCHAR(64),
  ADD COLUMN "row_hash" VARCHAR(64);

CREATE INDEX "rounds_rng_version_idx" ON "rounds" ("rng_version");

-- ── WalletCall: row-hash chain columns ─────────────────────
ALTER TABLE "wallet_calls"
  ADD COLUMN "prev_row_hash" VARCHAR(64),
  ADD COLUMN "row_hash" VARCHAR(64);

-- ── AuditAnchor: daily tip of the tamper-evident log ───────
CREATE TABLE "audit_anchors" (
  "id" UUID NOT NULL,
  "period_date" DATE NOT NULL,
  "stream_name" VARCHAR(32) NOT NULL,
  "operator_id" UUID,
  "first_row_id" VARCHAR(64),
  "last_row_id" VARCHAR(64),
  "row_count" INTEGER NOT NULL DEFAULT 0,
  "tip_hash" VARCHAR(64) NOT NULL,
  "manifest" JSONB NOT NULL,
  "signature" TEXT NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL DEFAULT 'HMAC-SHA256',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_anchors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "audit_anchors_period_date_stream_name_operator_id_key"
  ON "audit_anchors" ("period_date", "stream_name", "operator_id");

CREATE INDEX "audit_anchors_period_date_idx"
  ON "audit_anchors" ("period_date");
