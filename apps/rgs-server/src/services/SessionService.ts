import { generateClientSeed, generateSeedPair } from "@yantra/rng-core";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { signSessionToken } from "../middleware/session-auth.js";
import { signLaunchJwt } from "./SigningKeys.js";
import { dispatchEvent } from "./WebhookDispatcher.js";

export interface CreateSessionInput {
	operatorId: string;
	playerRef: string;
	gameCode: string;
	currency: string;
	lang: string;
	jurisdiction: string;
	mode?: "real" | "demo";
	returnUrl?: string;
	clientSeed?: string;
	rgLimits?: Record<string, unknown>;
	ttlSeconds?: number;
}

export const DEFAULT_SESSION_TTL_SECONDS = 4 * 60 * 60;
export const MIN_SESSION_TTL_SECONDS = 5 * 60;
export const MAX_SESSION_TTL_SECONDS = 8 * 60 * 60;

export function normaliseSessionTtlSeconds(ttlSeconds?: number): number {
	if (ttlSeconds === undefined) return DEFAULT_SESSION_TTL_SECONDS;
	if (!Number.isFinite(ttlSeconds)) return DEFAULT_SESSION_TTL_SECONDS;
	const ttl = Math.floor(ttlSeconds);
	return Math.min(
		MAX_SESSION_TTL_SECONDS,
		Math.max(MIN_SESSION_TTL_SECONDS, ttl),
	);
}

export interface CreatedSession {
	sessionId: string;
	sessionToken: string;
	/** ES256-signed launch JWT. Verifiable via /v1/operators/:slug/.well-known/jwks.json. */
	launchJwt: string;
	launchJwtAlgorithm: "ES256";
	launchUrl: string;
	expiresAt: string;
	serverSeedHash: string;
}

export class SessionService {
	async create(input: CreateSessionInput): Promise<CreatedSession> {
		const ttl = normaliseSessionTtlSeconds(input.ttlSeconds);
		const { serverSeed, serverSeedHash } = generateSeedPair();
		const clientSeed = input.clientSeed ?? generateClientSeed();
		const expiresAt = new Date(Date.now() + ttl * 1000);

		const session = await prisma.gameSession.create({
			data: {
				operatorId: input.operatorId,
				playerRef: input.playerRef,
				gameCode: input.gameCode,
				currency: input.currency,
				lang: input.lang,
				jurisdiction: input.jurisdiction,
				mode: input.mode === "demo" ? "DEMO" : "REAL",
				rgLimits: input.rgLimits as object | undefined,
				returnUrl: input.returnUrl,
				serverSeed,
				serverSeedHash,
				clientSeed,
				expiresAt,
			},
		});

		const baseClaims = {
			sub: session.id,
			sessionId: session.id,
			operatorId: session.operatorId,
			playerRef: session.playerRef,
			gameCode: session.gameCode,
			currency: session.currency,
			jurisdiction: session.jurisdiction,
			lang: session.lang,
			mode: session.mode === "DEMO" ? "demo" : "real",
			rgLimits: input.rgLimits as unknown as
				| import("../middleware/session-auth.js").SessionRgLimits
				| undefined,
		};

		// Legacy HS256 token — verified by session-auth.ts for Socket.IO +
		// iframe hand-off. Kept as the primary credential until all
		// integrators migrate to the asymmetric JWT.
		const sessionToken = signSessionToken(baseClaims, ttl);

		// New ES256 launch JWT — operators and aggregators verify via JWKS.
		// Contains the same claims so the migration is a drop-in swap.
		const launchJwt = await signLaunchJwt({
			operatorId: session.operatorId,
			payload: baseClaims as Record<string, unknown>,
			expiresInSec: ttl,
		});

		const params = new URLSearchParams({
			sessionToken,
			sessionId: session.id,
			lang: session.lang,
			operatorId: session.operatorId,
			currency: session.currency,
			gameCode: session.gameCode,
			jurisdiction: session.jurisdiction,
		});
		const launchUrl = `${config.gameClientBaseUrl}/?${params.toString()}`;

		return {
			sessionId: session.id,
			sessionToken,
			launchJwt,
			launchJwtAlgorithm: "ES256",
			launchUrl,
			expiresAt: expiresAt.toISOString(),
			serverSeedHash,
		};
	}

	async getActive(sessionId: string, operatorId?: string) {
		const s = await prisma.gameSession.findUnique({ where: { id: sessionId } });
		if (!s) return null;
		if (operatorId && s.operatorId !== operatorId) return null;
		if (s.terminatedAt) return s;
		if (s.expiresAt.getTime() < Date.now()) return s;
		return s;
	}

	async terminate(
		sessionId: string,
		reason: string,
		operatorId?: string,
	): Promise<boolean> {
		const s = await prisma.gameSession.findUnique({ where: { id: sessionId } });
		if (!s) return false;
		if (operatorId && s.operatorId !== operatorId) return false;
		if (s.terminatedAt) return true;
		const terminatedAt = new Date();
		await prisma.gameSession.update({
			where: { id: sessionId },
			data: { terminatedAt, terminationReason: reason.slice(0, 64) },
		});
		void dispatchEvent({
			operatorId: s.operatorId,
			eventType: "session.terminated",
			data: {
				sessionId,
				playerRef: s.playerRef,
				terminatedAt: terminatedAt.toISOString(),
				reason: reason.slice(0, 64),
			},
		}).catch(() => {});
		return true;
	}

	/** Rotate the seed pair mid-session. Returns the revealed old serverSeed. */
	async rotateSeed(
		sessionId: string,
		newClientSeed?: string,
	): Promise<{ revealedServerSeed: string; newServerSeedHash: string } | null> {
		const s = await prisma.gameSession.findUnique({ where: { id: sessionId } });
		if (!s) return null;
		const revealed = s.serverSeed;
		const { serverSeed, serverSeedHash } = generateSeedPair();
		await prisma.gameSession.update({
			where: { id: sessionId },
			data: {
				serverSeed,
				serverSeedHash,
				clientSeed: newClientSeed ?? s.clientSeed,
				nonce: 0,
			},
		});
		return { revealedServerSeed: revealed, newServerSeedHash: serverSeedHash };
	}
}

export const sessionService = new SessionService();
