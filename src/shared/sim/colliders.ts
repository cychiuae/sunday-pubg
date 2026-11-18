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
 *
 * M2b indoor maps (ADR 0005 §2): every wall segment is one oriented box (`wallFrame`), every kit part of every prop is a
 * prism through the placement transform T(x, y, z) · R_y(rotY) · S(scale), kit ramps become stairs of flat boxes with
 * rises <= RAMP_STEP_FRACTION x stepHeight, and glass walls / glass kit parts set `glass` (solid; impact kind 'glass').
 * The kit is read from `map.kit` (the sim never imports src/shared/kits). The grid covers `mapBounds(map)`, and boxes
 * are inserted by oriented-box cell coverage, so a 68 m wall fills only the cells it crosses.
 */
import { isIndoor, mapBounds, wallFrame } from '../maps';
import type {
  AnyMapData,
  IndoorMapData,
  IndoorPropPlacement,
  KitCollider,
  PropKind,
  PropKitEntry,
  PropPlacement,
  Vec3,
  WallSegment,
} from '../types';
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
  /** Index into map.props (-1 for indoor wall segments). */
  prop: number;
  /** M2b: glass (solid in the sim; impact and contact surface 'glass'). */
  glass?: boolean;
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
  /** Index into map.props (-1 for indoor wall segments). */
  prop: number;
  /** M2b: glass (solid in the sim; impact and contact surface 'glass'). */
  glass?: boolean;
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
  /** cells[row * cols + col] = collider indices overlapping the cell (circles by bounding square, boxes by OBB coverage). */
  readonly cells: readonly (readonly number[])[];
}

/** Base y of a prop (part heights are measured from here). */
export function propBaseY(p: PropPlacement, map: AnyMapData): number {
  if (p.kind === 'dock') return 0;
  const ground = heightAt(p.x, p.z, map);
  return p.kind === 'boat' ? Math.max(BOAT_MIN_BASE_Y, ground) : ground;
}

