/**
 * M2c per-match layout for island01 (docs/design/levels/variety.md §4; data ../variety/island01.variety.json).
 * Owner: level-designer. Pure and deterministic (ADR 0007 §1.4): decisions use detmath and Math.sqrt only.
 *
 * Order (variety.md §3.1): fixed landmarks -> each POI's arrangement structure (stream `arr:<poi>`) -> loot
 * (`loot:<group>`) -> arrangement fill and scatter zones (`scatter:<id>`) -> decor (`decor:<id>`, client only) -> look.
 * Seed 0 is the baseline: the M2b props and loot positions unchanged (plus guaranteed-weapon flags), baseline picks.
 */
import data from '../variety/island01.variety.json';
import { degToStep, detCos, detSin, radToStep, roundMm } from '../../../shared/detmath';
import { DECOR_VARIANTS, isDecorKind } from '../../../shared/kits/decor';
import { ISLAND_VARIANTS } from '../../../shared/kits/island';
import { GRASS_PATCH_RADIUS } from '../../../shared/grass';
import type { DecorPlacement, IslandMapData, LayoutPick, LootSpawn, LootTier, PropKind, PropPlacement } from '../../../shared/types';
import {
  BoundsGrid,
  DECOR_KINDS,
  type Frame,
  type LookPreset,
  type LootSpec,
  type NumOrRange,
  type P2,
  type PieceSpec,
  type Range2,
  type Rng,
  type VariantSpec,
  anyStep,
  bearing,
  cm,
  countOf,
  dist,
  intRange,
  len,
  mm,
  nudgeSearch,
  pickLook,
  pickWeighted,
  polarDeg,
  range,
  ringPoints,
  rngFor,
  rotOfStep,
  scaleOf,
  scatterPoint,
  shuffle,
  stepToward,
  toLocal,
  toWorld,
  worldStep,
} from './grammar';

// ---------------------------------------------------------------------------------------------
// Data shapes (island01.variety.json)
// ---------------------------------------------------------------------------------------------
type TierPick = Partial<Record<LootTier, number>>;
interface IslandZone {
  id: string;
  anchor: { x?: number; z?: number; polar?: Range2 };
  radius: number;
  frame: 'outward' | 'quarter' | 'any';
  mirror: boolean;
  aprons?: readonly { note?: string; rect: readonly [number, number, number, number] }[];
  lootPick: TierPick;
  loot?: readonly LootSpec[];
  variants: readonly VariantSpec[];
}
interface ScatterKind {
  kind: string;
  count?: NumOrRange;
  scale?: NumOrRange;
  near?: { kind: string; within: number };
}
interface ScatterZone {
  id: string;
  layer: 'sim' | 'decor';
  order?: number;
  rule?: 'clusters';
  clusters?: { n: number; centreJitterDeg: number; r: Range2; clusterRadius: number; perCluster: Range2 };
  area?: { annulus?: Range2; sectorDeg?: Range2 };
  minus?: readonly string[];
  kinds: readonly ScatterKind[];
}
interface IslandVariety {
  look: { presets: readonly LookPreset[] };
  fixed: readonly PieceSpec[];
  zones: readonly IslandZone[];
  lootGroups: readonly {
    id: string;
    rule?: 'ringGaps';
    candidatesPerGap?: readonly (readonly [number, number])[];
    lootPick?: TierPick;
    candidates?: readonly { tier: LootTier; polar: Range2 }[];
  }[];
  lootTotals: { common: number; rare: number; epic: number; guaranteedWeapons: number };
  scatter: readonly ScatterZone[];
  decor: readonly ScatterZone[];
  rules: {
    propGap: number;
    spawnPad: number;
    lootPropClearance: number;
    lootSpacing: number;
    lootNudgeMax: number;
    lootMaxRadius: number;
    zoneCentreClear: number;
    landLimit: number;
    decorPropClearance: number;
    decorLootSpawnClearance: number;
    decorSpacing: number;
    pieceTries: number;
    scatterTriesPerItem: number;
  };
  budgets: { simPlacementsMax: number; perKindMax: Record<string, number>; decorPlacementsMax: number; decorPerKindMax: number };
}
export const ISLAND_VARIETY = data as unknown as IslandVariety;
const D = ISLAND_VARIETY;
const R = D.rules;

