/**
 * Dev/E2E read-only game-state hook. Owner: game-developer. Consumer: qa-tester (Playwright, tests/e2e).
 *
 * When enabled, `window.__game` is a getter that returns a fresh plain-data `DevGameState` on every access, so
 * `await page.evaluate(() => window.__game.phase)` always reads the current frame. Writing to it does nothing;
 * mutating the returned object does not touch the game. Enabled only in Vite dev builds (`import.meta.env.DEV`) or
 * when the page URL has an `e2e` query flag (`/?e2e`, `/?e2e=1`), so production players never see it.
 * The state is the one ClientGame rendered on its last update() (predicted local position, interpolated remotes).
 */
import type { ConnectionStatus, MatchPhase, PlayerId, Vec3, WeaponId } from '../shared/types';

export const DEV_HOOK_KEY = '__game';

declare global {
  interface Window {
    /** Dev/E2E only (see src/game/devHook.ts). Undefined in production unless the URL has `?e2e`. */
    readonly __game?: DevGameState;
  }
}

export interface DevPlayerState {
  id: PlayerId;
  name: string;
  alive: boolean;
  isBot: boolean;
  hp: number;
  /** View position (predicted for the local player, interpolated for remotes). */
  pos: Vec3;
}

export interface DevGameState {
  connection: ConnectionStatus;
  /** Welcome received (name accepted). */
  joined: boolean;
  phase: MatchPhase;
  /** null before the first snapshot. */
  matchId: number | null;
  localId: PlayerId | null;
  /** False when dead or not a participant of the current match. */
  localAlive: boolean;
  localHp: number | null;
  localArmor: number | null;
  /** Rendered local feet position (predicted while alive); null when not a participant. */
  localPos: Vec3 | null;
  localWeapon: WeaponId | null;
  localKills: number;
  aliveCount: number;
  totalPlayers: number;
  lobbyCount: number;
  spectateTargetId: PlayerId | null;
  pointerLocked: boolean;
  /** Estimated server clock (ms). */
  serverTime: number;
  /** Unacknowledged local inputs held for replay. */
  pendingInputs: number;
  /** Distance (m) of the last reconciliation correction; 0 before the first one. */
  lastCorrection: number;
  /** Count of ground loot in the latest snapshot. */
  lootCount: number;
  /** Every match participant as the client renders it. */
  players: DevPlayerState[];
}

/** True in Vite dev builds, or when the URL has an `e2e` query parameter. */
export function devHookEnabled(): boolean {
  if (import.meta.env?.DEV) return true;
  try {
    return typeof location !== 'undefined' && new URLSearchParams(location.search).has('e2e');
  } catch {
    return false;
  }
}

/**
 * Define the `__game` getter on `target` (default `globalThis`, which is `window` in the browser) when enabled.
 * Returns a function that removes it again (ClientGame.dispose). Does nothing outside a browser unless a target
 * is given.
 */
export function installDevHook(
  read: () => DevGameState,
  opts: { target?: object; enabled?: boolean } = {},
): () => void {
  const target = opts.target ?? (typeof window !== 'undefined' ? window : null);
  const enabled = opts.enabled ?? devHookEnabled();
  if (!target || !enabled) return () => {};
  const getter = (): DevGameState => structuredClone(read());
  Object.defineProperty(target, DEV_HOOK_KEY, { configurable: true, enumerable: false, get: getter });
  return () => {
    const desc = Object.getOwnPropertyDescriptor(target, DEV_HOOK_KEY);
    if (desc?.get === getter) Reflect.deleteProperty(target, DEV_HOOK_KEY);
  };
}
