/**
 * Client game controller (ARCHITECTURE §6-§8, §12). Owner: game-developer.
 *
 * update(dt) order:
 *   1. drain queued net messages: welcome/status/snapshots (reconcile) and sim events (translate to the bus)
 *   2. local fixed steps at SIM_DT: sample input -> send -> predict (0..MAX_STEPS_PER_FRAME)
 *   3. remotes = net.getInterpolated(serverNow - interpolationDelayMs)
 *   4. spectate target, camera, interact prompt, zone status, footsteps/jump/land, countdown, zone warning
 *   5. build FrameView + HudView
 *
 * ClientGame is the only bus emitter. It never imports render/ui/audio and sees the network only via INetClient.
 */
import type { Balance } from '../shared/balance';
import { MAX_STEPS_PER_FRAME } from '../shared/constants';
import type {
  CameraView,
  ClientFrame,
  ClientGameDeps,
  FrameView,
  IClientGame,
  INetClient,
  PlayerView,
  Settings,
} from '../shared/contracts';
import type { EventBus, GameEvents } from '../shared/events';
import { vec3 } from '../shared/math';
import { effectiveSpreadDeg } from '../shared/sim/combat';
import { createMovementContext, stepMovement, toMovementInput, type MovementContext } from '../shared/sim/movement';
import { surfaceAt } from '../shared/sim/terrain';
import type {
  ConnectionStatus,
  LocalPlayerState,
  MapData,
  PlayerId,
  PlayerState,
  MovementStepResult,
  SimEvent,
  Vec3,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import { followCamera, orbitCamera } from './camera';
import {
  CountdownTracker,
  findNearestLoot,
  InteractPromptTracker,
  PhaseTracker,
  RemoteMotionTracker,
  StrideCounter,
  ZoneStatusTracker,
  ZoneTracker,
  type SurfaceFn,
} from './derived';
import { buildHudView, type LocalPose } from './hudBuilder';
import { InputController, type InputDriver } from './input/InputController';
import { cycleSlot, InputState } from './input/InputState';
import { actionsFromSnapshot, actionStatusModel, type PredictedActions } from './actionPrediction';
import { installDevHook, type DevGameState } from './devHook';
import { Predictor, type PredictStep } from './prediction';
import { translateSimEvent, type TranslateContext } from './simEvents';
import { SpectateController, spectateOrder } from './spectate';
import { resolveClientTuning, type ClientTuning } from './tuning';
import { isOutsideZone, zoneAt } from './zoneView';

type NetMessage =
  | { kind: 'welcome'; welcome: WelcomeInfo }
  | { kind: 'snapshot'; snapshot: WorldSnapshot }
  | { kind: 'events'; events: SimEvent[]; serverTime: number }
  | { kind: 'status'; status: ConnectionStatus; reason?: string };

/** Test/tooling hooks. main.ts uses the defaults. */
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
}

export class ClientGame implements IClientGame {
  private readonly bus: EventBus<GameEvents>;
  private readonly net: INetClient;
  private readonly balance: Balance;
  private readonly tuning: ClientTuning;
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

  private readonly serverUrl: string;
  private readonly getMap: (id: string) => MapData;
  private map: MapData;
  private movementCtx: MovementContext | null = null;
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
  private lastSprintInput = false;
  /** Last frame's view states by id (positions for events without one). */
  private viewPlayers = new Map<PlayerId, PlayerState>();

