/**
 * M2c per-match layout for the office (docs/design/levels/variety.md §5; data ../variety/office.variety.json).
 * Owner: level-designer. Pure and deterministic (ADR 0007 §1.4): every decision uses detmath, Math.sqrt and integer
 * rotation steps; the geometry here is a deterministic port of ../indoorGeometry.ts (which the tests keep using).
 *
 * Fixed: every OFFICE placement tagged 'fixed' (OFFICE_PROP_TAGS), in base order, first in `props`. Regenerated:
 * the four desk blocks (rows / gaps / pods + dressing), the Fishbowl, Blue Room, pantry and lounge arrangements, the
 * aisle clusters K1-K4, loot, wall-band and corner clutter, desk-top clutter, paper decor, the look and lit panels.
 * Seed 0 is the baseline: OFFICE's props and loot positions unchanged (plus guaranteed-weapon flags).
 */
import data from '../variety/office.variety.json';
import { detCos, detSin, radToStep, roundMm } from '../../../shared/detmath';
import type {
  DecorPlacement,
  IndoorMapData,
  IndoorPropPlacement,
  LayoutPick,
  LootSpawn,
  LootTier,
  PropKit,
  Vec2,
  Vec3,
  WallSegment,
} from '../../../shared/types';
import { OFFICE_DOORWAYS, OFFICE_LAYOUT_SPEC, OFFICE_PROP_TAGS } from '../office';
import { assignDecorVariants } from './island';
import {
  BoundsGrid,
  type LookPreset,
  type P2,
  type Range2,
  type Rng,
  anyStep,
  cm,
  dist,
  intRange,
  mm,
  nudgeSearch,
  pickLook,
  pickWeighted,
  range,
  rngFor,
  rotOfStep,
  shuffle,
  toLocal,
  toWorld,
} from './grammar';

// ---------------------------------------------------------------------------------------------
// Data shapes (office.variety.json)
// ---------------------------------------------------------------------------------------------
type BlockId = 'TL' | 'TR' | 'BL' | 'BR';
type Row = 'N' | 'S';
type XZ = readonly [number, number];
type LootCand = XZ | readonly [number, number, string] | { desk: string; at: XZ } | { tunnel: string };
interface BlockVariant {
  id: string;
  weight?: number;
  baseline?: boolean;
  removeDesks?: { row: readonly Row[]; columns: Partial<Record<Row, readonly number[]>>; count: Range2 };
  removeColumn?: readonly number[];
}
interface RoomPiece {
  kind: string;
  place: readonly XZ[];
  rot?: number | 'any';
}
interface RoomVariant {
  id: string;
  weight?: number;
  baseline?: boolean;
  pieces: readonly RoomPiece[];
  loot?: readonly { tier: LootTier; place: readonly XZ[] }[];
}
interface RoomZone {
  id: string;
  rect: readonly [number, number, number, number];
  lootPick?: Partial<Record<LootTier, number>>;
  loot?: readonly { tier: LootTier; place: readonly XZ[] }[];
  variants: readonly RoomVariant[];
}
interface ShapePiece {
  kind: string;
  at: XZ;
  rot?: number | 'any';
}
interface AisleShape {
  id: string;
  weight?: number;
  baseline?: boolean;
  pieces: { ew?: readonly ShapePiece[]; ns?: readonly ShapePiece[]; any?: readonly ShapePiece[]; chair?: string };
}
interface LootGroup {
  id: string;
  pick: number;
  candidates: readonly LootCand[];
  plusRoom?: string;
}
interface Band {
  id: string;
  wall: 'x' | 'z';
  face: number;
  from: number;
  to: number;
  inward: 1 | -1;
}
interface OfficeVariety {
  look: { presets: readonly LookPreset[]; afterHours: { litFraction: Range2; maxDistanceToLitPanel: number } };
  deskBlocks: {
    constraints: { maxPodsPerMatch: number; distinctPodX: readonly (readonly BlockId[])[] };
    blocks: readonly { id: BlockId; anchors: readonly string[]; variants: readonly BlockVariant[] }[];
    atriumCover: { pieces: readonly { kind: string; at: readonly [string, string] }[] };
    dressing: {
      variants: readonly { id: string; weight?: number; baseline?: boolean }[];
      deskClutter: { counts: Record<string, Range2>; minFullCoverPerBlock: number; fullCoverKinds: readonly string[] };
    };
  };
  aisleClusters: {
    slots: readonly { id: string; centre: XZ; smalls: 'ew' | 'ns'; chair: XZ }[];
    jitter: { x: number; z: number; tries: number };
    shapes: readonly AisleShape[];
  };
  rooms: readonly RoomZone[];
  lootGroups: {
    epic: readonly LootGroup[];
    rare: readonly LootGroup[];
    rareFromRooms: Record<string, number>;
    guaranteedWeapons: { regions: readonly { id: string; spawns: readonly number[]; candidates: readonly XZ[] }[] };
    common: readonly LootGroup[];
  };
  scatter: readonly {
    id: string;
    bands?: readonly Band[];
    metresPerItem?: Range2;
    kinds?: readonly { kind: string; weight: number; count?: Range2 }[];
    fillChance?: number;
    themes?: Record<string, readonly string[]>;
  }[];
  decor: readonly { id: string; kinds: readonly { kind: string; count: Range2; surface?: string }[] }[];
  lanes: Record<string, unknown>;
  rules: {
    propGap: number;
    flushGap: number;
    doorApron: { width: number; depth: number };
    routeStartClear: number;
    routeApproach: { width: number; length: number };
    routeEndClear: number;
    routeWaypointClear: number;
    spawnClear: number;
    zoneCentreClear: number;
    lootPropClearance: number;
    lootSpacingSameLevel: number;
    lootNudgeMax: number;
    plateauGapForbidden: Range2;
    maxVariablePropTop: number;
    pieceTries: number;
  };
  budgets: { decorPlacementsMax: number };
}
export const OFFICE_VARIETY = data as unknown as OfficeVariety;
const D = OFFICE_VARIETY;
const RU = D.rules;
const S = OFFICE_LAYOUT_SPEC;
const DESK_TOP = S.levelY.desk;
const LEVEL_Y: Record<string, number> = { floor: 0, desk: S.levelY.desk, pong: S.levelY.pong, perch: S.levelY.perch };

/** Kinds whose collider tops count for the plateau-gap rule (standable tops, office.md §4.1). */
const STANDABLE = new Set(['desk', 'deskWood', 'box', 'pottedPlant', 'filingCabinet', 'printer', 'pingPongTable', 'foosballTable', 'pantryCounter', 'dumbbellRack', 'guitarStand']);
/** Obstacles at floor level: a part starting below standing height and rising above a step. */
const STAND_H = 1.3;
const STEP_H = 0.35;

// ---------------------------------------------------------------------------------------------
// Deterministic solids (port of indoorGeometry.ts with the detmath table)
// ---------------------------------------------------------------------------------------------
export interface DSolid {
  box: boolean;
  ramp: boolean;
  cx: number;
  cz: number;
  hx: number;
  hz: number;
  r: number;
  c: number;
  s: number;
  y0: number;
  y1: number;
  /** Prop index (>= 0), -1 - wall index, or -1e9 for a probe. */
  prop: number;
  kind: string;
}

export function placementSolids(kit: PropKit, p: IndoorPropPlacement, prop: number): DSolid[] {
  const e = kit[p.kind];
  if (!e) return [];
  const step = radToStep(p.rotY);
  const c = detCos(step);
  const s = detSin(step);
  const sc = p.scale;
  return e.colliders.map((col): DSolid => {
    if (col.type === 'cylinder') {
      const lx = col.x * sc;
      const lz = col.z * sc;
      const r = col.r * sc;
      return { box: false, ramp: false, cx: p.x + lx * c + lz * s, cz: p.z - lx * s + lz * c, hx: r, hz: r, r, c, s, y0: p.y + col.y0 * sc, y1: p.y + col.y1 * sc, prop, kind: p.kind };
    }
    const lx = ((col.min[0] + col.max[0]) / 2) * sc;
    const lz = ((col.min[2] + col.max[2]) / 2) * sc;
    return {
      box: true,
      ramp: col.type === 'ramp',
      cx: p.x + lx * c + lz * s,
      cz: p.z - lx * s + lz * c,
      hx: ((col.max[0] - col.min[0]) / 2) * sc,
      hz: ((col.max[2] - col.min[2]) / 2) * sc,
      r: 0,
      c,
      s,
      y0: p.y + col.min[1] * sc,
      y1: p.y + col.max[1] * sc,
      prop,
      kind: p.kind,
    };
  });
}

