/**
 * Noise buffers, generated once per AudioContext and shared by every voice (sources start at a random offset so
 * repeated hits never sound identical). Owner: audio-designer.
 */

export type NoiseColor = 'white' | 'pink' | 'brown';

export interface NoiseBank {
  /** Short mono buffers for one-shots. */
  readonly white: AudioBuffer;
  readonly pink: AudioBuffer;
  readonly brown: AudioBuffer;
  /** Long, seamless, decorrelated stereo buffers for ambience beds and loops. */
  readonly pinkLoop: AudioBuffer;
  readonly brownLoop: AudioBuffer;
  get(color: NoiseColor): AudioBuffer;
}

/** Small deterministic PRNG so buffers are reproducible (and tests are stable). */
function makeRand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fills `out` with noise of the given colour, normalised to peak ~0.95. Pure; exported for tests. */
export function fillNoise(out: Float32Array, color: NoiseColor, seed: number): void {
  const rand = makeRand(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rand() * 2 - 1;
    if (color === 'white') out[i] = w;
    else if (color === 'pink') {
      // Paul Kellet's refined pink filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      out[i] = last;
    }
  }
  // Remove DC (brown noise drifts) and normalise.
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i] as number;
  mean /= out.length || 1;
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    const v = (out[i] as number) - mean;
    out[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  const k = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * k;
}

/**
 * Seamless loop: generates `length + fade` samples and crossfades the tail into the head, so sample[length-1] flows
 * into sample[0] without a click. Pure; exported for tests.
 */
export function fillLoopNoise(out: Float32Array, color: NoiseColor, seed: number, fade: number): void {
  const n = out.length;
  const f = Math.max(1, Math.min(fade, Math.floor(n / 2)));
  const tmp = new Float32Array(n + f);
  fillNoise(tmp, color, seed);
  for (let i = 0; i < n; i++) out[i] = tmp[i] as number;
  for (let i = 0; i < f; i++) {
    const a = i / f;
    out[i] = (tmp[i] as number) * a + (tmp[n + i] as number) * (1 - a);
  }
}

function monoBuffer(ctx: BaseAudioContext, seconds: number, color: NoiseColor, seed: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  fillNoise(buf.getChannelData(0), color, seed);
  return buf;
}

function stereoLoop(ctx: BaseAudioContext, seconds: number, color: NoiseColor, seed: number): AudioBuffer {
  const len = Math.max(2, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const fade = Math.floor(ctx.sampleRate * 0.25);
  fillLoopNoise(buf.getChannelData(0), color, seed, fade);
  fillLoopNoise(buf.getChannelData(1), color, seed + 7919, fade);
  return buf;
}

export function createNoiseBank(ctx: BaseAudioContext): NoiseBank {
  const white = monoBuffer(ctx, 1, 'white', 11);
  const pink = monoBuffer(ctx, 2, 'pink', 23);
  const brown = monoBuffer(ctx, 2, 'brown', 37);
  const pinkLoop = stereoLoop(ctx, 6, 'pink', 101);
  const brownLoop = stereoLoop(ctx, 7, 'brown', 211);
  return {
    white,
    pink,
    brown,
    pinkLoop,
    brownLoop,
    get: (color) => (color === 'white' ? white : color === 'pink' ? pink : brown),
  };
}
