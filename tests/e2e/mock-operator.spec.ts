// End-to-end: operator → RGS → iframe → settlement.
//
// Drives the full external surface a real integrator would touch:
//
//   1. Signed HTTP POST /v1/session          (operator → RGS)
//   2. Socket.IO connect with sessionToken   (iframe → RGS)
//   3. place_bet emit + bet_placed ack       (iframe → RGS → operator wallet)
//   4. round_state / round_result listeners  (RGS → iframe)
//
// The RGS is built inline here (matching apps/rgs-server/src/index.ts) so the
// test gets a real Express + Socket.IO instance without spawning a child
// process. The operator wallet is backed by `createFakeWallet` from the
// integration harness.
//
// Runs behind E2E=1 so `bun test` by default runs only the fast integration
// suite. In CI, add `E2E=1` to the `bun test` step once an `OperatorGameConfig`
// seed is wired into beforeEach.

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { type Socket as ClientSocket, io as ioClient } from "socket.io-client";

import { prisma } from "../../apps/rgs-server/src/db.js";
import { healthRouter } from "../../apps/rgs-server/src/routes/health.js";
import { v1Router } from "../../apps/rgs-server/src/routes/index.js";
import {
	getEngineRegistry,
	initEngineRegistry,
} from "../../apps/rgs-server/src/services/EngineRegistry.js";
import { attachGameSocket } from "../../apps/rgs-server/src/socket/gameSocket.js";
import {
	cleanDb,
	createFakeWallet,
	type FakeWallet,
	mintSessionToken,
	type SeededOperator,
	seedOperator,
	signedHeaders,
} from "../integration/harness.js";

const ENABLED = process.env.E2E === "1";
const describeMaybe = ENABLED ? describe : describe.skip;

interface RgsHandle {
	baseUrl: string;
	close: () => Promise<void>;
}

async function bootRgs(): Promise<RgsHandle> {
	const app = express();
	app.set("trust proxy", 1);
	app.use(
		express.json({
			limit: "256kb",
			verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
				req.rawBody = Buffer.from(buf);
			},
		}),
	);
	app.use(healthRouter);
	app.use("/v1", v1Router);

	const httpServer = createHttpServer(app);
	const io = new SocketIOServer(httpServer, { path: "/socket.io" });
	initEngineRegistry(io);
	attachGameSocket(io);

	await new Promise<void>((r) => httpServer.listen(0, r));
	const { port } = httpServer.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: async () => {
			await getEngineRegistry().stopAll();
			io.close();
			await new Promise<void>((r) => httpServer.close(() => r()));
		},
	};
}

async function seedGameConfig(
	operatorId: string,
	currency = "LKR",
): Promise<void> {
	await prisma.operatorGameConfig.create({
		data: {
			operatorId,
			gameCode: "ketapola-dice",
			currency,
			enabled: true,
			configJson: { lowWeight: 48, highWeight: 48 },
			configVersion: "v1",
			minBetMicro: 10_000_000n, // 100 LKR
			maxBetMicro: 10_000_000_000n, // 100,000 LKR
			commissionMicro: 3_000n,
			bettingWindowMs: 2_000,
			rollingWindowMs: 500,
			cooldownMs: 500,
		},
	});
}

async function seedLempiGameConfig(
	operatorId: string,
	currency = "LKR",
): Promise<void> {
	await prisma.operatorGameConfig.create({
		data: {
			operatorId,
			gameCode: "lempi-crash",
			currency,
			enabled: true,
			configJson: {
				houseEdge: 0.01,
				maxMultiplier: 1000,
				multiplierGrowthRate: 0.00011,
				minFlightMs: 700,
				maxFlightMs: 120_000,
				botCashoutsEnabled: true,
			},
			configVersion: "v1",
			minBetMicro: 10_000_000n,
			maxBetMicro: 10_000_000_000n,
			commissionMicro: 3_000n,
			bettingWindowMs: 2_000,
			rollingWindowMs: 500,
			cooldownMs: 500,
		},
	});
}

