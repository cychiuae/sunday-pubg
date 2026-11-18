/**
 * Static prop colliders derived from PropKind x scale, a uniform-grid spatial hash, movement push-out helpers and
 * ray casts for hitscan / line of sight. Pure and deterministic.
 *
 * Every collider is a vertical prism (circle or oriented box footprint) between `bottom` and `top` (absolute y).
 * Ground-rooted parts have bottom = -Infinity; raised parts (a leaning palm trunk's upper segments) float. A prop can
 * have several parts (a hut is a wall box plus a stepped roof). For movement, a collider whose top is within
 * `stepHeight` of the player's feet is walkable ground (crate tops, dock decks, boats) instead of a wall.
 *
 * Part sizes at scale 1 are measured from the procedural models in src/render/procedural/props.ts (sizes listed in its
 * header and in docs/art/ASSET_LIST.md). If a model changes size, update PROP_SHAPES and the tests in
 * colliders.test.ts so bullets and feet keep lining up with what players see.
 */
import type { MapData, PropKind, PropPlacement, Vec3 } from '../types';
import { heightAt, raycastTerrain } from './terrain';

export interface CircleCollider {
  shape: 'circle';
  x: number;
  z: number;
  r: number;
  /** Absolute y of the top. */
  top: number;
  /** Absolute y of the bottom (-Infinity for ground-rooted parts). */
  bottom: number;
  /** Index into map.props. */
  prop: number;
}

export interface BoxCollider {
  shape: 'box';
  x: number;
  z: number;
  /** Half extent along the prop's local X. */
  hx: number;
  /** Half extent along the prop's local Z. */
  hz: number;
  sin: number;
  cos: number;
  top: number;
  bottom: number;
  prop: number;
}

export type Collider = CircleCollider | BoxCollider;

/**
 * One collider part at scale 1, in the prop's local frame (local X -> world (cos rotY, -sin rotY), local Z -> world
 * (sin rotY, cos rotY), the same frame as render's propMatrix). `top` / `bottom` are metres above the prop's base y.
 */
export type PartSpec =
  | { shape: 'circle'; r: number; ox?: number; oz?: number; top: number; bottom?: number }
  | { shape: 'box'; hx: number; hz: number; ox?: number; oz?: number; top: number; bottom?: number };

/** Palm trunk: 6.6 m tall, leans +X by LEAN * t^2 (t = height fraction), radius 0.32 -> 0.20. Crown is not solid. */
const PALM_LEAN = 1.4;
const PALM_H = 6.6;
const palmLeanAt = (y: number): number => PALM_LEAN * (y / PALM_H) ** 2;

/**
 * Collider parts per prop kind at scale 1 (empty = soft prop: no collision, does not block shots or sight).
 * Heights are above the terrain at the prop origin, except docks (absolute, see DOCK_DECK_HEIGHT) and boats (base
 * clamped to BOAT_MIN_BASE_Y).
 */
