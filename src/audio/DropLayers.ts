/**
 * Persistent, continuously controlled drop sounds (M2b, drop.md "Audio and VFX"). Pooled voices are fire-and-forget,
 * but these follow live state every frame, so they are beds like Ambience:
 *
 * - carrier engine: seaplane prop drone (low saws, blade-pass chop, rumble) or delivery-drone rotor whine (four
 *   detuned saws, high buzz, rotor chop). Positional at the carrier (moved every frame along carrierPosAt), with the
 *   cue-style distance gain and air low-pass. Aboard, a 2D low-passed interior copy carries the cabin.
 * - door wind (aboard): band-passed rush through the open hatch.
 * - freefall wind: a low roar and a high whistle whose level and brightness rise with the measured fall speed, with
 *   buffeting.
 * - canopy flutter (chute): band-passed noise chopped at a fabric-flap rate.
 *
 * Each group is built on first need and disposed once it has been silent for a moment. Owner: audio-designer.
 */
import type { CarrierModel, Vec3 } from '../shared/types';
import { AUDIO_TUNING } from './cues';
import type { DropMix } from './drop';
import type { NoiseBank } from './noise';
import { AIR_FILTER_BYPASS_HZ, airCutoffHz, dist3, distanceGain, panningModelFor } from './spatial';

/** Seconds a silent group lingers before its nodes are released. */
const RELEASE_AFTER_S = 1.2;
/** Parameter smoothing time constant, seconds. */
const TC = 0.12;

/** A set of nodes and sources released together (also used by RocketLayers). */
export class Group {
  readonly nodes: AudioNode[] = [];
  readonly sources: AudioScheduledSourceNode[] = [];
  /** Context time it last had a non-zero target. */
  lastLive = 0;
  private readonly last = new Map<AudioParam, number>();

  constructor(readonly ctx: BaseAudioContext) {}

  gain(value: number, dest: AudioNode | AudioParam): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    connect(g, dest);
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  osc(type: OscillatorType, freq: number, dest: AudioNode | AudioParam): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    connect(o, dest);
    o.start(this.ctx.currentTime);
    this.sources.push(o);
    this.nodes.push(o);
    return o;
  }

  lfo(dest: AudioParam, rateHz: number, depth: number, type: OscillatorType = 'sine'): void {
    this.osc(type, rateHz, this.gain(depth, dest));
  }

  loop(buffer: AudioBuffer, rate: number, dest: AudioNode, rand: () => number): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(this.ctx.currentTime, rand() * buffer.duration * 0.9);
    this.sources.push(src);
    this.nodes.push(src);
  }

  /** Smoothly moves a param toward `value`; skips tiny changes so automation lists stay short. */
  set(p: AudioParam, value: number, tc = TC): void {
    const prev = this.last.get(p);
    if (prev !== undefined && Math.abs(prev - value) <= Math.max(1e-4, Math.abs(prev) * 0.01)) return;
    this.last.set(p, value);
    p.setTargetAtTime(value, this.ctx.currentTime, tc);
  }

  /** Drops the cached target of `p` so the next set() always schedules (after a manual ramp elsewhere). */
  forget(p: AudioParam): void {
    this.last.delete(p);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const s of this.sources) {
      try {
        s.stop(now);
      } catch {
        // already stopped
      }
    }
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        // already disconnected
      }
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.last.clear();
  }
}

function connect(n: AudioNode, dest: AudioNode | AudioParam): void {
  if ('connect' in dest) n.connect(dest);
  else n.connect(dest);
}

interface EngineGroup {
  g: Group;
  model: CarrierModel;
  exterior: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode;
  interior: GainNode;
}

interface WindGroup {
  g: Group;
  wind: GainNode;
  roarLp: BiquadFilterNode;
  whistleBp: BiquadFilterNode;
  whistle: GainNode;
  flutter: GainNode;
}

interface DoorGroup {
  g: Group;
  door: GainNode;
}

export class DropLayers {
  private engine: EngineGroup | null = null;
  private wind: WindGroup | null = null;
  private door: DoorGroup | null = null;

