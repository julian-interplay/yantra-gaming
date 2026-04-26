import type { GamePlugin, RngContext } from "@yantra/game-contract";
import {
	defaultLempiCrashConfig,
	type LempiCrashConfig,
	lempiCrashConfigSchema,
} from "./config";
import {
	determineLempiCrashOutcome,
	elapsedMsForMultiplier,
	type LempiCrashOutcomeData,
	multiplierAtElapsedMs,
	RNG_VERSION,
	verifyLempiCrashOutcome,
} from "./outcome";
import {
	type LempiCrashSelection,
	lempiCrashSelectionSchema,
} from "./selection";
import { settleLempiCrashBet, settleLempiCrashCashout } from "./settle";

type LempiCrashWireOutcome = LempiCrashOutcomeData & { type: "CRASH" };

const plugin: GamePlugin<
	LempiCrashSelection,
	LempiCrashWireOutcome,
	LempiCrashConfig
> = {
	gameCode: "lempi-crash",
	displayName: "Lempi Crash",
	cert: {
		rngVersion: RNG_VERSION,
		gliCategory: "GLI-11",
		mathVersion: "0.1.0",
		parSheetSha256: "",
	},
	selectionSchema: lempiCrashSelectionSchema,
	configSchema: lempiCrashConfigSchema,
	defaultConfig: defaultLempiCrashConfig,
	sampleSelection: { slotId: "A", autoCashoutMultiplier: 2.0 },

	computeOutcome(
		ctx: RngContext,
		config: LempiCrashConfig,
	): LempiCrashWireOutcome {
		return { type: "CRASH", ...determineLempiCrashOutcome(ctx, config) };
	},

	verifyOutcome(
		ctx: RngContext,
		config: LempiCrashConfig,
		claimed: LempiCrashWireOutcome,
	): boolean {
		return verifyLempiCrashOutcome(ctx, config, claimed);
	},

	settleBet({ selection, amountMicro, outcome, config, commissionMicro }) {
		return settleLempiCrashBet({
			selection,
			amountMicro,
			outcome,
			config,
			commissionMicro,
		});
	},

	outcomeForWire(outcome: LempiCrashWireOutcome) {
		return { outcomeType: "CRASH", outcome };
	},

	liveCrash: {
		multiplierAtElapsedMs,
		elapsedMsForMultiplier,
		slotId: (selection) => selection.slotId,
		autoCashoutMultiplier: (selection) =>
			selection.autoCashoutMultiplier ?? null,
		settleCashout: ({
			selection,
			amountMicro,
			cashoutMultiplier,
			commissionMicro,
		}) =>
			settleLempiCrashCashout({
				selection,
				amountMicro,
				cashoutMultiplier,
				commissionMicro,
			}),
	},
};

export default plugin;
export {
	determineLempiCrashOutcome,
	elapsedMsForMultiplier,
	type LempiCrashOutcomeData,
	multiplierAtElapsedMs,
	RNG_VERSION,
	verifyLempiCrashOutcome,
} from "./outcome";
