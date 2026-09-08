import type { Socket, Server as SocketIOServer } from "socket.io";
import { z } from "zod";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import {
	type SessionJwtClaims,
	verifySessionTokenOrThrow,
} from "../middleware/session-auth.js";
import { getEngineRegistry } from "../services/EngineRegistry.js";
import {
	getRpsTournamentService,
	RPS_GAME_CODE,
	type RpsHand,
} from "../services/RpsTournamentService.js";
import { newUuid } from "../utils/uuid.js";
import { RsStatus, type WalletResponse } from "../wallet/types.js";
import type { WalletClient } from "../wallet/WalletClient.js";

interface AuthedSocket extends Socket {
	data: {
		claims: SessionJwtClaims;
		sessionId: string;
		operatorId: string;
		playerRef: string;
		currency: string;
		gameCode: string;
	};
}

/**
 * Generic place_bet envelope. The core validates amount/autoplay/turbo; the
 * plugin owns the `selection` shape and validates it via its own zod schema.
 * Both must pass for the bet to reach GameEngine.placeBet().
 */
const PlaceBetEnvelopeSchema = z.object({
	amountMicro: z.union([z.string(), z.number(), z.bigint()]).transform((v) => {
		if (typeof v === "bigint") return v;
		return BigInt(typeof v === "number" ? Math.round(v) : v);
	}),
	selection: z.unknown(),
	autoplay: z.boolean().optional(),
	turbo: z.boolean().optional(),
});

const presenceByRoom = new Map<string, Map<string, number>>();
const INITIAL_BALANCE_MAX_ATTEMPTS = 3;
const INITIAL_BALANCE_RETRY_DELAY_MS = 750;

interface InitialBalanceFetchParams {
	sessionId: string;
	operatorId: string;
	playerRef: string;
	currency: string;
	gameCode: string;
	isConnected?: () => boolean;
	maxAttempts?: number;
	retryDelayMs?: number;
}

function gameRoom(
	operatorId: string,
	gameCode: string,
	currency: string,
): string {
	return `operator:${operatorId}:${gameCode}:${currency}`;
}

function connectedPlayerCount(room: string): number {
	return presenceByRoom.get(room)?.size ?? 0;
}

function incrementPresence(room: string, sessionId: string): number {
	const sessions = presenceByRoom.get(room) ?? new Map<string, number>();
	sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
	presenceByRoom.set(room, sessions);
	return sessions.size;
}

function decrementPresence(room: string, sessionId: string): number {
	const sessions = presenceByRoom.get(room);
	if (!sessions) return 0;
	const next = (sessions.get(sessionId) ?? 0) - 1;
	if (next > 0) {
		sessions.set(sessionId, next);
		return sessions.size;
	}
	sessions.delete(sessionId);
	const count = sessions.size;
	if (count === 0) presenceByRoom.delete(room);
	return count;
}

function emitPresence(io: SocketIOServer, room: string): void {
	io.to(room).emit("presence_update", {
		connectedPlayerCount: connectedPlayerCount(room),
	});
}

export async function fetchInitialBalanceWithRetry(
	walletClient: Pick<WalletClient, "balance">,
	params: InitialBalanceFetchParams,
): Promise<WalletResponse | null> {
	const maxAttempts = params.maxAttempts ?? INITIAL_BALANCE_MAX_ATTEMPTS;
	const retryDelayMs = params.retryDelayMs ?? INITIAL_BALANCE_RETRY_DELAY_MS;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (params.isConnected && !params.isConnected()) return null;

		const res = await walletClient.balance(
			{
				requestUuid: newUuid(),
				operatorId: params.operatorId,
				playerRef: params.playerRef,
				currency: params.currency,
				gameCode: params.gameCode,
			},
			{ sessionId: params.sessionId, attempt },
		);
		if (res.balanceMicro != null) return res;

		if (!shouldRetryInitialBalance(res.status) || attempt >= maxAttempts) {
			return res;
		}

		logger.warn("initial balance fetch retrying", {
			sessionId: params.sessionId,
			status: res.status,
			message: res.message ?? null,
			attempt,
			maxAttempts,
		});
		await sleep(retryDelayMs);
	}

	return null;
}

