-- Follow-ups after Tier 2:
--   * Granular KETAPOLA staff roles (KETAPOLA_COMPLIANCE/AUDITOR/SUPPORT)
--   * WebAuthn credentials + challenges (FIDO2 / passkeys)
--   * Cert upload tokens (presigned PUT)

-- ── Expand OperatorRole with staff sub-roles ─────────────────
ALTER TYPE "OperatorRole" ADD VALUE IF NOT EXISTS 'KETAPOLA_COMPLIANCE';
ALTER TYPE "OperatorRole" ADD VALUE IF NOT EXISTS 'KETAPOLA_AUDITOR';
ALTER TYPE "OperatorRole" ADD VALUE IF NOT EXISTS 'KETAPOLA_SUPPORT';

-- ── webauthn_credentials ─────────────────────────────────────
CREATE TABLE "webauthn_credentials" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "credential_id" VARCHAR(512) NOT NULL,
  "public_key" BYTEA NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "transports" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "aaguid" VARCHAR(36),
  "device_name" VARCHAR(100),
  "backed_up" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  CONSTRAINT "webauthn_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webauthn_credentials_credential_id_key"
  ON "webauthn_credentials" ("credential_id");
CREATE INDEX "webauthn_credentials_user_id_idx"
  ON "webauthn_credentials" ("user_id");
ALTER TABLE "webauthn_credentials"
  ADD CONSTRAINT "webauthn_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "operator_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── webauthn_challenges (short-lived) ────────────────────────
CREATE TABLE "webauthn_challenges" (
  "id" UUID NOT NULL,
  "user_id" UUID,
  "email" VARCHAR(254),
  "challenge" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webauthn_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webauthn_challenges_user_id_kind_idx"
  ON "webauthn_challenges" ("user_id", "kind");
CREATE INDEX "webauthn_challenges_email_kind_idx"
  ON "webauthn_challenges" ("email", "kind");
CREATE INDEX "webauthn_challenges_expires_at_idx"
  ON "webauthn_challenges" ("expires_at");

-- ── cert_upload_tokens (short-lived PUT authorisation) ───────
CREATE TABLE "cert_upload_tokens" (
  "id" UUID NOT NULL,
  "certificate_id" UUID NOT NULL,
  "token" VARCHAR(128) NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cert_upload_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cert_upload_tokens_token_key"
  ON "cert_upload_tokens" ("token");
CREATE INDEX "cert_upload_tokens_certificate_id_idx"
  ON "cert_upload_tokens" ("certificate_id");
CREATE INDEX "cert_upload_tokens_expires_at_idx"
  ON "cert_upload_tokens" ("expires_at");
