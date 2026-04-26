// Per-jurisdiction regulatory ruleset.
//
// Shipped as an independent package so the ruleset can be updated,
// audited, and versioned outside the rgs-server release cadence. A
// jurisdictional change (e.g. Germany tightens its spin-speed rule
// from 5 to 6 seconds) is a one-line edit here plus a new cert row —
// no engine change required.
//
// This does NOT try to model every rule in every regulation — only the
// rules that the engine can deterministically enforce at bet time.
// Content-level rules (game design, advertising copy, RG messaging
// text) live in the licensed game-client and operator-portal apps.
// The "mustShowNetLoss" etc. flags advertise to those apps what they
// must display — we don't render UI here.
//
// Regulator references are inline so a reviewer can audit intent. Dates
// are refreshed annually at the cert-lab submission; any mid-year rule
// change requires a scheduled review (see B2B_ROADMAP §16).

/** ISO 3166-1 alpha-2 country code, "MULTI" for cross-jurisdiction operators,
 * or a special "INTL" bucket for B2B-non-consumer-facing tests. */
export type JurisdictionCode = string;

export interface JurisdictionRules {
	/** Stable identifier (used in audit logs + Round.jurisdiction stamps). */
	code: JurisdictionCode;
	/** Human label for ops dashboards. */
	label: string;
	/** Regulator name — referenced in error codes and operator-portal UI. */
	regulator: string;
	/** Max single-bet stake in micro-units (× 100_000). Null = no jurisdictional cap. */
	maxStakeMicro: bigint | null;
	/** Minimum bet-to-result cycle length in ms. 0 = no floor. */
	minSpinMs: number;
	/** Autoplay mode permitted to player? UK, DE, ON commonly ban autoplay. */
	autoplayAllowed: boolean;
	/** Turbo / fast-spin mode permitted? */
	turboAllowed: boolean;
	/** Reality-check prompt cadence (ms). 0 = no reality check required. */
	realityCheckIntervalMs: number;
	/** Whether losses (not just profit/loss) must be displayed to the player. */
	mustShowNetLoss: boolean;
	/** Required session-time hard cap (sec). Null = no regulated cap. */
	maxSessionTimeSec: number | null;
	/** Net loss hard cap per session (micro). Null = no regulated cap. */
	maxSessionLossMicro: bigint | null;
	/** Daily net loss hard cap (micro). Null = no regulated cap. */
	maxDailyLossMicro: bigint | null;
	/** Whether a self-exclusion check against a national registry is mandatory. */
	requiresSelfExclusionCheck: boolean;
	/** Required registry adapter id (e.g. "GAMSTOP", "OASIS"). null if N/A. */
	selfExclusionRegistry: string | null;
	/** Sets of currencies the jurisdiction accepts for real-money play. */
	allowedCurrencies: string[];
	/** Crypto wallets permitted? MiCA (EU) has specific conditions — see notes. */
	cryptoAllowed: boolean;
	/** Demo / play-for-fun session permitted without KYC in this jurisdiction? */
	demoAllowedWithoutKyc: boolean;
	/** Regulator source reference — kept inline so a reviewer can audit intent. */
	sourceRefs: string[];
}

// ── Profiles ──────────────────────────────────────────────────

