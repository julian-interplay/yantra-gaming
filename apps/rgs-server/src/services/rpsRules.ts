export type RpsHand = "ROCK" | "PAPER" | "SCISSORS";

export interface RpsChoiceResult {
	winner: "A" | "B" | "TIE";
	reason: "CHOICE" | "A_TIMEOUT" | "B_TIMEOUT" | "DOUBLE_TIMEOUT" | "TIE";
}

export function resolveRpsChoice(
	aChoice: RpsHand | null,
	bChoice: RpsHand | null,
): RpsChoiceResult {
	if (aChoice && !bChoice) return { winner: "A", reason: "B_TIMEOUT" };
	if (!aChoice && bChoice) return { winner: "B", reason: "A_TIMEOUT" };
	if (!aChoice && !bChoice) return { winner: "TIE", reason: "DOUBLE_TIMEOUT" };
	if (aChoice === bChoice) return { winner: "TIE", reason: "TIE" };
	if (
		(aChoice === "ROCK" && bChoice === "SCISSORS") ||
		(aChoice === "PAPER" && bChoice === "ROCK") ||
		(aChoice === "SCISSORS" && bChoice === "PAPER")
	) {
		return { winner: "A", reason: "CHOICE" };
	}
	return { winner: "B", reason: "CHOICE" };
}

export function normalisePrizeTable(input: unknown): Array<{ rank: number; amountMicro: string }> {
	if (!Array.isArray(input)) return [];
	return input
		.map((row) => {
			if (typeof row !== "object" || row === null) return null;
			const r = row as Record<string, unknown>;
			const rank = Number(r.rank);
			const amountRaw = r.amountMicro;
			if (!Number.isInteger(rank) || rank < 1) return null;
			try {
				const amount = BigInt(String(amountRaw));
				if (amount < 0n) return null;
				return { rank, amountMicro: amount.toString() };
			} catch {
				return null;
			}
		})
		.filter((row): row is { rank: number; amountMicro: string } => row != null)
		.sort((a, b) => a.rank - b.rank);
}

export function hnlToMicro(value: string | number): bigint {
	if (typeof value === "number") return BigInt(Math.round(value * 100_000));
	const [intPart = "0", fracRaw = ""] = value.trim().split(".");
	const safeInt = intPart.replace(/[^\d]/g, "") || "0";
	const frac = `${fracRaw.replace(/[^\d]/g, "")}00000`.slice(0, 5);
	return BigInt(safeInt) * 100_000n + BigInt(frac);
}
