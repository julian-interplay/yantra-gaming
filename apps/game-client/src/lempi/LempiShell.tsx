import type React from "react";
import { useEffect, useState } from "react";
import { SessionExpiryBanner } from "../ui/SessionExpiryBanner";
import { LempiCanvas } from "./LempiCanvas";
import { LempiControls } from "./LempiControls";
import { formatHnl, useLempiStore } from "./LempiStore";
import { useLempiSocket } from "./useLempiSocket";
import "./LempiShell.css";

export const LempiShell: React.FC = () => {
	const { placeBet, cashOut } = useLempiSocket();
	const isConnected = useLempiStore((s) => s.isConnected);
	const roundState = useLempiStore((s) => s.roundState);
	const timeRemaining = useLempiStore((s) => s.timeRemaining);
	const multiplier = useLempiStore((s) => s.multiplier);
	const crashMultiplier = useLempiStore((s) => s.crashMultiplier);
	const balanceMicro = useLempiStore((s) => s.balanceMicro);
	const toasts = useLempiStore((s) => s.toasts);
	const poolPlayers = useLempiStore((s) => s.poolPlayers);
	const acceptedCount = useLempiStore((s) => s.acceptedCount);
	const cashedOutCount = useLempiStore((s) => s.cashedOutCount);
	const totalWinMicro = useLempiStore((s) => s.totalWinMicro);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		const handler = (event: Event) => {
			setNotice(
				String((event as CustomEvent<string>).detail ?? "Action rejected"),
			);
			window.setTimeout(() => setNotice(null), 2200);
		};
		window.addEventListener("lempi:notice", handler);
		return () => window.removeEventListener("lempi:notice", handler);
	}, []);

	return (
		<div className={`lempi-page ${isConnected ? "" : "is-reconnecting"}`}>
			{!isConnected && (
				<div className="lempi-reconnect" role="status" aria-live="polite">
					Reconnecting to game server...
				</div>
			)}
			<SessionExpiryBanner />
			<header className="lempi-header">
				<div className="lempi-header__brand">
					<strong>Lempi Crash</strong>
					<span className={isConnected ? "connected" : ""} />
				</div>
				<div className="lempi-header__balance">
					<span>Balance</span>
					<strong>{formatHnl(balanceMicro, true)}</strong>
				</div>
			</header>

			<main className="lempi-layout">
				<aside className="lempi-pool">
					<div className="lempi-pool__tabs">
						<span className="active">Live</span>
						<span>Portfolio</span>
						<span>AI Signals</span>
					</div>
					<div className="lempi-pool__summary">
						<div>
							<strong>
								{cashedOutCount}/{acceptedCount}
							</strong>
							<span> Pool</span>
						</div>
						<div>
							<strong>{formatHnl(totalWinMicro)}</strong>
							<span>Total win HNL</span>
						</div>
					</div>
					<div className="lempi-pool__table">
						<div className="lempi-pool__head">
							<span>Player</span>
							<span>Stake</span>
							<span>X</span>
							<span>Win</span>
						</div>
						{poolPlayers.map((player) => (
							<div
								className={`lempi-pool__row ${player.cashoutMultiplier ? "won" : ""}`}
								key={player.betId}
							>
								<span>{player.playerRef}</span>
								<span>{formatHnl(player.amountMicro)}</span>
								<span>
									{player.cashoutMultiplier
										? `${player.cashoutMultiplier.toFixed(2)}x`
										: "-"}
								</span>
								<span>
									{player.winMicro ? formatHnl(player.winMicro) : "-"}
								</span>
							</div>
						))}
					</div>
				</aside>

				<section className="lempi-stage">
					<div className="lempi-stage__top">
						<span>{isConnected ? "LIVE" : "CONNECTING"}</span>
						<strong>{formatHnl(balanceMicro, true)}</strong>
					</div>
					<LempiCanvas />
					<div className="lempi-hud">
						{roundState === "BETTING_OPEN" && (
							<>
								<span>GET READY</span>
								<strong>{timeRemaining}s</strong>
							</>
						)}
						{roundState === "ROLLING" && (
							<strong>{multiplier.toFixed(2)}x</strong>
						)}
						{roundState === "RESULT" && (
							<>
								<span>CRASHED AT</span>
								<strong>{(crashMultiplier ?? multiplier).toFixed(2)}x</strong>
							</>
						)}
					</div>
					<div className="lempi-toasts">
						{toasts.map((toast) => (
							<div className="lempi-toast" key={toast.id}>
								<span>{toast.playerRef}</span>
								<strong>{toast.multiplier.toFixed(2)}x</strong>
								<em>{formatHnl(toast.payoutMicro, true)}</em>
							</div>
						))}
					</div>
				</section>

				<LempiControls placeBet={placeBet} cashOut={cashOut} />
			</main>

			{notice && <div className="lempi-notice">{notice}</div>}
		</div>
	);
};
