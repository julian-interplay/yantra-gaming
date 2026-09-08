import { create } from "zustand";

export type RpsHand = "ROCK" | "PAPER" | "SCISSORS";
export type RpsTournamentStatus =
	| "NO_EVENT"
	| "DRAFT"
	| "SCHEDULED"
	| "REGISTERING"
	| "RUNNING"
	| "SETTLING"
	| "COMPLETED"
	| "CANCELLED";

export interface RpsParticipant {
	id: string;
	playerRef: string;
	status: string;
	rank: number | null;
}

export interface RpsMatch {
	id: string;
	roundNumber: number;
	attemptNumber: number;
	participantAId: string | null;
	participantBId: string | null;
	winnerId: string | null;
	status: string;
	resultReason: string | null;
	startsAt: string;
	endsAt: string;
	resolvedAt: string | null;
}

export interface RpsPrizeRow {
	rank: number;
	amountMicro: string;
}

export interface RpsAward {
	id: string;
	participantId: string;
	rank: number;
	amountMicro: string;
	status: string;
}

export interface RpsState {
	isConnected: boolean;
	participantId: string | null;
	tournamentId: string | null;
	title: string;
	status: RpsTournamentStatus;
	message: string | null;
	currentRound: number;
	scheduledStartAt: string | null;
	prizeTable: RpsPrizeRow[];
	participants: RpsParticipant[];
	matches: RpsMatch[];
	awards: RpsAward[];
	activeMatchId: string | null;
	selectedChoice: RpsHand | null;
	choicePending: boolean;
	notice: string | null;
	lastResult: "WIN" | "LOSS" | "TIE" | null;
	setConnected: (isConnected: boolean) => void;
	setRegistration: (participantId: string | null, tournamentId: string | null) => void;
	applyTournamentState: (payload: Partial<RpsState> & { status?: string }) => void;
	setChoice: (choice: RpsHand | null, pending?: boolean) => void;
	setNotice: (notice: string | null) => void;
	setResult: (result: RpsState["lastResult"]) => void;
}

export const useRpsStore = create<RpsState>()((set, get) => ({
	isConnected: false,
	participantId: null,
	tournamentId: null,
	title: "Piedra, Papel o Tijera",
	status: "NO_EVENT",
	message: null,
	currentRound: 0,
	scheduledStartAt: null,
	prizeTable: [],
	participants: [],
	matches: [],
	awards: [],
	activeMatchId: null,
	selectedChoice: null,
	choicePending: false,
	notice: null,
	lastResult: null,
	setConnected: (isConnected) => set({ isConnected }),
	setRegistration: (participantId, tournamentId) => set({ participantId, tournamentId }),
	applyTournamentState: (payload) => {
		const participantId = get().participantId;
		const matches = (payload.matches ?? get().matches) as RpsMatch[];
		const activeMatch =
			participantId == null
				? null
				: matches.find(
						(m) =>
							m.status === "OPEN" &&
							(m.participantAId === participantId || m.participantBId === participantId),
					);
		set({
			...(payload as Partial<RpsState>),
			status: (payload.status as RpsTournamentStatus | undefined) ?? get().status,
			activeMatchId: activeMatch?.id ?? null,
		});
	},
	setChoice: (selectedChoice, choicePending = false) => set({ selectedChoice, choicePending }),
	setNotice: (notice) => set({ notice }),
	setResult: (lastResult) => set({ lastResult }),
}));

export function formatHnl(micro: string | bigint): string {
	const value = typeof micro === "bigint" ? micro : BigInt(micro || "0");
	const units = Number(value) / 100_000;
	return `L${units.toLocaleString("es-HN", {
		minimumFractionDigits: units % 1 === 0 ? 0 : 2,
		maximumFractionDigits: 2,
	})}`;
}

export function handLabel(hand: RpsHand): string {
	switch (hand) {
		case "ROCK":
			return "Piedra";
		case "PAPER":
			return "Papel";
		case "SCISSORS":
			return "Tijera";
	}
}