// ---------------------------------------------------------------------------------------------
// Footprints (island.md "Props and performance"; island.ts propFootprint, here with the deterministic table)
// ---------------------------------------------------------------------------------------------
export interface Circle {
  x: number;
  z: number;
  r: number;
}
const FOOT_R: Record<PropKind, number> = {
  palm: 0.45, rock: 1.5, bush: 0.9, crate: 0.75, hut: 2.9, dock: 7.2, umbrella: 1.2, boat: 2.0, tikiTorch: 0.25, driftwood: 1.2,
  grass: GRASS_PATCH_RADIUS,
};
/** Largest single footprint circle a layout can hold (hut at scale 1.2; grass at scale <= 1.4 is 3.5), for grid query padding. */
const MAX_CIRCLE_R = 3.6;
const WORLD_EDGE = 188; // docks: worldRadius - 2
/** Beach ring (island.ts SPAWN_COUNT): 36 spawns at 5 + 10k deg, so gap k (between spawns k and k + 1) is at 10 + 10k deg. */
const RING_GAPS = 36;
const GAP_STEP_DEG = 360 / RING_GAPS;
const gapDeg = (k: number): number => GAP_STEP_DEG * (k + 1);
/** Radius of the beach-loot fallback point in each gap. */
const GAP_LOOT_R = 152;
/** Long Beach (north sand, 330-30 deg) starts at this radius. */
const LONG_BEACH_R = 143;
const HUT_HALF = 2.05;
const HUT_APRON = 1.5;