  constructor(deps: ClientGameDeps, options: ClientGameOptions = {}) {
    this.bus = deps.bus;
    this.net = deps.net;
    this.balance = deps.balance;
    this.map = deps.initialMap;
    this.tuning = resolveClientTuning(deps.balance, options.tuning);
    this.simDt = 1 / deps.balance.net.simHz;
    this.customStep = options.step ?? null;
    this.surface = options.surfaceAt ?? ((x, z) => surfaceAt(x, z, this.map));

    this.predictor = new Predictor(
      (state, input, status) => this.stepLocal(state, input, status),
      {
        snapDistance: this.tuning.correctionSnapDistance,
        decayMs: this.tuning.correctionDecayMs,
        maxPending: this.tuning.maxPendingInputs,
      },
      actionStatusModel(deps.balance),
    );

    this.input =
      options.input ??
      new InputController(new InputState(this.tuning.mouseRadiansPerPixel), deps.inputTarget, {
        shouldLockOnClick: () => this.joined && this.currentPhase() === 'playing',
      });

    this.net.setHandlers({
      onWelcome: (welcome) => this.queue.push({ kind: 'welcome', welcome }),
      onSnapshot: (snapshot) => this.queue.push({ kind: 'snapshot', snapshot }),
      onEvents: (events, serverTime) => this.queue.push({ kind: 'events', events, serverTime }),
      onStatus: (status, reason) => this.queue.push({ kind: 'status', status, reason }),
    });

    this.serverUrl = deps.serverUrl;
    this.getMap = deps.getMap;

    this.removeDevHook = (options.installDevHook ?? installDevHook)(() => this.devState());
  }

  // -------------------------------------------------------------------------------------------
  // IClientGame
  // -------------------------------------------------------------------------------------------

  join(name: string): void {
    if (this.disposed) return;
    this.joinName = name;
    this.net.connect(this.serverUrl, name);
  }

  playAgain(): void {
    // The server re-queues connected humans automatically. Only reconnect if the connection is gone.
    if (this.disposed || !this.joinName) return;
    if (this.net.status === 'disconnected' || this.net.status === 'error' || this.net.status === 'idle') {
      this.net.connect(this.serverUrl, this.joinName);
    }
  }

  setSettings(settings: Settings): void {
    this.input.state.setSensitivity(settings.mouseSensitivity, settings.invertY);
  }

