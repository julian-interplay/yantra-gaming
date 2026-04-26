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
				String((event as CustomEvent<string>).detail ?? "Accion rechazada"),
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
					Reconectando al servidor...
				</div>
			)}
			<SessionExpiryBanner />
			<header className="lempi-header">
				<div className="lempi-header__brand">
					<strong>Lempi Crash</strong>
					<span className={isConnected ? "connected" : ""} />
				</div>
				<div className="lempi-header__balance">
					<span>Saldo</span>
					<strong>{formatHnl(balanceMicro, true)}</strong>
				</div>
			</header>

			<main className="lempi-layout">
				<aside className="lempi-pool">
					<div className="lempi-pool__tabs">
						<span className="active">Mesa</span>
						<span>Cartera</span>
						<span>Senales IA</span>
					</div>
					<div className="lempi-pool__summary">
						<div>
							<strong>
								{cashedOutCount}/{acceptedCount}
							</strong>
							<span> Pozo</span>
						</div>
						<div>
							<strong>{formatHnl(totalWinMicro)}</strong>
							<span>Ganancia total HNL</span>
						</div>
					</div>
					<div className="lempi-pool__table">
						<div className="lempi-pool__head">
							<span>Jugador</span>
							<span>Apuesta</span>
							<span>X</span>
							<span>Gana</span>
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
					<LempiCanvas />
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
