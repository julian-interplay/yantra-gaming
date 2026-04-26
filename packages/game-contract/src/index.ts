import type { z } from "zod";

/**
 * GamePlugin — the seam between the Yantra Engine core and individual game
 * modules. Each game (dice, crash, slots, ...) implements this interface and
 * registers itself via apps/rgs-server/src/games/registry.ts. The core engine
 * owns the round state machine, wallet orchestration, RG limits, and audit
 * ledger; the plugin owns outcome math, bet selection, settlement, and wire
 * encoding.
 *
 * Pattern: Stake Engine math SDK / Hacksaw OpenRGS plugin contract.
 */

export interface RngContext {
	serverSeed: string;
	clientSeed: string;
	nonce: number;
}

export interface DiceOutcome {
	type: "DICE";
	diceValues: number[];
	outcomeSum: number;
	outcomeSide: "LOW" | "HIGH";
}

export interface CrashOutcome {
	type: "CRASH";
	/** Two-decimal crash multiplier (e.g. 2.57). 1.00 = instant bust, 1000.00 = the ceiling. */
	crashMultiplier: number;
	/** Uniform[0,1) sample used to derive the multiplier — surfaced for verifier transparency. */
	u: number;
}

/**
 * Multi-event outcome for games with compound rounds — slot-style free-spin
 * features, bonus buys, hold-and-spin, cascading reels, jackpots.
 *
 * The `events` array is ordered; each event carries its own deterministic
 * sub-outcome derived from the same `(serverSeed, clientSeed, nonce)` triple
 * (typically by bumping `nonce` per sub-event, or by deriving sub-seeds from
 * the primary HMAC — the plugin decides and documents in its RNG spec).
 *
 * Example shape for a 5-spin free-spin feature after a base-game trigger:
 *
 *   {
 *     type: 'MULTI',
 *     baseGame: { ... },
 *     events: [
 *       { type: 'FREE_SPIN', spinIndex: 1, payoutMicro: '0',     subOutcome: {...} },
 *       { type: 'FREE_SPIN', spinIndex: 2, payoutMicro: '150000', subOutcome: {...} },
 *       ...
 *     ],
 *     featurePurchased: false,
 *     jackpotContributionMicro: '0',
 *   }
 *
 * The engine pays once per round via `settleBet`; the per-event payout split
 * is for audit / replay / operator-reporting, not a separate wallet call.
 */
export interface MultiEventOutcome {
	type: "MULTI";
	/** Primary-game sub-outcome (e.g. the triggering spin). */
	baseGame: unknown;
	/** Ordered feature events emitted during the round. Each plugin-defined. */
	events: Array<{
		/** Event type tag — plugin-defined (e.g. 'FREE_SPIN', 'HOLD_AND_SPIN', 'FEATURE_BUY'). */
		type: string;
		/** Plugin-specific sub-outcome for this event. */
		subOutcome: unknown;
		/** Payout contributed by this event (micro-units, as a decimal string). */
		payoutMicro?: string;
		[extraKey: string]: unknown;
	}>;
	/** True if the round was triggered by a feature-buy bet, not a natural trigger. */
	featurePurchased?: boolean;
	/** Contribution to a shared jackpot pool this round (micro-units). */
	jackpotContributionMicro?: string;
}

// Grows as new games land. Each game adds its own variant to the discriminated
// union so the core can persist + ship outcomes without knowing the game's
// math. `MultiEventOutcome` is the convention for games that emit compound
// rounds (slots with free-spins, bonus buys, hold-and-spin, cascades).
export type GameOutcome = DiceOutcome | CrashOutcome | MultiEventOutcome;

export type BetSelection = unknown;

export type GameMathConfig = Record<string, unknown>;

export interface SettlementRequest {
	selection: BetSelection;
	amountMicro: bigint;
	outcome: GameOutcome;
	config: GameMathConfig;
	commissionMicro: bigint;
}

export interface SettlementResult {
	won: boolean;
	/** Gross payout to credit to the player (0 if lost). */
	payoutMicro: bigint;
	/** Optional per-game context attached to the wallet WIN call. */
	winMeta?: Record<string, unknown>;
}

export interface LiveCrashSupport<
	TSelection = BetSelection,
	TConfig extends GameMathConfig = GameMathConfig,
> {
	/** Returns the displayed two-decimal multiplier at elapsed flight time. */
	multiplierAtElapsedMs(elapsedMs: number, config: TConfig): number;
	/** Returns the elapsed flight time at which the multiplier reaches `multiplier`. */
	elapsedMsForMultiplier(multiplier: number, config: TConfig): number;
	/** Pulls a client slot identifier out of a live-crash selection. */
	slotId(selection: TSelection): string | null;
	/** Pulls the optional auto-cashout multiplier out of a live-crash selection. */
	autoCashoutMultiplier(selection: TSelection): number | null;
	/** Computes payout for an already-authorised live cashout. */
	settleCashout(req: {
		selection: TSelection;
		amountMicro: bigint;
		cashoutMultiplier: number;
		config: TConfig;
		commissionMicro: bigint;
	}): SettlementResult;
}

export interface CertAttestation {
	/** e.g. 'ketapola-rng-v1' — stamped on every Round row. */
	rngVersion: string;
	/** e.g. 'GLI-19', 'GLI-11'. */
	gliCategory: string;
	/** Semver of the game's math. Bumped on any payout/RTP change. */
	mathVersion: string;
	/** SHA-256 of the shipped par-sheet.json at build time. */
	parSheetSha256: string;
}

export interface WireOutcome {
	outcomeType: string;
	outcome: unknown;
}

export interface GamePlugin<
	TSelection = BetSelection,
	TOutcome extends GameOutcome = GameOutcome,
	TConfig extends GameMathConfig = GameMathConfig,
> {
	/** Stable identifier — appears in DB rows, socket rooms, URLs. Never rename once released. */
	readonly gameCode: string;
	readonly displayName: string;
	readonly cert: CertAttestation;

	/** Validates the selection payload submitted via place_bet. */
	readonly selectionSchema: z.ZodType<TSelection>;

	/** Validates OperatorGameConfig.configJson for this game. */
	readonly configSchema: z.ZodType<TConfig>;

	/** Default math config used to bootstrap a new operator and by the conformance harness. */
	readonly defaultConfig: TConfig;

	/** Example of a valid selection — used by the conformance harness to smoke the settlement path. */
	readonly sampleSelection: TSelection;

	/** Compute the round outcome. MUST be pure and deterministic given the same inputs. */
	computeOutcome(ctx: RngContext, config: TConfig): TOutcome;

	/** Recompute and compare against a claimed outcome (used by /rounds/:id/proof and dispute packs). */
	verifyOutcome(ctx: RngContext, config: TConfig, claimed: TOutcome): boolean;

	/** Decide win/loss and compute the gross payout for a single bet. Commission logic lives here. */
	settleBet(
		req: SettlementRequest & {
			outcome: TOutcome;
			selection: TSelection;
			config: TConfig;
		},
	): SettlementResult;

	/** Shape the outcome for the round_result socket event. */
	outcomeForWire(outcome: TOutcome): WireOutcome;

	/** Optional live-cashout support for crash-style games. */
	readonly liveCrash?: LiveCrashSupport<TSelection, TConfig>;
}
