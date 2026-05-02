import type React from "react";
import { useEffect, useRef, useState } from "react";
import pilotRacing from "../assets/lempi/pilot-racing-side.png";
import "./LempiLoadingScreen.css";

interface LempiLoadingScreenProps {
	ready: boolean;
	onComplete: () => void;
}

const MIN_VISIBLE_MS = 2300;
const TICK_MS = 70;
const LAUNCH_MS = 920;

export const LempiLoadingScreen: React.FC<LempiLoadingScreenProps> = ({
	ready,
	onComplete,
}) => {
	const mountedAt = useRef(Date.now());
	const completedRef = useRef(false);
	const [progress, setProgress] = useState(7);
	const [launching, setLaunching] = useState(false);

	useEffect(() => {
		if (launching) return;
		const timer = window.setInterval(() => {
			const elapsed = Date.now() - mountedAt.current;
			const canFinish = ready && elapsed >= MIN_VISIBLE_MS;

			setProgress((current) => {
				if (canFinish) return Math.min(100, current + 5.5);

				const stagedTarget = Math.min(88, 12 + (elapsed / MIN_VISIBLE_MS) * 76);
				const drift = current < 55 ? 1.2 : 0.55;
				return Math.min(stagedTarget, current + drift);
			});
		}, TICK_MS);

		return () => window.clearInterval(timer);
	}, [launching, ready]);

	useEffect(() => {
		if (progress < 100 || completedRef.current) return;
		completedRef.current = true;
		setLaunching(true);
		const timer = window.setTimeout(onComplete, LAUNCH_MS);
		return () => window.clearTimeout(timer);
	}, [onComplete, progress]);

	const roundedProgress = Math.min(100, Math.round(progress));

	return (
		<div
			className={`lempi-loading ${launching ? "is-launching" : ""}`}
			role="status"
			aria-live="polite"
			style={
				{ "--load-progress": `${roundedProgress}%` } as React.CSSProperties
			}
		>
			<div className="lempi-loading__sky" aria-hidden="true" />
			<div className="lempi-loading__speed-lines" aria-hidden="true" />

			<div className="lempi-loading__content">
				<div className="lempi-loading__brand">
					<span>Lempi Crash</span>
					<strong>Preparando vuelo</strong>
				</div>

				<div className="lempi-loading__runway" aria-hidden="true">
					<div className="lempi-loading__track">
						<div className="lempi-loading__track-fill" />
						<div className="lempi-loading__ticks">
							<span />
							<span />
							<span />
							<span />
							<span />
						</div>
					</div>
					<img
						className="lempi-loading__pilot"
						src={pilotRacing}
						alt=""
						draggable={false}
					/>
					<div className="lempi-loading__flare" />
				</div>

				<div className="lempi-loading__readout">
					<span>Cargando</span>
					<strong>{roundedProgress}%</strong>
				</div>
			</div>
		</div>
	);
};
