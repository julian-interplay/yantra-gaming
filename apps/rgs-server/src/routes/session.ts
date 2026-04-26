import { getJurisdiction } from "@yantra/jurisdiction-rules";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { geoAllowlist } from "../middleware/geo-allowlist.js";
import { idempotency } from "../middleware/idempotency.js";
import { ipAllowList } from "../middleware/ip-allow-list.js";
import { operatorAuth } from "../middleware/operator-auth.js";
import { sessionCreateRateLimit } from "../middleware/operator-rate-limit.js";
import { turnstileVerify } from "../middleware/turnstile.js";
import { globalKillSwitch } from "../services/GlobalKillSwitch.js";
import { sessionService } from "../services/SessionService.js";

export const sessionRouter = Router();

const CreateSessionBody = z.object({
	requestUuid: z.string().uuid(),
	operatorId: z.string().uuid(),
	playerRef: z.string().min(1).max(128),
	gameCode: z.string().default("yantra"),
	currency: z.string().min(1).max(8),
	lang: z.string().min(1).max(8).default("en"),
	jurisdiction: z.string().min(1).max(8).default("INTL"),
	/**
	 * ISO 3166-1 alpha-2 country code of the player, set by the operator's
	 * backend (authoritative source). Checked against Operator.allowedCountries
	 * by the geoAllowlist middleware. Optional here; header fallback (CF-IPCountry
	 * etc.) is honoured when omitted.
	 */
	country: z
		.string()
		.regex(/^[A-Za-z]{2}$/)
		.optional(),
	mode: z.enum(["real", "demo"]).optional(),
	returnUrl: z.string().url().optional(),
	clientSeed: z.string().min(1).max(128).optional(),
	/**
	 * Requested launch-token lifetime. The service applies the authoritative
	 * lower bound and max cap; `expiresAt` in the response is final.
	 */
	sessionTtlSeconds: z
		.number()
		.finite()
		.int()
		.positive()
		.max(86_400)
		.optional(),
	rgLimits: z.record(z.unknown()).optional(),
	/**
	 * Optional Cloudflare Turnstile token. Verified by the turnstileVerify
	 * middleware when TURNSTILE_SECRET_KEY is configured; ignored (pass-through)
	 * otherwise. Also accepted via the `cf-turnstile-response` header.
	 */
	cfTurnstileToken: z.string().optional(),
});

