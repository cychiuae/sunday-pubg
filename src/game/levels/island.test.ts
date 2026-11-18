import { describe, expect, it } from 'vitest';
import { ISLAND, LAND_LIMIT, SAND_INNER, buildIsland, propFootprint } from './island';
import { DEFAULT_MAP_ID, MAPS, getMap } from './index';

type P = { x: number; z: number };
const len = (p: P): number => Math.hypot(p.x, p.z);
const dist = (a: P, b: P): number => Math.hypot(a.x - b.x, a.z - b.z);

const map = ISLAND;
const amp = map.shoreNoise.amplitude;
const footprints = map.props.map((p) => propFootprint(p));
const allCircles = footprints.flat();
const POI_IDS = ['summit', 'rocks', 'dock', 'grove', 'tikibar', 'village', 'wreck'];

describe('island01 map data', () => {
  it('is deterministic', () => {
    const a = buildIsland();
    const b = buildIsland();
    expect(a).toEqual(b);
    expect(a).toEqual(ISLAND);
  });

  it('has the expected identity and POI ids', () => {
    expect(map.id).toBe('island01');
    expect(map.nameKey).toBe('map.island01.name');
    expect(map.pois.map((p) => p.id).sort()).toEqual([...POI_IDS].sort());
    for (const p of map.pois) expect(p.nameKey).toBe(`poi.${p.id}`);
  });

  it('has counts within targets', () => {
    expect(map.props.length).toBeGreaterThanOrEqual(250);
    expect(map.props.length).toBeLessThanOrEqual(400);
    expect(map.playerSpawns.length).toBeGreaterThanOrEqual(20);
    expect(map.lootSpawns.length).toBeGreaterThanOrEqual(60);
    expect(map.lootSpawns.length).toBeLessThanOrEqual(80);
    expect(map.zoneCenters.length).toBeGreaterThanOrEqual(6);
    expect(map.zoneCenters.length).toBeLessThanOrEqual(10);
    const kinds = new Set(map.props.map((p) => p.kind));
    expect(kinds.size).toBe(10);
  });

  it('splits loot tiers roughly 65 / 25 / 10', () => {
    const n = map.lootSpawns.length;
    const frac = (t: string): number => map.lootSpawns.filter((l) => l.tier === t).length / n;
    expect(frac('common')).toBeGreaterThan(0.58);
    expect(frac('common')).toBeLessThan(0.72);
    expect(frac('rare')).toBeGreaterThan(0.18);
    expect(frac('rare')).toBeLessThan(0.32);
    expect(frac('epic')).toBeGreaterThan(0.05);
    expect(frac('epic')).toBeLessThan(0.15);
  });

  it('puts epic loot at no more than 2 POIs and gives every POI at least 4 loot spawns', () => {
    const epicPois = new Set<string>();
    for (const l of map.lootSpawns.filter((s) => s.tier === 'epic')) {
      const poi = map.pois.find((p) => dist(p, l) <= p.radius);
      expect(poi, `epic loot at ${l.x},${l.z} outside any POI`).toBeDefined();
      if (poi) epicPois.add(poi.id);
    }
    expect(epicPois.size).toBeGreaterThanOrEqual(1);
    expect(epicPois.size).toBeLessThanOrEqual(2);
    for (const p of map.pois) {
      expect(map.lootSpawns.filter((l) => dist(p, l) <= p.radius).length, p.id).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps player spawns on the sand ring, fairly spaced, with loot nearby', () => {
    for (const s of map.playerSpawns) {
      expect(len(s)).toBeGreaterThanOrEqual(SAND_INNER);
      expect(len(s)).toBeLessThanOrEqual(LAND_LIMIT);
      const nearestSpawn = Math.min(...map.playerSpawns.filter((o) => o !== s).map((o) => dist(o, s)));
      expect(nearestSpawn).toBeGreaterThan(20);
      expect(nearestSpawn).toBeLessThan(32);
      const lootWithin25 = map.lootSpawns.filter((l) => dist(l, s) <= 25).length;
      expect(lootWithin25, `spawn ${s.x},${s.z}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps props on land, and docks reach from the beach out over water', () => {
    for (const [i, p] of map.props.entries()) {
      const fp = footprints[i] ?? [];
      if (p.kind === 'dock') {
        expect(Math.min(...fp.map((c) => len(c) - c.r))).toBeLessThanOrEqual(map.islandRadius - amp);
        expect(Math.max(...fp.map((c) => len(c) + c.r))).toBeGreaterThanOrEqual(map.islandRadius + amp);
        expect(Math.max(...fp.map((c) => len(c) + c.r))).toBeLessThanOrEqual(map.worldRadius - 2);
      } else {
        for (const c of fp) expect(len(c) + c.r).toBeLessThanOrEqual(LAND_LIMIT + 1e-6);
      }
      expect(p.scale).toBeGreaterThan(0.4);
      expect(p.scale).toBeLessThanOrEqual(2.5);
    }
    expect(map.props.some((p) => p.kind === 'dock')).toBe(true);
  });

  it('keeps loot on land and never inside a prop', () => {
    for (const l of map.lootSpawns) {
      expect(len(l)).toBeLessThanOrEqual(LAND_LIMIT);
      for (const c of allCircles) expect(dist(l, c) - c.r).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('never overlaps props with player spawns', () => {
    for (const s of map.playerSpawns) {
      for (const c of allCircles) expect(dist(s, c) - c.r).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps walkable gaps between props', () => {
    let minGap = Infinity;
    footprints.forEach((fa, i) => {
      for (const fb of footprints.slice(i + 1)) {
        for (const a of fa) for (const b of fb) minGap = Math.min(minGap, dist(a, b) - a.r - b.r);
      }
    });
    expect(minGap).toBeGreaterThanOrEqual(1.9);
  });

  it('keeps zone centres and hills well inland', () => {
    for (const z of map.zoneCenters) expect(len(z)).toBeLessThanOrEqual(50);
    for (const h of map.hills) {
      expect(h.height).toBeLessThanOrEqual(12);
      expect(len(h) + h.radius).toBeLessThanOrEqual(map.islandRadius - map.beachWidth - amp);
    }
  });
});

describe('map registry', () => {
  it('returns island01 and rejects unknown ids', () => {
    expect(MAPS.island01).toBe(ISLAND);
    expect(getMap(DEFAULT_MAP_ID)).toBe(ISLAND);
    expect(getMap('island01')).toBe(ISLAND);
    expect(() => getMap('nope')).toThrow();
    expect(() => getMap('toString')).toThrow();
  });
});
