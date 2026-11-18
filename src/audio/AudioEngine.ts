/**
 * Web Audio engine. Owner: audio-designer. Spec: docs/audio/AUDIO.md.
 *
 *   constructor(bus) subscribes to every GameEvent it voices, but creates NO AudioContext. Until unlock() succeeds,
 *   events are dropped silently. unlock() (first user gesture, called by main.ts) creates the context, the mix
 *   graph (sfx / ui / ambience -> duck -> master -> limiter -> destination) and starts the ambience beds.
 *
 * Flow: bus event -> AudioDirector (pure mapping) -> AudioCommand -> play/stop/duck here.
 * Every one-shot is a pooled voice (VoicePool: per-cue limits, priority stealing); its nodes are disconnected when
 * it ends (reaped in update()). Positional voices: per-voice gain (distance) -> optional low-pass (air) -> Panner
 * (direction only, rolloff 0) -> bus.
 */
import type { IAudio, UiSoundId } from '../shared/contracts';
import type { EventBus, GameEventName, GameEvents } from '../shared/events';
import type { Vec3 } from '../shared/types';
import { Ambience } from './Ambience';
import { AudioDirector, type AudioCommand, type PlayCommand } from './AudioDirector';
import { AUDIO_TUNING, CUES, type BusId, type CueId } from './cues';
import { Ducker } from './Ducker';
import { createNoiseBank, type NoiseBank } from './noise';
import { RECIPES } from './recipes';
import {
  AIR_FILTER_BYPASS_HZ,
  airCutoffHz,
  dbToGain,
  dist3,
  distanceGain,
  effectivePriority,
  panningModelFor,
  variation,
  volumeToGain,
} from './spatial';
import type { Voice } from './synth';
import { VoicePool, type PoolVoice } from './VoicePool';

export interface AudioEngineOptions {
  /** Context factory (tests inject a fake). Default: window.AudioContext / webkitAudioContext. */
  createContext?: () => AudioContext;
  /** [0,1) random source for variation (tests inject a seeded one). Default Math.random. */
  rand?: () => number;
  /**
   * Heartbeat threshold (local HP). main.ts injects balance `player.lowHpThreshold` (ADR 0003). Undefined or invalid
   * falls back to AUDIO_TUNING.lowHealthHp (30, matching the HUD).
   */
  lowHealthHp?: number;
}

/** Low-health heartbeat threshold in HP: the injected value when it is a positive finite number, else the default. */
export function resolveLowHealthHp(injected: number | undefined): number {
  return injected !== undefined && Number.isFinite(injected) && injected > 0 ? injected : AUDIO_TUNING.lowHealthHp;
}

const BUS_IDS: readonly BusId[] = ['sfx', 'ui', 'ambience'];
/** Contract UiSoundId -> cue. Unknown ids (a newer Ui talking to an older engine) are ignored. */
const UI_SOUND_CUES: Readonly<Record<UiSoundId, CueId>> = { 'ui.click': 'ui.click', 'ui.hover': 'ui.hover', 'ui.slider': 'ui.slider' };
/** Small scheduling lookahead so envelopes never start in the past. */
const LOOKAHEAD_S = 0.005;

interface Graph {
  master: GainNode;
  limiter: DynamicsCompressorNode;
  buses: Record<BusId, GainNode>;
  ducks: Record<BusId, GainNode>;
  noise: NoiseBank;
  ambience: Ambience;
}

/** One playing sound: the Voice handed to its recipe plus the bookkeeping to stop and disconnect it. */
class ActiveVoice implements Voice {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  loopKey: string | null = null;
  constructor(
    readonly ctx: BaseAudioContext,
    readonly out: GainNode,
    readonly t: number,
    readonly pitch: number,
    readonly intensity: number,
    readonly variant: string,
    readonly local: boolean,
    readonly distance: number,
    readonly durationS: number,
    readonly noise: NoiseBank,
    readonly rand: () => number,
  ) {}
  addSource(s: AudioScheduledSourceNode): void {
    this.sources.push(s);
  }
  addNode(n: AudioNode): void {
    this.nodes.push(n);
  }
  /** Fade out and stop all sources by `now + fade`. */
  fadeStop(now: number, fade: number): void {
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const s of this.sources) {
      try {
        s.stop(now + fade + 0.01);
      } catch {
        // Some browsers throw on a second stop(); the voice is ending either way.
      }
    }
  }
  disconnectAll(): void {
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
  }
}