/** Office walls are axis-aligned: an exact box without trig. */
export function wallDSolid(w: WallSegment, i: number): DSolid {
  const alongX = Math.abs(w.z2 - w.z1) < 1e-9;
  const hx = alongX ? Math.abs(w.x2 - w.x1) / 2 : w.thickness / 2;
  const hz = alongX ? w.thickness / 2 : Math.abs(w.z2 - w.z1) / 2;
  return { box: true, ramp: false, cx: (w.x1 + w.x2) / 2, cz: (w.z1 + w.z2) / 2, hx, hz, r: 0, c: 1, s: 0, y0: w.bottom, y1: w.top, prop: -1 - i, kind: 'wall' };
}

const rectSolid = (x0: number, z0: number, x1: number, z1: number): DSolid => ({
  box: true, ramp: false, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, r: 0, c: 1, s: 0, y0: 0, y1: 27, prop: -1e9, kind: 'probe',
});

export function solidAabb(s: DSolid): [number, number, number, number] {
  const ex = s.box ? Math.abs(s.hx * s.c) + Math.abs(s.hz * s.s) : s.r;
  const ez = s.box ? Math.abs(s.hx * s.s) + Math.abs(s.hz * s.c) : s.r;
  return [s.cx - ex, s.cz - ez, s.cx + ex, s.cz + ez];
}

/** 2D distance from (x, z) to the footprint (0 inside). */
export function partDist(s: DSolid, x: number, z: number): number {
  const dx = x - s.cx;
  const dz = z - s.cz;
  if (!s.box) return Math.max(Math.sqrt(dx * dx + dz * dz) - s.r, 0);
  const lx = dx * s.c - dz * s.s;
  const lz = dx * s.s + dz * s.c;
  const ex = Math.max(Math.abs(lx) - s.hx, 0);
  const ez = Math.max(Math.abs(lz) - s.hz, 0);
  return Math.sqrt(ex * ex + ez * ez);
}

export function partContains(s: DSolid, x: number, z: number, inset: number): boolean {
  const dx = x - s.cx;
  const dz = z - s.cz;
  if (!s.box) return Math.sqrt(dx * dx + dz * dz) <= s.r - inset;
  const lx = dx * s.c - dz * s.s;
  const lz = dx * s.s + dz * s.c;
  return Math.abs(lx) <= s.hx - inset && Math.abs(lz) <= s.hz - inset;
}

function corners(s: DSolid): P2[] {
  const out: P2[] = [];
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const lx = sx * s.hx;
    const lz = sz * s.hz;
    out.push({ x: s.cx + lx * s.c + lz * s.s, z: s.cz - lx * s.s + lz * s.c });
  }
  return out;
}

function projRadius(s: DSolid, ax: number, az: number): number {
  // Local X runs along (c, -s), local Z along (s, c).
  return s.hx * Math.abs(ax * s.c - az * s.s) + s.hz * Math.abs(ax * s.s + az * s.c);
}

function boxesOverlap(a: DSolid, b: DSolid): boolean {
  const axes: [number, number][] = [[a.c, -a.s], [a.s, a.c], [b.c, -b.s], [b.s, b.c]];
  for (const [ax, az] of axes) {
    const d = Math.abs((b.cx - a.cx) * ax + (b.cz - a.cz) * az);
    if (d >= projRadius(a, ax, az) + projRadius(b, ax, az)) return false;
  }
  return true;
}

/** 2D gap between two footprints (0 when they touch or overlap). */
export function partGap(a: DSolid, b: DSolid): number {
  if (!a.box && !b.box) return Math.max(dist(a.cx, a.cz, b.cx, b.cz) - a.r - b.r, 0);
  if (!a.box) return Math.max(partDist(b, a.cx, a.cz) - a.r, 0);
  if (!b.box) return Math.max(partDist(a, b.cx, b.cz) - b.r, 0);
  if (boxesOverlap(a, b)) return 0;
  let m = Infinity;
  for (const p of corners(a)) m = Math.min(m, partDist(b, p.x, p.z));
  for (const p of corners(b)) m = Math.min(m, partDist(a, p.x, p.z));
  return m;
}

const isObstacle = (s: DSolid, y = 0): boolean => s.y0 < y + STAND_H && s.y1 > y + STEP_H;

