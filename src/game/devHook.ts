/**
 * Dev/E2E read-only game-state hook. Owner: game-developer. Consumer: qa-tester (Playwright, tests/e2e).
 *
 * When enabled, `window.__game` is a getter that returns a fresh plain-data `DevGameState` on every access, so
 * `await page.evaluate(() => window.__game.phase)` always reads the current frame. Writing to it does nothing;
 * mutating the returned object does not touch the game. Enabled only in Vite dev builds (`import.meta.env.DEV`) or
 * when the page URL has an `e2e` query flag (`/?e2e`, `/?e2e=1`), so production players never see it.
 * The state is the one ClientGame rendered on its last update() (predicted local position, interpolated remotes).
 */
import type { CameraCase, HudSlotView, MeleeSwingView, SmokeCloudView, ViewmodelAction } from '../shared/contracts';
import type {
  ArmorTierOrNone,
  ConnectionStatus,
  GrenadeId,
  HealId,
  HeldId,
  ItemLevel,
  LookId,
  M2cSightType,
  M2cThrowableId,
  MatchPhase,
  PaneId,
  PlayerId,
  RocketId,
  ScopeId,
  SightType,
  Stance,
  Vec3,
} from '../shared/types';

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
  // ---- M2c ----
  /** Held weapon's level (null for fists and throwables). */
  weaponLevel: ItemLevel | null;
  /** Effective sight of the held item ('none' for fists, melee and throwables). */
  sight: M2cSightType;
  /**
   * PlayerView.smokeHidden: the camera's lines to this player's head AND chest both cross an opaque cloud, so the
   * renderer hides the name tag and spectate outline. Always false for the local player and the camera subject.
   */
  smokeHidden: boolean;
  /** PlayerView.swing: melee swing in progress (local: predicted; remotes: from meleeSwing events), else null. */
  swing: DevSwingState | null;
}

/** M2c: a melee swing as drawn (MeleeSwingView). */
export interface DevSwingState {
  weapon: MeleeSwingView['weapon'];
  /** 0..1 over the swing cycle. */
  progress: number;
  /** Progress at the hit frame. */
  hitFraction: number;
}

/** M2c: one local inventory slot as the HUD shows it (HudSlotView; predicted through a T switch and a G cycle). */
export interface DevSlotState {
  /** 0..3 (2 = fists or the melee weapon, 3 = the selected throwable). */
  slot: HudSlotView['slot'];
  /** null = empty slot. */
  item: HudSlotView['weapon'];
  /** Level badge; null for fists, throwables and empty slots. */
  level: ItemLevel | null;
  /** Mounted scope on a gun slot; null = built-in sight (and for non-guns). */
  scope: ScopeId | null;
  /** Effective sight now; 'none' for non-guns. */
  sight: M2cSightType;
}

/** M2c: the applied layout of the current match (server ref plus the client's own build). */
export interface DevLayoutState {
  mapId: string | null;
  /** Server's layout ref (WelcomeInfo.layout). */
  seed: number;
  version: number;
  hash: number;
  look: LookId;
  /** The client's own build (null when the client did not build the layout, e.g. no buildLayout dep). */
  clientVersion: number | null;
  clientHash: number | null;
  /** Client version and hash equal the server's; null when the client did not build. */
  hashMatched: boolean | null;
}

/** M2c: a live rocket as drawn (FrameView.rockets; rocketPosAt at serverTime). */
export interface DevRocketState {
  id: RocketId;
  ownerId: PlayerId;
  level: ItemLevel;
  pos: Vec3;
  vel: Vec3;
  origin: Vec3;
  firedAt: number;
}

/** M2c: a live smoke cloud as drawn (FrameView.smokes). */
export interface DevSmokeState {
  id: SmokeCloudView['id'];
  ownerId: PlayerId;
  /** Deploy point. */
  pos: Vec3;
  center: Vec3;
  /** Opaque radius now (smokeRadiusAt). */
  radius: number;
  deployedAt: number;
  fadeAt: number;
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
  // ---- M2c ----
  /** Applied layout of this match; null without a layout ref (before the first welcome, or a layout-less server). */
  layout: DevLayoutState | null;
  /** Look preset in use (FrameView.look; the baseline look of the map without a layout). */
  look: LookId;
  /** Held weapon's level, predicted (null for fists, throwables, or no local player). */
  weaponLevel: ItemLevel | null;
  /** The four local slots (index = slot), predicted; [] when not a participant. */
  localSlots: DevSlotState[];
  /** The spare-scope pouch, predicted through a T switch; null = empty or not a participant. */
  spareScope: ScopeId | null;
  /** Throwable slot selection, predicted (a G cycle shows at once); null when not a participant. */
  selectedThrowable: M2cThrowableId | null;
  /** Carried throwables per type (frags also in `grenades`); null when not a participant. */
  throwables: Record<M2cThrowableId, number> | null;
  /** 0..1 during a T sight switch, else null. */
  scopeSwapProgress: number | null;
  /** Local melee swing as drawn (predicted), else null. */
  meleeSwing: DevSwingState | null;
  /** 0..1 while a melee swing recovers (after the hit frame), null when ready. Predicted. */
  meleeRecovery: number | null;
  /** HudView.inSmoke: the camera is inside an opaque cloud. */
  inSmoke: boolean;
  /** Live rockets as drawn. */
  rockets: DevRocketState[];
  /** Live smoke clouds as drawn. */
  smokes: DevSmokeState[];
  /** Broken glass pane ids of this match, ascending. */
  brokenPanes: PaneId[];
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
