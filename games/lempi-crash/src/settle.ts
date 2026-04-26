import type { SettlementResult } from "@yantra/game-contract";
import type { LempiCrashConfig } from "./config";
import type { LempiCrashOutcomeData } from "./outcome";
import type { LempiCrashSelection } from "./selection";

function payoutAtMultiplier(
	amountMicro: bigint,
	multiplier: number,
	commissionMicro: bigint,
): bigint {
	const hundredths = BigInt(Math.round(multiplier * 100));
	const gross = (amountMicro * hundredths) / 100n;
	return gross > commissionMicro ? gross - commissionMicro : 0n;
}

export function settleLempiCrashBet(args: {
	selection: LempiCrashSelection;
	amountMicro: bigint;
	outcome: LempiCrashOutcomeData;
	config: LempiCrashConfig;
	commissionMicro: bigint;
}): SettlementResult {
	const { selection, amountMicro, outcome, commissionMicro } = args;
	const target = selection.autoCashoutMultiplier;
	if (target == null || outcome.crashMultiplier < target) {
		return { won: false, payoutMicro: 0n };
	}

	const payoutMicro = payoutAtMultiplier(amountMicro, target, commissionMicro);
	return {
		won: true,
		payoutMicro,
		winMeta: {
			slotId: selection.slotId,
			cashoutMode: "AUTO",
			cashoutMultiplier: target,
			crashMultiplier: outcome.crashMultiplier,
		},
	};
}

export function settleLempiCrashCashout(args: {
	selection: LempiCrashSelection;
	amountMicro: bigint;
	cashoutMultiplier: number;
	commissionMicro: bigint;
}): SettlementResult {
	const payoutMicro = payoutAtMultiplier(
		args.amountMicro,
		args.cashoutMultiplier,
		args.commissionMicro,
	);
	return {
		won: true,
		payoutMicro,
		winMeta: {
			slotId: args.selection.slotId,
			cashoutMode: "MANUAL",
			cashoutMultiplier: args.cashoutMultiplier,
		},
	};
}
