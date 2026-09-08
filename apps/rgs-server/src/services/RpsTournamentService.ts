import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { decryptSecret } from "../utils/secrets.js";
import { newUuid } from "../utils/uuid.js";
import { HttpWalletAdapter } from "../wallet/HttpWalletAdapter.js";
import { InternalWalletAdapter } from "../wallet/InternalWalletAdapter.js";
import { isSuccessOrDuplicate, type AwardRequest } from "../wallet/types.js";
import { WalletClient } from "../wallet/WalletClient.js";
import {
	type RpsHand,
	hnlToMicro,
	normalisePrizeTable,
	resolveRpsChoice,
} from "./rpsRules.js";

export const RPS_GAME_CODE = "rps-tournament";
export const RPS_CURRENCY = "HNL";

const POLL_INTERVAL_MS = 1000;
const DEFAULT_CHOICE_WINDOW_MS = 12_000;
const DEFAULT_ROUND_BREAK_MS = 3000;

export interface RpsSessionContext {
	sessionId: string;
	operatorId: string;
	playerRef: string;
	currency: string;
	gameCode: string;
}


export { hnlToMicro, normalisePrizeTable, resolveRpsChoice };
export type { RpsHand };

function tournamentRoom(id: string): string {
	return `rps:tournament:${id}`;
}

function sessionRoom(id: string): string {
	return `session:${id}`;
}

function maskPlayerRef(playerRef: string): string {
	if (playerRef.length <= 4) return playerRef;
	return `${playerRef.slice(0, 2)}***${playerRef.slice(-2)}`;
}

function seedHash(seed: string): string {
	return createHash("sha256").update(seed).digest("hex");
}

function seededSortKey(seed: string, value: string): string {
	return createHmac("sha256", seed).update(value).digest("hex");
}

function asPrizeRows(value: unknown): Array<{ rank: number; amountMicro: string }> {
	return normalisePrizeTable(value);
}

export class RpsTournamentService {
	private timer: NodeJS.Timeout | null = null;
	private readonly fallbackInternal = new InternalWalletAdapter();

	constructor(private readonly io: SocketIOServer) {}

