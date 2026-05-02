import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { SessionExpiryBanner } from "../ui/SessionExpiryBanner";
import { LempiCanvas } from "./LempiCanvas";
import { LempiControls } from "./LempiControls";
import { LempiLoadingScreen } from "./LempiLoadingScreen";
import { formatHnl, useLempiStore } from "./LempiStore";
import { useLempiSocket } from "./useLempiSocket";
import "./LempiShell.css";

export const LempiShell: React.FC = () => {
	const { placeBet, cashOut } = useLempiSocket();
	const isConnected = useLempiStore((s) => s.isConnected);
	const hasInitialBalanceResponse = useLempiStore(
		(s) => s.hasInitialBalanceResponse,
	);
	const balanceMicro = useLempiStore((s) => s.balanceMicro);
	const toasts = useLempiStore((s) => s.toasts);
	const poolPlayers = useLempiStore((s) => s.poolPlayers);
	const connectedPlayerCount = useLempiStore((s) => s.connectedPlayerCount);
	const acceptedCount = useLempiStore((s) => s.acceptedCount);
	const cashedOutCount = useLempiStore((s) => s.cashedOutCount);
	const totalWinMicro = useLempiStore((s) => s.totalWinMicro);
	const betHistory = useLempiStore((s) => s.betHistory);
	const [notice, setNotice] = useState<string | null>(null);
	const [poolTab, setPoolTab] = useState<"table" | "history">("table");
	const [loadingComplete, setLoadingComplete] = useState(false);
	const loaderReady = isConnected && hasInitialBalanceResponse;
	const handleLoadingComplete = useCallback(() => {
		setLoadingComplete(true);
	}, []);

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

			<main className="lempi-layout">
				<aside className="lempi-pool">
					<div className="lempi-pool__tabs">
						<button
							type="button"
							className={poolTab === "table" ? "active" : ""}
							onClick={() => setPoolTab("table")}
						>
							Mesa
						</button>
						<button
							type="button"
							className={poolTab === "history" ? "active" : ""}
							onClick={() => setPoolTab("history")}
						>
							Historial
						</button>
					</div>
					{poolTab === "table" ? (
						<>
							<div className="lempi-pool__summary">
								<div>
									<strong>{connectedPlayerCount}</strong>
									<span>En linea</span>
								</div>
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
						</>
					) : (
						<div className="lempi-history">
							<div className="lempi-history__head">
								<span>Ronda</span>
								<span>Apuesta</span>
								<span>Crash</span>
								<span>Pago</span>
							</div>
							{betHistory.length === 0 ? (
								<div className="lempi-history__empty">Sin apuestas aun</div>
							) : (
								[...betHistory].reverse().map((entry) => (
									<div
										className={`lempi-history__row ${entry.result.toLowerCase()}`}
										key={entry.id}
									>
										<span>#{entry.roundNumber || "-"}</span>
										<span>{formatHnl(entry.amountMicro)}</span>
										<span>{entry.crashMultiplier.toFixed(2)}x</span>
										<span>
											{entry.payoutMicro ? formatHnl(entry.payoutMicro) : "-"}
										</span>
									</div>
								))
							)}
						</div>
					)}
				</aside>

				<section className="lempi-stage">
					<div className="lempi-stage__hud">
						<div className="lempi-stage__brand">
							<strong className="lempi-stage__title">Lempi Crash</strong>
							<span
								className={`lempi-stage__status ${isConnected ? "connected" : ""}`}
							/>
						</div>
						<div className="lempi-stage__balance">
							<span>Saldo</span>
							<strong>{formatHnl(balanceMicro, true)}</strong>
						</div>
					</div>
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

			{notice && (
				<div className="lempi-notice" role="status" aria-live="polite">
					{notice}
				</div>
			)}

			{!loadingComplete && (
				<LempiLoadingScreen
					ready={loaderReady}
					onComplete={handleLoadingComplete}
				/>
			)}
		</div>
	);
};