sessionRouter.post(
	"/",
	operatorAuth,
	ipAllowList,
	geoAllowlist,
	sessionCreateRateLimit,
	turnstileVerify(),
	idempotency("session.create"),
	async (req, res) => {
		const parsed = CreateSessionBody.safeParse(req.body);
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: "invalid_body", details: parsed.error.flatten() });
			return;
		}
		const op = req.operator;
		if (!op) {
			res.status(401).json({ error: "no_operator_scope" });
			return;
		}
		if (parsed.data.operatorId !== op.id) {
			res.status(403).json({ error: "operator_mismatch" });
			return;
		}

		// Global kill-switch — ops-controlled emergency halt. Rejects every
		// new session launch across every operator until disengaged. In-flight
		// rounds continue settling via existing wallet-call chains.
		const gk = await globalKillSwitch.snapshot();
		if (gk.engaged) {
			logger.warn("session_blocked_global_kill_switch", {
				operatorId: op.id,
				reason: gk.reason,
			});
			res.status(503).json({
				error: "global_halt",
				reason: gk.reason ?? "operational_halt",
			});
			return;
		}

		// Status gate — suspended (PAUSED) operators retain HMAC access for
		// in-flight settlement but cannot open new sessions.
		if (op.status !== "ACTIVE") {
			logger.warn("session_blocked_operator_status", {
				operatorId: op.id,
				status: op.status,
			});
			res.status(403).json({
				error: "operator_not_active",
				status: op.status,
				reason: op.suspendedReason ?? null,
			});
			return;
		}

		// Kill-switch gate — refuse new sessions for (operator, game, currency)
		// when an incident flag is set. In-flight sessions continue; GLI-19 §3
		// forbids mid-round termination.
		const gc = await prisma.operatorGameConfig.findFirst({
			where: {
				operatorId: op.id,
				gameCode: parsed.data.gameCode,
				currency: parsed.data.currency,
			},
			select: { killSwitch: true, killSwitchReason: true },
		});
		if (gc?.killSwitch) {
			logger.warn("session_blocked_kill_switch", {
				operatorId: op.id,
				gameCode: parsed.data.gameCode,
				currency: parsed.data.currency,
				reason: gc.killSwitchReason,
			});
			res.status(503).json({
				error: "game_disabled",
				reason: gc.killSwitchReason ?? "operational_hold",
			});
			return;
		}

		// Operator currency whitelist. Empty list = fall back to defaultCurrency
		// only; populated list = the authoritative set for this tenant. Enforced
		// before the jurisdictional gate so a bad config surfaces early.
		const operatorCurrencies =
			op.allowedCurrencies.length > 0
				? op.allowedCurrencies
				: [op.defaultCurrency];
		if (!operatorCurrencies.includes(parsed.data.currency)) {
			logger.warn("session_blocked_currency_not_on_operator_whitelist", {
				operatorId: op.id,
				currency: parsed.data.currency,
			});
			res.status(400).json({
				error: "currency_not_permitted_for_operator",
				allowedCurrencies: operatorCurrencies,
			});
			return;
		}

		// Jurisdictional gate: currency whitelist, demo-mode KYC rules. The
		// bet-time check enforces stake caps, autoplay bans, spin-speed floors.
		// Rejecting at session-create is cheaper than rejecting every bet —
		// and surfaces an error the operator's integration code can handle.
		const rules = getJurisdiction(parsed.data.jurisdiction);
		if (
			rules.allowedCurrencies.length > 0 &&
			!rules.allowedCurrencies.includes(parsed.data.currency)
		) {
			logger.warn("session_blocked_currency_not_permitted", {
				operatorId: op.id,
				jurisdiction: parsed.data.jurisdiction,
				currency: parsed.data.currency,
			});
			res.status(400).json({
				error: "currency_not_permitted_in_jurisdiction",
				jurisdiction: parsed.data.jurisdiction,
				allowedCurrencies: rules.allowedCurrencies,
			});
			return;
		}

		const created = await sessionService.create({
			operatorId: op.id,
			playerRef: parsed.data.playerRef,
			gameCode: parsed.data.gameCode,
			currency: parsed.data.currency,
			lang: parsed.data.lang,
			jurisdiction: parsed.data.jurisdiction,
			mode: parsed.data.mode,
			returnUrl: parsed.data.returnUrl,
			clientSeed: parsed.data.clientSeed,
			ttlSeconds: parsed.data.sessionTtlSeconds,
			rgLimits: parsed.data.rgLimits,
		});
		res.status(201).json(created);
	},
);

sessionRouter.get("/:id", operatorAuth, ipAllowList, async (req, res) => {
	const s = await sessionService.getActive(
		req.params.id as string,
		req.operator?.id,
	);
	if (!s) {
		res.status(404).json({ error: "session_not_found" });
		return;
	}
	res.json({
		sessionId: s.id,
		operatorId: s.operatorId,
		playerRef: s.playerRef,
		gameCode: s.gameCode,
		currency: s.currency,
		lang: s.lang,
		jurisdiction: s.jurisdiction,
		mode: s.mode,
		createdAt: s.createdAt.toISOString(),
		expiresAt: s.expiresAt.toISOString(),
		terminatedAt: s.terminatedAt?.toISOString() ?? null,
		serverSeedHash: s.serverSeedHash,
	});
});

const TerminateBody = z.object({
	requestUuid: z.string().uuid().optional(),
	reason: z.string().max(64).default("operator_request"),
});

sessionRouter.post(
	"/:id/terminate",
	operatorAuth,
	ipAllowList,
	async (req, res) => {
		const parsed = TerminateBody.safeParse(req.body ?? {});
		if (!parsed.success) {
			res.status(400).json({ error: "invalid_body" });
			return;
		}
		const ok = await sessionService.terminate(
			req.params.id as string,
			parsed.data.reason,
			req.operator?.id,
		);
		if (!ok) {
			res.status(404).json({ error: "session_not_found" });
			return;
		}
		res.json({ ok: true });
	},
);

// Rotate the provably-fair seed pair mid-session.
//
// Reveals the old serverSeed (so anyone can verify every past round in this
// session), mints a fresh serverSeed + serverSeedHash, and resets the nonce
// to 0. Optionally takes a new clientSeed — if omitted, the existing one is
// kept. This is the standard commit-reveal rotation pattern used by Stake,
// NSoft, and Chainlink provably-fair.
const RotateSeedBody = z.object({
	requestUuid: z.string().uuid().optional(),
	clientSeed: z.string().min(1).max(128).optional(),
});

