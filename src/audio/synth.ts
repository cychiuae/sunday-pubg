/**
 * Synthesis primitives shared by every recipe: enveloped oscillators, filtered noise bursts, loops and LFOs.
 * Every node a primitive creates is registered on the Voice so the engine can stop and disconnect it when the
 * voice ends. Owner: audio-designer.
 */
import type { NoiseBank, NoiseColor } from './noise';

/** Per-voice synthesis context handed to a recipe. */
export interface Voice {
  readonly ctx: BaseAudioContext;
  /** Recipe output: connect the final node of every layer here. */
  readonly out: AudioNode;
  /** Context time the voice starts. */
  readonly t: number;
  /** Pitch ratio (jitter applied). Multiplies oscillator and filter frequencies. */
  readonly pitch: number;
  /** 0..1, meaning depends on the recipe (sprint, fall speed, last countdown second...). */
  readonly intensity: number;
  /** Recipe variant: weapon id, surface, item id, hit kind... ('' if none). */
  readonly variant: string;
  /** True for the local player's own sounds (2D, closer/fuller versions). */
  readonly local: boolean;
  /** Metres from the listener (0 for 2D). Recipes may add distant tails. */
  readonly distance: number;
  /** Requested duration for loops/timed voices, seconds (0 if not given). */
  readonly durationS: number;
  readonly noise: NoiseBank;
  /** [0, 1) random. */
  readonly rand: () => number;
  /** Register a source so stopping the voice stops it. */
  addSource(s: AudioScheduledSourceNode): void;
  /** Register a node so it is disconnected when the voice ends. */
  addNode(n: AudioNode): void;
}

const EPS = 0.0001;

/** Attack/hold/exponential-decay envelope on a gain param. Returns the end time. */
export function envelope(p: AudioParam, t0: number, peak: number, attack: number, hold: number, decay: number): number {
  const pk = Math.max(EPS * 2, peak);
  p.setValueAtTime(EPS, t0);
  p.linearRampToValueAtTime(pk, t0 + Math.max(0.001, attack));
  const holdEnd = t0 + Math.max(0.001, attack) + Math.max(0, hold);
  if (hold > 0) p.setValueAtTime(pk, holdEnd);
  const end = holdEnd + Math.max(0.005, decay);
  p.exponentialRampToValueAtTime(EPS, end);
  return end;
}

export function gainNode(v: Voice, value: number, dest: AudioNode): GainNode {
  const g = v.ctx.createGain();
  g.gain.value = value;
  g.connect(dest);
  v.addNode(g);
  return g;
}

export function filterNode(v: Voice, type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
  const f = v.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = clampHz(v, freq);
  f.Q.value = q;
  f.connect(dest);
  v.addNode(f);
  return f;
}

const clampHz = (v: Voice, hz: number): number => Math.min(v.ctx.sampleRate * 0.45, Math.max(10, hz));

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Glide target; reached exponentially after `glide` seconds. */
  freqEnd?: number;
  glide?: number;
  /** Start offset from v.t, seconds. */
  at?: number;
  attack?: number;
  hold?: number;
  decay: number;
  gain: number;
  detune?: number;
  /** Optional low-pass on this layer. */
  lowpass?: number;
  dest?: AudioNode;
}

/** Enveloped oscillator layer. Returns the end offset (seconds after v.t). */
export function tone(v: Voice, o: ToneOpts): number {
  const t0 = v.t + (o.at ?? 0);
  const osc = v.ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  const f0 = clampHz(v, o.freq * v.pitch);
  osc.frequency.setValueAtTime(f0, t0);
  if (o.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(clampHz(v, o.freqEnd * v.pitch), t0 + Math.max(0.005, o.glide ?? 0.1));
  }
  if (o.detune) osc.detune.value = o.detune;
  const dest = o.dest ?? v.out;
  const g = v.ctx.createGain();
  v.addNode(g);
  if (o.lowpass !== undefined) g.connect(filterNode(v, 'lowpass', o.lowpass * v.pitch, 0.7, dest));
  else g.connect(dest);
  osc.connect(g);
  const end = envelope(g.gain, t0, o.gain, o.attack ?? 0.002, o.hold ?? 0, o.decay);
  osc.start(t0);
  osc.stop(end + 0.02);
  v.addSource(osc);
  v.addNode(osc);
  return end - v.t;
}

export interface NoiseOpts {
  color?: NoiseColor;
  filter?: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  glide?: number;
  q?: number;
  at?: number;
  attack?: number;
  hold?: number;
  decay: number;
  gain: number;
  /** Playback rate of the noise buffer (lower = darker grain). */
  rate?: number;
  dest?: AudioNode;
}

