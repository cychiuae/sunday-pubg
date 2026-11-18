/**
 * Client module facades. Owner: tech-lead. Phase B agents implement these EXACTLY (path + export name below).
 * src/main.ts types every module against these interfaces, so a mismatch fails `npm run typecheck`.
 *
 *   src/render/Renderer.ts      export class Renderer    implements IRenderer   (graphics-engineer)
 *     constructor(container: HTMLElement, map: MapData, bus: EventBus<GameEvents>, balance: Balance)
 *       balance is required (main.ts passes BALANCE); Renderer must not import BALANCE itself.
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
import type { Balance, ZoneTheme } from './balance';
import type { EventBus, GameEvents } from './events';
import type {
  AmmoId,
  Appearance,
  ArmorId,
  ArmorTier,
  ArmorTierOrNone,
  DropPhase,
  ConnectionStatus,
  GrenadeId,
  HealId,
  HeldId,
  LootId,
  LootState,
  MapData,
  MapId,
  MapPickVia,
  MapVoteOption,
  MatchPhase,
  MemberId,
  RejectCode,
  RoomId,
  RoomMapMode,
  RoomPhase,
  RoomSettings,
  RoomState,
  RoomSummary,
  PlayerId,
  PlayerInput,
  PlayerState,
  SightType,
  SimEvent,
  SlotIndex,
  Stance,
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
  /**
   * M2a (producer: Ui settings screen + normalizeSettings; consumer: ClientGame input). RMB behaviour.
   * Absent = DEFAULT_ADS_MODE ('hold'). In 'toggle' ClientGame flips a latch on each RMB press and sends the latch
   * as the held PlayerInput.ads. The latch also clears on death, on any slot change, and when sprint is pressed.
   * Reload, heal and stance transitions do NOT clear it, so a toggled ADS resumes after them exactly like a held RMB.
   */
  adsMode?: AdsMode;
  /**
   * M2a (producer: Ui; consumer: ClientGame look). Extra multiplier on look speed while aiming, on top of the
   * automatic 1 / lerp(1, adsZoom, adsProgress). Range 0.1..3. Absent = DEFAULT_ADS_SENSITIVITY (1).
   */
  adsSensitivity?: number;
  /**
   * M2b (camera.md "Field of view"; producer Ui, consumer ClientGame): HORIZONTAL FOV at the 16:9 reference, degrees,
   * FP_FOV_MIN_DEG..FP_FOV_MAX_DEG. ClientGame converts it once to a vertical FOV (Hor+). Absent = DEFAULT_FP_FOV_DEG.
   */
  fovDeg?: number;
  /** M2b: effective camera head bob (Ui resolves its auto/on/off pref against reduced motion). Absent = true. */
  headBob?: boolean;
  /**
   * M2b: effective reduced motion (Ui resolves its 'system' pref with prefers-reduced-motion). ClientGame and the
   * renderer turn off camera bob, landing dip, recoil roll, FOV punch and camera shake. Absent = false.
   */
  reducedMotion?: boolean;
}
/** M2b: FOV setting range and default (a settings range like mouse sensitivity, so it lives here, not in balance). */
export const FP_FOV_MIN_DEG = 70;
export const FP_FOV_MAX_DEG = 100;
export const DEFAULT_FP_FOV_DEG = 80;
/** M2b: reference aspect for Settings.fovDeg (horizontal at 16:9). */
export const FP_FOV_REFERENCE_ASPECT = 16 / 9;
/** M2a. */
export type AdsMode = 'hold' | 'toggle';
export const ADS_MODES: readonly AdsMode[] = ['hold', 'toggle'];
export const DEFAULT_ADS_MODE: AdsMode = 'hold';
export const DEFAULT_ADS_SENSITIVITY = 1;
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
  /**
   * 'follow' = mouse-look camera on a pivot (first person when `firstPerson`, else the 3P boom); 'orbit' = slow attract
   * orbit around `target` (title, death cam, results). M2b: unchanged; `view` says which case it is.
   */
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
  /**
   * M2a: ClientGame already folds ADS into distance / shoulderOffset / fovDeg (ADR 0004 §5):
   * fovDeg = cameraFovDeg / ads.zoom; distance and shoulderOffset lerp toward clientFeel.adsCameraDistance /
   * adsCameraShoulderOffset by ads.cameraBlend. The renderer applies them as-is.
   */
  fovDeg: number;
  /**
   * M2a: scope view. When true the renderer puts the camera exactly at `target` (the local eye; distance and
   * shoulderOffset are 0), uses `fovDeg`, and hides the local player's body, wearables and held item. The
   * full-screen reticle overlay is Ui's (HudView.ads.scoped). Always false in orbit mode and while spectating.
   * M2b (first person, camera.md): true in every FP case (on foot, freefall, chute, FP spectate), not only scoped.
   */
  firstPerson: boolean;
  /** M2b: the camera case (see CameraCase). */
  view: CameraCase;
  /** M2b: the player whose eye the FP camera uses (hide that body), or the 3P subject; null for orbit/carrier. */
  subjectId: PlayerId | null;
  /**
   * M2b: camera roll in radians (recoil roll, camera.md "Recoil"). Roll about the view axis keeps the screen centre on
   * the shot ray. FOV punch is already folded into fovDeg. 0 with reduced motion.
   */
  roll: number;
}