/** Segment vs an axis-aligned box footprint (office walls; c = 1, s = 0): slab test. */
export function segmentHitsAxisBox(s: DSolid, ax: number, az: number, bx: number, bz: number): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: [number, number, number, number][] = [
    [ax, bx - ax, s.cx - s.hx, s.cx + s.hx],
    [az, bz - az, s.cz - s.hz, s.cz + s.hz],
  ];
  for (const [p, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let ta = (lo - p) / d;
    let tb = (hi - p) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------
interface Box2 {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
interface DeskRec {
  key: string;
  block: BlockId;
  x: number;
  z: number;
  step: number;
  code: string;
  occ: Box2[];
  items: number;
  /** Full-height cover items on this desk (deskClutter.fullCoverKinds). */
  full: number;
}
const FULL_COVER = new Set(D.deskBlocks.dressing.deskClutter.fullCoverKinds);
interface Probe extends Vec3 {
  r: number;
}
interface Cand {
  kind: string;
  x: number;
  y: number;
  z: number;
  step: number;
}

class OfficeBuilder {
  readonly props: IndoorPropPlacement[] = [];
  readonly solids: DSolid[] = [];
  private grid = new BoundsGrid(8);
  readonly loot: LootSpawn[] = [];
  readonly desks = new Map<string, DeskRec>();
  readonly decor: DecorPlacement[] = [];
  private readonly decorGrid = new BoundsGrid(4);
  fallbacks = 0;
  fixedCount = 0;
  readonly aprons: DSolid[];
  readonly lanes: DSolid[];
  readonly routeProbes: Probe[] = [];

  constructor(readonly base: IndoorMapData) {
    base.walls.forEach((w, i) => this.addSolid(wallDSolid(w, i)));
    const g = RU.doorApron.width / 2;
    const d = RU.doorApron.depth + 0.45;
    this.aprons = OFFICE_DOORWAYS.map((dw) =>
      Math.abs(dw.rotY) < 1e-6 ? rectSolid(dw.x - g, dw.z - d, dw.x + g, dw.z + d) : rectSolid(dw.x - d, dw.z - g, dw.x + d, dw.z + g),
    );
    this.lanes = Object.entries(D.lanes)
      .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
      .map(([, v]) => {
        const [x0, z0, x1, z1] = v as [number, number, number, number];
        return rectSolid(x0, z0, x1, z1);
      });
    for (const r of base.climbRoutes) {
      const pts = r.points;
      const s = pts[0]!;
      const n = pts[1]!;
      this.routeProbes.push({ ...s, r: RU.routeStartClear });
      const dx = s.x - n.x;
      const dz = s.z - n.z;
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > 1e-6) {
        for (let t = 0.5; t <= RU.routeApproach.length + 1e-9; t += 0.5) {
          this.routeProbes.push({ x: s.x + (dx / l) * t, y: s.y, z: s.z + (dz / l) * t, r: RU.routeApproach.width / 2 });
        }
      }
      this.routeProbes.push({ ...pts[pts.length - 1]!, r: RU.routeEndClear });
      for (let k = 1; k < pts.length - 1; k++) this.routeProbes.push({ ...pts[k]!, r: RU.routeWaypointClear });
    }
  }

  private addSolid(s: DSolid): void {
    const i = this.solids.length;
    this.solids.push(s);
    const [x0, z0, x1, z1] = solidAabb(s);
    this.grid.add(i, x0, z0, x1, z1);
  }

  near(x0: number, z0: number, x1: number, z1: number, fn: (s: DSolid) => boolean | void): void {
    this.grid.query(x0, z0, x1, z1, (i) => fn(this.solids[i]!));
  }

  checkpoint(): { props: number; solids: number } {
    return { props: this.props.length, solids: this.solids.length };
  }

  /** Drops everything placed after the checkpoint (rare: rebuilds the grid). */
  rollback(cp: { props: number; solids: number }): void {
    this.props.length = cp.props;
    this.solids.length = cp.solids;
    this.grid = new BoundsGrid(8);
    this.solids.forEach((s, i) => {
      const [x0, z0, x1, z1] = solidAabb(s);
      this.grid.add(i, x0, z0, x1, z1);
    });
  }

  /**
   * variety.md LV8: an r 2 agent can still cross the main aisle from (-84, 0) to (114, 0), over the whole floor (1 m
   * cells, 4-neighbour flood: the same rule as the test, with a 5 cm margin for the Math-vs-table geometry).
   */
  aislePassable(): boolean {
    const f = this.base.floor;
    const R = 2.05;
    const cell = 1;
    const nx = Math.ceil((f.maxX - f.minX) / cell);
    const nz = Math.ceil((f.maxZ - f.minZ) / cell);
    const free = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      const cz = f.minZ + (j + 0.5) * cell;
      if (cz < f.minZ + R || cz > f.maxZ - R) continue;
      for (let i = 0; i < nx; i++) {
        const cx = f.minX + (i + 0.5) * cell;
        if (cx < f.minX + R || cx > f.maxX - R) continue;
        let blocked = false;
        this.near(cx - R, cz - R, cx + R, cz + R, (s) => {
          if (isObstacle(s) && partDist(s, cx, cz) < R) {
            blocked = true;
            return true;
          }
          return false;
        });
        if (!blocked) free[j * nx + i] = 1;
      }
    }
    const nearest = (x: number, z: number, mask: Uint8Array): number => {
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          if (!mask[j * nx + i]) continue;
          const d = dist(f.minX + (i + 0.5) * cell, f.minZ + (j + 0.5) * cell, x, z);
          if (d <= 2 && d < bestD) {
            bestD = d;
            best = j * nx + i;
          }
        }
      }
      return best;
    };
    const start = nearest(-84, 0, free);
    if (start < 0) return false;
    const reached = new Uint8Array(nx * nz);
    const queue = new Int32Array(nx * nz);
    let head = 0;
    let tail = 0;
    reached[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++]!;
      const i = c % nx;
      const push = (m: number): void => {
        if (free[m] && !reached[m]) {
          reached[m] = 1;
          queue[tail++] = m;
        }
      };
      if (i > 0) push(c - 1);
      if (i < nx - 1) push(c + 1);
      if (c >= nx) push(c - nx);
      if (c + nx < nx * nz) push(c + nx);
    }
    return nearest(114, 0, reached) >= 0;
  }

  /** Adds a placement (rounded: mm, mrad) and its solids. */
  add(kind: string, x: number, y: number, z: number, step: number, scale = 1): IndoorPropPlacement {
    const p: IndoorPropPlacement = { kind, x: mm(x), y: mm(y), z: mm(z), rotY: rotOfStep(step), scale: cm(scale) };
    const idx = this.props.length;
    this.props.push(p);
    for (const s of placementSolids(this.base.kit, p, idx)) this.addSolid(s);
    return p;
  }

  addRaw(p: IndoorPropPlacement): void {
    const idx = this.props.length;
    this.props.push({ ...p });
    for (const s of placementSolids(this.base.kit, p, idx)) this.addSolid(s);
  }

  /**
   * variety.md §6 hard rules for a candidate group (placed together, internal pairs exempt). `gap`: the 2 m / flush
   * rule against everything; `plateau`: the 3-6 m plateau-gap ban; `loot`: clear of picked loot.
   */
  private partsOf(group: readonly Cand[]): DSolid[] {
    const parts: DSolid[] = [];
    for (const c of group) {
      const p: IndoorPropPlacement = { kind: c.kind, x: mm(c.x), y: mm(c.y), z: mm(c.z), rotY: rotOfStep(c.step), scale: 1 };
      parts.push(...placementSolids(this.base.kit, p, -2));
    }
    return parts;
  }

  /** LV9 route probes only (desk dressing and clutter). */
  routeClear(group: readonly Cand[]): boolean {
    for (const s of this.partsOf(group)) {
      for (const q of this.routeProbes) {
        if (s.y0 < q.y + STAND_H && s.y1 > q.y + STEP_H && partDist(s, q.x, q.z) < q.r) return false;
      }
    }
    return true;
  }

  /**
   * Is there a full-height wall (solid or glass) across the segment? Two tops on either side of a wall are no
   * near-miss jump (variety.md LV10, test run 3: the lounge box vs the Corner Office plant behind glass W12).
   */
  wallBetween(ax: number, az: number, bx: number, bz: number): boolean {
    let hit = false;
    this.near(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), (s) => {
      if (s.kind !== 'wall' || s.y1 < 20) return false;
      if (segmentHitsAxisBox(s, ax, az, bx, bz)) {
        hit = true;
        return true;
      }
      return false;
    });
    return hit;
  }

  /** The 3-6 m plateau-gap ban only (desk-top boxes). */
  plateauClear(group: readonly Cand[]): boolean {
    return this.plateauOk(this.partsOf(group));
  }

  private plateauOk(parts: readonly DSolid[]): boolean {
    const [lo, hi] = RU.plateauGapForbidden;
    for (const s of parts) {
      if (!STANDABLE.has(s.kind) || s.y1 < 2) continue;
      const [x0, z0, x1, z1] = solidAabb(s);
      let bad = false;
      this.near(x0 - hi, z0 - hi, x1 + hi, z1 + hi, (o) => {
        if (!STANDABLE.has(o.kind) || o.y1 < 2 || Math.abs(o.y1 - s.y1) > 1.35) return false;
        const g = partGap(s, o);
        if (g > lo && g < hi && !this.wallBetween(s.cx, s.cz, o.cx, o.cz)) {
          bad = true;
          return true;
        }
        return false;
      });
      if (bad) return false;
    }
    return true;
  }

  groupOk(group: readonly Cand[], rules: { gap: boolean; plateau: boolean; loot: boolean }): boolean {
    const f = this.base.floor;
    const parts = this.partsOf(group);
    for (const s of parts) {
      const [x0, z0, x1, z1] = solidAabb(s);
      if (x0 < f.minX - 0.01 || z0 < f.minZ - 0.01 || x1 > f.maxX + 0.01 || z1 > f.maxZ + 0.01) return false;
      if (s.y1 > RU.maxVariablePropTop) return false;
      for (const sp of this.base.playerSpawns) if (partDist(s, sp.x, sp.z) < RU.spawnClear + 0.1) return false;
      for (const q of this.routeProbes) {
        // Only parts that block a standing player at the probe's level (a keyboard or a book you step over does not).
        if (s.y0 < q.y + STAND_H && s.y1 > q.y + STEP_H && partDist(s, q.x, q.z) < q.r) return false;
      }
      if (rules.loot) {
        for (const l of this.loot) {
          const ly = l.y ?? 0;
          if (s.y0 >= ly + 1.0 || s.y1 <= ly + 0.01) continue;
          const d = partDist(s, l.x, l.z);
          if (s.y1 > ly + STEP_H ? d < RU.lootPropClearance : d <= 0) return false;
        }
      }
      if (!isObstacle(s)) continue;
      for (const a of this.aprons) if (partGap(s, a) <= 0) return false;
      for (const a of this.lanes) if (partGap(s, a) <= 0) return false;
      for (const zc of this.base.zoneCenters) if (partDist(s, zc.x, zc.z) < RU.zoneCentreClear) return false;
      let bad = false;
      const pad = RU.propGap;
      this.near(x0 - pad, z0 - pad, x1 + pad, z1 + pad, (o) => {
        if (!isObstacle(o)) return false;
        const g = partGap(s, o);
        if (g <= 0 || (rules.gap && g > RU.flushGap + 0.01 && g < RU.propGap)) {
          bad = true;
          return true;
        }
        return false;
      });
      if (bad) return false;
    }
    return !rules.plateau || this.plateauOk(parts);
  }

  commit(group: readonly Cand[]): void {
    for (const c of group) this.add(c.kind, c.x, c.y, c.z, c.step);
  }

  // ---- loot ----
  lootOk(x: number, y: number, z: number): boolean {
    const f = this.base.floor;
    const fc = RU.lootPropClearance;
    if (x < f.minX + fc || x > f.maxX - fc || z < f.minZ + fc || z > f.maxZ - fc) return false;
    // 2 cm margins: the sim and the tests build colliders with Math.cos of the mrad-rounded rotY, which can differ
    // from the table by a few mm on long parts; a spot accepted here must pass there too.
    const c = fc + 0.02;
    let supported = y <= 0.01;
    let bad = false;
    this.near(x - c, z - c, x + c, z + c, (s) => {
      if (!supported && !s.ramp && Math.abs(s.y1 - y) <= 0.05 && partContains(s, x, z, 0.32)) supported = true;
      if (s.y0 >= y + 1.0 || s.y1 <= y + 0.01) return false;
      const d = partDist(s, x, z);
      if (s.y1 > y + STEP_H ? d < c : d <= 0) {
        bad = true;
        return true;
      }
      return false;
    });
    if (bad || !supported) return false;
    for (const l of this.loot) {
      if (Math.abs((l.y ?? 0) - y) > 0.5) continue;
      if (dist(l.x, l.z, x, z) < RU.lootSpacingSameLevel) return false;
    }
    return true;
  }

  addLoot(x: number, y: number, z: number, tier: LootTier, group: string, guarantee: boolean, maxR: number): boolean {
    const p = nudgeSearch(mm(x), mm(z), maxR, (px, pz) => this.lootOk(px, y, pz));
    if (!p) return false;
    const l: LootSpawn = y > 0.01 ? { x: p.x, z: p.z, tier, y: mm(y), group } : { x: p.x, z: p.z, tier, group };
    if (guarantee) l.guarantee = 'weapon';
    this.loot.push(l);
    return true;
  }

  // ---- decor ----
  decorOk(x: number, y: number, z: number): boolean {
    let bad = false;
    this.near(x - 0.2, z - 0.2, x + 0.2, z + 0.2, (s) => {
      if (s.y0 > y + 0.3 || s.y1 < y - 0.01) return false;
      if (Math.abs(s.y1 - y) <= 0.05 && partContains(s, x, z, 0.2)) return false; // the surface it lies on
      if (partDist(s, x, z) < 0.2) {
        bad = true;
        return true;
      }
      return false;
    });
    if (bad) return false;
    for (const l of this.loot) if (Math.abs((l.y ?? 0) - y) < 0.5 && dist(l.x, l.z, x, z) < 1) return false;
    for (const sp of this.base.playerSpawns) if (y < 0.5 && dist(sp.x, sp.z, x, z) < 1) return false;
    this.decorGrid.query(x - 0.6, z - 0.6, x + 0.6, z + 0.6, (i) => {
      const o = this.decor[i]!;
      if (Math.abs(o.y - y) < 0.5 && dist(o.x, o.z, x, z) < 0.6) {
        bad = true;
        return true;
      }
      return false;
    });
    return !bad;
  }

  addDecor(kind: string, x: number, y: number, z: number, step: number): void {
    const i = this.decor.length;
    this.decor.push({ kind, x: mm(x), y: mm(y), z: mm(z), rotY: rotOfStep(step), scale: 1 });
    this.decorGrid.add(i, x, z, x, z);
  }
}

