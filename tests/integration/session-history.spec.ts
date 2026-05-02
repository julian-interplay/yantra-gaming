import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { Server } from "node:http";
import express from "express";

import { prisma } from "../../apps/rgs-server/src/db.js";
import { sessionRouter } from "../../apps/rgs-server/src/routes/session.js";
import { newUuid } from "../../apps/rgs-server/src/utils/uuid.js";
import {
	cleanDb,
	mintSessionToken,
	type SeededOperator,
	seedOperator,
} from "./harness.js";

interface RunningApp {
	url: string;
	close: () => Promise<void>;
}

async function startApp(): Promise<RunningApp> {
	const app = express();
	app.use(express.json());
	app.use("/v1/session", sessionRouter);

	return new Promise((resolve, reject) => {
		const server: Server = app.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolve({
				url: `http://127.0.0.1:${port}`,
				close: () =>
					new Promise<void>((r) => {
						server.close(() => r());
					}),
			});
		});
		server.once("error", reject);
	});
}

async function createSession(args: {
	operatorId: string;
	sessionId?: string;
	playerRef: string;
}): Promise<string> {
	const id = args.sessionId ?? newUuid();
	await prisma.gameSession.create({
		data: {
			id,
			operatorId: args.operatorId,
			playerRef: args.playerRef,
			gameCode: "lempi-crash",
			currency: "HNL",
			lang: "es",
			jurisdiction: "INTL",
			serverSeed: `server-${id}`,
			serverSeedHash: `hash-${id}`,
			clientSeed: `client-${id}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		},
	});
	return id;
}

async function createSettledCrashBet(args: {
	operatorId: string;
	sessionId: string;
	playerRef: string;
	slotId: "A" | "B";
	nonce: number;
	won: boolean;
	placedAt: Date;
}): Promise<string> {
	const round = await prisma.round.create({
		data: {
			operatorId: args.operatorId,
			sessionId: args.sessionId,
			gameCode: "lempi-crash",
			currency: "HNL",
			nonce: args.nonce,
			state: "SETTLED",
			outcomeType: "CRASH",
			outcomeData: { type: "CRASH", crashMultiplier: args.won ? 3.25 : 1.15 },
			serverSeed: `round-server-${args.nonce}`,
			serverSeedHash: `round-hash-${args.nonce}`,
			clientSeed: `round-client-${args.nonce}`,
			rngVersion: "test",
			settled: true,
			startedAt: args.placedAt,
			rolledAt: args.placedAt,
			settledAt: args.placedAt,
		},
	});

	const bet = await prisma.bet.create({
		data: {
			operatorId: args.operatorId,
			sessionId: args.sessionId,
			roundId: round.id,
			playerRef: args.playerRef,
			selection: { slotId: args.slotId },
			selectionType: "lempi-crash",
			amountMicro: 1_000_000n,
			currency: "HNL",
			status: "SETTLED",
			won: args.won,
			wonAmountMicro: args.won ? 2_000_000n : 0n,
			cashoutMultiplier: args.won ? 2 : null,
			cashoutPayoutMicro: args.won ? 2_000_000n : null,
			betTransactionUuid: newUuid(),
			winTransactionUuid: args.won ? newUuid() : null,
			placedAt: args.placedAt,
			settledAt: args.placedAt,
		},
	});
	return bet.id;
}

describe("player session history", () => {
	let app: RunningApp;
	let operator: SeededOperator;

	beforeAll(async () => {
		app = await startApp();
	});

	afterAll(async () => {
		await app.close();
		await prisma.$disconnect();
	});

	beforeEach(async () => {
		await cleanDb();
		operator = await seedOperator({
			walletCallbackUrl: "http://127.0.0.1:0/wallet",
			currency: "HNL",
		});
	});

	it("returns persisted Lempi bets across sessions for only the token player", async () => {
		const playerRef = "player-history-1";
		const previousSessionId = await createSession({
			operatorId: operator.operatorId,
			playerRef,
		});
		const { token, sessionId: currentSessionId } = mintSessionToken(
			operator.operatorId,
			playerRef,
			{ gameCode: "lempi-crash", currency: "HNL", lang: "es" },
		);
		await createSession({
			operatorId: operator.operatorId,
			sessionId: currentSessionId,
			playerRef,
		});
		const otherSessionId = await createSession({
			operatorId: operator.operatorId,
			playerRef: "other-player",
		});

		const oldBetId = await createSettledCrashBet({
			operatorId: operator.operatorId,
			sessionId: previousSessionId,
			playerRef,
			slotId: "A",
			nonce: 4,
			won: true,
			placedAt: new Date(Date.now() - 20_000),
		});
		const currentBetId = await createSettledCrashBet({
			operatorId: operator.operatorId,
			sessionId: currentSessionId,
			playerRef,
			slotId: "B",
			nonce: 5,
			won: false,
			placedAt: new Date(Date.now() - 10_000),
		});
		await createSettledCrashBet({
			operatorId: operator.operatorId,
			sessionId: otherSessionId,
			playerRef: "other-player",
			slotId: "A",
			nonce: 6,
			won: true,
			placedAt: new Date(),
		});

		const res = await fetch(`${app.url}/v1/session/history?limit=40`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			count: number;
			items: Array<{
				betId: string;
				roundNumber: number;
				slotId: string;
				result: string;
				payoutMicro: string | null;
			}>;
		};

		expect(body.count).toBe(2);
		expect(body.items.map((item) => item.betId)).toEqual([
			currentBetId,
			oldBetId,
		]);
		expect(body.items[0]).toMatchObject({
			roundNumber: 6,
			slotId: "B",
			result: "LOSS",
			payoutMicro: null,
		});
		expect(body.items[1]).toMatchObject({
			roundNumber: 5,
			slotId: "A",
			result: "WIN",
			payoutMicro: "2000000",
		});
	});
});
