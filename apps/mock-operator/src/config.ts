// Env config for the mock operator. Defaults match .env.example so `bun run dev`
// works with zero setup. This is dev-only; no validation library, no surprises.

function str(name: string, fallback: string): string {
	const v = process.env[name];
	return v && v.length > 0 ? v : fallback;
}

function int(name: string, fallback: number): number {
	const v = process.env[name];
	if (!v) return fallback;
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
}

export const config = {
	port: int("MOCK_OPERATOR_PORT", 4300),
	// Must match the UUID the RGS seed pins (apps/rgs-server/src/seed.ts).
	// If it doesn't, POST /v1/session rejects with operator_mismatch.
	operatorId: str("MOCK_OPERATOR_ID", "00000000-0000-4000-8000-000000000001"),
	apiKeyId: str("MOCK_OPERATOR_API_KEY_ID", "kid_mock_dev"),
	apiSecret: str("MOCK_OPERATOR_API_SECRET", "mock-dev-shared-secret"),
	walletSecret: str("MOCK_OPERATOR_WALLET_SECRET", "mock-dev-wallet-secret"),
	rgsBaseUrl: str("RGS_BASE_URL", "http://localhost:4500"),
	gameClientBaseUrl: str("GAME_CLIENT_BASE_URL", "http://localhost:3100"),
	signatureWindowSeconds: int("SIGNATURE_WINDOW_SECONDS", 30),
	gameCode: str("MOCK_OPERATOR_GAME_CODE", "lempi-crash"),
	defaultCurrency: str("MOCK_OPERATOR_CURRENCY", "HNL"),
	defaultLang: "en",
	defaultJurisdiction: str("MOCK_OPERATOR_JURISDICTION", "HN"),
	sessionTtlSeconds: int("MOCK_OPERATOR_SESSION_TTL_SECONDS", 4 * 60 * 60),
} as const;

export type MockOperatorConfig = typeof config;
