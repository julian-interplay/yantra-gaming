import { type RngContext, roundHmac } from "@yantra/rng-core";
import type { LempiCrashConfig } from "./config";

export const RNG_VERSION = "lempi-crash-rng-v1" as const;

export interface LempiCrashOutcomeData {
	crashMultiplier: number;
	u: number;
}

export function determineLempiCrashOutcome(
	ctx: RngContext,
	config: Pick<LempiCrashConfig, "houseEdge" | "maxMultiplier">,
): LempiCrashOutcomeData {
	if (config.houseEdge < 0 || config.houseEdge >= 1) {
		throw new Error(`houseEdge must be in [0, 1), got ${config.houseEdge}`);
	}
	if (config.maxMultiplier < 1.01) {
		throw new Error(
			`maxMultiplier must be >= 1.01, got ${config.maxMultiplier}`,
		);
	}

	const hmac = roundHmac(ctx);
	const bits52 = BigInt(`0x${hmac.slice(0, 13)}`);
	const max = 1n << 52n;
	const uRaw = Number(bits52) / Number(max);

	if (uRaw < config.houseEdge) {
		return { crashMultiplier: 1.0, u: uRaw };
	}

	const u = (uRaw - config.houseEdge) / (1 - config.houseEdge);
	const rawMultiplier = Math.floor(100 / (1 - u)) / 100;
	const crashMultiplier = Math.min(
		Math.max(1.0, rawMultiplier),
		config.maxMultiplier,
	);
	return { crashMultiplier, u: uRaw };
}

export function multiplierAtElapsedMs(
	elapsedMs: number,
	config: Pick<LempiCrashConfig, "multiplierGrowthRate" | "maxMultiplier">,
): number {
	const raw = Math.exp(Math.max(0, elapsedMs) * config.multiplierGrowthRate);
	return Math.min(
		config.maxMultiplier,
		Math.max(1, Math.floor(raw * 100) / 100),
	);
}

export function elapsedMsForMultiplier(
	multiplier: number,
	config: Pick<
		LempiCrashConfig,
		"multiplierGrowthRate" | "minFlightMs" | "maxFlightMs"
	>,
): number {
	if (multiplier <= 1) return config.minFlightMs;
	const elapsed = Math.ceil(Math.log(multiplier) / config.multiplierGrowthRate);
	return Math.max(config.minFlightMs, Math.min(config.maxFlightMs, elapsed));
}

export function verifyLempiCrashOutcome(
	ctx: RngContext,
	config: LempiCrashConfig,
	claimed: LempiCrashOutcomeData,
): boolean {
	const recomputed = determineLempiCrashOutcome(ctx, config);
	return (
		Math.abs(recomputed.crashMultiplier - claimed.crashMultiplier) < 1e-9 &&
		Math.abs(recomputed.u - claimed.u) < 1e-12
	);
}