/** M2b (camera.md "Viewmodel"): what the arms do this frame. Lengths come from balance (reloadMs, useMs, swapMs...). */
export type ViewmodelAction = 'idle' | 'swapIn' | 'reload' | 'heal' | 'cook' | 'throw' | 'punch';

/**
 * M2b (ADR 0005 §9): first-person viewmodel state, built by ClientGame (pure data; the renderer owns poses and
 * animation curves, graphics-designer owns VIEWMODEL_POSES). For the local player from prediction and snapshot.local;
 * for an FP spectate target from its interpolated PlayerState (anim flags; no action progress beyond what anim shows).
 */
export interface ViewmodelView {
  playerId: PlayerId;
  /** Skin tone and sleeve. */
  appearance: Appearance;
  /** Sleeve tint or vest edge (only if cheap). */
  vestTier: ArmorTierOrNone;
  /** In hand: the HeldId, or the heal item while healing. */
  item: HeldId | HealId;
  /** Grenade pin pulled (VIEWMODEL item 'grenade_cooking'). */
  cooking: boolean;
  action: ViewmodelAction;
  /** 0..1 through `action` (0 for 'idle'). */
  actionProgress: number;
  /** = AdsView.cameraBlend (spectate: eased from anim.ads). Pose blend hip -> ads. */
  adsBlend: number;
  /** false while the scope overlay shows, and when dead or aboard. */
  visible: boolean;
  /**
   * Monotonic count of this player's shots (local: from shotFired isLocal, so it is RTT-late like M1 muzzle flashes).
   * The renderer applies clientFeel.fpRecoil[weapon] once per increment (stacking cap 2x).
   */
  shotCount: number;
  /** Pose blend for the stance (the camera already moves with the eye height). */
  stance: Stance;
  stanceFrom: Stance;
  stanceProgress: number;
  /** Drop pose: skydive arms in freefall, toggles in the chute; null on foot. */
  dropPhase: DropPhase | null;
  /** Bob phase in radians (one vertical cycle per footstep stride) and amount 0..1 (speed, stance and ADS factors applied; 0 airborne). */
  bobPhase: number;
  bobAmount: number;
  sprinting: boolean;
  /** Look speed in rad/s (sway lag input), smoothed. */
  lookRate: { yaw: number; pitch: number };
  /** Multiplier for viewmodel bob and sway: 1, or clientFeel.reducedMotionViewmodelFactor with reduced motion. */
  motionScale: number;
}

