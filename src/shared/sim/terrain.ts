/**
 * Island heightfield. Pure, allocation-free, deterministic. Called per vertex by the renderer, per step by movement,
 * and by hitscan / line-of-sight rays.
 *
 * Shape (see docs/design/levels/island.md, "Interpretation notes for game-developer"):
 * - Coastline radius C(angle) = islandRadius + shoreNoise.amplitude * n(angle), n in [-1, 1]. n is a normalised sum of
 *   three seeded sine harmonics of the angle (integer harmonics, so it is periodic). `shoreNoise.frequency` sets the
 *   base harmonic (2.5 -> 3, 5 and 9 bumps), i.e. "about 3-5 bumps around the island".
 * - Inland of the beach (d = C - r >= beachWidth): baseHeight.
 * - Beach band (0 <= d < beachWidth): eases from baseHeight at the inner edge (zero slope, joins the flat smoothly) down to
 *   0 at the coastline: h = baseHeight * u * (2 - u), u = d / beachWidth.
 * - Sea (d < 0): continues with the same slope as the beach at the coast and flattens exponentially toward
 *   -SEA_FLOOR_DEPTH, so the shallow ring out to worldRadius stays wadeable. C1-continuous at the coast (no cliff).
 * - Hills are added on top: height * 0.5 * (1 + cos(pi * d / radius)) for d < radius.
 *
 * Angle convention for `coastlineRadius`: `angle = Math.atan2(z, x)` (standard math angle in the XZ plane), so the coast
 * point is `(cos(angle) * R, sin(angle) * R)` in (x, z).
 */
import type { MapData, Surface } from '../types';

/**
 * Asymptotic sea-floor depth (m) below sea level. Terrain-shape constant (the level doc asks for 0.5-1 m so the shallow
 * ring is wadeable). Not a gameplay number; could move to MapData if more maps need different seas.
 */
export const SEA_FLOOR_DEPTH = 0.9;

/** Harmonic multipliers relative to `shoreNoise.frequency`, and their weights (normalised so |n| <= 1). */
const HARMONIC_MULT_0 = 1;
const HARMONIC_MULT_1 = 1.9;
const HARMONIC_MULT_2 = 3.7;
const HARMONIC_W_0 = 1;
const HARMONIC_W_1 = 0.5;
const HARMONIC_W_2 = 0.25;
const HARMONIC_W_SUM = HARMONIC_W_0 + HARMONIC_W_1 + HARMONIC_W_2;
const TAU = Math.PI * 2;

/** Integer hash of (seed, i) -> [0, 1). Stateless so heightAt stays allocation-free with no caches. */
function hash01(seed: number, i: number): number {
  let h = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const harmonic = (frequency: number, mult: number): number => Math.max(1, Math.round(frequency * mult));

/** Shore noise n(angle) in [-1, 1]. */
export function shoreNoise(angle: number, map: MapData): number {
  const { frequency, seed } = map.shoreNoise;
  const s0 = Math.sin(harmonic(frequency, HARMONIC_MULT_0) * angle + hash01(seed, 0) * TAU);
  const s1 = Math.sin(harmonic(frequency, HARMONIC_MULT_1) * angle + hash01(seed, 1) * TAU);
  const s2 = Math.sin(harmonic(frequency, HARMONIC_MULT_2) * angle + hash01(seed, 2) * TAU);
  return (HARMONIC_W_0 * s0 + HARMONIC_W_1 * s1 + HARMONIC_W_2 * s2) / HARMONIC_W_SUM;
}

/** Distance from the origin where terrain crosses y = 0 at `angle = Math.atan2(z, x)`. Used for the minimap. */
export function coastlineRadius(angle: number, map: MapData): number {
  return map.islandRadius + map.shoreNoise.amplitude * shoreNoise(angle, map);
}

/** Terrain height without hills, as a function of signed distance inland of the coast (d = C - r). */
function profile(d: number, map: MapData): number {
  const bw = map.beachWidth;
  const base = map.baseHeight;
  if (bw <= 0) return d >= 0 ? base : -SEA_FLOOR_DEPTH * (1 - Math.exp(d));
  if (d >= bw) return base;
  if (d >= 0) {
    const u = d / bw;
    return base * u * (2 - u);
  }
  const slope = (2 * base) / bw;
  return -SEA_FLOOR_DEPTH * (1 - Math.exp((d * slope) / SEA_FLOOR_DEPTH));
}

/** Terrain y at (x, z). Negative in the sea. */
export function heightAt(x: number, z: number, map: MapData): number {
  const r = Math.sqrt(x * x + z * z);
  const c = coastlineRadius(Math.atan2(z, x), map);
  let h = profile(c - r, map);
  const hills = map.hills;
  for (let i = 0; i < hills.length; i++) {
    const hill = hills[i]!;
    const dx = x - hill.x;
    const dz = z - hill.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < hill.radius * hill.radius) {
      h += hill.height * 0.5 * (1 + Math.cos((Math.PI * Math.sqrt(d2)) / hill.radius));
    }
  }
  return h;
}

/** 'water' where heightAt < 0, 'sand' within beachWidth inland of the coast, 'grass' further inland. */
export function surfaceAt(x: number, z: number, map: MapData): Surface {
  if (heightAt(x, z, map) < 0) return 'water';
  const r = Math.sqrt(x * x + z * z);
  const d = coastlineRadius(Math.atan2(z, x), map) - r;
  return d < map.beachWidth ? 'sand' : 'grass';
}

/** Upper bound on |grad heightAt| used to size safe ray-march steps (hills here peak at ~0.55). */
const MAX_TERRAIN_SLOPE = 1;
const RAY_MIN_STEP = 0.2;
const RAY_MAX_STEP = 4;
const RAY_BISECT_ITERS = 8;

/**
 * Ray-march against the heightfield. `dir` should be unit length. Returns the distance t of the first point where the
 * ray goes below the terrain, or -1 if it does not within `maxT`.
 */
export function raycastTerrain(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  map: MapData,
): number {
  let t = 0;
  let f = oy - heightAt(ox, oz, map);
  if (f <= 0) return 0;
  const k = 1 / (1 + MAX_TERRAIN_SLOPE);
  while (t < maxT) {
    const step = Math.min(RAY_MAX_STEP, Math.max(RAY_MIN_STEP, f * k));
    const nt = Math.min(maxT, t + step);
    const nf = oy + dy * nt - heightAt(ox + dx * nt, oz + dz * nt, map);
    if (nf <= 0) {
      let lo = t;
      let hi = nt;
      for (let i = 0; i < RAY_BISECT_ITERS; i++) {
        const mid = (lo + hi) * 0.5;
        const mf = oy + dy * mid - heightAt(ox + dx * mid, oz + dz * mid, map);
        if (mf <= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    if (nt >= maxT) break;
    t = nt;
    f = nf;
  }
  return -1;
}