async function createLempiSession(args: {
	operatorId: string;
	sessionId: string;
	playerRef: string;
	currency?: string;
}): Promise<void> {
	await prisma.gameSession.create({
		data: {
			id: args.sessionId,
			operatorId: args.operatorId,
			playerRef: args.playerRef,
			gameCode: "lempi-crash",
			currency: args.currency ?? "LKR",
			lang: "es",
			jurisdiction: "INTL",
			serverSeed: `server-${args.sessionId}`,
			serverSeedHash: `hash-${args.sessionId}`,
			clientSeed: `client-${args.sessionId}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		},
	});
}

function waitForPresence(
	socket: ClientSocket,
	expected: number,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error(`presence ${expected} timeout`)),
			3_000,
		);
		const handler = (payload: { connectedPlayerCount?: number }) => {
			if (payload.connectedPlayerCount !== expected) return;
			clearTimeout(timeout);
			socket.off("presence_update", handler);
			resolve();
		};
		socket.on("presence_update", handler);
	});
}

describeMaybe(
	"e2e: operator launches session, player bets, round settles",
	() => {
		let rgs: RgsHandle;
		let fake: FakeWallet;
		let operator: SeededOperator;

		beforeAll(async () => {
			fake = await createFakeWallet();
			rgs = await bootRgs();
		});

		afterAll(async () => {
			await rgs.close();
			await fake.close();
			await prisma.$disconnect();
		});

		beforeEach(async () => {
			await getEngineRegistry().stopAll();
			await cleanDb();
			fake.resetHits();
			operator = await seedOperator({ walletCallbackUrl: fake.url });
			await seedGameConfig(operator.operatorId);
			fake.seed("e2e-player-1", "LKR", 1_000_000_000_000n); // 10M LKR
			await getEngineRegistry().startAllEnabled();
		});

		it("launches → bets → emits round_result", async () => {
			// 1. Operator creates a session.
			const body = JSON.stringify({
				requestUuid: crypto.randomUUID(),
				operatorId: operator.operatorId,
				playerRef: "e2e-player-1",
				gameCode: "yantra",
				currency: "LKR",
				lang: "si",
				jurisdiction: "LK",
				mode: "real",
				returnUrl: "https://example.com/lobby",
			});
			const res = await fetch(`${rgs.baseUrl}/v1/session`, {
				method: "POST",
				headers: signedHeaders(
					operator.inboundSecret,
					operator.inboundKid,
					"POST",
					"/v1/session",
					body,
				),
				body,
			});
			expect(res.status).toBe(200);
			const launch = (await res.json()) as {
				sessionToken: string;
				sessionId: string;
			};
			expect(launch.sessionToken).toBeTruthy();

			// 2. Player iframe connects via Socket.IO.
			const socket: ClientSocket = ioClient(rgs.baseUrl, {
				auth: { token: launch.sessionToken },
				transports: ["websocket"],
				forceNew: true,
			});
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", () => resolve());
				socket.once("connect_error", (e) => reject(e));
				setTimeout(() => reject(new Error("socket connect timeout")), 3_000);
			});

			// 3. Wait for a BETTING_OPEN phase, place a bet, wait for round_result.
			const roundResult = new Promise<{ outcomeSide: string }>((resolve) => {
				socket.once("round_result", (payload: { outcomeSide: string }) =>
					resolve(payload),
				);
			});

			const onRoundState = (payload: { phase: string }) => {
				if (payload.phase === "BETTING_OPEN") {
					socket.emit("place_bet", { side: "LOW", amountMicro: "100000000" });
				}
			};
			socket.on("round_state", onRoundState);

			const result = await Promise.race([
				roundResult,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("round_result timeout")), 15_000),
				),
			]);

			expect(["LOW", "HIGH"]).toContain(result.outcomeSide);
			expect(fake.hits("bet")).toBeGreaterThanOrEqual(1);

			socket.off("round_state", onRoundState);
			socket.disconnect();
		}, 30_000);

		it("emits unique connected-player presence for Lempi", async () => {
			await seedLempiGameConfig(operator.operatorId);

			const launchA = mintSessionToken(operator.operatorId, "presence-a", {
				gameCode: "lempi-crash",
				currency: "LKR",
				lang: "es",
			});
			const launchB = mintSessionToken(operator.operatorId, "presence-b", {
				gameCode: "lempi-crash",
				currency: "LKR",
				lang: "es",
			});
			await createLempiSession({
				operatorId: operator.operatorId,
				sessionId: launchA.sessionId,
				playerRef: "presence-a",
			});
			await createLempiSession({
				operatorId: operator.operatorId,
				sessionId: launchB.sessionId,
				playerRef: "presence-b",
			});

			const socketA: ClientSocket = ioClient(rgs.baseUrl, {
				auth: { token: launchA.token },
				transports: ["websocket"],
				forceNew: true,
			});
			await waitForPresence(socketA, 1);

			const duplicateA: ClientSocket = ioClient(rgs.baseUrl, {
				auth: { token: launchA.token },
				transports: ["websocket"],
				forceNew: true,
			});
			await waitForPresence(duplicateA, 1);

			const socketB: ClientSocket = ioClient(rgs.baseUrl, {
				auth: { token: launchB.token },
				transports: ["websocket"],
				forceNew: true,
			});
			await waitForPresence(socketB, 2);

			const decremented = waitForPresence(socketA, 1);
			socketB.disconnect();
			await decremented;

			socketA.disconnect();
			duplicateA.disconnect();
		}, 10_000);
	},
);
