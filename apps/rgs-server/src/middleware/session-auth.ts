import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { prisma } from "../db.js";

export interface SessionRgLimits {
	dailyLossMicro?: string;
	dailyWagerMicro?: string;
	sessionLossMicro?: string;
	sessionWagerMicro?: string;
	sessionTimeSeconds?: number;
}

export interface SessionJwtClaims {
	sub: string; // sessionId (we use sub = sessionId; playerRef is a claim)
	sessionId: string;
	operatorId: string;
	playerRef: string;
	gameCode: string;
	currency: string;
	jurisdiction: string;
	lang: string;
	mode: "real" | "demo";
	/**
	 * RG limits copied into the token so the game-client can display caps
	 * without an extra fetch. The server-side enforcement path re-reads
	 * rgLimits from the DB (authoritative) — the JWT copy is display-only.
	 */
	rgLimits?: SessionRgLimits;
	iat: number;
	exp: number;
}

declare module "express-serve-static-core" {
	interface Request {
		session?: Awaited<ReturnType<typeof prisma.gameSession.findUnique>>;
		sessionClaims?: SessionJwtClaims;
	}
}

export function signSessionToken(
	claims: Omit<SessionJwtClaims, "iat" | "exp">,
	expiresInSec = 4 * 60 * 60,
): string {
	return jwt.sign(claims, config.sessionJwtSecret, {
		algorithm: "HS256",
		expiresIn: expiresInSec,
	});
}

function extractToken(req: Request): string | undefined {
	const h = req.header("authorization");
	if (h && h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
	const q = req.query.sessionToken;
	if (typeof q === "string" && q.length > 0) return q;
	return undefined;
}

export async function sessionAuth(
	req: Request,
	res: Response,
	next: NextFunction,
): Promise<void> {
	const token = extractToken(req);
	if (!token) {
		res.status(401).json({ error: "missing_session_token" });
		return;
	}
	let claims: SessionJwtClaims;
	try {
		claims = jwt.verify(token, config.sessionJwtSecret) as SessionJwtClaims;
	} catch {
		res.status(401).json({ error: "invalid_session_token" });
		return;
	}

	const session = await prisma.gameSession.findUnique({
		where: { id: claims.sessionId },
	});
	if (!session) {
		res.status(401).json({ error: "session_not_found" });
		return;
	}
	if (session.terminatedAt) {
		res.status(401).json({ error: "session_terminated" });
		return;
	}
	if (session.expiresAt.getTime() < Date.now()) {
		res.status(401).json({ error: "session_expired" });
		return;
	}

	req.session = session;
	req.sessionClaims = claims;
	next();
}

export function verifySessionTokenOrThrow(token: string): SessionJwtClaims {
	return jwt.verify(token, config.sessionJwtSecret) as SessionJwtClaims;
}