export const PROP_SHAPES: Readonly<Record<PropKind, readonly PartSpec[]>> = {
  // Leaning trunk as three stacked circles that follow the lean (model: r 0.32 -> 0.20, 6.6 m, +X lean 1.4 m).
  palm: [
    { shape: 'circle', r: 0.34, ox: palmLeanAt(1.25), top: 2.5 },
    { shape: 'circle', r: 0.36, ox: palmLeanAt(3.5), bottom: 2.5, top: 4.5 },
    { shape: 'circle', r: 0.38, ox: palmLeanAt(5.55), bottom: 4.5, top: PALM_H },
  ],
  // Model: ellipsoid ~1.5 x 1.35 m radius, 1.4 m above ground.
  rock: [{ shape: 'circle', r: 1.4, top: 1.4 }],
  // Concealment, not cover.
  bush: [],
  crate: [{ shape: 'box', hx: 0.5, hz: 0.5, top: 1 }],
  // Model: 4 x 4 m on 0.6 m stilts, walls to 2.8 m, 4-sided thatch pyramid (half-width 2.33 at 2.8 m) to 4.7 m,
  // finial to 5.1 m. Wall box plus a stepped roof (each step sized to the pyramid at its mid-height).
  hut: [
    { shape: 'box', hx: 2.05, hz: 2.05, top: 3.3 },
    { shape: 'box', hx: 1.4, hz: 1.4, top: 3.9 },
    { shape: 'box', hx: 0.65, hz: 0.65, top: 4.5 },
    { shape: 'box', hx: 0.3, hz: 0.3, top: 5.1 },
  ],
  // Walkable deck; top is DOCK_DECK_HEIGHT (absolute), see collidersForProp.
  dock: [{ shape: 'box', hx: 1.5, hz: 7, top: 0 }],
  // Pole only (tilted 0.12 rad toward local -X, top under the canopy at ~2.05 m). The cloth canopy is not cover.
  umbrella: [{ shape: 'circle', r: 0.1, ox: -0.07, top: 2.05 }],
  // Model: half-ellipsoid hull 1.5 x 4 m, rim at 0.55 m. Mid box plus round bow/stern. Walkable (inside the boat).
  boat: [
    { shape: 'box', hx: 0.75, hz: 1.3, top: 0.55 },
    { shape: 'circle', r: 0.6, oz: 1.35, top: 0.55 },
    { shape: 'circle', r: 0.6, oz: -1.35, top: 0.55 },
  ],
  // Model: bamboo pole r ~0.06 with a fuel bowl to 2.07 m (flame above is not solid).
  tikiTorch: [{ shape: 'circle', r: 0.1, top: 2.07 }],
  // Model: ~2.6 m log along local Z (slightly bent toward -X), 0.35 m high. Needs a hop (stepHeight 0.3).
  driftwood: [{ shape: 'box', hx: 0.32, hz: 1.3, ox: -0.08, oz: -0.07, top: 0.35 }],
};

/** Dock deck height above sea level (y = 0) at scale 1. Docks stand over water, so this is absolute, not terrain-relative. */
export const DOCK_DECK_HEIGHT = 0.8;

/** Boats float: their base y is max(terrain, BOAT_MIN_BASE_Y). Mirrors render's propBaseY. */
export const BOAT_MIN_BASE_Y = -0.12;

const CELL_SIZE = 8;
const GRID_MARGIN = 16;

export interface ColliderSet {
  readonly colliders: readonly Collider[];
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly cols: number;
  readonly rows: number;
  /** cells[row * cols + col] = collider indices overlapping the cell (by bounding circle). */
  readonly cells: readonly (readonly number[])[];
}

/** Base y of a prop (part heights are measured from here). */
export function propBaseY(p: PropPlacement, map: MapData): number {
  if (p.kind === 'dock') return 0;
  const ground = heightAt(p.x, p.z, map);
  return p.kind === 'boat' ? Math.max(BOAT_MIN_BASE_Y, ground) : ground;
}

/** All collider parts for one placement (empty for soft props). */
export function collidersForProp(p: PropPlacement, index: number, map: MapData): Collider[] {
  const s = p.scale;
  const sin = Math.sin(p.rotY);
  const cos = Math.cos(p.rotY);
  const base = propBaseY(p, map);
  return PROP_SHAPES[p.kind].map((spec): Collider => {
    const ox = (spec.ox ?? 0) * s;
    const oz = (spec.oz ?? 0) * s;
    const x = p.x + ox * cos + oz * sin;
    const z = p.z - ox * sin + oz * cos;
    const top = p.kind === 'dock' ? DOCK_DECK_HEIGHT * s : base + spec.top * s;
    const bottom = spec.bottom === undefined ? -Infinity : base + spec.bottom * s;
    if (spec.shape === 'circle') return { shape: 'circle', x, z, r: spec.r * s, top, bottom, prop: index };
    return { shape: 'box', x, z, hx: spec.hx * s, hz: spec.hz * s, sin, cos, top, bottom, prop: index };
  });
}

/** Main (first) collider part for one placement, or null for soft props. */
export function colliderForProp(p: PropPlacement, index: number, map: MapData): Collider | null {
  return collidersForProp(p, index, map)[0] ?? null;
}

export const boundingRadius = (c: Collider): number => (c.shape === 'circle' ? c.r : Math.hypot(c.hx, c.hz));

