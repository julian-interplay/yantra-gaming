import type { GamePlugin } from '@yantra/game-contract';
import crashMinimal from '@yantra-games/crash-minimal';
import ketapolaDice from '@yantra-games/ketapola-dice';
import lempiCrash from '@yantra-games/lempi-crash';

/**
 * Static plugin registry. Each game module exports a default GamePlugin; we
 * import them by name here and register by `gameCode`. Adding a new game is
 * two lines: add the dependency to apps/rgs-server/package.json and a row
 * below. No dynamic fs-scan — the registry is auditable at build time and
 * a broken plugin fails the compile, not a running server.
 */
const plugins: Record<string, GamePlugin> = {
  [ketapolaDice.gameCode]: ketapolaDice,
  [crashMinimal.gameCode]: crashMinimal,
  [lempiCrash.gameCode]: lempiCrash,
};

export function getPlugin(gameCode: string): GamePlugin | null {
  return plugins[gameCode] ?? null;
}

export function listPlugins(): GamePlugin[] {
  return Object.values(plugins);
}

export function listGameCodes(): string[] {
  return Object.keys(plugins);
}
