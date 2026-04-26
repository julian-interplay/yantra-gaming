import { create } from "zustand";
import type { LaunchParams, RgLimits } from "../bootstrap/parseLaunchParams";

// Session state for the iframe. Lives in memory only — no localStorage.
// The operator is the identity authority; we are a dumb canvas that holds
// a short-lived token for this one session and throws it away on unmount.

interface SessionState {
	params: LaunchParams | null;
	token: string | null;
	/** ms since epoch, when the iframe initialised. Used as the session-start anchor for the RG time-remaining calc. */
	sessionStartedAtMs: number | null;
	/** ms since epoch, from the JWT `exp` claim. */
	expiresAtMs: number | null;
	/** RG-limits copy decoded from the token. Display-only; server enforces. */
	rgLimits: RgLimits | null;
	gameCode: string | null;
	terminated: boolean;
	terminationReason: string | null;

	initialise: (params: LaunchParams) => void;
	refreshToken: (token: string) => void;
	terminate: (reason?: string) => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
	params: null,
	token: null,
	sessionStartedAtMs: null,
	expiresAtMs: null,
	rgLimits: null,
	gameCode: null,
	terminated: false,
	terminationReason: null,

	initialise: (params) =>
		set({
			params,
			token: params.sessionToken,
			sessionStartedAtMs: Date.now(),
			expiresAtMs: params.expiresAtMs,
			rgLimits: params.rgLimits,
			gameCode: params.gameCode,
			terminated: false,
		}),
	refreshToken: (token) => set({ token }),
	terminate: (reason) =>
		set({ terminated: true, terminationReason: reason ?? null, token: null }),
}));
