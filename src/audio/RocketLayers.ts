/**
 * Rocket in-flight whistles (docs/audio/M2c.md §4.2). A rocket moves and lives for a few seconds, so like the carrier
 * engine it is a bed controlled every frame, not a pooled one-shot.
 *
 * - Up to AUDIO_TUNING.rocketEmitters emitters; the nearest live rockets within rocketMaxM get one each.
 * - Each emitter: a band-passed noise hiss plus a low-passed saw whistle, chopped by a 13 Hz square "sputter", then the
 *   cue-style distance gain, the air low-pass and an HRTF/equal-power panner at the rocket.
 * - Doppler-ish pitch (soundMap.dopplerRatio): approaching rockets climb, receding ones sink.
 * - Fly-by: when a rocket's closest approach passes inside rocketFlybyM, the engine plays one `rocket.flyby`.
 * - A rocket that ends (rocketGone) cuts in 25 ms; one missing from the frame for rocketMissingMs fades in 80 ms.
 *
 * Positions come from IAudio.setRockets (FrameView.rockets, computed with the shared rocketPosAt), or from the engine's
 * own dead reckoning of rocketFired while main.ts does not call it. No per-frame allocation once emitters exist.
 * Owner: audio-designer.
 */
import type { RocketView } from '../shared/contracts';
import type { RocketId, Vec3 } from '../shared/types';
import { AUDIO_TUNING } from './cues';
import { Group } from './DropLayers';
import type { NoiseBank } from './noise';
import { dopplerRatio } from './soundMap';
import { AIR_FILTER_BYPASS_HZ, airCutoffHz, dist3, distanceGain, panningModelFor } from './spatial';

/** Seconds an idle emitter keeps its nodes before they are released. */
const RELEASE_AFTER_S = 2;
/** Doppler smoothing time constant (s). */
const DOPPLER_TC = 0.05;
const WHISTLE_HZ = 900;
const HISS_HZ = 1800;

interface Emitter {
  g: Group;
  /** Rocket it voices, or null when idle. */
  id: RocketId | null;
  /** Server ms the rocket was last in a frame. */
  seenAt: number;
  out: GainNode;
  air: BiquadFilterNode;
  panner: PannerNode;
  whistle: OscillatorNode;
  hissBp: BiquadFilterNode;
  hissSrc: AudioBufferSourceNode;
  /** Context time it went idle (release timer). */
  idleSince: number;
}

interface Flight {
  prevD: number;
  approaching: boolean;
  done: boolean;
  seen: number;
}

export type FlybySink = (pos: Vec3, closeness: number) => void;

