import { useCallback, useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { useSessionStore } from "../session/sessionStore";
import { type RpsHand, useRpsStore } from "./RpsStore";

const SOCKET_URL = (import.meta.env.VITE_RGS_SOCKET_URL ?? "").replace(/\/+$/, "");

function spanishReason(reason: string | undefined): string {
	switch (reason) {
		case "partida_cerrada":
			return "La partida ya cerro";
		case "partida_no_iniciada":
			return "La partida aun no inicia";
		case "tiempo_agotado":
			return "Se acabo el tiempo";
		case "no_es_tu_partida":
			return "Esta no es tu partida";
		case "jugador_no_registrado":
			return "No estas registrado";
		case "seleccion_invalida":
			return "Seleccion invalida";
		default:
			return "Accion rechazada";
	}
}

function isMockRpsMode(): boolean {
	if (typeof window === "undefined") return false;
	const value = new URLSearchParams(window.location.search).get("mockRps");
	return value === "1" || value === "true";
}

function nowPlus(ms: number): string {
	return new Date(Date.now() + ms).toISOString();
}

function mockChoiceForRound(round: number): RpsHand {
	return round === 1 ? "SCISSORS" : "ROCK";
}

function beats(choice: RpsHand, rival: RpsHand): "WIN" | "LOSS" | "TIE" {
	if (choice === rival) return "TIE";
	if (
		(choice === "ROCK" && rival === "SCISSORS") ||
		(choice === "PAPER" && rival === "ROCK") ||
		(choice === "SCISSORS" && rival === "PAPER")
	) {
		return "WIN";
	}
	return "LOSS";
}

function bootMockTournament(): void {
	const store = useRpsStore.getState();
	store.setConnected(true);
	store.setRegistration("mock-player", "mock-tournament");
	store.setChoice(null, false);
	store.setResult(null);
	store.setNotice("Torneo demo listo");
	store.applyTournamentState({
		tournamentId: "mock-tournament",
		title: "Torneo Piedra Papel Tijera",
		status: "RUNNING",
		message: "Modo demo local. Elige una jugada para avanzar.",
		currentRound: 1,
		scheduledStartAt: new Date().toISOString(),
		prizeTable: [
			{ rank: 1, amountMicro: "100000000" },
			{ rank: 2, amountMicro: "25000000" },
			{ rank: 3, amountMicro: "10000000" },
		],
		participants: [
			{ id: "mock-player", playerRef: "Tu", status: "ACTIVE", rank: null },
			{ id: "mock-rival-1", playerRef: "Rival Uno", status: "ACTIVE", rank: null },
			{ id: "mock-rival-2", playerRef: "Rival Dos", status: "ELIMINATED", rank: 4 },
			{ id: "mock-rival-3", playerRef: "Finalista", status: "ACTIVE", rank: null },
		],
		matches: [
			{
				id: "mock-match-1",
				roundNumber: 1,
				attemptNumber: 1,
				participantAId: "mock-player",
				participantBId: "mock-rival-1",
				winnerId: null,
				status: "OPEN",
				resultReason: null,
				startsAt: new Date().toISOString(),
				endsAt: nowPlus(12000),
				resolvedAt: null,
			},
			{
				id: "mock-match-2",
				roundNumber: 1,
				attemptNumber: 1,
				participantAId: "mock-rival-2",
				participantBId: "mock-rival-3",
				winnerId: "mock-rival-3",
				status: "RESOLVED",
				resultReason: "NORMAL",
				startsAt: new Date().toISOString(),
				endsAt: new Date().toISOString(),
				resolvedAt: new Date().toISOString(),
			},
		],
		awards: [],
	});
}

export function useRpsSocket(): { submitChoice: (choice: RpsHand) => void } {
	const token = useSessionStore((s) => s.token);
	const socketRef = useRef<Socket | null>(null);
	const mockRoundRef = useRef(1);
	const mockAttemptRef = useRef(1);
	const mockTimersRef = useRef<number[]>([]);

	const submitChoice = useCallback((choice: RpsHand) => {
		if (isMockRpsMode()) {
			const store = useRpsStore.getState();
			if (store.choicePending || !store.activeMatchId) return;
			const round = mockRoundRef.current;
			const matchId = store.activeMatchId;
			const opponentId = round === 1 ? "mock-rival-1" : "mock-rival-3";
			const rivalChoice = mockChoiceForRound(round);
			const outcome = beats(choice, rivalChoice);
			store.setChoice(choice, true);
			store.setNotice(`Rival eligio ${rivalChoice === "ROCK" ? "Piedra" : rivalChoice === "PAPER" ? "Papel" : "Tijera"}`);
			const timer = window.setTimeout(() => {
				const latest = useRpsStore.getState();
				const resolvedAt = new Date().toISOString();
				const resolvedMatches = latest.matches.map((match) =>
					match.id === matchId
						? {
								...match,
								status: "RESOLVED",
								winnerId: outcome === "WIN" ? "mock-player" : outcome === "LOSS" ? opponentId : null,
								resultReason: outcome === "TIE" ? "TIE" : "NORMAL",
								resolvedAt,
							}
						: match,
				);
				if (outcome === "TIE") {
					mockAttemptRef.current += 1;
					latest.setResult("TIE");
					latest.setChoice(null, false);
					latest.setNotice("Empate. Revancha inmediata.");
					latest.applyTournamentState({
						status: "RUNNING",
						matches: [
							...resolvedMatches,
							{
								id: `${matchId}-tie-${mockAttemptRef.current}`,
								roundNumber: round,
								attemptNumber: mockAttemptRef.current,
								participantAId: "mock-player",
								participantBId: round === 1 ? "mock-rival-1" : "mock-rival-3",
								winnerId: null,
								status: "OPEN",
								resultReason: null,
								startsAt: new Date().toISOString(),
								endsAt: nowPlus(12000),
								resolvedAt: null,
							},
						],
					});
					return;
				}
				if (outcome === "LOSS") {
					latest.setResult("LOSS");
					latest.setChoice(null, false);
					latest.applyTournamentState({
						status: "COMPLETED",
						message: round === 1 ? "El rival gano esta partida demo." : "Final demo terminada.",
						participants: latest.participants.map((participant) =>
							participant.id === "mock-player"
								? { ...participant, status: "ELIMINATED", rank: round === 1 ? 3 : 2 }
								: participant.id === (round === 1 ? "mock-rival-1" : "mock-rival-3")
									? { ...participant, status: "WINNER", rank: 1 }
									: participant,
						),
						matches: resolvedMatches,
					});
					return;
				}
				latest.setResult("WIN");
				latest.setChoice(null, false);
				if (round === 1) {
					mockRoundRef.current = 2;
					mockAttemptRef.current = 1;
					latest.setNotice("Ganaste. Final contra el ultimo rival.");
					latest.applyTournamentState({
						status: "RUNNING",
						message: "Final demo. Una jugada mas para ganar el premio.",
						currentRound: 2,
						participants: latest.participants.map((participant) =>
							participant.id === "mock-rival-1" ? { ...participant, status: "ELIMINATED", rank: 3 } : participant,
						),
						matches: [
							...resolvedMatches,
							{
								id: "mock-final",
								roundNumber: 2,
								attemptNumber: 1,
								participantAId: "mock-player",
								participantBId: "mock-rival-3",
								winnerId: null,
								status: "OPEN",
								resultReason: null,
								startsAt: new Date().toISOString(),
								endsAt: nowPlus(12000),
								resolvedAt: null,
							},
						],
					});
					return;
				}
				latest.setNotice("Premio acreditado: L1,000");
				latest.applyTournamentState({
					status: "COMPLETED",
					message: "Ganaste el torneo demo.",
					participants: latest.participants.map((participant) =>
						participant.id === "mock-player"
							? { ...participant, status: "WINNER", rank: 1 }
							: participant.id === "mock-rival-3"
								? { ...participant, status: "ELIMINATED", rank: 2 }
								: participant,
					),
					matches: resolvedMatches,
					awards: [
						{
							id: "mock-award-1",
							participantId: "mock-player",
							rank: 1,
							amountMicro: "100000000",
							status: "COMPLETED",
						},
					],
				});
			}, 850);
			mockTimersRef.current.push(timer);
			return;
		}
		const socket = socketRef.current;
		const store = useRpsStore.getState();
		if (!socket?.connected) {
			store.setNotice("Conectando al servidor");
			return;
		}
		if (!store.activeMatchId) {
			store.setNotice("Esperando oponente");
			return;
		}
		store.setChoice(choice, true);
		socket.emit(
			"rps_choice",
			{ matchId: store.activeMatchId, choice },
			(ack: { ok?: boolean; reason?: string }) => {
				const latest = useRpsStore.getState();
				if (ack?.ok) {
					latest.setChoice(choice, false);
					return;
				}
				latest.setChoice(null, false);
				latest.setNotice(spanishReason(ack?.reason));
			},
		);
	}, []);

	useEffect(() => {
		if (isMockRpsMode()) {
			bootMockTournament();
			return () => {
				for (const timer of mockTimersRef.current) window.clearTimeout(timer);
				mockTimersRef.current = [];
				useRpsStore.getState().setConnected(false);
			};
		}
		if (!token) return;
		const socketOptions = {
			auth: { token },
			transports: ["websocket", "polling"],
			reconnection: true,
			reconnectionAttempts: Infinity,
			reconnectionDelay: 1000,
			reconnectionDelayMax: 5000,
		};
		const socket = SOCKET_URL ? io(SOCKET_URL, socketOptions) : io(socketOptions);
		socketRef.current = socket;

		socket.on("connect", () => useRpsStore.getState().setConnected(true));
		socket.on("disconnect", () => useRpsStore.getState().setConnected(false));
		socket.on("rps_registration_update", (payload: { participantId?: string; tournamentId?: string }) => {
			useRpsStore.getState().setRegistration(payload.participantId ?? null, payload.tournamentId ?? null);
		});
		socket.on("rps_tournament_state", (payload: Record<string, unknown>) => {
			useRpsStore.getState().applyTournamentState(payload as never);
		});
		socket.on("rps_bracket_update", (payload: Record<string, unknown>) => {
			if (Array.isArray(payload.matches)) useRpsStore.getState().applyTournamentState(payload as never);
		});
		socket.on("rps_match_start", () => {
			const s = useRpsStore.getState();
			s.setChoice(null, false);
			s.setResult(null);
		});
		socket.on("rps_match_result", (payload: { winnerId?: string | null; loserId?: string | null; result?: string }) => {
			const s = useRpsStore.getState();
			if (payload.result === "TIE") {
				s.setResult("TIE");
				s.setNotice("Empate. Juegan otra vez.");
				s.setChoice(null, false);
				return;
			}
			if (payload.winnerId === s.participantId) s.setResult("WIN");
			if (payload.loserId === s.participantId) s.setResult("LOSS");
			s.setChoice(null, false);
		});
		socket.on("rps_prize_awarded", (payload: { amountMicro?: string }) => {
			useRpsStore.getState().setNotice(`Premio acreditado: ${payload.amountMicro ?? ""}`);
		});
		socket.on("rps_tournament_complete", () => {
			useRpsStore.getState().setChoice(null, false);
		});

		return () => {
			socket.disconnect();
			socketRef.current = null;
			useRpsStore.getState().setConnected(false);
		};
	}, [token]);

	return { submitChoice };
}
