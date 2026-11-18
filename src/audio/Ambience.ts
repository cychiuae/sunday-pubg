/**
 * Persistent ambience beds, one scene per map kind (M2b: switched on mapChanged with a crossfade).
 *
 * - island: slow ocean swells, foam hiss that trails each swell, light wind, and a surf-roar layer that fades in while
 *   the local player stands in the tide. Gull calls are one-shot voices scheduled by the AudioEngine.
 * - indoor (office): HVAC rumble and air rush, a faint mains hum, a fluorescent buzz with a slow flicker; for the
 *   sprinkler theme a distant rain bed once the sprinklers are on and a close spray while the local player stands in
 *   the rain; for lights-out the buzz cuts outside the circle. Distant typing is one-shots from the engine; the indoor
 *   reverb is a send in the engine graph.
 *
 * All modulation runs on audio-rate LFOs, so there is no per-frame work. Owner: audio-designer.
 */
import type { ZoneTheme } from '../shared/balance';
import { AUDIO_TUNING } from './cues';
import type { NoiseBank } from './noise';
import type { AmbienceScene } from './soundMap';

/** One scene's node graph. Everything it creates is tracked and disconnected on dispose. */
abstract class Bed {
  readonly out: GainNode;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];

  constructor(
    protected readonly ctx: BaseAudioContext,
    protected readonly noise: NoiseBank,
    dest: AudioNode,
  ) {
    this.out = this.gain(0, dest);
  }

  abstract setOutside(active: boolean): void;
  abstract setZoneBed(active: boolean): void;

  fadeTo(level: number, seconds: number): void {
    const now = this.ctx.currentTime;
    const g = this.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(level, now + Math.max(0.01, seconds));
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
    for (const n of this.nodes) n.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
  }

  protected gain(value: number, dest: AudioNode | AudioParam | null): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest && isParam(dest)) g.connect(dest);
    else if (dest) g.connect(dest);
    this.nodes.push(g);
    return g;
  }

  protected filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  protected loop(buffer: AudioBuffer, rate: number, dest: AudioNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(this.ctx.currentTime, Math.random() * buffer.duration * 0.9);
    this.sources.push(src);
    this.nodes.push(src);
  }

  /** Steady oscillator into `dest`. */
  protected osc(type: OscillatorType, freq: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.connect(dest);
    o.start(this.ctx.currentTime);
    this.sources.push(o);
    this.nodes.push(o);
    return o;
  }

  /** LFO (amplitude `depth`) summed into a node input or an AudioParam. */
  protected lfoInto(dest: AudioNode | AudioParam, rateHz: number, depth: number, type: OscillatorType = 'sine'): void {
    const g = this.gain(depth, dest);
    this.osc(type, rateHz, g);
  }

  /** Registers a node created outside the helpers (disconnected on dispose). */
  protected track(n: AudioNode): void {
    this.nodes.push(n);
  }

  protected target(p: AudioParam, value: number, tc: number): void {
    p.setTargetAtTime(value, this.ctx.currentTime, tc);
  }
}

/** The beach (M1 beds, unchanged). */
class IslandBed extends Bed {
  private readonly surf: GainNode;
  private readonly waveBoost: GainNode;