export class RocketLayers {
  private readonly emitters: (Emitter | null)[];
  private readonly flights = new Map<RocketId, Flight>();
  private stamp = 0;
  /** Preallocated: indices of the chosen rockets this frame. */
  private readonly chosen: number[];
  private readonly chosenD: number[];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: NoiseBank,
    private readonly world: AudioNode,
    private readonly rand: () => number,
  ) {
    const n = AUDIO_TUNING.rocketEmitters;
    this.emitters = new Array<Emitter | null>(n).fill(null);
    this.chosen = new Array<number>(n).fill(-1);
    this.chosenD = new Array<number>(n).fill(Infinity);
  }

  /**
   * One frame: assign the nearest rockets to emitters, move and pitch them, fade out the rest, and report fly-bys.
   * `serverTime` = FrameView.serverTime (ms).
   */
  update(rockets: readonly RocketView[], serverTime: number, listener: Vec3, onFlyby: FlybySink): void {
    const T = AUDIO_TUNING;
    const now = this.ctx.currentTime;
    const n = this.emitters.length;
    const stamp = ++this.stamp;

    // Pick the n nearest within range (insertion into small fixed arrays).
    for (let k = 0; k < n; k++) {
      this.chosen[k] = -1;
      this.chosenD[k] = Infinity;
    }
    for (let i = 0; i < rockets.length; i++) {
      const r = rockets[i] as RocketView;
      const d = dist3(listener, r.pos);
      this.flyby(r, d, stamp, onFlyby);
      if (!(d < T.rocketMaxM)) continue;
      for (let k = 0; k < n; k++) {
        if (d < (this.chosenD[k] as number)) {
          for (let j = n - 1; j > k; j--) {
            this.chosen[j] = this.chosen[j - 1] as number;
            this.chosenD[j] = this.chosenD[j - 1] as number;
          }
          this.chosen[k] = i;
          this.chosenD[k] = d;
          break;
        }
      }
    }
    if (this.flights.size > 0) this.flights.forEach(this.pruneFlight);

    // Keep emitters on rockets that are still chosen; free the others.
    for (let e = 0; e < n; e++) {
      const em = this.emitters[e];
      if (!em || em.id === null) continue;
      let still = false;
      for (let k = 0; k < n; k++) {
        const idx = this.chosen[k] as number;
        if (idx >= 0 && (rockets[idx] as RocketView).id === em.id) {
          still = true;
          break;
        }
      }
      if (still) continue;
      // Not chosen: out of range or out-ranked now, or missing from this frame.
      const present = this.indexOf(rockets, em.id) >= 0;
      if (present || serverTime - em.seenAt > T.rocketMissingMs) this.silence(em, now, 0.08);
    }

    // Voice each chosen rocket.
    for (let k = 0; k < n; k++) {
      const idx = this.chosen[k] as number;
      if (idx < 0) continue;
      const r = rockets[idx] as RocketView;
      const em = this.emitterFor(r.id, now);
      if (!em) continue;
      em.seenAt = serverTime;
      const d = this.chosenD[k] as number;
      const ratio = dopplerRatio(r.pos, r.vel, listener);
      setPos(em.panner, r.pos);
      em.panner.panningModel = panningModelFor(d);
      em.g.set(em.out.gain, T.rocketGain * distanceGain(d, T.rocketRefM, T.rocketMaxM, T.rocketRolloff), 0.03);
      const cutoff = airCutoffHz(d);
      em.g.set(em.air.frequency, cutoff < AIR_FILTER_BYPASS_HZ ? cutoff : 20000, 0.05);
      em.g.set(em.whistle.frequency, WHISTLE_HZ * ratio, DOPPLER_TC);
      em.g.set(em.hissBp.frequency, HISS_HZ * ratio, DOPPLER_TC);
      em.g.set(em.hissSrc.playbackRate, ratio, DOPPLER_TC);
    }

    // Release emitters idle for a while.
    for (let e = 0; e < n; e++) {
      const em = this.emitters[e];
      if (em && em.id === null && now - em.idleSince > RELEASE_AFTER_S) {
        em.g.dispose();
        this.emitters[e] = null;
      }
    }
  }

  /** The rocket ended (explosion or dud): cut its whistle now. */
  stop(id: RocketId): void {
    const now = this.ctx.currentTime;
    for (const em of this.emitters) if (em && em.id === id) this.silence(em, now, 0.025);
    const f = this.flights.get(id);
    if (f) f.done = true;
  }

  /** Silences everything (match reset / map change). */
  reset(): void {
    const now = this.ctx.currentTime;
    for (const em of this.emitters) if (em && em.id !== null) this.silence(em, now, 0.05);
    this.flights.clear();
  }

  dispose(): void {
    for (let e = 0; e < this.emitters.length; e++) {
      this.emitters[e]?.g.dispose();
      this.emitters[e] = null;
    }
    this.flights.clear();
  }

  /** Rockets with an emitter (tests). */
  get voiced(): RocketId[] {
    const out: RocketId[] = [];
    for (const em of this.emitters) if (em && em.id !== null) out.push(em.id);
    return out;
  }

  /** Emitters holding nodes (tests). */
  get built(): number {
    let c = 0;
    for (const em of this.emitters) if (em) c++;
    return c;
  }

  // --- internals ---------------------------------------------------------------------------
  private flyby(r: RocketView, d: number, stamp: number, onFlyby: FlybySink): void {
    let f = this.flights.get(r.id);
    if (!f) {
      f = { prevD: d, approaching: false, done: false, seen: stamp };
      this.flights.set(r.id, f);
      return;
    }
    f.seen = stamp;
    if (f.done) return;
    if (d < f.prevD - 1e-3) f.approaching = true;
    else if (f.approaching && d > f.prevD + 1e-3) {
      // Closest approach was last frame.
      const R = AUDIO_TUNING.rocketFlybyM;
      if (f.prevD < R) {
        f.done = true;
        onFlyby(r.pos, 1 - f.prevD / R);
      }
      f.approaching = false;
    }
    f.prevD = d;
  }

  private readonly pruneFlight = (f: Flight, id: RocketId): void => {
    if (f.seen !== this.stamp) this.flights.delete(id);
  };

  private indexOf(rockets: readonly RocketView[], id: RocketId): number {
    for (let i = 0; i < rockets.length; i++) if ((rockets[i] as RocketView).id === id) return i;
    return -1;
  }

  /** The emitter already on `id`, else a free one (built on first need), else null. */
  private emitterFor(id: RocketId, now: number): Emitter | null {
    let free = -1;
    for (let e = 0; e < this.emitters.length; e++) {
      const em = this.emitters[e];
      if (em && em.id === id) return em;
      if (free < 0 && (!em || em.id === null)) free = e;
    }
    if (free < 0) return null;
    const em = this.emitters[free] ?? this.build();
    this.emitters[free] = em;
    em.id = id;
    em.g.lastLive = now;
    return em;
  }

  private silence(em: Emitter, now: number, fade: number): void {
    em.id = null;
    em.idleSince = now;
    em.out.gain.cancelScheduledValues(now);
    em.out.gain.setValueAtTime(em.out.gain.value, now);
    em.out.gain.linearRampToValueAtTime(0, now + fade);
    // The smoothed-set cache must not skip the next ramp up.
    em.g.forget(em.out.gain);
  }

  private build(): Emitter {
    const g = new Group(this.ctx);
    const panner = this.ctx.createPanner();
    panner.distanceModel = 'linear';
    panner.rolloffFactor = 0; // loudness is the out gain
    panner.panningModel = 'HRTF';
    panner.connect(this.world);
    g.nodes.push(panner);
    const air = g.filter('lowpass', 20000, 0.5, panner);
    const out = g.gain(0, air);
    const sputter = g.gain(0.65, out);
    g.lfo(sputter.gain, 13, 0.35, 'square');
    // Hiss: band-passed noise (playbackRate follows the doppler ratio).
    const hissBp = g.filter('bandpass', HISS_HZ, 1.2, g.gain(0.5, sputter));
    const hissSrc = this.ctx.createBufferSource();
    hissSrc.buffer = this.noise.pinkLoop;
    hissSrc.loop = true;
    hissSrc.connect(hissBp);
    hissSrc.start(this.ctx.currentTime, this.rand() * this.noise.pinkLoop.duration * 0.9);
    g.sources.push(hissSrc);
    g.nodes.push(hissSrc);
    // Whistle: a saw through a low-pass.
    const whistle = g.osc('sawtooth', WHISTLE_HZ, g.filter('lowpass', 2400, 0.7, g.gain(0.18, sputter)));
    return { g, id: null, seenAt: 0, out, air, panner, whistle, hissBp, hissSrc, idleSince: 0 };
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
