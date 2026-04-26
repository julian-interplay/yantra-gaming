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
import idolUrl from "../assets/lempi/idol.png";
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
			const idolTexture = await Assets.load<Texture>(idolUrl);

			const world = new Container();
			const bg1 = new Sprite(bgTexture);
			const bg2 = new Sprite(bgTexture);
			const shade = new Graphics();
			const idol = new Sprite(idolTexture);
			const pilot = new Sprite(pilotTexture);
			const flame = new Graphics();
			const multiplierText = new Text({
				text: "1.00x",
				style: {
					fill: 0xffffff,
					fontFamily: "Orbitron, system-ui",
					fontSize: 92,
					fontWeight: "900",
					dropShadow: { color: 0x000000, alpha: 0.6, blur: 8, distance: 4 },
				},
			});
			const statusText = new Text({
				text: "",
				style: {
					fill: 0xf1c84b,
					fontFamily: "Rajdhani, system-ui",
					fontSize: 32,
					fontWeight: "800",
					letterSpacing: 2,
				},
			});

			pilot.anchor.set(0.5);
			pilot.scale.set(0.28);
			idol.anchor.set(0.5, 1);
			idol.alpha = 0.7;
			multiplierText.anchor.set(0.5);
			statusText.anchor.set(0.5);

			world.addChild(
				bg1,
				bg2,
				shade,
				idol,
				flame,
				pilot,
				multiplierText,
				statusText,
			);
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

				idol.x = Math.min(w - 120, w * 0.86);
				idol.y = h - 16;
				idol.scale.set(Math.min(0.34, Math.max(0.18, w / 3600)));

				multiplierText.x = w * 0.55;
				multiplierText.y = h * 0.42;
				multiplierText.style.fontSize = Math.max(54, Math.min(132, w * 0.105));

				statusText.x = w * 0.5;
				statusText.y = h * 0.18;
				statusText.style.fontSize = Math.max(22, Math.min(38, w * 0.032));
			};

			const resizeObserver = new ResizeObserver(layout);
			resizeObserver.observe(container);
			layout();

			const unsubscribe = useLempiStore.subscribe((state) => {
				multiplierText.text =
					state.roundState === "RESULT" && state.crashMultiplier
						? `${state.crashMultiplier.toFixed(2)}x`
						: `${state.multiplier.toFixed(2)}x`;
				statusText.text =
					state.roundState === "BETTING_OPEN"
						? `GET READY  ${state.timeRemaining}s`
						: state.roundState === "RESULT"
							? "CRASHED"
							: state.roundState === "ROLLING"
								? "FLYING"
								: "";
			});

			app.ticker.add(() => {
				const state = useLempiStore.getState();
				const w = app.screen.width;
				const h = app.screen.height;
				const speed =
					state.roundState === "ROLLING"
						? 2.4 + Math.min(8, state.multiplier * 0.7)
						: 0.35;
				scroll = (scroll + speed) % Math.max(1, bg1.width - 2);
				bg1.x = -scroll;
				bg2.x = bg1.x + bg1.width - 2;

				const fly = state.roundState === "ROLLING";
				const crashed = state.roundState === "RESULT";
				const targetX = fly
					? w * 0.31 + Math.min(w * 0.16, state.multiplier * 14)
					: w * 0.2;
				const targetY = crashed
					? h * 0.64
					: fly
						? h * 0.58 - Math.min(h * 0.22, state.multiplier * 13)
						: h * 0.68;
				pilot.x += (targetX - pilot.x) * 0.08;
				pilot.y += (targetY - pilot.y) * 0.08;
				pilot.rotation = crashed ? 0.75 : fly ? -0.28 : -0.12;
				pilot.alpha = crashed ? 0.65 : 1;

				flame.clear();
				if (fly) {
					flame.ellipse(pilot.x - 88, pilot.y + 48, 56, 18);
					flame.fill({ color: 0xffd04d, alpha: 0.78 });
					flame.ellipse(pilot.x - 115, pilot.y + 58, 76, 26);
					flame.fill({ color: 0xf04a31, alpha: 0.34 });
				}
			});

			cleanup = () => {
				unsubscribe();
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