/**
 * M2b (ADR 0005 §9, camera.md "Camera mode per state"): which camera case this frame is. Producer: ClientGame.
 * - 'firstPerson': mode 'follow', firstPerson true, target = the eye (+ capped bob). On foot, freefall, chute, FP
 *   spectate. No boom collision, no body fade; the renderer hides `subjectId`'s body and draws FrameView.viewmodel.
 * - 'carrier': aboard. mode 'follow', firstPerson false, target = the carrier, distance = 3P boom. Renderer draws the
 *   carrier and no aboard characters.
 * - 'chase': V spectate chase. mode 'follow', firstPerson false, the M1 3P boom with collision and wall fade.
 * - 'death': the death cam (mode 'orbit' around the body or killer). 'results': results orbit. 'title': title/lobby orbit.
 */
export type CameraCase = 'firstPerson' | 'carrier' | 'chase' | 'death' | 'results' | 'title';

/**
 * M2a (ADR 0004 §5): local ADS state for this frame, built by ClientGame from the PREDICTED MovementState.adsMs.
 * The same object goes to FrameView.ads (renderer: ADS weapon pose) and HudView.ads (Ui: crosshair dot, red dot,
 * scope overlay). null when there is no live local player (spectating, lobby).
 */
export interface AdsView {
  /** Sight of the item in hand (balance weapons.<id>.sight; 'none' for fists and the grenade). */
  sight: SightType;
  /** Sim progress 0..1 (adsMs / adsTimeMs). Drops to 0 instantly when ADS ends. */
  progress: number;
  /**
   * Cosmetic 0..1: equals `progress` while aiming; after an exit it eases to 0 over clientFeel.adsExitBlendMs.
   * Drives the camera pull-in and the crosshair shrink so leaving ADS does not pop.
   */
  cameraBlend: number;
  /** Current FOV divisor = lerp(1, weapons[w].adsZoom, cameraBlend). Look sensitivity is divided by it. */
  zoom: number;
  /** sight is scope_4x / scope_8x AND progress === 1: Ui shows the scope overlay, camera.firstPerson is true. */
  scoped: boolean;
}

/**
 * M2a (ADR 0004 §3): a live grenade as drawn this frame. ClientGame extrapolates snapshot/event state to
 * net.serverNow() with the shared `stepGrenade` (exact; grenades never touch players), capped at
 * GRENADE_EXTRAPOLATION_MAX_MS past its source sample.
 */
export interface GrenadeView {
  id: GrenadeId;
  ownerId: PlayerId;
  pos: Vec3;
  vel: Vec3;
  /** Server ms. Blink faster as explodesAt - FrameView.serverTime shrinks. */
  explodesAt: number;
  /** vel is zero (resting). */
  resting: boolean;
}

/**
 * M2a (ADR 0004 §4): predicted throw arc for the local player, from `predictGrenadeArc` (src/shared/sim/grenade.ts),
 * called by ClientGame while the grenade slot is active and ready or cooking. Renderer draws the polyline and a
 * ring of `radius` at `end`. null when not holding a grenade, dead, swapping, or during throw recovery.
 */
export interface GrenadeArcView {
  /** Sampled path from the throw origin, one point per sim tick (SIM_DT), bounces included. */
  points: Vec3[];
  /** Where the preview stops: fuse end, rest point, or the end of clientFeel.grenadeArcPreviewSeconds. */
  end: Vec3;
  endReason: 'fuse' | 'rest' | 'time';
  /** items.grenade.radius (blast ring). */
  radius: number;
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
  /** M2a: live grenades, extrapolated to serverTime (see GrenadeView). */
  grenades: GrenadeView[];
  /** M2a: local throw preview, or null. */
  grenadeArc: GrenadeArcView | null;
  /** M2a: local ADS (same object as HudView.ads), or null. */
  ads: AdsView | null;
  /** M2b: first-person arms, or null in 3P cases. */
  viewmodel: ViewmodelView | null;
  /** M2b: effective reduced motion (Settings.reducedMotion): no explosion or freefall camera shake. */
  reducedMotion: boolean;
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
  /** null = empty slot (slot 2 is always 'fists'; M2a: slot 3 is always 'grenade', dimmed when count is 0). */
  weapon: HeldId | null;
  /** Rounds in magazine; null for fists/empty/grenade. */
  mag: number | null;
  /** M2a: slot 3 only, carried grenades (LocalPlayerState.grenades). null for slots 0-2. */
  count: number | null;
}