/** All collider parts for one placement (empty for soft props). */
export function collidersForProp(p: PropPlacement, index: number, map: AnyMapData): Collider[] {
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
export function colliderForProp(p: PropPlacement, index: number, map: AnyMapData): Collider | null {
  return collidersForProp(p, index, map)[0] ?? null;
}

export const boundingRadius = (c: Collider): number => (c.shape === 'circle' ? c.r : Math.hypot(c.hx, c.hz));

/**
 * Kit ramps compile to stairs whose rises are at most this fraction of movement.stepHeight (ADR 0005 §3), so walking
 * up never needs a jump and float error never pushes a rise over the step limit.
 */
export const RAMP_STEP_FRACTION = 0.8;

/** Oriented box helper: centre, half extents, rotation (local X -> world (cos, -sin), local Z -> (sin, cos)). */
function orientedBox(
  x: number,
  z: number,
  hx: number,
  hz: number,
  rotY: number,
  bottom: number,
  top: number,
  prop: number,
  glass: boolean,
): BoxCollider {
  const c: BoxCollider = { shape: 'box', x, z, hx, hz, sin: Math.sin(rotY), cos: Math.cos(rotY), top, bottom, prop };
  if (glass) c.glass = true;
  return c;
}

/** One indoor wall segment as a box collider (ADR 0005 §2: through `wallFrame`, shared with render and the minimap). */
export function wallCollider(w: WallSegment): BoxCollider {
  const f = wallFrame(w);
  return orientedBox(f.cx, f.cz, f.halfLength, f.halfThickness, f.rotY, w.bottom, w.top, -1, w.material === 'glass');
}

/**
 * Collider prisms of one kit part under a placement: boxes and cylinders map 1:1, a ramp becomes
 * n = ceil(rise / (RAMP_STEP_FRACTION x stepHeight)) flat steps of rise/n and depth/n climbing toward local -Z.
 */
export function kitPartColliders(
  part: KitCollider,
  p: IndoorPropPlacement,
  index: number,
  stepHeight: number,
  out: Collider[] = [],
): Collider[] {
  const s = p.scale;
  const sin = Math.sin(p.rotY);
  const cos = Math.cos(p.rotY);
  // Local (lx, lz) at scale s -> world: local X -> (cos, -sin), local Z -> (sin, cos).
  const wx = (lx: number, lz: number): number => p.x + lx * s * cos + lz * s * sin;
  const wz = (lx: number, lz: number): number => p.z - lx * s * sin + lz * s * cos;
  if (part.type === 'cylinder') {
    out.push({ shape: 'circle', x: wx(part.x, part.z), z: wz(part.x, part.z), r: part.r * s, bottom: p.y + part.y0 * s, top: p.y + part.y1 * s, prop: index });
    return out;
  }
  const [x0, y0, z0] = part.min;
  const [x1, y1, z1] = part.max;
  const cx = (x0 + x1) / 2;
  const hx = ((x1 - x0) / 2) * s;
  if (part.type === 'box') {
    const cz = (z0 + z1) / 2;
    out.push(orientedBox(wx(cx, cz), wz(cx, cz), hx, ((z1 - z0) / 2) * s, p.rotY, p.y + y0 * s, p.y + y1 * s, index, part.glass === true));
    return out;
  }
  // Ramp: walkable top rises from y0 at z1 to y1 at z0 (toward -Z).
  const rise = (y1 - y0) * s;
  const maxRise = RAMP_STEP_FRACTION * stepHeight;
  const n = rise > 0 && maxRise > 0 ? Math.max(1, Math.ceil(rise / maxRise - 1e-9)) : 1;
  const tread = (z1 - z0) / n;
  for (let i = 1; i <= n; i++) {
    const zFront = z1 - (i - 1) * tread;
    const zBack = z1 - i * tread;
    const cz = (zFront + zBack) / 2;
    out.push(orientedBox(wx(cx, cz), wz(cx, cz), hx, (tread / 2) * s, p.rotY, p.y + y0 * s, p.y + y0 * s + (rise * i) / n, index, false));
  }
  return out;
}

/** Every collider of one indoor prop (empty for visual-only kinds or unknown keys). */
export function kitPropColliders(entry: PropKitEntry | undefined, p: IndoorPropPlacement, index: number, stepHeight: number): Collider[] {
  const out: Collider[] = [];
  if (!entry) return out;
  for (const part of entry.colliders) kitPartColliders(part, p, index, stepHeight, out);
  return out;
}

function indoorColliders(map: IndoorMapData, stepHeight: number): Collider[] {
  const out: Collider[] = [];
  for (const w of map.walls) out.push(wallCollider(w));
  map.props.forEach((p, i) => {
    const entry = Object.prototype.hasOwnProperty.call(map.kit, p.kind) ? map.kit[p.kind] : undefined;
    for (const c of kitPropColliders(entry, p, i, stepHeight)) out.push(c);
  });
  return out;
}

/**
 * Static colliders of a map plus the spatial grid (sized from `mapBounds`). `stepHeight` = balance
 * movement.stepHeight (indoor ramp stairs); island maps ignore it.
 */
export function buildColliders(map: AnyMapData, stepHeight: number): ColliderSet {
  const colliders: Collider[] = [];
  if (isIndoor(map)) {
    for (const c of indoorColliders(map, stepHeight)) colliders.push(c);
  } else {
    map.props.forEach((p, i) => {
      for (const c of collidersForProp(p, i, map)) colliders.push(c);
    });
  }
  const bounds = mapBounds(map);
  const minX = bounds.minX - GRID_MARGIN;
  const minZ = bounds.minZ - GRID_MARGIN;
  const cols = Math.max(1, Math.ceil((bounds.maxX + GRID_MARGIN - minX) / CELL_SIZE));
  const rows = Math.max(1, Math.ceil((bounds.maxZ + GRID_MARGIN - minZ) / CELL_SIZE));
  const cells: number[][] = [];
  for (let i = 0; i < cols * rows; i++) cells.push([]);
  colliders.forEach((c, idx) => {
    const br = boundingRadius(c);
    const c0 = clampCell(Math.floor((c.x - br - minX) / CELL_SIZE), cols);
    const c1 = clampCell(Math.floor((c.x + br - minX) / CELL_SIZE), cols);
    const r0 = clampCell(Math.floor((c.z - br - minZ) / CELL_SIZE), rows);
    const r1 = clampCell(Math.floor((c.z + br - minZ) / CELL_SIZE), rows);
    for (let r = r0; r <= r1; r++) {
      for (let col = c0; col <= c1; col++) {
        if (c.shape === 'box' && !boxOverlapsCell(c, minX + col * CELL_SIZE, minZ + r * CELL_SIZE, CELL_SIZE)) continue;
        cells[r * cols + col]!.push(idx);
      }
    }
  });
  return { colliders, cellSize: CELL_SIZE, minX, minZ, cols, rows, cells };
}

/** 2D separating-axis test: oriented box footprint vs the axis-aligned cell [x0, x0 + size] x [z0, z0 + size]. */
function boxOverlapsCell(c: BoxCollider, x0: number, z0: number, size: number): boolean {
  const h = size / 2;
  const ccx = x0 + h;
  const ccz = z0 + h;
  const dx = ccx - c.x;
  const dz = ccz - c.z;
  // Box axes in world: u = (cos, -sin) (local X), v = (sin, cos) (local Z).
  const ux = c.cos;
  const uz = -c.sin;
  const vx = c.sin;
  const vz = c.cos;
  const eps = 1e-9;
  // World axes.
  if (Math.abs(dx) > h + c.hx * Math.abs(ux) + c.hz * Math.abs(vx) + eps) return false;
  if (Math.abs(dz) > h + c.hx * Math.abs(uz) + c.hz * Math.abs(vz) + eps) return false;
  // Box axes.
  if (Math.abs(dx * ux + dz * uz) > c.hx + h * (Math.abs(ux) + Math.abs(uz)) + eps) return false;
  if (Math.abs(dx * vx + dz * vz) > c.hz + h * (Math.abs(vx) + Math.abs(vz)) + eps) return false;
  return true;
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

/** M2b: 'glass' = a glass wall or a glass kit part (solid). Indoor floor and ceiling hits are 'terrain'. */
export type StaticHitKind = 'terrain' | 'prop' | 'water' | 'glass';

export interface StaticHit {
  t: number;
  kind: StaticHitKind;
}

/**
 * First static obstacle (prop, wall or terrain) along a unit ray within maxT, or null. A terrain hit below sea level
 * is reported as 'water' (water itself does not block shots; the sea floor does). Indoor: the floor and the ceiling
 * planes are 'terrain' (shots stop at the ceiling), glass colliders are 'glass'.
 */
export function raycastStatic(set: ColliderSet, map: AnyMapData, o: Vec3, dir: Vec3, maxT: number): StaticHit | null {
  const prop = raycastColliders(set, o, dir, maxT);
  const limit = prop ? prop.t : maxT;
  const tt = raycastTerrain(o.x, o.y, o.z, dir.x, dir.y, dir.z, limit, map);
  if (tt >= 0 && (!prop || tt < prop.t)) {
    const y = o.y + dir.y * tt;
    return { t: tt, kind: y < 0 ? 'water' : 'terrain' };
  }
  return prop ? { t: prop.t, kind: prop.collider.glass === true ? 'glass' : 'prop' } : null;
}

/** True when nothing static blocks the segment a -> b. */
export function lineOfSight(set: ColliderSet, map: AnyMapData, a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  return raycastStatic(set, map, a, dir, len) === null;
}
