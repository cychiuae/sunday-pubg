/**
 * M2c per-match layout checks LV1-LV16 (docs/design/levels/variety.md §6) over 202 seeds per map:
 * mixSeed(0x5EED0001, i) for i = 0..199, plus 0 (baseline) and 0xFFFFFFFF.
 *
 * These tests use the Math-based level geometry (../indoorGeometry.ts, ../island.ts propFootprint) on purpose: an
 * independent implementation from the generator's deterministic port. LV14's stuck-rate run needs
 * `matchReport --layout-seeds` (game-developer) and is a todo here; the nav build and reachability run on 30 seeds.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import blocklist from '../name-blocklist.json';
import { BALANCE, balanceForMap } from '../../../shared/balance';
import { mixSeed } from '../../../shared/detmath';
import { LAYOUT_FORMAT_VERSION, formatLayoutSeed, layoutHash, layoutSeedFor } from '../../../shared/layout';
import { navStuckForLayoutSeeds } from '../../../shared/sim/tools/navStuck';
import { GLASS_PANE_MAX_WIDTH, glassPanes, validateIndoorMap } from '../../../shared/maps';
import { prepareMap } from '../../../shared/sim/movement';
import { nearestNode } from '../../../shared/sim/nav';
import type { IndoorMapData, IslandMapData, LootSpawn, MatchLayout, PropKind, PropPlacement, Vec2 } from '../../../shared/types';
import {
  type LayerGrid,
  type Solid,
  buildLayer,
  flood,
  footprintContains,
  footprintDist,
  lootSpotIssue,
  mapSolids,
  nearCell,
  spawnIssue,
  topAt,
} from '../indoorGeometry';
import { ISLAND, propFootprint } from '../island';
import { DELIBERATE_GAPS, OFFICE, OFFICE_DOORWAYS, OFFICE_PROP_TAGS } from '../office';
import { BoundsGrid } from './grammar';
import { DECOR_KINDS, applyLayout, buildMatchLayout, pickVariants } from './index';
import { ISLAND_VARIETY } from './island';
import { OFFICE_VARIETY, partGap, placementSolids, segmentHitsAxisBox, wallDSolid } from './office';

const SEEDS: number[] = [0, 0xffffffff, ...Array.from({ length: 200 }, (_, i) => mixSeed(0x5eed0001, i))];
const LONG = 900_000;
/**
 * 1 cm: the generator decides on the detmath table; these checks rebuild footprints with Math.sin/cos of the
 * mrad-rounded rotY (as the sim does), which can differ by a few mm on long parts (docks, desks).
 */
const TOL = 0.01;
/**
 * Fallback uses per seed (variety.md §3.2). A fallback layout is still valid (every LV check runs on it); the bound
 * catches data that keeps failing. The worst seed is logged.
 */
const MAX_FALLBACKS = { island: 4, office: 6 };

/**
 * Collects every violation of one check across all seeds, then asserts once (prints the first 40 and the total), so a
 * run reports all failures instead of the first seed only.
 */
class Report {
  private readonly items: string[] = [];
  private total = 0;
  /** Records `msg` when `ok` is false; returns ok. */
  check(ok: boolean, msg: string): boolean {
    if (!ok) {
      this.total++;
      if (this.items.length < 400) this.items.push(msg);
    }
    return ok;
  }
  /** value >= min (with a tolerance already folded in by the caller). */
  atLeast(value: number, min: number, msg: string): boolean {
    return this.check(value >= min, `${msg}: ${value.toFixed(3)} < ${min}`);
  }
  atMost(value: number, max: number, msg: string): boolean {
    return this.check(value <= max, `${msg}: ${value.toFixed(3)} > ${max}`);
  }
  done(): void {
    expect(this.items.slice(0, 40), `${this.total} violation(s)`).toEqual([]);
  }
}
const stepHeight = BALANCE.movement.stepHeight;
const R_PLAYER = BALANCE.player.radius;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);

const cache = new Map<string, { layout: MatchLayout; map: IslandMapData | IndoorMapData }>();
function built(mapId: 'island01' | 'office', seed: number): { layout: MatchLayout; map: IslandMapData | IndoorMapData } {
  const key = `${mapId}:${seed}`;
  let v = cache.get(key);
  if (!v) {
    const base = mapId === 'office' ? OFFICE : ISLAND;
    const layout = buildMatchLayout(base, seed);
    v = { layout, map: applyLayout(base, layout) };
    cache.set(key, v);
  }
  return v;
}
const island = (seed: number): { layout: MatchLayout; map: IslandMapData } => built('island01', seed) as { layout: MatchLayout; map: IslandMapData };
const office = (seed: number): { layout: MatchLayout; map: IndoorMapData } => built('office', seed) as { layout: MatchLayout; map: IndoorMapData };
const tierCounts = (l: readonly LootSpawn[]): [number, number, number] => [
  l.filter((s) => s.tier === 'common').length,
  l.filter((s) => s.tier === 'rare').length,
  l.filter((s) => s.tier === 'epic').length,
];
const OFFICE_FIXED = OFFICE_PROP_TAGS.filter((t) => t === 'fixed').length;
/** Index of the first per-match (variable) office prop (the baseline is all M2b: none are checked as variable). */
const variableFrom = (seed: number, props: readonly unknown[]): number => (seed === 0 ? props.length : OFFICE_FIXED);

// ---------------------------------------------------------------------------------------------
// Island geometry helpers
// ---------------------------------------------------------------------------------------------
function islandCircles(map: IslandMapData): { x: number; z: number; r: number; prop: number; kind: PropKind }[] {
  return map.props.flatMap((p, i) => propFootprint(p).map((c) => ({ ...c, prop: i, kind: p.kind })));
}