/** M2a: one worn armor piece on the HUD (armor.md "What the UI must show"). */
export interface HudArmorView {
  id: ArmorId;
  tier: ArmorTier;
  /** Raw float; display ceil(durability). */
  durability: number;
  /** items.<id>.durability (fresh value; bar = durability / maxDurability). */
  maxDurability: number;
}

/** M2a: grenade being cooked in hand (fuse ring around the crosshair). */
export interface HudCookView {
  /** max(0, cookExplodesAt - serverNow()), ms. Ring turns red when <= 1000. */
  fuseRemainingMs: number;
  /** items.grenade.fuseMs. */
  fuseMs: number;
}

/** M2a: a live grenade near the local player (danger indicator, visible through walls). */
export interface HudGrenadeDangerView {
  id: GrenadeId;
  /** Horizontal distance from the local player, m. Listed only when 3D distance <= items.grenade.radius + 2. */
  distance: number;
  /**
   * Bearing relative to the camera yaw, radians in (-PI, PI]: 0 = straight ahead, +PI/2 = to the right.
   * Ui draws the icon on screen when roughly ahead, else at the screen edge (same convention as the damage arc).
   */
  bearing: number;
  /** Server ms (blink / urgency). */
  explodesAt: number;
  /**
   * M2a addendum (producer: game-developer grenades.ts; consumer: Ui urgency ring): max(0, explodesAt - serverNow()),
   * ms, on the same clock as HudCookView.fuseRemainingMs. Optional until the producer fills it.
   */
  fuseRemainingMs?: number;
}

/**
 * M2a addendum: why RMB is held but ADS is not engaging (Ui hint `hud.ads.<reason>`). Sprint is not a reason: holding
 * RMB already cancels sprint in the sim. Swap, stance transitions and sight 'none' are short or obvious and get no hint.
 */
export type AdsBlockReason = 'reloading' | 'healing';

export interface HudLocalView {
  id: PlayerId;
  name: string;
  alive: boolean;
  hp: number;
  maxHp: number;
  /** M2a (replaces armor/maxArmor): worn vest, null = empty slot (dim outline). */
  vest: HudArmorView | null;
  /** M2a: worn helmet, null = empty slot. */
  helmet: HudArmorView | null;
  kills: number;
  pos: Vec3;
  yaw: number;
  /** M2a: four slots, index = SlotIndex (3 = grenade). */
  slots: [HudSlotView, HudSlotView, HudSlotView, HudSlotView];
  activeSlot: SlotIndex;
  /** M2a: HeldId ('grenade' in slot 3). */
  weapon: HeldId;
  /** Active weapon magazine; null for fists and the grenade. */
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
  /** M2a: carried grenades and items.grenade.maxCarry. */
  grenades: number;
  grenadeMax: number;
  /** M2a: grenade in hand being cooked, else null. */
  cook: HudCookView | null;
  /** M2a: predicted stance (stance icon). */
  stance: Stance;
  stanceFrom: Stance;
  /** M2a: 0..1, 1 = settled (icon animates while < 1). */
  stanceProgress: number;
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
  /** Same object every frame; draw coastline/POIs from it (M2b indoor: walls, floor zones, plateaus). */
  map: MapData;
  /** Marker for the local player, or the spectate target when spectating. null in lobby. */
  self: { x: number; z: number; yaw: number } | null;
  /**
   * M2b (drop.md "What the UI must show"; producer ClientGame from MatchState.route): the dashed route, the eject
   * marker and the carrier icon (null before playing.startsAt and after route.endsAt). null when there is no route.
   */
  route: MinimapRouteView | null;
}

/** M2b. */
export interface MinimapRouteView {
  from: Vec2;
  to: Vec2;
  eject: Vec2;
  /** Carrier position and heading (radians, yaw convention) now; null before the flight starts or after it ends. */
  carrier: { pos: Vec2; heading: number } | null;
}