/** Layout footprint circles of a placement (deterministic; local +Z = (sin, cos) of the rotation step). */
export function islandFootprint(kind: PropKind, x: number, z: number, step: number, scale: number): Circle[] {
  const ax = detSin(step);
  const az = detCos(step);
  const along = (offs: readonly number[], r: number): Circle[] => offs.map((o) => ({ x: x + ax * o * scale, z: z + az * o * scale, r: r * scale }));
  if (kind === 'dock') return along([-5.6, -2.8, 0, 2.8, 5.6], 1.6);
  if (kind === 'boat') return along([-1, 1], 1.0);
  if (kind === 'driftwood') return along([-0.6, 0.6], 0.6);
  return [{ x, z, r: FOOT_R[kind] * scale }];
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------
interface Apron {
  frame: Frame;
  rect: readonly [number, number, number, number];
}

class IslandBuilder {
  readonly props: PropPlacement[] = [];
  readonly steps: number[] = [];
  readonly circles: (Circle & { prop: number })[] = [];
  private grid = new BoundsGrid(8);
  readonly loot: LootSpawn[] = [];
  readonly decor: DecorPlacement[] = [];
  private readonly decorGrid = new BoundsGrid(4);
  readonly hutDoors: P2[] = [];
  readonly counts = new Map<string, number>();
  fallbacks = 0;
  readonly aprons: Apron[] = [];

  constructor(readonly base: IslandMapData) {}

  private addCircles(cs: Circle[], prop: number): void {
    for (const c of cs) {
      const i = this.circles.length;
      this.circles.push({ ...c, prop });
      this.grid.add(i, c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r);
    }
  }

  /** Adds without any rule check (fixed landmarks, the baseline map). Values are rounded first. */
  force(kind: PropKind, x: number, z: number, step: number, scale: number): PropPlacement {
    const p: PropPlacement = { kind, x: mm(x), z: mm(z), rotY: rotOfStep(step), scale: cm(scale) };
    const idx = this.props.length;
    this.props.push(p);
    this.steps.push(step);
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    this.addCircles(islandFootprint(kind, p.x, p.z, step, p.scale), idx);
    if (kind === 'hut') {
      const d = HUT_HALF * p.scale + HUT_APRON;
      this.hutDoors.push({ x: p.x + d * detSin(step), z: p.z + d * detCos(step) });
    }
    return p;
  }

  checkpoint(): { props: number; circles: number; doors: number } {
    return { props: this.props.length, circles: this.circles.length, doors: this.hutDoors.length };
  }

  rollback(cp: { props: number; circles: number; doors: number }): void {
    for (let i = cp.props; i < this.props.length; i++) {
      const k = this.props[i]!.kind;
      this.counts.set(k, (this.counts.get(k) ?? 1) - 1);
    }
    this.props.length = cp.props;
    this.steps.length = cp.props;
    this.circles.length = cp.circles;
    this.hutDoors.length = cp.doors;
    this.grid = new BoundsGrid(8);
    this.circles.forEach((c, i) => this.grid.add(i, c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r));
  }

  private budgetOk(kind: string): boolean {
    if (this.props.length >= D.budgets.simPlacementsMax) return false;
    const cap = D.budgets.perKindMax[kind];
    return cap === undefined || (this.counts.get(kind) ?? 0) < cap;
  }

  /** variety.md §4.1 rules for one placement (already rounded). */
  fits(kind: PropKind, x: number, z: number, step: number, scale: number): boolean {
    if (!this.budgetOk(kind)) return false;
    for (const c of islandFootprint(kind, x, z, step, scale)) {
      const outer = len(c.x, c.z) + c.r;
      if (kind === 'dock' ? outer > WORLD_EDGE : outer > R.landLimit) return false;
      const pad = c.r + R.propGap + MAX_CIRCLE_R;
      let hit = false;
      this.grid.query(c.x - pad, c.z - pad, c.x + pad, c.z + pad, (i) => {
        const o = this.circles[i]!;
        if (dist(c.x, c.z, o.x, o.z) < c.r + o.r + R.propGap) {
          hit = true;
          return true;
        }
        return false;
      });
      if (hit) return false;
      for (const s of this.base.playerSpawns) if (dist(c.x, c.z, s.x, s.z) < c.r + R.spawnPad) return false;
      for (const s of this.base.zoneCenters) if (dist(c.x, c.z, s.x, s.z) < c.r + R.zoneCentreClear) return false;
      for (const l of this.loot) if (dist(c.x, c.z, l.x, l.z) < c.r + R.lootPropClearance) return false;
      for (const d of this.hutDoors) if (dist(c.x, c.z, d.x, d.z) < c.r + HUT_APRON) return false;
      for (const a of this.aprons) {
        const l = toLocal(a.frame, c.x, c.z);
        if (l.x > a.rect[0] - c.r && l.x < a.rect[2] + c.r && l.z > a.rect[1] - c.r && l.z < a.rect[3] + c.r) return false;
      }
    }
    if (kind === 'hut') {
      const d = HUT_HALF * scale + HUT_APRON;
      const door = { x: x + d * detSin(step), z: z + d * detCos(step) };
      const pad = HUT_APRON + MAX_CIRCLE_R;
      let hit = false;
      this.grid.query(door.x - pad, door.z - pad, door.x + pad, door.z + pad, (i) => {
        const o = this.circles[i]!;
        if (dist(door.x, door.z, o.x, o.z) < o.r + HUT_APRON) {
          hit = true;
          return true;
        }
        return false;
      });
      if (hit) return false;
    }
    return true;
  }

  tryAdd(kind: PropKind, x: number, z: number, step: number, scale: number): boolean {
    const px = mm(x);
    const pz = mm(z);
    const ps = cm(scale);
    if (!this.fits(kind, px, pz, step, ps)) return false;
    this.force(kind, px, pz, step, ps);
    return true;
  }

  // ---- loot ----
  lootFits(x: number, z: number): boolean {
    if (len(x, z) > R.lootMaxRadius) return false;
    const pad = R.lootPropClearance + MAX_CIRCLE_R;
    let hit = false;
    this.grid.query(x - pad, z - pad, x + pad, z + pad, (i) => {
      const o = this.circles[i]!;
      if (dist(x, z, o.x, o.z) < o.r + R.lootPropClearance) {
        hit = true;
        return true;
      }
      return false;
    });
    if (hit) return false;
    for (const l of this.loot) if (dist(x, z, l.x, l.z) < R.lootSpacing) return false;
    return true;
  }

  /** Nudged add (<= maxR); returns the spawn or null. */
  addLootNear(x: number, z: number, tier: LootTier, group: string, maxR: number, guarantee = false): LootSpawn | null {
    const p = nudgeSearch(mm(x), mm(z), maxR, (px, pz) => this.lootFits(px, pz));
    if (!p) return null;
    const l: LootSpawn = guarantee ? { x: p.x, z: p.z, tier, group, guarantee: 'weapon' } : { x: p.x, z: p.z, tier, group };
    this.loot.push(l);
    return l;
  }

  // ---- decor ----
  decorFits(x: number, z: number): boolean {
    const pad = R.decorPropClearance + MAX_CIRCLE_R;
    let hit = false;
    this.grid.query(x - pad, z - pad, x + pad, z + pad, (i) => {
      const o = this.circles[i]!;
      if (dist(x, z, o.x, o.z) < o.r + R.decorPropClearance) {
        hit = true;
        return true;
      }
      return false;
    });
    if (hit) return false;
    for (const l of this.loot) if (dist(x, z, l.x, l.z) < R.decorLootSpawnClearance) return false;
    for (const s of this.base.playerSpawns) if (dist(x, z, s.x, s.z) < R.decorLootSpawnClearance) return false;
    const sp = R.decorSpacing;
    this.decorGrid.query(x - sp, z - sp, x + sp, z + sp, (i) => {
      const o = this.decor[i]!;
      if (dist(x, z, o.x, o.z) < sp) {
        hit = true;
        return true;
      }
      return false;
    });
    return !hit;
  }

  addDecor(kind: string, x: number, z: number, step: number, scale: number): void {
    const i = this.decor.length;
    this.decor.push({ kind, x: mm(x), y: 0, z: mm(z), rotY: rotOfStep(step), scale: cm(scale) });
    this.decorGrid.add(i, x, z, x, z);
  }
}

// ---------------------------------------------------------------------------------------------
// Zones: rolls, frames, pieces
// ---------------------------------------------------------------------------------------------
interface Anchor extends P2 {
  outStep: number;
}
function anchorOf(z: IslandZone): Anchor {
  if (z.anchor.polar) {
    const [deg, r] = z.anchor.polar;
    const p = polarDeg(deg, r);
    return { x: p.x, z: p.z, outStep: degToStep(180 - deg) };
  }
  return { x: z.anchor.x ?? 0, z: z.anchor.z ?? 0, outStep: 0 };
}
const baselineIndex = (vs: readonly VariantSpec[]): number => Math.max(0, vs.findIndex((v) => v.baseline));

export interface IslandRoll {
  zone: IslandZone;
  variant: number;
  frame: Frame;
  rng: Rng;
}

/** The variant roll of every POI (variety.md §2.2: the first draws of `arr:<poi>`). Cheap; used by pickVariants. */
export function rollIsland(seed: number): IslandRoll[] {
  return D.zones.map((z) => {
    const rng = rngFor(seed, `arr:${z.id}`);
    const a = anchorOf(z);
    if (seed === 0) return { zone: z, variant: baselineIndex(z.variants), frame: { x: a.x, z: a.z, step: z.frame === 'outward' ? a.outStep : 0, mirror: false }, rng };
    const variant = pickWeighted(rng, z.variants);
    let step = 0;
    if (z.frame === 'outward') step = a.outStep;
    else if (z.frame === 'quarter') step = intRange(rng, 0, 3) * 256;
    else step = anyStep(rng);
    const mirror = z.mirror && rng() < 0.5;
    return { zone: z, variant, frame: { x: a.x, z: a.z, step, mirror }, rng };
  });
}

export function islandPicks(rolls: readonly IslandRoll[]): LayoutPick[] {
  return rolls.map((r) => {
    const params: Record<string, number> = {};
    if (r.zone.frame !== 'outward') params.turn = r.frame.step;
    if (r.frame.mirror) params.mirror = 1;
    const v = r.zone.variants[r.variant]!.id;
    return Object.keys(params).length > 0 ? { zone: r.zone.id, variant: v, params } : { zone: r.zone.id, variant: v };
  });
}

interface Item {
  kind: PropKind;
  lx: number;
  lz: number;
  scale: number;
  /** Local rotation step, or a world step when `world` is set. */
  rot: (lx: number, lz: number, w: P2) => number;
}

interface Ctx {
  hull: P2;
}

function rotFn(piece: PieceSpec, f: Frame, rng: Rng, ctx: Ctx, ringDeg?: number, lineStep?: number): Item['rot'] {
  const r = piece.rot;
  if (typeof r === 'number') {
    const s = worldStep(f, degToStep(r));
    return () => s;
  }
  if (r === 'any') {
    const s = anyStep(rng);
    return () => s;
  }
  if (r === 'face') return (lx, lz) => worldStep(f, stepToward(-lx, -lz));
  if (r === 'away') return (lx, lz) => worldStep(f, stepToward(lx, lz));
  if (r === 'tangent') {
    const s = ringDeg === undefined ? anyStep(rng) : worldStep(f, degToStep(ringDeg + 90));
    return () => s;
  }
  if (r === 'along') {
    const s = worldStep(f, lineStep ?? 0);
    return () => s;
  }
  if (r === 'faceHull') return (_lx, _lz, w) => stepToward(ctx.hull.x - w.x, ctx.hull.z - w.z);
  const s = worldStep(f, 0);
  return () => s;
}

/** Structure items of a non-scatter piece, in data order (draws scale and 'any' rotations up front). */
function expandPiece(piece: PieceSpec, f: Frame, rng: Rng, ctx: Ctx): Item[] {
  const kind = piece.kind as PropKind;
  const out: Item[] = [];
  const push = (lx: number, lz: number, ringDeg?: number, lineStep?: number): void => {
    out.push({ kind, lx, lz, scale: scaleOf(rng, piece.scale), rot: rotFn(piece, f, rng, ctx, ringDeg, lineStep) });
  };
  const jit = (): P2 => {
    const j = piece.jitter ?? 0;
    if (j <= 0) return { x: 0, z: 0 };
    return bearing(range(rng, 0, 360), j * Math.sqrt(rng()));
  };
  if (piece.at) {
    const j = jit();
    push(piece.at[0] + j.x, piece.at[1] + j.z);
  }
  for (const p of piece.place ?? []) {
    const j = jit();
    push(p[0] + j.x, p[1] + j.z);
  }
  if (piece.ring) for (const { p, deg } of ringPoints(rng, piece.ring)) push(p.x, p.z, deg);
  if (piece.grid) {
    for (const x of piece.grid.x) {
      for (const z of piece.grid.z) {
        const j = jit();
        push(x + j.x, z + j.z);
      }
    }
  }
  if (piece.line) {
    const { from, to, n } = piece.line;
    const ls = stepToward(to[0] - from[0], to[1] - from[1]);
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const jr = piece.line.jitter ?? 0;
      const j = jr > 0 ? bearing(range(rng, 0, 360), jr * Math.sqrt(rng())) : { x: 0, z: 0 };
      push(from[0] + (to[0] - from[0]) * t + j.x, from[1] + (to[1] - from[1]) * t + j.z, undefined, ls);
    }
  }
  if (piece.cluster) {
    const a = piece.cluster.spacing / Math.sqrt(3);
    for (const { p } of ringPoints(rng, piece.cluster.centres.ring)) {
      const turn = range(rng, 0, 120);
      for (let i = 0; i < piece.cluster.n; i++) {
        const o = bearing(turn + (360 / piece.cluster.n) * i, a);
        push(p.x + o.x, p.z + o.z);
      }
    }
  }
  return out;
}