export function buildColliders(map: MapData): ColliderSet {
  const colliders: Collider[] = [];
  map.props.forEach((p, i) => {
    for (const c of collidersForProp(p, i, map)) colliders.push(c);
  });
  const extent = map.worldRadius + GRID_MARGIN;
  const minX = -extent;
  const minZ = -extent;
  const cols = Math.ceil((2 * extent) / CELL_SIZE);
  const rows = cols;
  const cells: number[][] = [];
  for (let i = 0; i < cols * rows; i++) cells.push([]);
  colliders.forEach((c, idx) => {
    const br = boundingRadius(c);
    const c0 = clampCell(Math.floor((c.x - br - minX) / CELL_SIZE), cols);
    const c1 = clampCell(Math.floor((c.x + br - minX) / CELL_SIZE), cols);
    const r0 = clampCell(Math.floor((c.z - br - minZ) / CELL_SIZE), rows);
    const r1 = clampCell(Math.floor((c.z + br - minZ) / CELL_SIZE), rows);
    for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) cells[r * cols + col]!.push(idx);
  });
  return { colliders, cellSize: CELL_SIZE, minX, minZ, cols, rows, cells };
}

const clampCell = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);

/**
 * Calls `fn(collider)` for every collider whose cell overlaps the square around (x, z). A collider spanning several
 * cells may be visited more than once; all callers here are idempotent (push-out, max, min).
 */
export function forEachColliderNear(
  set: ColliderSet,
  x: number,
  z: number,
  radius: number,
  fn: (c: Collider) => void,
): void {
  const c0 = clampCell(Math.floor((x - radius - set.minX) / set.cellSize), set.cols);
  const c1 = clampCell(Math.floor((x + radius - set.minX) / set.cellSize), set.cols);
  const r0 = clampCell(Math.floor((z - radius - set.minZ) / set.cellSize), set.rows);
  const r1 = clampCell(Math.floor((z + radius - set.minZ) / set.cellSize), set.rows);
  for (let r = r0; r <= r1; r++) {
    for (let col = c0; col <= c1; col++) {
      const cell = set.cells[r * set.cols + col]!;
      for (let i = 0; i < cell.length; i++) fn(set.colliders[cell[i]!]!);
    }
  }
}

/** World XZ -> box-local (lx along local X, lz along local Z). */
function toLocal(c: BoxCollider, x: number, z: number): { lx: number; lz: number } {
  const dx = x - c.x;
  const dz = z - c.z;
  return { lx: dx * c.cos - dz * c.sin, lz: dx * c.sin + dz * c.cos };
}

export function containsPoint(c: Collider, x: number, z: number): boolean {
  if (c.shape === 'circle') {
    const dx = x - c.x;
    const dz = z - c.z;
    return dx * dx + dz * dz <= c.r * c.r;
  }
  const { lx, lz } = toLocal(c, x, z);
  return Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz;
}

/** True if a circle of radius `r` at (x, z) overlaps the collider footprint (touching counts). */
export function overlapsCircle(c: Collider, x: number, z: number, r: number): boolean {
  if (c.shape === 'circle') {
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = c.r + r;
    return dx * dx + dz * dz <= rr * rr;
  }
  const { lx, lz } = toLocal(c, x, z);
  const qx = lx - Math.max(-c.hx, Math.min(c.hx, lx));
  const qz = lz - Math.max(-c.hz, Math.min(c.hz, lz));
  return qx * qx + qz * qz <= r * r;
}

/**
 * Highest walkable collider top under the point (x, z) that is at most `feetY + stepHeight`, or -Infinity.
 */
export function platformHeightAt(set: ColliderSet, x: number, z: number, feetY: number, stepHeight: number): number {
  let best = -Infinity;
  const limit = feetY + stepHeight;
  forEachColliderNear(set, x, z, 0, (c) => {
    if (c.top <= limit && c.top > best && containsPoint(c, x, z)) best = c.top;
  });
  return best;
}

/** Mutable push-out accumulator (owned by the caller). */
export interface PushOut {
  x: number;
  z: number;
}

/**
 * Pushes a circle (player footprint) out of every wall collider. A collider is a wall when the feet are lower than
 * `top - stepHeight` and the body (feetY .. feetY + bodyHeight) reaches its bottom. Iterates a few times to settle
 * corners. Writes the result into `out`.
 */
