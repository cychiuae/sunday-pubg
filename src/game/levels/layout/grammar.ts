/**
 * M2c per-match layout: shared helpers for both map generators (docs/design/levels/variety.md §2-§3). Owner:
 * level-designer.
 *
 * Determinism (ADR 0007 §1.4): every accept/reject decision uses only `+ - * /`, comparisons, Math.sqrt / round /
 * floor / imul and src/shared/detmath.ts. No Math.random, no time, no Math.sin/cos/atan2/hypot. Rotations are integer
 * steps (1/1024 turn); written values are rounded to mm / mrad before anything reads them.
 */
import { TURN_STEPS, degToStep, detCos, detSin, roundMm, roundMrad, stepToRad, streamSeed, wrapStep } from '../../../shared/detmath';

export type Rng = () => number;

/** mulberry32: the project's seeded PRNG (same as the M2b generators). Returns [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The PRNG of a named stream (variety.md §2.2): `arr:<zone>`, `loot:<group>`, `scatter:<zone>`, `decor:<zone>`, `look`. */
export const rngFor = (seed: number, name: string): Rng => mulberry32(streamSeed(seed, name));

export const range = (rng: Rng, a: number, b: number): number => a + (b - a) * rng();
/** Integer in [a, b] (inclusive). */
export const intRange = (rng: Rng, a: number, b: number): number => a + Math.floor(rng() * (b - a + 1));
/** A count spec: a number or [min, max] (inclusive). */
export const countOf = (rng: Rng, c: number | readonly [number, number]): number =>
  typeof c === 'number' ? c : intRange(rng, c[0], c[1]);
/** A scale spec: a number or [min, max]. */
export const scaleOf = (rng: Rng, s: number | readonly [number, number] | undefined): number =>
  s === undefined ? 1 : typeof s === 'number' ? s : range(rng, s[0], s[1]);
/** Uniform random rotation step. */
export const anyStep = (rng: Rng): number => Math.floor(rng() * TURN_STEPS);

/** Index of a weighted pick (weight defaults to 1). */
export function pickWeighted(rng: Rng, items: readonly { weight?: number }[]): number {
  let total = 0;
  for (const it of items) total += it.weight ?? 1;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= items[i]!.weight ?? 1;
    if (r < 0) return i;
  }
  return items.length - 1;
}

/** Fisher-Yates in place; returns the array. */
export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
  return arr;
}

export interface P2 {
  x: number;
  z: number;
}

export const dist = (ax: number, az: number, bx: number, bz: number): number => {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
};
export const len = (x: number, z: number): number => Math.sqrt(x * x + z * z);

/** Compass polar (0 deg = north = -Z, 90 = east = +X, clockwise) -> world XZ, with the deterministic table. */
export function polarDeg(deg: number, r: number): P2 {
  const s = degToStep(deg);
  return { x: r * detSin(s), z: -r * detCos(s) };
}

/** Zone-local bearing b (0 = local +Z "front", 90 = local +X) at radius r -> local XZ. */
export function bearing(deg: number, r: number): P2 {
  const s = degToStep(deg);
  return { x: r * detSin(s), z: r * detCos(s) };
}

/**
 * A placement frame (Three.js rotation.y convention): local +X -> world (cos, -sin), local +Z -> world (sin, cos).
 * `mirror` flips local X before rotating (and negates local rotations).
 */
export interface Frame {
  x: number;
  z: number;
  step: number;
  mirror: boolean;
}

export function toWorld(f: Frame, lx: number, lz: number): P2 {
  const c = detCos(f.step);
  const s = detSin(f.step);
  const mx = f.mirror ? -lx : lx;
  return { x: f.x + mx * c + lz * s, z: f.z - mx * s + lz * c };
}

/** World point -> frame-local (inverse of toWorld). */
export function toLocal(f: Frame, x: number, z: number): P2 {
  const c = detCos(f.step);
  const s = detSin(f.step);
  const dx = x - f.x;
  const dz = z - f.z;
  const lx = dx * c - dz * s;
  return { x: f.mirror ? -lx : lx, z: dx * s + dz * c };
}

