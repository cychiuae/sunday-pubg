/**
 * Client game controller (ARCHITECTURE §6-§8, §12, §14, §15.3). Owner: game-developer.
 *
 * update(dt) order:
 *   1. drain queued net messages: hello/rooms, welcome (map switch), status, snapshots (reconcile) and sim events
 *   2. local fixed steps at SIM_DT: sample input -> send -> predict (0..MAX_STEPS_PER_FRAME); aboard: look + the jump
 *      edge only, and a predicted carrier jump
 *   3. remotes = net.getInterpolated(serverNow - interpolationDelayMs)
 *   4. spectate target, look clamp, ADS view, interact prompt, zone status, footsteps/jump/land, countdown, zone
 *      warning, carrier departure
 *   5. grenades (extrapolated), throw arc preview, danger list
 *   6. camera (every CameraCase), viewmodel, FrameView + HudView
 *
 * M2b:
 * - Map switching (ADR 0005 §5): on each welcome whose map differs from the loaded one (and on the first welcome):
 *   getMap, balanceForMap, a MapRuntime per map id (prepareMap with nav off; built once per session), tuning re-resolved
 *   from the effective balance, per-match state reset, then `mapChanged` before the next FrameView.
 * - Rooms (ADR 0006): RoomsModel builds HudView.rooms and the room events; the IClientGame room intents forward to it.
 *   NetClient sends `hello` with the client token itself (CLIENT_TOKEN_STORAGE_KEY).
 * - Carrier drop (drop.md): aboard = 3P carrier camera; the local jump is predicted (freefall at the predicted carrier
 *   position on the press, exactly World.processAboard); playerJumped and parachuteOpened for the local player come
 *   from prediction (server echoes dropped); carrierDeparted when serverNow passes route.startsAt. F = jump edge only
 *   while aboard or dropping.
 * - First person (camera.md, ADR 0005 §9): camera.ts builds every CameraCase; FrameView.viewmodel for the local player
 *   and FP spectate; V toggles the spectate view; the look clamp follows the sim's pitchLimits.
 *
 * ClientGame is the only bus emitter. It never imports render/ui/audio and sees the network only via INetClient.
 */
