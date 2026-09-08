CREATE TYPE "RpsTournamentStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'REGISTERING', 'RUNNING', 'SETTLING', 'COMPLETED', 'CANCELLED');
CREATE TYPE "RpsParticipantStatus" AS ENUM ('REGISTERED', 'ACTIVE', 'ELIMINATED', 'WINNER');
CREATE TYPE "RpsMatchStatus" AS ENUM ('PENDING', 'OPEN', 'RESOLVED', 'TIED', 'BYE');
CREATE TYPE "RpsHand" AS ENUM ('ROCK', 'PAPER', 'SCISSORS');
CREATE TYPE "RpsAwardStatus" AS ENUM ('PENDING', 'AWARDED', 'FAILED');

ALTER TYPE "WalletEndpoint" ADD VALUE 'AWARD';

CREATE TABLE "rps_tournaments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operator_id" UUID NOT NULL,
  "title" VARCHAR(140) NOT NULL,
  "currency" VARCHAR(8) NOT NULL DEFAULT 'HNL',
  "status" "RpsTournamentStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduled_start_at" TIMESTAMP(3) NOT NULL,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "cancelled_reason" VARCHAR(256),
  "min_players" INTEGER NOT NULL DEFAULT 2,
  "choice_window_ms" INTEGER NOT NULL DEFAULT 12000,
  "round_break_ms" INTEGER NOT NULL DEFAULT 3000,
  "prize_table" JSONB NOT NULL DEFAULT '[]',
  "seed" VARCHAR(128) NOT NULL,
  "seed_hash" VARCHAR(128) NOT NULL,
  "current_round" INTEGER NOT NULL DEFAULT 0,
  "created_by" VARCHAR(254),
  "updated_by" VARCHAR(254),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rps_tournaments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rps_participants" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operator_id" UUID NOT NULL,
  "tournament_id" UUID NOT NULL,
  "session_id" UUID,
  "player_ref" VARCHAR(128) NOT NULL,
  "display_name" VARCHAR(80),
  "status" "RpsParticipantStatus" NOT NULL DEFAULT 'REGISTERED',
  "rank" INTEGER,
  "eliminated_at" TIMESTAMP(3),
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3),
  CONSTRAINT "rps_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rps_matches" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operator_id" UUID NOT NULL,
  "tournament_id" UUID NOT NULL,
  "round_number" INTEGER NOT NULL,
  "attempt_number" INTEGER NOT NULL DEFAULT 1,
  "participant_a_id" UUID,
  "participant_b_id" UUID,
  "winner_id" UUID,
  "status" "RpsMatchStatus" NOT NULL DEFAULT 'PENDING',
  "result_reason" VARCHAR(32),
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rps_matches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rps_choices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "match_id" UUID NOT NULL,
  "participant_id" UUID NOT NULL,
  "choice" "RpsHand" NOT NULL,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rps_choices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rps_prize_awards" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operator_id" UUID NOT NULL,
  "tournament_id" UUID NOT NULL,
  "participant_id" UUID NOT NULL,
  "player_ref" VARCHAR(128) NOT NULL,
  "rank" INTEGER NOT NULL,
  "prize_ref" VARCHAR(80) NOT NULL,
  "amount_micro" BIGINT NOT NULL,
  "currency" VARCHAR(8) NOT NULL DEFAULT 'HNL',
  "status" "RpsAwardStatus" NOT NULL DEFAULT 'PENDING',
  "request_uuid" UUID,
  "transaction_uuid" UUID,
  "awarded_at" TIMESTAMP(3),
  "last_error" VARCHAR(256),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rps_prize_awards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "rps_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "operator_id" UUID NOT NULL,
  "tournament_id" UUID NOT NULL,
  "actor" VARCHAR(254),
  "event_type" VARCHAR(64) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "rps_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rps_participants_tournament_id_player_ref_key" ON "rps_participants"("tournament_id", "player_ref");
CREATE UNIQUE INDEX "rps_choices_match_id_participant_id_key" ON "rps_choices"("match_id", "participant_id");
CREATE UNIQUE INDEX "rps_prize_awards_tournament_id_rank_key" ON "rps_prize_awards"("tournament_id", "rank");

CREATE INDEX "rps_tournaments_operator_id_status_scheduled_start_at_idx" ON "rps_tournaments"("operator_id", "status", "scheduled_start_at");
CREATE INDEX "rps_tournaments_currency_idx" ON "rps_tournaments"("currency");
CREATE INDEX "rps_participants_operator_id_player_ref_idx" ON "rps_participants"("operator_id", "player_ref");
CREATE INDEX "rps_participants_session_id_idx" ON "rps_participants"("session_id");
CREATE INDEX "rps_participants_tournament_id_status_idx" ON "rps_participants"("tournament_id", "status");
CREATE INDEX "rps_matches_operator_id_tournament_id_round_number_idx" ON "rps_matches"("operator_id", "tournament_id", "round_number");
CREATE INDEX "rps_matches_status_ends_at_idx" ON "rps_matches"("status", "ends_at");
CREATE INDEX "rps_choices_participant_id_idx" ON "rps_choices"("participant_id");
CREATE INDEX "rps_prize_awards_operator_id_status_idx" ON "rps_prize_awards"("operator_id", "status");
CREATE INDEX "rps_prize_awards_transaction_uuid_idx" ON "rps_prize_awards"("transaction_uuid");
CREATE INDEX "rps_audit_events_operator_id_created_at_idx" ON "rps_audit_events"("operator_id", "created_at");
CREATE INDEX "rps_audit_events_tournament_id_idx" ON "rps_audit_events"("tournament_id");

ALTER TABLE "rps_tournaments" ADD CONSTRAINT "rps_tournaments_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_participants" ADD CONSTRAINT "rps_participants_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_participants" ADD CONSTRAINT "rps_participants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "rps_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_participants" ADD CONSTRAINT "rps_participants_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "game_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rps_matches" ADD CONSTRAINT "rps_matches_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_matches" ADD CONSTRAINT "rps_matches_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "rps_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_matches" ADD CONSTRAINT "rps_matches_participant_a_id_fkey" FOREIGN KEY ("participant_a_id") REFERENCES "rps_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rps_matches" ADD CONSTRAINT "rps_matches_participant_b_id_fkey" FOREIGN KEY ("participant_b_id") REFERENCES "rps_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rps_matches" ADD CONSTRAINT "rps_matches_winner_id_fkey" FOREIGN KEY ("winner_id") REFERENCES "rps_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rps_choices" ADD CONSTRAINT "rps_choices_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "rps_matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_choices" ADD CONSTRAINT "rps_choices_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "rps_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_prize_awards" ADD CONSTRAINT "rps_prize_awards_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_prize_awards" ADD CONSTRAINT "rps_prize_awards_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "rps_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_prize_awards" ADD CONSTRAINT "rps_prize_awards_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "rps_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_audit_events" ADD CONSTRAINT "rps_audit_events_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rps_audit_events" ADD CONSTRAINT "rps_audit_events_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "rps_tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
