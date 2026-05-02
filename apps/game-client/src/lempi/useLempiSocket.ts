import { useCallback, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useSessionStore } from "../session/sessionStore";
import {
	hnlToMicro,
	type LempiBetHistoryEntry,
	type LempiSlotId,
	type LempiState,
	useLempiStore,
} from "./LempiStore";
import { playLempiTone } from "./sound";

const SOCKET_URL = (import.meta.env.VITE_RGS_SOCKET_URL ?? "").replace(
	/\/+$/,
	"",
);

function asBig(value: unknown): bigint | null {
	if (typeof value !== "string") return null;
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function phaseToState(phase: string | undefined) {
	switch ((phase ?? "").toUpperCase()) {
		case "BETTING_OPEN":
			return "BETTING_OPEN";
		case "ROLLING":
			return "ROLLING";
		case "RESULT":
			return "RESULT";
		case "SETTLED":
			return "COOLDOWN";
		default:
			return "WAITING";
	}
}

function spanishReason(reason: string | undefined, fallback: string): string {
	switch (reason) {
		case "too_late":
			return "Demasiado tarde";
		case "not_found":
			return "Apuesta no encontrada";
		case "already_cashed_out":
			return "Retiro ya realizado";
		case "not_cashoutable":
			return "Retiro no disponible";
		case "invalid_selection":
			return "Seleccion invalida";
		case "betting_closed":
			return "Apuestas cerradas";
		case "insufficient_funds":
			return "Saldo insuficiente";
		case "wallet_timeout":
			return "La billetera no respondio";
		case "wallet_error":
			return "Error de billetera";
		case "server_error":
			return "Error del servidor";
		case "invalid_token":
			return "Sesion invalida";
		case "round_not_open":
			return "La ronda no acepta apuestas";
		case "spin_too_fast":
			return "Espera un momento antes de volver a apostar";
		default:
			return fallback;
	}
}

function emitNotice(detail: string): void {
	window.dispatchEvent(new CustomEvent("lempi:notice", { detail }));
}

export function useLempiSocket(): {
	placeBet: (
		slotId: LempiSlotId,
		amountText: string,
		autoCashout: number | null,
	) => void;
	cashOut: (slotId: LempiSlotId) => void;
} {
	const token = useSessionStore((s) => s.token);
	const socketRef = useRef<Socket | null>(null);

	const placeBet = useCallback(
		(slotId: LempiSlotId, amountText: string, autoCashout: number | null) => {
			const socket = socketRef.current;
			if (!socket?.connected) {
				emitNotice("Conectando al servidor");
				return;
			}
			const amountMicro = hnlToMicro(amountText);
			const store = useLempiStore.getState();
			store.setSlot(slotId, {
				amountMicro,
				autoCashoutMultiplier: autoCashout,
				status: "PENDING",
				betId: null,
				cashoutMultiplier: null,
				payoutMicro: null,
			});
			playLempiTone("bet");
			socket.emit(
				"place_bet",
				{
					amountMicro: amountMicro.toString(),
					selection: {
						slotId,
						...(autoCashout ? { autoCashoutMultiplier: autoCashout } : {}),
					},
				},
				(ack: { ok?: boolean; betId?: string; reason?: string }) => {
					const latest = useLempiStore.getState();
					if (ack?.ok && ack.betId) {
						latest.setSlot(slotId, { betId: ack.betId, status: "ACTIVE" });
						return;
					}
					latest.setSlot(slotId, { status: "IDLE", betId: null });
					emitNotice(spanishReason(ack?.reason, "Apuesta rechazada"));
				},
			);
		},
		[],
	);

	const cashOut = useCallback((slotId: LempiSlotId) => {
		const socket = socketRef.current;
		const slot = useLempiStore.getState().slots[slotId];
		if (!socket?.connected) {
			emitNotice("Conectando al servidor");
			return;
		}
		if (!slot.betId || slot.status !== "ACTIVE") return;
		socket.emit(
			"cash_out",
			{ betId: slot.betId, slotId },
			(ack: {
				ok?: boolean;
				reason?: string;
				cashoutMultiplier?: number;
				payoutMicro?: string;
			}) => {
				if (ack?.ok) return;
				emitNotice(spanishReason(ack?.reason, "Retiro rechazado"));
			},
		);
	}, []);

	useEffect(() => {
		if (!token) return;
		const socketOptions = {
			auth: { token },
			transports: ["websocket", "polling"],
			reconnection: true,
			reconnectionAttempts: Infinity,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
		};
		const socket = SOCKET_URL
			? io(SOCKET_URL, socketOptions)
			: io(socketOptions);
		socketRef.current = socket;

		let countdownHandle: ReturnType<typeof setInterval> | null = null;
		const stopCountdown = () => {
			if (countdownHandle) {
				clearInterval(countdownHandle);
				countdownHandle = null;
			}
		};
		const startCountdown = () => {
			stopCountdown();
			countdownHandle = setInterval(() => {
				const s = useLempiStore.getState();
				if (s.roundState !== "BETTING_OPEN") {
					stopCountdown();
					return;
				}
				s.setRoundInfo(
					s.roundId ?? "",
					s.roundNumber,
					Math.max(0, s.timeRemaining - 1),
				);
			}, 1000);
		};

		socket.on("connect", () => useLempiStore.getState().setConnected(true));
		socket.on("connect_error", (err) => {
			useLempiStore.getState().setConnected(false);
			emitNotice(`Error del servidor: ${err.message || "conexion fallida"}`);
		});
		socket.on("error", (err: { message?: string } | string | undefined) => {
			const message = typeof err === "string" ? err : err?.message;
			emitNotice(`Error del servidor: ${message || "intenta de nuevo"}`);
		});
		socket.on("disconnect", (reason) => {
			useLempiStore.getState().setConnected(false);
			if (reason !== "io client disconnect") {
				emitNotice("Conexion perdida con el servidor");
			}
		});

		socket.on(
			"game_config",
			(data: {
				currency?: string;
				minBetMicro?: string;
				maxBetMicro?: string;
				bettingWindowMs?: number;
				config?: { maxMultiplier?: number };
			}) => {
				const patch: Partial<
					Pick<
						LempiState,
						| "currency"
						| "minBetMicro"
						| "maxBetMicro"
						| "bettingWindowMs"
						| "maxMultiplier"
					>
				> = {};
				const min = asBig(data.minBetMicro);
				const max = asBig(data.maxBetMicro);
				if (data.currency) patch.currency = data.currency;
				if (min != null) patch.minBetMicro = min;
				if (max != null) patch.maxBetMicro = max;
				if (data.bettingWindowMs) patch.bettingWindowMs = data.bettingWindowMs;
				if (data.config?.maxMultiplier)
					patch.maxMultiplier = data.config.maxMultiplier;
				useLempiStore.getState().setConfig(patch);
			},
		);

		socket.on(
			"round_state",
			(data: {
				roundId: string;
				roundNumber?: number;
				nonce?: number;
				phase?: string;
				phaseDurationMs?: number;
				phaseRemainingMs?: number;
			}) => {
				const s = useLempiStore.getState();
				const nextState = phaseToState(data.phase);
				const duration = Math.ceil(
					(data.phaseRemainingMs ?? data.phaseDurationMs ?? 0) / 1000,
				);
				s.setRoundInfo(
					data.roundId,
					data.roundNumber ??
						(typeof data.nonce === "number" ? data.nonce + 1 : s.roundNumber),
					duration,
				);
				s.setRoundState(nextState);
				if (nextState === "BETTING_OPEN") {
					s.resetSlotsForRound();
					startCountdown();
				} else {
					stopCountdown();
				}
			},
		);

		socket.on("multiplier_tick", (data: { multiplier?: number }) => {
			if (typeof data.multiplier === "number") {
				useLempiStore.getState().setMultiplier(data.multiplier);
			}
		});

		socket.on(
			"cashout_accepted",
			(data: {
				slotId?: LempiSlotId;
				cashoutMultiplier?: number;
				payoutMicro?: string;
			}) => {
				const payout = asBig(data.payoutMicro) ?? 0n;
				if (data.slotId) {
					useLempiStore.getState().setSlot(data.slotId, {
						status: "CASHED_OUT",
						cashoutMultiplier: data.cashoutMultiplier ?? null,
						payoutMicro: payout,
					});
				}
				playLempiTone("cashout");
			},
		);

		socket.on(
			"player_cashout",
			(data: {
				playerRef?: string;
				cashoutMultiplier?: number;
				payoutMicro?: string;
			}) => {
				const payout = asBig(data.payoutMicro);
				if (data.playerRef && data.cashoutMultiplier && payout != null) {
					useLempiStore.getState().addToast({
						playerRef: data.playerRef,
						multiplier: data.cashoutMultiplier,
						payoutMicro: payout,
					});
				}
			},
		);

		socket.on(
			"pool_update",
			(data: {
				acceptedCount?: number;
				cashedOutCount?: number;
				totalStakeMicro?: string;
				totalWinMicro?: string;
				players?: Array<{
					betId: string;
					playerRef: string;
					amountMicro: string;
					cashoutMultiplier: number | null;
					winMicro: string | null;
				}>;
			}) => {
				useLempiStore.getState().setPool({
					acceptedCount: data.acceptedCount ?? 0,
					cashedOutCount: data.cashedOutCount ?? 0,
					totalStakeMicro: asBig(data.totalStakeMicro) ?? 0n,
					totalWinMicro: asBig(data.totalWinMicro) ?? 0n,
					players: (data.players ?? []).map((p) => ({
						betId: p.betId,
						playerRef: p.playerRef,
						amountMicro: asBig(p.amountMicro) ?? 0n,
						cashoutMultiplier: p.cashoutMultiplier,
						winMicro: asBig(p.winMicro) ?? null,
					})),
				});
			},
		);

		socket.on(
			"round_result",
			(data: { outcome?: { crashMultiplier?: number } }) => {
				stopCountdown();
				const crashMultiplier =
					data.outcome?.crashMultiplier ?? useLempiStore.getState().multiplier;
				const s = useLempiStore.getState();
				s.setCrashResult(crashMultiplier);
				s.setRoundState("RESULT");
				const historyEntries: LempiBetHistoryEntry[] = (["A", "B"] as const)
					.map((slotId) => {
						const slot = s.slots[slotId];
						if (!slot.betId) return null;
						const won = slot.status === "CASHED_OUT";
						return {
							id: `${s.roundId ?? "round"}-${slot.betId}`,
							roundId: s.roundId ?? "",
							roundNumber: s.roundNumber,
							slotId,
							amountMicro: slot.amountMicro,
							crashMultiplier,
							cashoutMultiplier: slot.cashoutMultiplier,
							payoutMicro: slot.payoutMicro,
							result: won ? "WIN" : "LOSS",
						};
					})
					.filter((entry): entry is LempiBetHistoryEntry => entry != null);
				s.addBetHistory(historyEntries);
				for (const slotId of ["A", "B"] as const) {
					const slot = s.slots[slotId];
					if (slot.status === "ACTIVE" || slot.status === "PENDING") {
						s.setSlot(slotId, { status: "LOST" });
					}
				}
				playLempiTone("crash");
			},
		);

		socket.on(
			"balance_update",
			(data: { balanceMicro?: string; currency?: string }) => {
				const balance = asBig(data.balanceMicro);
				if (balance != null) useLempiStore.getState().setBalanceMicro(balance);
				if (data.currency)
					useLempiStore.getState().setConfig({ currency: data.currency });
			},
		);

		socket.on("bet_rejected", (data: { reason?: string } | undefined) => {
			emitNotice(spanishReason(data?.reason, "Apuesta rechazada"));
		});

		return () => {
			stopCountdown();
			socket.disconnect();
			socketRef.current = null;
			useLempiStore.getState().setConnected(false);
		};
	}, [token]);

	return { placeBet, cashOut };
}