	start(): void {
		if (this.timer) return;
		this.schedule();
		logger.info("RpsTournamentService started");
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	async registerSocket(socket: Socket, ctx: RpsSessionContext): Promise<void> {
		if (ctx.gameCode !== RPS_GAME_CODE || ctx.currency !== RPS_CURRENCY) {
			socket.emit("rps_error", { reason: "juego_no_disponible" });
			return;
		}

		const tournament = await this.findJoinableTournament(ctx.operatorId);
		if (!tournament) {
			socket.emit("rps_tournament_state", {
				status: "NO_EVENT",
				message: "No hay torneos disponibles en este momento.",
			});
			return;
		}

		const participant = await prisma.rpsParticipant.upsert({
			where: {
				tournamentId_playerRef: {
					tournamentId: tournament.id,
					playerRef: ctx.playerRef,
				},
			},
			create: {
				operatorId: ctx.operatorId,
				tournamentId: tournament.id,
				sessionId: ctx.sessionId,
				playerRef: ctx.playerRef,
				displayName: maskPlayerRef(ctx.playerRef),
				lastSeenAt: new Date(),
			},
			update: {
				sessionId: ctx.sessionId,
				lastSeenAt: new Date(),
			},
		});

		socket.join(tournamentRoom(tournament.id));
		socket.emit("rps_registration_update", {
			tournamentId: tournament.id,
			participantId: participant.id,
			status: participant.status,
		});
		await this.emitTournamentState(tournament.id, ctx.sessionId);
		await this.audit(tournament.id, ctx.operatorId, "participant_registered", {
			playerRef: ctx.playerRef,
			sessionId: ctx.sessionId,
		});
	}

	async submitChoice(ctx: RpsSessionContext, matchId: string, choice: RpsHand): Promise<{ ok: true } | { ok: false; reason: string }> {
		const match = await prisma.rpsMatch.findUnique({
			where: { id: matchId },
			include: { tournament: true },
		});
		if (!match || match.operatorId !== ctx.operatorId) return { ok: false, reason: "partida_no_encontrada" };
		if (match.status !== "OPEN") return { ok: false, reason: "partida_cerrada" };
		if (match.startsAt.getTime() > Date.now()) return { ok: false, reason: "partida_no_iniciada" };
		if (match.endsAt.getTime() <= Date.now()) return { ok: false, reason: "tiempo_agotado" };

		const participant = await prisma.rpsParticipant.findFirst({
			where: {
				tournamentId: match.tournamentId,
				playerRef: ctx.playerRef,
			},
		});
		if (!participant) return { ok: false, reason: "jugador_no_registrado" };
		if (participant.id !== match.participantAId && participant.id !== match.participantBId) {
			return { ok: false, reason: "no_es_tu_partida" };
		}

		await prisma.rpsChoice.upsert({
			where: {
				matchId_participantId: {
					matchId,
					participantId: participant.id,
				},
			},
			create: { matchId, participantId: participant.id, choice },
			update: {},
		});
		this.io.to(sessionRoom(ctx.sessionId)).emit("rps_choice_ack", {
			matchId,
			choice,
			submitted: true,
		});
		await this.emitMatchUpdate(match.tournamentId, matchId);
		await this.tryResolveMatch(matchId);
		return { ok: true };
	}

	async createTournament(input: {
		operatorId: string;
		title: string;
		scheduledStartAt: Date;
		minPlayers: number;
		choiceWindowMs: number;
		roundBreakMs: number;
		prizeTable: Array<{ rank: number; amountMicro: string }>;
		actor?: string | null;
	}) {
		const seed = randomBytes(32).toString("hex");
		const created = await prisma.rpsTournament.create({
			data: {
				operatorId: input.operatorId,
				title: input.title,
				currency: RPS_CURRENCY,
				status: "SCHEDULED",
				scheduledStartAt: input.scheduledStartAt,
				minPlayers: input.minPlayers,
				choiceWindowMs: input.choiceWindowMs,
				roundBreakMs: input.roundBreakMs,
				prizeTable: input.prizeTable as object,
				seed,
				seedHash: seedHash(seed),
				createdBy: input.actor ?? null,
				updatedBy: input.actor ?? null,
			},
		});
		await this.audit(created.id, input.operatorId, "tournament_created", {
			title: created.title,
			scheduledStartAt: created.scheduledStartAt.toISOString(),
		}, input.actor);
		return created;
	}

	async manualStart(tournamentId: string, operatorId: string, actor?: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
		const tournament = await prisma.rpsTournament.findUnique({ where: { id: tournamentId } });
		if (!tournament || tournament.operatorId !== operatorId) return { ok: false, reason: "not_found" };
		if (!["SCHEDULED", "REGISTERING"].includes(tournament.status)) return { ok: false, reason: "not_startable" };
		const count = await prisma.rpsParticipant.count({ where: { tournamentId } });
		if (count < tournament.minPlayers) return { ok: false, reason: "min_players_not_met" };
		await this.startTournament(tournamentId, actor ?? "manual");
		return { ok: true };
	}

	async cancel(tournamentId: string, operatorId: string, reason: string, actor?: string | null): Promise<{ ok: true } | { ok: false; reason: string }> {
		const tournament = await prisma.rpsTournament.findUnique({ where: { id: tournamentId } });
		if (!tournament || tournament.operatorId !== operatorId) return { ok: false, reason: "not_found" };
		if (["COMPLETED", "CANCELLED"].includes(tournament.status)) return { ok: false, reason: "not_cancelable" };
		await prisma.rpsTournament.update({
			where: { id: tournamentId },
			data: {
				status: "CANCELLED",
				cancelledAt: new Date(),
				cancelledReason: reason.slice(0, 256),
				updatedBy: actor ?? null,
			},
		});
		await this.audit(tournamentId, operatorId, "tournament_cancelled", { reason }, actor);
		this.io.to(tournamentRoom(tournamentId)).emit("rps_tournament_complete", {
			tournamentId,
			status: "CANCELLED",
			reason,
		});
		return { ok: true };
	}

	private schedule(): void {
		this.timer = setTimeout(() => {
			this.tick()
				.catch((err) => logger.error("rps_tournament_tick_failed", { err: (err as Error).message }))
				.finally(() => this.schedule());
		}, POLL_INTERVAL_MS);
	}

	private async tick(): Promise<void> {
		await this.startDueTournaments();
		await this.resolveExpiredMatches();
		await this.advanceReadyTournaments();
	}

	private async findJoinableTournament(operatorId: string) {
		const now = new Date();
		return prisma.rpsTournament.findFirst({
			where: {
				operatorId,
				currency: RPS_CURRENCY,
				status: { in: ["SCHEDULED", "REGISTERING"] },
				scheduledStartAt: { gte: new Date(now.getTime() - 60_000) },
			},
			orderBy: { scheduledStartAt: "asc" },
		});
	}

	private async startDueTournaments(): Promise<void> {
		const due = await prisma.rpsTournament.findMany({
			where: {
				status: { in: ["SCHEDULED", "REGISTERING"] },
				scheduledStartAt: { lte: new Date() },
			},
			take: 20,
		});
		for (const tournament of due) {
			const count = await prisma.rpsParticipant.count({ where: { tournamentId: tournament.id } });
			if (count >= tournament.minPlayers) await this.startTournament(tournament.id, "scheduled");
		}
	}

	private async startTournament(tournamentId: string, actor: string): Promise<void> {
		const tournament = await prisma.rpsTournament.findUnique({
			where: { id: tournamentId },
			include: { participants: true },
		});
		if (!tournament || !["SCHEDULED", "REGISTERING"].includes(tournament.status)) return;
		if (tournament.participants.length < tournament.minPlayers) return;

		await prisma.rpsTournament.update({
			where: { id: tournamentId },
			data: { status: "RUNNING", startedAt: new Date(), currentRound: 1 },
		});
		await prisma.rpsParticipant.updateMany({
			where: { tournamentId, status: "REGISTERED" },
			data: { status: "ACTIVE" },
		});
		await this.audit(tournamentId, tournament.operatorId, "tournament_started", { actor });
		await this.createRoundMatches(tournamentId, 1, tournament.roundBreakMs);
		await this.emitTournamentState(tournamentId);
	}

	private async createRoundMatches(tournamentId: string, roundNumber: number, delayMs: number): Promise<void> {
		const tournament = await prisma.rpsTournament.findUnique({
			where: { id: tournamentId },
			include: { participants: { where: { status: "ACTIVE" } } },
		});
		if (!tournament) return;
		const startsAt = new Date(Date.now() + delayMs);
		const endsAt = new Date(startsAt.getTime() + (tournament.choiceWindowMs || DEFAULT_CHOICE_WINDOW_MS));
		const active = [...tournament.participants].sort((a, b) =>
			seededSortKey(tournament.seed, `${roundNumber}:${a.id}`).localeCompare(
				seededSortKey(tournament.seed, `${roundNumber}:${b.id}`),
			),
		);

		for (let i = 0; i < active.length; i += 2) {
			const a = active[i];
			const b = active[i + 1];
			if (!a) continue;
			if (!b) {
				await prisma.rpsMatch.create({
					data: {
						operatorId: tournament.operatorId,
						tournamentId,
						roundNumber,
						participantAId: a.id,
						winnerId: a.id,
						status: "BYE",
						resultReason: "BYE",
						startsAt,
						endsAt: startsAt,
						resolvedAt: new Date(),
					},
				});
				continue;
			}
			const match = await prisma.rpsMatch.create({
				data: {
					operatorId: tournament.operatorId,
					tournamentId,
					roundNumber,
					participantAId: a.id,
					participantBId: b.id,
					status: "OPEN",
					startsAt,
					endsAt,
				},
			});
			this.io.to(tournamentRoom(tournamentId)).emit("rps_match_start", this.matchWire(match));
		}
		await prisma.rpsTournament.update({
			where: { id: tournamentId },
			data: { currentRound: roundNumber },
		});
		await this.emitTournamentState(tournamentId);
	}

	private async resolveExpiredMatches(): Promise<void> {
		const matches = await prisma.rpsMatch.findMany({
			where: { status: "OPEN", endsAt: { lte: new Date() } },
			take: 50,
		});
		for (const match of matches) await this.tryResolveMatch(match.id, true);
	}

	private async tryResolveMatch(matchId: string, force = false): Promise<void> {
		const match = await prisma.rpsMatch.findUnique({
			where: { id: matchId },
			include: { choices: true },
		});
		if (!match || match.status !== "OPEN") return;
		const aChoice = match.choices.find((c) => c.participantId === match.participantAId)?.choice as RpsHand | undefined;
		const bChoice = match.choices.find((c) => c.participantId === match.participantBId)?.choice as RpsHand | undefined;
		if (!force && (!aChoice || !bChoice)) return;

		const result = resolveRpsChoice(aChoice ?? null, bChoice ?? null);
		if (result.winner === "TIE") {
			await prisma.rpsMatch.update({
				where: { id: matchId },
				data: { status: "TIED", resultReason: result.reason, resolvedAt: new Date() },
			});
			const retry = await prisma.rpsMatch.create({
				data: {
					operatorId: match.operatorId,
					tournamentId: match.tournamentId,
					roundNumber: match.roundNumber,
					attemptNumber: match.attemptNumber + 1,
					participantAId: match.participantAId,
					participantBId: match.participantBId,
					status: "OPEN",
					resultReason: "REPLAY",
					startsAt: new Date(Date.now() + DEFAULT_ROUND_BREAK_MS),
					endsAt: new Date(Date.now() + DEFAULT_ROUND_BREAK_MS + DEFAULT_CHOICE_WINDOW_MS),
				},
			});
			this.io.to(tournamentRoom(match.tournamentId)).emit("rps_match_result", {
				matchId,
				result: "TIE",
				replayMatchId: retry.id,
			});
			this.io.to(tournamentRoom(match.tournamentId)).emit("rps_match_start", this.matchWire(retry));
			await this.emitTournamentState(match.tournamentId);
			return;
		}

		const winnerId = result.winner === "A" ? match.participantAId : match.participantBId;
		const loserId = result.winner === "A" ? match.participantBId : match.participantAId;
		await prisma.rpsMatch.update({
			where: { id: matchId },
			data: { status: "RESOLVED", winnerId, resultReason: result.reason, resolvedAt: new Date() },
		});
		if (loserId) await this.eliminateParticipant(loserId);
		this.io.to(tournamentRoom(match.tournamentId)).emit("rps_match_result", {
			matchId,
			winnerId,
			loserId,
			reason: result.reason,
		});
		await this.emitTournamentState(match.tournamentId);
	}

	private async eliminateParticipant(participantId: string): Promise<void> {
		const participant = await prisma.rpsParticipant.findUnique({
			where: { id: participantId },
			include: { tournament: true },
		});
		if (!participant || participant.status !== "ACTIVE") return;
		const remaining = await prisma.rpsParticipant.count({
			where: {
				tournamentId: participant.tournamentId,
				status: "ACTIVE",
				id: { not: participantId },
			},
		});
		await prisma.rpsParticipant.update({
			where: { id: participantId },
			data: {
				status: "ELIMINATED",
				eliminatedAt: new Date(),
				rank: remaining + 1,
			},
		});
	}

	private async advanceReadyTournaments(): Promise<void> {
		const running = await prisma.rpsTournament.findMany({
			where: { status: "RUNNING" },
			take: 20,
		});
		for (const tournament of running) {
			const open = await prisma.rpsMatch.count({
				where: { tournamentId: tournament.id, status: "OPEN" },
			});
			if (open > 0) continue;
			const active = await prisma.rpsParticipant.findMany({
				where: { tournamentId: tournament.id, status: "ACTIVE" },
				orderBy: { registeredAt: "asc" },
			});
			if (active.length === 1) {
				await prisma.rpsParticipant.update({
					where: { id: active[0]!.id },
					data: { status: "WINNER", rank: 1 },
				});
				await prisma.rpsTournament.update({
					where: { id: tournament.id },
					data: { status: "SETTLING" },
				});
				await this.awardPrizes(tournament.id);
				await prisma.rpsTournament.update({
					where: { id: tournament.id },
					data: { status: "COMPLETED", completedAt: new Date() },
				});
				this.io.to(tournamentRoom(tournament.id)).emit("rps_tournament_complete", {
					tournamentId: tournament.id,
					winnerId: active[0]!.id,
					seed: tournament.seed,
				});
				await this.emitTournamentState(tournament.id);
				continue;
			}
			const unresolvedNonOpen = await prisma.rpsMatch.count({
				where: {
					tournamentId: tournament.id,
					roundNumber: tournament.currentRound,
					status: { in: ["PENDING"] },
				},
			});
			if (unresolvedNonOpen === 0 && active.length > 1) {
				await this.createRoundMatches(
					tournament.id,
					tournament.currentRound + 1,
					tournament.roundBreakMs || DEFAULT_ROUND_BREAK_MS,
				);
			}
		}
	}

	private async awardPrizes(tournamentId: string): Promise<void> {
		const tournament = await prisma.rpsTournament.findUnique({
			where: { id: tournamentId },
			include: { participants: true },
		});
		if (!tournament) return;
		const prizeTable = asPrizeRows(tournament.prizeTable);
		const byRank = new Map(tournament.participants.filter((p) => p.rank != null).map((p) => [p.rank!, p]));
		const wallet = await this.walletClient(tournament.operatorId);

		for (const prize of prizeTable) {
			const participant = byRank.get(prize.rank);
			if (!participant) continue;
			const amountMicro = BigInt(prize.amountMicro);
			if (amountMicro <= 0n) continue;
			const existing = await prisma.rpsPrizeAward.findUnique({
				where: { tournamentId_rank: { tournamentId, rank: prize.rank } },
			});
			if (existing?.status === "AWARDED") continue;
			const requestUuid = existing?.requestUuid ?? newUuid();
			const transactionUuid = existing?.transactionUuid ?? newUuid();
			const prizeRef = `rps:${tournamentId}:rank:${prize.rank}`;
			const award = await prisma.rpsPrizeAward.upsert({
				where: { tournamentId_rank: { tournamentId, rank: prize.rank } },
				create: {
					operatorId: tournament.operatorId,
					tournamentId,
					participantId: participant.id,
					playerRef: participant.playerRef,
					rank: prize.rank,
					prizeRef,
					amountMicro,
					currency: RPS_CURRENCY,
					requestUuid,
					transactionUuid,
				},
				update: { requestUuid, transactionUuid, lastError: null },
			});
			const req: AwardRequest = {
				requestUuid,
				transactionUuid,
				operatorId: tournament.operatorId,
				playerRef: participant.playerRef,
				currency: RPS_CURRENCY,
				gameCode: RPS_GAME_CODE,
				amountMicro,
				prizeRef,
				tournamentId,
				rank: prize.rank,
				meta: { tournamentId, rank: prize.rank, awardId: award.id },
			};
			const res = await wallet.award(req);
			if (isSuccessOrDuplicate(res.status)) {
				await prisma.rpsPrizeAward.update({
					where: { id: award.id },
					data: { status: "AWARDED", awardedAt: new Date(), lastError: null },
				});
				this.io.to(tournamentRoom(tournamentId)).emit("rps_prize_awarded", {
					tournamentId,
					participantId: participant.id,
					rank: prize.rank,
					amountMicro: amountMicro.toString(),
				});
			} else {
				await prisma.rpsPrizeAward.update({
					where: { id: award.id },
					data: { status: "FAILED", lastError: res.status },
				});
				await prisma.pendingWalletJob.create({
					data: {
						operatorId: tournament.operatorId,
						endpoint: "AWARD",
						payload: {
							requestUuid,
							transactionUuid,
							playerRef: participant.playerRef,
							currency: RPS_CURRENCY,
							gameCode: RPS_GAME_CODE,
							amountMicro: amountMicro.toString(),
							prizeRef,
							tournamentId,
							rank: prize.rank,
						},
						lastError: res.status,
					},
				});
			}
		}
	}

	private async walletClient(operatorId: string): Promise<WalletClient> {
		const operator = await prisma.operator.findUnique({ where: { id: operatorId } });
		const cred = await prisma.operatorCredential.findFirst({
			where: { operatorId, type: "WALLET_HMAC_OUTBOUND", revokedAt: null },
			orderBy: { createdAt: "desc" },
		});
		if (!operator || !cred || !operator.walletCallbackUrl) return new WalletClient(operatorId, this.fallbackInternal);
		return new WalletClient(
			operatorId,
			new HttpWalletAdapter({
				operatorId,
				kid: cred.kid,
				secret: decryptSecret(Buffer.from(cred.cipherBlob)),
				walletCallbackUrl: operator.walletCallbackUrl,
				timeoutMs: config.walletCallTimeoutMs,
			}),
		);
	}

	private async emitMatchUpdate(tournamentId: string, matchId: string): Promise<void> {
		const match = await prisma.rpsMatch.findUnique({
			where: { id: matchId },
			include: { choices: true },
		});
		if (!match) return;
		this.io.to(tournamentRoom(tournamentId)).emit("rps_bracket_update", {
			match: this.matchWire(match),
			choicesSubmitted: match.choices.map((c) => c.participantId),
		});
	}

	private async emitTournamentState(tournamentId: string, sessionId?: string): Promise<void> {
		const tournament = await prisma.rpsTournament.findUnique({
			where: { id: tournamentId },
			include: {
				participants: { orderBy: [{ rank: "asc" }, { registeredAt: "asc" }] },
				matches: { orderBy: [{ roundNumber: "asc" }, { createdAt: "asc" }] },
				prizeAwards: true,
			},
		});
		if (!tournament) return;
		const payload = {
			tournamentId,
			title: tournament.title,
			status: tournament.status,
			currency: tournament.currency,
			scheduledStartAt: tournament.scheduledStartAt.toISOString(),
			startedAt: tournament.startedAt?.toISOString() ?? null,
			completedAt: tournament.completedAt?.toISOString() ?? null,
			currentRound: tournament.currentRound,
			minPlayers: tournament.minPlayers,
			choiceWindowMs: tournament.choiceWindowMs,
			roundBreakMs: tournament.roundBreakMs,
			prizeTable: asPrizeRows(tournament.prizeTable),
			seedHash: tournament.seedHash,
			seed: tournament.status === "COMPLETED" ? tournament.seed : null,
			participants: tournament.participants.map((p) => ({
				id: p.id,
				playerRef: p.displayName ?? maskPlayerRef(p.playerRef),
				status: p.status,
				rank: p.rank,
			})),
			matches: tournament.matches.map((m) => this.matchWire(m)),
			awards: tournament.prizeAwards.map((a) => ({
				id: a.id,
				participantId: a.participantId,
				rank: a.rank,
				amountMicro: a.amountMicro.toString(),
				status: a.status,
			})),
		};
		const target = sessionId ? this.io.to(sessionRoom(sessionId)) : this.io.to(tournamentRoom(tournamentId));
		target.emit("rps_tournament_state", payload);
		target.emit("rps_bracket_update", payload);
	}

	private matchWire(match: {
		id: string;
		roundNumber: number;
		attemptNumber: number;
		participantAId: string | null;
		participantBId: string | null;
		winnerId: string | null;
		status: string;
		resultReason: string | null;
		startsAt: Date;
		endsAt: Date;
		resolvedAt: Date | null;
	}) {
		return {
			id: match.id,
			roundNumber: match.roundNumber,
			attemptNumber: match.attemptNumber,
			participantAId: match.participantAId,
			participantBId: match.participantBId,
			winnerId: match.winnerId,
			status: match.status,
			resultReason: match.resultReason,
			startsAt: match.startsAt.toISOString(),
			endsAt: match.endsAt.toISOString(),
			resolvedAt: match.resolvedAt?.toISOString() ?? null,
		};
	}

	private async audit(
		tournamentId: string,
		operatorId: string,
		eventType: string,
		data: Record<string, unknown>,
		actor?: string | null,
	): Promise<void> {
		await prisma.rpsAuditEvent.create({
			data: { tournamentId, operatorId, eventType, data, actor: actor ?? null },
		}).catch((err) => logger.warn("rps_audit_write_failed", { err: (err as Error).message }));
	}
}

let singleton: RpsTournamentService | null = null;

export function initRpsTournamentService(io: SocketIOServer): RpsTournamentService {
	singleton = new RpsTournamentService(io);
	return singleton;
}

export function getRpsTournamentService(): RpsTournamentService {
	if (!singleton) throw new Error("RpsTournamentService not initialised");
	return singleton;
}
