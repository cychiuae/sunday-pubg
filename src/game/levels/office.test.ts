import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import blocklist from './name-blocklist.json';
import strings from '../../content/strings/en.json';
import { BALANCE } from '../../shared/balance';
import { OFFICE_KIT } from '../../shared/kits/office';
import { CLIMB_JUMP_RISE_MAX, validateIndoorMap } from '../../shared/maps';
import type { Vec2 } from '../../shared/types';
import {
  type LayerGrid,
  type Solid,
  RAMP_STEP_RISE,
  buildLayer,
  flood,
  footprintContains,
  lootSpotIssue,
  mapSolids,
  nearCell,
  spawnIssue,
  supportTop,
  topAt,
} from './indoorGeometry';
import { ISLAND } from './island';
import {
  DELIBERATE_GAPS,
  OFFICE,
  OFFICE_DESK_TOP,
  OFFICE_DOORWAYS,
  OFFICE_DOOR_CLEAR,
  OFFICE_DOOR_GAP,
  OFFICE_LOOT_DEFS,
  OFFICE_NUDGE_MAX,
  OFFICE_PERCH_TOP,
  OFFICE_PONG_TOP,
  OFFICE_SPAWN_DEFS,
  buildOffice,
} from './office';

const map = OFFICE;
const stepHeight = BALANCE.movement.stepHeight;
const LAYER = { radius: BALANCE.player.radius, standHeight: BALANCE.player.height, stepHeight };
const solids = mapSolids(map);
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const strs = strings as Record<string, string>;

const POI_IDS = [
  'office_meeting', 'office_phone', 'office_corner', 'office_blue', 'office_yellow', 'office_pantry', 'office_admin',
  'office_entrance', 'office_gym', 'office_games', 'office_tea', 'office_sales', 'office_design', 'office_eng',
  'office_project',
];

// ---------------------------------------------------------------------------------------------
// Reachability: the floor flood from the crossroads, then every plateau reached through climb routes.
// ---------------------------------------------------------------------------------------------
const layerKey = (y: number): string => y.toFixed(2);
const grids = new Map<string, LayerGrid>();
const gridAt = (y: number): LayerGrid => {
  const k = layerKey(y);
  let g = grids.get(k);
  if (!g) {
    g = buildLayer(solids, map.floor, y, { cell: y <= 0.01 ? 1 : 0.5, ...LAYER });
    grids.set(k, g);
  }
  return g;
};
const reached = new Map<string, Uint8Array>();
reached.set(layerKey(0), flood(gridAt(0), [map.zoneCenters[0]!]));
const routesReached = new Set<string>();
{
  const seeds = new Map<string, Vec2[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of map.climbRoutes) {
      if (routesReached.has(r.id)) continue;
      const s = r.points[0]!;
      const e = r.points[r.points.length - 1]!;
      const rs = reached.get(layerKey(s.y));
      if (!rs || nearCell(gridAt(s.y), rs, s.x, s.z, 1.0) < 0) continue;
      routesReached.add(r.id);
      changed = true;
      const list = seeds.get(layerKey(e.y)) ?? [];
      list.push(e);
      seeds.set(layerKey(e.y), list);
      reached.set(layerKey(e.y), flood(gridAt(e.y), list, 1.0));
    }
  }
}
/** Is (x, y, z) on a reached cell of its layer (within `within`)? */
function isReached(x: number, y: number, z: number, within: number): boolean {
  const r = reached.get(layerKey(y));
  return !!r && nearCell(gridAt(y), r, x, z, within) >= 0;
}