// ---------------------------------------------------------------------------------------------
// Desk geometry helpers (office.md §3; desk-local kind boxes as in office.ts)
// ---------------------------------------------------------------------------------------------
const colX = (b: BlockId, k: number): number => blockDef(b).x0 + S.col * k;
const rowZ = (b: BlockId, row: Row): number => blockDef(b).spine + (row === 'N' ? -S.row : S.row);
function blockDef(id: BlockId): (typeof S.blocks)[number] {
  return S.blocks.find((b) => b.id === id)!;
}

function kindBox(kit: PropKit, kind: string, relStep: number, cx: number, cz: number): Box2 {
  const c = detCos(relStep);
  const s = detSin(relStep);
  const b: Box2 = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  const addPt = (ix: number, iz: number): void => {
    const x = cx + ix * c + iz * s;
    const z = cz - ix * s + iz * c;
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.z0 = Math.min(b.z0, z);
    b.z1 = Math.max(b.z1, z);
  };
  for (const p of kit[kind]?.colliders ?? []) {
    const [x0, z0, x1, z1] = p.type === 'cylinder' ? [p.x - p.r, p.z - p.r, p.x + p.r, p.z + p.r] : [p.min[0], p.min[2], p.max[0], p.max[2]];
    addPt(x0, z0);
    addPt(x1, z0);
    addPt(x0, z1);
    addPt(x1, z1);
  }
  return b;
}
const boxGap = (a: Box2, b: Box2): number => {
  const ex = Math.max(a.x0 - b.x1, b.x0 - a.x1, 0);
  const ez = Math.max(a.z0 - b.z1, b.z0 - a.z1, 0);
  return Math.sqrt(ex * ex + ez * ez);
};
const boxPointDist = (b: Box2, x: number, z: number): number => {
  const ex = Math.max(b.x0 - x, x - b.x1, 0);
  const ez = Math.max(b.z0 - z, z - b.z1, 0);
  return Math.sqrt(ex * ex + ez * ez);
};
const deskFrame = (d: DeskRec): { x: number; z: number; step: number; mirror: boolean } => ({ x: d.x, z: d.z, step: d.step, mirror: false });

function onDesk(b: OfficeBuilder, d: DeskRec, kind: string, lx: number, lz: number, relStep = 0): void {
  const w = toWorld(deskFrame(d), lx, lz);
  b.add(kind, w.x, DESK_TOP, w.z, d.step + relStep);
  d.occ.push(kindBox(b.base.kit, kind, relStep, lx, lz));
  if (FULL_COVER.has(kind)) d.full++;
}

// ---------------------------------------------------------------------------------------------
// Rolls (variety.md §2.2: the first draws of `arr:<zone>`), shared with pickVariants
// ---------------------------------------------------------------------------------------------
export interface OfficeBlockRoll {
  id: BlockId;
  variant: string;
  removed: Set<string>;
  column: number | null;
  rng: Rng;
}
export interface OfficeRolls {
  blocks: OfficeBlockRoll[];
  rooms: { zone: RoomZone; variant: number; rng: Rng }[];
  aisle: { slot: (typeof D.aisleClusters.slots)[number]; shape: number; rng: Rng }[];
}
const baselineOf = <T extends { baseline?: boolean }>(vs: readonly T[]): number => Math.max(0, vs.findIndex((v) => v.baseline));

export function rollOffice(seed: number): OfficeRolls {
  const cons = D.deskBlocks.constraints;
  const blocks: OfficeBlockRoll[] = [];
  let pods = 0;
  for (const bd of D.deskBlocks.blocks) {
    const rng = rngFor(seed, `arr:${bd.id}`);
    if (seed === 0) {
      blocks.push({ id: bd.id, variant: bd.variants[baselineOf(bd.variants)]!.id, removed: new Set(), column: null, rng });
      continue;
    }
    let v = bd.variants[pickWeighted(rng, bd.variants)]!;
    if (v.removeColumn && pods >= cons.maxPodsPerMatch) {
      const others = bd.variants.filter((q) => !q.removeColumn);
      v = others[pickWeighted(rng, others)]!;
    }
    const removed = new Set<string>();
    let column: number | null = null;
    if (v.removeDesks) {
      const rd = v.removeDesks;
      const row = rd.row[Math.floor(rng() * rd.row.length)]!;
      const cols = shuffle(rng, [...(rd.columns[row] ?? [])]);
      const n = Math.min(cols.length, intRange(rng, rd.count[0], rd.count[1]));
      for (const k of cols.slice(0, n)) removed.add(`${bd.id}.${row}.${k}`);
    } else if (v.removeColumn) {
      const opts = v.removeColumn;
      column = opts[Math.floor(rng() * opts.length)]!;
      const pair = cons.distinctPodX.find((p) => p.includes(bd.id));
      const partner = pair ? blocks.find((q) => pair.includes(q.id) && q.id !== bd.id) : undefined;
      const partnerX = partner && partner.column !== null ? colX(partner.id, partner.column) : null;
      if (partnerX !== null && partnerX === colX(bd.id, column)) {
        column = opts.find((c) => colX(bd.id, c) !== partnerX) ?? column;
      }
      for (const row of ['N', 'S'] as const) removed.add(`${bd.id}.${row}.${column}`);
      pods++;
    }
    blocks.push({ id: bd.id, variant: v.id, removed, column, rng });
  }
  const rooms = D.rooms.map((zone) => {
    const rng = rngFor(seed, `arr:${zone.id}`);
    return { zone, variant: seed === 0 ? baselineOf(zone.variants) : pickWeighted(rng, zone.variants), rng };
  });
  const aisle = D.aisleClusters.slots.map((slot) => {
    const rng = rngFor(seed, `arr:${slot.id}`);
    return { slot, shape: seed === 0 ? baselineOf(D.aisleClusters.shapes) : pickWeighted(rng, D.aisleClusters.shapes), rng };
  });
  return { blocks, rooms, aisle };
}