// GLI-19 §3.7 disconnect-reconnect protection.
//
// When a player reconnects mid-round (or finishes a round on a different
// device), the operator needs an authoritative answer to "what happened to
// my player's HELD bets?" Polling this endpoint returns every
// PendingRoundBet attached to the session — HELD means outcome is still
// pending; RESOLVED/REFUNDED include the outcome and the wallet TX chain
// so the operator can surface the net-effect balance update the player
// missed while disconnected.
//
// Operator scope is enforced; the endpoint does not leak other players'
// bets even on the same session. No caching — the reconnection flow
// cannot tolerate stale data.
sessionRouter.get(
	"/:id/pending",
	operatorAuth,
	ipAllowList,
	async (req, res) => {
		const sessionId = req.params.id as string;
		const s = await prisma.gameSession.findUnique({ where: { id: sessionId } });
		if (!s || s.operatorId !== req.operator?.id) {
			res.status(404).json({ error: "session_not_found" });
			return;
		}

		// Collect every bet on this session that either is HELD or has a
		// terminal PendingRoundBet row (RESOLVED / REFUNDED). We intentionally
		// return the resolved rows too so a reconnecting player can replay
		// what happened while their socket was offline.
		const bets = await prisma.bet.findMany({
			where: { sessionId },
			orderBy: { placedAt: "asc" },
			include: { pendingRoundBet: true, round: true },
		});

		const pending = bets.map((b) => ({
			betId: b.id,
			roundId: b.roundId,
			selection: b.selection,
			selectionType: b.selectionType,
			amountMicro: b.amountMicro.toString(),
			currency: b.currency,
			status: b.status,
			placedAt: b.placedAt.toISOString(),
			settledAt: b.settledAt?.toISOString() ?? null,
			won: b.won,
			wonAmountMicro: b.wonAmountMicro?.toString() ?? null,
			transactions: {
				bet: b.betTransactionUuid,
				win: b.winTransactionUuid,
				rollback: b.rollbackTransactionUuid,
			},
			round: {
				roundId: b.round.id,
				state: b.round.state,
				outcomeType: b.round.outcomeType,
				outcome: b.round.outcomeData,
				settled: b.round.settled,
				settledAt: b.round.settledAt?.toISOString() ?? null,
				voidedAt: b.round.voidedAt?.toISOString() ?? null,
			},
			pendingState: b.pendingRoundBet
				? {
						state: b.pendingRoundBet.state,
						heldAt: b.pendingRoundBet.heldAt.toISOString(),
						resolvedAt: b.pendingRoundBet.resolvedAt?.toISOString() ?? null,
						refundedAt: b.pendingRoundBet.refundedAt?.toISOString() ?? null,
						resolutionReason: b.pendingRoundBet.resolutionReason,
					}
				: null,
		}));

		const heldCount = pending.filter(
			(p) => p.pendingState?.state === "HELD",
		).length;
		res.json({
			sessionId,
			operatorId: s.operatorId,
			playerRef: s.playerRef,
			terminatedAt: s.terminatedAt?.toISOString() ?? null,
			heldCount,
			bets: pending,
		});
	},
);

sessionRouter.post(
	"/:id/rotate-seed",
	operatorAuth,
	ipAllowList,
	async (req, res) => {
		const parsed = RotateSeedBody.safeParse(req.body ?? {});
		if (!parsed.success) {
			res
				.status(400)
				.json({ error: "invalid_body", details: parsed.error.flatten() });
			return;
		}
		const sessionId = req.params.id as string;

		const existing = await sessionService.getActive(
			sessionId,
			req.operator?.id,
		);
		if (!existing) {
			res.status(404).json({ error: "session_not_found" });
			return;
		}
		if (existing.terminatedAt) {
			res.status(409).json({ error: "session_terminated" });
			return;
		}

		const result = await sessionService.rotateSeed(
			sessionId,
			parsed.data.clientSeed,
		);
		if (!result) {
			res.status(404).json({ error: "session_not_found" });
			return;
		}
		res.json({
			sessionId,
			revealedServerSeed: result.revealedServerSeed,
			newServerSeedHash: result.newServerSeedHash,
		});
	},
);
