import { z } from "zod";

export const lempiCrashConfigSchema = z
	.object({
		houseEdge: z.number().min(0).lt(1),
		maxMultiplier: z.number().min(1.01),
		multiplierGrowthRate: z.number().positive(),
		minFlightMs: z.number().int().min(0),
		maxFlightMs: z.number().int().min(1_000),
		botCashoutsEnabled: z.boolean().default(true),
	})
	.strict();

export type LempiCrashConfig = z.infer<typeof lempiCrashConfigSchema>;

export const defaultLempiCrashConfig: LempiCrashConfig = {
	houseEdge: 0.01,
	maxMultiplier: 1000,
	multiplierGrowthRate: 0.00011,
	minFlightMs: 700,
	maxFlightMs: 120_000,
	botCashoutsEnabled: true,
};