/** Place one structure item: the nominal spot, then jittered tries growing to 2 m. */
function placeItem(b: IslandBuilder, it: Item, f: Frame, rng: Rng): boolean {
  const tries = R.pieceTries;
  for (let t = 0; t < tries; t++) {
    let lx = it.lx;
    let lz = it.lz;
    if (t > 0) {
      const o = bearing(range(rng, 0, 360), ((2 * t) / tries) * Math.sqrt(rng()));
      lx += o.x;
      lz += o.z;
    }
    const w = toWorld(f, lx, lz);
    if (b.tryAdd(it.kind, w.x, w.z, it.rot(lx, lz, w), it.scale)) return true;
  }
  return false;
}

/** Scatter piece: up to n items, each with scatterTriesPerItem random tries. Shortfall is allowed. */
function placeScatter(b: IslandBuilder, piece: PieceSpec, f: Frame, rng: Rng): void {
  const s = piece.scatter!;
  const n = countOf(rng, s.n);
  const kind = piece.kind as PropKind;
  for (let i = 0; i < n; i++) {
    for (let t = 0; t < R.scatterTriesPerItem; t++) {
      const p = scatterPoint(rng, s);
      const scale = scaleOf(rng, piece.scale);
      const localRot = piece.rot === 'any' || piece.rot === undefined ? -1 : typeof piece.rot === 'number' ? degToStep(piece.rot) : -1;
      const step = localRot < 0 ? anyStep(rng) : worldStep(f, localRot);
      if (!p) continue;
      const w = toWorld(f, p.x, p.z);
      if (b.tryAdd(kind, w.x, w.z, step, scale)) break;
    }
  }
}

