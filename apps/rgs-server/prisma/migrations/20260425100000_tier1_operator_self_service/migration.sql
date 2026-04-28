-- Tier-1 operator self-service:
--   * OperatorEnvironment enum + Operator.environment + sibling pairing
--   * Operator.allowed_currencies whitelist
--   * MFA + disabled state on OperatorUser; expanded OperatorRole
--   * OperatorUserInvite (invite flow with single-use hashed tokens)
--   * WebhookSubscription + WebhookDelivery (outbound event bus)
--   * OperatorSigningKey (asymmetric launch JWT)

-- ── Enums ──────────────────────────────────────────────────
CREATE TYPE "OperatorEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');
CREATE TYPE "WebhookDeliveryState" AS ENUM (
  'PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED_RETRY', 'DEAD_LETTERED'
);
CREATE TYPE "SigningKeyStatus" AS ENUM ('ACTIVE', 'RETIRING', 'RETIRED');

-- ── Operator extensions ────────────────────────────────────
ALTER TABLE "operators"
  ADD COLUMN "environment" "OperatorEnvironment" NOT NULL DEFAULT 'PRODUCTION',
  ADD COLUMN "sibling_operator_id" UUID,
  ADD COLUMN "allowed_currencies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "operators_environment_idx" ON "operators" ("environment");
CREATE INDEX "operators_sibling_operator_id_idx" ON "operators" ("sibling_operator_id");

-- ── OperatorRole expansion (add OPERATOR_FINANCE, OPERATOR_SUPPORT) ──
ALTER TYPE "OperatorRole" ADD VALUE IF NOT EXISTS 'OPERATOR_FINANCE';
ALTER TYPE "OperatorRole" ADD VALUE IF NOT EXISTS 'OPERATOR_SUPPORT';

-- ── OperatorUser: MFA + disabled state ─────────────────────
ALTER TABLE "operator_users"
  ADD COLUMN "mfa_totp_secret_cipher" BYTEA,
  ADD COLUMN "mfa_enrolled_at" TIMESTAMP(3),
  ADD COLUMN "mfa_recovery_codes_hash" TEXT,
  ADD COLUMN "disabled_at" TIMESTAMP(3),
  ADD COLUMN "disabled_by" VARCHAR(254);

-- ── OperatorUserInvite ─────────────────────────────────────
CREATE TABLE "operator_user_invites" (
  "id" UUID NOT NULL,
  "operator_id" UUID NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "role" "OperatorRole" NOT NULL DEFAULT 'OPERATOR_VIEWER',
  "token_hash" VARCHAR(128) NOT NULL,
  "invited_by_email" VARCHAR(254) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_user_invites_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "operator_user_invites_token_hash_key"
  ON "operator_user_invites" ("token_hash");
CREATE INDEX "operator_user_invites_operator_id_idx"
  ON "operator_user_invites" ("operator_id");
CREATE INDEX "operator_user_invites_email_idx"
  ON "operator_user_invites" ("email");
CREATE INDEX "operator_user_invites_expires_at_idx"
  ON "operator_user_invites" ("expires_at");

ALTER TABLE "operator_user_invites"
  ADD CONSTRAINT "operator_user_invites_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── WebhookSubscription ────────────────────────────────────
CREATE TABLE "webhook_subscriptions" (
  "id" UUID NOT NULL,
  "operator_id" UUID NOT NULL,
  "url" TEXT NOT NULL,
  "event_types" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "secret_cipher" BYTEA NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "description" VARCHAR(200),
  "secret_version" VARCHAR(16) NOT NULL DEFAULT 'v1',
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "last_success_at" TIMESTAMP(3),
  "last_failure_at" TIMESTAMP(3),
  "last_failure_reason" VARCHAR(256),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_subscriptions_operator_id_enabled_idx"
  ON "webhook_subscriptions" ("operator_id", "enabled");
ALTER TABLE "webhook_subscriptions"
  ADD CONSTRAINT "webhook_subscriptions_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── WebhookDelivery ────────────────────────────────────────
CREATE TABLE "webhook_deliveries" (
  "id" UUID NOT NULL,
  "subscription_id" UUID NOT NULL,
  "operator_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "event_type" VARCHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "signature" VARCHAR(128) NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "next_attempt_at" TIMESTAMP(3),
  "state" "WebhookDeliveryState" NOT NULL DEFAULT 'PENDING',
  "http_status" INTEGER,
  "response_body" TEXT,
  "latency_ms" INTEGER,
  "completed_at" TIMESTAMP(3),
  "dead_lettered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_deliveries_operator_id_state_idx"
  ON "webhook_deliveries" ("operator_id", "state");
CREATE INDEX "webhook_deliveries_event_id_idx"
  ON "webhook_deliveries" ("event_id");
CREATE INDEX "webhook_deliveries_next_attempt_at_idx"
  ON "webhook_deliveries" ("next_attempt_at");
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── OperatorSigningKey ─────────────────────────────────────
CREATE TABLE "operator_signing_keys" (
  "id" UUID NOT NULL,
  "operator_id" UUID NOT NULL,
  "kid" VARCHAR(64) NOT NULL,
  "algorithm" VARCHAR(16) NOT NULL DEFAULT 'ES256',
  "public_jwk" JSONB NOT NULL,
  "private_jwk_cipher" BYTEA NOT NULL,
  "status" "SigningKeyStatus" NOT NULL DEFAULT 'ACTIVE',
  "not_before" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "not_after" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operator_signing_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_signing_keys_kid_key"
  ON "operator_signing_keys" ("kid");
CREATE INDEX "operator_signing_keys_operator_id_status_idx"
  ON "operator_signing_keys" ("operator_id", "status");
ALTER TABLE "operator_signing_keys"
  ADD CONSTRAINT "operator_signing_keys_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
