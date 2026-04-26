// Lobby: renders the fake-casino page on GET /, and on POST /lobby/launch
// kicks off a signed POST /v1/session call to the RGS and redirects the
// browser to the returned launchUrl.

import crypto from "node:crypto";
import {
	type CreateSessionRequest,
	type CreateSessionResponse,
	KEY_ID_HEADER,
	SIGNATURE_HEADER,
	TIMESTAMP_HEADER,
} from "@yantra/wallet-spec";
import { Router, urlencoded } from "express";
import { config } from "../config.js";
import { signPayload } from "../wallet/signing.js";
import { getStore } from "../wallet/store.js";
import { type LobbyViewModel, renderLobby } from "./template.js";

export const lobbyRouter = Router();

// Lobby form submissions are plain form-urlencoded.
const formBody = urlencoded({ extended: false });

function buildViewModel(error?: LobbyViewModel["error"]): LobbyViewModel {
	const store = getStore(config.operatorId);
	const players = store.seededPlayers().map((ref) => ({
		playerRef: ref,
		balanceMicro: store.balance(config.operatorId, ref),
	}));
	return {
		operatorId: config.operatorId,
		apiKeyId: config.apiKeyId,
		rgsBaseUrl: config.rgsBaseUrl,
		gameClientBaseUrl: config.gameClientBaseUrl,
		currency: config.defaultCurrency,
		players,
		...(error ? { error } : {}),
	};
}

lobbyRouter.get("/", (_req, res) => {
	res.set("content-type", "text/html; charset=utf-8");
	res.send(renderLobby(buildViewModel()));
});

lobbyRouter.post("/lobby/launch", formBody, async (req, res) => {
	const playerRef = String(
		(req.body as { playerRef?: unknown })?.playerRef ?? "",
	).trim();
	if (!playerRef) {
		res.status(400).set("content-type", "text/html; charset=utf-8");
		return res.send(
			renderLobby(
				buildViewModel({
					playerRef: "(none)",
					message: "playerRef is required",
				}),
			),
		);
	}

	const payload: CreateSessionRequest = {
		operatorId: config.operatorId,
		playerRef,
		gameCode: config.gameCode,
		currency: config.defaultCurrency,
		lang: config.defaultLang,
		jurisdiction: config.defaultJurisdiction,
		mode: "real",
		returnUrl: `http://localhost:${config.port}/`,
		sessionTtlSeconds: config.sessionTtlSeconds,
	};

	// Wrap in the signed-request envelope the RGS expects. Per the roadmap
	// §8.2, the signature covers method + path + timestamp + sha256(body),
	// and the body carries a per-request `requestUuid` for replay protection.
	const envelope = {
		requestUuid: crypto.randomUUID(),
		...payload,
	};
	const bodyJson = JSON.stringify(envelope);
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const path = "/v1/session";
	const signature = signPayload(
		config.apiSecret,
		"POST",
		path,
		timestamp,
		bodyJson,
	);
	const url = `${config.rgsBaseUrl}${path}`;

	let rgsStatus = 0;
	let rgsBody: unknown;

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				[KEY_ID_HEADER]: config.apiKeyId,
				[TIMESTAMP_HEADER]: timestamp,
				[SIGNATURE_HEADER]: signature,
			},
			body: bodyJson,
		});
		rgsStatus = resp.status;
		const text = await resp.text();
		try {
			rgsBody = text ? JSON.parse(text) : null;
		} catch {
			rgsBody = text;
		}

		if (!resp.ok) {
			res.status(502).set("content-type", "text/html; charset=utf-8");
			return res.send(
				renderLobby(
					buildViewModel({
						playerRef,
						message: `RGS /v1/session returned HTTP ${rgsStatus}`,
						detail: rgsBody,
					}),
				),
			);
		}

		const data = rgsBody as Partial<CreateSessionResponse> | null;
		if (!data?.launchUrl) {
			res.status(502).set("content-type", "text/html; charset=utf-8");
			return res.send(
				renderLobby(
					buildViewModel({
						playerRef,
						message: "RGS response missing launchUrl",
						detail: rgsBody,
					}),
				),
			);
		}

		// Success — redirect the browser straight at the game-client iframe URL.
		return res.redirect(302, data.launchUrl);
	} catch (err) {
		res.status(502).set("content-type", "text/html; charset=utf-8");
		return res.send(
			renderLobby(
				buildViewModel({
					playerRef,
					message: `Could not reach RGS at ${config.rgsBaseUrl}`,
					detail: err instanceof Error ? err.message : err,
				}),
			),
		);
	}
});