export function officePicks(r: OfficeRolls): LayoutPick[] {
  const out: LayoutPick[] = [];
  for (const b of r.blocks) {
    if (b.column !== null) out.push({ zone: b.id, variant: b.variant, params: { column: b.column } });
    else if (b.removed.size > 0) out.push({ zone: b.id, variant: b.variant, params: { removed: [...b.removed].map((k) => k.slice(3)).sort().join(',') } });
    else out.push({ zone: b.id, variant: b.variant });
  }
  for (const room of r.rooms) out.push({ zone: room.zone.id, variant: room.zone.variants[room.variant]!.id });
  for (const a of r.aisle) out.push({ zone: a.slot.id, variant: D.aisleClusters.shapes[a.shape]!.id });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Generation steps
// ---------------------------------------------------------------------------------------------
/** Full-height cover placements on a block's deck area (the LV15 rule). */
function fullCoverOnDeck(b: OfficeBuilder, id: BlockId): number {
  const def = blockDef(id);
  const x0 = def.x0 - S.col / 2;
  const x1 = def.x0 + S.col * (def.n - 1) + S.col / 2;
  return b.props.filter((p) => FULL_COVER.has(p.kind) && Math.abs(p.y - DESK_TOP) < 0.05 && p.x > x0 && p.x < x1 && Math.abs(p.z - def.spine) < 2 * S.row).length;
}

/** A laptop at desk-local (lx, lz) if it clears the desk's other items and every route probe. */
function tryLaptop(b: OfficeBuilder, d: DeskRec, lx: number, lz: number): boolean {
  const bx = kindBox(b.base.kit, 'laptop', 0, lx, lz);
  if (d.occ.some((o) => boxGap(o, bx) < S.clutterGap)) return false;
  if (!b.routeClear([deskCand(d, 'laptop', lx, lz)])) return false;
  onDesk(b, d, 'laptop', lx, lz);
  return true;
}

/**
 * variety.md §5.1 / LV15, made deterministic (test run 5): right after a block is built, before loot and clutter, put
 * laptops beside the keyboards until the deck holds minFullCoverPerBlock full-height cover items. Every desk side is
 * tried (shuffled), so this only fails when a block has almost no desks left. Returns whether it reached the minimum.
 */
function coverFloor(b: OfficeBuilder, id: BlockId, rng: Rng): boolean {
  const min = D.deskBlocks.dressing.deskClutter.minFullCoverPerBlock;
  if (fullCoverOnDeck(b, id) >= min) return true;
  const desks = shuffle(rng, [...b.desks.values()].filter((d) => d.block === id && d.code !== 'K'));
  for (const lz of [S.laptopAt[1], -0.95]) {
    for (const d of desks) {
      for (const lx of [S.extraLaptopX, -S.extraLaptopX, S.laptopAt[0], -S.laptopAt[0]]) {
        if (tryLaptop(b, d, lx, lz) && fullCoverOnDeck(b, id) >= min) return true;
      }
    }
  }
  return fullCoverOnDeck(b, id) >= min;
}

function placeBlocks(b: OfficeBuilder, rolls: OfficeRolls, seed: number): void {
  for (const roll of rolls.blocks) {
    const rng = rngFor(seed, `dress:${roll.id}`);
    const cp = b.checkpoint();
    buildBlock(b, roll, rng);
    if (coverFloor(b, roll.id, rng)) continue;
    // Guaranteed fallback: the block as `rows` (every desk present), which always has room for the floor.
    b.rollback(cp);
    for (const key of [...b.desks.keys()]) if (key.startsWith(`${roll.id}.`)) b.desks.delete(key);
    b.fallbacks++;
    const rows = D.deskBlocks.blocks.find((q) => q.id === roll.id)!.variants.find((v) => v.baseline)!;
    roll.variant = rows.id;
    roll.removed = new Set();
    roll.column = null;
    buildBlock(b, roll, rng);
    coverFloor(b, roll.id, rng);
  }
  // Extra laptops on random monitored desks (office.md §3.3), clear of the desk's other items and the route probes.
  const rng = rngFor(seed, 'dress:laptops');
  const pool = [...b.desks.values()].filter((d) => d.code === '1' || d.code === '2');
  for (let placed = 0; placed < S.extraLaptops && pool.length > 0; ) {
    const d = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
    const side = rng() < 0.5 ? -1 : 1;
    for (const lx of [side * S.extraLaptopX, -side * S.extraLaptopX]) {
      if (tryLaptop(b, d, lx, S.laptopAt[1])) {
        placed++;
        break;
      }
    }
  }
}

function buildBlock(b: OfficeBuilder, roll: OfficeBlockRoll, rng: Rng): void {
  const dressVs = D.deskBlocks.dressing.variants;
  {
    const bd = blockDef(roll.id);
    // Monitor pattern: the plan, or the same codes shuffled over the non-K/P desks.
    const dress = dressVs[pickWeighted(rng, dressVs)]!;
    const codes = new Map<string, string>();
    const free: string[] = [];
    for (const row of ['N', 'S'] as const) {
      const pat = row === 'N' ? bd.north : bd.south;
      for (let k = 0; k < bd.n; k++) {
        const code = pat[k] ?? 'x';
        codes.set(`${roll.id}.${row}.${k}`, code);
      }
    }
    if (dress.id !== 'plan') {
      const keys = [...codes.keys()].filter((k) => !'KP'.includes(codes.get(k)!));
      const vals = shuffle(rng, keys.map((k) => codes.get(k)!));
      keys.forEach((k, i) => codes.set(k, vals[i]!));
    }
    for (let k = 0; k < bd.n; k++) {
      const x = colX(roll.id, k);
      const colGone = roll.column === k;
      for (const row of ['N', 'S'] as const) {
        const key = `${roll.id}.${row}.${k}`;
        if (roll.removed.has(key)) continue;
        const step = row === 'N' ? 0 : 512;
        const z = rowZ(roll.id, row);
        b.add('desk', x, 0, z, step);
        const code = codes.get(key)!;
        const d: DeskRec = { key, block: roll.id, x, z, step, code, occ: [], items: 0, full: 0 };
        b.desks.set(key, d);
        if (code === '1' || code === '2') {
          onDesk(b, d, code === '2' ? 'monitorDual' : 'monitor', S.monitorAt[0], S.monitorAt[1]);
          onDesk(b, d, 'keyboard', S.keyboardAt[0], S.keyboardAt[1]);
        } else if (code === 'x') {
          // A shuffled pattern can put a laptop next to a route landing (the perch starts): try both sides, else none.
          for (const lx of [S.laptopAt[0], -S.laptopAt[0]]) {
            if (b.routeClear([deskCand(d, 'laptop', lx, S.laptopAt[1])])) {
              onDesk(b, d, 'laptop', lx, S.laptopAt[1]);
              break;
            }
          }
        }
        if (!S.chairOmit.has(key)) {
          let cx = S.chairFixedX[key] ?? x + range(rng, -S.chairJitter, S.chairJitter);
          if (S.chairNoEastJitter.has(key)) cx = Math.min(cx, x);
          // Chairs keep doorway aprons, spawns and route probes clear (variety.md LV3/LV7/LV9): jittered spot, then the
          // desk's own x, else no chair (e.g. the NE perch desk's chair sits in door D8's apron).
          const cz = z + (row === 'N' ? -S.chairOffset : S.chairOffset);
          const rules = { gap: false, plateau: false, loot: false };
          for (const tx of [cx, x]) {
            const chair: Cand[] = [{ kind: 'chair', x: tx, y: 0, z: cz, step: step + 512 }];
            if (b.groupOk(chair, rules)) {
              b.commit(chair);
              break;
            }
          }
        }
      }
      if (colGone) continue;
      // Tunnel low cover (office.md §3.4): diagonal side and which corner gets which kind from the stream.
      const s = rng() < 0.5 ? 1 : -1;
      const swap = rng() < 0.5;
      const [kA, kB] = swap ? ['bookStack', 'boxSmall'] : ['boxSmall', 'bookStack'];
      b.add(kA, x + S.tunnelCover.small[0] * s, 0, bd.spine + S.tunnelCover.small[1] * s, 0);
      b.add(kB, x + S.tunnelCover.books[0] * s, 0, bd.spine + S.tunnelCover.books[1] * s, 0);
    }
    if (roll.column !== null) {
      const s = rng() < 0.5 ? 1 : -1;
      const x = colX(roll.id, roll.column);
      const group: Cand[] = D.deskBlocks.atriumCover.pieces.map((p) => ({
        kind: p.kind,
        x: x + parseFloat(p.at[0]) * s,
        y: 0,
        z: bd.spine + parseFloat(p.at[1]) * s,
        step: 0,
      }));
      if (b.groupOk(group, { gap: true, plateau: true, loot: false })) b.commit(group);
      else b.fallbacks++;
    }
  }
}

/** A desk-top placement as a candidate (world position, desk rotation + rel). */
function deskCand(d: DeskRec, kind: string, lx: number, lz: number, relStep = 0): Cand {
  const w = toWorld(deskFrame(d), lx, lz);
  return { kind, x: w.x, y: DESK_TOP, z: w.z, step: d.step + relStep };
}

function roomCands(v: RoomVariant, rng: Rng): Cand[] {
  const out: Cand[] = [];
  for (const p of v.pieces) {
    for (const [x, z] of p.place) {
      const step = p.rot === 'any' ? anyStep(rng) : Math.round(((p.rot ?? 0) / 360) * 1024);
      out.push({ kind: p.kind, x, y: 0, z, step: ((step % 1024) + 1024) % 1024 });
    }
  }
  return out;
}

function placeRooms(b: OfficeBuilder, rolls: OfficeRolls): void {
  for (const room of rolls.rooms) {
    const bi = baselineOf(room.zone.variants);
    const group = roomCands(room.zone.variants[room.variant]!, room.rng);
    if (room.variant === bi || b.groupOk(group, { gap: false, plateau: true, loot: false })) {
      b.commit(group);
      continue;
    }
    b.fallbacks++;
    room.variant = bi;
    b.commit(roomCands(room.zone.variants[bi]!, room.rng));
  }
}

function aisleCands(shape: AisleShape, slot: (typeof D.aisleClusters.slots)[number], x: number, z: number, rng: Rng): Cand[] {
  const pieces = shape.pieces.any ?? (slot.smalls === 'ns' ? shape.pieces.ns : shape.pieces.ew) ?? [];
  const out: Cand[] = pieces.map((p) => ({ kind: p.kind, x: x + p.at[0], y: 0, z: z + p.at[1], step: p.rot === 'any' ? anyStep(rng) : 0 }));
  if (shape.pieces.chair) out.push({ kind: 'chair', x: x + slot.chair[0], y: 0, z: z + slot.chair[1], step: anyStep(rng) });
  return out;
}

function placeAisle(b: OfficeBuilder, rolls: OfficeRolls): void {
  const J = D.aisleClusters.jitter;
  const shapes = D.aisleClusters.shapes;
  // The M2b clusters (4 placements each: box, 2 boxSmall, chair; slot order), the fallback: the fallback spawns were
  // nudged for exactly these placements, chair rotation included.
  const baseAisle = b.base.props.filter((_, i) => OFFICE_PROP_TAGS[i] === 'aisle');
  const cp = b.checkpoint();
  rolls.aisle.forEach((a, k) => {
    let done = false;
    for (let t = 0; t < J.tries && !done; t++) {
      const x = a.slot.centre[0] + (t === 0 ? 0 : range(a.rng, -J.x, J.x));
      const z = a.slot.centre[1] + (t === 0 ? 0 : range(a.rng, -J.z, J.z));
      const group = aisleCands(shapes[a.shape]!, a.slot, x, z, a.rng);
      if (b.groupOk(group, { gap: true, plateau: true, loot: false })) {
        b.commit(group);
        done = true;
      }
    }
    if (!done) {
      b.fallbacks++;
      a.shape = baselineOf(shapes);
      for (const p of baseAisle.slice(4 * k, 4 * k + 4)) b.addRaw(p);
    }
  });
  // The four clusters together must leave the main aisle crossable (LV8, run 4); else all four go back to M2b.
  if (!b.aislePassable()) {
    b.rollback(cp);
    b.fallbacks++;
    for (const a of rolls.aisle) a.shape = baselineOf(shapes);
    for (const p of baseAisle) b.addRaw(p);
  }
}

/** A loot candidate -> world point and height, or null when its desk or tunnel is gone this match. */
function resolveCand(b: OfficeBuilder, c: LootCand, removedCols: Set<string>): Vec3 | null {
  if (Array.isArray(c)) {
    const y = c.length > 2 ? (LEVEL_Y[c[2] as string] ?? 0) : 0;
    return { x: c[0] as number, y, z: c[1] as number };
  }
  const o = c as { desk?: string; at?: XZ; tunnel?: string };
  if (o.desk) {
    const d = b.desks.get(o.desk);
    if (!d || !o.at) return null;
    const w = toWorld(deskFrame(d), o.at[0], o.at[1]);
    return { x: w.x, y: DESK_TOP, z: w.z };
  }
  if (o.tunnel) {
    const [bid, k] = o.tunnel.split('.') as [BlockId, string];
    if (removedCols.has(o.tunnel)) return null;
    return { x: colX(bid, Number(k)), y: 0, z: blockDef(bid).spine };
  }
  return null;
}

function pickGroup(b: OfficeBuilder, tier: LootTier, id: string, cands: (Vec3 | null)[], pick: number, rng: Rng, guarantee: boolean, spare: Vec3[]): void {
  const live = shuffle(rng, cands.filter((c): c is Vec3 => c !== null));
  let got = 0;
  for (const c of live) {
    if (got >= pick) {
      spare.push(c);
      continue;
    }
    if (b.addLoot(c.x, c.y, c.z, tier, id, guarantee, RU.lootNudgeMax)) got++;
  }
  // Fallback (variety.md §3.2): unused candidates of the same tier from earlier groups.
  while (got < pick && spare.length > 0) {
    const c = spare.shift()!;
    if (b.addLoot(c.x, c.y, c.z, tier, id, guarantee, RU.lootNudgeMax)) {
      got++;
      b.fallbacks++;
    }
  }
}

function placeLoot(b: OfficeBuilder, rolls: OfficeRolls, seed: number): void {
  const removedCols = new Set<string>();
  for (const r of rolls.blocks) if (r.column !== null) removedCols.add(`${r.id}.${r.column}`);
  const LG = D.lootGroups;
  const spare: Record<LootTier, Vec3[]> = { epic: [], rare: [], common: [] };
  for (const g of LG.epic) pickGroup(b, 'epic', g.id, g.candidates.map((c) => resolveCand(b, c, removedCols)), g.pick, rngFor(seed, `loot:${g.id}`), false, spare.epic);
  for (const g of LG.guaranteedWeapons.regions) {
    pickGroup(b, 'common', g.id, g.candidates.map((c) => resolveCand(b, c, removedCols)), 1, rngFor(seed, `loot:${g.id}`), true, []);
  }
  const roomLoot = (id: string): Vec3[] => {
    const room = rolls.rooms.find((r) => r.zone.id === id);
    if (!room) return [];
    const specs = [...(room.zone.loot ?? []), ...(room.zone.variants[room.variant]!.loot ?? [])].filter((s) => s.tier === 'rare');
    return specs.flatMap((s) => s.place.map(([x, z]) => ({ x, y: 0, z })));
  };
  for (const g of LG.rare) {
    const cands: (Vec3 | null)[] = g.candidates.map((c) => resolveCand(b, c, removedCols));
    if (g.plusRoom) cands.push(...roomLoot(g.plusRoom));
    pickGroup(b, 'rare', g.id, cands, g.pick, rngFor(seed, `loot:${g.id}`), false, spare.rare);
  }
  for (const [roomId, pick] of Object.entries(LG.rareFromRooms)) {
    pickGroup(b, 'rare', `room.${roomId}`, roomLoot(roomId), pick, rngFor(seed, `loot:room.${roomId}`), false, spare.rare);
  }
  for (const g of LG.common) pickGroup(b, 'common', g.id, g.candidates.map((c) => resolveCand(b, c, removedCols)), g.pick, rngFor(seed, `loot:${g.id}`), false, spare.common);
}

/**
 * variety.md LV6: every fallback spawn has >= spawnLootMin.count loot points within spawnLootMin.within. Where the
 * random picks leave a spawn short, move one plain common (not guaranteed, not near a spawn that would then fall
 * short) to the nearest free common candidate of any common group within reach. Tier counts are unchanged.
 */
function ensureSpawnLoot(b: OfficeBuilder, rolls: OfficeRolls): void {
  const rule = (RU as unknown as { spawnLootMin: { count: number; within: number } }).spawnLootMin;
  const removedCols = new Set<string>();
  for (const r of rolls.blocks) if (r.column !== null) removedCols.add(`${r.id}.${r.column}`);
  const cands: { p: Vec3; group: string }[] = [];
  for (const g of D.lootGroups.common) {
    for (const c of g.candidates) {
      const p = resolveCand(b, c, removedCols);
      if (p) cands.push({ p, group: g.id });
    }
  }
  const spawns = b.base.playerSpawns;
  const near = (s: Vec2): number => b.loot.filter((l) => dist(l.x, l.z, s.x, s.z) <= rule.within).length;
  for (const s of spawns) {
    for (let guard = 0; near(s) < rule.count && guard < 4; guard++) {
      const reach = cands
        .filter((c) => dist(c.p.x, c.p.z, s.x, s.z) <= rule.within - 1)
        .sort((a, c) => dist(a.p.x, a.p.z, s.x, s.z) - dist(c.p.x, c.p.z, s.x, s.z));
      const victims = b.loot
        .map((l, i) => ({ l, i, served: spawns.filter((o) => dist(l.x, l.z, o.x, o.z) <= rule.within).length }))
        .filter((v) => v.l.tier === 'common' && !v.l.guarantee && v.served === 0);
      let moved = false;
      for (const v of victims) {
        for (const c of reach) {
          b.loot.splice(v.i, 1);
          if (b.addLoot(c.p.x, c.p.y, c.p.z, 'common', c.group, false, 1)) {
            moved = true;
            break;
          }
          b.loot.splice(v.i, 0, v.l);
        }
        if (moved) break;
      }
      if (!moved) break;
    }
  }
}

// ---- clutter scatter (wall bands, room corners) ----
const PLANT_R = 1.35;
const BOX_HX = 2.25;
const BOX_HZ = 1.8;
const SMALL_HX = 1.485;
const SMALL_HZ = 0.99;
const STACK_HX = 1.035;
const STACK_HZ = 1.35;

/** A wall-hugging item as candidates: `along` = position along the wall, local axes (u along, v into the room). */
function hugCands(kit: PropKit, kind: string, rng: Rng, place: (u: number, v: number) => P2, step: number): Cand[] | null {
  const fg = RU.flushGap;
  const at = (u: number, v: number, k: string): Cand => {
    const p = place(u, v);
    return { kind: k, x: p.x, y: 0, z: p.z, step };
  };
  if (kind === 'pottedPlant') return [at(0, PLANT_R + fg, 'pottedPlant')];
  if (kind === 'boxPair') {
    const side = rng() < 0.5 ? -1 : 1;
    return [at(0, BOX_HZ + fg, 'box'), at(side * (BOX_HX + SMALL_HX), SMALL_HZ + fg, 'boxSmall')];
  }
  if (kind === 'paperStack') {
    const n = rng() < 0.5 ? 1 : 2;
    const out: Cand[] = [];
    for (let j = 0; j < n; j++) out.push(at(j * 2 * STACK_HX, STACK_HZ + fg, 'bookStack'));
    return out;
  }
  if (kind === 'waterCooler') {
    if (!kit.waterCooler) return null;
    return [at(0, colliderHalf(kit, 'waterCooler')[1] + fg, 'waterCooler')];
  }
  return null;
}

/** Half extents (x, z) of a kit kind's colliders at scale 1, rotation 0 (flush placement uses colliders, not the drawing). */
function colliderHalf(kit: PropKit, kind: string): [number, number] {
  let hx = 0;
  let hz = 0;
  for (const c of kit[kind]?.colliders ?? []) {
    if (c.type === 'cylinder') {
      hx = Math.max(hx, Math.abs(c.x) + c.r);
      hz = Math.max(hz, Math.abs(c.z) + c.r);
    } else {
      hx = Math.max(hx, Math.abs(c.min[0]), Math.abs(c.max[0]));
      hz = Math.max(hz, Math.abs(c.min[2]), Math.abs(c.max[2]));
    }
  }
  return [hx, hz];
}

function placeWallBands(b: OfficeBuilder, seed: number): void {
  const z = D.scatter.find((s) => s.bands);
  if (!z || !z.bands) return;
  const rng = rngFor(seed, `scatter:${z.id}`);
  const kinds = (z.kinds ?? []).filter((k) => k.kind !== 'waterCooler' || b.base.kit.waterCooler);
  const mpi = z.metresPerItem ?? [15, 15];
  for (const band of z.bands) {
    const L = band.to - band.from;
    const count = Math.max(1, Math.round(L / range(rng, mpi[0], mpi[1])));
    const spacing = L / count;
    for (let i = 0; i < count; i++) {
      const u0 = band.from + (i + 0.5) * spacing + range(rng, -2, 2);
      const kind = kinds[pickWeighted(rng, kinds)]!.kind;
      // For a wall at constant z, along = x and the item rotation is 0; at constant x, along = z and rotation 90 deg.
      const step = band.wall === 'z' ? 0 : 256;
      const place = (u: number, v: number): P2 =>
        band.wall === 'z' ? { x: u0 + u, z: band.face + band.inward * v } : { x: band.face + band.inward * v, z: u0 + u };
      const group = hugCands(b.base.kit, kind, rng, place, step);
      if (group && b.groupOk(group, { gap: true, plateau: true, loot: true })) b.commit(group);
    }
  }
}

function roomFaces(r: { minX: number; maxX: number; minZ: number; maxZ: number }, floor: IndoorMapData['floor']): [number, number, number, number] {
  const face = (edge: number, f: number, sign: number): number => (Math.abs(edge - f) < 1e-6 ? edge : edge + sign * 0.45);
  return [face(r.minX, floor.minX, 1), face(r.minZ, floor.minZ, 1), face(r.maxX, floor.maxX, -1), face(r.maxZ, floor.maxZ, -1)];
}

function placeRoomCorners(b: OfficeBuilder, seed: number): void {
  const z = D.scatter.find((s) => s.themes);
  if (!z || !z.themes) return;
  const rng = rngFor(seed, `scatter:${z.id}`);
  const rooms = S.rooms as Record<string, { minX: number; maxX: number; minZ: number; maxZ: number }>;
  for (const [roomId, theme] of Object.entries(z.themes)) {
    const rect = rooms[roomId];
    if (!rect) continue;
    const kinds = theme.filter((k) => k !== 'waterCooler' || b.base.kit.waterCooler);
    if (kinds.length === 0) continue;
    const [fx0, fz0, fx1, fz1] = roomFaces(rect, b.base.floor);
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      if (rng() >= (z.fillChance ?? 0.5)) continue;
      const kind = kinds[Math.floor(rng() * kinds.length)]!;
      const fx = sx > 0 ? fx0 : fx1;
      const fz = sz > 0 ? fz0 : fz1;
      // u runs along x away from the x wall, v along z away from the z wall.
      const extraU =
        kind === 'boxPair' ? BOX_HX : kind === 'paperStack' ? STACK_HX : kind === 'pottedPlant' ? PLANT_R : colliderHalf(b.base.kit, kind)[0];
      const place = (u: number, v: number): P2 => ({ x: fx + sx * (extraU + RU.flushGap + Math.abs(u)), z: fz + sz * v });
      const group = hugCands(b.base.kit, kind, rng, place, 0);
      if (group && b.groupOk(group, { gap: true, plateau: true, loot: true })) b.commit(group);
    }
  }
}