export function resolveCircle(
  set: ColliderSet,
  x: number,
  z: number,
  radius: number,
  feetY: number,
  stepHeight: number,
  out: PushOut,
  bodyHeight = Infinity,
): void {
  let px = x;
  let pz = z;
  const iterations = 3;
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    forEachColliderNear(set, px, pz, radius, (c) => {
      if (feetY >= c.top - stepHeight || feetY + bodyHeight <= c.bottom) return;
      if (c.shape === 'circle') {
        const dx = px - c.x;
        const dz = pz - c.z;
        const min = c.r + radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min) return;
        const d = Math.sqrt(d2);
        if (d < 1e-9) {
          px = c.x + min;
        } else {
          px = c.x + (dx / d) * min;
          pz = c.z + (dz / d) * min;
        }
        moved = true;
        return;
      }
      const { lx, lz } = toLocal(c, px, pz);
      let nlx = lx;
      let nlz = lz;
      const ax = Math.abs(lx);
      const az = Math.abs(lz);
      if (ax <= c.hx && az <= c.hz) {
        // Centre inside the box: push out along the axis of least penetration.
        const penX = c.hx - ax + radius;
        const penZ = c.hz - az + radius;
        if (penX < penZ) nlx = (lx >= 0 ? 1 : -1) * (c.hx + radius);
        else nlz = (lz >= 0 ? 1 : -1) * (c.hz + radius);
      } else {
        const cx = Math.max(-c.hx, Math.min(c.hx, lx));
        const cz = Math.max(-c.hz, Math.min(c.hz, lz));
        const qx = lx - cx;
        const qz = lz - cz;
        const d2 = qx * qx + qz * qz;
        if (d2 >= radius * radius) return;
        const d = Math.sqrt(d2);
        nlx = cx + (qx / d) * radius;
        nlz = cz + (qz / d) * radius;
      }
      // Local -> world: local X = (cos, -sin), local Z = (sin, cos).
      px = c.x + nlx * c.cos + nlz * c.sin;
      pz = c.z - nlx * c.sin + nlz * c.cos;
      moved = true;
    });
    if (!moved) break;
  }
  out.x = px;
  out.z = pz;
}