/** A rotation given in the frame (local step) -> world step. */
export const worldStep = (f: Frame, localStep: number): number => wrapStep(f.step + (f.mirror ? -localStep : localStep));

/**
 * The step whose direction (sin, cos) best matches (dx, dz): a deterministic atan2 for "face toward" rotations
 * (argmax of the dot product over the 1024 steps; ties to the lowest step).
 */
export function stepToward(dx: number, dz: number): number {
  let best = 0;
  let bestDot = -Infinity;
  for (let k = 0; k < TURN_STEPS; k++) {
    const d = dx * detSin(k) + dz * detCos(k);
    if (d > bestDot) {
      bestDot = d;
      best = k;
    }
  }
  return best;
}

/** The rotY written into a placement for a step (radians in [0, 2 PI), rounded to mrad). */
export const rotOfStep = (step: number): number => roundMrad(stepToRad(step));
export const mm = roundMm;
/** Scale written into a placement (cm). */
export const cm = (v: number): number => Math.round(v * 100) / 100;

/** A simple uniform grid of item indices by axis-aligned bounds (cell 8 m). Deterministic iteration order. */
export class BoundsGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(private readonly cell = 8) {}
  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }
  add(index: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const i0 = Math.floor(minX / this.cell);
    const i1 = Math.floor(maxX / this.cell);
    const j0 = Math.floor(minZ / this.cell);
    const j1 = Math.floor(maxZ / this.cell);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = this.key(i, j);
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(index);
      }
    }
  }
  /** Calls fn once per index whose bounds touch the query box (ascending index order is NOT guaranteed). */
  query(minX: number, minZ: number, maxX: number, maxZ: number, fn: (index: number) => boolean | void): void {
    const i0 = Math.floor(minX / this.cell);
    const i1 = Math.floor(maxX / this.cell);
    const j0 = Math.floor(minZ / this.cell);
    const j1 = Math.floor(maxZ / this.cell);
    const seen = new Set<number>();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (const idx of list) {
          if (seen.has(idx)) continue;
          seen.add(idx);
          if (fn(idx) === true) return;
        }
      }
    }
  }
}