/** Free-cell flood over land (r <= rules.lootMaxRadius) with every hard (not bush or grass) footprint inflated by `inflate`, from (0, 0). */
function islandFlood(map: IslandMapData, inflate: number, cell = 0.5): { reached: (x: number, z: number, within: number) => boolean } {
  const LAND = ISLAND_VARIETY.rules.lootMaxRadius;
  const R = LAND + 2;
  const n = Math.ceil((2 * R) / cell);
  const free = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -R + (i + 0.5) * cell;
      const z = -R + (j + 0.5) * cell;
      if (Math.hypot(x, z) <= LAND) free[j * n + i] = 1;
    }
  }
  for (const c of islandCircles(map)) {
    if (c.kind === 'bush' || c.kind === 'grass') continue; // soft props
    const rr = c.r + inflate;
    const i0 = Math.max(0, Math.floor((c.x - rr + R) / cell));
    const i1 = Math.min(n - 1, Math.floor((c.x + rr + R) / cell));
    const j0 = Math.max(0, Math.floor((c.z - rr + R) / cell));
    const j1 = Math.min(n - 1, Math.floor((c.z + rr + R) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (Math.hypot(-R + (i + 0.5) * cell - c.x, -R + (j + 0.5) * cell - c.z) < rr) free[j * n + i] = 0;
      }
    }
  }
  const reached = new Uint8Array(n * n);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  const near = (x: number, z: number, within: number, mask: Uint8Array): number => {
    const ci = Math.floor((x + R) / cell);
    const cj = Math.floor((z + R) / cell);
    const k = Math.ceil(within / cell) + 1;
    let best = -1;
    let bestD = Infinity;
    for (let j = cj - k; j <= cj + k; j++) {
      if (j < 0 || j >= n) continue;
      for (let i = ci - k; i <= ci + k; i++) {
        if (i < 0 || i >= n || !mask[j * n + i]) continue;
        const d = Math.hypot(-R + (i + 0.5) * cell - x, -R + (j + 0.5) * cell - z);
        if (d <= within && d < bestD) {
          bestD = d;
          best = j * n + i;
        }
      }
    }
    return best;
  };
  const s = near(0, 0, 3, free);
  if (s >= 0) {
    reached[s] = 1;
    queue[tail++] = s;
  }
  while (head < tail) {
    const c = queue[head++]!;
    const i = c % n;
    const push = (m: number): void => {
      if (free[m] && !reached[m]) {
        reached[m] = 1;
        queue[tail++] = m;
      }
    };
    if (i > 0) push(c - 1);
    if (i < n - 1) push(c + 1);
    if (c >= n) push(c - n);
    if (c + n < n * n) push(c + n);
  }
  return { reached: (x, z, within) => near(x, z, within, reached) >= 0 };
}

