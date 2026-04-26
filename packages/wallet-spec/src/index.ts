// @yantra/wallet-spec
// The single source of truth for the wallet contract. Consumed by:
//   - apps/rgs-server (outbound calls)
//   - apps/mock-operator (fake operator implementation)
//   - packages/operator-sdk (helpers operators install)
//
// If you change a field here, update docs/wallet-api.md in the same commit.

// ── Primitive types ─────────────────────────────────────

export type Uuid = string;
export type IsoCurrency = string; // 'LKR', 'USD', 'EUR', 'BTC', …
export type PlayerRef = string;

// ── Status codes ────────────────────────────────────────

export const RsStatus = {
	OK: "RS_OK",
	UNKNOWN: "RS_ERROR_UNKNOWN",
	INVALID_TOKEN: "RS_ERROR_INVALID_TOKEN",
	INVALID_SIGNATURE: "RS_ERROR_INVALID_SIGNATURE",
	INVALID_PARTNER: "RS_ERROR_INVALID_PARTNER",
	NOT_ENOUGH_MONEY: "RS_ERROR_NOT_ENOUGH_MONEY",
	USER_DISABLED: "RS_ERROR_USER_DISABLED",
	TOKEN_EXPIRED: "RS_ERROR_TOKEN_EXPIRED",
	WRONG_CURRENCY: "RS_ERROR_WRONG_CURRENCY",
	WRONG_SYNTAX: "RS_ERROR_WRONG_SYNTAX",
	WRONG_TYPES: "RS_ERROR_WRONG_TYPES",
	DUPLICATE_TRANSACTION: "RS_ERROR_DUPLICATE_TRANSACTION",
	TRANSACTION_NOT_FOUND: "RS_ERROR_TRANSACTION_DOES_NOT_EXIST",
	LIMIT_REACHED: "RS_ERROR_LIMIT_REACHED",
	TIMEOUT: "RS_ERROR_TIMEOUT",
} as const;

export type RsStatus = (typeof RsStatus)[keyof typeof RsStatus];

// ── Signing headers ─────────────────────────────────────

export const SIGNATURE_HEADER = "x-yantra-signature";
export const KEY_ID_HEADER = "x-yantra-key-id";
export const TIMESTAMP_HEADER = "x-yantra-timestamp";

// ── Signing (HMAC-SHA256) ───────────────────────────────
//
// Canonical string:   METHOD \n PATH \n TIMESTAMP \n SHA256(BODY_AS_HEX)
// Signature:          base64( HMAC_SHA256(secret, canonical) )
//
// Timestamp is unix seconds. Receivers MUST reject requests outside a ±30s
// window from wall clock to prevent replay. Receivers MUST compare the
// signature using a constant-time comparison (crypto.timingSafeEqual).

import crypto from "node:crypto";

export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;

function sha256Hex(body: string | Uint8Array): string {
	return crypto.createHash("sha256").update(body).digest("hex");
}

function canonicalString(
	method: string,
	path: string,
	timestamp: number | string,
	body: string | Uint8Array,
): string {
	return `${method.toUpperCase()}\n${path}\n${timestamp}\n${sha256Hex(body)}`;
}

/**
 * Produce the `X-Yantra-Signature` header value. Both the RGS and operators
 * use this for outbound calls; the receiver uses {@link verifyPayload} to check it.
 */
export function signPayload(
	secret: string,
	method: string,
	path: string,
	timestamp: number | string,
	body: string | Uint8Array,
): string {
	const canonical = canonicalString(method, path, timestamp, body);
	return crypto.createHmac("sha256", secret).update(canonical).digest("base64");
}

/**
 * Verify a signature against a request.
 *
 * Returns false if:
 *   - the timestamp is outside the configured window (replay guard)
 *   - the signature is malformed
 *   - the signature does not match (constant-time compare)
 */