/** Structure of one variant. Returns false (and rolls back) when a required piece cannot be placed. */
function placeStructure(b: IslandBuilder, roll: IslandRoll, vi: number, baselineMode: boolean, ctx: Ctx): boolean {
  const cp = b.checkpoint();
  const v = roll.zone.variants[vi]!;
  for (const piece of v.pieces ?? []) {
    if (piece.fill) continue;
    if (piece.scatter) {
      placeScatter(b, piece, roll.frame, roll.rng);
      continue;
    }
    for (const it of expandPiece(piece, roll.frame, roll.rng, ctx)) {
      if (placeItem(b, it, roll.frame, roll.rng)) continue;
      if (piece.optional) continue;
      if (baselineMode) {
        b.fallbacks++;
        continue;
      }
      b.rollback(cp);
      return false;
    }
  }
  return true;
}

function placeFill(b: IslandBuilder, roll: IslandRoll, rng: Rng, ctx: Ctx): void {
  const v = roll.zone.variants[roll.variant]!;
  for (const piece of v.pieces ?? []) {
    if (!piece.fill) continue;
    if (piece.scatter) placeScatter(b, piece, roll.frame, rng);
    else for (const it of expandPiece(piece, roll.frame, rng, ctx)) placeItem(b, it, roll.frame, rng);
  }
}

/** Loot specs -> world candidates by tier. */
function lootCandidates(specs: readonly LootSpec[], f: Frame, rng: Rng): Record<LootTier, P2[]> {
  const out: Record<LootTier, P2[]> = { common: [], rare: [], epic: [] };
  for (const s of specs) {
    const list = out[s.tier];
    if (s.at) list.push(toWorld(f, s.at[0], s.at[1]));
    for (const p of s.place ?? []) list.push(toWorld(f, p[0], p[1]));
    if (s.ring) for (const { p } of ringPoints(rng, s.ring)) list.push(toWorld(f, p.x, p.z));
    if (s.polar) list.push(polarDeg(s.polar[0], s.polar[1]));
  }
  return out;
}

