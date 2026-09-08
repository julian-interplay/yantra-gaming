import type React from "react";
import { useEffect, useMemo } from "react";
import { SessionExpiryBanner } from "../ui/SessionExpiryBanner";
import { formatHnl, handLabel, type RpsHand, useRpsStore } from "./RpsStore";
import { RpsCanvas } from "./RpsCanvas";
import { useRpsSocket } from "./useRpsSocket";
import "./RpsShell.css";

const choices: RpsHand[] = ["ROCK", "PAPER", "SCISSORS"];

export const RpsShell: React.FC = () => {
	const { submitChoice } = useRpsSocket();
	const state = useRpsStore();

	const myParticipant = useMemo(
		() => state.participants.find((p) => p.id === state.participantId) ?? null,
		[state.participants, state.participantId],
	);
	const topPrize = state.prizeTable[0]?.amountMicro ?? "0";
	const activeMatch = state.matches.find((m) => m.id === state.activeMatchId);
	const disabled = !activeMatch || state.choicePending || state.selectedChoice != null;

	useEffect(() => {
		if (!state.notice) return;
		const timer = window.setTimeout(() => useRpsStore.getState().setNotice(null), 2400);
		return () => window.clearTimeout(timer);
	}, [state.notice]);

	return (
		<div className={`rps-page ${state.isConnected ? "is-online" : "is-offline"}`}>
			<SessionExpiryBanner />
			{!state.isConnected ? <div className="rps-reconnect">Reconectando...</div> : null}

			<main className="rps-shell">
				<section className="rps-stage">
					<div className="rps-stage__top">
						<div className="rps-brand">
							<span>Torneo</span>
							<strong>Piedra Papel Tijera</strong>
						</div>
						<div className="rps-jackpot">
							<span>Premio mayor</span>
							<strong>{formatHnl(topPrize)}</strong>
						</div>
					</div>

					<RpsCanvas />

					<div className="rps-status-strip">
						<div>
							<span>Jugadores</span>
							<strong>{state.participants.length}</strong>
						</div>
						<div>
							<span>Ronda</span>
							<strong>{state.currentRound || "-"}</strong>
						</div>
						<div>
							<span>Estado</span>
							<strong>{statusLabel(state.status)}</strong>
						</div>
					</div>
				</section>

				<aside className="rps-panel">
					<div className="rps-card rps-card--intro">
						<h1>{headline(state.status, myParticipant?.status, state.lastResult)}</h1>
						<p>{bodyCopy(state.status, myParticipant?.status, state.message)}</p>
					</div>

					<div className="rps-card rps-card--prizes">
						<div className="rps-card__head">
							<span>Premios</span>
							<strong>HNL</strong>
						</div>
						{state.prizeTable.length === 0 ? (
							<div className="rps-empty">Premios por confirmar</div>
						) : (
							state.prizeTable.slice(0, 4).map((row) => (
								<div className="rps-prize-row" key={row.rank}>
									<span>#{row.rank}</span>
									<strong>{formatHnl(row.amountMicro)}</strong>
								</div>
							))
						)}
					</div>

					<div className="rps-controls">
						{choices.map((choice) => (
							<button
								type="button"
								key={choice}
								className={`rps-choice rps-choice--${choice.toLowerCase()} ${
									state.selectedChoice === choice ? "is-selected" : ""
								}`}
								disabled={disabled}
								onClick={() => submitChoice(choice)}
							>
								<span>{handIcon(choice)}</span>
								<strong>{handLabel(choice)}</strong>
							</button>
						))}
					</div>

					<div className={`rps-result rps-result--${state.lastResult?.toLowerCase() ?? "idle"}`}>
						{resultCopy(state.lastResult, myParticipant?.rank)}
					</div>
				</aside>
			</main>

			{state.notice ? <div className="rps-notice">{state.notice}</div> : null}
		</div>
	);
};

function statusLabel(status: string): string {
	switch (status) {
		case "SCHEDULED":
		case "REGISTERING":
			return "Registro";
		case "RUNNING":
			return "En vivo";
		case "SETTLING":
			return "Pagando";
		case "COMPLETED":
			return "Final";
		case "CANCELLED":
			return "Cancelado";
		default:
			return "Espera";
	}
}

function headline(status: string, participantStatus?: string, result?: string | null): string {
	if (participantStatus === "WINNER") return "Ganaste";
	if (participantStatus === "ELIMINATED") return "Perdiste";
	if (result === "TIE") return "Empate";
	if (status === "NO_EVENT") return "Proximo torneo";
	if (status === "RUNNING") return "Elige tu jugada";
	if (status === "COMPLETED") return "Torneo finalizado";
	return "Juega gratis";
}

function bodyCopy(status: string, participantStatus?: string, message?: string | null): string {
	if (message) return message;
	if (participantStatus === "WINNER") return "El premio se acredita directo a tu billetera.";
	if (participantStatus === "ELIMINATED") return "Gracias por jugar. Espera el proximo torneo.";
	if (status === "RUNNING") return "Tienes pocos segundos para vencer a tu rival.";
	if (status === "NO_EVENT") return "Cuando haya un torneo disponible te registraremos automaticamente.";
	return "Te registramos y te buscaremos un oponente al iniciar.";
}

function resultCopy(result: string | null, rank?: number | null): string {
	if (result === "WIN") return "Ganaste la partida. Sigues vivo.";
	if (result === "LOSS") return rank ? `Terminaste en puesto #${rank}.` : "Quedaste eliminado.";
	if (result === "TIE") return "Misma jugada. Se repite la partida.";
	return "Sin buyback. Una oportunidad, un ganador.";
}

function handIcon(hand: RpsHand): string {
	switch (hand) {
		case "ROCK":
			return "R";
		case "PAPER":
			return "P";
		case "SCISSORS":
			return "T";
	}
}