/** M2b (drop.md "Aboard" / "Freefall"): local drop HUD. null when the local player is neither aboard nor dropping. */
export interface HudDropView {
  stage: 'aboard' | 'freefall' | 'chute';
  /** Aboard: whole seconds until jumping is allowed (0 = allowed now). */
  noJumpSecondsLeft: number;
  /** Aboard: whole seconds until the auto-eject. */
  ejectSecondsLeft: number;
  /** Participants still aboard (MatchState.aboardCount). */
  aboardCount: number;
  /** Freefall/chute: height above the terrain or floor below, m. */
  altitude: number;
  /** drop.chuteDeployHeight (marked on the altitude bar). */
  deployHeight: number;
  /** Freefall: a jump press would open the parachute now (manualDeploy and dropMs >= minFreefallMs). */
  canDeploy: boolean;
}

// ---------------------------------------------------------------------------------------------
// M2b rooms view model (ADR 0006; docs/ui/UI.md §12.10). Built by ClientGame from lobby messages each frame.
// ---------------------------------------------------------------------------------------------
export interface RoomsView {
  /** Where the server has this client. 'none' before the hello reply. */
  location: 'none' | 'browser' | 'room';
  /** Non-null iff location === 'browser'. */
  browser: RoomBrowserView | null;
  /** Non-null iff location === 'room'. */
  room: RoomView | null;
  /** A lobby request in flight (spinners, read-only fields). Cleared by its reply or reject. */
  pending: 'create' | 'join' | 'leave' | 'start' | 'cancel' | 'settings' | null;
}

export interface RoomLimitsView {
  roomNameMax: number;
  maxHumansMin: number;
  maxHumansMax: number;
  maxHumansDefault: number;
  fillBotsDefault: boolean;
  /** Maps the server offers, in display order (vote options = these + 'random'). */
  maps: MapId[];
  codeLength: number;
  codeAlphabet: string;
  /** Server MAP env pin, or null. */
  pinnedMapId: MapId | null;
}

export interface RoomBrowserView {
  /** false until the first list arrives (skeleton rows). */
  loaded: boolean;
  /** Public rooms only, in server order. */
  rooms: RoomListEntryView[];
  /** false when the server reported max_rooms on the last create. */
  canCreate: boolean;
  limits: RoomLimitsView;
}

export interface RoomListEntryView {
  id: RoomId;
  /** Display name (null names already rendered from `room.create.name.default` with hostName). */
  name: string;
  mapMode: RoomMapMode;
  mapId: MapId | null;
  humans: number;
  maxHumans: number;
  status: RoomPhase;
  /** Whole seconds since the match started (client-ticked from phaseSince); null unless 'playing'. */
  elapsedSeconds: number | null;
}

export interface RoomMemberView {
  id: MemberId;
  name: string;
  isHost: boolean;
  isLocal: boolean;
  ready: boolean;
  /** A participant of the running match (alive or dead). */
  inMatch: boolean;
  spectating: boolean;
}

export interface MapVoteView {
  /** The server's maps in order, then 'random'. */
  options: { option: MapVoteOption; count: number }[];
  mine: MapVoteOption | null;
  /** Voting closed for this match (after the lock) or pinned. */
  locked: boolean;
  pinned: boolean;
}

