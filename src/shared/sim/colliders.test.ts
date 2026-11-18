import { describe, expect, it } from 'vitest';
import { createRng } from '../math';
import { ISLAND } from '../../game/levels/island';
import {
  buildColliders,
  BOAT_MIN_BASE_Y,
  colliderForProp,
  collidersForProp,
  containsPoint,
  DOCK_DECK_HEIGHT,
  lineOfSight,
  overlapsCircle,
  rayCollider,
  raycastColliders,
  resolveCircle,
} from './colliders';
import { lootSpawnsInsideColliders } from './loot';
import { flatMap } from './testkit';

describe('colliders', () => {
  it('derives shapes from kind x scale; bushes are soft', () => {
    const m = flatMap();
    const rock = colliderForProp({ kind: 'rock', x: 0, z: 0, rotY: 0, scale: 2 }, 0, m)!;
    expect(rock.shape).toBe('circle');
    if (rock.shape === 'circle') expect(rock.r).toBeCloseTo(2.8);
    expect(rock.top).toBeCloseTo(m.baseHeight + 2.8);
    expect(colliderForProp({ kind: 'bush', x: 0, z: 0, rotY: 0, scale: 1 }, 0, m)).toBeNull();
    const dock = colliderForProp({ kind: 'dock', x: 0, z: 0, rotY: Math.PI / 2, scale: 1 }, 0, m)!;
    expect(dock.top).toBeCloseTo(DOCK_DECK_HEIGHT);
    // rotY = pi/2: local +Z points to world +X, so the 14 m long axis runs along X.
    expect(containsPoint(dock, 6.5, 0)).toBe(true);
    expect(containsPoint(dock, 0, 6.5)).toBe(false);
    expect(containsPoint(dock, 0, 1.4)).toBe(true);
  });

  it('heights match the procedural models (props.ts): rock 1.4, crate 1, boat 0.55, torch ~2.07, driftwood 0.35', () => {
    const m = flatMap();
    const g = m.baseHeight;
    const top = (kind: Parameters<typeof collidersForProp>[0]['kind'], scale = 1) =>
      Math.max(...collidersForProp({ kind, x: 0, z: 0, rotY: 0, scale }, 0, m).map((c) => c.top)) - g;
    expect(top('rock')).toBeCloseTo(1.4);
    expect(top('crate')).toBeCloseTo(1);
    expect(top('boat')).toBeCloseTo(0.55);
    expect(top('boat', 1.8)).toBeCloseTo(0.99);
    expect(top('tikiTorch')).toBeCloseTo(2.07);
    expect(top('driftwood')).toBeCloseTo(0.35);
    expect(top('umbrella')).toBeLessThan(2.1); // pole stops under the 2.25 m canopy
    expect(top('palm')).toBeCloseTo(6.6);
    expect(top('hut')).toBeCloseTo(5.1);
    // Boats float: base never below BOAT_MIN_BASE_Y even over deep water.
    const sea = flatMap({ baseHeight: -3 });
    const boat = collidersForProp({ kind: 'boat', x: 0, z: 0, rotY: 0, scale: 1 }, 0, sea);
    expect(boat[0]!.top).toBeCloseTo(BOAT_MIN_BASE_Y + 0.55);
  });

  it('hut roof blocks shots up to the thatch and narrows toward the peak', () => {
    const m = flatMap({}, [{ kind: 'hut', x: 0, z: -10, rotY: 0.3, scale: 1 }]);
    const set = buildColliders(m);
    const g = m.baseHeight;
    const ray = (y: number, x = 0) => raycastColliders(set, { x, y: g + y, z: 0 }, { x: 0, y: 0, z: -1 }, 30);
    expect(ray(1)).not.toBeNull(); // walls
    expect(ray(3.6)).not.toBeNull(); // roof (old 3 m box let this through)
    expect(ray(4.3)).not.toBeNull(); // near the peak
    expect(ray(5.3)).toBeNull(); // above the finial
    expect(ray(4.3, 1.5)).toBeNull(); // beside the narrow top of the roof
    expect(ray(3.1, 1.9)).not.toBeNull(); // the wide eaves
  });

  it('leaning palm: upper trunk follows the lean (rotY) and floats, so it neither blocks low shots nor walkers', () => {
    // rotY = pi/2: local +X (the lean) points to world -Z.
    const m = flatMap({}, [{ kind: 'palm', x: 0, z: 0, rotY: Math.PI / 2, scale: 1 }]);
    const set = buildColliders(m);
    const g = m.baseHeight;
    const parts = collidersForProp(m.props[0]!, 0, m);
    expect(parts.length).toBe(3);
    const top = parts[2]!;
    expect(top.z).toBeLessThan(-0.8);
    expect(Math.abs(top.x)).toBeLessThan(1e-9);
    expect(top.bottom).toBeCloseTo(g + 4.5);
    // A shot at 5.5 m aimed across the leaning crown hits; one at 1 m through the same x/z spot does not.
    expect(raycastColliders(set, { x: -5, y: g + 5.5, z: top.z }, { x: 1, y: 0, z: 0 }, 10)).not.toBeNull();
    expect(raycastColliders(set, { x: -5, y: g + 1, z: top.z }, { x: 1, y: 0, z: 0 }, 10)).toBeNull();
    // Walking under the upper trunk is not blocked.
    const out = { x: 0, z: 0 };
    resolveCircle(set, 0, top.z, 0.45, g, 0.3, out, 1.3);
    expect(out.z).toBeCloseTo(top.z, 9);
  });

  it('pushes a circle out of a rock and a rotated crate', () => {
    const m = flatMap({}, [
      { kind: 'rock', x: 0, z: 0, rotY: 0, scale: 1 },
      { kind: 'crate', x: 10, z: 0, rotY: 0.7, scale: 1 },
    ]);
    const set = buildColliders(m);
    const out = { x: 0, z: 0 };
    resolveCircle(set, 1, 0.2, 0.45, 2, 0.3, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(1.85, 5);
    resolveCircle(set, 10.1, 0.1, 0.45, 2, 0.3, out);
    expect(overlapsCircle(set.colliders[1]!, out.x, out.z, 0.449)).toBe(false);
  });

  it('crate blocks a ray at body height but not one passing above it', () => {
    const m = flatMap({}, [{ kind: 'crate', x: 0, z: -5, rotY: 0, scale: 1 }]);
    const set = buildColliders(m);
    const low = raycastColliders(set, { x: 0, y: 2.5, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(low?.t).toBeCloseTo(4.5, 5);
    expect(raycastColliders(set, { x: 0, y: 3.2, z: 0 }, { x: 0, y: 0, z: -1 }, 20)).toBeNull();
    expect(lineOfSight(set, m, { x: 0, y: 2.5, z: 0 }, { x: 0, y: 2.5, z: -10 })).toBe(false);
    expect(lineOfSight(set, m, { x: 0, y: 3.5, z: 0 }, { x: 0, y: 3.5, z: -10 })).toBe(true);
  });

  it('grid DDA ray cast matches brute force on the island', () => {
    const set = buildColliders(ISLAND);
    const rng = createRng(7);
    for (let i = 0; i < 400; i++) {
      const o = { x: rng.range(-100, 100), y: rng.range(2, 6), z: rng.range(-100, 100) };
      const a = rng.range(0, Math.PI * 2);
      const e = rng.range(-0.1, 0.05);
      const d = { x: Math.cos(a) * Math.cos(e), y: Math.sin(e), z: Math.sin(a) * Math.cos(e) };
      let brute = Infinity;
      for (const c of set.colliders) {
        const t = rayCollider(c, o, d, 80);
        if (t >= 0 && t < brute) brute = t;
      }
      const hit = raycastColliders(set, o, d, 80);
      if (brute === Infinity) expect(hit).toBeNull();
      else expect(hit?.t).toBeCloseTo(brute, 9);
    }
  });

  it('island data: no player spawn or loot spawn inside a prop collider', () => {
    const set = buildColliders(ISLAND);
    expect(lootSpawnsInsideColliders(ISLAND, set)).toEqual([]);
    for (const s of ISLAND.playerSpawns) {
      for (const c of set.colliders) expect(overlapsCircle(c, s.x, s.z, 0.45)).toBe(false);
    }
  });
});
