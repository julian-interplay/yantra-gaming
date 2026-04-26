import { describe, expect, it } from "bun:test";
import vectors from "../../../games/lempi-crash/fixtures/rng-test-vectors.json";
import { determineLempiCrashOutcome } from "../../../games/lempi-crash/src/outcome";

describe("Lempi Crash — RNG test vectors", () => {
	for (const [index, vector] of vectors.entries()) {
		it(`matches vector #${index + 1}`, () => {
			const outcome = determineLempiCrashOutcome(
				{
					serverSeed: vector.serverSeed,
					clientSeed: vector.clientSeed,
					nonce: vector.nonce,
				},
				vector.config,
			);
			expect(outcome.crashMultiplier).toBe(vector.outcome.crashMultiplier);
			expect(outcome.u).toBe(vector.outcome.u);
		});
	}
});