function defaultCreateContext(): AudioContext {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) throw new Error('Web Audio API not available');
  return new Ctor({ latencyHint: 'interactive' });
}

export class AudioEngine implements IAudio {
  private ctx: AudioContext | null = null;
  private graph: Graph | null = null;
  private disposed = false;
  private failed = false;

  private readonly director: AudioDirector;
  private readonly unsubs: (() => void)[] = [];
  private readonly pool = new VoicePool<ActiveVoice>(AUDIO_TUNING.maxVoices);
  private readonly loops = new Map<string, PoolVoice<ActiveVoice>>();
  private readonly dying: { voice: ActiveVoice; at: number }[] = [];
  private readonly lastPlayed = new Map<CueId, number>();
  private readonly ducker = new Ducker();
  private readonly appliedDuckDb: Record<BusId, number> = { sfx: 0, ui: 0, ambience: 0 };
  private readonly rand: () => number;
  private readonly vary: [number, number] = [1, 1];

  private readonly listenerPos: Vec3 = { x: 0, y: 0, z: 0 };
  private listenerYaw = 0;
  private volume = 1;
  private lowHealth = false;
  private heartbeatTimer = 0;
  private gullTimer: number;
  private readonly gullPos: Vec3 = { x: 0, y: 0, z: 0 };

  private readonly releaseVoice = (pv: PoolVoice<ActiveVoice>): void => {
    const v = pv.handle;
    if (v.loopKey !== null && this.loops.get(v.loopKey) === pv) this.loops.delete(v.loopKey);
    v.disconnectAll();
  };