const COVER_KINDS = new Set<PropKind>(['rock', 'crate', 'hut', 'palm', 'boat']);
/** variety.md §4.2 cover score: summed footprint diameters of hard cover inside the POI disc. */
function coverScore(map: IslandMapData, poi: { x: number; z: number; radius: number }): number {
  let s = 0;
  for (const p of map.props) {
    if (!COVER_KINDS.has(p.kind)) continue;
    if (p.kind === 'boat' && p.scale < 1.5) continue;
    if (dist(p, poi) > poi.radius) continue;
    for (const c of propFootprint(p)) s += 2 * c.r;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Office geometry helpers (the office.test.ts method)
// ---------------------------------------------------------------------------------------------
interface OfficeReach {
  solids: Solid[];
  gridAt: (y: number) => LayerGrid;
  isReached: (x: number, y: number, z: number, within: number) => boolean;
  routesReached: Set<string>;
}
const reachCache = new Map<number, OfficeReach>();
function officeReach(seed: number): OfficeReach {
  const hit = reachCache.get(seed);
  if (hit) return hit;
  const map = office(seed).map;
  const solids = mapSolids(map);
  const LAYER = { radius: R_PLAYER, standHeight: BALANCE.player.height, stepHeight };
  const key = (y: number): string => y.toFixed(2);
  const grids = new Map<string, LayerGrid>();
  const gridAt = (y: number): LayerGrid => {
    let g = grids.get(key(y));
    if (!g) {
      g = buildLayer(solids, map.floor, y, { cell: y <= 0.01 ? 1 : 0.5, ...LAYER });
      grids.set(key(y), g);
    }
    return g;
  };
  const reached = new Map<string, Uint8Array>();
  reached.set(key(0), flood(gridAt(0), [map.zoneCenters[0]!]));
  const routesReached = new Set<string>();
  const seeds = new Map<string, Vec2[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of map.climbRoutes) {
      if (routesReached.has(r.id)) continue;
      const s = r.points[0]!;
      const e = r.points[r.points.length - 1]!;
      const rs = reached.get(key(s.y));
      if (!rs || nearCell(gridAt(s.y), rs, s.x, s.z, 1.0) < 0) continue;
      routesReached.add(r.id);
      changed = true;
      const list = seeds.get(key(e.y)) ?? [];
      list.push(e);
      seeds.set(key(e.y), list);
      reached.set(key(e.y), flood(gridAt(e.y), list, 1.0));
    }
  }
  const out: OfficeReach = {
    solids,
    gridAt,
    routesReached,
    isReached: (x, y, z, within) => {
      const r = reached.get(key(y));
      return !!r && nearCell(gridAt(y), r, x, z, within) >= 0;
    },
  };
  reachCache.set(seed, out);
  return out;
}

const isObstacle = (s: Solid, y = 0): boolean => s.y0 < y + BALANCE.player.height && s.y1 > y + 0.35;
/** Solid footprint vs an axis-aligned rect: sampled both ways (centre, corners, edge midpoints). */
function hitsRect(s: Solid, r: readonly [number, number, number, number]): boolean {
  const inRect = (x: number, z: number): boolean => x > r[0] && x < r[2] && z > r[1] && z < r[3];
  const ex = s.shape === 'cyl' ? s.r : s.hx;
  const ez = s.shape === 'cyl' ? s.r : s.hz;
  for (const [a, b] of [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const lx = a * ex * 0.999;
    const lz = b * ez * 0.999;
    if (inRect(s.cx + lx * s.cos + lz * s.sin, s.cz - lx * s.sin + lz * s.cos)) return true;
  }
  for (const [x, z] of [[r[0], r[1]], [r[0], r[3]], [r[2], r[1]], [r[2], r[3]], [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]] as const) {
    if (footprintContains(s, x, z)) return true;
  }
  return false;
}
function apronRect(d: (typeof OFFICE_DOORWAYS)[number]): [number, number, number, number] {
  const g = OFFICE_VARIETY.rules.doorApron.width / 2;
  const dd = OFFICE_VARIETY.rules.doorApron.depth + 0.45;
  return Math.abs(d.rotY) < 1e-6 ? [d.x - g, d.z - dd, d.x + g, d.z + dd] : [d.x - dd, d.z - g, d.x + dd, d.z + g];
}
const LANES = Object.entries(OFFICE_VARIETY.lanes)
  .filter(([k, v]) => !k.startsWith('_') && Array.isArray(v))
  .map(([k, v]) => [k, v as [number, number, number, number]] as const);

/**
 * Octile floor-path distance field in metres over a floor layer from (x, z), capped at maxD (Infinity beyond).
 * Bucketed Dijkstra on integer costs (10 per straight cell, 14 per diagonal), so it stays fast over 202 seeds.
 */
function pathField(g: LayerGrid, x: number, z: number, maxD: number): Float64Array {
  const n = g.free.length;
  const INF = 0x3fffffff;
  const d = new Int32Array(n).fill(INF);
  const out = new Float64Array(n).fill(Infinity);
  const start = nearCell(g, g.free, x, z, 2);
  if (start < 0) return out;
  const maxC = Math.ceil((maxD / g.cell) * 10);
  const buckets: number[][] = Array.from({ length: maxC + 15 }, () => []);
  d[start] = 0;
  buckets[0]!.push(start);
  for (let c = 0; c <= maxC; c++) {
    for (const idx of buckets[c]!) {
      if (d[idx] !== c) continue;
      out[idx] = (c / 10) * g.cell;
      const ci = idx % g.nx;
      const cj = Math.floor(idx / g.nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) continue;
          const m = j * g.nx + i;
          if (!g.free[m]) continue;
          const diag = di !== 0 && dj !== 0;
          if (diag && (!g.free[cj * g.nx + i] || !g.free[j * g.nx + ci])) continue;
          const nd = c + (diag ? 14 : 10);
          if (nd <= maxC && nd < d[m]!) {
            d[m] = nd;
            buckets[nd]!.push(m);
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Name blocklist (office.test.ts method; names only)
// ---------------------------------------------------------------------------------------------
const NAME_HASHES = new Set<string>(blocklist.hashes as string[]);
const hashToken = (t: string): string => createHash('sha256').update(`${blocklist.salt}:${t}`).digest('hex');
function nameHits(text: string): number {
  const out = new Set<string>();
  for (const words of [text, text.replace(/([a-z])([A-Z])/g, '$1 $2')].map((t) => t.toLowerCase().split(/[^a-z]+/).filter(Boolean))) {
    words.forEach((w, i) => {
      out.add(w);
      if (i > 0) out.add(`${words[i - 1]} ${w}`);
    });
  }
  let hits = 0;
  for (const t of out) if (NAME_HASHES.has(hashToken(t))) hits++;
  return hits;
}

// =============================================================================================
describe('layout contract', () => {
  it('LV1: is deterministic, decor-independent in its sim part, and pins golden hashes', () => {
    for (const seed of SEEDS.slice(0, 30)) {
      for (const base of [ISLAND, OFFICE]) {
        const a = buildMatchLayout(base, seed);
        const b = buildMatchLayout(base, seed);
        expect(b).toEqual(a);
        const server = buildMatchLayout(base, seed, { decor: false });
        expect(server.props, `${base.id} ${formatLayoutSeed(seed)}`).toEqual(a.props);
        expect(server.lootSpawns).toEqual(a.lootSpawns);
        expect(server.hash).toBe(a.hash);
        expect(server.decor).toEqual([]);
        expect(a.hash).toBe(layoutHash(a.props, a.lootSpawns));
        expect(a.version).toBe(LAYOUT_FORMAT_VERSION);
        expect(a.seed).toBe(seed >>> 0);
      }
    }
    const golden: Record<string, string> = {};
    for (const seed of [0, 1, 0x3fa2c1d0]) {
      golden[`island01 ${formatLayoutSeed(seed)}`] = formatLayoutSeed(island(seed).layout.hash);
      golden[`office ${formatLayoutSeed(seed)}`] = formatLayoutSeed(office(seed).layout.hash);
    }
    expect(golden).toMatchSnapshot();
  }, LONG);

  it('seed 0 is the baseline: today\'s props and loot positions, baseline picks and look', () => {
    for (const [base, look] of [[ISLAND, 'noon'], [OFFICE, 'day']] as const) {
      const l = buildMatchLayout(base, 0);
      expect(l.props).toEqual(base.props);
      expect(l.lootSpawns.map(({ x, z, tier, y }) => ({ x, z, tier, y }))).toEqual(base.lootSpawns.map(({ x, z, tier, y }) => ({ x, z, tier, y })));
      expect(l.look).toBe(look);
      expect(l.fallbacks).toBe(0);
    }
  });

  it('applyLayout keeps the map type and replaces only props and loot', () => {
    const { layout, map } = office(SEEDS[5]!);
    expect(map.kind).toBe('indoor');
    expect(map.walls).toBe(OFFICE.walls);
    expect(map.props).toBe(layout.props);
    expect(map.lootSpawns).toBe(layout.lootSpawns);
    expect(validateIndoorMap(map, stepHeight)).toEqual([]);
    expect(() => applyLayout(ISLAND, layout)).toThrow();
  });

  it('LV2: picks are valid, pickVariants matches the build, office pods rules hold, fallbacks are bounded', () => {
    const rep = new Report();
    const fb = { island: 0, office: 0 };
    const islandZones = ISLAND_VARIETY.zones.map((z) => [z.id, z.variants.map((v) => v.id)] as const);
    for (const seed of SEEDS) {
      const where = formatLayoutSeed(seed);
      {
        const { layout } = island(seed);
        const picks = pickVariants(ISLAND, seed);
        rep.check(JSON.stringify(layout.picks.map((p) => p.zone)) === JSON.stringify(picks.map((p) => p.zone)), `${where} island pick zones differ`);
        if (layout.fallbacks === 0) rep.check(JSON.stringify(layout.picks) === JSON.stringify(picks), `${where} island pickVariants != picks`);
        for (const [id, ids] of islandZones) rep.check(ids.includes(layout.picks.find((p) => p.zone === id)?.variant ?? ''), `${where} island ${id}: unknown variant`);
        rep.atMost(layout.fallbacks, MAX_FALLBACKS.island, `${where} island fallbacks`);
        fb.island = Math.max(fb.island, layout.fallbacks);
      }
      const { layout, map } = office(seed);
      const picks = pickVariants(OFFICE, seed);
      rep.check(JSON.stringify(layout.picks.map((p) => p.zone)) === JSON.stringify(picks.map((p) => p.zone)), `${where} office pick zones differ`);
      if (layout.fallbacks === 0) rep.check(JSON.stringify(layout.picks) === JSON.stringify(picks), `${where} office pickVariants != picks`);
      const blocks = layout.picks.filter((p) => ['TL', 'TR', 'BL', 'BR'].includes(p.zone));
      rep.atMost(blocks.filter((p) => p.variant === 'pods').length, OFFICE_VARIETY.deskBlocks.constraints.maxPodsPerMatch, `${where} pods`);
      const col = (z: string): unknown => blocks.find((p) => p.zone === z && p.variant === 'pods')?.params?.column;
      for (const [a, b] of [['TL', 'BL'], ['TR', 'BR']]) if (col(a) !== undefined && col(b) !== undefined) rep.check(col(a) !== col(b), `${where} ${a}/${b} pods at the same x`);
      // Anchor desks always present.
      for (const bd of OFFICE_VARIETY.deskBlocks.blocks) {
        for (const key of bd.anchors) {
          const [b, row, k] = key.split('.') as [string, string, string];
          const blk = { TL: [-61.68, -23.21], TR: [26.8, -23.21], BL: [-61.68, 23.21], BR: [26.8, 23.21] }[b]!;
          const x = blk[0]! + 12.64 * Number(k);
          const z = blk[1]! + (row === 'N' ? -3.395 : 3.395);
          rep.check(map.props.some((p) => p.kind === 'desk' && Math.abs(p.x - x) < 0.01 && Math.abs(p.z - z) < 0.01), `${where} anchor desk ${key} missing`);
        }
      }
      rep.atMost(layout.fallbacks, MAX_FALLBACKS.office, `${where} office fallbacks (picks ${JSON.stringify(layout.picks)})`);
      fb.office = Math.max(fb.office, layout.fallbacks);
    }
    console.info(`[LV2] max fallbacks per seed: island ${fb.island}, office ${fb.office}`);
    rep.done();
  }, LONG);

  it('emits only known decor kinds and look ids for its map', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      for (const [base, looks] of [[ISLAND, ISLAND_VARIETY.look.presets], [OFFICE, OFFICE_VARIETY.look.presets]] as const) {
        const l = built(base.id as 'island01' | 'office', seed).layout;
        expect(looks.map((p) => p.id)).toContain(l.look);
        for (const d of l.decor) expect(DECOR_KINDS as readonly string[]).toContain(d.kind);
      }
    }
  }, LONG);
});

// =============================================================================================
describe('island01 layouts (202 seeds)', () => {
  it('LV3 + LV4 + LV11: spawns keep their pad, zone centres stay clear', () => {
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = island(seed).map;
      const where = formatLayoutSeed(seed);
      const circles = islandCircles(map);
      const pad = seed === 0 ? 2.5 : ISLAND_VARIETY.rules.spawnPad;
      for (const s of map.playerSpawns) {
        for (const c of circles) rep.atLeast(dist(s, c) - c.r, pad - TOL, `${where} spawn ${s.x},${s.z} vs ${c.kind}@${c.x.toFixed(1)},${c.z.toFixed(1)}`);
      }
      if (seed === 0) continue;
      for (const zc of map.zoneCenters) {
        for (const c of circles) rep.atLeast(dist(zc, c) - c.r, ISLAND_VARIETY.rules.zoneCentreClear - TOL, `${where} zone ${zc.x},${zc.z} vs ${c.kind}`);
      }
    }
    rep.done();
  }, LONG);

  it('LV5 + LV6: exact loot counts, valid spots, guaranteed weapons by every spawn', () => {
    const T = ISLAND_VARIETY.lootTotals;
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = island(seed).map;
      const where = formatLayoutSeed(seed);
      rep.check(JSON.stringify(tierCounts(map.lootSpawns)) === JSON.stringify([T.common, T.rare, T.epic]), `${where} tier counts ${JSON.stringify(tierCounts(map.lootSpawns))}`);
      rep.check(map.lootSpawns.filter((l) => l.guarantee === 'weapon').length === T.guaranteedWeapons, `${where} guaranteed weapons count`);
      const circles = islandCircles(map);
      map.lootSpawns.forEach((l, i) => {
        rep.atMost(Math.hypot(l.x, l.z), ISLAND_VARIETY.rules.lootMaxRadius + 1e-6, `${where} loot ${i} (${l.group}) radius`);
        for (const c of circles) rep.atLeast(dist(l, c) - c.r, 0.75 - TOL, `${where} loot ${i} (${l.group}) vs ${c.kind}`);
        for (let j = i + 1; j < map.lootSpawns.length; j++) rep.atLeast(dist(l, map.lootSpawns[j]!), 2.5 - 1e-6, `${where} loot ${i}/${j} spacing`);
      });
      for (const s of map.playerSpawns) {
        const near = map.lootSpawns.filter((l) => dist(l, s) <= 25);
        rep.atLeast(near.length, 3, `${where} spawn ${s.x},${s.z} loot within 25 m`);
        rep.check(near.some((l) => l.guarantee === 'weapon'), `${where} spawn ${s.x},${s.z}: no guaranteed weapon within 25 m`);
      }
      rep.check(map.lootSpawns.filter((l) => l.tier === 'epic').every((l) => ['summit', 'grove', 'baseline'].includes(l.group ?? '')), `${where} epic outside summit/grove`);
    }
    rep.done();
  }, LONG);

  it('LV5 + LV8 + LV11: loot, spawns, POIs and zone centres are reachable on foot; the beach ring is connected', () => {
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = island(seed).map;
      const where = formatLayoutSeed(seed);
      const player = islandFlood(map, R_PLAYER);
      map.lootSpawns.forEach((l, i) => rep.check(player.reached(l.x, l.z, 1.0), `${where} loot ${i} (${l.group}) at ${l.x},${l.z} unreachable`));
      for (const zc of map.zoneCenters) rep.check(player.reached(zc.x, zc.z, 1.5), `${where} zone ${zc.x},${zc.z} unreachable`);
      const wide = islandFlood(map, 0.9);
      for (const s of map.playerSpawns) rep.check(wide.reached(s.x, s.z, 1.5), `${where} spawn ${s.x},${s.z} cut off (r 0.9 agent)`);
      for (const p of map.pois) rep.check(wide.reached(p.x, p.z, 6), `${where} POI ${p.id} cut off (r 0.9 agent)`);
    }
    rep.done();
  }, LONG);

  it('LV10: every pair of footprints keeps the 2 m gap', () => {
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = island(seed).map;
      const circles = islandCircles(map);
      const grid = new BoundsGrid(8);
      circles.forEach((c, i) => grid.add(i, c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r));
      circles.forEach((c, i) => {
        grid.query(c.x - c.r - 2, c.z - c.r - 2, c.x + c.r + 2, c.z + c.r + 2, (j) => {
          const o = circles[j]!;
          if (j <= i || o.prop === c.prop) return;
          rep.atLeast(dist(c, o) - c.r - o.r, 2 - TOL, `${formatLayoutSeed(seed)} ${c.kind}@${c.x.toFixed(1)},${c.z.toFixed(1)} vs ${o.kind}@${o.x.toFixed(1)},${o.z.toFixed(1)}`);
        });
      });
    }
    rep.done();
  }, LONG);

  it('LV13: placement budgets hold for the worst seed', () => {
    const B = ISLAND_VARIETY.budgets;
    const rep = new Report();
    let worst = { seed: 0, n: 0 };
    for (const seed of SEEDS) {
      const { layout, map } = island(seed);
      const where = formatLayoutSeed(seed);
      if (map.props.length > worst.n) worst = { seed, n: map.props.length };
      rep.atMost(map.props.length, B.simPlacementsMax, `${where} sim placements`);
      for (const [kind, cap] of Object.entries(B.perKindMax)) {
        rep.atMost(map.props.filter((p: PropPlacement) => p.kind === kind).length, cap, `${where} ${kind}`);
      }
      rep.atMost(layout.decor.length, B.decorPlacementsMax, `${where} decor`);
    }
    console.info(`[LV13] island worst seed ${formatLayoutSeed(worst.seed)}: ${worst.n} sim placements`);
    rep.done();
  }, LONG);

  it('LV15: each POI variant keeps its cover within the fairness band of the baseline', () => {
    const F = (ISLAND_VARIETY as unknown as { fairness: { coverScoreTolerance: number; coverScoreHardLimit: number } }).fairness;
    const rep = new Report();
    for (const poi of ISLAND.pois) {
      const byVariant = new Map<string, number[]>();
      for (const seed of SEEDS.slice(2)) {
        const { layout, map } = island(seed);
        const v = layout.picks.find((p) => p.zone === poi.id)!.variant;
        const list = byVariant.get(v) ?? [];
        list.push(coverScore(map, poi));
        byVariant.set(v, list);
      }
      const baseId = ISLAND_VARIETY.zones.find((z) => z.id === poi.id)!.variants.find((v) => v.baseline)!.id;
      const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
      const base = mean(byVariant.get(baseId) ?? [coverScore(ISLAND, poi)]);
      const means: string[] = [];
      for (const [v, scores] of byVariant) {
        means.push(`${v} ${mean(scores).toFixed(1)}`);
        rep.atMost(Math.abs(mean(scores) / base - 1), F.coverScoreTolerance, `${poi.id}.${v} mean ${mean(scores).toFixed(1)} vs ${base.toFixed(1)}`);
        for (const s of scores) rep.atMost(Math.abs(s / base - 1), F.coverScoreHardLimit, `${poi.id}.${v} seed score ${s.toFixed(1)} vs ${base.toFixed(1)}`);
      }
      console.info(`[LV15] ${poi.id} cover means: ${means.join(', ')}`);
    }
    rep.done();
  }, LONG);
});

