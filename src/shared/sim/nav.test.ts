import { describe, expect, it } from 'vitest';
import { BALANCE, balanceForMap } from '../balance';
import { OFFICE } from '../../game/levels/office';
import { validateIndoorMap } from '../maps';
import type { IndoorMapData, Vec3 } from '../types';
import { createMovementContext } from './movement';
import {
  buildNavGraph,
  findPath,
  NAV_AI,
  isReachableNode,
  NavBudget,
  NavGraphData,
  navTuning,
  nearestNode,
  nodePos,
  PathCache,
  pathLength,
  plateauNodes,
  requestPath,
  startNode,
  type NavGraph,
} from './nav';
import { miniOffice, officeLikeBalance, roomsMaze } from './navTestkit';

const OFFICE_B = officeLikeBalance();

function graphOf(map: IndoorMapData, b = OFFICE_B): NavGraph {
  return buildNavGraph(map, createMovementContext(map, b).colliders, b);
}

const spawnPos = (s: { x: number; z: number; y?: number }): Vec3 => ({ x: s.x, y: s.y ?? 0, z: s.z });

/**
 * Deterministic cost bound (no wall clock): requestPath under a NavBudget expands at most maxExpansionsPerTick nodes per
 * tick, finishes within `maxTicks` ticks, and yields exactly the path of the complete (unbudgeted) search.
 */
function budgetedMatchesFull(g: NavGraph, from: Vec3, to: Vec3, maxTicks: number): void {
  const full = findPath(g, from, to, new PathCache(4));
  expect(full).not.toBeNull();
  const cache = new PathCache(4);
  const budget = new NavBudget(2);
  let got: ReturnType<typeof requestPath> = 'wait';
  let ticks = 0;
  for (let t = 0; t < maxTicks && got === 'wait'; t++) {
    got = requestPath(g, from, to, cache, budget, t * 33);
    expect(budget.expanded.n).toBeLessThanOrEqual(NAV_AI.maxExpansionsPerTick);
    ticks = t + 1;
  }
  expect(got, `finished within ${maxTicks} ticks`).not.toBe('wait');
  expect(got).toEqual(full);
  expect(ticks).toBeGreaterThanOrEqual(1);
}

describe('fixtures', () => {
  it('are valid indoor maps', () => {
    expect(validateIndoorMap(miniOffice(), BALANCE.movement.stepHeight)).toEqual([]);
    expect(validateIndoorMap(roomsMaze(), BALANCE.movement.stepHeight)).toEqual([]);
  });
});

