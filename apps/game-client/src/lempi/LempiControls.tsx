import type React from "react";
import { useMemo, useState } from "react";
import {
	formatHnl,
	hnlToMicro,
	type LempiSlotId,
	useLempiStore,
} from "./LempiStore";

interface LempiControlsProps {
	placeBet: (
		slotId: LempiSlotId,
		amountText: string,
		autoCashout: number | null,
	) => void;
	cashOut: (slotId: LempiSlotId) => void;
}

const CHIPS = ["10", "50", "100", "500"];

export const LempiControls: React.FC<LempiControlsProps> = ({
	placeBet,
	cashOut,
}) => {
	return (
		<div className="lempi-controls">
			<LempiBetPanel slotId="A" placeBet={placeBet} cashOut={cashOut} />
			<LempiBetPanel slotId="B" placeBet={placeBet} cashOut={cashOut} />
		</div>
	);
};

const LempiBetPanel: React.FC<LempiControlsProps & { slotId: LempiSlotId }> = ({
	slotId,
	placeBet,
	cashOut,
}) => {
	const slot = useLempiStore((s) => s.slots[slotId]);
	const roundState = useLempiStore((s) => s.roundState);
	const balanceMicro = useLempiStore((s) => s.balanceMicro);
	const minBetMicro = useLempiStore((s) => s.minBetMicro);
	const maxBetMicro = useLempiStore((s) => s.maxBetMicro);
	const multiplier = useLempiStore((s) => s.multiplier);
	const [amount, setAmount] = useState(() => formatHnl(slot.amountMicro));
	const [autoEnabled, setAutoEnabled] = useState(false);
	const [autoCashout, setAutoCashout] = useState("2.00");

	const amountMicro = useMemo(() => hnlToMicro(amount || "0"), [amount]);
	const canLaunch =
		roundState === "BETTING_OPEN" &&
		slot.status === "IDLE" &&
		amountMicro >= minBetMicro &&
		amountMicro <= maxBetMicro &&
		amountMicro <= balanceMicro;
	const canCashOut = roundState === "ROLLING" && slot.status === "ACTIVE";
	const label =
		slot.status === "PENDING"
			? "ESPERANDO"
			: canCashOut
				? `RETIRAR ${multiplier.toFixed(2)}x`
				: slot.status === "CASHED_OUT"
					? `GANASTE ${slot.cashoutMultiplier?.toFixed(2)}x`
					: slot.status === "LOST"
						? "PERDIDO"
						: "LANZAR";

	return (
		<section className={`lempi-bet ${slot.status.toLowerCase()}`}>
			<div className="lempi-bet__tabs">
				<span>Apuesta</span>
				<label>
					<input
						type="checkbox"
						checked={autoEnabled}
						onChange={(event) => setAutoEnabled(event.target.checked)}
						disabled={slot.status !== "IDLE"}
					/>
					Auto
				</label>
			</div>

			<div className="lempi-bet__amount">
				<button
					type="button"
					onClick={() =>
						setAmount(String(Math.max(10, Number(amount || 0) - 10)))
					}
					disabled={slot.status !== "IDLE"}
				>
					-
				</button>
				<input
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
					disabled={slot.status !== "IDLE"}
					inputMode="decimal"
				/>
				<button
					type="button"
					onClick={() => setAmount(String(Number(amount || 0) + 10))}
					disabled={slot.status !== "IDLE"}
				>
					+
				</button>
			</div>

			<div className="lempi-bet__chips">
				{CHIPS.map((chip) => (
					<button
						type="button"
						key={chip}
						onClick={() => setAmount(chip)}
						disabled={slot.status !== "IDLE"}
					>
						{chip}
					</button>
				))}
			</div>

			{autoEnabled && (
				<div className="lempi-bet__auto">
					<span>Retiro auto</span>
					<input
						value={autoCashout}
						onChange={(event) => setAutoCashout(event.target.value)}
						disabled={slot.status !== "IDLE"}
						inputMode="decimal"
					/>
					<span>x</span>
				</div>
			)}

			<button
				type="button"
				className="lempi-bet__action"
				disabled={!canLaunch && !canCashOut}
				onClick={() => {
					if (canCashOut) {
						cashOut(slotId);
						return;
					}
					if (canLaunch) {
						const auto = autoEnabled ? Number.parseFloat(autoCashout) : null;
						placeBet(slotId, amount, Number.isFinite(auto) ? auto : null);
					}
				}}
			>
				<strong>{label}</strong>
				<span>{formatHnl(amountMicro, true)}</span>
			</button>
		</section>
	);
};