/** Nudge search (variety.md §4.3): rings of 0.25 m up to maxR, 16 directions per ring (deterministic table). */
export function nudgeSearch(x: number, z: number, maxR: number, ok: (x: number, z: number) => boolean): P2 | null {
  if (ok(x, z)) return { x, z };
  for (let r = 0.25; r <= maxR + 1e-9; r += 0.25) {
    for (let a = 0; a < 16; a++) {
      const s = a * (TURN_STEPS / 16);
      const px = mm(x + r * detSin(s));
      const pz = mm(z + r * detCos(s));
      if (ok(px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Variety data shapes (the JSON files in ../variety/). Only the fields the generators read are typed.
// ---------------------------------------------------------------------------------------------
export type Range2 = readonly [number, number];
export type NumOrRange = number | Range2;
export type RotSpec = number | 'any' | 'face' | 'away' | 'tangent' | 'along' | 'outward' | 'outwardPlus' | 'faceHull';

export interface RingSpec {
  n: number;
  r: NumOrRange;
  start?: number;
  stepDeg?: number;
  arc?: Range2;
  jitterDeg?: number;
  centre?: readonly [number, number];
  anchor?: string;
}
export interface ScatterSpec {
  n: NumOrRange;
  disc?: number;
  annulus?: Range2;
  rect?: readonly [number, number, number, number];
  centre?: readonly [number, number];
  minus?: readonly { strip: { axis: 'x' | 'z'; halfWidth: number } }[];
}
export interface PieceSpec {
  kind: string;
  at?: readonly [number, number];
  place?: readonly (readonly [number, number])[];
  ring?: RingSpec;
  line?: { from: readonly [number, number]; to: readonly [number, number]; n: number; jitter?: number };
  grid?: { x: readonly number[]; z: readonly number[] };
  cluster?: { centres: { ring: RingSpec }; n: number; spacing: number };
  scatter?: ScatterSpec;
  polar?: readonly [number, number];
  rot?: RotSpec;
  rotOffsetRad?: number;
  scale?: NumOrRange;
  jitter?: number;
  fill?: boolean;
  optional?: boolean;
  note?: string;
}
export interface LootSpec {
  tier: 'common' | 'rare' | 'epic';
  at?: readonly [number, number];
  place?: readonly (readonly [number, number])[];
  ring?: RingSpec;
  polar?: readonly [number, number];
}
export interface VariantSpec {
  id: string;
  weight?: number;
  baseline?: boolean;
  pieces?: readonly PieceSpec[];
  loot?: readonly LootSpec[];
  fixedOverride?: { tikibarHutRotDeg?: Range2 };
}
export interface LookPreset {
  id: string;
  weight: number;
  baseline?: boolean;
}

/** Weighted look pick from the `look` stream; seed 0 or none = the baseline preset. */
export function pickLook(seed: number, presets: readonly LookPreset[]): string {
  const base = presets.find((p) => p.baseline) ?? presets[0]!;
  if (seed === 0) return base.id;
  const rng = rngFor(seed, 'look');
  return presets[pickWeighted(rng, presets)]!.id;
}

/** Positions of a ring spec in local coordinates (draws from rng for r ranges and jitter). Returns [point, bearingDeg]. */
export function ringPoints(rng: Rng, ring: RingSpec): { p: P2; deg: number }[] {
  const out: { p: P2; deg: number }[] = [];
  const n = ring.n;
  let start = ring.start ?? 0;
  let step = ring.stepDeg ?? 360 / n;
  if (ring.arc) {
    start = ring.arc[0];
    step = n > 1 ? (ring.arc[1] - ring.arc[0]) / (n - 1) : 0;
  }
  const cx = ring.centre ? ring.centre[0] : 0;
  const cz = ring.centre ? ring.centre[1] : 0;
  for (let k = 0; k < n; k++) {
    const jit = ring.jitterDeg ? range(rng, -ring.jitterDeg, ring.jitterDeg) : 0;
    const deg = start + step * k + jit;
    const r = typeof ring.r === 'number' ? ring.r : range(rng, ring.r[0], ring.r[1]);
    const b = bearing(deg, r);
    out.push({ p: { x: cx + b.x, z: cz + b.z }, deg });
  }
  return out;
}

/** A uniform random point of a scatter area (local), or null when it lands in a `minus` strip. */
export function scatterPoint(rng: Rng, s: ScatterSpec): P2 | null {
  const cx = s.centre ? s.centre[0] : 0;
  const cz = s.centre ? s.centre[1] : 0;
  let p: P2;
  if (s.rect) {
    p = { x: range(rng, s.rect[0], s.rect[2]), z: range(rng, s.rect[1], s.rect[3]) };
  } else {
    const r0 = s.annulus ? s.annulus[0] : 0;
    const r1 = s.annulus ? s.annulus[1] : (s.disc ?? 1);
    const r = Math.sqrt(range(rng, r0 * r0, r1 * r1));
    const b = bearing(range(rng, 0, 360), r);
    p = { x: cx + b.x, z: cz + b.z };
  }
  for (const m of s.minus ?? []) {
    const v = m.strip.axis === 'z' ? p.x : p.z;
    if (v > -m.strip.halfWidth && v < m.strip.halfWidth) return null;
  }
  return p;
}

/** Decor kinds the generators can emit (the render decor table must cover exactly these; ADR 0007 §1.1). */
export const DECOR_KINDS = [
  'shellCluster', 'starfish', 'sandcastle', 'beachTowel', 'fernTuft', 'flowerTuft', 'coconutPile', 'seaweed', 'paperSheets',
] as const;
export type DecorKind = (typeof DECOR_KINDS)[number];
