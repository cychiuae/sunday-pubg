/**
 * Dev/E2E read-only game-state hook. Owner: game-developer. Consumer: qa-tester (Playwright, tests/e2e).
 *
 * When enabled, `window.__game` is a getter that returns a fresh plain-data `DevGameState` on every access, so
 * `await page.evaluate(() => window.__game.phase)` always reads the current frame. Writing to it does nothing;
 * mutating the returned object does not touch the game. Enabled only in Vite dev builds (`import.meta.env.DEV`) or
 * when the page URL has an `e2e` query flag (`/?e2e`, `/?e2e=1`), so production players never see it.
 * The state is the one ClientGame rendered on its last update() (predicted local position, interpolated remotes).
 */
import type { CameraCase, ViewmodelAction } from '../shared/contracts';
import type { ArmorTierOrNone, ConnectionStatus, GrenadeId, HealId, HeldId, MatchPhase, PlayerId, SightType, Stance, Vec3 } from '../shared/types';

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
  /** M2a: target stance, transition source and progress (1 = settled). */
  stance: Stance;
  stanceFrom: Stance;
  stanceProgress: number;
  vestTier: ArmorTierOrNone;
  helmetTier: ArmorTierOrNone;
  weapon: HeldId;
}

/** M2a: a live grenade as drawn (FrameView.grenades). */
export interface DevGrenadeState {
  id: GrenadeId;
  ownerId: PlayerId;
  pos: Vec3;
  resting: boolean;
  explodesAt: number;
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
  /** Rendered local feet position (predicted while alive); null when not a participant. */
  localPos: Vec3 | null;
  /** Local look angles in radians (the mouse-driven yaw/pitch sent with inputs; yaw 0 = -Z, pitch > 0 = up). */
  localYaw: number;
  localPitch: number;
  /** M2a: HeldId ('grenade' in slot 3). */
  localWeapon: HeldId | null;
  /** M2a: predicted local stance (null when not a live participant). */
  stance: Stance | null;
  stanceFrom: Stance | null;
  /** 0..1, 1 = settled. */
  stanceProgress: number | null;
  /** M2a: ADS engaged (predicted adsMs > 0). */
  ads: boolean;
  /** M2a: predicted ADS progress 0..1 (adsMs / adsTimeMs). */
  adsProgress: number;
  /** M2a: cosmetic camera blend 0..1 and the scope view flag (camera.firstPerson). */
  adsCameraBlend: number;
  scoped: boolean;
  /** M2a: sight of the item in hand; null without a live local player. */
  sight: SightType | null;
  /** M2a: worn armor tiers (0 = none) and durability (null = none). */
  vestTier: ArmorTierOrNone;
  helmetTier: ArmorTierOrNone;
  vestDurability: number | null;
  helmetDurability: number | null;
  /** M2a: carried grenades. */
  grenades: number;
  /** M2a: a grenade is cooking in hand (predicted or authoritative). */
  cooking: boolean;
  /** M2a: remaining cook fuse (ms) as shown by the HUD ring; null when not cooking. */
  cookFuseMs: number | null;
  /** M2a: the throw arc preview is shown this frame. */
  grenadeArc: boolean;
  /** M2a: live grenades in the world (extrapolated). */
  liveGrenades: DevGrenadeState[];
  /** M2a: camera vertical FOV and the scope view flag. */
  cameraFovDeg: number;
  cameraFirstPerson: boolean;
  /** M2a: camera pivot height above the rendered local feet (the stance eye height); null without a live local. */
  cameraEyeHeight: number | null;
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
  // ---- M2b ----
  /** Map of the current match (null before the first welcome). */
  mapId: string | null;
  /** CameraView.view of the last frame (null before the first update). */
  cameraView: CameraCase | null;
  /** Local drop stage (HudView.drop.stage), null on foot or not a live participant. */
  dropPhase: 'aboard' | 'freefall' | 'chute' | null;
  aboard: boolean;
  /** Room the client is in (null in the browser or before hello). */
  roomId: string | null;
  roomCode: string | null;
  isHost: boolean;
  /** FrameView.viewmodel summary (null in 3P cases). */
  viewmodel: { item: HeldId | HealId; action: ViewmodelAction; visible: boolean } | null;
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