  constructor(ctx: BaseAudioContext, noise: NoiseBank, dest: AudioNode) {
    super(ctx, noise, dest);
    // Swell LFO: two slow sines at incommensurate rates so the sea never loops audibly.
    const swell = this.gain(1, null);
    this.lfoInto(swell, 0.11, 1);
    this.lfoInto(swell, 0.071, 0.6);

    // Waves: brown noise, low-passed; the swell opens the filter and raises the level together.
    this.waveBoost = this.gain(1, this.out);
    const waveGain = this.gain(0.5, this.waveBoost);
    const waveLp = this.filter('lowpass', 420, 0.5, waveGain);
    this.loop(noise.brownLoop, 1, waveLp);
    swell.connect(this.gain(150, waveLp.frequency));
    swell.connect(this.gain(0.2, waveGain.gain));

    // Foam: bright hiss that peaks ~1.4 s after each swell crest (the wave breaking on sand).
    const foamGain = this.gain(0.035, this.waveBoost);
    const foamHp = this.filter('highpass', 1900, 0.5, foamGain);
    this.loop(noise.pinkLoop, 1, foamHp);
    const delay = ctx.createDelay(3);
    delay.delayTime.value = 1.4;
    this.track(delay);
    swell.connect(delay);
    delay.connect(this.gain(0.025, foamGain.gain));

    // Wind: band-passed pink noise drifting slowly in pitch and level.
    const windGain = this.gain(0.05, this.out);
    const windBp = this.filter('bandpass', 550, 0.6, windGain);
    this.loop(noise.pinkLoop, 0.83, windBp);
    this.lfoInto(windBp.frequency, 0.05, 200);
    this.lfoInto(windGain.gain, 0.033, 0.03);

    // Surf roar: silent until the player is in the tide.
    this.surf = this.gain(0, this.out);
    const surfLp = this.filter('lowpass', 1300, 0.5, this.surf);
    this.loop(noise.brownLoop, 1.3, surfLp);
    this.lfoInto(surfLp.frequency, 0.4, 300);
  }

  /** In the tide: louder, closer waves plus surf roar. */
  setOutside(active: boolean): void {
    this.target(this.surf.gain, active ? 0.35 : 0, 0.4);
    this.target(this.waveBoost.gain, active ? 1.6 : 1, 0.5);
  }

  setZoneBed(_active: boolean): void {
    // The tide loop is a one-shot voice; the sea is always there.
  }
}

/** The office: air handling, lights, and the sprinkler (or lights-out) zone layers. */
class IndoorBed extends Bed {
  private readonly buzz: GainNode;
  private readonly hvacBoost: GainNode;
  private readonly spray: GainNode | null;
  private readonly rainBed: GainNode | null;

  constructor(
    ctx: BaseAudioContext,
    noise: NoiseBank,
    dest: AudioNode,
    private readonly theme: ZoneTheme,
  ) {
    super(ctx, noise, dest);

    // HVAC: a deep brown-noise rumble plus a soft band of air rush from the ceiling vents, breathing slowly.
    this.hvacBoost = this.gain(1, this.out);
    const rumbleGain = this.gain(0.42, this.hvacBoost);
    this.loop(noise.brownLoop, 0.7, this.filter('lowpass', 150, 0.6, rumbleGain));
    const airGain = this.gain(0.05, this.hvacBoost);
    const airBp = this.filter('bandpass', 420, 0.5, airGain);
    this.loop(noise.pinkLoop, 0.9, airBp);
    this.lfoInto(airGain.gain, 0.045, 0.015);
    this.lfoInto(airBp.frequency, 0.021, 80);

    // Mains hum under the rumble (fundamental + octave), barely there.
    const hum = this.gain(0.022, this.hvacBoost);
    this.osc('sine', 58, hum);
    this.osc('sine', 116, this.gain(0.5, hum));

    // Fluorescent buzz: a 120 Hz saw through a narrow band-pass, with a slow flicker in level.
    this.buzz = this.gain(1, this.out);
    const buzzGain = this.gain(0.012, this.buzz);
    this.osc('sawtooth', 120, this.filter('bandpass', 2400, 3, buzzGain));
    this.lfoInto(buzzGain.gain, 0.07, 0.004);
    this.lfoInto(buzzGain.gain, 11, 0.0015, 'square'); // tube flutter

    if (theme === 'lightsOut') {
      this.spray = null;
      this.rainBed = null;
      return;
    }
    // Sprinklers on somewhere on the floor: a soft, wide rain hiss (once the first shrink has started).
    this.rainBed = this.gain(0, this.out);
    const rainBp = this.filter('bandpass', 3200, 0.4, this.rainBed);
    this.loop(noise.pinkLoop, 1.1, rainBp);
    this.lfoInto(rainBp.frequency, 0.09, 400);

    // Standing in the rain: close spray hiss, droplet patter (fast AM) and water drumming on the floor.
    this.spray = this.gain(0, this.out);
    this.loop(noise.pinkLoop, 1.25, this.filter('highpass', 2500, 0.5, this.gain(0.6, this.spray)));
    const patter = this.gain(0.25, this.spray);
    this.loop(noise.pinkLoop, 1.6, this.filter('bandpass', 5200, 1.2, patter));
    this.lfoInto(patter.gain, 13, 0.2, 'square');
    this.lfoInto(patter.gain, 7.3, 0.12, 'triangle');
    this.loop(noise.brownLoop, 1.4, this.filter('lowpass', 700, 0.7, this.gain(0.3, this.spray)));
  }

