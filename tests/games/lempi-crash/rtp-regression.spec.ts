import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import { defaultLempiCrashConfig } from "../../../games/lempi-crash/src/config";
import {
	determineLempiCrashOutcome,
	elapsedMsForMultiplier,
	multiplierAtElapsedMs,
} from "../../../games/lempi-crash/src/outcome";
import {
	settleLempiCrashBet,
	settleLempiCrashCashout,
} from "../../../games/lempi-crash/src/settle";

const FULL_RUN = process.env.RTP_REGRESSION_FULL === "1";
const ITERATIONS = FULL_RUN ? 5_000_000 : 500_000;
const RTP_TOLERANCE = 0.015;

function simulate(cashoutMultiplier: number): number {
	const serverSeed = crypto.randomBytes(32).toString("hex");
	const clientSeed = crypto.randomBytes(16).toString("hex");
	const stake = 100_000n;
	const hundredths = BigInt(Math.round(cashoutMultiplier * 100));
	let paidOut = 0n;
	for (let nonce = 0; nonce < ITERATIONS; nonce++) {
		const outcome = determineLempiCrashOutcome(
			{ serverSeed, clientSeed, nonce },
			defaultLempiCrashConfig,
		);
		if (outcome.crashMultiplier >= cashoutMultiplier) {
			paidOut += (stake * hundredths) / 100n;
		}
	}
	return Number(paidOut) / Number(stake * BigInt(ITERATIONS));
}

describe(`Lempi Crash — RTP regression (${FULL_RUN ? "5M" : "500K"} rounds)`, () => {
	for (const cashout of [1.5, 2, 5, 20]) {
		it(`cashout ${cashout}x converges to 99% RTP`, () => {
			expect(Math.abs(simulate(cashout) - 0.99)).toBeLessThan(RTP_TOLERANCE);
		});
	}
});

describe("Lempi Crash — live cashout math", () => {
	it("manual cashout pays stake times current multiplier", () => {
		const result = settleLempiCrashCashout({
			selection: { slotId: "A" },
			amountMicro: 1_000_000n,
			cashoutMultiplier: 2.25,
			commissionMicro: 0n,
		});
		expect(result.won).toBe(true);
		expect(result.payoutMicro).toBe(2_250_000n);
	});

	it("auto cashout wins only when crash reaches target", () => {
		const win = settleLempiCrashBet({
			selection: { slotId: "A", autoCashoutMultiplier: 2 },
			amountMicro: 1_000_000n,
			outcome: { crashMultiplier: 2.01, u: 0.5 },
			config: defaultLempiCrashConfig,
			commissionMicro: 0n,
		});
		const loss = settleLempiCrashBet({
			selection: { slotId: "B", autoCashoutMultiplier: 2 },
			amountMicro: 1_000_000n,
			outcome: { crashMultiplier: 1.99, u: 0.5 },
			config: defaultLempiCrashConfig,
			commissionMicro: 0n,
		});
		expect(win.payoutMicro).toBe(2_000_000n);
		expect(loss.won).toBe(false);
	});

	it("flight curve round-trips multiplier to elapsed time", () => {
		const elapsed = elapsedMsForMultiplier(2, defaultLempiCrashConfig);
		const multiplier = multiplierAtElapsedMs(elapsed, defaultLempiCrashConfig);
		expect(multiplier).toBeGreaterThanOrEqual(2);
		expect(multiplier).toBeLessThan(2.02);
	});
});
