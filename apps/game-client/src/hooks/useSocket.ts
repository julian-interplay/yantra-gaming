import { useCallback, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useSessionStore } from "../session/sessionStore";
import {
	type BetSide,
	type RoundState,
	useGameStore,
} from "../store/gameStore";

// Socket.IO target — VITE_RGS_SOCKET_URL in prod, Vite proxy in dev.
const SOCKET_URL = (import.meta.env.VITE_RGS_SOCKET_URL ?? "").replace(
	/\/+$/,
	"",
);

export interface BetRejectedPayload {
	reason: string;
	code?: string;
	roundId?: string;
}

export interface UseSocketApi {
	/** Places a bet on the current round. */
	placeBet: (side: BetSide, amountMicro: bigint) => void;
	/** Latest bet-rejection payload, cleared on the next bet attempt. */
}

/**
 * Opens a Socket.IO connection to the RGS using the session token from the
 * in-memory store. Subscribes to the player-facing event set and wires
 * state into gameStore. Returns a stable `placeBet` emitter.
 */
export function useSocket(): {
	placeBet: (side: BetSide, amountMicro: bigint) => void;
} {
	const socketRef = useRef<Socket | null>(null);
	const token = useSessionStore((s) => s.token);

	const placeBet = useCallback((side: BetSide, amountMicro: bigint) => {
		const socket = socketRef.current;
		if (!socket?.connected) return;
		// Amounts are transmitted as decimal strings — BigInt is not JSON-safe.
		socket.emit("place_bet", {
			amountMicro: amountMicro.toString(),
			selection: { side },
		});
		// Optimistic local state so the UI can show "bet placed" immediately.
		// The server's `balance_update` / `bet_rejected` will correct it.
		const s = useGameStore.getState();
		s.placeBet(side, amountMicro);
		if (s.roundId) {
			s.addPlayerBet({
				roundId: s.roundId,
				roundNumber: s.roundNumber || undefined,
				side,
				amountMicro,
				status: "PENDING",
				timestamp: Date.now(),
			});
		}
	}, []);

	useEffect(() => {
		if (!token) return;

		const socketOptions = {
			auth: { token },
			transports: ["websocket", "polling"] as const,
			reconnection: true,
			reconnectionAttempts: Infinity,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
		};

		const socket = SOCKET_URL
			? io(SOCKET_URL, socketOptions)
			: io(socketOptions);
		socketRef.current = socket;

		const gs = useGameStore.getState();

		// Client-side countdown. Server only emits phaseDurationMs at phase start,
		// not per-second ticks — so we run a 1Hz interval here and decrement
		// timeRemaining locally. Reset when the phase flips.
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
				const s = useGameStore.getState();
				if (s.roundState !== "BETTING_OPEN") {
					stopCountdown();
					return;
				}
				const next = Math.max(0, s.timeRemaining - 1);
				s.setTimeRemaining(next);
				if (next === 0) stopCountdown();
			}, 1000);
		};

		socket.on("connect", () => {
			gs.setConnected(true);
		});

		socket.on("disconnect", () => {
			useGameStore.getState().setConnected(false);
		});

		/* ── Round state ─────────────────────────────────────── */
		// Server emits `phase` and `phaseDurationMs` / `phaseRemainingMs`; we also
		// accept the older `state` / `timeRemaining` names in case the contract
		// moves back. Everything downstream keeps the client's RoundState vocab.
		socket.on(
			"round_state",
			(data: {
				roundId: string;
				roundNumber?: number;
				nonce?: number;
				// current server shape
				phase?: string;
				phaseDurationMs?: number;
				phaseRemainingMs?: number;
				// legacy / alternative shape
				state?: RoundState;
				timeRemaining?: number;
				bettingDuration?: number;
				// seeds
				serverSeedHash?: string;
				serverSeed?: string;
				clientSeed?: string;
				// embedded outcome (sometimes the server ships the result here too)
				diceValues?: number[];
				outcomeSide?: BetSide;
				outcomeSum?: number;
			}) => {
				if (!data) return;
				const s = useGameStore.getState();

				// Prefer explicit `state` when present, otherwise map server `phase`
				// onto the client's RoundState enum. Unknown phases fall back to
				// WAITING_FOR_BET so the UI never deadlocks.
				const phase = (data.state ?? data.phase ?? "").toUpperCase();
				const nextState: RoundState =
					phase === "BETTING_OPEN"
						? "BETTING_OPEN"
						: phase === "ROLLING"
							? "ROLLING"
							: phase === "RESULT"
								? "RESULT"
								: phase === "SETTLED" || phase === "COOLDOWN"
									? "COOLDOWN"
									: "WAITING_FOR_BET";

				const duration =
					data.phaseDurationMs != null
						? Math.ceil(data.phaseDurationMs / 1000)
						: (data.bettingDuration ?? 0);
				// Server only sends phaseRemainingMs when a client joins mid-phase
				// (the snapshot emit). Otherwise assume the phase just started.
				const timeRemaining =
					data.phaseRemainingMs != null
						? Math.ceil(data.phaseRemainingMs / 1000)
						: data.timeRemaining != null
							? data.timeRemaining
							: duration;

				s.setRoundInfo(data.roundId || "", timeRemaining);
				if (nextState === "BETTING_OPEN" && duration > 0) {
					useGameStore.setState({ bettingDuration: duration });
				}
				s.setRoundState(nextState);

				if (nextState === "BETTING_OPEN") {
					startCountdown();
				} else {
					stopCountdown();
				}

				if (data.serverSeedHash) s.setServerSeedHash(data.serverSeedHash);
				if (data.serverSeed) s.setServerSeed(data.serverSeed);
				if (data.clientSeed) s.setClientSeed(data.clientSeed);
				if (typeof data.nonce === "number") s.setNonce(data.nonce);

				// Server emits the 1-indexed display counter as `roundNumber`; fall
				// back to `nonce + 1` for legacy servers that don't send it.
				const displayNumber =
					typeof data.roundNumber === "number"
						? data.roundNumber
						: typeof data.nonce === "number"
							? data.nonce + 1
							: undefined;
				if (typeof displayNumber === "number") s.setRoundNumber(displayNumber);

				// Some snapshot emits on reconnect may include the outcome inline —
				// mirror it into the store without duplicating history (round_result
				// is the authoritative settlement event).
				if (data.outcomeSum != null && data.outcomeSide) {
					s.setDiceResult(data.outcomeSum, data.outcomeSum, data.outcomeSide);
				}
			},
		);

		/* ── Timer tick ──────────────────────────────────────── */
		socket.on("time_remaining", (data: { timeRemaining: number }) => {
			useGameStore.getState().setTimeRemaining(data.timeRemaining);
		});

		/* ── Round result ────────────────────────────────────── */
		// Server ships `{ roundId, nonce, outcome: { diceValues, outcomeSum, outcomeSide } }`.
		// Accept both the nested and the flat shape so the client survives a
		// future event-shape revision.
		socket.on(
			"round_result",
			(data: {
				roundId: string;
				roundNumber?: number;
				nonce?: number;
				timestamp?: number;
				serverSeed?: string;
				serverSeedHash?: string;
				// nested shape (current server)
				outcome?: {
					diceValues?: number[];
					outcomeSum?: number;
					outcomeSide?: BetSide;
				};
				// flat shape (legacy / alternative)
				diceValues?: number[];
				sum?: number;
				side?: BetSide;
			}) => {
				if (!data) return;
				const s = useGameStore.getState();
				const side: BetSide = (data.outcome?.outcomeSide ??
					data.side ??
					"LOW") as BetSide;
				const sum = data.outcome?.outcomeSum ?? data.sum ?? 0;
				const diceValues = data.outcome?.diceValues ?? data.diceValues;

				s.setDiceResult(sum, sum, side);
				if (data.serverSeed) s.setServerSeed(data.serverSeed);
				if (data.serverSeedHash) s.setServerSeedHash(data.serverSeedHash);

				const displayNumber =
					typeof data.roundNumber === "number"
						? data.roundNumber
						: typeof data.nonce === "number"
							? data.nonce + 1
							: undefined;
				if (typeof displayNumber === "number") s.setRoundNumber(displayNumber);

				s.addHistoryEntry({
					roundId: data.roundId || "",
					roundNumber: displayNumber,
					diceValues,
					dieValue: sum,
					sum,
					side,
					timestamp: data.timestamp || Date.now(),
				});

				const bet = s.currentBet;
				if (bet && bet.side === side) {
					// Provisional +2x stake hint; the authoritative payout lands via
					// balance_update from the operator wallet call.
					s.setLastWinMicro(bet.amountMicro * 2n);
					s.setLastLossMicro(null);
				} else if (bet) {
					s.setLastLossMicro(bet.amountMicro);
					s.setLastWinMicro(null);
				}

				// Settle the player's own bet record (if any) for this round.
				if (data.roundId) {
					const payoutMicro =
						bet && bet.side === side ? bet.amountMicro * 2n : 0n;
					s.resolvePlayerBet(data.roundId, {
						outcomeSide: side,
						outcomeSum: sum,
						payoutMicro,
					});
				}

				// Server emits no `round_state` for RESULT — drive the transition from
				// the result payload so the PixiJS GameController reveals the dice face
				// and the canvas HUD shows the outcome pill. Client resets to betting
				// when the next round_state arrives.
				stopCountdown();
				s.setRoundState("RESULT");
			},
		);

		/* ── Balance update (authoritative, from operator wallet) ── */
		socket.on(
			"balance_update",
			(data: {
				balanceMicro?: string;
				currency?: string;
				change?: string;
				type?: string;
			}) => {
				if (!data) return;
				if (typeof data.balanceMicro === "string") {
					try {
						useGameStore.getState().setBalanceMicro(BigInt(data.balanceMicro));
					} catch {
						/* ignore malformed */
					}
				}
				if (data.currency) {
					useGameStore.getState().setConfig({ currency: data.currency });
				}
			},
		);

		/* ── Bet acknowledged ────────────────────────────────── */
		socket.on(
			"bet_placed",
			(_data: { roundId: string; side: BetSide; amountMicro: string }) => {
				// Local state is already set optimistically by placeBet; nothing to do
				// here beyond confirming the server accepted the bet. Could be surfaced
				// as a toast — left to the UI layer if wanted.
			},
		);

		/* ── Bet rejected ────────────────────────────────────── */
		socket.on("bet_rejected", (data: BetRejectedPayload) => {
			const s = useGameStore.getState();
			s.clearBet();
			// Drop the optimistic pending record for this round so the recent-bets
			// list doesn't get orphaned entries when the operator declines a bet.
			const roundId = data.roundId ?? s.roundId;
			if (roundId) {
				useGameStore.setState((state) => ({
					playerBets: state.playerBets.filter(
						(b) => !(b.roundId === roundId && b.status === "PENDING"),
					),
				}));
			}
			// Surface the reason via a shared event (lightweight — avoids another
			// store). The UI listens on `window` for 'ketapola:bet-rejected'.
			window.dispatchEvent(
				new CustomEvent("ketapola:bet-rejected", { detail: data }),
			);
		});

		/* ── Game config pushed from server ──────────────────── */
		socket.on(
			"game_config",
			(data: {
				minBetMicro?: string;
				maxBetMicro?: string;
				currency?: string;
			}) => {
				const s = useGameStore.getState();
				const patch: Parameters<typeof s.setConfig>[0] = {};
				try {
					if (data.minBetMicro) patch.minBetMicro = BigInt(data.minBetMicro);
					if (data.maxBetMicro) patch.maxBetMicro = BigInt(data.maxBetMicro);
				} catch {
					/* ignore */
				}
				if (data.currency) patch.currency = data.currency;
				s.setConfig(patch);
			},
		);

		/* ── Pause / resume ──────────────────────────────────── */
		socket.on("game_paused", () => useGameStore.getState().setPaused(true));
		socket.on("game_resumed", () => useGameStore.getState().setPaused(false));

		return () => {
			stopCountdown();
			socket.disconnect();
			socketRef.current = null;
			useGameStore.getState().setConnected(false);
		};
	}, [token]);

	return { placeBet };
}