// =============================================================================================
describe('office layouts (202 seeds)', () => {
  it('splits every glass wall into panes no wider than GLASS_PANE_MAX_WIDTH, with stable pane ids', () => {
    for (const w of OFFICE.walls.filter((q) => q.material === 'glass')) {
      expect(Math.hypot(w.x2 - w.x1, w.z2 - w.z1)).toBeLessThanOrEqual(GLASS_PANE_MAX_WIDTH + 1e-6);
    }
    const a = glassPanes(office(SEEDS[3]!).map);
    const b = glassPanes(applyLayout(OFFICE, buildMatchLayout(OFFICE, SEEDS[3]!, { decor: false })));
    expect(b).toEqual(a);
    a.forEach((p, i) => expect(p.id).toBe(i));
    // Wall panes come first and are the same in every layout.
    const walls = (m: IndoorMapData): unknown[] => glassPanes(m).filter((p) => 'wall' in p);
    expect(walls(office(SEEDS[4]!).map)).toEqual(walls(OFFICE));
  });

  it('LV3 + LV4: fallback spawns stay clear (2.5 m), zone centres keep 3 m, variable props stay under 12 m', () => {
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = office(seed).map;
      const where = formatLayoutSeed(seed);
      const solids = officeReach(seed).solids;
      map.playerSpawns.forEach((s, i) => {
        const issue = spawnIssue(solids, map.floor, s.x, s.z);
        rep.check(issue === null, `${where} spawn ${i + 1}: ${issue}`);
      });
      const from = variableFrom(seed, map.props);
      const variable = solids.filter((s) => s.prop >= from);
      for (const s of variable) rep.atMost(s.y1, OFFICE_VARIETY.rules.maxVariablePropTop + 1e-6, `${where} ${s.label} top`);
      // Low cover (top <= 1 m: the tunnel's boxSmall / bookStack by design, office.md §3.4) may sit in the disc.
      for (const zc of map.zoneCenters) {
        for (const s of variable) {
          if (isObstacle(s) && s.y1 > 1.0) rep.atLeast(footprintDist(s, zc.x, zc.z), 3 - TOL, `${where} zone ${zc.x},${zc.z} vs ${s.label}`);
        }
      }
    }
    rep.done();
  }, LONG);

  it('LV5 + LV6: exact loot counts, valid spots, every loot spot reachable, guaranteed weapons near every spawn', () => {
    const T = OFFICE_VARIETY as unknown as { lootTotals: { common: number; rare: number; epic: number; guaranteedWeapons: number } };
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = office(seed).map;
      const where = formatLayoutSeed(seed);
      const reach = officeReach(seed);
      const counts = tierCounts(map.lootSpawns);
      rep.check(JSON.stringify(counts) === JSON.stringify([T.lootTotals.common, T.lootTotals.rare, T.lootTotals.epic]), `${where} tier counts ${JSON.stringify(counts)}`);
      const guaranteed = map.lootSpawns.filter((l) => l.guarantee === 'weapon');
      rep.check(guaranteed.length === T.lootTotals.guaranteedWeapons, `${where} guaranteed weapons: ${guaranteed.length}`);
      map.lootSpawns.forEach((l, i) => {
        const y = l.y ?? 0;
        const issue = lootSpotIssue(reach.solids, map.floor, l.x, y, l.z, stepHeight);
        rep.check(issue === null, `${where} loot ${i} (${l.group}) at ${l.x},${y},${l.z}: ${issue}`);
        rep.check(reach.isReached(l.x, y, l.z, y <= 0.01 ? 1.2 : 0.8), `${where} loot ${i} (${l.group}) at ${l.x},${y},${l.z} unreachable`);
        for (let j = i + 1; j < map.lootSpawns.length; j++) {
          const o = map.lootSpawns[j]!;
          if (Math.abs((o.y ?? 0) - y) > 0.5) continue;
          rep.atLeast(dist(l, o), 2.0 - 1e-6, `${where} loot ${i}/${j} spacing`);
        }
      });
      for (const l of map.lootSpawns.filter((q) => q.tier === 'epic')) rep.check((l.y ?? 0) > 6, `${where} epic on the floor at ${l.x},${l.z}`);
      // The baseline keeps M2b's loot positions exactly; its guarantee flags are best effort (spawn 7, in the Blue
      // Room, has no M2b common within 35 m of path). The per-match layouts must meet the rule.
      if (seed === 0) continue;
      const floorGrid = reach.gridAt(0);
      map.playerSpawns.forEach((s, i) => {
        rep.atLeast(map.lootSpawns.filter((l) => dist(l, s) <= 30).length, 2, `${where} spawn ${i + 1} loot within 30 m`);
        const field = pathField(floorGrid, s.x, s.z, 40);
        const ok = guaranteed.some((l) => {
          const c = nearCell(floorGrid, floorGrid.free, l.x, l.z, 1.5);
          return c >= 0 && field[c]! <= 35;
        });
        rep.check(ok, `${where} spawn ${i + 1}: no guaranteed weapon within 35 m of path`);
      });
    }
    rep.done();
  }, LONG);

  it('LV7 + LV8: doorways, corridor lanes and the main aisle stay open', () => {
    const LAYER = { standHeight: BALANCE.player.height, stepHeight };
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = office(seed).map;
      const where = formatLayoutSeed(seed);
      const solids = officeReach(seed).solids;
      const from = variableFrom(seed, map.props);
      const variable = solids.filter((s) => s.prop >= from && isObstacle(s));
      const at = (s: Solid): string => `${s.label}@${s.cx.toFixed(1)},${s.cz.toFixed(1)}`;
      for (const d of OFFICE_DOORWAYS) for (const s of variable) rep.check(!hitsRect(s, apronRect(d)), `${where} ${d.id} apron vs ${at(s)}`);
      for (const [id, rect] of LANES) for (const s of variable) rep.check(!hitsRect(s, rect), `${where} lane ${id} vs ${at(s)}`);
      const wide = buildLayer(solids, map.floor, 0, { cell: 1, radius: 1.5, ...LAYER });
      const r = flood(wide, [map.zoneCenters[0]!], 1.5);
      for (const d of OFFICE_DOORWAYS) {
        const nrm = Math.abs(d.rotY) < 1e-6 ? { x: 0, z: 1 } : { x: 1, z: 0 };
        for (const sgn of [-2.5, 2.5]) {
          rep.check(nearCell(wide, r, d.x + nrm.x * sgn, d.z + nrm.z * sgn, 1.5) >= 0, `${where} ${d.id} side ${sgn} not reached (r 1.5 agent)`);
        }
      }
      const aisle = buildLayer(solids, map.floor, 0, { cell: 1, radius: 2.0, ...LAYER });
      const ra = flood(aisle, [{ x: -84, z: 0 }], 2);
      rep.check(nearCell(aisle, ra, 114, 0, 2) >= 0, `${where} main aisle blocked (r 2 agent)`);
    }
    rep.done();
  }, LONG);

  it('LV9: climb-route starts, approaches, ends and waypoints stay clear; every route and deck stays reachable', () => {
    const RU = OFFICE_VARIETY.rules;
    const rep = new Report();
    for (const seed of SEEDS) {
      const map = office(seed).map;
      const where = formatLayoutSeed(seed);
      const reach = officeReach(seed);
      const from = variableFrom(seed, map.props);
      const variable = reach.solids.filter((s) => s.prop >= from);
      for (const r of map.climbRoutes) rep.check(reach.routesReached.has(r.id), `${where} route ${r.id} start not reached`);
      for (const r of map.climbRoutes) {
        const pts = r.points;
        const s0 = pts[0]!;
        const s1 = pts[1]!;
        const probes: { x: number; y: number; z: number; r: number; what: string }[] = [{ ...s0, r: RU.routeStartClear, what: 'start' }];
        const L = Math.hypot(s0.x - s1.x, s0.z - s1.z);
        for (let t = 0.5; t <= RU.routeApproach.length + 1e-9; t += 0.5) {
          probes.push({ x: s0.x + ((s0.x - s1.x) / L) * t, y: s0.y, z: s0.z + ((s0.z - s1.z) / L) * t, r: RU.routeApproach.width / 2, what: 'approach' });
        }
        probes.push({ ...pts[pts.length - 1]!, r: RU.routeEndClear, what: 'end' });
        for (let k = 1; k < pts.length - 1; k++) probes.push({ ...pts[k]!, r: RU.routeWaypointClear, what: `wp${k}` });
        for (const q of probes) {
          for (const s of variable) {
            // Parts that block a standing player at the probe's level (a keyboard you step over does not).
            if (!(s.y0 < q.y + BALANCE.player.height && s.y1 > q.y + 0.35)) continue;
            rep.atLeast(footprintDist(s, q.x, q.z), q.r - TOL, `${where} ${r.id} ${q.what} vs ${s.label}@${s.cx.toFixed(1)},${s.cz.toFixed(1)}`);
          }
        }
      }
      // Every desk of every block deck is reached on its top (gaps and pods keep each piece on a route).
      const inBlock = (x: number): boolean => (x > -68 && x < -4.8) || (x > 20.48 && x < 96.32);
      map.props.forEach((p) => {
        if (p.kind !== 'desk' || Math.abs(Math.abs(p.z) - 23.21) > 7 || !inBlock(p.x)) return;
        rep.check(reach.isReached(p.x, 6.66, p.z, 3), `${where} desk ${p.x},${p.z} top not reached`);
      });
    }
    rep.done();
  }, LONG);

  it('LV10: no prop pierces another, and no plateau gap falls in the 3-6 m band', () => {
    const [lo, hi] = OFFICE_VARIETY.rules.plateauGapForbidden;
    const STAND = new Set(['desk', 'deskWood', 'box', 'pottedPlant', 'filingCabinet', 'printer', 'pingPongTable', 'foosballTable', 'pantryCounter', 'dumbbellRack', 'guitarStand']);
    const rep = new Report();
    // Full-height walls (solid and glass): two tops on either side of one are no near-miss jump (variety.md LV10).
    const walls = OFFICE.walls.filter((w) => w.top >= 20).map((w, i) => wallDSolid(w, i));
    const wallBetween = (ax: number, az: number, bx: number, bz: number): boolean => walls.some((w) => segmentHitsAxisBox(w, ax, az, bx, bz));
    for (const seed of SEEDS) {
      const { map } = office(seed);
      const where = formatLayoutSeed(seed);
      const from = variableFrom(seed, map.props);
      const parts = map.props.flatMap((p, i) => placementSolids(map.kit, p, i));
      const grid = new BoundsGrid(8);
      const box = (s: (typeof parts)[number]): [number, number, number, number] => {
        const ex = s.box ? Math.abs(s.hx * s.c) + Math.abs(s.hz * s.s) : s.r;
        const ez = s.box ? Math.abs(s.hx * s.s) + Math.abs(s.hz * s.c) : s.r;
        return [s.cx - ex, s.cz - ez, s.cx + ex, s.cz + ez];
      };
      parts.forEach((s, i) => {
        const [x0, z0, x1, z1] = box(s);
        grid.add(i, x0, z0, x1, z1);
      });
      // Shrinking both footprints by 2 cm turns "touching" (flush, gap 0) into a positive gap; a real overlap stays 0.
      const shrink = (s: (typeof parts)[number]): (typeof parts)[number] => ({ ...s, hx: Math.max(s.hx - 0.02, 0), hz: Math.max(s.hz - 0.02, 0), r: Math.max(s.r - 0.02, 0) });
      const floorObstacle = (s: (typeof parts)[number]): boolean => s.y0 < 1.3 && s.y1 > 0.35;
      const standTop = (s: (typeof parts)[number]): boolean => STAND.has(s.kind) && s.y1 >= 2;
      // Plateaus: standable tops at the same height that touch (a flush row of boxes, a desk block) are one plateau;
      // the 3-6 m band applies between different plateaus only.
      const comp = parts.map((_, i) => i);
      const find = (i: number): number => {
        while (comp[i] !== i) {
          comp[i] = comp[comp[i]!]!;
          i = comp[i]!;
        }
        return i;
      };
      parts.forEach((s, i) => {
        if (!standTop(s)) return;
        const [x0, z0, x1, z1] = box(s);
        grid.query(x0 - 0.1, z0 - 0.1, x1 + 0.1, z1 + 0.1, (j) => {
          const o = parts[j]!;
          if (j === i || !standTop(o) || Math.abs(o.y1 - s.y1) > 0.05 || partGap(s, o) > 0.1) return;
          comp[find(i)] = find(j);
        });
      });
      parts.forEach((s, i) => {
        if (s.prop < from) return;
        const [x0, z0, x1, z1] = box(s);
        if (floorObstacle(s)) {
          grid.query(x0 - 0.05, z0 - 0.05, x1 + 0.05, z1 + 0.05, (j) => {
            const o = parts[j]!;
            if (o.prop === s.prop || (o.prop >= from && j < i) || !floorObstacle(o)) return;
            rep.check(partGap(shrink(s), shrink(o)) > 0, `${where} ${s.kind} pierces ${o.kind} at ${s.cx.toFixed(2)},${s.cz.toFixed(2)}`);
          });
        }
        if (standTop(s)) {
          grid.query(x0 - hi, z0 - hi, x1 + hi, z1 + hi, (j) => {
            const o = parts[j]!;
            if (o.prop === s.prop || (o.prop >= from && j < i) || !standTop(o) || Math.abs(s.y1 - o.y1) > 1.35) return;
            if (find(i) === find(j) || wallBetween(s.cx, s.cz, o.cx, o.cz)) return;
            const g = partGap(s, o);
            rep.check(!(g > lo && g < hi), `${where} plateau gap ${g.toFixed(2)} ${s.kind}@${s.cx.toFixed(1)},${s.cz.toFixed(1)} vs ${o.kind}@${o.cx.toFixed(1)},${o.cz.toFixed(1)}`);
          });
        }
      });
    }
    rep.done();
  }, LONG);

  it('LV12: no new stance gap (raised parts 0.6-1.35 m over a walkable top), on 20 seeds', () => {
    const samplePoints = (s: Solid): [number, number][] => {
      const pts: [number, number][] = [[s.cx, s.cz]];
      const ex = s.shape === 'cyl' ? 0.7 * s.r : s.hx - 0.05;
      const ez = s.shape === 'cyl' ? 0.7 * s.r : s.hz - 0.05;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const lx = sx * ex;
        const lz = sz * ez;
        pts.push([s.cx + lx * s.cos + lz * s.sin, s.cz - lx * s.sin + lz * s.cos]);
      }
      return pts;
    };
    const rep = new Report();
    for (const seed of SEEDS.slice(0, 20)) {
      const all = officeReach(seed).solids;
      const grid = new BoundsGrid(8);
      all.forEach((s, i) => {
        const ex = s.shape === 'cyl' ? s.r : Math.abs(s.hx * s.cos) + Math.abs(s.hz * s.sin);
        const ez = s.shape === 'cyl' ? s.r : Math.abs(s.hx * s.sin) + Math.abs(s.hz * s.cos);
        grid.add(i, s.cx - ex, s.cz - ez, s.cx + ex, s.cz + ez);
      });
      const found = new Set<string>();
      for (const b of all) {
        if (b.prop < 0 || b.y0 <= 0.01) continue;
        for (const [x, z] of samplePoints(b)) {
          let below = 0;
          let filled = false;
          grid.query(x, z, x, z, (j) => {
            const c = all[j]!;
            if (c === b || !footprintContains(c, x, z)) return false;
            if (c.y0 < b.y0 - 0.01 && c.y1 > b.y0 + 0.01) {
              filled = true;
              return true;
            }
            const t = topAt(c, x, z);
            if (t <= b.y0 + 0.01 && t > below) below = t;
            return false;
          });
          const gap = b.y0 - below;
          if (!filled && gap >= 0.6 && gap <= 1.35) found.add(b.label);
        }
      }
      const got = [...found].sort().join(',');
      rep.check(got === [...DELIBERATE_GAPS].sort().join(','), `${formatLayoutSeed(seed)} stance gaps: ${got}`);
    }
    rep.done();
  }, LONG);

  it('LV13 + LV15: placement budgets hold for the worst seed; every block deck keeps 3 full-height cover items', () => {
    const B = (OFFICE_VARIETY as unknown as { budgets: { nonCeilingPlacementsMax: number; decorPlacementsMax: number } }).budgets;
    const FULL = new Set(OFFICE_VARIETY.deskBlocks.dressing.deskClutter.fullCoverKinds);
    const rep = new Report();
    let worst = { seed: 0, n: 0 };
    for (const seed of SEEDS) {
      const { layout, map } = office(seed);
      const where = formatLayoutSeed(seed);
      const n = map.props.filter((p) => map.kit[p.kind]?.origin !== 'ceiling').length;
      if (n > worst.n) worst = { seed, n };
      rep.atMost(n, B.nonCeilingPlacementsMax, `${where} non-ceiling placements`);
      rep.atMost(layout.decor.length, B.decorPlacementsMax, `${where} decor`);
      // The baseline is M2b's dressing as built (TR has 2); the per-match layouts top up to the minimum.
      if (seed === 0) continue;
      for (const [bx0, bx1, bz] of [[-68, -4.8, -23.21], [20.48, 83.68, -23.21], [-68, -4.8, 23.21], [20.48, 96.32, 23.21]] as const) {
        const cover = map.props.filter((p) => FULL.has(p.kind) && Math.abs(p.y - 6.66) < 0.05 && p.x > bx0 && p.x < bx1 && Math.abs(p.z - bz) < 6.8).length;
        rep.atLeast(cover, OFFICE_VARIETY.deskBlocks.dressing.deskClutter.minFullCoverPerBlock, `${where} block at ${bx0},${bz} full-height cover`);
      }
    }
    console.info(`[LV13] office worst seed ${formatLayoutSeed(worst.seed)}: ${worst.n} non-ceiling placements`);
    rep.done();
  }, LONG);

  it('afterHours lights: every lit set covers the floor within 20 m', () => {
    const rep = new Report();
    for (const seed of SEEDS) {
      const { layout, map } = office(seed);
      const where = formatLayoutSeed(seed);
      if (layout.look !== 'afterHours') {
        rep.check(layout.lightsOn === undefined, `${where} lightsOn set for look ${layout.look}`);
        continue;
      }
      const lit = (layout.lightsOn ?? []).map((i) => map.props[i]!);
      rep.check(lit.length > 0, `${where} no lit panel`);
      for (const l of lit) rep.check(l.kind === 'lightPanel', `${where} lightsOn points at ${l.kind}`);
      for (const p of map.props.filter((q) => q.kind === 'lightPanel')) {
        rep.atMost(lit.length > 0 ? Math.min(...lit.map((l) => dist(l, p))) : Infinity, 20, `${where} panel at ${p.x},${p.z} to nearest lit`);
      }
    }
    rep.done();
  }, LONG);

  it('LV14 (normal run, 30 seeds): the nav graph builds and reaches every spawn, loot spot and zone centre', () => {
    const balance = balanceForMap(BALANCE, 'office');
    const rep = new Report();
    const times: number[] = [];
    for (const seed of SEEDS.slice(0, 30)) {
      const map = office(seed).map;
      const t0 = performance.now();
      const rt = prepareMap(map, balance);
      times.push(performance.now() - t0);
      const g = rt.nav!;
      const where = formatLayoutSeed(seed);
      for (const s of map.playerSpawns) rep.check(nearestNode(g, { x: s.x, y: 0, z: s.z }) !== -1, `${where} spawn ${s.x},${s.z} off the nav graph`);
      for (const l of map.lootSpawns) rep.check(nearestNode(g, { x: l.x, y: l.y ?? 0, z: l.z }) !== -1, `${where} loot ${l.group} ${l.x},${l.y ?? 0},${l.z} off the nav graph`);
      for (const c of map.zoneCenters) rep.check(nearestNode(g, { x: c.x, y: 0, z: c.z }) !== -1, `${where} zone ${c.x},${c.z} off the nav graph`);
    }
    rep.done();
    times.sort((a, b) => a - b);
    console.info(`[LV14] office prepareMap (nav) ms: median ${times[15]!.toFixed(0)}, p95 ${times[28]!.toFixed(0)}, max ${times[29]!.toFixed(0)}`);
  }, LONG);

  it('LV14 stuck rate (normal run, 30 layout seeds; nightly: 200 via matchReport --nav-walk): pooled < 2 %, every seed <= 5 %', () => {
    const seeds = Array.from({ length: 30 }, (_, i) => layoutSeedFor(1 + i, 0));
    const r = navStuckForLayoutSeeds(OFFICE, balanceForMap(BALANCE, 'office'), seeds, 12, 60, 1);
    console.info(`[LV14] stuck rate pooled ${(r.pooledRate * 100).toFixed(2)} %, worst ${formatLayoutSeed(r.worst.layoutSeed)} ${(r.worst.stuckRate * 100).toFixed(2)} %`);
    expect(r.pooledRate).toBeLessThan(0.02);
    const rep = new Report();
    for (const s of r.perSeed) rep.atMost(s.stuckRate, 0.05, `${formatLayoutSeed(s.layoutSeed)} stuck rate`);
    rep.done();
  }, 120_000);

  it('LV16: no seat-plan names in generated office layouts or the variety data', () => {
    for (const seed of SEEDS.slice(0, 20)) expect(nameHits(JSON.stringify(office(seed).layout)), formatLayoutSeed(seed)).toBe(0);
    expect(nameHits(readFileSync(new URL('../variety/office.variety.json', import.meta.url), 'utf8'))).toBe(0);
  }, LONG);
});
