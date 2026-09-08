import { describe, expect, it } from "bun:test";
import {
	hnlToMicro,
	normalisePrizeTable,
	resolveRpsChoice,
} from "../../../apps/rgs-server/src/services/rpsRules";

describe("rps tournament rules", () => {
	it("resolves rock paper scissors choices", () => {
		expect(resolveRpsChoice("ROCK", "SCISSORS")).toEqual({
			winner: "A",
			reason: "CHOICE",
		});
		expect(resolveRpsChoice("PAPER", "SCISSORS")).toEqual({
			winner: "B",
			reason: "CHOICE",
		});
		expect(resolveRpsChoice("PAPER", "PAPER")).toEqual({
			winner: "TIE",
			reason: "TIE",
		});
	});

	it("turns missing choices into timeout results", () => {
		expect(resolveRpsChoice("ROCK", null)).toEqual({
			winner: "A",
			reason: "B_TIMEOUT",
		});
		expect(resolveRpsChoice(null, "PAPER")).toEqual({
			winner: "B",
			reason: "A_TIMEOUT",
		});
		expect(resolveRpsChoice(null, null)).toEqual({
			winner: "TIE",
			reason: "DOUBLE_TIMEOUT",
		});
	});

	it("normalises fixed HNL prize tables", () => {
		expect(
			normalisePrizeTable([
				{ rank: 3, amountMicro: "10000000" },
				{ rank: 1, amountMicro: "100000000" },
				{ rank: 0, amountMicro: "1" },
				{ rank: 2, amountMicro: "-1" },
			]),
		).toEqual([
			{ rank: 1, amountMicro: "100000000" },
			{ rank: 3, amountMicro: "10000000" },
		]);
	});

	it("converts HNL to micro units", () => {
		expect(hnlToMicro("1000").toString()).toBe("100000000");
		expect(hnlToMicro("12.50").toString()).toBe("1250000");
	});
});