export interface RoomView {
  id: RoomId;
  code: string;
  /** Display name (default rendered client-side, ADR 0006 Q5). */
  name: string;
  settings: RoomSettings;
  phase: RoomPhase;
  hostId: MemberId;
  isLocalHost: boolean;
  /** Humans, oldest first. */
  members: RoomMemberView[];
  botSeats: number;
  localReady: boolean;
  /** Joined mid-match and watching the running match. */
  localSpectating: boolean;
  /** Host may press Start now (waiting phase and the rooms.md minimum). */
  canStart: boolean;
  /** Why Start is disabled for the host (string key suffix), else null. */
  startBlockedReason: 'needTwoWithoutBots' | null;
  /** Host may Cancel now (countdown before the lock). */
  canCancel: boolean;
  /** Countdown whole seconds left; null outside 'countdown'. */
  countdownSecondsLeft: number | null;
  autoStart: { reason: 'allReady' | 'timer'; secondsLeft: number } | null;
  /** null when the map mode is fixed. */
  vote: MapVoteView | null;
  map: { id: MapId; via: MapPickVia } | null;
  /** The client is still building `map` (set on welcome, cleared after the first frame rendered with it). */
  mapLoading: boolean;
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
    /** M2b: FP from their eye or the V chase cam. */
    view: 'firstPerson' | 'chase';
  } | null;
  /** M2b (UI.md §13.5): which camera the player looks through. */
  cameraView: 'firstPerson' | 'chase' | 'orbit';
  pointerLocked: boolean;
  /**
   * Current effective spread for the crosshair, degrees (0 for fists). M2a: the full combat.md cone
   * (ADS A x stance S x move M x air J), from the predicted movement state.
   */
  crosshairSpreadDeg: number;
  /** M2a: local ADS (same object as FrameView.ads), or null when there is no live local player. */
  ads: AdsView | null;
  /**
   * M2a: live grenades within items.grenade.radius + items.grenade.dangerMargin (default 2) m of the local player,
   * nearest first. Empty otherwise.
   */
  grenadeDanger: HudGrenadeDangerView[];
  /**
   * M2a addendum (producer: hudBuilder from the predicted ads input and snapshot.local timers; consumer: Ui hint):
   * non-null while the local player holds ADS (PlayerInput.ads) with a sighted weapon and ADS is blocked by a reload
   * or a heal. Optional until the producer fills it; absent = no hint.
   */
  adsBlocked?: AdsBlockReason | null;
  /** M1-fix (producer: hudBuilder): vertical FOV the camera uses this frame (= FrameView.camera.fovDeg). */
  cameraFovDeg: number;
  /** M1-fix (producer: hudBuilder): balance match.deathScreenSeconds (death card before spectate). */
  deathScreenSeconds?: number;
  /** M2b (ADR 0006): browser and waiting room. */
  rooms: RoomsView;
  /** M2b: local drop HUD (aboard, freefall, chute), else null. */
  drop: HudDropView | null;
  /** M2b (ADR 0005 §7): zone fiction of the current map (`hud.<theme>.*` strings). */
  zoneTheme: ZoneTheme;
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
  /**
   * Revision 1b, BUG-001 (producer: Ui death card "Spectate" button; main.ts wires it to IClientGame.requestSpectate).
   * Skip the rest of the death screen and start spectating now.
   */
  onSpectate?: () => void;
  /**
   * M2b rooms intents (ADR 0006; main.ts wires each to the IClientGame method of the same name). Every one is
   * ignored by ClientGame when not valid in the current state. Map ids come from RoomLimitsView.maps.
   */
  onRefreshRooms?(): void;
  onCreateRoom?(settings: RoomSettingsInput): void;
  onJoinRoom?(target: RoomJoinTarget): void;
  onLeaveRoom?(): void;
  onSetRoomSettings?(patch: Partial<RoomSettingsInput>): void;
  onStartMatch?(): void;
  onCancelCountdown?(): void;
  onSetReady?(ready: boolean): void;
  onVote?(option: MapVoteOption | null): void;
  onKick?(memberId: MemberId): void;
}

