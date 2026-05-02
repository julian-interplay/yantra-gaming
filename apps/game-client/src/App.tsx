import type React from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type LaunchParams,
	parseLaunchParams,
} from "./bootstrap/parseLaunchParams";
import { useSocket } from "./hooks/useSocket";
import {
	installParentMessaging,
	sendReady,
	sendSessionEnded,
} from "./iframe/parentMessaging";
import { LempiShell } from "./lempi/LempiShell";
import { useSessionStore } from "./session/sessionStore";
import { useGameStore } from "./store/gameStore";
import { BetControls } from "./ui/BetControls";
import { BetRejectToast } from "./ui/BetRejectToast";
import { CanvasErrorBoundary } from "./ui/CanvasErrorBoundary";
import { CanvasToolbar } from "./ui/CanvasToolbar";
import { ErrorScreen } from "./ui/ErrorScreen";
import { FairnessDrawer } from "./ui/FairnessDrawer";
import { GameSplash } from "./ui/GameSplash";
import { Header } from "./ui/Header";
import { InfoSheet } from "./ui/InfoSheet";
import { LeftPanel } from "./ui/LeftPanel";
import { LossToast } from "./ui/LossToast";
import { OfflineBanner } from "./ui/OfflineBanner";
import { SessionExpiryBanner } from "./ui/SessionExpiryBanner";
import { WinToast } from "./ui/WinToast";

let gameCanvasPromise: Promise<{ default: React.ComponentType }> | null = null;

function loadGameCanvas(): Promise<{ default: React.ComponentType }> {
	gameCanvasPromise ??= import("./ui/GameCanvas").then((mod) => ({
		default: mod.GameCanvas,
	}));
	return gameCanvasPromise;
}

const LazyGameCanvas = lazy(loadGameCanvas);

/**
 * Full page layout — header on top, LeftPanel | canvas-area | BetControls in
 * the body. Overlays (offline, toasts, drawers) float above. Layout collapses
 * to a stacked column under 1024px (see global.css + each panel's own CSS).
 */
const GameShell: React.FC = () => {
	const { t } = useTranslation();
	const { placeBet } = useSocket();
	const isPaused = useGameStore((s) => s.isPaused);
	const isConnected = useGameStore((s) => s.isConnected);

	const [fairnessOpen, setFairnessOpen] = useState(false);
	const [infoSheetOpen, setInfoSheetOpen] = useState(false);
	const [splashHidden, setSplashHidden] = useState(false);
	const [splashMounted, setSplashMounted] = useState(true);
	const [showDisconnected, setShowDisconnected] = useState(false);

	// Hide the splash after the first socket connection — the scene has loaded
	// by then and we have real data to render.
	useEffect(() => {
		if (!isConnected) return;
		const hideTimer = setTimeout(() => setSplashHidden(true), 400);
		return () => clearTimeout(hideTimer);
	}, [isConnected]);

	useEffect(() => {
		const frame = window.requestAnimationFrame(() => {
			void loadGameCanvas();
		});
		return () => window.cancelAnimationFrame(frame);
	}, []);

	// Unmount the splash after its fade-out transition completes (matches 0.45s).
	useEffect(() => {
		if (!splashHidden) return;
		const timer = setTimeout(() => setSplashMounted(false), 500);
		return () => clearTimeout(timer);
	}, [splashHidden]);

	// Show "reconnecting" overlay only after 5s of disconnect — brief blips
	// shouldn't flash the overlay.
	useEffect(() => {
		if (isConnected) {
			setShowDisconnected(false);
			return;
		}
		const timer = setTimeout(() => setShowDisconnected(true), 5000);
		return () => clearTimeout(timer);
	}, [isConnected]);

	return (
		<div className="game-page">
			<OfflineBanner />
			<SessionExpiryBanner />
			<Header onInfoClick={() => setInfoSheetOpen(true)} />

			<div className="game-page__body">
				<LeftPanel />

				<div className="game-page__canvas-area">
					<CanvasErrorBoundary>
						<Suspense fallback={<div className="game-canvas" />}>
							<LazyGameCanvas />
						</Suspense>
					</CanvasErrorBoundary>

					{splashMounted && <GameSplash hidden={splashHidden} />}

					<CanvasToolbar onOpenFairness={() => setFairnessOpen(true)} />

					<div className={`game-page__overlay pause ${isPaused ? "open" : ""}`}>
						<div className="game-page__overlay-content">
							<span className="game-page__overlay-icon">||</span>
							<span className="game-page__overlay-text">
								{t("game.paused")}
							</span>
						</div>
					</div>

					<div
						className={`game-page__overlay disconnected ${showDisconnected ? "open" : ""}`}
					>
						<div className="game-page__overlay-content">
							<span className="game-page__overlay-spinner" />
							<span className="game-page__overlay-text">
								{t("game.disconnected")}
							</span>
						</div>
					</div>
				</div>

				<BetControls placeBet={placeBet} />
			</div>

			<WinToast />
			<LossToast />
			<BetRejectToast />
			<FairnessDrawer
				open={fairnessOpen}
				onClose={() => setFairnessOpen(false)}
			/>
			<InfoSheet open={infoSheetOpen} onClose={() => setInfoSheetOpen(false)} />
		</div>
	);
};

/**
 * Top-level app. Reads launch params on mount, wires parent-frame messaging,
 * and chooses between the game shell and the error screen.
 */
export const App: React.FC = () => {
	const { i18n } = useTranslation();
	const [params] = useState<LaunchParams | null>(() => parseLaunchParams());
	const terminated = useSessionStore((s) => s.terminated);
	const terminationReason = useSessionStore((s) => s.terminationReason);
	const initialise = useSessionStore((s) => s.initialise);
	const refreshToken = useSessionStore((s) => s.refreshToken);
	const terminate = useSessionStore((s) => s.terminate);

	useEffect(() => {
		if (!params) return;
		initialise(params);
		if (params.lang && params.lang !== i18n.language) {
			i18n.changeLanguage(params.lang).catch(() => {});
		}
	}, [params, initialise, i18n]);

	useEffect(() => {
		if (!params) return;
		sendReady();
		const detach = installParentMessaging({
			onTerminate: (reason) => {
				terminate(reason);
				sendSessionEnded(reason);
			},
			onRefreshToken: (token) => refreshToken(token),
		});
		return detach;
	}, [params, terminate, refreshToken]);

	const errorScreen = useMemo(() => {
		if (!params) return <ErrorScreen />;
		if (terminated) {
			return (
				<ErrorScreen
					title="Session ended"
					message={
						terminationReason ?? "Return to your casino to start a new session."
					}
				/>
			);
		}
		return null;
	}, [params, terminated, terminationReason]);

	if (errorScreen) return errorScreen;
	if (params?.gameCode === "lempi-crash") return <LempiShell />;
	return <GameShell />;
};
