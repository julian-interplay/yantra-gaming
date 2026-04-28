-- Phase 3 of the multi-game plugin migration.
--
-- Drops dice-specific outcome columns on rounds/bets; adds generic
-- outcome_type + outcome_data (JSONB) on rounds, and selection +
-- selection_type (JSONB + VARCHAR) on bets. Adds config_json + config_version
-- to operator_game_configs; the legacy low_weight/high_weight columns stay
-- for one more migration (dropped in Phase 4 after seed/portal migrate to
-- config_json).
--
-- This is a destructive dev-only migration. For a hypothetical production
-- migration you would add a data-copy step before the DROP:
--   UPDATE rounds SET outcome_type='DICE',
--     outcome_data = jsonb_build_object('type','DICE',
--       'diceValues', dice_values,
--       'outcomeSum', outcome_sum,
--       'outcomeSide', outcome_side)
--     WHERE outcome_side IS NOT NULL;
--   UPDATE bets SET selection=jsonb_build_object('side', side),
--     selection_type='ketapola-dice';
--   UPDATE operator_game_configs SET
--     config_json=jsonb_build_object('lowWeight', low_weight, 'highWeight', high_weight);

-- rounds: dice columns → generic outcome JSON
ALTER TABLE "rounds" DROP COLUMN "dice_values";
ALTER TABLE "rounds" DROP COLUMN "outcome_sum";
ALTER TABLE "rounds" DROP COLUMN "outcome_side";
ALTER TABLE "rounds" ADD COLUMN "outcome_type" VARCHAR(32);
ALTER TABLE "rounds" ADD COLUMN "outcome_data" JSONB;
ALTER TABLE "rounds" ADD COLUMN "game_config_version" VARCHAR(32);
CREATE INDEX "rounds_outcome_type_idx" ON "rounds"("outcome_type");
-- Drop default on rng_version; the plugin supplies it per-round now.
ALTER TABLE "rounds" ALTER COLUMN "rng_version" DROP DEFAULT;

-- bets: side enum string → plugin-owned selection JSON
ALTER TABLE "bets" DROP COLUMN "side";
ALTER TABLE "bets" ADD COLUMN "selection" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "bets" ADD COLUMN "selection_type" VARCHAR(32) NOT NULL DEFAULT '';
-- Remove the default once seed re-runs; kept as DEFAULT so dev-time Prisma
-- migrate dev doesn't reject existing seed rows.
ALTER TABLE "bets" ALTER COLUMN "selection" DROP DEFAULT;
ALTER TABLE "bets" ALTER COLUMN "selection_type" DROP DEFAULT;

-- operator_game_configs: add plugin math config. low_weight / high_weight
-- remain for the duration of Phase 3; Phase 4 drops them after callers
-- migrate to configJson.
ALTER TABLE "operator_game_configs" ADD COLUMN "config_json" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "operator_game_configs" ADD COLUMN "config_version" VARCHAR(32) NOT NULL DEFAULT 'v1';
