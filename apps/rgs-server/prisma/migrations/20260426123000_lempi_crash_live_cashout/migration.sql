ALTER TABLE "bets"
  ADD COLUMN "cashout_multiplier" DOUBLE PRECISION,
  ADD COLUMN "cashout_elapsed_ms" INTEGER,
  ADD COLUMN "cashout_mode" VARCHAR(16),
  ADD COLUMN "cashout_at" TIMESTAMP(3),
  ADD COLUMN "cashout_payout_micro" BIGINT;

CREATE INDEX "bets_round_id_cashout_at_idx" ON "bets"("round_id", "cashout_at");
