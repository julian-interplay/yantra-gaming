import { z } from "zod";

export const lempiCrashSelectionSchema = z
	.object({
		slotId: z.enum(["A", "B"]),
		autoCashoutMultiplier: z.number().min(1.01).max(10_000).optional(),
	})
	.strict();

export type LempiCrashSelection = z.infer<typeof lempiCrashSelectionSchema>;
