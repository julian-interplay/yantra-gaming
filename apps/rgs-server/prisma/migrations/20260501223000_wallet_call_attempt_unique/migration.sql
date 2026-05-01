-- Retries intentionally reuse the same wallet request UUID so operator
-- callbacks remain idempotent. The audit log records each outbound attempt,
-- so the uniqueness constraint must include the attempt number.
DROP INDEX IF EXISTS "wallet_calls_operator_id_direction_endpoint_request_uuid_key";

CREATE UNIQUE INDEX "wallet_calls_operator_id_direction_endpoint_request_uuid_attempt_key"
ON "wallet_calls"("operator_id", "direction", "endpoint", "request_uuid", "attempt");