/** M2b: what the create dialog and the host settings dialog send (RoomSettings with `name` as typed). */
export type RoomSettingsInput = RoomSettings;
/** M2b: join a listed room by id, or any room by its code (already normalizeRoomCode'd). */
export type RoomJoinTarget = { roomId: RoomId } | { code: string };

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
  /**
   * M2a addendum (ADR 0004 addendum A2; producer: main.ts from FrameView each frame; implementer: audio-designer).
   * Live grenades as drawn this frame, plus FrameView.serverTime. Audio plays the positional fuse tick for grenades
   * near the listener (range is audio tuning, about 8 m) and skips the local player's own cooked grenade, which already
   * has the 2D cook tick. Plain read-only data, the same array the renderer gets; do not keep references across frames.
   */
  setGrenades?(grenades: readonly GrenadeView[], serverTime: number): void;
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
  /** M2b (ADR 0006): hello reply (server maps, pin, limits). Handlers stay optional so test doubles can omit them. */
  onHello?(hello: ServerHello): void;
  /** M2b: full public list (on subscribe), then each delta already applied by NetClient. */
  onRoomList?(rooms: RoomSummary[]): void;
  /** M2b: you entered a room (memberId is yours in it). */
  onRoomJoined?(room: RoomState, memberId: MemberId): void;
  /** M2b: room state changed. */
  onRoom?(room: RoomState): void;
  onRoomLeft?(reason: 'left' | 'kicked' | 'closed'): void;
  /** M2b: a lobby request was refused (non-fatal). `req` = the request's `t`. */
  onReject?(req: string, code: RejectCode, retryAfterMs?: number): void;
}

/** M2b: the server's reply to `hello`. */
export interface ServerHello {
  serverTime: number;
  maps: MapId[];
  pinnedMap: MapId | null;
  limits: { maxRooms: number; roomNameMax: number; maxHumansMin: number; maxHumansMax: number; maxHumansDefault: number; fillBotsDefault: boolean };
}

/** Remote view at a past render time. */
export interface InterpolatedWorld {
  renderTime: number;
  /**
   * Positions lerped, yaw/pitch lerpAngle'd, discrete fields from the newer snapshot. M2a: stanceProgress is lerped
   * when stance and stanceFrom match in both snapshots, else taken from the newer one. Grenades are NOT
   * interpolated here (ClientGame extrapolates them, ADR 0004 §3).
   */
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
  /**
   * M2b rooms (ADR 0006 §3). No-ops unless connected. `connect(url, name)` then sends
   * `hello` (with the per-browser client token, CLIENT_TOKEN_STORAGE_KEY) instead of `join`. On every `welcome`
   * NetClient resets its delta decoder and snapshot buffer (a new World restarts ticks).
   */
  listRooms(subscribe: boolean): void;
  createRoom(settings: RoomSettingsInput): void;
  joinRoom(target: RoomJoinTarget): void;
  leaveRoom(): void;
  setRoomSettings(patch: Partial<RoomSettingsInput>): void;
  startMatch(): void;
  cancelCountdown(): void;
  setReady(ready: boolean): void;
  vote(option: MapVoteOption | null): void;
  kick(memberId: MemberId): void;
}

/**
 * M2b (ADR 0006 §5, director ruling Q6): localStorage key of the random per-browser client token sent in `hello`.
 * It only keys the kick rejoin cooldown (weak by design; never an IP).
 */
export const CLIENT_TOKEN_STORAGE_KEY = 'bsp.clientToken.v1';

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
   * Revision 1b, BUG-001 (producer: game-developer). Skip the remaining deathScreenSeconds and start spectating on
   * the next update(). No-op unless the local player is dead and not yet spectating (idempotent).
   */
  requestSpectate?(): void;
  /**
   * Once per animation frame, dt in seconds (clamped by caller to <= 0.1). Processes queued net messages
   * (emitting bus events), runs local fixed steps (input send + prediction), interpolates remotes and returns views.
   */
  update(dt: number): ClientFrame;
  /** M2b rooms intents (ADR 0006), forwarded from UiCallbacks by main.ts. */
  refreshRooms(): void;
  createRoom(settings: RoomSettingsInput): void;
  joinRoom(target: RoomJoinTarget): void;
  leaveRoom(): void;
  setRoomSettings(patch: Partial<RoomSettingsInput>): void;
  startMatch(): void;
  cancelCountdown(): void;
  setReady(ready: boolean): void;
  vote(option: MapVoteOption | null): void;
  kick(memberId: MemberId): void;
  dispose(): void;
}
