import {
	Application,
	Assets,
	Container,
	Graphics,
	Sprite,
	Text,
	type Texture,
} from "pixi.js";
import type React from "react";
import { useEffect, useRef } from "react";
import backgroundUrl from "../assets/lempi/background.png";
import pilotUrl from "../assets/lempi/pilot.png";
import { useLempiStore } from "./LempiStore";

export const LempiCanvas: React.FC = () => {
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let destroyed = false;
		let cleanup: (() => void) | null = null;

		(async () => {
			const app = new Application();
			await app.init({
				background: 0x06070b,
				resizeTo: container,
				preference: "webgl",
				antialias: true,
				autoDensity: true,
				resolution: Math.min(window.devicePixelRatio, 2),
			});
			if (destroyed) {
				app.destroy(true);
				return;
			}

			container.appendChild(app.canvas);

			const bgTexture = await Assets.load<Texture>(backgroundUrl);
			const pilotTexture = await Assets.load<Texture>(pilotUrl);

			const world = new Container();
			const bg1 = new Sprite(bgTexture);
			const bg2 = new Sprite(bgTexture);
			const shade = new Graphics();
			const pilot = new Sprite(pilotTexture);
			const flame = new Graphics();
			const multiplierText = new Text({
				text: "1.00x",
				style: {
					fill: 0xffffff,
					fontFamily: "Orbitron, system-ui",
					fontSize: 72,
					fontWeight: "900",
					dropShadow: { color: 0x000000, alpha: 0.5, blur: 5, distance: 3 },
				},
			});
			const statusText = new Text({
				text: "",
				style: {
					fill: 0xf0c84c,
					fontFamily: "Rajdhani, system-ui",
					fontSize: 22,
					fontWeight: "900",
					letterSpacing: 2,
					dropShadow: { color: 0x000000, alpha: 0.45, blur: 4, distance: 2 },
				},
			});

			pilot.anchor.set(0.5);
			pilot.scale.set(0.14);
			multiplierText.anchor.set(0.5);
			statusText.anchor.set(0.5);

			world.addChild(bg1, bg2, shade, flame, pilot, multiplierText, statusText);
			app.stage.addChild(world);

			let scroll = 0;
			const layout = () => {
				const w = app.screen.width;
				const h = app.screen.height;
				for (const bg of [bg1, bg2]) {
					const scale =
						Math.max(h / bgTexture.height, w / bgTexture.width) * 1.05;
					bg.scale.set(scale);
					bg.y = (h - bgTexture.height * scale) / 2;
				}
				bg1.x = -scroll;
				bg2.x = bg1.x + bg1.width - 2;

				shade.clear();
				shade.rect(0, 0, w, h);
				shade.fill({ color: 0x05050a, alpha: 0.34 });
				shade.rect(0, 0, w, h);
				shade.fill({ color: 0x1b1024, alpha: 0.16 });

				multiplierText.x = w * 0.61;
				multiplierText.y = h * 0.36;
				multiplierText.style.fontSize = Math.max(34, Math.min(72, w * 0.12));

				statusText.x = w * 0.61;
				statusText.y = h * 0.17;
				statusText.style.fontSize = Math.max(14, Math.min(20, w * 0.036));
			};

			const resizeObserver = new ResizeObserver(layout);
			resizeObserver.observe(container);
			layout();

			app.ticker.add(() => {
				const state = useLempiStore.getState();
				const w = app.screen.width;
				const h = app.screen.height;
				const displayMultiplier =
					state.roundState === "RESULT" && state.crashMultiplier
						? state.crashMultiplier
						: state.multiplier;
				multiplierText.text =
					state.roundState === "BETTING_OPEN"
						? `${state.timeRemaining}s`
						: `${displayMultiplier.toFixed(2)}x`;
				statusText.text =
					state.roundState === "BETTING_OPEN"
						? "PREPARATE"
						: state.roundState === "RESULT"
							? "EXPLOTO"
							: state.roundState === "ROLLING"
								? "VOLANDO"
								: "";

				const speed =
					state.roundState === "ROLLING"
						? 0.55 +
							Math.min(4.6, Math.max(0, state.multiplier - 1) ** 0.9 * 0.48)
						: 0.12;
				scroll = (scroll + speed) % Math.max(1, bg1.width - 2);
				bg1.x = -scroll;
				bg2.x = bg1.x + bg1.width - 2;

				const fly = state.roundState === "ROLLING";
				const crashed = state.roundState === "RESULT";
				const targetX = fly
					? w * 0.26 + Math.min(w * 0.14, state.multiplier * 10)
					: w * 0.17;
				const targetY = crashed
					? h * 0.62
					: fly
						? h * 0.58 - Math.min(h * 0.2, state.multiplier * 9)
						: h * 0.66;
				pilot.x += (targetX - pilot.x) * 0.08;
				pilot.y += (targetY - pilot.y) * 0.08;
				pilot.rotation = crashed ? 0.75 : fly ? -0.28 : -0.12;
				pilot.alpha = crashed ? 0.65 : 1;

				flame.clear();
				if (fly) {
					flame.ellipse(pilot.x - 44, pilot.y + 24, 28, 9);
					flame.fill({ color: 0xffd04d, alpha: 0.78 });
					flame.ellipse(pilot.x - 58, pilot.y + 29, 38, 13);
					flame.fill({ color: 0xf04a31, alpha: 0.34 });
				}
			});

			cleanup = () => {
				resizeObserver.disconnect();
				app.destroy(true, { children: true });
			};
		})().catch(() => {});

		return () => {
			destroyed = true;
			cleanup?.();
		};
	}, []);

	return <div className="lempi-canvas" ref={containerRef} />;
};