// ---- desk-top clutter (office.md §3.3, after loot) ----
/**
 * Depth of the clutter-free walkway along each desk's front edge. 1.6 m leaves no room for an item between the walkway
 * and a desk-top loot spot's 1 m clear disc (Kettle Corner's loot sits 1.3 m behind the front band).
 */
const DESK_WALKWAY = 1.6;
function placeDeskClutter(b: OfficeBuilder, seed: number): void {
  const rng = rngFor(seed, 'dress:clutter');
  const kit = b.base.kit;
  const xLim = S.deskHalfW - S.deskEdgeMargin;
  const zLim = S.deskHalfD - S.deskEdgeMargin;
  const avoidLoot = b.loot.filter((l) => Math.abs((l.y ?? 0) - DESK_TOP) < 0.1);
  const avoidRoute = b.base.climbRoutes.flatMap((r) => r.points).filter((p) => Math.abs(p.y - DESK_TOP) < 0.5);
  const tryClutter = (d: DeskRec, kind: string): boolean => {
    const rotatable = kind.startsWith('plush') || kind === 'mug' || kind === 'waterBottle';
    for (let t = 0; t < 80; t++) {
      const quarter = Math.floor(rng() * 4) * 256;
      const rel = quarter + (rotatable ? Math.round(range(rng, -57, 57)) : 0);
      const lx = range(rng, -xLim, xLim);
      const lz = range(rng, -zLim, zLim);
      const bx = kindBox(kit, kind, rel, lx, lz);
      if (bx.x0 < -xLim || bx.x1 > xLim || bx.z0 < -zLim || bx.z1 > zLim) continue;
      // Front walkway (chair side, desk-local -Z): flush desks line it up into one path along each row, so clutter can
      // never cut a desk-top loot spot or a desk off its deck (test run 3).
      if (bx.z0 < -zLim + DESK_WALKWAY) continue;
      if (d.occ.some((o) => boxGap(o, bx) < S.clutterGap)) continue;
      const clear = (pts: readonly { x: number; z: number }[], r: number): boolean =>
        pts.every((p) => {
          const l = toLocal(deskFrame(d), p.x, p.z);
          return boxPointDist(bx, l.x, l.z) >= r;
        });
      if (!clear(avoidLoot, S.clutterLootClear) || !clear(avoidRoute, S.clutterRouteClear)) continue;
      // Route probes (perch approaches included) and, for boxes (a 9.36 m top), the 3-6 m plateau-gap ban.
      const cand = deskCand(d, kind, lx, lz, rel);
      if (!b.routeClear([cand])) continue;
      if (kind === 'box' && !b.plateauClear([cand])) continue;
      onDesk(b, d, kind, lx, lz, ((rel % 1024) + 1024) % 1024);
      d.items++;
      return true;
    }
    return false;
  };
  const kettle = b.desks.get('TL.S.0');
  if (kettle) for (const [kind, n] of S.kettleItems) for (let i = 0; i < n; i++) tryClutter(kettle, kind);
  const eligible = [...b.desks.values()].filter((d) => !'KP'.includes(d.code));
  for (const [kind, rr] of Object.entries(D.deskBlocks.dressing.deskClutter.counts)) {
    const n = intRange(rng, rr[0], rr[1]);
    for (let i = 0; i < n; i++) {
      const order = eligible
        .filter((d) => d.items < 3)
        .map((d) => ({ d, key: d.items + rng() * 0.5 }))
        .sort((p, q) => p.key - q.key);
      for (const { d } of order) if (tryClutter(d, kind)) break;
    }
  }
  // variety.md §5.1: every block deck keeps minFullCoverPerBlock full-height cover items (plush, box, laptop).
  // Counted from the placements on the block's deck area (the same rule LV15 checks), not from per-desk counters.
  // Exhaustive: smallest kind first (a laptop fits beside a keyboard; on BL's dual-monitor desks a plush does not),
  // every desk of the block (perch desks too, not Kettle Corner), no per-desk item cap (test run 4: BL was one short).
  const minFull = D.deskBlocks.dressing.deskClutter.minFullCoverPerBlock;
  const topUp = ['laptop', 'plushCrab', 'plushSeal', 'plushWhale', 'box'];
  for (const bd of D.deskBlocks.blocks) {
    const def = blockDef(bd.id);
    const x0 = def.x0 - S.col / 2;
    const x1 = def.x0 + S.col * (def.n - 1) + S.col / 2;
    const fullOnDeck = (): number =>
      b.props.filter((p) => FULL_COVER.has(p.kind) && Math.abs(p.y - DESK_TOP) < 0.05 && p.x > x0 && p.x < x1 && Math.abs(p.z - def.spine) < 2 * S.row).length;
    const desks = shuffle(rng, [...b.desks.values()].filter((d) => d.block === bd.id && d.code !== 'K'));
    let have = fullOnDeck();
    for (const kind of topUp) {
      for (const d of desks) {
        if (have >= minFull) break;
        if (tryClutter(d, kind)) have = fullOnDeck();
      }
    }
  }
}

