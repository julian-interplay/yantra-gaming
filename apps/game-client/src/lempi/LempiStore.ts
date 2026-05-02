import { create } from "zustand";

export type LempiRoundState =
	| "WAITING"
	| "BETTING_OPEN"
	| "ROLLING"
	| "RESULT"
	| "COOLDOWN";
export type LempiSlotId = "A" | "B";
export type LempiSlotStatus =
	| "IDLE"
	| "PENDING"
	| "ACTIVE"
	| "CASHED_OUT"
	| "LOST";

export interface LempiBetSlot {
	slotId: LempiSlotId;
	amountMicro: bigint;
	autoCashoutMultiplier: number | null;
	betId: string | null;
	status: LempiSlotStatus;
	cashoutMultiplier: number | null;
	payoutMicro: bigint | null;
}

export interface LempiToast {
	id: string;
	playerRef: string;
	multiplier: number;
	payoutMicro: bigint;
}

export interface LempiPoolPlayer {
	betId: string;
	playerRef: string;
	amountMicro: bigint;
	cashoutMultiplier: number | null;
	winMicro: bigint | null;
}

export interface LempiBetHistoryEntry {
	id: string;
	betId: string;
	roundId: string;
	roundNumber: number;
	slotId: LempiSlotId;
	amountMicro: bigint;
	crashMultiplier: number;
	cashoutMultiplier: number | null;
	payoutMicro: bigint | null;
	result: "WIN" | "LOSS";
}

export interface LempiState {
	roundId: string | null;
	roundNumber: number;
	roundState: LempiRoundState;
	timeRemaining: number;
	multiplier: number;
	crashMultiplier: number | null;
	balanceMicro: bigint;
	currency: string;
	minBetMicro: bigint;
	maxBetMicro: bigint;
	bettingWindowMs: number;
	maxMultiplier: number;
	slots: Record<LempiSlotId, LempiBetSlot>;
	toasts: LempiToast[];
	poolPlayers: LempiPoolPlayer[];
	betHistory: LempiBetHistoryEntry[];
	connectedPlayerCount: number;
	acceptedCount: number;
	cashedOutCount: number;
	totalStakeMicro: bigint;
	totalWinMicro: bigint;
	isConnected: boolean;
	hasInitialBalanceResponse: boolean;

	setConnected: (connected: boolean) => void;
	setConfig: (
		patch: Partial<
			Pick<
				LempiState,
				| "currency"
				| "minBetMicro"
				| "maxBetMicro"
				| "bettingWindowMs"
				| "maxMultiplier"
			>
		>,
	) => void;
	setRoundState: (state: LempiRoundState) => void;
	setRoundInfo: (
		roundId: string,
		roundNumber: number,
		timeRemaining: number,
	) => void;
	setMultiplier: (multiplier: number) => void;
	setCrashResult: (multiplier: number) => void;
	setBalanceMicro: (amount: bigint) => void;
	setInitialBalanceResponse: (received: boolean) => void;
	setSlot: (slotId: LempiSlotId, patch: Partial<LempiBetSlot>) => void;
	resetSlotsForRound: () => void;
	addToast: (toast: Omit<LempiToast, "id">) => void;
	hydrateBetHistory: (entries: LempiBetHistoryEntry[]) => void;
	addBetHistory: (entries: LempiBetHistoryEntry[]) => void;
	setPresence: (connectedPlayerCount: number) => void;
	setPool: (payload: {
		acceptedCount: number;
		cashedOutCount: number;
		totalStakeMicro: bigint;
		totalWinMicro: bigint;
		players: LempiPoolPlayer[];
	}) => void;
}

function mergeHistory(
	current: LempiBetHistoryEntry[],
	incoming: LempiBetHistoryEntry[],
): LempiBetHistoryEntry[] {
	const merged: LempiBetHistoryEntry[] = [];
	const positions = new Map<string, number>();
	for (const entry of [...current, ...incoming]) {
		const key = entry.betId || entry.id;
		const existing = positions.get(key);
		if (existing != null) {
			merged[existing] = entry;
			continue;
		}
		positions.set(key, merged.length);
		merged.push(entry);
	}
	return merged.slice(-40);
}