// ---------------------------------------------------------------------------------------------
// stance.md level rule: raised parts whose bottom sits 0.6-1.35 m over a walkable top
// ---------------------------------------------------------------------------------------------
function samplePoints(s: Solid): [number, number][] {
  const pts: [number, number][] = [[s.cx, s.cz]];
  const ex = s.shape === 'cyl' ? 0.7 * s.r : s.hx - 0.05;
  const ez = s.shape === 'cyl' ? 0.7 * s.r : s.hz - 0.05;
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    const lx = sx * ex;
    const lz = sz * ez;
    pts.push([s.cx + lx * s.cos + lz * s.sin, s.cz - lx * s.sin + lz * s.cos]);
  }
  return pts;
}
function raisedGaps(all: readonly Solid[]): Set<string> {
  const found = new Set<string>();
  for (const b of all) {
    if (b.prop < 0 || b.y0 <= 0.01) continue;
    for (const [x, z] of samplePoints(b)) {
      let below = 0;
      let filled = false;
      for (const c of all) {
        if (c === b || !footprintContains(c, x, z)) continue;
        if (c.y0 < b.y0 - 0.01 && c.y1 > b.y0 + 0.01) {
          filled = true; // something occupies the space right under b's bottom
          break;
        }
        const t = topAt(c, x, z);
        if (t <= b.y0 + 0.01 && t > below) below = t;
      }
      const gap = b.y0 - below;
      if (!filled && gap >= 0.6 && gap <= 1.35) found.add(b.label);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Real-name blocklist: salted SHA-256 hashes of the lowercased names (single words and "word word" pairs) on the
// reference seat plan, in name-blocklist.json. No plain or reversible name is stored in the repo: the generator that
// holds the plain list lives outside the repo (ask the level-designer to regenerate). A hit reports a count only.
// ---------------------------------------------------------------------------------------------
const NAME_HASHES = new Set<string>(blocklist.hashes as string[]);
/** Hashes of common English words on the list: checked in identifiers and map data only, not in prose. */
const DATA_ONLY_HASHES = new Set<string>(blocklist.dataOnlyHashes as string[]);
const hashToken = (t: string): string => createHash('sha256').update(`${blocklist.salt}:${t}`).digest('hex');

/** Lowercased words and adjacent word pairs, both from the plain text and with camelCase split. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  const lists = [text, text.replace(/([a-z])([A-Z])/g, '$1 $2')].map((t) => t.toLowerCase().split(/[^a-z]+/).filter(Boolean));
  for (const words of lists) {
    words.forEach((w, i) => {
      out.add(w);
      if (i > 0) out.add(`${words[i - 1]} ${w}`);
    });
  }
  return out;
}
/** Number of tokens in `text` whose salted hash is on the blocklist. */
function nameHits(text: string, prose: boolean): number {
  let hits = 0;
  for (const t of tokens(text)) {
    const h = hashToken(t);
    if (NAME_HASHES.has(h) || (!prose && DATA_ONLY_HASHES.has(h))) hits++;
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
describe('office map data', () => {
  it('has the contract identity and the kit', () => {
    expect(map.kind).toBe('indoor');
    expect(map.id).toBe('office');
    expect(map.nameKey).toBe('map.office.name');
    expect(map.carrier).toBe('drone');
    expect(map.kit).toBe(OFFICE_KIT);
    expect(strs[map.nameKey]).toBeTruthy();
    expect(map.floor).toEqual({ minX: -117, maxX: 117, minZ: -72, maxZ: 72 });
    expect(map.ceilingHeight).toBe(27);
  });

  it('is deterministic', () => {
    expect(buildOffice()).toEqual(OFFICE);
  });

  it('passes validateIndoorMap', () => {
    expect(validateIndoorMap(map, stepHeight)).toEqual([]);
  });

  it('derives the plateau heights from the kit', () => {
    expect(OFFICE_DESK_TOP).toBeCloseTo(6.66, 6);
    expect(OFFICE_PONG_TOP).toBeCloseTo(6.84, 6);
    expect(OFFICE_PERCH_TOP).toBeCloseTo(10.44, 6);
  });

  it('has the office.md counts', () => {
    expect(map.playerSpawns).toHaveLength(24);
    expect(map.lootSpawns).toHaveLength(78);
    const tiers = (t: string): number => map.lootSpawns.filter((l) => l.tier === t).length;
    expect([tiers('common'), tiers('rare'), tiers('epic')]).toEqual([50, 20, 8]);
    expect(map.zoneCenters).toHaveLength(9);
    expect(map.climbRoutes).toHaveLength(20);
    expect(map.props.filter((p) => p.kind === 'desk')).toHaveLength(44);
    expect(map.props.filter((p) => p.kind === 'doorFrame')).toHaveLength(17);
    expect(map.props.length).toBeGreaterThan(450);
    expect(map.props.length).toBeLessThan(800);
  });

  it('uses the narrative POI ids, each with a name and a short name', () => {
    expect(map.pois.map((p) => p.id).sort()).toEqual([...POI_IDS].sort());
    for (const p of map.pois) {
      expect(p.nameKey).toBe(`poi.${p.id}`);
      expect(strs[p.nameKey], p.nameKey).toBeTruthy();
      expect(strs[`${p.nameKey}.short`], `${p.nameKey}.short`).toBeTruthy();
    }
  });

  it('keeps zone centres inside the floor inset by 15 m', () => {
    for (const c of map.zoneCenters) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(map.floor.maxX - 15);
      expect(Math.abs(c.z)).toBeLessThanOrEqual(map.floor.maxZ - 15);
    }
    expect(map.zoneCenters[0]).toEqual({ x: 7.84, z: 0 });
  });
});

describe('office walls and doorways', () => {
  it('has 16 interior doorways whose wall gap fits a doorFrame, with a clear opening of at least 3 m', () => {
    const ids = OFFICE_DOORWAYS.map((d) => d.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    expect(ids).toEqual(Array.from({ length: 16 }, (_, i) => `D${i + 1}`));
    expect(OFFICE_DOOR_CLEAR).toBeGreaterThanOrEqual(3);
    expect(OFFICE_DOOR_CLEAR).toBeCloseTo(8.1, 6);
    for (const d of OFFICE_DOORWAYS) {
      const frame = map.props.find((p) => p.kind === 'doorFrame' && Math.abs(p.x - d.x) < 1e-6 && Math.abs(p.z - d.z) < 1e-6);
      expect(frame, d.id).toBeDefined();
      expect(frame!.rotY).toBeCloseTo(d.rotY, 6);
      const alongX = Math.abs(d.rotY) < 1e-6;
      const c = alongX ? d.x : d.z;
      const line = map.walls.filter((w) =>
        alongX ? Math.abs(w.z1 - d.z) < 1e-6 && Math.abs(w.z2 - d.z) < 1e-6 : Math.abs(w.x1 - d.x) < 1e-6 && Math.abs(w.x2 - d.x) < 1e-6,
      );
      const ends = line.map((w) => (alongX ? [Math.min(w.x1, w.x2), Math.max(w.x1, w.x2)] : [Math.min(w.z1, w.z2), Math.max(w.z1, w.z2)]));
      for (const [lo, hi] of ends) expect(c <= lo! || c >= hi!, `${d.id} is not inside a wall`).toBe(true);
      const before = Math.max(...ends.map(([, hi]) => hi!).filter((v) => v <= c));
      const after = Math.min(...ends.map(([lo]) => lo!).filter((v) => v >= c));
      expect(after - before, d.id).toBeCloseTo(OFFICE_DOOR_GAP, 2);
    }
  });

  it('has full-height walls of 0.9 m and no wall inside another doorway', () => {
    for (const w of map.walls) {
      expect(w.bottom).toBe(0);
      expect(w.top).toBe(27);
      expect(w.thickness).toBeCloseTo(0.9, 6);
    }
  });

  it('can walk through every doorway from both sides', () => {
    for (const d of OFFICE_DOORWAYS) {
      const n = Math.abs(d.rotY) < 1e-6 ? { x: 0, z: 1 } : { x: 1, z: 0 };
      for (const s of [-2.5, 2.5]) {
        expect(isReached(d.x + n.x * s, 0, d.z + n.z * s, 1.0), `${d.id} side ${s}`).toBe(true);
      }
    }
  });
});

describe('office climb routes', () => {
  it('gives each deck walk and jump routes, and every room plateau two', () => {
    const by = (plateau: string): typeof map.climbRoutes => map.climbRoutes.filter((r) => r.plateau === plateau);
    for (const deck of ['upper', 'lower']) {
      expect(by(deck).filter((r) => r.mode === 'walk').length, deck).toBeGreaterThanOrEqual(2);
      expect(by(deck).filter((r) => r.mode === 'jump').length, deck).toBeGreaterThanOrEqual(2);
    }
    for (const p of ['exec', 'yellow']) expect(by(p).length, p).toBeGreaterThanOrEqual(2);
    for (const p of ['pongW', 'pongE', 'perchNE', 'perchSW']) expect(by(p).length, p).toBeGreaterThanOrEqual(1);
  });

  it('keeps every waypoint rise at or below the 0.95 m jump cap, and walk routes within stepHeight', () => {
    expect(CLIMB_JUMP_RISE_MAX).toBe(0.95);
    for (const r of map.climbRoutes) {
      for (let k = 1; k < r.points.length; k++) {
        const rise = r.points[k]!.y - r.points[k - 1]!.y;
        expect(rise, `${r.id}[${k}]`).toBeLessThanOrEqual(CLIMB_JUMP_RISE_MAX + 1e-9);
        if (r.mode === 'walk') expect(rise, `${r.id}[${k}] walk`).toBeLessThanOrEqual(stepHeight + 1e-9);
      }
    }
  });

  it('follows the sim stair rule on ramps (one waypoint per compiled step)', () => {
    expect(RAMP_STEP_RISE).toBeCloseTo(0.8 * stepHeight, 9);
    const n = Math.ceil(OFFICE_DESK_TOP / RAMP_STEP_RISE - 1e-9);
    expect(n).toBe(24);
    for (const r of map.climbRoutes.filter((q) => q.mode === 'walk')) expect(r.points, r.id).toHaveLength(n + 2);
  });

  it('puts every waypoint on a real top at its height', () => {
    for (const r of map.climbRoutes) {
      r.points.forEach((p, k) => {
        const top = supportTop(solids, p.x, p.z, p.y + 0.1);
        expect(Math.abs(top - p.y), `${r.id}[${k}] at ${p.x},${p.y},${p.z} stands on ${top}`).toBeLessThanOrEqual(0.05);
      });
    }
  });

  it('keeps every physical step rise (kit tops under the waypoints) at or below the 0.95 m cap', () => {
    for (const r of map.climbRoutes) {
      const tops = r.points.map((p) => supportTop(solids, p.x, p.z, p.y + 0.1));
      for (let k = 1; k < tops.length; k++) {
        expect(tops[k]! - tops[k - 1]!, `${r.id}[${k}]`).toBeLessThanOrEqual(CLIMB_JUMP_RISE_MAX + 1e-9);
      }
    }
  });

  it('reaches every route start from the crossroads', () => {
    expect([...routesReached].sort()).toEqual(map.climbRoutes.map((r) => r.id).sort());
  });
});

describe('office spawns and loot', () => {
  it('keeps every fallback spawn 2.5 m from colliders, near its office.md spot, on reachable floor, with loot nearby', () => {
    map.playerSpawns.forEach((s, i) => {
      expect(spawnIssue(solids, map.floor, s.x, s.z), `spawn ${i + 1}`).toBeNull();
      expect(dist(s, OFFICE_SPAWN_DEFS[i]!), `spawn ${i + 1} nudge`).toBeLessThanOrEqual(OFFICE_NUDGE_MAX + 1e-6);
      expect(isReached(s.x, 0, s.z, 1.5), `spawn ${i + 1} reachable`).toBe(true);
      const near = map.lootSpawns.filter((l) => dist(l, s) <= 25).length;
      expect(near, `spawn ${i + 1} loot within 25 m`).toBeGreaterThanOrEqual(2);
      const nearest = Math.min(...map.playerSpawns.filter((o) => o !== s).map((o) => dist(o, s)));
      expect(nearest, `spawn ${i + 1} spacing`).toBeGreaterThanOrEqual(18);
    });
  });

  it('keeps every spawn 30 m from the open-plan epics (perches, bridges)', () => {
    const openEpics = OFFICE_LOOT_DEFS.map((d, i) => ({ d, l: map.lootSpawns[i]! })).filter(({ d }) => ['E5', 'E6', 'E7', 'E8'].includes(d.id));
    expect(openEpics).toHaveLength(4);
    for (const s of map.playerSpawns) for (const { d, l } of openEpics) expect(dist(s, l), `${d.id} vs ${s.x},${s.z}`).toBeGreaterThanOrEqual(30);
  });

  it('keeps loot clear of props, at its level, and within the nudge of its office.md spot', () => {
    expect(OFFICE_LOOT_DEFS).toHaveLength(map.lootSpawns.length);
    map.lootSpawns.forEach((l, i) => {
      const d = OFFICE_LOOT_DEFS[i]!;
      expect(l.tier, d.id).toBe(d.tier);
      const y = l.y ?? 0;
      const want = { floor: 0, desk: OFFICE_DESK_TOP, pong: OFFICE_PONG_TOP, perch: OFFICE_PERCH_TOP }[d.level];
      expect(y, d.id).toBeCloseTo(want, 2);
      if (d.level === 'floor') expect(l.y, d.id).toBeUndefined();
      expect(lootSpotIssue(solids, map.floor, l.x, y, l.z, stepHeight), d.id).toBeNull();
      expect(dist(l, d), `${d.id} nudge`).toBeLessThanOrEqual(OFFICE_NUDGE_MAX + 1e-6);
    });
  });

  it('puts every epic on a plateau you must climb to', () => {
    for (const l of map.lootSpawns.filter((s) => s.tier === 'epic')) expect(l.y ?? 0).toBeGreaterThan(6);
  });

  it('can reach every loot spot (floor flood, plateaus through climb routes)', () => {
    map.lootSpawns.forEach((l, i) => {
      const y = l.y ?? 0;
      expect(isReached(l.x, y, l.z, y <= 0.01 ? 1.2 : 0.8), `${OFFICE_LOOT_DEFS[i]!.id} at ${l.x},${y},${l.z}`).toBe(true);
    });
  });

  it('can reach every zone centre on the floor', () => {
    for (const c of map.zoneCenters) expect(isReached(c.x, 0, c.z, 1.5), `${c.x},${c.z}`).toBe(true);
  });
});

describe('office stance gaps (stance.md level rule)', () => {
  it('lists every raised part whose bottom sits 0.6-1.35 m above a walkable top as a deliberate gap', () => {
    const found = raisedGaps(solids);
    expect([...found].sort()).toEqual([...DELIBERATE_GAPS].sort());
  });
});

describe('no real names', () => {
  it('has a generated, salted blocklist', () => {
    expect(blocklist.salt.length).toBeGreaterThanOrEqual(16);
    expect(NAME_HASHES.size).toBeGreaterThanOrEqual(30);
    for (const h of [...NAME_HASHES, ...DATA_ONLY_HASHES]) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tokenizes words, camelCase parts and word pairs', () => {
    expect([...tokens('Sales Row deskWood')].sort()).toEqual(['desk', 'desk wood', 'deskwood', 'row', 'row desk', 'row deskwood', 'sales', 'sales row', 'wood'].sort());
    expect(nameHits('Sales Row, Design Bay, Engineering Pit, Corner Office', false)).toBe(0);
  });

  it('finds none of the seat-plan names in the map data', () => {
    expect(nameHits(JSON.stringify(OFFICE), false)).toBe(0);
    expect(nameHits(JSON.stringify(ISLAND), false)).toBe(0);
  });

  it('finds none of the seat-plan names in the player-facing strings or the level doc', () => {
    expect(nameHits(JSON.stringify(strings), true)).toBe(0);
    const doc = readFileSync(new URL('../../../docs/design/levels/office.md', import.meta.url), 'utf8');
    expect(nameHits(doc, true)).toBe(0);
  });

  it('finds none of the seat-plan names in the M2c variety spec and layout data (variety.md LV16)', () => {
    // The variety JSON mixes kind ids with design prose (intents, notes), so it is scanned like prose: names only.
    for (const path of [
      '../../../docs/design/levels/variety.md',
      './variety/office.variety.json',
      './variety/island01.variety.json',
    ]) {
      const text = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(nameHits(text, true), path).toBe(0);
    }
  });
});
