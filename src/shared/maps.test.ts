import { describe, expect, it } from 'vitest';
import { carrierHeading, carrierPosAt, isIndoor, mapBounds, mapExtent, validateIndoorMap, wallFrame } from './maps';
import type { DropRoute, IndoorMapData, IslandMapData } from './types';

const indoor = (over: Partial<IndoorMapData> = {}): IndoorMapData => ({
  kind: 'indoor',
  id: 'test_indoor',
  nameKey: 'map.office.name',
  carrier: 'drone',
  floor: { minX: -100, minZ: -50, maxX: 100, maxZ: 50 },
  floorMaterial: 'wood',
  floorZones: [{ minX: 0, minZ: 0, maxX: 10, maxZ: 10, material: 'carpet' }],
  ceilingHeight: 28,
  walls: [{ x1: -10, z1: 0, x2: 10, z2: 0, thickness: 0.5, bottom: 0, top: 27, material: 'glass' }],
  props: [{ kind: 'desk', x: 0, y: 0, z: 0, rotY: 0, scale: 1 }],
  kit: { desk: { origin: 'floor', size: [10, 6.7, 7], colliders: [{ type: 'box', name: 'top', min: [-5, 6, -3], max: [5, 6.7, 3] }] } },
  climbRoutes: [{ id: 'a', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0.9, z: 0 }, { x: 2, y: 1.2, z: 0 }] }],
  playerSpawns: [{ x: 0, z: 0 }],
  lootSpawns: [{ x: 1, z: 1, tier: 'rare', y: 6.7 }],
  zoneCenters: [{ x: 0, z: 0 }],
  pois: [{ id: 'p', nameKey: 'poi.x', x: 0, z: 0, radius: 5 }],
  ...over,
});
const island = { id: 'island01', worldRadius: 135 } as IslandMapData;

describe('maps helpers (ADR 0005)', () => {
  it('bounds and extent per kind', () => {
    expect(isIndoor(indoor())).toBe(true);
    expect(isIndoor(island)).toBe(false);
    expect(mapBounds(island)).toEqual({ minX: -135, minZ: -135, maxX: 135, maxZ: 135 });
    expect(mapBounds(indoor())).toEqual({ minX: -100, minZ: -50, maxX: 100, maxZ: 50 });
    expect(mapExtent(indoor())).toBeCloseTo(Math.hypot(100, 50));
    expect(mapExtent(island)).toBe(135);
  });

  it('wallFrame rotY maps local +X onto the wall direction (Three.js rotation.y convention)', () => {
    const w = wallFrame({ x1: 0, z1: 0, x2: 0, z2: 10, thickness: 1, bottom: 0, top: 3, material: 'solid' });
    expect(w.cx).toBe(0);
    expect(w.cz).toBe(5);
    expect(w.halfLength).toBe(5);
    expect(w.halfThickness).toBe(0.5);
    // local +X -> (cos t, -sin t) must be (0, 1)
    expect(Math.cos(w.rotY)).toBeCloseTo(0);
    expect(-Math.sin(w.rotY)).toBeCloseTo(1);
  });

  it('carrier position and heading follow the route and clamp at both ends', () => {
    const r: DropRoute = {
      mapId: 'island01', entry: { x: 0, z: 100 }, exit: { x: 0, z: -100 }, eject: { x: 0, z: -80 }, altitude: 120,
      speed: 20, startsAt: 1000, noJumpUntil: 4000, ejectAt: 10000, endsAt: 11000,
    };
    expect(carrierPosAt(r, 0)).toEqual({ x: 0, z: 100 });
    expect(carrierPosAt(r, 6000)).toEqual({ x: 0, z: 0 });
    expect(carrierPosAt(r, 99999)).toEqual({ x: 0, z: -100 });
    // Flying toward -Z = yaw 0.
    expect(carrierHeading(r)).toBeCloseTo(0);
  });

  it('validateIndoorMap accepts good data and lists each problem', () => {
    expect(validateIndoorMap(indoor(), 0.35)).toEqual([]);
    const bad = indoor({
      walls: [{ x1: 0, z1: 0, x2: 0, z2: 0, thickness: 0, bottom: 2, top: 1, material: 'solid' }],
      props: [{ kind: 'sofa', x: 0, y: 0, z: 0, rotY: 0, scale: 1 }],
      lootSpawns: [{ x: 500, z: 0, tier: 'common' }],
      climbRoutes: [{ id: 'a', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1.5, z: 0 }] }],
    });
    const errs = validateIndoorMap(bad, 0.35).join('\n');
    expect(errs).toMatch(/walls\[0\]: zero length/);
    expect(errs).toMatch(/walls\[0\]: thickness/);
    expect(errs).toMatch(/walls\[0\]: need 0 <= bottom < top/);
    expect(errs).toMatch(/props\[0\]: kind "sofa"/);
    expect(errs).toMatch(/lootSpawns\[0\] is outside/);
    expect(errs).toMatch(/climbRoutes\.a\[1\]: rise 1\.500/);
  });
});