/** Enveloped, filtered noise burst. Returns the end offset (seconds after v.t). */
export function noise(v: Voice, o: NoiseOpts): number {
  const t0 = v.t + (o.at ?? 0);
  const src = v.ctx.createBufferSource();
  const buf = v.noise.get(o.color ?? 'white');
  src.buffer = buf;
  src.loop = true;
  if (o.rate !== undefined) src.playbackRate.value = o.rate;
  const f = v.ctx.createBiquadFilter();
  f.type = o.filter ?? 'bandpass';
  f.frequency.setValueAtTime(clampHz(v, o.freq * v.pitch), t0);
  if (o.freqEnd !== undefined) {
    f.frequency.exponentialRampToValueAtTime(clampHz(v, o.freqEnd * v.pitch), t0 + Math.max(0.005, o.glide ?? 0.1));
  }
  f.Q.value = o.q ?? 1;
  const g = v.ctx.createGain();
  src.connect(f);
  f.connect(g);
  g.connect(o.dest ?? v.out);
  const end = envelope(g.gain, t0, o.gain, o.attack ?? 0.002, o.hold ?? 0, o.decay);
  src.start(t0, v.rand() * Math.max(0, buf.duration - 0.5));
  src.stop(end + 0.02);
  v.addSource(src);
  v.addNode(src);
  v.addNode(f);
  v.addNode(g);
  return end - v.t;
}

/** A quick click: very short filtered noise tick. Returns the end offset. */
export function click(v: Voice, at: number, freq: number, gain: number, q = 4, decay = 0.012): number {
  return noise(v, { filter: 'bandpass', freq, q, at, attack: 0.0008, decay, gain });
}

/** Simple additive bell/steel-drum note. Returns the end offset. */
export function bell(
  v: Voice,
  at: number,
  freq: number,
  gain: number,
  decay: number,
  partials: readonly (readonly [ratio: number, gain: number])[] = [[1, 1], [2.0, 0.35], [3.01, 0.18]],
  dest?: AudioNode,
): number {
  let end = 0;
  for (const [ratio, pg] of partials) {
    end = Math.max(
      end,
      tone(v, { type: 'sine', freq: freq * ratio, at, attack: 0.002, decay: decay / Math.sqrt(ratio), gain: gain * pg, dest }),
    );
  }
  return end;
}

/** Plucked note (ukulele-ish): triangle with a fast low-passed decay. Returns the end offset. */
export function pluck(v: Voice, at: number, freq: number, gain: number, decay = 0.35, dest?: AudioNode): number {
  const a = tone(v, { type: 'triangle', freq, at, attack: 0.002, decay, gain, lowpass: freq * 4, dest });
  const b = tone(v, { type: 'sine', freq: freq * 2, at, attack: 0.002, decay: decay * 0.4, gain: gain * 0.25, dest });
  return Math.max(a, b);
}

export interface LoopNoiseOpts {
  buffer: AudioBuffer;
  filter: BiquadFilterType;
  freq: number;
  q?: number;
  gain: number;
  fadeIn?: number;
  /** Absolute stop time (context seconds); voice stopping may cut earlier. */
  until: number;
  rate?: number;
  dest?: AudioNode;
}

/** Looping noise bed with a fade-in, faded out at `until`. Returns its gain and filter for modulation. */
export function loopNoise(v: Voice, o: LoopNoiseOpts): { gain: GainNode; filter: BiquadFilterNode } {
  const src = v.ctx.createBufferSource();
  src.buffer = o.buffer;
  src.loop = true;
  if (o.rate !== undefined) src.playbackRate.value = o.rate;
  const f = v.ctx.createBiquadFilter();
  f.type = o.filter;
  f.frequency.value = clampHz(v, o.freq * v.pitch);
  f.Q.value = o.q ?? 0.7;
  const g = v.ctx.createGain();
  src.connect(f);
  f.connect(g);
  g.connect(o.dest ?? v.out);
  const fadeIn = Math.max(0.005, o.fadeIn ?? 0.08);
  g.gain.setValueAtTime(EPS, v.t);
  g.gain.linearRampToValueAtTime(o.gain, v.t + fadeIn);
  const fadeOutStart = Math.max(v.t + fadeIn, o.until - 0.15);
  g.gain.setValueAtTime(o.gain, fadeOutStart);
  g.gain.linearRampToValueAtTime(0, o.until);
  src.start(v.t, v.rand() * Math.max(0, o.buffer.duration - 0.5));
  src.stop(o.until + 0.02);
  v.addSource(src);
  v.addNode(src);
  v.addNode(f);
  v.addNode(g);
  return { gain: g, filter: f };
}

/** Sine LFO added to an AudioParam (param value + depth * sin). Runs from v.t until `until`. */
export function lfo(v: Voice, param: AudioParam, rateHz: number, depth: number, until: number, type: OscillatorType = 'sine'): void {
  const osc = v.ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = rateHz;
  const g = v.ctx.createGain();
  g.gain.value = depth;
  osc.connect(g);
  g.connect(param);
  osc.start(v.t);
  osc.stop(until + 0.02);
  v.addSource(osc);
  v.addNode(osc);
  v.addNode(g);
}

/** Note name helper: MIDI note -> Hz. */
export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