const makeSlot = (slotId: LempiSlotId): LempiBetSlot => ({
	slotId,
	amountMicro: 1_000_000n,
	autoCashoutMultiplier: null,
	betId: null,
	status: "IDLE",
	cashoutMultiplier: null,
	payoutMicro: null,
});

export const useLempiStore = create<LempiState>()((set) => ({
	roundId: null,
	roundNumber: 0,
	roundState: "WAITING",
	timeRemaining: 0,
	multiplier: 1,
	crashMultiplier: null,
	balanceMicro: 0n,
	currency: "HNL",
	minBetMicro: 1_000_000n,
	maxBetMicro: 10_000_000_000n,
	bettingWindowMs: 8_000,
	maxMultiplier: 1000,
	slots: { A: makeSlot("A"), B: makeSlot("B") },
	toasts: [],
	poolPlayers: [],
	betHistory: [],
	connectedPlayerCount: 0,
	acceptedCount: 0,
	cashedOutCount: 0,
	totalStakeMicro: 0n,
	totalWinMicro: 0n,
	isConnected: false,
	hasInitialBalanceResponse: false,

	setConnected: (connected) => set({ isConnected: connected }),
	setConfig: (patch) => set((state) => ({ ...state, ...patch })),
	setRoundState: (roundState) => set({ roundState }),
	setRoundInfo: (roundId, roundNumber, timeRemaining) =>
		set({ roundId, roundNumber, timeRemaining }),
	setMultiplier: (multiplier) => set({ multiplier }),
	setCrashResult: (crashMultiplier) =>
		set({ crashMultiplier, multiplier: crashMultiplier }),
	setBalanceMicro: (balanceMicro) =>
		set({ balanceMicro, hasInitialBalanceResponse: true }),
	setInitialBalanceResponse: (hasInitialBalanceResponse) =>
		set({ hasInitialBalanceResponse }),
	setSlot: (slotId, patch) =>
		set((state) => ({
			slots: {
				...state.slots,
				[slotId]: { ...state.slots[slotId], ...patch },
			},
		})),
	resetSlotsForRound: () =>
		set((state) => ({
			multiplier: 1,
			crashMultiplier: null,
			slots: {
				A: {
					...makeSlot("A"),
					amountMicro: state.slots.A.amountMicro,
					autoCashoutMultiplier: state.slots.A.autoCashoutMultiplier,
				},
				B: {
					...makeSlot("B"),
					amountMicro: state.slots.B.amountMicro,
					autoCashoutMultiplier: state.slots.B.autoCashoutMultiplier,
				},
			},
			toasts: [],
			poolPlayers: [],
			acceptedCount: 0,
			cashedOutCount: 0,
			totalStakeMicro: 0n,
			totalWinMicro: 0n,
		})),
	addToast: (toast) =>
		set((state) => ({
			toasts: [
				...state.toasts.slice(-5),
				{
					...toast,
					id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
				},
			],
		})),
	hydrateBetHistory: (entries) =>
		set((state) => ({
			betHistory: mergeHistory(entries, state.betHistory),
		})),
	addBetHistory: (entries) =>
		set((state) => ({
			betHistory: mergeHistory(state.betHistory, entries),
		})),
	setPresence: (connectedPlayerCount) => set({ connectedPlayerCount }),
	setPool: (payload) => set(payload),
}));

export const MICRO_PER_UNIT = 100_000n;

export function hnlToMicro(value: string): bigint {
	const [intPart = "0", fracRaw = ""] = value.trim().split(".");
	const safeInt = intPart.replace(/[^\d]/g, "") || "0";
	const frac = `${fracRaw.replace(/[^\d]/g, "")}00000`.slice(0, 5);
	return BigInt(safeInt) * MICRO_PER_UNIT + BigInt(frac);
}

export function formatHnl(micro: bigint, withCurrency = false): string {
	const units = Number(micro) / Number(MICRO_PER_UNIT);
	const formatted = units.toLocaleString("en-HN", {
		minimumFractionDigits: units % 1 === 0 ? 0 : 2,
		maximumFractionDigits: 2,
	});
	return withCurrency ? `L${formatted}` : formatted;
}