  requestPointerLock(): void {
    this.input.requestLock();
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

    const zone: ZoneState | null = snap?.zone ? zoneAt(snap.zone, snap.serverTime, now) : null;
    this.updateDerived(players, predictedLocal, zone, now);

    const spectating = this.isSpectating();
    const candidates = spectating ? spectateOrder(players, this.localId) : null;
    if (this.input.state.consumeSpectateNext() && candidates && this.spectate.next(candidates)) {
      this.emitSpectateChanged(players);
    } else if (this.spectate.update(candidates)) {
      this.emitSpectateChanged(players);
    }
    const spectateTarget =
      this.spectate.targetId === null ? null : (players.find((p) => p.id === this.spectate.targetId) ?? null);

    this.viewPlayers = new Map(players.map((p) => [p.id, p]));

    // 5. Views.
    const localView = this.localId === null ? undefined : players.find((p) => p.id === this.localId);
    const camera = this.buildCamera(predictedLocal, localView, spectateTarget);
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
    };

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
      crosshairSpreadDeg: this.crosshairSpread(predictedLocal),
      cameraFovDeg: camera.fovDeg,
    });

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
    return {
      connection: this.connection,
      joined: this.joined,
      phase: this.currentPhase(),
      matchId: snap?.match.matchId ?? null,
      localId: this.localId,
      localAlive: local?.alive ?? false,
      localHp: local ? local.hp : null,
      localArmor: local ? local.armor : null,
      localPos: local ? { ...local.pos } : null,
      localWeapon: local ? local.weapon : null,
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
      players: (frame?.players ?? []).map(({ state }) => ({
        id: state.id,
        name: state.name,
        alive: state.alive,
        isBot: state.isBot,
        hp: state.hp,
        pos: { ...state.pos },
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
              translateSimEvent(ev, ctx, this.bus);
              this.afterSimEvent(ev);
            }
            break;
          }
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
    if (welcome.mapId !== this.map.id) {
      console.error(`[ClientGame] server map "${welcome.mapId}" differs from the loaded map "${this.map.id}"`);
      try {
        this.map = this.getMap(welcome.mapId);
        this.movementCtx = null;
      } catch (err) {
        console.error('[ClientGame] unknown map id from server', err);
      }
    }
  }

  private onStatus(status: ConnectionStatus, reason?: string): void {
    this.connection = status;
    this.bus.emit('connectionStatus', reason === undefined ? { status } : { status, reason });
    // Anything but 'connected' (connecting to a new session, idle after disconnect(), dropped, error) ends the
    // current session; the next welcome starts a fresh one.
    if (status !== 'connected') {
      this.joined = false;
      this.snapshot = null;
      this.localId = null;
      this.resetMatchState();
      this.phaseTracker.reset();
    }
  }

  private onSnapshot(snap: WorldSnapshot): void {
    const prev = this.snapshot;
    this.snapshot = snap;
    if (prev && prev.match.matchId !== snap.match.matchId) this.resetMatchState();

    this.phaseTracker.onSnapshot(snap.match, this.bus);
    this.zoneTracker.onSnapshot(snap.zone, this.bus);

    const local = snap.local;
    const localPlayer = local ? snap.players.find((p) => p.id === local.id) : undefined;
    if (local && localPlayer?.alive) {
      const wasActive = this.predictor.active;
      const res = this.predictor.reconcile(
        local.movement,
        local.lastProcessedInputSeq,
        actionsFromSnapshot(local, localPlayer.hp),
      );
      if (wasActive) this.lastCorrection = res.correction;
      if (!wasActive) {
        this.input.state.setLook(localPlayer.yaw, localPlayer.pitch);
        this.localStrides.reset();
      }
    } else {
      this.predictor.reset();
    }
  }

  private afterSimEvent(ev: SimEvent): void {
    if (ev.type === 'kill') {
      this.spectate.onKill(ev.victimId, ev.killerId, this.localId);
      if (ev.victimId === this.localId) {
        this.localDeathAt = this.time;
        this.predictor.reset();
      }
    }
  }

  private translateContext(): TranslateContext {
    return { localId: this.localId, nameOf: (id) => this.nameOf(id), posOf: (id) => this.posOf(id) };
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
    this.spectate.clearPreference();
    this.zoneTracker.reset();
    this.remoteMotion.reset();
    this.localStrides.reset();
    this.accumulator = 0;
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

  private canControl(): boolean {
    return (
      this.joined &&
      this.localId !== null &&
      this.currentPhase() === 'playing' &&
      this.predictor.active &&
      this.snapshot?.local != null
    );
  }

  private fixedStep(): void {
    const local = this.snapshot?.local;
    if (!this.canControl() || !local) {
      this.input.state.clearEdges();
      return;
    }
    const { input, firePressed } = this.input.state.sample(++this.seq, this.simDt, (dir) =>
      cycleSlot(local.activeSlot, [local.slots[0] !== null, local.slots[1] !== null], dir),
    );
    if (firePressed) this.maybeDryFire(local);
    this.net.sendInput(input);
    this.lastSprintInput = input.sprint;

    const prevState = this.predictor.state;
    const result = this.predictor.apply(input);
    if (!result || !prevState || this.localId === null) return;
    this.emitLocalMotion(prevState.pos, result, input.sprint);
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
      });
    }
  }

  private maybeDryFire(local: LocalPlayerState): void {
    if (local.activeSlot === 2 || local.reloadRemainingMs > 0 || this.predictor.state?.dropping) return;
    const slot = local.slots[local.activeSlot];
    if (slot && slot.mag <= 0) this.bus.emit('dryFire', { weapon: slot.weapon });
  }

  private stepLocal: PredictStep = (state, input, status) => {
    if (this.customStep) return this.customStep(state, input, status);
    if (!this.movementCtx) this.movementCtx = createMovementContext(this.map, this.balance);
    return stepMovement(state, toMovementInput(input, status, this.balance), input.dt, this.movementCtx);
  };

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

  /** Local PlayerState with predicted position, live mouse yaw/pitch and movement-derived anim flags. */
  private buildPredictedLocal(base: PlayerState | undefined): PlayerState | null {
    const state = this.predictor.state;
    if (!base || !state || !base.alive) return null;
    const pos = this.predictor.renderPosition(this.accumulator / this.simDt) ?? state.pos;
    const hSpeed = Math.hypot(state.vel.x, state.vel.z);
    const moving = hSpeed > this.tuning.animMoveSpeed;
    return {
      ...base,
      pos,
      velY: state.vel.y,
      yaw: this.input.state.yaw,
      pitch: this.input.state.pitch,
      anim: {
        ...base.anim,
        moving,
        sprinting: moving && this.lastSprintInput && state.grounded && hSpeed > this.balance.movement.walkSpeed,
        airborne: !state.grounded,
        dropping: state.dropping,
      },
    };
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
    if (this.localDeathAt === null) return true;
    return this.time - this.localDeathAt >= this.balance.match.deathScreenSeconds;
  }

  private emitSpectateChanged(players: readonly PlayerState[]): void {
    const id = this.spectate.targetId;
    const name = id === null ? null : (players.find((p) => p.id === id)?.name ?? this.nameOf(id));
    this.bus.emit('spectateTargetChanged', { targetId: id, targetName: name });
  }

  private updateDerived(players: readonly PlayerState[], predictedLocal: PlayerState | null, zone: ZoneState | null, now: number): void {
    const snap = this.snapshot;
    const phase = this.currentPhase();

    this.countdown.update(phase === 'countdown' ? (snap?.match.phaseEndsAt ?? null) : null, now, this.bus);
    if (snap) {
      this.zoneTracker.updateWarning(zone, now, snap.match.matchId, this.balance.zone.warningSecondsBeforeShrink, this.bus);
    }

    const predicted = this.predictor.state;
    // Zone in/out for the (predicted) local player.
    this.zoneStatus.set(predictedLocal !== null && zone !== null && isOutsideZone(predictedLocal.pos, zone), this.bus);

    // Interact prompt: nearest loot in range of the predicted feet, only when able to pick up.
    const canLoot = predictedLocal !== null && predicted !== null && !predicted.dropping && phase === 'playing';
    this.prompt.set(
      canLoot && snap && predicted ? findNearestLoot(snap.loot, predicted.pos, this.balance.player.pickupRange) : null,
      this.bus,
    );

    // Remote footsteps/jump/land (local ones come from the prediction steps).
    this.remoteMotion.update(players, this.localId, this.surface, this.tuning, this.bus);
  }

  private buildCamera(
    predictedLocal: PlayerState | null,
    localView: PlayerState | undefined,
    spectateTarget: PlayerState | null,
  ): CameraView {
    const eye = this.balance.player.eyeHeight;
    const look = this.input.state;
    if (predictedLocal) return followCamera(predictedLocal.pos, look.yaw, look.pitch, eye, this.tuning);
    if (spectateTarget) return followCamera(spectateTarget.pos, spectateTarget.yaw, spectateTarget.pitch, eye, this.tuning);
    const phase = this.currentPhase();
    // Death screen: stay on our own body until spectating starts.
    if (localView && this.snapshot?.local && (phase === 'playing' || phase === 'results')) {
      return followCamera(localView.pos, look.yaw, look.pitch, eye, this.tuning);
    }
    return orbitCamera(this.map, this.time, this.tuning);
  }

  private crosshairSpread(predictedLocal: PlayerState | null): number {
    const state = this.predictor.state;
    if (!predictedLocal || !state) return 0;
    return effectiveSpreadDeg(predictedLocal.weapon, this.balance, {
      horizontalSpeed: Math.hypot(state.vel.x, state.vel.z),
      airborne: !state.grounded,
    });
  }
}