  /**
   * @param world  positional exterior engine goes here (the sfx bus: reverb indoors, muffles, cabin filter).
   * @param direct 2D cabin and body layers go here (bypasses the cabin filter).
   */
  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: NoiseBank,
    private readonly world: AudioNode,
    private readonly direct: AudioNode,
    private readonly rand: () => number,
  ) {}

  /** Applies this frame's mix. Cheap when everything is idle (no nodes exist). */
  apply(mix: DropMix, listener: Vec3): void {
    const now = this.ctx.currentTime;

    // --- carrier engine ---
    if (mix.carrierActive) {
      if (this.engine && this.engine.model !== mix.carrierModel) this.release('engine');
      const e = this.engine ?? (this.engine = this.buildEngine(mix.carrierModel));
      e.g.lastLive = now;
      const def = AUDIO_TUNING.carrier[mix.carrierModel];
      const d = dist3(listener, mix.carrierPos);
      const ext = def.gain * distanceGain(d, def.refDistance, def.maxDistance, def.rolloff);
      const aboardShare = 1 - mix.aboard * (1 - AUDIO_TUNING.aboardExteriorGain);
      e.g.set(e.exterior.gain, ext * aboardShare);
      e.g.set(e.interior.gain, def.gain * 0.75 * mix.aboard, 0.25);
      const cutoff = airCutoffHz(d);
      e.g.set(e.air.frequency, cutoff >= AIR_FILTER_BYPASS_HZ ? 20000 : cutoff, 0.3);
      e.panner.panningModel = panningModelFor(d);
      setPos(e.panner, mix.carrierPos);
    } else if (this.engine) {
      this.engine.g.set(this.engine.exterior.gain, 0, 0.25);
      this.engine.g.set(this.engine.interior.gain, 0, 0.25);
    }

    // --- door wind (aboard) ---
    if (mix.aboard > 0) {
      const dg = this.door ?? (this.door = this.buildDoor());
      dg.g.lastLive = now;
      dg.g.set(dg.door.gain, 0.22 * mix.aboard, 0.3);
    } else if (this.door) {
      // The jump: the door rush cuts quickly as you fall clear.
      this.door.g.set(this.door.door.gain, 0, 0.08);
    }

    // --- freefall wind and canopy flutter ---
    if (mix.wind > 0 || mix.flutter > 0) {
      const w = this.wind ?? (this.wind = this.buildWind());
      w.g.lastLive = now;
      const s = mix.wind;
      w.g.set(w.wind.gain, 0.55 * Math.pow(s, 1.3), 0.15);
      w.g.set(w.roarLp.frequency, 250 + 900 * s, 0.2);
      w.g.set(w.whistleBp.frequency, 900 + 1900 * s, 0.2);
      w.g.set(w.whistle.gain, 0.08 + 0.35 * s * s, 0.2);
      w.g.set(w.flutter.gain, 0.3 * mix.flutter, mix.flutter > 0 ? 0.05 : 0.15);
    } else if (this.wind) {
      this.wind.g.set(this.wind.wind.gain, 0, 0.12);
      this.wind.g.set(this.wind.flutter.gain, 0, 0.1);
    }

    // Release groups that have been silent for a while.
    if (this.engine && now - this.engine.g.lastLive > RELEASE_AFTER_S) this.release('engine');
    if (this.door && now - this.door.g.lastLive > RELEASE_AFTER_S) this.release('door');
    if (this.wind && now - this.wind.g.lastLive > RELEASE_AFTER_S) this.release('wind');
  }

  /** True while any group holds nodes (tests and debugging). */
  get active(): { engine: boolean; door: boolean; wind: boolean } {
    return { engine: this.engine !== null, door: this.door !== null, wind: this.wind !== null };
  }

  /** The exterior engine panner (tests). */
  get enginePanner(): PannerNode | null {
    return this.engine?.panner ?? null;
  }

  dispose(): void {
    this.release('engine');
    this.release('door');
    this.release('wind');
  }

  private release(which: 'engine' | 'door' | 'wind'): void {
    const grp = which === 'engine' ? this.engine : which === 'door' ? this.door : this.wind;
    grp?.g.dispose();
    if (which === 'engine') this.engine = null;
    else if (which === 'door') this.door = null;
    else this.wind = null;
  }

  private buildEngine(model: CarrierModel): EngineGroup {
    const g = new Group(this.ctx);
    const r = this.rand;
    // Output split: exterior (air low-pass -> panner -> world) and interior (cabin low-pass -> direct).
    const panner = this.ctx.createPanner();
    panner.distanceModel = 'linear';
    panner.rolloffFactor = 0; // loudness is the exterior gain
    panner.panningModel = 'equalpower';
    panner.connect(this.world);
    g.nodes.push(panner);
    const air = g.filter('lowpass', 20000, 0.5, panner);
    const exterior = g.gain(0, air);
    const interior = g.gain(0, g.filter('lowpass', 520, 0.7, this.direct));
    const body = g.gain(1, exterior);
    body.connect(interior);

    if (model === 'seaplane') {
      // Prop engine: low saws and a sub, chopped at the blade-pass rate, over an air rumble.
      const chop = g.gain(0.7, body);
      g.lfo(chop.gain, 31, 0.3, 'square');
      const lp = g.filter('lowpass', 900, 0.8, chop);
      const a = g.osc('sawtooth', 68, g.gain(0.32, lp));
      const b = g.osc('sawtooth', 136.8, g.gain(0.12, lp));
      const sub = g.osc('square', 34, g.gain(0.22, g.filter('lowpass', 300, 0.7, chop)));
      for (const o of [a, b, sub]) g.lfo(o.frequency, 0.21, 1.2);
      g.loop(this.noise.brownLoop, 0.9, g.filter('lowpass', 500, 0.6, g.gain(0.4, body)), r);
    } else {
      // Toy delivery drone: four detuned rotor saws, a thin whine, and a chopped high buzz.
      const bp = g.filter('bandpass', 1100, 0.7, g.gain(1, body));
      for (const f of [182, 189, 196, 205]) {
        const o = g.osc('sawtooth', f, g.gain(0.16, bp));
        g.lfo(o.frequency, 0.5 + r() * 0.4, 3 + r() * 2);
      }
      const whine = g.osc('sine', 768, g.gain(0.045, body));
      g.lfo(whine.frequency, 0.6, 9);
      const buzz = g.gain(0.12, body);
      g.lfo(buzz.gain, 47, 0.08, 'square');
      g.loop(this.noise.pinkLoop, 1.2, g.filter('highpass', 3000, 0.6, buzz), r);
    }
    return { g, model, exterior, air, panner, interior };
  }

  private buildDoor(): DoorGroup {
    const g = new Group(this.ctx);
    const door = g.gain(0, this.direct);
    const bp = g.filter('bandpass', 700, 0.5, door);
    g.loop(this.noise.pinkLoop, 0.95, bp, this.rand);
    g.lfo(bp.frequency, 0.23, 220);
    g.lfo(door.gain, 0.37, 0.05);
    g.loop(this.noise.brownLoop, 1.1, g.filter('lowpass', 380, 0.6, g.gain(0.8, door)), this.rand);
    return { g, door };
  }

  private buildWind(): WindGroup {
    const g = new Group(this.ctx);
    const wind = g.gain(0, this.direct);
    // Buffeting on the whole wind.
    const buffet = g.gain(1, wind);
    g.lfo(buffet.gain, 5.5, 0.12);
    g.lfo(buffet.gain, 1.7, 0.08);
    const roarLp = g.filter('lowpass', 250, 0.6, g.gain(0.9, buffet));
    g.loop(this.noise.brownLoop, 1.2, roarLp, this.rand);
    const whistle = g.gain(0.08, buffet);
    const whistleBp = g.filter('bandpass', 900, 1.4, whistle);
    g.loop(this.noise.pinkLoop, 1.05, whistleBp, this.rand);
    // Canopy flutter: fabric flap at ~9 Hz, separate from the wind level.
    const flutter = g.gain(0, this.direct);
    const flap = g.gain(0.6, flutter);
    g.lfo(flap.gain, 9, 0.4, 'square');
    g.lfo(flap.gain, 3.1, 0.15);
    g.loop(this.noise.pinkLoop, 0.8, g.filter('bandpass', 850, 1.5, flap), this.rand);
    return { g, wind, roarLp, whistleBp, whistle, flutter };
  }
}

function setPos(p: PannerNode, pos: Vec3): void {
  if (p.positionX) {
    p.positionX.value = pos.x;
    p.positionY.value = pos.y;
    p.positionZ.value = pos.z;
  } else {
    p.setPosition(pos.x, pos.y, pos.z);
  }
}