// ---- decor and lights ----
function placeDecor(b: OfficeBuilder, seed: number): void {
  const f = b.base.floor;
  for (const z of D.decor) {
    const rng = rngFor(seed, `decor:${z.id}`);
    for (const k of z.kinds) {
      const n = intRange(rng, k.count[0], k.count[1]);
      const desks = [...b.desks.values()];
      for (let i = 0; i < n && b.decor.length < D.budgets.decorPlacementsMax; i++) {
        for (let t = 0; t < 20; t++) {
          const step = anyStep(rng);
          if (k.surface === 'deskTop') {
            if (desks.length === 0) break;
            const d = desks[Math.floor(rng() * desks.length)]!;
            const lx = range(rng, -S.deskHalfW + 0.5, S.deskHalfW - 0.5);
            const lz = range(rng, -S.deskHalfD + 0.5, S.deskHalfD - 0.5);
            if (d.occ.some((o) => boxPointDist(o, lx, lz) < 0.2)) continue;
            const w = toWorld(deskFrame(d), lx, lz);
            if (!b.decorOk(w.x, DESK_TOP, w.z)) continue;
            b.addDecor(k.kind, w.x, DESK_TOP, w.z, step);
            break;
          }
          const x = range(rng, f.minX + 1, f.maxX - 1);
          const zz = range(rng, f.minZ + 1, f.maxZ - 1);
          if (!b.decorOk(x, 0, zz)) continue;
          b.addDecor(k.kind, x, 0, zz, step);
          break;
        }
      }
    }
  }
  assignDecorVariants(b.decor, seed);
}