const UK: JurisdictionRules = {
	code: "GB",
	label: "United Kingdom",
	regulator: "UKGC",
	// UKGC remote game design changes took effect 17 Jan 2025:
	//   - 2.5 s minimum spin cycle (RTS 14A)
	//   - autoplay / quick-spin / slam-stop / turbo prohibited (RTS 13A)
	//   - mandatory stake caps: £5/spin for 25+, £2/spin for 18–24.
	// We apply £2 globally as a conservative default so an under-25 player is
	// always compliant; operators can raise to £5 for verified age-25+ players
	// via `OperatorGameConfig.maxBetMicro` (per-player, per their own policy).
	maxStakeMicro: 200_000n, // £2.00 in micro-units
	minSpinMs: 2_500, // UKGC RTS 14A — effective 17 Jan 2025
	autoplayAllowed: false, // RTS 13A — effective 17 Jan 2025
	turboAllowed: false, // RTS 13A — effective 17 Jan 2025
	realityCheckIntervalMs: 60 * 60_000, // RTS 13C
	mustShowNetLoss: true, // RTS 13D
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "GAMSTOP", // GamProtect SCV (BGC pilot 2024/25) queried alongside
	allowedCurrencies: ["GBP"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: false, // UKGC 2024 demo-mode age-verification rules
	sourceRefs: [
		"UKGC LCCP Gambling Commission Licence Conditions and Codes of Practice",
		"UKGC Remote Technical Standards (RTS) v1 Sep 2024: 11, 13A, 13C, 13D, 14A",
		"UKGC remote game design changes effective 17 Jan 2025",
	],
};

const DE: JurisdictionRules = {
	code: "DE",
	label: "Germany",
	regulator: "GGL",
	maxStakeMicro: 100_000n, // €1.00 per spin (GlüStV § 22a / OASIS slot file)
	minSpinMs: 5_000, // GlüStV 2021 § 22a - 5-second minimum cycle
	autoplayAllowed: false,
	turboAllowed: false,
	realityCheckIntervalMs: 60 * 60_000,
	mustShowNetLoss: true,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	// GlüStV 2021 § 6c — €1,000/month deposit limit. Enforced in the operator's
	// wallet, not here; we surface the expectation to the operator-portal.
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	// Germany has two central systems: OASIS (self-exclusion register) and
	// LUGAS (cross-operator deposit-cap + simultaneous-session limiter).
	// Both are checked at session create by the operator wallet; the RGS
	// surfaces the response through the session JWT claim set.
	selfExclusionRegistry: "OASIS",
	allowedCurrencies: ["EUR"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"Glücksspielstaatsvertrag 2021 (GlüStV) §§ 6c, 22a",
		"Gemeinsame Glücksspielbehörde der Länder (GGL) technical notes",
		"OASIS (self-exclusion register) + LUGAS (central limit system)",
	],
};

const ES: JurisdictionRules = {
	code: "ES",
	label: "Spain",
	regulator: "DGOJ",
	maxStakeMicro: null, // Per-game; not a jurisdictional cap
	minSpinMs: 0,
	autoplayAllowed: true,
	turboAllowed: true,
	realityCheckIntervalMs: 60 * 60_000, // Real Decreto 958/2020
	mustShowNetLoss: true, // Art. 20 — mandatory net-losses display
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "RGIAJ",
	allowedCurrencies: ["EUR"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"Ley 13/2011 de regulación del juego",
		"Real Decreto 958/2020 sobre comunicaciones comerciales",
	],
};

const ON_CA: JurisdictionRules = {
	// iGaming Ontario — conduct-and-manage model, AGCO Registrar's Standards.
	// iGaming Ontario became an independent agency May 2025.
	// Standards 2.10 / 2.11 updated Jun 2025 — data-driven player-risk
	// monitoring + timely intervention requirements.
	code: "ON-CA",
	label: "Ontario, Canada",
	regulator: "AGCO",
	maxStakeMicro: null,
	minSpinMs: 2_500,
	autoplayAllowed: false, // RSIG 2.04 and 3.04 restrict autoplay
	turboAllowed: false, // RSIG 2.04 restricts accelerated play
	realityCheckIntervalMs: 60 * 60_000,
	mustShowNetLoss: true,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "iGO-SE",
	allowedCurrencies: ["CAD"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"AGCO Registrar's Standards for Internet Gaming (RSIG) 2024",
		"AGCO Standards 2.10 / 2.11 updated Jun 2025",
		"iGaming Ontario Operating Agreement",
	],
};

const MT: JurisdictionRules = {
	code: "MT",
	label: "Malta",
	regulator: "MGA",
	maxStakeMicro: null,
	minSpinMs: 2_500,
	autoplayAllowed: true,
	turboAllowed: true,
	realityCheckIntervalMs: 60 * 60_000, // Player Protection Directive
	mustShowNetLoss: false,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "MGA-SE",
	allowedCurrencies: ["EUR", "USD", "GBP"],
	cryptoAllowed: true,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"Malta Gaming Authority Player Protection Directive 2018",
		"MGA Player Protection Directive Jan 2024 update (automated risk monitoring, KYC+)",
		"MGA Gaming Authorisations and Compliance Directive",
	],
};