describe('buildNavGraph', () => {
  it('is deterministic: the same map and balance give the same hash (one hash per map)', () => {
    for (const make of [miniOffice, roomsMaze]) {
      const a = graphOf(make());
      const b = graphOf(make());
      expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(b.hash).toBe(a.hash);
      expect(b.nodeCount).toBe(a.nodeCount);
      expect(a.mapId).toBe(make().id);
    }
    expect(graphOf(miniOffice()).hash).not.toBe(graphOf(roomsMaze()).hash);
  }, 120_000);

  it('changes the hash when the geometry or the nav balance changes', () => {
    const base = graphOf(miniOffice()).hash;
    const moved = miniOffice();
    moved.props[0] = { ...moved.props[0]!, x: moved.props[0]!.x + 1 };
    expect(graphOf(moved).hash).not.toBe(base);
    const cheaper = officeLikeBalance((b) => {
      b.bots.nav = { ...navTuning(b), climbCostMultiplier: 3 };
    });
    expect(graphOf(miniOffice(), cheaper).hash).not.toBe(base);
  });

  it('links every climb route', () => {
    const g = graphOf(miniOffice()) as NavGraphData;
    expect(g.unlinkedRoutes).toEqual([]);
    expect(g.routeIds).toEqual(['W-STAIRS', 'E-RAMP', 'PERCH', 'ROOM-T']);
  });

  it('builds floor nodes under the desks and plateau nodes on top (layers)', () => {
    const g = graphOf(miniOffice());
    const under = startNode(g, { x: -23.4, y: 0, z: 0.5 });
    const top = startNode(g, { x: -23.4, y: 6.66, z: 0.5 });
    expect(under).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(nodePos(g, under).y).toBe(0);
    expect(nodePos(g, top).y).toBeCloseTo(6.66, 6);
    // Desk leg panels and the outer walls block cells.
    expect(startNode(g, { x: -29.94, y: 0, z: -3 })).not.toBe(-1); // snaps next to the leg
    expect(nodePos(g, startNode(g, { x: -29.94, y: 0, z: -3 })).x).not.toBeCloseTo(-29.94, 0);
  });

  it('every plateau is reachable and every reachable plateau has a way back down (connectivity)', () => {
    const map = miniOffice();
    const g = graphOf(map);
    const pts = [...map.playerSpawns.map(spawnPos), ...map.lootSpawns.map(spawnPos), ...map.zoneCenters.map(spawnPos)];
    const cache = new PathCache(512);
    for (const s of map.lootSpawns) {
      const n = nearestNode(g, spawnPos(s));
      expect(isReachableNode(g, n)).toBe(true);
      // Plateau loot snaps onto its plateau, not to the floor below it.
      expect(nodePos(g, n).y).toBeCloseTo(s.y ?? 0, 1);
    }
    for (const a of pts) {
      for (const b of pts) {
        const path = findPath(g, a, b, cache);
        expect(path, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`).not.toBeNull();
      }
    }
    // Every main-component plateau node can reach the floor spawn and be reached from it.
    const floor = spawnPos(map.playerSpawns[0]!);
    const plats = plateauNodes(g);
    expect(plats.length).toBeGreaterThan(400);
    for (let i = 0; i < plats.length; i += 37) {
      const at = nodePos(g, plats[i]!);
      expect(findPath(g, floor, at, cache)).not.toBeNull();
      expect(findPath(g, at, floor, cache)).not.toBeNull();
    }
  }, 120_000);

  it('only drops where the fall is safe for the effective balance', () => {
    const g = graphOf(miniOffice()) as NavGraphData;
    const b = OFFICE_B.movement;
    const safe = (b.fallDamageMinSpeed * b.fallDamageMinSpeed) / (2 * b.gravity);
    let drops = 0;
    for (let n = 0; n < g.nodeCount; n++) {
      for (let k = g.adjStart[n]!; k < g.adjStart[n + 1]!; k++) {
        if (g.adjKind[k] !== 1) continue;
        drops++;
        expect(g.nodeY[n]! - g.nodeY[g.adjTo[k]!]!).toBeLessThanOrEqual(safe + 1e-6);
      }
    }
    expect(drops).toBeGreaterThan(50);
    // With the island threshold (13 m/s, safe 4.2 m) a desk walk-off is not a link: the way down is a route.
    const island = graphOf(miniOffice(), BALANCE) as NavGraphData;
    let deskDrops = 0;
    for (let n = 0; n < island.nodeCount; n++) {
      for (let k = island.adjStart[n]!; k < island.adjStart[n + 1]!; k++) {
        if (island.adjKind[k] === 1 && island.nodeY[n]! > 6 && island.nodeY[island.adjTo[k]!]! < 0.5) deskDrops++;
      }
    }
    expect(deskDrops).toBe(0);
  });
});

describe('findPath', () => {
  it('climbs a route with jumps on the bookStairs and walks the ramp', () => {
    const map = miniOffice();
    const g = graphOf(map);
    const cache = new PathCache(64);
    // From the west floor to the west end of the plateau: the stairs (jump route).
    const west = findPath(g, { x: -57, y: 0, z: -12 }, { x: -40, y: 6.66, z: -3.4 }, cache)!;
    expect(west.climbs).toBe(1);
    expect(west.jump.filter(Boolean).length).toBeGreaterThanOrEqual(6);
    expect(west.points[west.points.length - 1]!.y).toBeCloseTo(6.66, 6);
    // From the east floor to the east end: the ramp (walk route, no jumps).
    const east = findPath(g, { x: 26, y: 0, z: 12 }, { x: 5, y: 6.66, z: 3.4 }, cache)!;
    expect(east.climbs).toBe(1);
    expect(east.jump.some(Boolean)).toBe(false);
    // Jump flags line up with points.
    expect(west.jump.length).toBe(west.points.length);
    expect(west.length).toBeGreaterThan(Math.hypot(17, 8.6));
  });

  it('goes around walls and through doorways (glass blocks too)', () => {
    const g = graphOf(miniOffice());
    const cache = new PathCache(64);
    // Behind the glass section (x = 30, z 18..30): the straight line is 10 m, the path goes via the doorway at z 0.
    const p = findPath(g, { x: 25, y: 0, z: 24 }, { x: 35, y: 0, z: 24 }, cache)!;
    expect(p.length).toBeGreaterThan(40);
    expect(p.points.some((q) => Math.abs(q.z) < 5 && Math.abs(q.x - 30) < 3)).toBe(true);
  });

  it('is deterministic and smooths open floor to few points', () => {
    const map = roomsMaze();
    const g1 = graphOf(map);
    const g2 = graphOf(roomsMaze());
    const a = findPath(g1, { x: -30, y: 0, z: -30 }, { x: 30, y: 0, z: 30 }, new PathCache(8));
    const b = findPath(g2, { x: -30, y: 0, z: -30 }, { x: 30, y: 0, z: 30 }, new PathCache(8));
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
    expect(a!.points.length).toBeLessThan(20);
    const straight = findPath(g1, { x: -35, y: 0, z: -35 }, { x: -20, y: 0, z: -20 }, new PathCache(8))!;
    expect(straight.points.length).toBeLessThanOrEqual(3);
  });

  it('pathLength is the path polyline length, Infinity when unreachable', () => {
    const g = graphOf(roomsMaze());
    const cache = new PathCache(8);
    const from = { x: -30, y: 0, z: -30 };
    const to = { x: 30, y: 0, z: 30 };
    const len = pathLength(g, from, to, cache);
    expect(len).toBeCloseTo(findPath(g, from, to, cache)!.length, 9);
    expect(len).toBeGreaterThan(Math.hypot(60, 60));
  });

  it('nearestNode snaps points inside props and walls to reachable cells', () => {
    const g = graphOf(miniOffice());
    for (const q of [
      { x: -36 + 5.94, y: 0, z: -3 }, // inside a desk leg
      { x: 30, y: 0, z: -20 }, // inside the room wall
      { x: -48.6, y: 2, z: -3.375 }, // inside the stairs
    ]) {
      const n = nearestNode(g, q);
      expect(isReachableNode(g, n)).toBe(true);
      const at = nodePos(g, n);
      expect(Math.hypot(at.x - q.x, at.z - q.z)).toBeLessThan(4);
    }
  });
});

describe('PathCache and budget', () => {
  it('LRU-caches by (start node, goal node) and evicts the oldest', () => {
    const g = graphOf(roomsMaze());
    const cache = new PathCache(2);
    const A = { x: -30, y: 0, z: -30 };
    const B = { x: 30, y: 0, z: 30 };
    const C = { x: 0, y: 0, z: 0 };
    const D = { x: -27, y: 0, z: 27 };
    const p1 = findPath(g, A, B, cache);
    expect(findPath(g, A, B, cache)).toBe(p1);
    expect(cache.hits).toBe(1);
    findPath(g, A, C, cache);
    findPath(g, A, D, cache); // evicts A->B (least recently used)
    expect(cache.entries).toBe(2);
    const again = findPath(g, A, B, cache);
    expect(again).not.toBe(p1);
    expect(again).toEqual(p1);
  });

  it('limits new searches per tick; cached paths are free', () => {
    const g = graphOf(roomsMaze());
    const cache = new PathCache(16);
    const budget = new NavBudget(2);
    const from = { x: -30, y: 0, z: -30 };
    const goals = [{ x: 30, y: 0, z: 30 }, { x: 0, y: 0, z: 0 }, { x: -27, y: 0, z: 27 }];
    expect(requestPath(g, from, goals[0]!, cache, budget, 100)).not.toBe('wait');
    expect(requestPath(g, from, goals[1]!, cache, budget, 100)).not.toBe('wait');
    expect(requestPath(g, from, goals[2]!, cache, budget, 100)).toBe('wait');
    expect(requestPath(g, from, goals[0]!, cache, budget, 100)).not.toBe('wait'); // cached
    expect(requestPath(g, from, goals[2]!, cache, budget, 133)).not.toBe('wait'); // next tick
  });

  it('a budgeted search spreads over ticks within maxExpansionsPerTick and returns the unbudgeted path', () => {
    budgetedMatchesFull(graphOf(miniOffice()), { x: -57, y: 0, z: -25 }, { x: 55, y: 6.66, z: 25 }, 6);
  });
});

describe('the real office (maps.md acceptance 19)', () => {
  const ob = balanceForMap(BALANCE, 'office');
  const office = (): NavGraph => buildNavGraph(OFFICE, createMovementContext(OFFICE, ob).colliders, ob);
  const g = office();

  it('builds deterministically (one hash per map) and links all climb routes', () => {
    expect(office().hash).toBe(g.hash);
    expect(g.mapId).toBe('office');
    expect((g as NavGraphData).unlinkedRoutes).toEqual([]);
    expect((g as NavGraphData).routeIds.length).toBe(OFFICE.climbRoutes.length);
  }, 120_000);

  it('reaches every player spawn, loot spawn (plateau loot on its plateau) and zone centre, and back', () => {
    const cache = new PathCache(1024);
    const hub = spawnPos(OFFICE.zoneCenters[0]!);
    const targets = [...OFFICE.playerSpawns.map(spawnPos), ...OFFICE.lootSpawns.map(spawnPos), ...OFFICE.zoneCenters.map(spawnPos)];
    for (const q of targets) {
      const n = nearestNode(g, q);
      expect(isReachableNode(g, n), JSON.stringify(q)).toBe(true);
      const at = nodePos(g, n);
      expect(Math.abs(at.y - q.y), `level of ${JSON.stringify(q)}`).toBeLessThan(0.5);
      expect(Math.hypot(at.x - q.x, at.z - q.z), `snap of ${JSON.stringify(q)}`).toBeLessThan(2.5);
      expect(findPath(g, hub, q, cache), `hub -> ${JSON.stringify(q)}`).not.toBeNull();
      expect(findPath(g, q, hub, cache), `${JSON.stringify(q)} -> hub`).not.toBeNull();
    }
  }, 120_000);

  it('every main-component plateau has a way up and a way down', () => {
    const cache = new PathCache(64);
    const floor = spawnPos(OFFICE.zoneCenters[0]!);
    const plats = plateauNodes(g);
    expect(plats.length).toBeGreaterThan(2000);
    for (let i = 0; i < plats.length; i += 97) {
      const at = nodePos(g, plats[i]!);
      const up = findPath(g, floor, at, cache);
      expect(up).not.toBeNull();
      expect(up!.climbs).toBeGreaterThanOrEqual(1);
      expect(findPath(g, at, floor, cache)).not.toBeNull();
    }
  }, 120_000);

  it('a corner-to-corner search is bounded per tick (maxExpansionsPerTick) and matches the unbudgeted path', () => {
    const f = OFFICE.floor;
    for (let i = 0; i < 4; i++) {
      budgetedMatchesFull(g, { x: f.minX + 3, y: 0, z: f.minZ + 3 + 5 * i }, { x: f.maxX - 3, y: 0, z: f.maxZ - 3 - 5 * i }, 12);
    }
  }, 120_000);
});