function lightsFor(b: OfficeBuilder, seed: number, look: string): number[] | undefined {
  if (look !== 'afterHours') return undefined;
  const panels: number[] = [];
  b.props.forEach((p, i) => {
    if (p.kind === 'lightPanel') panels.push(i);
  });
  const rng = rngFor(seed, 'look:lights');
  const [f0, f1] = D.look.afterHours.litFraction;
  const order = shuffle(rng, [...panels]);
  const lit = new Set(order.slice(0, Math.ceil(range(rng, f0, f1) * panels.length)));
  // Coverage: every panel has a lit panel within 16.5 m (one panel pitch), so every floor point is within about 20 m.
  for (const i of panels) {
    if (lit.has(i)) continue;
    const p = b.props[i]!;
    let ok = false;
    for (const j of lit) {
      const q = b.props[j]!;
      if (dist(p.x, p.z, q.x, q.z) <= 16.5) {
        ok = true;
        break;
      }
    }
    if (!ok) lit.add(i);
  }
  return [...lit].sort((a, c) => a - c);
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------
export interface OfficeLayoutParts {
  props: IndoorPropPlacement[];
  lootSpawns: LootSpawn[];
  picks: LayoutPick[];
  decor: DecorPlacement[];
  fallbacks: number;
  look: string;
  lightsOn?: number[];
  /** Number of leading `props` entries that are the fixed (M2b 'fixed'-tagged) placements. */
  fixedCount: number;
}

function checkBase(base: IndoorMapData): void {
  if (base.props.length !== OFFICE_PROP_TAGS.length) {
    throw new Error(`office layout: base map has ${base.props.length} props, OFFICE_PROP_TAGS has ${OFFICE_PROP_TAGS.length}`);
  }
}

/** Baseline guaranteed-weapon flags: per region, the base common floor point nearest (worst case) to its spawns. */
function baselineLoot(base: IndoorMapData): LootSpawn[] {
  const loot: LootSpawn[] = base.lootSpawns.map((l) => ({ ...l, group: 'baseline' }));
  for (const region of D.lootGroups.guaranteedWeapons.regions) {
    const spawns: Vec2[] = region.spawns.map((n) => base.playerSpawns[n - 1]!).filter(Boolean);
    let best = -1;
    let bestD = Infinity;
    loot.forEach((l, i) => {
      if (l.tier !== 'common' || l.guarantee || l.y !== undefined) return;
      let worst = 0;
      for (const s of spawns) worst = Math.max(worst, dist(l.x, l.z, s.x, s.z));
      if (worst < bestD) {
        bestD = worst;
        best = i;
      }
    });
    if (best >= 0) loot[best] = { ...loot[best]!, guarantee: 'weapon' };
  }
  return loot;
}

export function buildOfficeLayout(base: IndoorMapData, seed: number, opts: { decor: boolean }): OfficeLayoutParts {
  checkBase(base);
  const b = new OfficeBuilder(base);
  if (seed === 0) {
    for (const p of base.props) b.addRaw(p);
    b.fixedCount = OFFICE_PROP_TAGS.filter((t) => t === 'fixed').length;
    b.loot.push(...baselineLoot(base));
    const look = pickLook(0, D.look.presets);
    if (opts.decor) placeDecor(b, 0);
    return { props: b.props, lootSpawns: b.loot, picks: officePicks(rollOffice(0)), decor: b.decor, fallbacks: 0, look, fixedCount: b.fixedCount };
  }
  base.props.forEach((p, i) => {
    if (OFFICE_PROP_TAGS[i] === 'fixed') b.addRaw(p);
  });
  b.fixedCount = b.props.length;
  const rolls = rollOffice(seed);
  placeBlocks(b, rolls, seed);
  placeRooms(b, rolls);
  placeAisle(b, rolls);
  placeLoot(b, rolls, seed);
  ensureSpawnLoot(b, rolls);
  placeWallBands(b, seed);
  placeRoomCorners(b, seed);
  placeDeskClutter(b, seed);
  const look = pickLook(seed, D.look.presets);
  if (opts.decor) placeDecor(b, seed);
  const lightsOn = opts.decor ? lightsFor(b, seed, look) : undefined;
  const parts: OfficeLayoutParts = { props: b.props, lootSpawns: b.loot, picks: officePicks(rolls), decor: b.decor, fallbacks: b.fallbacks, look, fixedCount: b.fixedCount };
  if (lightsOn) parts.lightsOn = lightsOn;
  return parts;
}

/** Exposed for tests. */
export const OFFICE_ROUND = roundMm;