const SE: JurisdictionRules = {
	code: "SE",
	label: "Sweden",
	regulator: "Spelinspektionen",
	maxStakeMicro: null,
	minSpinMs: 3_000,
	autoplayAllowed: false, // Spelinspektionen technical regulations 2019:2
	turboAllowed: false,
	realityCheckIntervalMs: 60 * 60_000,
	mustShowNetLoss: true,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "SPELPAUS",
	allowedCurrencies: ["SEK", "EUR"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: false,
	sourceRefs: [
		"Spellag (2018:1138)",
		"SIFS 2018:1 / 2019:2 technical requirements",
	],
};

const RO: JurisdictionRules = {
	code: "RO",
	label: "Romania",
	regulator: "ONJN",
	maxStakeMicro: null,
	minSpinMs: 2_000,
	autoplayAllowed: true,
	turboAllowed: true,
	realityCheckIntervalMs: 30 * 60_000, // stricter than most
	mustShowNetLoss: true,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "ONJN-RSE",
	allowedCurrencies: ["RON", "EUR"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"OUG 77/2009 privind organizarea jocurilor de noroc",
		"ONJN Normă tehnică 2022",
	],
};

const BR: JurisdictionRules = {
	// Brazil SPA (Secretaria de Prêmios e Apostas). Law 14.790/2023 and SPA
	// Normative Ordinances 722/827/1,330/1,475. Regulation effective 1 Jan 2025.
	// SPA-recognised cert labs: GLI, BMM, iTech Labs, Trisigma, Quinel, eCOGRA.
	// Mandatory platform + per-game certification; ISO/IEC 27001 infrastructure;
	// facial-recognition KYC (operator-side); .bet.br domain; no demo mode without
	// KYC; BRL only. Fixed-odds / online-slot specific rules — no crypto.
	code: "BR",
	label: "Brazil",
	regulator: "SPA",
	maxStakeMicro: null, // No jurisdictional per-spin cap; operator-level RG caps via session JWT
	minSpinMs: 2_000, // SPA technical standard — continuous-play safety
	autoplayAllowed: false, // Autoplay restricted in fixed-odds online betting
	turboAllowed: false,
	realityCheckIntervalMs: 60 * 60_000, // Mandatory reality-check
	mustShowNetLoss: true, // Mandatory net-position display
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: true,
	selfExclusionRegistry: "SPA-AUTOEXCLUSAO",
	allowedCurrencies: ["BRL"],
	cryptoAllowed: false, // SPA ordinance prohibits crypto for regulated play
	demoAllowedWithoutKyc: false,
	sourceRefs: [
		"Lei 14.790/2023 (Brazilian fixed-odds betting law)",
		"SPA/MF Normative Ordinances 722, 827, 1330, 1475",
		"SPA certification standard — effective 1 Jan 2025",
	],
};

const HN: JurisdictionRules = {
	code: "HN",
	label: "Honduras",
	regulator: "CNJ",
	maxStakeMicro: null,
	minSpinMs: 2_000,
	autoplayAllowed: true,
	turboAllowed: true,
	realityCheckIntervalMs: 60 * 60_000,
	mustShowNetLoss: true,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: false,
	selfExclusionRegistry: null,
	allowedCurrencies: ["HNL"],
	cryptoAllowed: false,
	demoAllowedWithoutKyc: true,
	sourceRefs: [
		"Honduras jurisdiction profile for HNL-only Yantra sandbox and pilot deployments",
	],
};

// Default / non-regulated-testbed. Used for internal sandboxes, the engine
// keepalive session, and pilot deployments. Permissive across the board
// because no specific regulator is in force.
const INTL: JurisdictionRules = {
	code: "INTL",
	label: "International / test",
	regulator: "none",
	maxStakeMicro: null,
	minSpinMs: 0,
	autoplayAllowed: true,
	turboAllowed: true,
	realityCheckIntervalMs: 0,
	mustShowNetLoss: false,
	maxSessionTimeSec: null,
	maxSessionLossMicro: null,
	maxDailyLossMicro: null,
	requiresSelfExclusionCheck: false,
	selfExclusionRegistry: null,
	allowedCurrencies: [],
	cryptoAllowed: true,
	demoAllowedWithoutKyc: true,
	sourceRefs: [],
};

export const JURISDICTIONS: Record<string, JurisdictionRules> = {
	GB: UK,
	"GB-UK": UK,
	DE,
	ES,
	MT,
	SE,
	RO,
	BR,
	HN,
	ON: ON_CA,
	"ON-CA": ON_CA,
	INTL,
	MULTI: INTL, // cross-jurisdiction operators default to INTL; per-session override expected
};

export function getJurisdiction(code: JurisdictionCode): JurisdictionRules {
	return JURISDICTIONS[code] ?? INTL;
}

export function hasJurisdiction(code: JurisdictionCode): boolean {
	return code in JURISDICTIONS;
}

// ── Bet-time check ────────────────────────────────────────────

export type JurisdictionBreach =
	| "stake_above_jurisdiction_max"
	| "autoplay_not_permitted"
	| "turbo_not_permitted"
	| "currency_not_permitted"
	| "spin_too_fast"
	| "demo_not_allowed_without_kyc";

export interface JurisdictionCheckInput {
	jurisdiction: JurisdictionCode;
	stakeMicro: bigint;
	currency: string;
	/** Milliseconds since previous bet in this session (0 for first bet). */
	timeSincePreviousBetMs?: number;
	/** Whether this bet was submitted from an autoplay loop. */
	autoplay?: boolean;
	/** Whether this bet was submitted from the "turbo" fast-spin mode. */
	turbo?: boolean;
	/** Session mode — demo flows can relax some gates (e.g. UK KYC). */
	mode?: "real" | "demo";
	/** Whether the player has completed age-verification / KYC. */
	playerKycVerified?: boolean;
}

export interface JurisdictionCheckResult {
	allowed: boolean;
	reason?: JurisdictionBreach;
	remainingMicro?: bigint | null;
}

export function checkJurisdictionRules(
	input: JurisdictionCheckInput,
): JurisdictionCheckResult {
	const rules = getJurisdiction(input.jurisdiction);

	if (
		rules.allowedCurrencies.length > 0 &&
		!rules.allowedCurrencies.includes(input.currency)
	) {
		return { allowed: false, reason: "currency_not_permitted" };
	}

	if (
		input.mode === "demo" &&
		!rules.demoAllowedWithoutKyc &&
		!input.playerKycVerified
	) {
		return { allowed: false, reason: "demo_not_allowed_without_kyc" };
	}

	if (rules.maxStakeMicro !== null && input.stakeMicro > rules.maxStakeMicro) {
		return {
			allowed: false,
			reason: "stake_above_jurisdiction_max",
			remainingMicro: rules.maxStakeMicro,
		};
	}

	if (input.autoplay === true && !rules.autoplayAllowed) {
		return { allowed: false, reason: "autoplay_not_permitted" };
	}

	if (input.turbo === true && !rules.turboAllowed) {
		return { allowed: false, reason: "turbo_not_permitted" };
	}

	if (
		rules.minSpinMs > 0 &&
		input.timeSincePreviousBetMs !== undefined &&
		input.timeSincePreviousBetMs > 0 &&
		input.timeSincePreviousBetMs < rules.minSpinMs
	) {
		return { allowed: false, reason: "spin_too_fast" };
	}

	return { allowed: true };
}

// ── Effective RG floor ────────────────────────────────────────
//
// Given a jurisdiction and the operator-configured RG limits on a session,
// return the tightest limits the engine should enforce. Operator limits
// can be tighter than the regulation but never looser.

export interface RGFloor {
	sessionTimeSeconds?: number;
	sessionLossMicro?: bigint;
	dailyLossMicro?: bigint;
	realityCheckIntervalMs?: number;
}

export function effectiveRGFloor(
	jurisdiction: JurisdictionCode,
	operatorLimits?: {
		sessionTimeSeconds?: number;
		sessionLossMicro?: bigint;
		dailyLossMicro?: bigint;
	},
): RGFloor {
	const rules = getJurisdiction(jurisdiction);
	const out: RGFloor = {};

	if (rules.realityCheckIntervalMs > 0) {
		out.realityCheckIntervalMs = rules.realityCheckIntervalMs;
	}

	// Session time — operator may tighten, regulator may mandate.
	if (
		rules.maxSessionTimeSec !== null ||
		operatorLimits?.sessionTimeSeconds !== undefined
	) {
		const candidates = [rules.maxSessionTimeSec ?? Number.POSITIVE_INFINITY];
		if (operatorLimits?.sessionTimeSeconds !== undefined) {
			candidates.push(operatorLimits.sessionTimeSeconds);
		}
		const min = Math.min(...candidates);
		if (Number.isFinite(min)) out.sessionTimeSeconds = min;
	}

	if (
		rules.maxSessionLossMicro !== null ||
		operatorLimits?.sessionLossMicro !== undefined
	) {
		const candidates: bigint[] = [];
		if (rules.maxSessionLossMicro !== null)
			candidates.push(rules.maxSessionLossMicro);
		if (operatorLimits?.sessionLossMicro !== undefined) {
			candidates.push(operatorLimits.sessionLossMicro);
		}
		if (candidates.length > 0) {
			out.sessionLossMicro = candidates.reduce((a, b) => (a < b ? a : b));
		}
	}

	if (
		rules.maxDailyLossMicro !== null ||
		operatorLimits?.dailyLossMicro !== undefined
	) {
		const candidates: bigint[] = [];
		if (rules.maxDailyLossMicro !== null)
			candidates.push(rules.maxDailyLossMicro);
		if (operatorLimits?.dailyLossMicro !== undefined) {
			candidates.push(operatorLimits.dailyLossMicro);
		}
		if (candidates.length > 0) {
			out.dailyLossMicro = candidates.reduce((a, b) => (a < b ? a : b));
		}
	}

	return out;
}
