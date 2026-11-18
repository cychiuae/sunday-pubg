/**
 * Pure spatial / level helpers (no Web Audio). Owner: audio-designer.
 *
 * Positional voices use a PannerNode for direction only (rolloffFactor 0). Distance loudness and air absorption are
 * computed here once at voice start, so culling, priority and loudness all agree and are unit-testable.
 */
import type { Vec3 } from '../shared/types';

export const dist3 = (a: Vec3, b: Vec3): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

/** Fraction of maxDistance where the extra linear fade-out to silence begins. */
export const EDGE_FADE_START = 0.8;

/**
 * Inverse-distance gain (PannerNode 'inverse' formula) with a linear fade to exactly 0 at maxDistance, so sounds
 * never pop in/out at the cull radius. Returns 1 inside refDistance, 0 at or beyond maxDistance.
 */
export function distanceGain(d: number, refDistance: number, maxDistance: number, rolloff: number): number {
  if (!(d < maxDistance)) return 0;
  const ref = Math.max(refDistance, 1e-3);
  const dd = Math.max(d, ref);
  const inv = ref / (ref + rolloff * (dd - ref));
  if (!Number.isFinite(maxDistance)) return inv;
  const edge = EDGE_FADE_START * maxDistance;
  const fade = d <= edge ? 1 : 1 - (d - edge) / (maxDistance - edge);
  return inv * fade;
}

export const AIR_MIN_CUTOFF_HZ = 900;
export const AIR_MAX_CUTOFF_HZ = 20000;
/** Below this the low-pass is skipped entirely (saves a node per voice). */
export const AIR_FILTER_BYPASS_HZ = 16000;

/** Low-pass cutoff simulating air absorption: bright up close, muffled far away (distant gunfire reads as distant). */
export function airCutoffHz(d: number): number {
  const hz = AIR_MAX_CUTOFF_HZ * Math.exp(-Math.max(0, d) / 45);
  return hz < AIR_MIN_CUTOFF_HZ ? AIR_MIN_CUTOFF_HZ : hz;
}

/** HRTF for close sounds where direction matters most; cheaper equal-power beyond. */
export const HRTF_MAX_DISTANCE = 40;
export const panningModelFor = (d: number): PanningModelType => (d < HRTF_MAX_DISTANCE ? 'HRTF' : 'equalpower');

/**
 * Priority used for voice stealing. Within a cue's base priority, closer sounds win (+0..+5). 2D (local) sounds
 * get the full +5 because they are always "at" the listener.
 */
export function effectivePriority(base: number, d: number | null, maxDistance: number): number {
  if (d === null || !Number.isFinite(maxDistance) || maxDistance <= 0) return base + 5;
  const closeness = 1 - Math.min(1, Math.max(0, d / maxDistance));
  return base + 5 * closeness;
}

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, 1e-6));
export const semitonesToRatio = (st: number): number => Math.pow(2, st / 12);

/** Settings slider (0..1) to master gain. Squared for a roughly perceptual taper. NaN-safe. */
export function volumeToGain(v: number): number {
  const c = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
  return c * c;
}

/** Uniform random in [-1, 1) from a [0, 1) source. */
export const bipolar = (rand: () => number): number => rand() * 2 - 1;

/** Per-play variation: returns [pitchRatio, gainMultiplier]. Written into `out` to avoid allocating. */
export function variation(pitchJitterSt: number, gainJitterDb: number, rand: () => number, out: [number, number]): [number, number] {
  out[0] = pitchJitterSt > 0 ? semitonesToRatio(bipolar(rand) * pitchJitterSt) : 1;
  out[1] = gainJitterDb > 0 ? dbToGain(bipolar(rand) * gainJitterDb) : 1;
  return out;
}

/** Listener forward vector for a yaw (types.ts convention: yaw 0 looks toward -Z). */
export function listenerForward(yaw: number, out: Vec3): Vec3 {
  out.x = -Math.sin(yaw);
  out.y = 0;
  out.z = -Math.cos(yaw);
  return out;
}