function shouldRetryInitialBalance(status: WalletResponse["status"]): boolean {
	return status === RsStatus.TIMEOUT || status === RsStatus.UNKNOWN;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function attachGameSocket(io: SocketIOServer): void {
	io.use(async (socket, next) => {
		const token =
			(socket.handshake.auth?.token as string | undefined) ??
			(socket.handshake.query?.sessionToken as string | undefined);
		if (!token) return next(new Error("missing_session_token"));
		try {
			const claims = verifySessionTokenOrThrow(token);
			const session = await prisma.gameSession.findUnique({
				where: { id: claims.sessionId },
			});
			if (!session) return next(new Error("session_not_found"));
			if (session.terminatedAt) return next(new Error("session_terminated"));
			if (session.expiresAt.getTime() < Date.now())
				return next(new Error("session_expired"));

			(socket as AuthedSocket).data = {
				claims,
				sessionId: session.id,
				operatorId: session.operatorId,
				playerRef: session.playerRef,
				currency: session.currency,
				gameCode: session.gameCode,
			};
			next();
		} catch (err) {
			logger.warn("socket auth failed", { err: (err as Error).message });
			next(new Error("invalid_session_token"));
		}
	});

	io.on("connection", async (rawSocket) => {
		const socket = rawSocket as AuthedSocket;
		const { sessionId, operatorId, gameCode, currency, playerRef } =
			socket.data;
		const room = gameRoom(operatorId, gameCode, currency);

		socket.join(`session:${sessionId}`);
		socket.join(room);

		if (gameCode === RPS_GAME_CODE) {
			incrementPresence(room, sessionId);
			emitPresence(io, room);
			socket.emit("connected", {
				sessionId,
				gameCode,
				currency,
				currentPhase: "TOURNAMENT",
				currentRoundId: null,
			});
			const rps = getRpsTournamentService();
			await rps.registerSocket(socket, {
				sessionId,
				operatorId,
				playerRef,
				currency,
				gameCode,
			});
			socket.on(
				"rps_choice",
				async (payload: unknown, ack?: (r: unknown) => void) => {
					const parsed = z
						.object({
							matchId: z.string().uuid(),
							choice: z.enum(["ROCK", "PAPER", "SCISSORS"]),
						})
						.safeParse(payload);
					if (!parsed.success) {
						ack?.({ ok: false, reason: "seleccion_invalida" });
						return;
					}
					const result = await rps.submitChoice(
						{ sessionId, operatorId, playerRef, currency, gameCode },
						parsed.data.matchId,
						parsed.data.choice as RpsHand,
					);
					ack?.(result);
				},
			);
			socket.on("disconnect", () => {
				decrementPresence(room, sessionId);
				emitPresence(io, room);
			});
			return;
		}

		const registry = getEngineRegistry();
		const engine = await registry.forSession({
			operatorId,
			gameCode,
			currency,
		});
		if (!engine) {
			socket.emit("engine_unavailable", { reason: "no_game_config" });
			socket.disconnect(true);
			return;
		}

		incrementPresence(room, sessionId);
		emitPresence(io, room);

		socket.emit("connected", {
			sessionId,
			gameCode,
			currency,
			currentPhase: engine.phase,
			currentRoundId: engine.currentRoundId,
		});
		socket.emit("game_config", {
			gameCode,
			currency,
			minBetMicro: engine.config.minBetMicro.toString(),
			maxBetMicro: engine.config.maxBetMicro.toString(),
			bettingWindowMs: engine.config.bettingWindowMs,
			rollingWindowMs: engine.config.rollingWindowMs,
			cooldownMs: engine.config.cooldownMs,
			config: engine.gameConfigSnapshot,
		});

		// Catch the new socket up to the in-flight round so the UI doesn't sit
		// blank until the next phase transition.
		const snapshot = engine.currentRoundSnapshot;
		if (snapshot) {
			socket.emit("round_state", {
				roundId: snapshot.roundId,
				nonce: snapshot.nonce,
				roundNumber: snapshot.roundNumber,
				phase: snapshot.phase,
				phaseDurationMs: snapshot.phaseDurationMs,
				phaseRemainingMs: snapshot.phaseRemainingMs,
				serverSeedHash: snapshot.serverSeedHash,
				clientSeed: snapshot.clientSeed,
			});
		}

		// Pull the player's current balance from the operator wallet and push it
		// down so the UI has something to show before the first bet/win.
		void (async () => {
			try {
				const res = await fetchInitialBalanceWithRetry(
					engine.getWalletClient(),
					{
						sessionId,
						operatorId,
						playerRef,
						currency,
						gameCode,
						isConnected: () => socket.connected,
					},
				);
				if (!res) return;
				if (res.balanceMicro != null && socket.connected) {
					socket.emit("balance_update", {
						playerRef,
						balanceMicro: res.balanceMicro.toString(),
						currency: res.currency ?? currency,
					});
					return;
				}
				logger.warn("initial balance fetch returned no balance", {
					sessionId,
					status: res.status,
					message: res.message ?? null,
				});
				if (socket.connected) {
					socket.emit("balance_unavailable", {
						status: res.status,
						message: res.message ?? null,
					});
				}
			} catch (err) {
				logger.warn("initial balance fetch failed", {
					sessionId,
					err: (err as Error).message,
				});
				if (socket.connected) {
					socket.emit("balance_unavailable", {
						status: "RS_ERROR_UNKNOWN",
						message: (err as Error).message,
					});
				}
			}
		})();

		socket.on(
			"place_bet",
			async (payload: unknown, ack?: (r: unknown) => void) => {
				const envelope = PlaceBetEnvelopeSchema.safeParse(payload);
				if (!envelope.success) {
					ack?.({ ok: false, reason: "invalid_envelope" });
					return;
				}
				const selection = engine.plugin.selectionSchema.safeParse(
					envelope.data.selection,
				);
				if (!selection.success) {
					ack?.({ ok: false, reason: "invalid_selection" });
					return;
				}
				const result = await engine.placeBet({
					sessionId: socket.data.sessionId,
					playerRef: socket.data.playerRef,
					operatorId: socket.data.operatorId,
					currency: socket.data.currency,
					input: {
						amountMicro: envelope.data.amountMicro,
						selection: selection.data,
						autoplay: envelope.data.autoplay,
						turbo: envelope.data.turbo,
					},
				});
				ack?.(result);
			},
		);

		socket.on(
			"cash_out",
			async (payload: unknown, ack?: (r: unknown) => void) => {
				const parsed = z
					.object({
						betId: z.string().uuid(),
						slotId: z.string().optional(),
					})
					.safeParse(payload);
				if (!parsed.success) {
					ack?.({ ok: false, reason: "invalid_envelope" });
					return;
				}
				const result = await engine.cashOut({
					sessionId: socket.data.sessionId,
					playerRef: socket.data.playerRef,
					operatorId: socket.data.operatorId,
					currency: socket.data.currency,
					betId: parsed.data.betId,
					slotId: parsed.data.slotId,
				});
				ack?.(result);
			},
		);

		socket.on("disconnect", () => {
			decrementPresence(room, sessionId);
			emitPresence(io, room);
		});
	});
}