  setOutside(active: boolean): void {
    if (this.theme === 'lightsOut') {
      // In the dark: the tubes go quiet and the air handling feels bigger.
      this.target(this.buzz.gain, active ? 0 : 1, 0.08);
      this.target(this.hvacBoost.gain, active ? 1.4 : 1, 0.6);
      return;
    }
    if (this.spray) this.target(this.spray.gain, active ? 0.35 : 0, active ? 0.12 : 0.5);
    if (this.rainBed) this.target(this.rainBed.gain, active ? 0 : this.bedLevel, 0.4);
  }

  private bedLevel = 0;

  setZoneBed(active: boolean): void {
    this.bedLevel = active ? 0.06 : 0;
    if (this.rainBed) this.target(this.rainBed.gain, this.bedLevel, 1.2);
  }
}

/** Owns the current scene and crossfades on change. */
export class Ambience {
  private bed: Bed;
  private scene: AmbienceScene;
  private theme: ZoneTheme;
  private readonly dying: { bed: Bed; at: number }[] = [];
  private outside = false;
  private zoneBed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly noise: NoiseBank,
    private readonly dest: AudioNode,
    scene: AmbienceScene = 'island',
    theme: ZoneTheme = 'tide',
  ) {
    this.scene = scene;
    this.theme = theme;
    this.bed = this.build(scene, theme);
    this.bed.fadeTo(1, 2.5);
  }

  get currentScene(): AmbienceScene {
    return this.scene;
  }

  /** Crossfades to `scene` (a no-op when neither the scene nor the theme changed). Clears the outside/zone layers. */
  setScene(scene: AmbienceScene, theme: ZoneTheme): void {
    this.outside = false;
    this.zoneBed = false;
    if (scene === this.scene && theme === this.theme) {
      this.bed.setOutside(false);
      this.bed.setZoneBed(false);
      return;
    }
    const fade = AUDIO_TUNING.sceneFadeS;
    this.bed.fadeTo(0, fade);
    this.dying.push({ bed: this.bed, at: this.ctx.currentTime + fade + 0.1 });
    this.scene = scene;
    this.theme = theme;
    this.bed = this.build(scene, theme);
    this.bed.fadeTo(1, fade);
  }

  /** Local player outside the safe zone: surf (island), spray (sprinklers) or dark (lights out). */
  setOutside(active: boolean): void {
    this.outside = active;
    this.bed.setOutside(active);
  }

  /** Zone layer that persists once the zone has started (indoor sprinkler rain bed). */
  setZoneBed(active: boolean): void {
    if (active === this.zoneBed) return;
    this.zoneBed = active;
    this.bed.setZoneBed(active);
    if (this.outside) this.bed.setOutside(true);
  }

  /** Disposes faded-out scenes. Called from AudioEngine.update. */
  update(now: number): void {
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i] as { bed: Bed; at: number };
      if (d.at <= now) {
        d.bed.dispose();
        this.dying.splice(i, 1);
      }
    }
  }

  /** Scenes still fading out (tests). */
  get fadingCount(): number {
    return this.dying.length;
  }

  dispose(): void {
    this.bed.dispose();
    for (const d of this.dying) d.bed.dispose();
    this.dying.length = 0;
  }

  private build(scene: AmbienceScene, theme: ZoneTheme): Bed {
    return scene === 'indoor' ? new IndoorBed(this.ctx, this.noise, this.dest, theme) : new IslandBed(this.ctx, this.noise, this.dest);
  }
}

/** AudioParams are recognised structurally (`instanceof AudioParam` is unavailable in node tests). */
const isParam = (x: AudioNode | AudioParam): x is AudioParam => !('connect' in x);
