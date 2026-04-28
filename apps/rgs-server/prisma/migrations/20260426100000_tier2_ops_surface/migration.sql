-- Tier-2 ops surface:
--   * admin_audit_entries  — who did what on /v1/platform routes
--   * global_kill_switch   — emergency stop of every engine
--   * certificates artifact columns (file_size, file_sha256)

CREATE TABLE "admin_audit_entries" (
  "id" UUID NOT NULL,
  "actor_user_id" UUID,
  "actor_email" VARCHAR(254) NOT NULL,
  "actor_role" VARCHAR(32) NOT NULL,
  "method" VARCHAR(8) NOT NULL,
  "path" VARCHAR(256) NOT NULL,
  "target_type" VARCHAR(32),
  "target_id" VARCHAR(128),
  "body_summary" JSONB,
  "response_status" INTEGER NOT NULL,
  "latency_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_audit_entries_actor_user_id_created_at_idx"
  ON "admin_audit_entries" ("actor_user_id", "created_at");
CREATE INDEX "admin_audit_entries_path_created_at_idx"
  ON "admin_audit_entries" ("path", "created_at");
CREATE INDEX "admin_audit_entries_target_type_target_id_created_at_idx"
  ON "admin_audit_entries" ("target_type", "target_id", "created_at");

CREATE TABLE "global_kill_switch" (
  "id" VARCHAR(16) NOT NULL DEFAULT 'singleton',
  "engaged" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(256),
  "engaged_at" TIMESTAMP(3),
  "engaged_by" VARCHAR(254),
  "disengaged_at" TIMESTAMP(3),
  "disengaged_by" VARCHAR(254),
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "global_kill_switch_pkey" PRIMARY KEY ("id")
);

-- Seed the singleton row so callers can UPDATE without first INSERTing.
INSERT INTO "global_kill_switch" ("id", "engaged", "updated_at")
  VALUES ('singleton', false, CURRENT_TIMESTAMP)
  ON CONFLICT DO NOTHING;

ALTER TABLE "certificates"
  ADD COLUMN "file_size" INTEGER,
  ADD COLUMN "file_sha256" VARCHAR(64);
