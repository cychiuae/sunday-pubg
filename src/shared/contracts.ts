/**
 * Client module facades. Owner: tech-lead. Phase B agents implement these EXACTLY (path + export name below).
 * src/main.ts types every module against these interfaces, so a mismatch fails `npm run typecheck`.
 *
 *   src/render/Renderer.ts      export class Renderer    implements IRenderer   (graphics-engineer)
 *     constructor(container: HTMLElement, map: MapData, bus: EventBus<GameEvents>, balance?: Balance)
 *       M1-fix: main.ts passes BALANCE; graphics-engineer can now drop the BALANCE fallback import.
 *   src/ui/Ui.ts                export class Ui          implements IUi         (ui-ux-designer)
 *     constructor(root: HTMLElement, bus: EventBus<GameEvents>, callbacks: UiCallbacks)
 *   src/audio/AudioEngine.ts    export class AudioEngine implements IAudio      (audio-designer)
 *     constructor(bus: EventBus<GameEvents>, options?: { lowHealthHp?: number; ... })
 *       Revision 1b: main.ts passes lowHealthHp = balance.player.lowHpThreshold (ADR 0003).
 *   src/net/NetClient.ts        export class NetClient   implements INetClient  (network-engineer)
 *     constructor()
 *   src/game/ClientGame.ts      export class ClientGame  implements IClientGame (game-developer)
 *     constructor(deps: ClientGameDeps)
 *   src/game/levels/index.ts    export function getMap(id: string): MapData; export const DEFAULT_MAP_ID: string
 *                                                                               (level-designer)
 *
 * Renderer, Ui and AudioEngine never import each other, ClientGame, or NetClient. They read FrameView/HudView and
 * subscribe to the bus. Only ClientGame emits on the bus.
 */
