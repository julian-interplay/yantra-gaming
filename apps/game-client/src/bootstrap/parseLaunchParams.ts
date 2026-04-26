// Parses the launch-parameter query string the operator points the iframe at.
// See B2B_ROADMAP.md §6 "Game launch flow" — operator calls POST /v1/session on
// their backend, receives a launchUrl with these params, then renders
// <iframe src={launchUrl}>. We parse the URL exactly once on mount.

import { decodeJwtPayload } from "../utils/jwt";

export type LaunchMode = "real" | "demo";

export interface RgLimits {
	dailyLossMicro?: bigint;
	dailyWagerMicro?: bigint;
	sessionLossMicro?: bigint;
	sessionWagerMicro?: bigint;
	sessionTimeSeconds?: number;
}

export interface LaunchParams {
	/** Short-lived JWT issued by the RGS when the operator called /v1/session. */
	sessionToken: string;
	/** Opaque public id of the operator whose casino we are embedded into. */
	operatorId: string;
	/** BCP-47-ish language hint. Defaults to 'en'. */
	lang: string;
	/** Real money or demo mode. Defaults to 'real'. */
	mode: LaunchMode;
	/** ISO-4217 currency, hint only — authoritative copy lives in the token. */
	currency: string | null;
	/** Stable game code, hint only — authoritative copy lives in the token. */
	gameCode: string | null;
	/** Two-letter jurisdiction hint. */
	jurisdiction: string | null;
	/** RG limits decoded from the token, for display only. */
	rgLimits: RgLimits | null;
	/** Session expiry — ms since epoch, derived from `exp` claim. */
	expiresAtMs: number | null;
}

function readParam(params: URLSearchParams, key: string): string | null {
	const v = params.get(key);
	if (v == null) return null;
	const trimmed = v.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function readMode(params: URLSearchParams): LaunchMode {
	const raw = readParam(params, "mode");
	return raw === "demo" ? "demo" : "real";
}

/**
 * Reads launch params from the current window URL.
 * Returns `null` if required fields are missing or malformed — the caller
 * should show the session-expired screen in that case.
 */
export function parseLaunchParams(
	search: string = window.location.search,
): LaunchParams | null {
	const params = new URLSearchParams(search);

	const sessionToken = readParam(params, "sessionToken");
	const operatorId = readParam(params, "operatorId");

	if (!sessionToken || !operatorId) return null;

	// Very light JWT shape check — three dot-separated base64url segments.
	// Full verification happens on the server; we just avoid opening a socket
	// with obvious garbage.
	if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(sessionToken)) {
		return null;
	}

	// Decode the token payload (no verification — server handles that) to
	// surface the rgLimits and expiry the operator set at session creation.
	const claims = decodeJwtPayload(sessionToken);
	const rgLimits = parseRgLimits(claims?.rgLimits);
	const expiresAtMs =
		typeof claims?.exp === "number" ? claims.exp * 1000 : null;

	return {
		sessionToken,
		operatorId,
		lang: readParam(params, "lang") ?? claims?.lang ?? "en",
		mode: readMode(params),
		currency: readParam(params, "currency") ?? claims?.currency ?? null,
		gameCode: readParam(params, "gameCode") ?? claims?.gameCode ?? null,
		jurisdiction:
			readParam(params, "jurisdiction") ?? claims?.jurisdiction ?? null,
		rgLimits,
		expiresAtMs,
	};
}

function parseRgLimits(
	raw: NonNullable<ReturnType<typeof decodeJwtPayload>>["rgLimits"] | undefined,
): RgLimits | null {
	if (!raw) return null;
	const out: RgLimits = {};
	if (typeof raw.dailyLossMicro === "string")
		out.dailyLossMicro = safeBig(raw.dailyLossMicro);
	if (typeof raw.dailyWagerMicro === "string")
		out.dailyWagerMicro = safeBig(raw.dailyWagerMicro);
	if (typeof raw.sessionLossMicro === "string")
		out.sessionLossMicro = safeBig(raw.sessionLossMicro);
	if (typeof raw.sessionWagerMicro === "string")
		out.sessionWagerMicro = safeBig(raw.sessionWagerMicro);
	if (typeof raw.sessionTimeSeconds === "number")
		out.sessionTimeSeconds = raw.sessionTimeSeconds;
	return Object.keys(out).length > 0 ? out : null;
}

function safeBig(s: string): bigint | undefined {
	try {
		return BigInt(s);
	} catch {
		return undefined;
	}
}