const TIERS: readonly LootTier[] = ['epic', 'rare', 'common'];

function pickZoneLoot(b: IslandBuilder, roll: IslandRoll, rng: Rng): void {
  const z = roll.zone;
  const specs = [...(z.loot ?? []), ...(z.variants[roll.variant]!.loot ?? [])];
  const cands = lootCandidates(specs, roll.frame, rng);
  for (const tier of TIERS) {
    const k = z.lootPick[tier] ?? 0;
    let got = 0;
    for (const c of shuffle(rng, cands[tier])) {
      if (got >= k) break;
      if (b.addLootNear(c.x, c.z, tier, z.id, R.lootNudgeMax)) got++;
    }
    // Fallback (variety.md §3.2): a random point of the POI disc, as in M2b.
    for (let t = 0; got < k && t < 400; t++) {
      const o = bearing(range(rng, 0, 360), z.radius * 0.9 * Math.sqrt(rng()));
      if (b.addLootNear(roll.frame.x + o.x, roll.frame.z + o.z, tier, z.id, 0)) {
        got++;
        b.fallbacks++;
      }
    }
  }
}

function pickBeachLoot(b: IslandBuilder, seed: number): void {
  const g = D.lootGroups.find((q) => q.rule === 'ringGaps')!;
  const rng = rngFor(seed, `loot:${g.id}`);
  const phase = rng() < 0.5 ? 0 : 1;
  for (let k = 0; k < RING_GAPS; k++) {
    const gap = gapDeg(k);
    const big = (k + phase) % 2 === 0;
    const group = `${g.id}.g${String(k).padStart(2, '0')}`;
    const cands = shuffle(rng, (g.candidatesPerGap ?? []).map(([off, r]) => polarDeg(gap + off, r)));
    const want = big ? 2 : 1;
    let got = 0;
    for (const c of cands) {
      if (got >= want) break;
      if (b.addLootNear(c.x, c.z, 'common', group, R.lootNudgeMax, big && got === 0)) got++;
    }
    while (got < want) {
      const c = polarDeg(gap, GAP_LOOT_R);
      if (!b.addLootNear(c.x, c.z, 'common', group, 8, big && got === 0)) break;
      got++;
      b.fallbacks++;
    }
  }
}