import type { Balance } from './balance';
import type { EventBus, GameEvents } from './events';
import type {
  AmmoId,
  ConnectionStatus,
  HealId,
  LootId,
  LootState,
  MapData,
  MatchPhase,
  PlayerId,
  PlayerInput,
  PlayerState,
  SimEvent,
  SlotIndex,
  Vec2,
  Vec3,
  WeaponId,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from './types';

// ---------------------------------------------------------------------------------------------
// Settings (Ui owns the settings screen and persistence in localStorage key SETTINGS_STORAGE_KEY)
// ---------------------------------------------------------------------------------------------
export interface Settings {
  /** Multiplier on radians-per-pixel base (ClientGame defines the base). Range 0.1..3. */
  mouseSensitivity: number;
  /** 0..1 */
  masterVolume: number;
  invertY: boolean;
  /**
   * M1-fix (producer: Ui settings screen + normalizeSettings; consumer: main.ts -> IRenderer.setQuality).
   * Absent = DEFAULT_QUALITY. (Kept out of DEFAULT_SETTINGS until Ui persists it, so Ui's settings tests stay valid.)
   */
  quality?: QualityLevel;
}
/** M1-fix: graphics preset. Same union as src/render/quality.ts QualityPreset. */
export type QualityLevel = 'low' | 'medium' | 'high';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['low', 'medium', 'high'];
export const DEFAULT_QUALITY: QualityLevel = 'medium';
export const DEFAULT_SETTINGS: Settings = { mouseSensitivity: 1, masterVolume: 0.8, invertY: false };
export const SETTINGS_STORAGE_KEY = 'bsp.settings.v1';

// ---------------------------------------------------------------------------------------------
// FrameView: what the renderer draws this frame (built by ClientGame)
// ---------------------------------------------------------------------------------------------
export interface CameraView {
  /** 'follow' = over-the-shoulder on a player; 'orbit' = slow attract orbit around `target` (title/lobby). */
  mode: 'follow' | 'orbit';
  /** Pivot point: followed player's feet + eyeHeight. In orbit mode, the orbit centre. */
  target: Vec3;
  /** Look yaw/pitch (radians, types.ts convention). In orbit mode yaw is the orbit angle. */
  yaw: number;
  pitch: number;
  /** Metres behind the pivot along -aim. Renderer may shorten it to avoid terrain/props. */
  distance: number;
  /** Metres to the right of the pivot (over-the-shoulder). */
  shoulderOffset: number;
  fovDeg: number;
}

export interface PlayerView {
  /** Interpolated (remotes) or predicted (local) state. Treat as read-only. */
  state: PlayerState;
  isLocal: boolean;
  isSpectateTarget: boolean;
}

export interface FrameView {
  /** Client monotonic seconds since start (animation clock). */
  time: number;
  /** Estimated server ms "now" (not the interpolation render time). */
  serverTime: number;
  phase: MatchPhase;
  localId: PlayerId | null;
  camera: CameraView;
  /** All match participants, dead ones included (alive = false). */
  players: PlayerView[];
  loot: LootState[];
  /** Loot the interact prompt points at (outline/highlight), or null. */
  highlightLootId: LootId | null;
  zone: ZoneState | null;
}

export interface ListenerPose {
  pos: Vec3;
  yaw: number;
}

export interface IRenderer {
  /** The WebGL canvas (ClientGame uses it for pointer lock and mouse input). */
  readonly canvas: HTMLCanvasElement;
  render(view: FrameView, dt: number): void;
  /** Reads container size; call on window resize. */
  resize(): void;
  /** Camera world pose after the last render(), for the audio listener. */
  getListenerPose(): ListenerPose;
  /** M1-fix (Renderer already implements it): switch graphics preset at runtime. main.ts calls it on settings change. */
  setQuality?(quality: QualityLevel): void;
  /**
   * Revision 1b (producer: graphics-engineer; ADR 0003 §5). 'ok' normally; 'restoring' from webglcontextlost until
   * webglcontextrestored; 'failed' once restore has not happened within CONTEXT_RESTORE_TIMEOUT_MS (constants.ts).
   * May return to 'ok' if the context comes back late. main.ts polls it once per frame and forwards changes to
   * IUi.setGraphicsStatus. Absent = always 'ok'.
   */
  getGraphicsStatus?(): GraphicsStatus;
  dispose(): void;
}

/** Revision 1b: WebGL context health, bridged Renderer -> main.ts -> Ui. */
export type GraphicsStatus = 'ok' | 'restoring' | 'failed';

// ---------------------------------------------------------------------------------------------
// HudView: what the DOM UI shows this frame (built by ClientGame)
// ---------------------------------------------------------------------------------------------
export interface HudSlotView {
  slot: SlotIndex;
  /** null = empty slot (slot 2 is always 'fists'). */
  weapon: WeaponId | null;
  /** Rounds in magazine; null for fists/empty. */
  mag: number | null;
}

export interface HudLocalView {
  id: PlayerId;
  name: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  armor: number;
  maxArmor: number;
  kills: number;
  pos: Vec3;
  yaw: number;
  slots: [HudSlotView, HudSlotView, HudSlotView];
  activeSlot: SlotIndex;
  weapon: WeaponId;
  /** Active weapon magazine; null for fists. */
  mag: number | null;
  magSize: number | null;
  /** Reserve ammo for the active weapon's ammo type; null for fists. */
  reserve: number | null;
  heals: Record<HealId, number>;
  /** 0..1 while reloading, else null. */
  reloadProgress: number | null;
  /** 0..1 while healing, else null. */
  healProgress: number | null;
  healItem: HealId | null;
  dropping: boolean;
  outsideZone: boolean;
  /** M1-fix (producer: hudBuilder): carry limits = balance items.<heal>.maxStack, so the prompt can warn when full. */
  healMax?: Record<HealId, number>;
  /** M1-fix (producer: hudBuilder): items.<ammo>.maxCarry for the active weapon's ammo; null for fists. */
  reserveMax?: number | null;
  /** M1-fix (producer: hudBuilder): ammo type of the active weapon; null for fists. */
  ammoType?: AmmoId | null;
  /**
   * Revision 1b (producer: hudBuilder, from balance.player.lowHpThreshold; omitted when that key is absent).
   * Low health = alive && hp > 0 && hp <= lowHpThreshold (absolute HP, same rule as the audio heartbeat).
   * Consumer: Ui, falling back to its own default only while the field is absent (ADR 0003).
   */
  lowHpThreshold?: number;
}

export interface HudZoneView {
  phaseIndex: number;
  phaseCount: number;
  shrinking: boolean;
  /** True during the final collapse (phaseIndex === phaseCount). */
  isFinal: boolean;
  /** Whole seconds until the current wait/shrink ends (>= 0). */
  secondsLeft: number;
  center: Vec2;
  radius: number;
  targetCenter: Vec2;
  targetRadius: number;
  dps: number;
}

export interface HudMinimapView {
  /** Same object every frame; draw coastline/POIs from it. */
  map: MapData;
  /** Marker for the local player, or the spectate target when spectating. null in lobby. */
  self: { x: number; z: number; yaw: number } | null;
}

export interface HudView {
  connection: ConnectionStatus;
  /** True after the server's welcome (name accepted). */
  joined: boolean;
  phase: MatchPhase;
  countdownSecondsLeft: number | null;
  resultsSecondsLeft: number | null;
  lobbyCount: number;
  targetPlayers: number;
  aliveCount: number;
  totalPlayers: number;
  /** null when not a participant in the current match. */
  local: HudLocalView | null;
  zone: HudZoneView | null;
  minimap: HudMinimapView;
  spectate: {
    targetId: PlayerId;
    targetName: string;
    targetHp: number;
    /** M1-fix (producer: hudBuilder): balance player.maxHp, for the HP bar scale. */
    targetMaxHp?: number;
  } | null;
  pointerLocked: boolean;
  /** Current effective spread for the crosshair, degrees (0 for fists). */
  crosshairSpreadDeg: number;
  /** M1-fix (producer: hudBuilder): vertical FOV the camera uses this frame (= FrameView.camera.fovDeg). */
  cameraFovDeg?: number;
  /** M1-fix (producer: hudBuilder): balance match.deathScreenSeconds (death card before spectate). */
  deathScreenSeconds?: number;
}

export interface UiCallbacks {
  /** Title screen "Play" with a validated, trimmed name (1..MAX_NAME_LENGTH chars). Also used for Rejoin. */
  onJoin(name: string): void;
  /** Fired on every change and once right after construction with the loaded settings. */
  onSettingsChanged(settings: Settings): void;
  /** Results screen "Play again": dismiss results and show the lobby (server re-queues automatically). */
  onPlayAgain(): void;
  /** "Click to play"/"Resume" button. Runs inside the click handler so pointer lock is allowed. */
  onResume(): void;
  /**
   * M1-fix (producer: Ui; main.ts wires it to IAudio.playUi). Ui calls it on button click / hover / slider input.
   * This is the only path for UI sounds; AudioEngine attaches no document click/hover listeners.
   */
  playUiSound?(id: UiSoundId): void;
}

export interface IUi {
  update(hud: HudView): void;
  getSettings(): Settings;
  /**
   * Revision 1b (consumer: ui-ux-designer; caller: main.ts, only on change). 'failed': show a blocking "graphics
   * reset, please reload" overlay with a Reload button (location.reload()). 'restoring': optional small notice.
   * 'ok': hide both. Strings from narrative-designer.
   */
  setGraphicsStatus?(status: GraphicsStatus): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------
/** M1-fix: UI interaction sounds (AudioEngine.playUi cue ids). */
export type UiSoundId = 'ui.click' | 'ui.hover' | 'ui.slider';

export interface IAudio {
  /** Create/resume the AudioContext. Called on the first user gesture; idempotent. */
  unlock(): void;
  setListener(pos: Vec3, yaw: number): void;
  /** 0..1 */
  setVolume(master: number): void;
  update(dt: number): void;
  /** M1-fix (AudioEngine already implements it): non-positional UI sound. Dropped before unlock(). */
  playUi?(id: UiSoundId): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Network client
// ---------------------------------------------------------------------------------------------
export interface NetHandlers {
  onWelcome(welcome: WelcomeInfo): void;
  /** Every received snapshot, loot already re-filled. Called after it is pushed into the interpolation buffer. */
  onSnapshot(snapshot: WorldSnapshot): void;
  onEvents(events: SimEvent[], serverTime: number): void;
  /** `reason` is an error code from the server ('full', 'bad_name', 'bad_version') or a close reason. */
  onStatus(status: ConnectionStatus, reason?: string): void;
}

/** Remote view at a past render time. */
export interface InterpolatedWorld {
  renderTime: number;
  /** Positions lerped, yaw/pitch lerpAngle'd, discrete fields from the newer snapshot. */
  players: PlayerState[];
}

export interface INetClient {
  /** Handlers are invoked synchronously from the socket callbacks. ClientGame queues and processes in update(). */
  setHandlers(handlers: NetHandlers): void;
  /** Opens the socket and sends `join` once open. Reconnecting = call connect again. */
  connect(url: string, name: string): void;
  disconnect(): void;
  /** No-op unless connected. */
  sendInput(input: PlayerInput): void;
  readonly status: ConnectionStatus;
  readonly playerId: PlayerId | null;
  /** Smoothed round-trip time in ms (from ping/pong). */
  readonly rttMs: number;
  /** Estimated current server clock ms. */
  serverNow(): number;
  /**
   * Players interpolated at `renderTime` (server ms; ClientGame passes serverNow() - INTERP_DELAY_MS).
   * Clamps to the oldest/newest buffered snapshot (no extrapolation). null before the first snapshot.
   * Players present in only one of the two bracketing snapshots are taken from that snapshot as-is.
   */
  getInterpolated(renderTime: number): InterpolatedWorld | null;
  latestSnapshot(): WorldSnapshot | null;
}

// ---------------------------------------------------------------------------------------------
// Client game controller
// ---------------------------------------------------------------------------------------------
export interface ClientGameDeps {
  bus: EventBus<GameEvents>;
  net: INetClient;
  /** Element that receives mouse input and pointer lock (the renderer canvas). Keyboard listens on window. */
  inputTarget: HTMLElement;
  balance: Balance;
  getMap: (id: string) => MapData;
  /** Initial map shown before welcome (orbit camera on the title screen). */
  initialMap: MapData;
  /** Full WebSocket URL, e.g. ws://localhost:5173/ws. */
  serverUrl: string;
}

export interface ClientFrame {
  frame: FrameView;
  hud: HudView;
}

export interface IClientGame {
  join(name: string): void;
  playAgain(): void;
  setSettings(settings: Settings): void;
  /** Must be called from a user-gesture handler. */
  requestPointerLock(): void;
  /**
   * Once per animation frame, dt in seconds (clamped by caller to <= 0.1). Processes queued net messages
   * (emitting bus events), runs local fixed steps (input send + prediction), interpolates remotes and returns views.
   */
  update(dt: number): ClientFrame;
  dispose(): void;
}
