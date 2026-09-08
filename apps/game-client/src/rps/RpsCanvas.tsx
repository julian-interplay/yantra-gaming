import {
	Application,
	Assets,
	Container,
	Graphics,
	Rectangle,
	Sprite,
	Text,
	type Texture,
} from "pixi.js";
import type React from "react";
import { useEffect, useRef } from "react";
import assetSheetUrl from "../assets/rps/rps-arcade-sheet.png";
import { type RpsHand, useRpsStore } from "./RpsStore";

const frames = {
	logo: new Rectangle(20, 150, 430, 350),
	prize: new Rectangle(1210, 145, 430, 300),
	rock: new Rectangle(515, 155, 205, 250),
	paper: new Rectangle(750, 150, 205, 255),
	scissors: new Rectangle(1010, 150, 205, 255),
	confetti: new Rectangle(815, 455, 420, 210),
	lose: new Rectangle(1265, 455, 375, 215),
};

function atlasTexture(base: Texture, frame: Rectangle): Texture {
	return new Texture({ source: base.source, frame });
}

function handFrame(hand: RpsHand | null): keyof typeof frames {
	if (hand === "PAPER") return "paper";
	if (hand === "SCISSORS") return "scissors";
	return "rock";
}

export const RpsCanvas: React.FC = () => {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const host = ref.current;
		if (!host) return;
		let destroyed = false;
		let cleanup: (() => void) | null = null;

		(async () => {
			const app = new Application();
			await app.init({
				background: 0x07111d,
				resizeTo: host,
				antialias: true,
				autoDensity: true,
				resolution: Math.min(window.devicePixelRatio, 2),
			});
			if (destroyed) {
				app.destroy(true);
				return;
			}
			host.appendChild(app.canvas);
			const texture = await Assets.load<Texture>(assetSheetUrl);
			const atlas = {
				logo: atlasTexture(texture, frames.logo),
				prize: atlasTexture(texture, frames.prize),
				rock: atlasTexture(texture, frames.rock),
				paper: atlasTexture(texture, frames.paper),
				scissors: atlasTexture(texture, frames.scissors),
				confetti: atlasTexture(texture, frames.confetti),
				lose: atlasTexture(texture, frames.lose),
			};

			const stage = new Container();
			const bg = new Graphics();
			const grid = new Graphics();
			const light = new Graphics();
			const arena = new Graphics();
			const logo = new Sprite(atlas.logo);
			const prize = new Sprite(atlas.prize);
			const confettiBurst = new Sprite(atlas.confetti);
			const loseBurst = new Sprite(atlas.lose);
			const leftHand = new Sprite(atlas.rock);
			const rightHand = new Sprite(atlas.scissors);
			const choiceGhosts = [
				new Sprite(atlas.rock),
				new Sprite(atlas.paper),
				new Sprite(atlas.scissors),
			];
			const center = new Text({
				text: "VS",
				style: {
					fill: 0xffd447,
					fontFamily: "Impact, system-ui",
					fontSize: 76,
					fontWeight: "900",
					dropShadow: { color: 0x000000, alpha: 0.5, blur: 6, distance: 3 },
				},
			});
			const status = new Text({
				text: "",
				style: {
					fill: 0xffffff,
					fontFamily: "system-ui",
					fontSize: 26,
					fontWeight: "900",
					dropShadow: { color: 0x000000, alpha: 0.65, blur: 5, distance: 2 },
				},
			});
			for (const sprite of [logo, prize, confettiBurst, loseBurst, leftHand, rightHand, ...choiceGhosts]) {
				sprite.anchor.set(0.5);
			}
			confettiBurst.alpha = 0;
			loseBurst.alpha = 0;
			logo.alpha = 0.82;
			prize.alpha = 0.9;
			for (const ghost of choiceGhosts) ghost.alpha = 0.2;
			center.anchor.set(0.5);
			status.anchor.set(0.5);
			stage.addChild(bg, grid, light, logo, prize, ...choiceGhosts, arena, leftHand, rightHand, confettiBurst, loseBurst, center, status);
			app.stage.addChild(stage);

			const confetti = Array.from({ length: 44 }, (_, i) => ({
				x: Math.random(),
				y: Math.random(),
				speed: 0.6 + Math.random() * 1.4,
				color: [0xff20d6, 0x20e7ff, 0xffd447, 0xffffff][i % 4]!,
				size: 3 + Math.random() * 6,
			}));

			const layout = () => {
				const w = app.screen.width;
				const h = app.screen.height;
				logo.x = w * 0.18;
				logo.y = h * 0.27;
				logo.scale.set(Math.min(0.56, w / 1550));
				prize.x = w * 0.84;
				prize.y = h * 0.28;
				prize.scale.set(Math.min(0.5, w / 1750));
				leftHand.x = w * 0.27;
				leftHand.y = h * 0.58;
				rightHand.x = w * 0.73;
				rightHand.y = h * 0.58;
				leftHand.scale.set(Math.min(0.64, w / 1180));
				rightHand.scale.set(Math.min(0.64, w / 1180));
				choiceGhosts.forEach((ghost, i) => {
					ghost.x = w * (0.38 + i * 0.12);
					ghost.y = h * 0.28;
					ghost.scale.set(Math.min(0.34, w / 2200));
				});
				center.x = w * 0.5;
				center.y = h * 0.54;
				status.x = w * 0.5;
				status.y = h * 0.18;
				confettiBurst.x = w * 0.5;
				confettiBurst.y = h * 0.48;
				confettiBurst.scale.set(Math.min(0.86, w / 1120));
				loseBurst.x = w * 0.5;
				loseBurst.y = h * 0.48;
				loseBurst.scale.set(Math.min(0.78, w / 1200));
			};
			const ro = new ResizeObserver(layout);
			ro.observe(host);
			layout();

			let t = 0;
			app.ticker.add(() => {
				t += app.ticker.deltaTime;
				const state = useRpsStore.getState();
				const w = app.screen.width;
				const h = app.screen.height;
				const match = state.matches.find((m) => m.id === state.activeMatchId);
				const remaining = match
					? Math.max(0, Math.ceil((new Date(match.endsAt).getTime() - Date.now()) / 1000))
					: 0;
				status.text =
					state.status === "NO_EVENT"
						? "ESPERANDO TORNEO"
						: state.status === "COMPLETED"
							? "TORNEO FINALIZADO"
							: match
								? `${remaining}s PARA ELEGIR`
								: "BUSCANDO OPONENTE";
				leftHand.texture = atlas[handFrame(state.selectedChoice)];
				rightHand.texture =
					state.lastResult === "WIN"
						? atlas.rock
						: state.lastResult === "LOSS"
							? atlas.paper
							: atlas.scissors;

				const baseHandScale = Math.min(0.64, w / 1180);
				const pulse = 1 + Math.sin(t * 0.08) * 0.055;
				leftHand.scale.set(baseHandScale * pulse);
				rightHand.scale.set(baseHandScale * (1 + Math.cos(t * 0.08) * 0.045));
				leftHand.rotation = Math.sin(t * 0.045) * 0.08 - 0.08;
				rightHand.rotation = Math.cos(t * 0.045) * 0.08 + 0.08;
				center.rotation = Math.sin(t * 0.04) * 0.025;
				center.scale.set(1 + Math.sin(t * 0.07) * 0.05);
				logo.x = w * 0.18 + Math.sin(t * 0.025) * 10;
				prize.y = h * 0.28 + Math.cos(t * 0.03) * 8;
				confettiBurst.alpha += (((state.status === "COMPLETED" || state.lastResult === "WIN") ? 0.55 : 0) - confettiBurst.alpha) * 0.08;
				loseBurst.alpha += ((state.lastResult === "LOSS" ? 0.45 : 0) - loseBurst.alpha) * 0.08;

				bg.clear();
				bg.rect(0, 0, w, h);
				bg.fill({ color: 0x07111d });
				bg.circle(w * 0.2 + Math.sin(t * 0.015) * 35, h * 0.22, Math.max(w, h) * 0.28);
				bg.fill({ color: 0xff20d6, alpha: 0.13 });
				bg.circle(w * 0.82 + Math.cos(t * 0.014) * 35, h * 0.24, Math.max(w, h) * 0.27);
				bg.fill({ color: 0x20e7ff, alpha: 0.12 });
				bg.circle(w * 0.5, h * 0.95, Math.max(w, h) * 0.36);
				bg.fill({ color: 0x1b3dff, alpha: 0.1 });

				grid.clear();
				for (let i = 0; i < 18; i += 1) {
					const y = h * 0.74 + i * 18;
					const width = i * 26;
					grid.moveTo(w * 0.5 - width, y);
					grid.lineTo(w * 0.5 + width, y);
				}
				for (let i = -8; i <= 8; i += 1) {
					const x = w * 0.5 + i * 42;
					grid.moveTo(x, h * 0.75);
					grid.lineTo(w * 0.5 + i * 115, h);
				}
				grid.stroke({ color: 0x1ce7ff, alpha: 0.12, width: 1 });

				light.clear();
				const sweep = (Math.sin(t * 0.02) + 1) / 2;
				light.moveTo(w * (0.16 + sweep * 0.68), h * 0.18);
				light.lineTo(w * (0.08 + sweep * 0.6), h * 0.74);
				light.lineTo(w * (0.28 + sweep * 0.56), h * 0.74);
				light.closePath();
				light.fill({ color: 0xffffff, alpha: 0.045 });

				arena.clear();
				arena.roundRect(w * 0.1, h * 0.32, w * 0.8, h * 0.42, 26);
				arena.fill({ color: 0x081a2c, alpha: 0.28 });
				arena.stroke({ color: state.selectedChoice ? 0xffd447 : 0x1ce7ff, width: 2.5, alpha: 0.52 });
				arena.moveTo(w * 0.5, h * 0.34);
				arena.lineTo(w * 0.5, h * 0.72);
				arena.stroke({ color: 0xff21d8, width: 2, alpha: 0.28 });
				for (let i = 0; i < 3; i += 1) {
					const ghost = choiceGhosts[i]!;
					ghost.y = h * 0.28 + Math.sin(t * 0.05 + i) * 8;
					ghost.alpha = state.selectedChoice ? 0.12 : 0.22 + Math.sin(t * 0.04 + i) * 0.05;
				}

				if (state.status === "COMPLETED" || state.lastResult === "WIN") {
					for (const bit of confetti) {
						bit.y = (bit.y + bit.speed * 0.0028) % 1;
						arena.rect(bit.x * w, bit.y * h, bit.size, bit.size * 1.8);
						arena.fill({ color: bit.color, alpha: 0.76 });
					}
				}
			});

			cleanup = () => {
				ro.disconnect();
				app.destroy(true, { children: true });
			};
		})().catch(() => {});

		return () => {
			destroyed = true;
			cleanup?.();
		};
	}, []);

	return <div className="rps-canvas" ref={ref} />;
};