function pickInlandLoot(b: IslandBuilder, seed: number): void {
  for (const g of D.lootGroups) {
    if (g.rule === 'ringGaps' || !g.candidates) continue;
    const rng = rngFor(seed, `loot:${g.id}`);
    for (const tier of TIERS) {
      const k = g.lootPick?.[tier] ?? 0;
      let got = 0;
      const cands = shuffle(rng, g.candidates.filter((c) => c.tier === tier).map((c) => polarDeg(c.polar[0], c.polar[1])));
      for (const c of cands) {
        if (got >= k) break;
        if (b.addLootNear(c.x, c.z, tier, g.id, R.lootNudgeMax)) got++;
      }
      for (const c of cands) {
        if (got >= k) break;
        if (b.addLootNear(c.x, c.z, tier, g.id, 8)) {
          got++;
          b.fallbacks++;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scatter zones and decor
// ---------------------------------------------------------------------------------------------
function areaPoint(rng: Rng, area: NonNullable<ScatterZone['area']>): { p: P2; deg: number; r: number } {
  let deg: number;
  if (area.sectorDeg) {
    const [a, c] = area.sectorDeg;
    const span = (((c - a) % 360) + 360) % 360;
    deg = a + range(rng, 0, span);
  } else deg = range(rng, 0, 360);
  const [r0, r1] = area.annulus ?? [0, 100];
  const r = Math.sqrt(range(rng, r0 * r0, r1 * r1));
  return { p: polarDeg(deg, r), deg: ((deg % 360) + 360) % 360, r };
}

function minusHit(b: IslandBuilder, minus: readonly string[] | undefined, p: P2, deg: number, r: number): boolean {
  for (const m of minus ?? []) {
    if (m === 'longBeach' && (deg >= 330 || deg <= 30) && r >= LONG_BEACH_R) return true;
    if (m === 'poiDiscs' || m === 'poiDiscs+2') {
      const extra = m === 'poiDiscs+2' ? 2 : 0;
      for (const poi of b.base.pois) if (dist(p.x, p.z, poi.x, poi.z) < poi.radius + extra) return true;
    }
  }
  return false;
}

function placeScatterZone(b: IslandBuilder, z: ScatterZone, seed: number): void {
  const rng = rngFor(seed, `scatter:${z.id}`);
  if (z.rule === 'clusters' && z.clusters) {
    const c = z.clusters;
    const k0 = z.kinds[0]!;
    for (let k = 0; k < c.n; k++) {
      const centre = polarDeg(GAP_STEP_DEG * k + range(rng, -c.centreJitterDeg, c.centreJitterDeg), range(rng, c.r[0], c.r[1]));
      const n = intRange(rng, c.perCluster[0], c.perCluster[1]);
      for (let i = 0; i < n; i++) {
        for (let t = 0; t < 15; t++) {
          const o = bearing(range(rng, 0, 360), c.clusterRadius * Math.sqrt(rng()));
          if (b.tryAdd(k0.kind as PropKind, centre.x + o.x, centre.z + o.z, anyStep(rng), scaleOf(rng, k0.scale))) break;
        }
      }
    }
    return;
  }
  for (const k of z.kinds) {
    const n = countOf(rng, k.count ?? 0);
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < R.scatterTriesPerItem; t++) {
        const a = areaPoint(rng, z.area ?? {});
        const step = anyStep(rng);
        const scale = scaleOf(rng, k.scale);
        if (minusHit(b, z.minus, a.p, a.deg, a.r)) continue;
        if (b.tryAdd(k.kind as PropKind, a.p.x, a.p.z, step, scale)) break;
      }
    }
  }
}

function placeDecor(b: IslandBuilder, seed: number): void {
  const perKind = new Map<string, number>();
  for (const z of D.decor) {
    const rng = rngFor(seed, `decor:${z.id}`);
    for (const k of z.kinds) {
      if (!(DECOR_KINDS as readonly string[]).includes(k.kind)) continue;
      const anchors = k.near ? b.props.filter((p) => p.kind === k.near!.kind) : [];
      const n = countOf(rng, k.count ?? 0);
      for (let i = 0; i < n; i++) {
        if (b.decor.length >= D.budgets.decorPlacementsMax || (perKind.get(k.kind) ?? 0) >= D.budgets.decorPerKindMax) break;
        for (let t = 0; t < 20; t++) {
          let p: P2;
          if (k.near) {
            if (anchors.length === 0) break;
            const a = anchors[Math.floor(rng() * anchors.length)]!;
            const o = bearing(range(rng, 0, 360), k.near.within * Math.sqrt(rng()));
            p = { x: a.x + o.x, z: a.z + o.z };
          } else p = areaPoint(rng, z.area ?? {}).p;
          const step = anyStep(rng);
          const scale = range(rng, 0.8, 1.2);
          if (!b.decorFits(p.x, p.z)) continue;
          b.addDecor(k.kind, p.x, p.z, step, scale);
          perKind.set(k.kind, (perKind.get(k.kind) ?? 0) + 1);
          break;
        }
      }
    }
  }
  assignDecorVariants(b.decor, seed);
}

/** Render variants of decor (art M2c §9; DECOR_VARIANTS), from their own stream. Shared with the office generator. */
export function assignDecorVariants(decor: DecorPlacement[], seed: number): void {
  const rng = rngFor(seed, 'decor:variants');
  for (const d of decor) {
    const n = isDecorKind(d.kind) ? DECOR_VARIANTS[d.kind] : 1;
    const v = Math.floor(rng() * n);
    if (v > 0) d.variant = v;
  }
}

// ---------------------------------------------------------------------------------------------
// Fixed landmarks
// ---------------------------------------------------------------------------------------------
function placeFixed(b: IslandBuilder, rolls: readonly IslandRoll[], rng: Rng): Ctx {
  let hull: P2 = { x: 0, z: 0 };
  const tikiRoll = rolls.find((r) => r.zone.id === 'tikibar');
  const tikiOverride = tikiRoll?.zone.variants[tikiRoll.variant]?.fixedOverride?.tikibarHutRotDeg;
  for (const f of D.fixed) {
    const kind = f.kind as PropKind;
    const scale = typeof f.scale === 'number' ? f.scale : 1;
    if (f.ring) {
      const anchor = D.zones.find((z) => z.id === f.ring!.anchor);
      const a = anchor ? anchorOf(anchor) : { x: 0, z: 0, outStep: 0 };
      for (const { p } of ringPoints(rng, f.ring)) b.force(kind, a.x + p.x, a.z + p.z, 0, scale);
      continue;
    }
    if (!f.polar) continue;
    const [deg, r] = f.polar;
    const p = polarDeg(deg, r);
    let step = 0;
    if (f.rot === 'outward' || f.rot === 'outwardPlus') step = degToStep(180 - deg);
    if (f.rot === 'outwardPlus' && f.rotOffsetRad) step = step + radToStep(f.rotOffsetRad);
    const isTikiHut = kind === 'hut' && tikiRoll !== undefined && dist(p.x, p.z, anchorOf(tikiRoll.zone).x, anchorOf(tikiRoll.zone).z) < 10;
    if (isTikiHut && tikiOverride) step = step + degToStep(range(tikiRoll!.rng, tikiOverride[0], tikiOverride[1]));
    b.force(kind, p.x, p.z, ((step % 1024) + 1024) % 1024, scale);
    if (kind === 'boat' && scale > 1.5) hull = { x: mm(p.x), z: mm(p.z) };
  }
  // Dock aprons (in the dock zone frame).
  for (const roll of rolls) for (const a of roll.zone.aprons ?? []) b.aprons.push({ frame: roll.frame, rect: a.rect });
  return { hull };
}

// ---------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------
export interface IslandLayoutParts {
  props: PropPlacement[];
  lootSpawns: LootSpawn[];
  picks: LayoutPick[];
  decor: DecorPlacement[];
  fallbacks: number;
  look: string;
}

/** Baseline (seed 0): the M2b island as built, loot unchanged except the guaranteed-weapon flags (variety.md §4.3). */
function buildBaseline(base: IslandMapData, opts: { decor: boolean }): IslandLayoutParts {
  const b = new IslandBuilder(base);
  for (const p of base.props) b.force(p.kind, p.x, p.z, radToStep(p.rotY), p.scale);
  // Keep the base values exactly (force() re-rounds; the base data is already rounded to cm / mrad).
  b.props.length = 0;
  b.props.push(...base.props.map((p) => ({ ...p })));
  const loot: LootSpawn[] = base.lootSpawns.map((l) => ({ ...l, group: 'baseline' }));
  for (let k = 0; k < RING_GAPS; k += 2) {
    const target = polarDeg(gapDeg(k), GAP_LOOT_R);
    let best = -1;
    let bestD = Infinity;
    loot.forEach((l, i) => {
      if (l.tier !== 'common' || l.guarantee) return;
      const d = dist(l.x, l.z, target.x, target.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) loot[best] = { ...loot[best]!, guarantee: 'weapon' };
  }
  b.loot.push(...loot);
  if (opts.decor) placeDecor(b, 0);
  return { props: b.props, lootSpawns: b.loot, picks: islandPicks(rollIsland(0)), decor: b.decor, fallbacks: 0, look: pickLook(0, D.look.presets) };
}

export function buildIslandLayout(base: IslandMapData, seed: number, opts: { decor: boolean }): IslandLayoutParts {
  if (seed === 0) return buildBaseline(base, opts);
  const b = new IslandBuilder(base);
  const rolls = rollIsland(seed);
  const ctx = placeFixed(b, rolls, rngFor(seed, 'arr:fixed'));
  // 1. Arrangement structure, with the baseline fallback (variety.md §3.2).
  for (const roll of rolls) {
    const bi = baselineIndex(roll.zone.variants);
    if (!placeStructure(b, roll, roll.variant, roll.variant === bi, ctx)) {
      b.fallbacks++;
      roll.variant = bi;
      placeStructure(b, roll, bi, true, ctx);
    }
  }
  // 2. Loot.
  for (const roll of rolls) pickZoneLoot(b, roll, rngFor(seed, `loot:${roll.zone.id}`));
  pickBeachLoot(b, seed);
  pickInlandLoot(b, seed);
  // 3. Fill and scatter.
  for (const roll of rolls) placeFill(b, roll, rngFor(seed, `scatter:${roll.zone.id}`), ctx);
  for (const z of [...D.scatter].sort((p, q) => (p.order ?? 0) - (q.order ?? 0))) placeScatterZone(b, z, seed);
  // 4. Render-only prop variants (art M2c §9.1): own stream, never read by a decision, not hashed. Computed on every
  // side (cheap) so the server's and the client's props stay equal objects.
  const vr = rngFor(seed, 'variant:props');
  for (const p of b.props) {
    const v = Math.floor(vr() * (ISLAND_VARIANTS[p.kind] ?? 1));
    if (v > 0) p.variant = v;
  }
  // 5. Client part.
  if (opts.decor) placeDecor(b, seed);
  return { props: b.props, lootSpawns: b.loot, picks: islandPicks(rolls), decor: b.decor, fallbacks: b.fallbacks, look: pickLook(seed, D.look.presets) };
}

/** Exposed for tests: rounding used for every written coordinate. */
export const ISLAND_ROUND = roundMm;