/** [tEnter, tExit] of a 2D ray (origin o, direction d, not necessarily unit) against a footprint, or null. */
function footprintInterval(c: Collider, ox: number, oz: number, dx: number, dz: number): [number, number] | null {
  if (c.shape === 'circle') {
    const fx = ox - c.x;
    const fz = oz - c.z;
    const a = dx * dx + dz * dz;
    const cc = fx * fx + fz * fz - c.r * c.r;
    if (a < 1e-12) return cc <= 0 ? [-Infinity, Infinity] : null;
    const b = fx * dx + fz * dz;
    const disc = b * b - a * cc;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    return [(-b - sq) / a, (-b + sq) / a];
  }
  const { lx, lz } = toLocal(c, ox, oz);
  const ldx = dx * c.cos - dz * c.sin;
  const ldz = dx * c.sin + dz * c.cos;
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (o: number, d: number, h: number): boolean => {
    if (Math.abs(d) < 1e-12) return Math.abs(o) <= h;
    let a = (-h - o) / d;
    let b = (h - o) / d;
    if (a > b) {
      const tmp = a;
      a = b;
      b = tmp;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return t0 <= t1;
  };
  if (!slab(lx, ldx, c.hx) || !slab(lz, ldz, c.hz)) return null;
  return [t0, t1];
}

/** Ray (unit `dir`) vs one collider prism. Returns hit distance in [0, maxT] or -1. */
export function rayCollider(c: Collider, o: Vec3, dir: Vec3, maxT: number): number {
  const fp = footprintInterval(c, o.x, o.z, dir.x, dir.z);
  if (!fp) return -1;
  let t0 = fp[0];
  let t1 = fp[1];
  // Slab bottom <= y <= top.
  if (Math.abs(dir.y) < 1e-12) {
    if (o.y > c.top || o.y < c.bottom) return -1;
  } else {
    const tt = (c.top - o.y) / dir.y;
    const tb = (c.bottom - o.y) / dir.y; // +-Infinity for ground-rooted parts
    if (dir.y > 0) {
      t1 = Math.min(t1, tt);
      t0 = Math.max(t0, tb);
    } else {
      t0 = Math.max(t0, tt);
      t1 = Math.min(t1, tb);
    }
  }
  if (t0 > t1 || t1 < 0) return -1;
  const t = Math.max(0, t0);
  return t <= maxT ? t : -1;
}

/** Nearest prop hit along a ray: `{ t, collider }`, or null. Walks the grid with a 2D DDA. */
export function raycastColliders(
  set: ColliderSet,
  o: Vec3,
  dir: Vec3,
  maxT: number,
): { t: number; collider: Collider } | null {
  let bestT = Infinity;
  let best: Collider | null = null;
  const testCell = (col: number, row: number): void => {
    const cell = set.cells[row * set.cols + col]!;
    for (let i = 0; i < cell.length; i++) {
      const c = set.colliders[cell[i]!]!;
      const t = rayCollider(c, o, dir, maxT);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = c;
      }
    }
  };
  const cs = set.cellSize;
  let col = Math.floor((o.x - set.minX) / cs);
  let row = Math.floor((o.z - set.minZ) / cs);
  const inGrid = (): boolean => col >= 0 && col < set.cols && row >= 0 && row < set.rows;
  const hlen = Math.hypot(dir.x, dir.z);
  if (hlen < 1e-9) {
    if (inGrid()) testCell(col, row);
    return best ? { t: bestT, collider: best } : null;
  }
  const stepX = dir.x > 0 ? 1 : -1;
  const stepZ = dir.z > 0 ? 1 : -1;
  const tDeltaX = Math.abs(dir.x) < 1e-12 ? Infinity : cs / Math.abs(dir.x);
  const tDeltaZ = Math.abs(dir.z) < 1e-12 ? Infinity : cs / Math.abs(dir.z);
  const nextBoundX = set.minX + (col + (stepX > 0 ? 1 : 0)) * cs;
  const nextBoundZ = set.minZ + (row + (stepZ > 0 ? 1 : 0)) * cs;
  let tMaxX = Math.abs(dir.x) < 1e-12 ? Infinity : (nextBoundX - o.x) / dir.x;
  let tMaxZ = Math.abs(dir.z) < 1e-12 ? Infinity : (nextBoundZ - o.z) / dir.z;
  let tCell = 0;
  // Bounded walk: a ray of length maxT crosses at most this many cells.
  const maxCells = Math.ceil((maxT * hlen) / cs) * 2 + 4;
  for (let i = 0; i < maxCells; i++) {
    if (inGrid()) testCell(col, row);
    const tExit = Math.min(tMaxX, tMaxZ);
    if (bestT <= tExit || tExit > maxT) break;
    tCell = tExit;
    if (tMaxX < tMaxZ) {
      col += stepX;
      tMaxX += tDeltaX;
    } else {
      row += stepZ;
      tMaxZ += tDeltaZ;
    }
    if (tCell > maxT) break;
  }
  return best ? { t: bestT, collider: best } : null;
}

export type StaticHitKind = 'terrain' | 'prop' | 'water';

export interface StaticHit {
  t: number;
  kind: StaticHitKind;
}

/**
 * First static obstacle (prop or terrain) along a unit ray within maxT, or null. A terrain hit below sea level is
 * reported as 'water' (water itself does not block shots; the sea floor does).
 */
export function raycastStatic(set: ColliderSet, map: MapData, o: Vec3, dir: Vec3, maxT: number): StaticHit | null {
  const prop = raycastColliders(set, o, dir, maxT);
  const limit = prop ? prop.t : maxT;
  const tt = raycastTerrain(o.x, o.y, o.z, dir.x, dir.y, dir.z, limit, map);
  if (tt >= 0 && (!prop || tt < prop.t)) {
    const y = o.y + dir.y * tt;
    return { t: tt, kind: y < 0 ? 'water' : 'terrain' };
  }
  return prop ? { t: prop.t, kind: 'prop' } : null;
}

/** True when nothing static blocks the segment a -> b. */
export function lineOfSight(set: ColliderSet, map: MapData, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  return raycastStatic(set, map, a, dir, len) === null;
}