export function verifyPayload(opts: {
	secret: string;
	method: string;
	path: string;
	timestamp: number | string;
	body: string | Uint8Array;
	signature: string;
	toleranceSeconds?: number;
	nowSeconds?: number; // injectable for tests
}): boolean {
	const { secret, method, path, timestamp, body, signature } = opts;
	const tolerance = opts.toleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
	const nowSec = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

	const tsNum =
		typeof timestamp === "number" ? timestamp : Number.parseInt(timestamp, 10);
	if (!Number.isFinite(tsNum)) return false;
	if (Math.abs(nowSec - tsNum) > tolerance) return false;

	const expected = signPayload(secret, method, path, timestamp, body);
	let a: Buffer;
	let b: Buffer;
	try {
		a = Buffer.from(expected, "base64");
		b = Buffer.from(signature, "base64");
	} catch {
		return false;
	}
	if (a.length === 0 || a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

// ── Wire format (always JSON over HTTPS, amounts as decimal strings) ─

// BigInt does not serialise as JSON; wire format uses decimal strings.
export type MicroAmountString = string;

export interface WalletRequestCommon {
	requestUuid: Uuid;
	operatorId: string;
	playerRef: PlayerRef;
	currency: IsoCurrency;
	gameCode: string;
}

/**
 * Bonus-money attribution shared by bet / win / rollback.
 *
 * Operators that run promotional or bonus wallets typically need to track
 * which transactions were funded by bonus balance vs real balance — both for
 * their own reporting (wagering-requirement tracking) and for regulatory
 * reporting (bonus-funded GGR is taxed differently in many jurisdictions).
 */
export interface BonusAttribution {
	/** If true, this transaction is funded by a bonus wallet, not real balance. */
	isBonus?: boolean;
	/** Operator-opaque reference to the bonus / campaign this belongs to. */
	bonusRef?: string;
	/** Wagering progress this transaction contributes to, in micro-units. */
	wageringContributionMicro?: MicroAmountString;
}

/**
 * Foreign-exchange context for multi-currency operators.
 *
 * Used when the session currency and the player's wallet currency differ
 * (e.g. player wallet is USD, session currency is BRL for a Brazil-regulated
 * game). Both sides should carry the FX rate and source currency so the
 * operator wallet can reconcile in its ledger currency.
 */
export interface FxContext {
	/** Player wallet's native currency (ISO 4217 / crypto symbol). */
	walletCurrency?: IsoCurrency;
	/** Rate applied to convert `currency` (session) → `walletCurrency`. Decimal string. */
	fxRate?: string;
	/** Timestamp (ISO-8601) the rate was locked. */
	fxRateAt?: string;
	/** Rate source — 'ECB', 'COINBASE', 'OPERATOR_INTERNAL', etc. Audit trail. */
	fxRateSource?: string;
}

export interface BalanceRequestWire extends WalletRequestCommon {}

export interface BetRequestWire
	extends WalletRequestCommon,
		BonusAttribution,
		FxContext {
	transactionUuid: Uuid;
	amountMicro: MicroAmountString;
	roundId: Uuid;
	/** @deprecated Use `isBonus` on `BonusAttribution` instead. Kept for backward compat. */
	isFree?: boolean;
	meta?: Record<string, unknown>;
}

export interface WinRequestWire
	extends WalletRequestCommon,
		BonusAttribution,
		FxContext {
	transactionUuid: Uuid;
	referenceTransactionUuid: Uuid;
	amountMicro: MicroAmountString;
	roundId: Uuid;
	/**
	 * Jackpot contribution credited from this win (micro-units). Used by games
	 * that feed a shared jackpot pool; settled separately by the operator.
	 */
	jackpotContributionMicro?: MicroAmountString;
	meta?: Record<string, unknown>;
}

export interface RollbackRequestWire extends WalletRequestCommon {
	transactionUuid: Uuid;
	referenceTransactionUuid: Uuid;
	roundId?: Uuid;
	meta?: Record<string, unknown>;
}

export interface WalletResponseWire {
	status: RsStatus;
	requestUuid: Uuid;
	balanceMicro?: MicroAmountString;
	currency?: IsoCurrency;
	message?: string;
}

// ── Money conversion helpers ────────────────────────────

export const MICRO_PER_UNIT = 100_000n;

export function toMicro(value: string | number): bigint {
	if (typeof value === "number")
		return BigInt(Math.round(value * Number(MICRO_PER_UNIT)));
	// Decimal string — handle safely without float drift.
	const [intPart, fracPart = ""] = value.split(".");
	const frac = (fracPart + "00000").slice(0, 5); // 5 decimal places = micro
	return BigInt(intPart || "0") * MICRO_PER_UNIT + BigInt(frac || "0");
}

export function fromMicro(micro: bigint): string {
	const neg = micro < 0n;
	const abs = neg ? -micro : micro;
	const intPart = abs / MICRO_PER_UNIT;
	const fracPart = (abs % MICRO_PER_UNIT)
		.toString()
		.padStart(5, "0")
		.replace(/0+$/, "");
	const s = fracPart.length > 0 ? `${intPart}.${fracPart}` : `${intPart}`;
	return neg ? `-${s}` : s;
}

// ── Game launch ─────────────────────────────────────────

export interface CreateSessionRequest {
	operatorId: string;
	playerRef: PlayerRef;
	gameCode: string;
	currency: IsoCurrency;
	lang: string;
	jurisdiction: string;
	mode?: "real" | "demo";
	returnUrl?: string;
	clientSeed?: string;
	/**
	 * Requested launch-session credential lifetime in seconds.
	 * The RGS applies server-side min/max caps and returns the authoritative
	 * expiry in `expiresAt`.
	 */
	sessionTtlSeconds?: number;
	rgLimits?: {
		dailyLossMicro?: MicroAmountString;
		dailyWagerMicro?: MicroAmountString;
		sessionTimeSeconds?: number;
	};
}

export interface CreateSessionResponse {
	sessionId: Uuid;
	sessionToken: string;
	launchUrl: string;
	expiresAt: string; // ISO 8601
	serverSeedHash: string;
}

// ── Classifier helpers ──────────────────────────────────

const REJECT = new Set<RsStatus>([
	RsStatus.NOT_ENOUGH_MONEY,
	RsStatus.LIMIT_REACHED,
	RsStatus.USER_DISABLED,
]);

const DUPLICATE = new Set<RsStatus>([RsStatus.DUPLICATE_TRANSACTION]);

export function isRejectStatus(s: RsStatus): boolean {
	return REJECT.has(s);
}

export function isSuccessOrDuplicate(s: RsStatus): boolean {
	return s === RsStatus.OK || DUPLICATE.has(s);
}