  constructor(
    bus: EventBus<GameEvents>,
    private readonly options: AudioEngineOptions = {},
  ) {
    this.rand = options.rand ?? Math.random;
    this.gullTimer = this.nextGullDelay();
    this.director = new AudioDirector((cmd) => this.exec(cmd), {
      lowHealthHp: resolveLowHealthHp(options.lowHealthHp),
    });

    const d = this.director;
    this.sub(bus, 'matchPhaseChanged', (e) => d.matchPhaseChanged(e));
    this.sub(bus, 'countdown', (e) => d.countdown(e));
    this.sub(bus, 'localPlayerSpawned', (e) => d.localPlayerSpawned(e));
    this.sub(bus, 'shotFired', (e) => d.shotFired(e));
    this.sub(bus, 'dryFire', (e) => d.dryFire(e));
    this.sub(bus, 'playerDamaged', (e) => d.playerDamaged(e));
    this.sub(bus, 'localHitConfirmed', (e) => d.localHitConfirmed(e));
    this.sub(bus, 'playerKilled', (e) => d.playerKilled(e));
    this.sub(bus, 'itemPickedUp', (e) => d.itemPickedUp(e));
    this.sub(bus, 'reloadStarted', (e) => d.reloadStarted(e));
    this.sub(bus, 'reloadFinished', (e) => d.reloadFinished(e));
    this.sub(bus, 'healStarted', (e) => d.healStarted(e));
    this.sub(bus, 'healFinished', (e) => d.healFinished(e));
    this.sub(bus, 'healCancelled', (e) => d.healCancelled(e));
    this.sub(bus, 'weaponSwitched', (e) => d.weaponSwitched(e));
    this.sub(bus, 'actionFailed', (e) => d.actionFailed(e));
    this.sub(bus, 'zoneChanged', (e) => d.zoneChanged(e));
    this.sub(bus, 'zoneWarning', (e) => d.zoneWarning(e));
    this.sub(bus, 'localZoneStatusChanged', (e) => d.localZoneStatusChanged(e));
    this.sub(bus, 'footstep', (e) => d.footstep(e));
    this.sub(bus, 'jump', (e) => d.jump(e));
    this.sub(bus, 'land', (e) => d.land(e));
    this.sub(bus, 'matchEnded', (e) => d.matchEnded(e));
    this.sub(bus, 'interactPromptChanged', (e) => d.interactPromptChanged(e));
    this.sub(bus, 'spectateTargetChanged', (e) => d.spectateTargetChanged(e));
    this.sub(bus, 'connectionStatus', (e) => d.connectionStatus(e));

    // UI sounds arrive through playUi() (Ui -> UiCallbacks.playUiSound -> main.ts), and main.ts calls unlock() on
    // every pointerdown/keydown, so the only document listener left is tab visibility (suspend while hidden).
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  // --- IAudio ------------------------------------------------------------------------------
  unlock(): void {
    if (this.disposed || this.failed) return;
    if (this.ctx) {
      this.resumeIfSuspended();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = (this.options.createContext ?? defaultCreateContext)();
    } catch (err) {
      this.failed = true;
      console.warn('[audio] Web Audio unavailable; running silent.', err);
      return;
    }
    this.ctx = ctx;
    this.graph = this.buildGraph(ctx);
    this.applyListener();
    this.resumeIfSuspended();
  }

  setListener(pos: Vec3, yaw: number): void {
    this.listenerPos.x = pos.x;
    this.listenerPos.y = pos.y;
    this.listenerPos.z = pos.z;
    this.listenerYaw = yaw;
    this.applyListener();
  }

  setVolume(master: number): void {
    this.volume = master;
    const ctx = this.ctx;
    if (ctx && this.graph) this.graph.master.gain.setTargetAtTime(volumeToGain(master), ctx.currentTime, 0.03);
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g) return;
    const now = ctx.currentTime;

    this.pool.reap(now, this.releaseVoice);
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i] as { voice: ActiveVoice; at: number };
      if (d.at <= now) {
        d.voice.disconnectAll();
        this.dying[i] = this.dying[this.dying.length - 1] as { voice: ActiveVoice; at: number };
        this.dying.pop();
      }
    }

    for (const bus of BUS_IDS) {
      const db = this.ducker.targetDb(bus, now);
      if (db !== this.appliedDuckDb[bus]) {
        const attack = db < this.appliedDuckDb[bus];
        g.ducks[bus].gain.setTargetAtTime(dbToGain(db), now, attack ? 0.015 : 0.3);
        this.appliedDuckDb[bus] = db;
      }
    }

    if (ctx.state !== 'running') return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;

    if (this.lowHealth) {
      this.heartbeatTimer -= step;
      if (this.heartbeatTimer <= 0) {
        this.heartbeatTimer = AUDIO_TUNING.heartbeatIntervalS;
        this.play({ kind: 'play', cue: 'heartbeat', pos: null });
      }
    }

    this.gullTimer -= step;
    if (this.gullTimer <= 0) {
      this.gullTimer = this.nextGullDelay();
      const ang = this.rand() * Math.PI * 2;
      const r = 30 + this.rand() * 50;
      this.gullPos.x = this.listenerPos.x + Math.cos(ang) * r;
      this.gullPos.y = this.listenerPos.y + 15 + this.rand() * 15;
      this.gullPos.z = this.listenerPos.z + Math.sin(ang) * r;
      this.play({ kind: 'play', cue: 'amb.gull', pos: this.gullPos });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    this.pool.clear((pv) => pv.handle.disconnectAll());
    for (const d of this.dying) d.voice.disconnectAll();
    this.dying.length = 0;
    this.loops.clear();
    if (this.graph) {
      this.graph.ambience.dispose();
      this.graph.master.disconnect();
      this.graph.limiter.disconnect();
      for (const b of BUS_IDS) {
        this.graph.buses[b].disconnect();
        this.graph.ducks[b].disconnect();
      }
    }
    this.graph = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  /** Non-positional UI sound (IAudio.playUi; main.ts wires UiCallbacks.playUiSound here). Dropped before unlock. */
  playUi(id: UiSoundId): void {
    if (this.disposed) return;
    const cue: CueId | undefined = UI_SOUND_CUES[id];
    if (cue) this.play({ kind: 'play', cue, pos: null });
  }

  // --- Extra API (not on IAudio) -----------------------------------------------------------

  /** True once an AudioContext exists. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Live pooled voices (debug/tests). */
  get voiceCount(): number {
    return this.pool.size;
  }

  // --- internals ---------------------------------------------------------------------------
  private sub<K extends GameEventName>(bus: EventBus<GameEvents>, type: K, handler: (e: GameEvents[K]) => void): void {
    this.unsubs.push(
      bus.on(type, (e) => {
        // Before unlock (or after dispose) every event is dropped silently, including director state updates.
        if (this.ctx && this.graph) handler(e);
      }),
    );
  }

  private exec(cmd: AudioCommand): void {
    const ctx = this.ctx;
    if (!ctx || !this.graph) return;
    switch (cmd.kind) {
      case 'play':
        this.play(cmd);
        return;
      case 'stop':
        this.stopLoop(cmd.loopKey, ctx.currentTime, AUDIO_TUNING.loopStopFadeS);
        return;
      case 'stopLoops':
        for (const key of [...this.loops.keys()]) this.stopLoop(key, ctx.currentTime, AUDIO_TUNING.loopStopFadeS);
        return;
      case 'duck':
        this.ducker.duck(cmd.bus, cmd.db, ctx.currentTime, cmd.holdS);
        return;
      case 'lowHealth':
        this.lowHealth = cmd.active;
        this.heartbeatTimer = 0;
        return;
      case 'surf':
        this.graph.ambience.setSurf(cmd.active);
        return;
    }
  }

  private play(cmd: PlayCommand): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g || ctx.state !== 'running') return;
    const def = CUES[cmd.cue];
    const now = ctx.currentTime;

    const last = this.lastPlayed.get(cmd.cue);
    if (def.cooldownS > 0 && last !== undefined && now - last < def.cooldownS) return;

    const pos = def.spatial ? cmd.pos : null;
    let d = 0;
    let distGain = 1;
    if (pos) {
      d = dist3(this.listenerPos, pos);
      distGain = distanceGain(d, def.refDistance, def.maxDistance, def.rolloff);
      if (distGain < 0.002) return; // culled: no nodes created
    }

    if (cmd.loopKey) this.stopLoop(cmd.loopKey, now, AUDIO_TUNING.stealFadeS);
    this.pool.reap(now, this.releaseVoice);
    const priority = effectivePriority(def.priority, pos ? d : null, def.maxDistance);
    const adm = this.pool.admit(cmd.cue, priority, def.maxInstances);
    if (adm.kind === 'reject') return;
    if (adm.kind === 'steal') this.kill(adm.victim, now, AUDIO_TUNING.stealFadeS);

    variation(def.pitchJitter, def.gainJitterDb, this.rand, this.vary);
    const out = ctx.createGain();
    out.gain.value = def.gain * (cmd.gain ?? 1) * this.vary[1] * distGain;
    const voice = new ActiveVoice(
      ctx, out, now + LOOKAHEAD_S, this.vary[0], cmd.intensity ?? 0, cmd.variant ?? '', pos === null, d,
      cmd.durationS ?? 0, g.noise, this.rand,
    );
    voice.addNode(out);

    let tail: AudioNode = out;
    if (pos) {
      const cutoff = airCutoffHz(d);
      if (cutoff < AIR_FILTER_BYPASS_HZ) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = cutoff;
        lp.Q.value = 0.5;
        tail.connect(lp);
        tail = lp;
        voice.addNode(lp);
      }
      const p = ctx.createPanner();
      p.panningModel = panningModelFor(d);
      p.distanceModel = 'linear';
      p.rolloffFactor = 0; // distance loudness is applied on `out`
      setPannerPosition(p, pos);
      tail.connect(p);
      tail = p;
      voice.addNode(p);
    }
    tail.connect(g.buses[def.bus]);

    let len: number;
    try {
      len = RECIPES[cmd.cue](voice);
    } catch (err) {
      voice.disconnectAll();
      console.warn(`[audio] recipe "${cmd.cue}" failed`, err);
      return;
    }
    if (!(len > 0) || !Number.isFinite(len)) len = 0.1;

    const pv = this.pool.add(cmd.cue, priority, now, voice.t + len + 0.05, voice);
    if (cmd.loopKey) {
      voice.loopKey = cmd.loopKey;
      this.loops.set(cmd.loopKey, pv);
    }
    this.lastPlayed.set(cmd.cue, now);
  }

  /** Removes a voice from the pool now, fades it, and disconnects it shortly after. */
  private kill(pv: PoolVoice<ActiveVoice>, now: number, fade: number): void {
    if (!this.pool.remove(pv)) return;
    const v = pv.handle;
    if (v.loopKey !== null && this.loops.get(v.loopKey) === pv) this.loops.delete(v.loopKey);
    v.fadeStop(now, fade);
    this.dying.push({ voice: v, at: now + fade + 0.05 });
  }

  private stopLoop(key: string, now: number, fade: number): void {
    const pv = this.loops.get(key);
    if (!pv) return;
    this.loops.delete(key);
    this.kill(pv, now, fade);
  }

  private buildGraph(ctx: AudioContext): Graph {
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = volumeToGain(this.volume);
    master.connect(limiter);

    const mk = (bus: BusId): [GainNode, GainNode] => {
      const duck = ctx.createGain();
      duck.gain.value = 1;
      duck.connect(master);
      const level = ctx.createGain();
      level.gain.value = AUDIO_TUNING.busGain[bus];
      level.connect(duck);
      return [level, duck];
    };
    const [sfx, sfxDuck] = mk('sfx');
    const [ui, uiDuck] = mk('ui');
    const [amb, ambDuck] = mk('ambience');

    const noise = createNoiseBank(ctx);
    const ambience = new Ambience(ctx, noise, amb);
    return {
      master,
      limiter,
      buses: { sfx, ui, ambience: amb },
      ducks: { sfx: sfxDuck, ui: uiDuck, ambience: ambDuck },
      noise,
      ambience,
    };
  }

  private applyListener(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const L = ctx.listener;
    const p = this.listenerPos;
    const fx = -Math.sin(this.listenerYaw);
    const fz = -Math.cos(this.listenerYaw);
    if (L.positionX) {
      L.positionX.value = p.x;
      L.positionY.value = p.y;
      L.positionZ.value = p.z;
      L.forwardX.value = fx;
      L.forwardY.value = 0;
      L.forwardZ.value = fz;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else {
      // Older Firefox/Safari: deprecated setters.
      L.setPosition(p.x, p.y, p.z);
      L.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  private resumeIfSuspended(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      void ctx.resume().catch(() => undefined);
    }
  }

  private readonly onVisibility = (): void => {
    const ctx = this.ctx;
    if (!ctx || this.disposed || typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      if (ctx.state === 'running') void ctx.suspend().catch(() => undefined);
    } else this.resumeIfSuspended();
  };

  private nextGullDelay(): number {
    const { gullMinIntervalS: lo, gullMaxIntervalS: hi } = AUDIO_TUNING;
    return lo + this.rand() * (hi - lo);
  }
}

function setPannerPosition(p: PannerNode, pos: Vec3): void {
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else {
    p.setPosition(pos.x, pos.y, pos.z);
  }
}
