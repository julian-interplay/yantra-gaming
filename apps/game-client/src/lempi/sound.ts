let audioContext: AudioContext | null = null;

export function playLempiTone(kind: "bet" | "cashout" | "crash"): void {
	try {
		audioContext ??= new AudioContext();
		const ctx = audioContext;
		const oscillator = ctx.createOscillator();
		const gain = ctx.createGain();
		const now = ctx.currentTime;
		const frequency = kind === "cashout" ? 720 : kind === "crash" ? 90 : 360;
		oscillator.type = kind === "cashout" ? "triangle" : "sine";
		oscillator.frequency.setValueAtTime(frequency, now);
		if (kind === "cashout")
			oscillator.frequency.exponentialRampToValueAtTime(980, now + 0.12);
		if (kind === "crash")
			oscillator.frequency.exponentialRampToValueAtTime(45, now + 0.22);
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(
			kind === "crash" ? 0.18 : 0.08,
			now + 0.02,
		);
		gain.gain.exponentialRampToValueAtTime(
			0.0001,
			now + (kind === "crash" ? 0.28 : 0.16),
		);
		oscillator.connect(gain);
		gain.connect(ctx.destination);
		oscillator.start(now);
		oscillator.stop(now + (kind === "crash" ? 0.32 : 0.18));
	} catch {
		// Audio is best-effort; browsers can block it until the first gesture.
	}
}