import { balanceForMap, sightOf, zoneThemeOf, type Balance, type ZoneTheme } from '../shared/balance';
import { MAX_STEPS_PER_FRAME, SIM_DT } from '../shared/constants';
import {
  DEFAULT_ADS_MODE,
  DEFAULT_ADS_SENSITIVITY,
  type AdsBlockReason,
  type AdsView,
  type CameraView,
  type ClientFrame,
  type ClientGameDeps,
  type FrameView,
  type GrenadeArcView,
  type GrenadeView,
  type HudCookView,
  type HudGrenadeDangerView,
  type HudView,
  type IClientGame,
  type INetClient,
  type PlayerView,
  type RoomJoinTarget,
  type RoomSettingsInput,
  type ServerHello,
  type Settings,
  type ViewmodelView,
} from '../shared/contracts';
import type { EventBus, GameEvents } from '../shared/events';
import { isIndoor } from '../shared/maps';
import { vec3 } from '../shared/math';
import { effectiveSpreadDeg } from '../shared/sim/combat';
import { prepareMap, stepMovement, toMovementInput, type MapRuntime, type MovementContext } from '../shared/sim/movement';
import { chestPoint, eyeHeightOf, isStanceSettled, pitchLimits, stanceProgress } from '../shared/sim/stance';
import { surfaceAt } from '../shared/sim/terrain';
import type {
  AnyMapData,
  ConnectionStatus,
  DropSimEvent,
  HeldId,
  LocalPlayerState,
  MapVoteOption,
  MemberId,
  MovementState,
  MovementStepResult,
  PlayerId,
  PlayerInput,
  PlayerState,
  RejectCode,
  RoomState,
  RoomSummary,
  SightType,
  SimEvent,
  Surface,
  Vec3,
  WeaponId,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import { actionsFromSnapshot, actionStatusModel, heldOf, snapshotOriginMs, type PredictedActions } from './actionPrediction';
import { AdsBlend, adsLookScale } from './ads';
import {
  BobTracker,
  bobAmountOf,
  carrierCamera,
  chaseCamera,
  deathCamSubject,
  firstPersonCamera,
  fpCameraOffset,
  headBob,
  LandDip,
  orbitAround,
  playerEyeHeight,
  RecoilKick,
  relabel,
  titleCamera,
} from './camera';
import {
  CountdownTracker,
  findNearestLoot,
  InteractPromptTracker,
  pickupRefusal,
  PhaseTracker,
  RemoteMotionTracker,
  StrideCounter,
  ZoneStatusTracker,
  ZoneTracker,
  type SurfaceFn,
} from './derived';
import { installDevHook, type DevGameState } from './devHook';
import {
  buildDropHud,
  buildRouteView,
  canJumpAt,
  CarrierDepartTracker,
  jumpState,
  localAboard,
  matchAboardCount,
  matchRoute,
  moveDrop,
  playerAboard,
  playerDropPhase,
} from './drop';
import { fovBaseOf, type FovBase } from './fov';
import { ArcPreview, buildGrenadeArc, grenadeDanger, GrenadeTracker, sharedGrenadeStep, type ArcInput, type GrenadeStepFn } from './grenades';
import { buildHudView, type LocalPose, type LocalStanceView } from './hudBuilder';
import { InputController, type InputDriver } from './input/InputController';
import { cycleSlot, InputState } from './input/InputState';
import { Predictor, type PredictStep } from './prediction';
import { RoomsModel, type DefaultRoomName } from './rooms';
import { translateSimEvent, type TranslateContext } from './simEvents';
import { SpectateController, spectateOrder } from './spectate';
import { resolveClientTuning, type ClientTuning } from './tuning';
import { buildViewmodel, localVmAction, LookRate, remoteVmAction, ShotCounter, SpectateAdsClock } from './viewmodel';
import { isOutsideZone, zoneAt } from './zoneView';

type NetMessage =
  | { kind: 'welcome'; welcome: WelcomeInfo }
  | { kind: 'snapshot'; snapshot: WorldSnapshot }
  | { kind: 'events'; events: (SimEvent | DropSimEvent)[]; serverTime: number }
  | { kind: 'status'; status: ConnectionStatus; reason?: string }
  | { kind: 'hello'; hello: ServerHello }
  | { kind: 'roomList'; rooms: RoomSummary[] }
  | { kind: 'roomJoined'; room: RoomState; memberId: MemberId }
  | { kind: 'room'; room: RoomState }
  | { kind: 'roomLeft'; reason: 'left' | 'kicked' | 'closed' }
  | { kind: 'reject'; req: string; code: RejectCode };

/** Test/tooling hooks. main.ts uses the defaults (plus `defaultRoomName`, see rooms.ts). */
export interface ClientGameOptions {
  tuning?: Partial<ClientTuning>;
  /** Input source; default binds the DOM (keyboard on window, mouse + pointer lock on deps.inputTarget). */
  input?: InputDriver;
  /** Movement step for prediction; default is the shared sim stepMovement on the current map. */
  step?: PredictStep;
  /** Surface lookup for footsteps/land; default is the shared sim surfaceAt on the current map. */
  surfaceAt?: SurfaceFn;
  /** Installs the E2E `window.__game` getter; default `installDevHook` (DEV builds or `?e2e` only). */
  installDevHook?: (read: () => DevGameState) => () => void;
  /** M2a: grenade physics step for extrapolation; default is the shared stepGrenade on the current map. */
  grenadeStep?: GrenadeStepFn;
  /**
   * M2a: throw arc preview builder; default the cached `ArcPreview` over `buildGrenadeArc` with the shared sim (null
   * disables the preview). A custom builder is called every frame (tests).
   */
  grenadeArc?: ((eye: Vec3, yaw: number, pitch: number, proneSettled: boolean, fuseRemainingMs: number) => GrenadeArcView) | null;
  /** M2b: renders a null room name (main.ts: `(name) => t('room.create.nameDefault', { name })`). Default: the host name. */
  defaultRoomName?: DefaultRoomName;
}

/** Per-frame local state (predicted), shared by the views and the dev hook. */
interface LocalFrameState {
  held: HeldId;
  ads: AdsView | null;
  cooking: boolean;
  cook: HudCookView | null;
  arc: GrenadeArcView | null;
  grenades: GrenadeView[];
  danger: HudGrenadeDangerView[];
  /** Rendered eye height above the rendered feet (lerped between fixed steps). */
  eyeHeight: number | null;
  adsBlocked: AdsBlockReason | null;
}

interface CameraOut {
  camera: CameraView;
  viewmodel: ViewmodelView | null;
}

export class ClientGame implements IClientGame {
  private readonly bus: EventBus<GameEvents>;
  private readonly net: INetClient;
  /** deps.balance: the base. The effective per-map balance is `balance`. */
  private readonly baseBalance: Balance;
  private balance: Balance;
  private readonly tuningOverrides: Partial<ClientTuning>;
  private tuning: ClientTuning;
  private readonly simDt: number;
  private readonly input: InputDriver;
  private readonly predictor: Predictor<PredictedActions>;
  private readonly spectate = new SpectateController();
  private readonly phaseTracker = new PhaseTracker();
  private readonly countdown = new CountdownTracker();
  private readonly zoneTracker = new ZoneTracker();
  private readonly zoneStatus = new ZoneStatusTracker();
  private readonly prompt = new InteractPromptTracker();
  private readonly remoteMotion = new RemoteMotionTracker();
  private readonly localStrides = new StrideCounter();
  private readonly surface: SurfaceFn;
  private readonly rooms: RoomsModel;

  private readonly serverUrl: string;
  private readonly getMap: (id: string) => AnyMapData;
  private map: AnyMapData;
  /** Map of the current match (null before the first welcome: the title map is shown). */
  private mapId: string | null = null;
  private zoneTheme: ZoneTheme;
  /** MapRuntime per map id (colliders built once per map per session). */
  private readonly runtimes = new Map<string, MapRuntime>();
  private movementCtx: MovementContext | null = null;
  /** RoomView.mapLoading: set on a welcome map switch, cleared after the first frame built with it. */
  private mapLoading = false;
  private readonly customStep: PredictStep | null;

  private queue: NetMessage[] = [];
  private connection: ConnectionStatus = 'idle';
  private joined = false;
  private joinName = '';
  private localId: PlayerId | null = null;
  private snapshot: WorldSnapshot | null = null;
  private seq = 0;
  private accumulator = 0;
  private time = 0;
  private disposed = false;
  private readonly removeDevHook: () => void;
  /** Last update()'s output and reconciliation correction (dev hook). */
  private lastFrame: ClientFrame | null = null;
  private lastCorrection = 0;

  /** Client time (s) of the local death, for the death-screen delay before spectating. */
  private localDeathAt: number | null = null;
  /** Death cam: the killer and the look yaw at death (orbit start). */
  private deathKillerId: PlayerId | null = null;
  private deathYaw = 0;
  /** The player asked to skip the rest of the death screen (requestSpectate). Cleared per match and per death. */
  private spectateRequested = false;
  /** M2b: FP or the V chase cam while spectating (persists while spectating). */
  private spectateView: 'firstPerson' | 'chase' = 'firstPerson';
  private lastSprintInput = false;
  /** M2a: ADS camera blend, look scale and the localAdsChanged edge. */
  private readonly adsBlend = new AdsBlend();
  private adsSensitivity = DEFAULT_ADS_SENSITIVITY;
  private adsEngaged: { weapon: WeaponId; sight: SightType } | null = null;
  /** M2a: predicted active slot last frame (a change drops the ADS toggle latch). */
  private lastActiveSlot: number | null = null;
  private readonly grenades: GrenadeTracker;
  private readonly arcBuilder: ((input: ArcInput) => GrenadeArcView) | null;
  private readonly arcPreview: ArcPreview | null;
  private localFrame: LocalFrameState | null = null;
  /** Last frame's view states by id (positions for events without one). */
  private viewPlayers = new Map<PlayerId, PlayerState>();

  // ---- M2b first person ----
  private fov: FovBase = fovBaseOf(undefined);
  private headBobOn = true;
  private reducedMotion = false;
  private readonly bob = new BobTracker();
  private readonly landDip = new LandDip();
  private readonly recoil = new RecoilKick();
  private readonly lookRate = new LookRate();
  private readonly spectateAds = new SpectateAdsClock();
  private readonly spectateAdsBlend = new AdsBlend();
  private readonly shots = new ShotCounter();
  /** Whose eye the camera used last frame (recoil applies to that player's shots). */
  private cameraSubject: PlayerId | null = null;
  private lastCamera: CameraView | null = null;
  private resultsAt: number | null = null;

  // ---- M2b drop ----
  /** A carrier jump predicted on input `seq`, not yet acknowledged by an aboard=false snapshot. */
  private predictedJump: { seq: number } | null = null;
  /** The local playerJumped / parachuteOpened for the current drop came from prediction (drop the server echo). */
  private localJumpEmitted = false;
  private localChuteEmitted = false;
  /** Look angles were taken from the server once this match (spawn facing). */
  private lookInitialized = false;
  /** Inputs sent aboard (look + jump edge), replayed if the server ejects us before it sees our jump. */
  private aboardInputs: PlayerInput[] = [];
  private readonly carrierDepart = new CarrierDepartTracker();

  constructor(deps: ClientGameDeps, options: ClientGameOptions = {}) {
    this.bus = deps.bus;
    this.net = deps.net;
    this.baseBalance = deps.balance;
    this.balance = deps.balance;
    this.map = deps.initialMap as AnyMapData;
    this.zoneTheme = zoneThemeOf(deps.balance, this.map.id, isIndoor(this.map) ? 'indoor' : 'island');
    this.tuningOverrides = options.tuning ?? {};
    this.tuning = resolveClientTuning(deps.balance, this.tuningOverrides);
    this.simDt = 1 / deps.balance.net.simHz;
    this.customStep = options.step ?? null;
    this.surface = options.surfaceAt ?? ((x, z) => surfaceAt(x, z, this.map) as Surface);
    this.grenades = new GrenadeTracker(options.grenadeStep ?? sharedGrenadeStep(() => this.ctx()), this.simDt);
    if (options.grenadeArc === undefined) {
      this.arcPreview = new ArcPreview((i, out) => buildGrenadeArc(i, this.ctx(), this.balance, out), this.simDt * 1000);
      this.arcBuilder = (i) => (this.arcPreview as ArcPreview).get(i);
    } else {
      const custom = options.grenadeArc;
      this.arcPreview = null;
      this.arcBuilder = custom ? (i) => custom(i.eye, i.yaw, i.pitch, i.proneSettled, i.fuseRemainingMs) : null;
    }

    this.predictor = new Predictor(
      (state, input, status) => this.stepLocal(state, input, status),
      {
        snapDistance: this.tuning.correctionSnapDistance,
        decayMs: this.tuning.correctionDecayMs,
        maxPending: this.tuning.maxPendingInputs,
      },
      actionStatusModel(() => this.balance),
    );

    this.input =
      options.input ??
      new InputController(new InputState(this.tuning.mouseRadiansPerPixel), deps.inputTarget, {
        shouldLockOnClick: () => this.joined && this.currentPhase() === 'playing',
      });

    this.rooms = new RoomsModel(this.net, this.bus, options.defaultRoomName);

    this.net.setHandlers({
      onWelcome: (welcome) => this.queue.push({ kind: 'welcome', welcome }),
      onSnapshot: (snapshot) => this.queue.push({ kind: 'snapshot', snapshot }),
      onEvents: (events, serverTime) => this.queue.push({ kind: 'events', events, serverTime }),
      onStatus: (status, reason) => this.queue.push({ kind: 'status', status, reason }),
      onHello: (hello) => this.queue.push({ kind: 'hello', hello }),
      onRoomList: (rooms) => this.queue.push({ kind: 'roomList', rooms }),
      onRoomJoined: (room, memberId) => this.queue.push({ kind: 'roomJoined', room, memberId }),
      onRoom: (room) => this.queue.push({ kind: 'room', room }),
      onRoomLeft: (reason) => this.queue.push({ kind: 'roomLeft', reason }),
      onReject: (req, code) => this.queue.push({ kind: 'reject', req, code }),
    });

    this.serverUrl = deps.serverUrl;
    this.getMap = (id) => deps.getMap(id) as AnyMapData;

    this.removeDevHook = (options.installDevHook ?? installDevHook)(() => this.devState());
  }

  // -------------------------------------------------------------------------------------------
  // IClientGame
  // -------------------------------------------------------------------------------------------

  /** Connects; NetClient sends `hello` with the per-browser client token (CLIENT_TOKEN_STORAGE_KEY). */
  join(name: string): void {
    if (this.disposed) return;
    this.joinName = name;
    this.net.connect(this.serverUrl, name);
  }

  playAgain(): void {
    // The room returns everyone to its waiting room after results. Only reconnect if the connection is gone.
    if (this.disposed || !this.joinName) return;
    if (this.net.status === 'disconnected' || this.net.status === 'error' || this.net.status === 'idle') {
      this.net.connect(this.serverUrl, this.joinName);
    }
  }

  setSettings(settings: Settings): void {
    this.input.state.setSensitivity(settings.mouseSensitivity, settings.invertY);
    this.input.state.setAdsMode(settings.adsMode ?? DEFAULT_ADS_MODE);
    const sens = settings.adsSensitivity;
    this.adsSensitivity = typeof sens === 'number' && Number.isFinite(sens) && sens > 0 ? sens : DEFAULT_ADS_SENSITIVITY;
    // M2b (camera.md): FOV (Hor+), head bob and reduced motion (effective values resolved by Ui).
    this.fov = fovBaseOf(settings.fovDeg);
    this.reducedMotion = settings.reducedMotion === true;
    this.headBobOn = settings.headBob !== false && !this.reducedMotion;
  }

  requestPointerLock(): void {
    this.input.requestLock();
  }

  /**
   * BUG-001: the death card's "Spectate" button. Skips the rest of match.deathScreenSeconds so the next update()
   * picks a target and emits spectateTargetChanged. No-op unless the local player died this match (idempotent).
   */
  requestSpectate(): void {
    if (this.disposed || this.localDeathAt === null) return;
    this.spectateRequested = true;
  }

  // ---- M2b rooms intents (UiCallbacks -> main.ts -> here) ----
  refreshRooms(): void {
    this.rooms.refreshRooms();
  }
  createRoom(settings: RoomSettingsInput): void {
    this.rooms.createRoom(settings);
  }
  joinRoom(target: RoomJoinTarget): void {
    this.rooms.joinRoom(target);
  }
  leaveRoom(): void {
    this.rooms.leaveRoom();
  }
  setRoomSettings(patch: Partial<RoomSettingsInput>): void {
    this.rooms.setRoomSettings(patch);
  }
  startMatch(): void {
    this.rooms.startMatch();
  }
  cancelCountdown(): void {
    this.rooms.cancelCountdown(this.net.serverNow());
  }
  setReady(ready: boolean): void {
    this.rooms.setReady(ready);
  }
  vote(option: MapVoteOption | null): void {
    this.rooms.vote(option);
  }
  kick(memberId: MemberId): void {
    this.rooms.kick(memberId);
  }

  update(dt: number): ClientFrame {
    const frameDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += frameDt;

    // 1. Net messages -> state + bus events.
    this.drainQueue();

    // 2. Local fixed steps.
    this.runFixedSteps(frameDt);
    this.predictor.decay(frameDt);

    // 3. Remotes.
    const now = this.net.serverNow();
    const snap = this.snapshot;
    const interp = snap ? this.net.getInterpolated(now - this.balance.net.interpolationDelayMs) : null;
    const viewSource = interp?.players ?? snap?.players ?? [];

    // 4. Local view state, spectate, derived events.
    const localSnapState = this.localSnapshotPlayer();
    const predictedLocal = this.buildPredictedLocal(localSnapState);
    const players: PlayerState[] = viewSource.map((p) => (predictedLocal && p.id === this.localId ? predictedLocal : p));
    if (predictedLocal && !players.some((p) => p.id === predictedLocal.id)) players.push(predictedLocal);

    this.updateLook(frameDt);
    const zone: ZoneState | null = snap?.zone ? zoneAt(snap.zone, snap.serverTime, now) : null;
    const local = this.buildLocalFrame(predictedLocal, now, frameDt);
    this.localFrame = local;
    this.updateDerived(players, predictedLocal, zone, now);

    const spectating = this.isSpectating();
    const candidates = spectating ? spectateOrder(players, this.localId) : null;
    if (this.input.state.consumeSpectateNext() && candidates && this.spectate.next(candidates)) {
      this.emitSpectateChanged(players);
    } else if (this.spectate.update(candidates)) {
      this.emitSpectateChanged(players);
    }
    if (this.input.state.consumeViewToggle() && spectating) {
      this.spectateView = this.spectateView === 'firstPerson' ? 'chase' : 'firstPerson';
    }
    const spectateTarget =
      this.spectate.targetId === null ? null : (players.find((p) => p.id === this.spectate.targetId) ?? null);

    this.viewPlayers = new Map(players.map((p) => [p.id, p]));

    // 5. Views.
    const localView = this.localId === null ? undefined : players.find((p) => p.id === this.localId);
    const { camera, viewmodel } = this.buildCamera(predictedLocal, localView, spectateTarget, local, players, now, frameDt);
    const localPose: LocalPose | null =
      snap?.local && localView
        ? {
            pos: localView.pos,
            yaw: predictedLocal ? this.input.state.yaw : localView.yaw,
            dropping: this.predictor.state?.dropping ?? snap.local.movement.dropping,
          }
        : null;

    const frame: FrameView = {
      time: this.time,
      serverTime: now,
      phase: this.currentPhase(),
      localId: this.joined ? this.localId : null,
      camera,
      players: players.map(
        (state): PlayerView => ({
          state,
          isLocal: state.id === this.localId,
          isSpectateTarget: state.id === this.spectate.targetId,
        }),
      ),
      loot: snap?.loot ?? [],
      highlightLootId: this.prompt.currentLootId,
      zone,
      grenades: local.grenades,
      grenadeArc: local.arc,
      ads: local.ads,
      viewmodel,
      reducedMotion: this.reducedMotion,
    };

    const aliveLocal = localSnapState?.alive === true;
    const hud = buildHudView({
      balance: this.balance,
      map: this.map,
      connection: this.connection,
      joined: this.joined,
      snapshot: snap,
      now,
      localId: this.localId,
      localName: this.joinName,
      localPose,
      zone,
      outsideZone: this.zoneStatus.isOutside,
      spectateTarget,
      pointerLocked: this.input.isLocked(),
      crosshairSpreadDeg: this.crosshairSpread(predictedLocal, local.held),
      cameraFovDeg: camera.fovDeg,
      ads: local.ads,
      grenadeDanger: local.danger,
      localStance: this.predictedStance(),
      ...(this.predictor.active ? { cook: local.cook } : {}),
      rooms: this.rooms.view(this.balance, now, this.mapLoading),
      drop: buildDropHud({
        aboard: aliveLocal && this.isAboard(),
        route: matchRoute(snap?.match),
        now,
        aboardCount: matchAboardCount(snap?.match),
        movement: aliveLocal ? (this.predictor.state ?? snap?.local?.movement ?? null) : null,
        map: this.map,
        balance: this.balance,
      }),
      route: buildRouteView(matchRoute(snap?.match), now),
      zoneTheme: this.zoneTheme,
      cameraView: hudCameraView(camera),
      spectateView: this.spectateView,
      adsBlocked: local.adsBlocked,
    });

    this.mapLoading = false;
    this.lastFrame = { frame, hud };
    return this.lastFrame;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDevHook();
    this.input.dispose();
    this.net.disconnect();
    this.queue = [];
  }

  /** Plain-data state for the dev/E2E hook (`window.__game`), from the last update(). */
  private devState(): DevGameState {
    const hud = this.lastFrame?.hud ?? null;
    const frame = this.lastFrame?.frame ?? null;
    const local = hud?.local ?? null;
    const snap = this.snapshot;
    const lf = this.localFrame;
    const m = this.predictor.state;
    const live = local?.alive === true && m !== null;
    const ads = lf?.ads ?? null;
    const room = this.rooms.state;
    const vm = frame?.viewmodel ?? null;
    const drop = hud?.drop ?? null;
    return {
      connection: this.connection,
      joined: this.joined,
      phase: this.currentPhase(),
      matchId: snap?.match.matchId ?? null,
      localId: this.localId,
      localAlive: local?.alive ?? false,
      localHp: local ? local.hp : null,
      localPos: local ? { ...local.pos } : null,
      localYaw: this.input.state.yaw,
      localPitch: this.input.state.pitch,
      localWeapon: live && lf ? lf.held : local ? local.weapon : null,
      stance: local ? local.stance : null,
      stanceFrom: local ? local.stanceFrom : null,
      stanceProgress: local ? local.stanceProgress : null,
      ads: live && m.adsMs > 0,
      adsProgress: ads?.progress ?? 0,
      adsCameraBlend: ads?.cameraBlend ?? 0,
      scoped: ads?.scoped ?? false,
      sight: ads?.sight ?? null,
      vestTier: local?.vest?.tier ?? 0,
      helmetTier: local?.helmet?.tier ?? 0,
      vestDurability: local?.vest?.durability ?? null,
      helmetDurability: local?.helmet?.durability ?? null,
      grenades: local?.grenades ?? 0,
      cooking: lf?.cooking ?? false,
      cookFuseMs: local?.cook?.fuseRemainingMs ?? null,
      grenadeArc: (frame?.grenadeArc ?? null) !== null,
      liveGrenades: (frame?.grenades ?? []).map((g) => ({
        id: g.id,
        ownerId: g.ownerId,
        pos: { ...g.pos },
        resting: g.resting,
        explodesAt: g.explodesAt,
      })),
      cameraFovDeg: frame?.camera.fovDeg ?? this.tuning.cameraFovDeg,
      cameraFirstPerson: frame?.camera.firstPerson ?? false,
      cameraEyeHeight: live ? (lf?.eyeHeight ?? null) : null,
      localKills: local?.kills ?? 0,
      aliveCount: hud?.aliveCount ?? 0,
      totalPlayers: hud?.totalPlayers ?? 0,
      lobbyCount: hud?.lobbyCount ?? 0,
      spectateTargetId: this.spectate.targetId,
      pointerLocked: hud?.pointerLocked ?? false,
      serverTime: frame?.serverTime ?? this.net.serverNow(),
      pendingInputs: this.predictor.pendingInputs.length,
      lastCorrection: this.lastCorrection,
      lootCount: snap?.loot.length ?? 0,
      mapId: this.mapId,
      cameraView: frame?.camera.view ?? null,
      dropPhase: drop?.stage ?? null,
      aboard: drop?.stage === 'aboard',
      roomId: room?.id ?? null,
      roomCode: room?.code ?? null,
      isHost: room !== null && room.hostId === this.rooms.localMemberId,
      viewmodel: vm ? { item: vm.item, action: vm.action, visible: vm.visible } : null,
      players: (frame?.players ?? []).map(({ state }) => ({
        id: state.id,
        name: state.name,
        alive: state.alive,
        isBot: state.isBot,
        hp: state.hp,
        pos: { ...state.pos },
        stance: state.stance,
        stanceFrom: state.stanceFrom,
        stanceProgress: state.stanceProgress,
        vestTier: state.vestTier,
        helmetTier: state.helmetTier,
        weapon: state.weapon,
      })),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Net message processing
  // -------------------------------------------------------------------------------------------

  private drainQueue(): void {
    const messages = this.queue;
    this.queue = [];
    for (const msg of messages) {
      try {
        switch (msg.kind) {
          case 'welcome':
            this.onWelcome(msg.welcome);
            break;
          case 'status':
            this.onStatus(msg.status, msg.reason);
            break;
          case 'snapshot':
            this.onSnapshot(msg.snapshot);
            break;
          case 'events': {
            const ctx = this.translateContext();
            for (const ev of msg.events) {
              this.beforeSimEvent(ev, msg.serverTime);
              translateSimEvent(ev, ctx, this.bus);
              this.afterSimEvent(ev);
            }
            break;
          }
          case 'hello':
            this.rooms.onHello(msg.hello);
            break;
          case 'roomList':
            this.rooms.onRoomList(msg.rooms);
            break;
          case 'roomJoined':
            this.rooms.onRoomJoined(msg.room, msg.memberId);
            break;
          case 'room':
            this.rooms.onRoom(msg.room);
            break;
          case 'roomLeft':
            this.rooms.onRoomLeft(msg.reason);
            this.leaveMatch();
            break;
          case 'reject':
            this.rooms.onReject(msg.req, msg.code);
            break;
        }
      } catch (err) {
        console.error('[ClientGame] failed to process net message', msg.kind, err);
      }
    }
  }

  private onWelcome(welcome: WelcomeInfo): void {
    this.joined = true;
    this.localId = welcome.playerId;
    this.seq = 0;
    this.resetMatchState();
    this.phaseTracker.reset();
    this.snapshot = null;
    this.switchMap(welcome.mapId);
  }

  /**
   * ADR 0005 §5: load the match's map (first welcome, or a different map id): effective balance, a cached MapRuntime,
   * tuning from the per-map balance, then `mapChanged` (before the next FrameView). Per-match state was reset by the
   * caller. An unknown id keeps the current map (logged).
   */
  private switchMap(mapId: string): void {
    if (mapId === this.mapId) return;
    let map: AnyMapData;
    try {
      map = this.getMap(mapId);
    } catch (err) {
      console.error(`[ClientGame] unknown map id "${mapId}" from server`, err);
      return;
    }
    const rt = this.runtimeFor(map);
    this.map = map;
    this.mapId = mapId;
    this.balance = rt.balance;
    this.movementCtx = rt.ctx;
    this.tuning = resolveClientTuning(this.balance, this.tuningOverrides);
    this.input.state.setRadiansPerPixel(this.tuning.mouseRadiansPerPixel);
    this.zoneTheme = zoneThemeOf(this.baseBalance, mapId, isIndoor(map) ? 'indoor' : 'island');
    this.arcPreview?.reset();
    this.mapLoading = true;
    this.bus.emit('mapChanged', { mapId, map, balance: this.balance, zoneTheme: this.zoneTheme });
  }

  /** MapRuntime per map id (prepareMap with nav off: the client never runs bots). */
  private runtimeFor(map: AnyMapData): MapRuntime {
    let rt = this.runtimes.get(map.id);
    if (!rt) {
      rt = prepareMap(map, balanceForMap(this.baseBalance, map.id), { nav: false });
      this.runtimes.set(map.id, rt);
    }
    return rt;
  }

  private onStatus(status: ConnectionStatus, reason?: string): void {
    this.connection = status;
    this.bus.emit('connectionStatus', reason === undefined ? { status } : { status, reason });
    // Anything but 'connected' (connecting to a new session, idle after disconnect(), dropped, error) ends the
    // current session; the next welcome starts a fresh one.
    if (status !== 'connected') {
      this.rooms.reset();
      this.leaveMatch();
    }
  }

  /** Not in a match any more (disconnect, left the room): drop the match view. The loaded map stays. */
  private leaveMatch(): void {
    this.joined = false;
    this.snapshot = null;
    this.localId = null;
    this.resetMatchState();
    this.phaseTracker.reset();
  }

  private onSnapshot(snap: WorldSnapshot): void {
    const prev = this.snapshot;
    this.snapshot = snap;
    if (prev && prev.match.matchId !== snap.match.matchId) this.resetMatchState();

    this.phaseTracker.onSnapshot(snap.match, this.bus);
    this.zoneTracker.onSnapshot(snap.zone, this.bus);
    this.grenades.onSnapshot(snap.grenades ?? [], snap.serverTime);

    const local = snap.local;
    const localPlayer = local ? snap.players.find((p) => p.id === local.id) : undefined;
    if (local && localPlayer && !this.lookInitialized) {
      // Spawn facing (aboard: the carrier heading). Later snapshots echo our own look, so never snap it again.
      this.lookInitialized = true;
      this.input.state.setLook(localPlayer.yaw, localPlayer.pitch);
    }
    if (local && localPlayer?.alive && localAboard(local)) {
      // Aboard: no movement prediction. A predicted jump keeps predicting until the server processed its input; if the
      // server is past it and still has us aboard, it refused the jump (too early): back to the carrier.
      const jump = this.predictedJump;
      if (!jump || local.lastProcessedInputSeq >= jump.seq) {
        if (jump) this.localJumpEmitted = false;
        this.predictedJump = null;
        this.predictor.reset();
      }
    } else if (local && localPlayer?.alive) {
      this.predictedJump = null;
      const wasActive = this.predictor.active;
      // Auto-eject (or a jump we did not predict): inputs sent aboard after the ejection tick are movement on the server.
      if (!wasActive && this.aboardInputs.length > 0) this.predictor.seedPending(this.aboardInputs);
      this.aboardInputs = [];
      // Fire timers and the trigger latch are not in the snapshot: carry them from our prediction at the acked seq.
      const carry = this.predictor.actionsAfter(local.lastProcessedInputSeq);
      const res = this.predictor.reconcile(
        local.movement,
        local.lastProcessedInputSeq,
        actionsFromSnapshot(local, localPlayer.hp, snap.tick, carry, snapshotOriginMs(snap)),
      );
      if (wasActive) this.lastCorrection = res.correction;
      if (!wasActive) this.localStrides.reset();
    } else {
      this.predictedJump = null;
      this.predictor.reset();
    }
  }

  /** Grenade samples go in before the bus sees the event, so listeners and the next frame agree. */
  private beforeSimEvent(ev: SimEvent | DropSimEvent, serverTime: number): void {
    if (ev.type === 'grenadeThrown') this.grenades.onThrown(ev, serverTime);
    else if (ev.type === 'explosion') this.grenades.onExplosion(ev.id);
    else if (ev.type === 'shot') {
      this.shots.add(ev.shooterId);
      if (ev.shooterId === this.cameraSubject && ev.weapon !== 'fists') this.recoil.onShot(ev.weapon, this.time, this.tuning);
    }
  }

  private afterSimEvent(ev: SimEvent | DropSimEvent): void {
    if (ev.type === 'kill') {
      this.spectate.onKill(ev.victimId, ev.killerId, this.localId);
      if (ev.victimId === this.localId) {
        this.localDeathAt = this.time;
        this.deathKillerId = ev.killerId;
        this.deathYaw = this.input.state.yaw;
        this.spectateRequested = false;
        this.predictor.reset();
        this.predictedJump = null;
        this.input.state.clearAdsToggle();
      }
    } else if (ev.type === 'dropJump' && ev.playerId === this.localId) {
      this.localJumpEmitted = true;
    } else if (ev.type === 'chuteOpen' && ev.playerId === this.localId) {
      this.localChuteEmitted = true;
    }
  }

  private translateContext(): TranslateContext {
    return {
      localId: this.localId,
      nameOf: (id) => this.nameOf(id),
      posOf: (id) => this.posOf(id),
      localEye: () => this.localEye(),
      skipLocalDrop: (type) => (type === 'dropJump' ? this.localJumpEmitted : this.localChuteEmitted),
    };
  }

  /** Predicted eye of the live local player (explosion.localDistance), else null. */
  private localEye(): Vec3 | null {
    const state = this.predictor.state;
    if (!state || this.localId === null) return null;
    const feet = this.predictor.renderPosition(this.accumulator / this.simDt) ?? state.pos;
    return { x: feet.x, y: feet.y + eyeHeightOf(state, this.balance), z: feet.z };
  }

  private nameOf(id: PlayerId): string | null {
    const fromSnap = this.snapshot?.players.find((p) => p.id === id);
    if (fromSnap) return fromSnap.name;
    return this.viewPlayers.get(id)?.name ?? null;
  }

  private posOf(id: PlayerId): Vec3 {
    if (id === this.localId && this.predictor.active) {
      const p = this.predictor.renderPosition(this.accumulator / this.simDt);
      if (p) return p;
    }
    const view = this.viewPlayers.get(id) ?? this.snapshot?.players.find((p) => p.id === id);
    return view ? { ...view.pos } : vec3();
  }

  /** Per-match client state (new match, new connection, disconnect). */
  private resetMatchState(): void {
    this.predictor.reset();
    this.localDeathAt = null;
    this.deathKillerId = null;
    this.spectateRequested = false;
    this.spectate.clearPreference();
    this.zoneTracker.reset();
    this.remoteMotion.reset();
    this.localStrides.reset();
    this.accumulator = 0;
    this.grenades.reset();
    this.adsBlend.reset();
    this.spectateAdsBlend.reset();
    this.adsEngaged = null;
    this.lastActiveSlot = null;
    this.input.state.clearAdsToggle();
    this.predictedJump = null;
    this.localJumpEmitted = false;
    this.localChuteEmitted = false;
    this.lookInitialized = false;
    this.aboardInputs = [];
    this.carrierDepart.reset();
    this.bob.reset();
    this.landDip.reset();
    this.recoil.reset();
    this.lookRate.reset();
    this.spectateAds.reset();
    this.shots.reset();
    this.arcPreview?.reset();
    this.prompt.reset();
    this.resultsAt = null;
  }

  // -------------------------------------------------------------------------------------------
  // Local fixed steps (input + prediction)
  // -------------------------------------------------------------------------------------------

  private runFixedSteps(dt: number): void {
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.simDt && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= this.simDt;
      steps++;
      this.fixedStep();
    }
    // Spiral-of-death guard: drop whole steps we could not run this frame.
    if (this.accumulator >= this.simDt) this.accumulator %= this.simDt;
  }

  private inPlay(): boolean {
    return this.joined && this.localId !== null && this.currentPhase() === 'playing' && this.snapshot?.local != null;
  }

  private canControl(): boolean {
    return this.inPlay() && this.predictor.active;
  }

  /** Alive and riding the carrier (snapshot), with no predicted jump. */
  private isAboard(): boolean {
    return this.predictedJump === null && localAboard(this.snapshot?.local) && this.localSnapshotPlayer()?.alive === true;
  }

  private fixedStep(): void {
    const local = this.snapshot?.local;
    if (local && this.inPlay() && this.isAboard()) {
      this.aboardStep(local);
      return;
    }
    if (!this.canControl() || !local) {
      this.input.state.clearEdges();
      return;
    }
    const acts = this.predictor.predictedActions;
    const { input, firePressed } = this.input.state.sample(++this.seq, this.simDt, (dir) =>
      acts
        ? cycleSlot(acts.inv.activeSlot, [acts.inv.slots[0] !== null, acts.inv.slots[1] !== null], dir, acts.inv.grenades > 0)
        : cycleSlot(local.activeSlot, [local.slots[0] !== null, local.slots[1] !== null], dir, local.grenades > 0),
    );
    if (firePressed) this.maybeDryFire(local);
    this.net.sendInput(input);
    this.lastSprintInput = input.sprint;

    const prevState = this.predictor.state;
    const result = this.predictor.apply(input);
    if (!result || !prevState || this.localId === null) return;
    this.emitLocalMotion(prevState.pos, result, input.sprint);
    const sc = result.stanceChanged;
    if (sc) {
      // M2a: the local stanceChanged comes from prediction on the step it starts (the server echo is dropped).
      this.bus.emit('stanceChanged', {
        playerId: this.localId,
        from: sc.from,
        to: sc.to,
        forced: sc.forced,
        durationMs: sc.durationMs,
        pos: { ...result.state.pos },
        isLocal: true,
      });
    }
    const chute = result.chuteOpened;
    if (chute !== null && !this.localChuteEmitted) {
      this.localChuteEmitted = true;
      this.bus.emit('parachuteOpened', { playerId: this.localId, pos: { ...result.state.pos }, manual: chute === 'manual', isLocal: true });
    }
  }

  /**
   * Aboard (drop.md): send look and the jump edge every tick (the server ignores everything else). A jump edge from
   * route.noJumpUntil is predicted like World.processAboard: freefall at the carrier position at that moment, zero
   * velocity, no movement step on the jump tick; prediction then runs normally from the next input.
   */
  private aboardStep(local: LocalPlayerState): void {
    const { input } = this.input.state.sample(++this.seq, this.simDt);
    this.net.sendInput(input);
    this.lastSprintInput = false;
    this.aboardInputs.push(input);
    if (this.aboardInputs.length > this.tuning.maxPendingInputs) this.aboardInputs.shift();
    const snap = this.snapshot as WorldSnapshot;
    const route = matchRoute(snap.match);
    const now = this.net.serverNow();
    if (!input.jump || !route || !canJumpAt(route, now) || this.localId === null) return;
    const me = this.localSnapshotPlayer();
    const tick = snap.tick + Math.round((now - snap.serverTime) / (SIM_DT * 1000));
    const state = jumpState(route, now);
    this.predictor.reset();
    this.predictor.reconcile(state, input.seq, actionsFromSnapshot(local, me?.hp ?? 0, tick, null, snapshotOriginMs(snap)));
    this.predictedJump = { seq: input.seq };
    this.aboardInputs = [];
    this.localStrides.reset();
    if (!this.localJumpEmitted) {
      this.localJumpEmitted = true;
      this.localChuteEmitted = false;
      this.bus.emit('playerJumped', { playerId: this.localId, pos: { ...state.pos }, auto: false, isLocal: true });
    }
  }

  private emitLocalMotion(from: Vec3, result: MovementStepResult, sprint: boolean): void {
    const id = this.localId as PlayerId;
    const pos = result.state.pos;
    if (result.jumped) this.bus.emit('jump', { playerId: id, pos: { ...pos }, isLocal: true });
    if (result.landed) {
      this.bus.emit('land', {
        playerId: id,
        pos: { ...pos },
        fallSpeed: Math.max(0, result.landingSpeed),
        surface: this.surface(pos.x, pos.z),
        isLocal: true,
      });
      this.localStrides.clear(id);
      this.landDip.trigger(this.time);
    }
    if (!result.state.grounded || result.state.dropping) return;
    const dist = Math.hypot(pos.x - from.x, pos.z - from.z);
    const sprinting = sprint && dist / this.simDt > this.balance.movement.walkSpeed;
    const stride = sprinting ? this.tuning.footstepStrideSprint : this.tuning.footstepStrideWalk;
    if (this.localStrides.add(id, dist, stride)) {
      this.bus.emit('footstep', {
        playerId: id,
        pos: { ...pos },
        surface: this.surface(pos.x, pos.z),
        sprinting,
        isLocal: true,
        stance: result.state.stance,
      });
    }
  }

  private maybeDryFire(local: LocalPlayerState): void {
    const active = local.activeSlot;
    if (active !== 0 && active !== 1) return;
    if (local.reloadRemainingMs > 0 || this.predictor.state?.dropping) return;
    const slot = local.slots[active];
    if (slot && slot.mag <= 0) this.bus.emit('dryFire', { weapon: slot.weapon });
  }

  private stepLocal: PredictStep = (state, input, status) => {
    if (this.customStep) return this.customStep(state, input, status);
    return stepMovement(state, toMovementInput(input, status, this.balance), input.dt, this.ctx());
  };

  /** Shared sim context for the current map (movement, grenade physics, arc preview). */
  private ctx(): MovementContext {
    if (!this.movementCtx) this.movementCtx = this.runtimeFor(this.map).ctx;
    return this.movementCtx;
  }

  // -------------------------------------------------------------------------------------------
  // Views and derived per-frame state
  // -------------------------------------------------------------------------------------------

  private currentPhase(): FrameView['phase'] {
    return this.snapshot?.match.phase ?? 'lobby';
  }

  private localSnapshotPlayer(): PlayerState | undefined {
    const snap = this.snapshot;
    if (!snap?.local) return undefined;
    const id = snap.local.id;
    return snap.players.find((p) => p.id === id);
  }

  /** Local PlayerState with predicted position, live mouse yaw/pitch and movement-derived anim and drop flags. */
  private buildPredictedLocal(base: PlayerState | undefined): PlayerState | null {
    const state = this.predictor.state;
    if (!base || !state || !base.alive) return null;
    const pos = this.predictor.renderPosition(this.accumulator / this.simDt) ?? state.pos;
    const hSpeed = Math.hypot(state.vel.x, state.vel.z);
    const moving = hSpeed > this.tuning.animMoveSpeed;
    const acts = this.predictor.predictedActions;
    const out: PlayerState = {
      ...base,
      pos,
      velY: state.vel.y,
      yaw: this.input.state.yaw,
      pitch: this.input.state.pitch,
      weapon: acts ? heldOf(acts) : base.weapon,
      stance: state.stance,
      stanceFrom: state.stanceFrom,
      stanceProgress: stanceProgress(state, this.balance),
      anim: {
        ...base.anim,
        moving,
        sprinting: moving && this.lastSprintInput && state.grounded && hSpeed > this.balance.movement.walkSpeed,
        airborne: !state.grounded,
        dropping: state.dropping,
        ads: state.adsMs > 0,
        cooking: acts ? acts.cook !== null : base.anim.cooking,
      },
    };
    // M2b drop fields (PlayerDropFields; on PlayerState after the C-gate): a predicted jump has left the carrier.
    return Object.assign(out, { aboard: false, dropPhase: moveDrop(state).dropPhase });
  }

  /**
   * Spectating = in a running match (playing/results) and either not a participant (joined mid-match) or dead
   * for longer than match.deathScreenSeconds.
   */
  private isSpectating(): boolean {
    const snap = this.snapshot;
    if (!this.joined || !snap) return false;
    const phase = snap.match.phase;
    if (phase !== 'playing' && phase !== 'results') return false;
    if (!snap.local) return true;
    const me = snap.players.find((p) => p.id === snap.local?.id);
    if (me?.alive) return false;
    if (this.localDeathAt === null || this.spectateRequested) return true;
    return this.time - this.localDeathAt >= this.balance.match.deathScreenSeconds;
  }

  private emitSpectateChanged(players: readonly PlayerState[]): void {
    const id = this.spectate.targetId;
    const name = id === null ? null : (players.find((p) => p.id === id)?.name ?? this.nameOf(id));
    this.bus.emit('spectateTargetChanged', { targetId: id, targetName: name });
  }

  /**
   * Look clamp (camera.md "Prone pitch"): the sim's pitchLimits for the predicted stance. A pitch outside them (entering
   * prone) eases in over the rest of the transition. F counts as the jump edge only aboard or dropping.
   */
  private updateLook(frameDt: number): void {
    const s = this.input.state;
    const state = this.predictor.state;
    if (state) {
      const pl = pitchLimits(state, this.balance);
      s.setPitchLimits(pl.min, pl.max);
      const ms = state.stanceMs;
      s.easePitchIntoLimits(ms > 0 ? (frameDt * 1000) / ms : 1);
    } else {
      s.setPitchLimits(-Infinity, Infinity);
    }
    s.setAltJumpEnabled(this.inPlay() && (this.isAboard() || state?.dropping === true));
  }

  private updateDerived(players: readonly PlayerState[], predictedLocal: PlayerState | null, zone: ZoneState | null, now: number): void {
    const snap = this.snapshot;
    const phase = this.currentPhase();

    this.countdown.update(phase === 'countdown' ? (snap?.match.phaseEndsAt ?? null) : null, now, this.bus);
    if (snap) {
      this.zoneTracker.updateWarning(zone, now, snap.match.matchId, this.balance.zone.warningSecondsBeforeShrink, this.bus);
      this.carrierDepart.update(matchRoute(snap.match), snap.match.matchId, now, this.bus);
    }

    const predicted = this.predictor.state;
    // Zone in/out for the (predicted) local player.
    this.zoneStatus.set(predictedLocal !== null && zone !== null && isOutsideZone(predictedLocal.pos, zone), this.bus);

    // Interact prompt: nearest loot in range of the predicted feet, only when able to pick up.
    const canLoot = predictedLocal !== null && predicted !== null && !predicted.dropping && phase === 'playing';
    const loot = canLoot && snap && predicted ? findNearestLoot(snap.loot, predicted.pos, this.balance.player.pickupRange) : null;
    this.prompt.set(loot, this.bus, loot && snap?.local ? pickupRefusal(loot, snap.local, this.balance) : null, this.balance);

    // Remote footsteps/jump/land (local ones come from the prediction steps).
    this.remoteMotion.update(players, this.localId, this.surface, this.tuning, this.bus);
  }

  /** Every CameraCase (camera.md "Camera mode per state") plus the FP viewmodel. */
  private buildCamera(
    predictedLocal: PlayerState | null,
    localView: PlayerState | undefined,
    spectateTarget: PlayerState | null,
    local: LocalFrameState,
    players: readonly PlayerState[],
    now: number,
    frameDt: number,
  ): CameraOut {
    const out = this.pickCamera(predictedLocal, localView, spectateTarget, local, players, now, frameDt);
    const subject = out.camera.view === 'firstPerson' ? (out.camera.subjectId ?? null) : null;
    if (subject !== this.cameraSubject) {
      this.recoil.reset();
      this.cameraSubject = subject;
    }
    if (out.camera.view !== 'results') this.lastCamera = out.camera;
    return out;
  }

  private pickCamera(
    predictedLocal: PlayerState | null,
    localView: PlayerState | undefined,
    spectateTarget: PlayerState | null,
    local: LocalFrameState,
    players: readonly PlayerState[],
    now: number,
    frameDt: number,
  ): CameraOut {
    const look = this.input.state;
    const t = this.tuning;
    const phase = this.currentPhase();
    const route = matchRoute(this.snapshot?.match);

    if (phase === 'results') {
      if (this.resultsAt === null) this.resultsAt = this.time;
      const winnerId = this.snapshot?.match.winnerId ?? null;
      const winner = winnerId === null ? undefined : players.find((p) => p.id === winnerId && p.alive);
      if (winner) {
        const center = { x: winner.pos.x, y: winner.pos.y + playerEyeHeight(winner, this.balance), z: winner.pos.z };
        return { camera: orbitAround('results', center, winner.yaw, this.time - this.resultsAt, winner.id, t), viewmodel: null };
      }
      return { camera: relabel(this.lastCamera ?? titleCamera(this.map, this.time, t), 'results'), viewmodel: null };
    }
    this.resultsAt = null;

    if (predictedLocal && this.predictor.state && this.localId !== null) {
      return this.localFirstPerson(predictedLocal, this.predictor.state, local, frameDt);
    }
    if (phase === 'playing' && this.isAboard() && route) {
      return { camera: carrierCamera(route, now, look.yaw, look.pitch, t), viewmodel: null };
    }
    if (spectateTarget) {
      if (playerAboard(spectateTarget) && route) {
        return { camera: carrierCamera(route, now, spectateTarget.yaw, spectateTarget.pitch, t), viewmodel: null };
      }
      const eyeH = playerEyeHeight(spectateTarget, this.balance);
      if (this.spectateView === 'chase') {
        return { camera: chaseCamera(spectateTarget.pos, spectateTarget.yaw, spectateTarget.pitch, eyeH, spectateTarget.id, t), viewmodel: null };
      }
      return this.spectateFirstPerson(spectateTarget, eyeH, frameDt);
    }
    // Death screen: orbit our body (or the killer when alive and close) until spectating starts.
    if (localView && this.snapshot?.local && phase === 'playing' && !localView.alive) {
      const killer = this.deathKillerId === null ? null : (players.find((p) => p.id === this.deathKillerId) ?? null);
      const subject = deathCamSubject(localView, killer, t);
      const center = { x: subject.pos.x, y: subject.pos.y + playerEyeHeight(subject, this.balance), z: subject.pos.z };
      const since = this.localDeathAt === null ? 0 : this.time - this.localDeathAt;
      return { camera: orbitAround('death', center, this.deathYaw, since, subject.id, t), viewmodel: null };
    }
    return { camera: titleCamera(this.map, this.time, t), viewmodel: null };
  }

  /** On foot, freefall and chute: the FP camera at the predicted eye, and the local viewmodel. */
  private localFirstPerson(p: PlayerState, state: MovementState, local: LocalFrameState, frameDt: number): CameraOut {
    const t = this.tuning;
    const look = this.input.state;
    const id = p.id;
    const eyeH = local.eyeHeight ?? playerEyeHeight(p, this.balance);
    const eye = { x: p.pos.x, y: p.pos.y + eyeH, z: p.pos.z };
    const blend = local.ads?.cameraBlend ?? 0;
    const sprinting = p.anim.sprinting;
    const phase = this.bob.update(id, p.pos, sprinting ? t.footstepStrideSprint : t.footstepStrideWalk, t.maxFrameTravel);
    const amount = bobAmountOf(Math.hypot(state.vel.x, state.vel.z), state.stance, state.grounded && !state.dropping, this.balance, t);
    const offset = fpCameraOffset(look.yaw, headBob(phase, amount, sprinting, t), this.landDip.sample(this.time, t), blend, this.headBobOn, t);
    const recoil = this.recoil.sample(this.time, t, this.reducedMotion);
    const camera = firstPersonCamera({
      eye,
      yaw: look.yaw,
      pitch: look.pitch,
      fovDeg: this.adsBlend.fovDeg ?? this.fov.playerDeg,
      offset,
      roll: recoil.roll,
      fovPunchDeg: recoil.fovPunchDeg,
      subjectId: id,
    });
    const acts = this.predictor.predictedActions;
    const viewmodel = buildViewmodel({
      playerId: id,
      appearance: p.appearance,
      vestTier: p.vestTier,
      act: acts ? localVmAction(acts, this.balance) : remoteVmAction(p),
      adsBlend: blend,
      visible: !(local.ads?.scoped ?? false),
      shotCount: this.shots.of(id),
      stance: state.stance,
      stanceFrom: state.stanceFrom,
      stanceProgress: stanceProgress(state, this.balance),
      dropPhase: moveDrop(state).dropPhase,
      bobPhase: phase,
      bobAmount: amount * (1 - blend),
      sprinting,
      lookRate: this.lookRate.update(id, look.yaw, look.pitch, frameDt),
      motionScale: this.reducedMotion ? t.reducedMotionViewmodelFactor : 1,
    });
    return { camera, viewmodel };
  }

  /** FP spectate: the target's interpolated eye and look, their ADS rebuilt from anim.ads, and their viewmodel. */
  private spectateFirstPerson(target: PlayerState, eyeH: number, frameDt: number): CameraOut {
    const t = this.tuning;
    const adsMs = this.spectateAds.update(target.id, target.anim.ads, this.time * 1000);
    const ads = this.spectateAdsBlend.update({ adsMs }, target.weapon, this.balance, frameDt * 1000, t.adsExitBlendMs, this.fov);
    const recoil = this.recoil.sample(this.time, t, this.reducedMotion);
    const eye = { x: target.pos.x, y: target.pos.y + eyeH, z: target.pos.z };
    const camera = firstPersonCamera({
      eye,
      yaw: target.yaw,
      pitch: target.pitch,
      fovDeg: this.spectateAdsBlend.fovDeg ?? this.fov.playerDeg,
      offset: { x: 0, y: 0, z: 0 },
      roll: recoil.roll,
      fovPunchDeg: recoil.fovPunchDeg,
      subjectId: target.id,
    });
    const onGround = !target.anim.airborne && !target.anim.dropping;
    const phase = this.bob.update(target.id, target.pos, target.anim.sprinting ? t.footstepStrideSprint : t.footstepStrideWalk, t.maxFrameTravel);
    const amount = target.anim.moving && onGround ? bobAmountOf(Infinity, target.stance, true, this.balance, t) : 0;
    const viewmodel = buildViewmodel({
      playerId: target.id,
      appearance: target.appearance,
      vestTier: target.vestTier,
      act: remoteVmAction(target),
      adsBlend: ads.cameraBlend,
      visible: target.alive && !ads.scoped,
      shotCount: this.shots.of(target.id),
      stance: target.stance,
      stanceFrom: target.stanceFrom,
      stanceProgress: target.stanceProgress,
      dropPhase: playerDropPhase(target),
      bobPhase: phase,
      bobAmount: amount * (1 - ads.cameraBlend),
      sprinting: target.anim.sprinting,
      lookRate: this.lookRate.update(target.id, target.yaw, target.pitch, frameDt),
      motionScale: this.reducedMotion ? t.reducedMotionViewmodelFactor : 1,
    });
    return { camera, viewmodel };
  }

  /** Full combat.md cone from the predicted movement state (0 for the grenade). */
  private crosshairSpread(predictedLocal: PlayerState | null, held: HeldId): number {
    const state = this.predictor.state;
    if (!predictedLocal || !state || held === 'grenade') return 0;
    const ads = this.localFrame?.ads ?? null;
    return effectiveSpreadDeg(held, this.balance, {
      horizontalSpeed: Math.hypot(state.vel.x, state.vel.z),
      airborne: !state.grounded,
      adsProgress: ads?.progress ?? 0,
      stance: state.stance,
      stanceSettled: isStanceSettled(state),
    });
  }

  /** Predicted stance for the HUD icon, or null (the HUD falls back to the snapshot). */
  private predictedStance(): LocalStanceView | null {
    const state = this.predictor.state;
    if (!state) return null;
    return { stance: state.stance, stanceFrom: state.stanceFrom, progress: stanceProgress(state, this.balance) };
  }

  /**
   * Per-frame local state: ADS view (and its look scale, toggle gating and localAdsChanged edge), the eye height
   * lerped between fixed steps (smooth stance camera), cook ring, throw arc, live grenades, the danger list and the
   * adsBlocked hint.
   */
  private buildLocalFrame(predictedLocal: PlayerState | null, now: number, frameDt: number): LocalFrameState {
    const state = this.predictor.state;
    const acts = this.predictor.predictedActions;
    const snapLocal = this.snapshot?.local ?? null;
    const grenades = this.grenades.views(now);
    const alive = predictedLocal !== null && state !== null && acts !== null;
    const held: HeldId = alive && acts ? heldOf(acts) : (predictedLocal?.weapon ?? 'fists');

    // Slot changes (keys, wheel, auto-switch, pickups) drop the ADS toggle latch.
    const slot = alive && acts ? acts.inv.activeSlot : null;
    if (slot !== null && this.lastActiveSlot !== null && slot !== this.lastActiveSlot) this.input.state.clearAdsToggle();
    this.lastActiveSlot = slot;

    let ads: AdsView | null = null;
    if (alive && state) ads = this.adsBlend.update(state, held, this.balance, frameDt * 1000, this.tuning.adsExitBlendMs, this.fov);
    else this.adsBlend.reset();
    this.input.state.setLookScale(adsLookScale(ads, this.adsSensitivity));
    this.input.state.setAdsAllowed(alive && sightOf(this.balance, held) !== 'none');
    this.updateAdsEdge(alive && state !== null && state.adsMs > 0 && held !== 'grenade' ? (held as WeaponId) : null);

    if (!alive || !state || !acts || !predictedLocal) {
      return { held, ads: null, cooking: false, cook: null, arc: null, grenades, danger: [], eyeHeight: null, adsBlocked: null };
    }

    const prev = this.predictor.previousState ?? state;
    const alpha = Math.min(1, Math.max(0, this.accumulator / this.simDt));
    const eyePrev = eyeHeightOf(prev, this.balance);
    const eyeHeight = eyePrev + (eyeHeightOf(state, this.balance) - eyePrev) * alpha;

    const g = this.balance.items.grenade;
    // Predicted cook.explodesAt is on the server clock (predicted tick of the pin pull + fuseMs), so the ring shows at
    // once on the press; the authoritative value takes over when the snapshot has it.
    const cooking = acts.cook !== null;
    const explodesAt = snapLocal?.cookExplodesAt ?? acts.cook?.explodesAt ?? null;
    const fuseLeft = cooking && explodesAt !== null ? Math.min(g.fuseMs, Math.max(0, explodesAt - now)) : null;
    const cook: HudCookView | null = fuseLeft === null ? null : { fuseRemainingMs: fuseLeft, fuseMs: g.fuseMs };

    let arc: GrenadeArcView | null = null;
    const ready = acts.swapRemainingMs === 0 && acts.throwRecoveryMs === 0 && !state.dropping && (cooking || acts.inv.grenades > 0);
    if (this.arcBuilder && held === 'grenade' && ready) {
      const feet = predictedLocal.pos;
      const eye = { x: feet.x, y: feet.y + eyeHeight, z: feet.z };
      const proneSettled = state.stance === 'prone' && isStanceSettled(state);
      try {
        arc = this.arcBuilder({
          eye,
          yaw: this.input.state.yaw,
          pitch: this.input.state.pitch,
          proneSettled,
          fuseRemainingMs: fuseLeft ?? g.fuseMs,
          maxSeconds: this.tuning.grenadeArcPreviewSeconds,
        });
      } catch (err) {
        console.error('[ClientGame] grenade arc preview failed', err);
      }
    }

    const chest = chestPoint(predictedLocal.pos, state, this.balance);
    const danger = grenadeDanger(grenades, chest, this.input.state.yaw, this.balance, now);
    // REVIEW-M2a addendum: RMB held with a sighted weapon, but a reload or heal blocks ADS.
    const sighted = held !== 'grenade' && sightOf(this.balance, held) !== 'none';
    const adsBlocked: AdsBlockReason | null =
      this.input.state.adsActive && sighted ? (acts.reload ? 'reloading' : acts.heal ? 'healing' : null) : null;
    return { held, ads, cooking, cook, arc, grenades, danger, eyeHeight, adsBlocked };
  }

  /** localAdsChanged on each engage/exit of the predicted ADS (adsMs 0 -> > 0 and back). */
  private updateAdsEdge(engagedWeapon: WeaponId | null): void {
    const prev = this.adsEngaged;
    if (engagedWeapon !== null && (prev === null || prev.weapon !== engagedWeapon)) {
      if (prev) this.bus.emit('localAdsChanged', { engaged: false, weapon: prev.weapon, sight: prev.sight });
      const sight = sightOf(this.balance, engagedWeapon);
      this.adsEngaged = { weapon: engagedWeapon, sight };
      this.bus.emit('localAdsChanged', { engaged: true, weapon: engagedWeapon, sight });
    } else if (engagedWeapon === null && prev !== null) {
      this.adsEngaged = null;
      this.bus.emit('localAdsChanged', { engaged: false, weapon: prev.weapon, sight: prev.sight });
    }
  }
}

/** HudView.cameraView from the camera case. */
function hudCameraView(c: CameraView): NonNullable<HudView['cameraView']> {
  return c.view === 'firstPerson' ? 'firstPerson' : c.view === 'chase' ? 'chase' : 'orbit';
}
