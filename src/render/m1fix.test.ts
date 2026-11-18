/**
 * M1-fix render tests: sim collider alignment (REVIEW-M1 m4), loot tier from LootState (Contract revision 1 #1),
 * name-tag atlas maths, camera blockers derived from sim colliders.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap } from '../game/levels';
import { collidersForProp, DOCK_DECK_HEIGHT, PROP_SHAPES } from '../shared/sim/colliders';
import { heightAt } from '../shared/sim/terrain';
import type { LootState, PropKind, PropPlacement } from '../shared/types';
import { CameraObstacles, segmentBoxEntry, type CameraCollider } from './cameraRig';
import { lootTierOf } from './LootLayer';
import { tagRect } from './NameTags';
import { cameraCollidersFor, DOCK_MODEL_DECK_TOP, propBaseY } from './PropLayer';
import { createProp } from './procedural';

const map = getMap('island01');

/** Top of the solid ('body') geometry of a prop model at scale 1, metres above its origin. */
function modelTop(kind: PropKind): number {
  const root = createProp(kind);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name === 'body') box.expandByObject(o);
  });
  return box.max.y;
}

describe('props line up with sim colliders', () => {
  it('dock deck top equals the sim DOCK_DECK_HEIGHT at any scale', () => {
    for (const scale of [1, 1.2]) {
      const p: PropPlacement = { kind: 'dock', x: 0, z: 200, rotY: 0, scale };
      const deckTop = propBaseY('dock', heightAt(p.x, p.z, map), scale) + DOCK_MODEL_DECK_TOP * scale;
      const simTop = collidersForProp(p, 0, map)[0]!.top;
      expect(deckTop).toBeCloseTo(simTop, 6);
      expect(simTop).toBeCloseTo(DOCK_DECK_HEIGHT * scale, 6);
    }
  });

  it('boats use the sim base rule (float at sea level)', () => {
    const p: PropPlacement = { kind: 'boat', x: 0, z: 200, rotY: 0, scale: 1 };
    const ground = heightAt(p.x, p.z, map);
    const simTop = collidersForProp(p, 0, map)[0]!.top;
    expect(propBaseY('boat', ground) + PROP_SHAPES.boat[0]!.top).toBeCloseTo(simTop, 6);
  });

  // Kinds whose visible body is solid, with the allowed gap (m). Palm crowns, umbrella canopies and torch flames are
  // not cover. Boat: the raised bow and stern (0.79 m) stand above the 0.55 m rim the collider uses. Driftwood is
  // left out on purpose: its branch stub reaches 0.64 m, but the collider stays at 0.35 m so players can hop the log.
  const SOLID: [PropKind, number][] = [['rock', 0.15], ['crate', 0.15], ['hut', 0.15], ['boat', 0.3]];
  for (const [kind, tol] of SOLID) {
    it(`${kind}: model top matches collider top within ${tol} m`, () => {
      const colliderTop = Math.max(...PROP_SHAPES[kind].map((s) => s.top));
      expect(Math.abs(modelTop(kind) - colliderTop)).toBeLessThan(tol);
    });
  }
});

describe('loot tier', () => {
  const spawn = map.lootSpawns.find((s) => s.tier === 'common')!;
  const base: LootState = { id: 1, item: 'bandage', qty: 1, pos: { x: spawn.x, y: 0, z: spawn.z } };

  it('uses LootState.tier when present, even next to a spawn of another tier', () => {
    expect(lootTierOf({ ...base, tier: 'epic' }, map.lootSpawns, 3)).toBe('epic');
  });

  it('falls back to nearest-spawn inference when tier is absent', () => {
    expect(lootTierOf(base, map.lootSpawns, 3)).toBe('common');
    expect(lootTierOf({ ...base, pos: { x: 9999, y: 0, z: 9999 } }, map.lootSpawns, 3)).toBe('common');
  });
});

describe('name tag atlas', () => {
  it('rows map to disjoint, centred UV rectangles (flipY: row 0 at the top)', () => {
    const out = new Float32Array(8);
    tagRect(0, 100, out, 0);
    tagRect(1, 512, out, 4);
    const [u0, v0, u1, v1] = out;
    expect(u0 + u1).toBeCloseTo(1, 6);
    expect(v1).toBeCloseTo(1, 6);
    expect(v0).toBeLessThan(v1);
    expect(out[4]).toBeCloseTo(0, 6);
    expect(out[6]).toBeCloseTo(1, 6);
    expect(out[7]).toBeCloseTo(v0, 6);
  });
});

describe('camera blockers from sim colliders', () => {
  const flat = (): number => 0;

  it('a box blocks a boom that crosses it, padded by the camera radius', () => {
    const box: CameraCollider = { x: 0, z: 3, r: Math.hypot(1, 1), bottom: -Infinity, top: 5, box: { hx: 1, hz: 1, sin: 0, cos: 1 } };
    const o = new CameraObstacles(flat, [box], 50);
    // Pivot at origin, camera 6 m along +Z at y = 1: box face at z = 2, padded by 0.2 -> t = 1.8 / 6.
    expect(o.segmentFraction(0, 1, 0, 0, 1, 6)).toBeCloseTo(1.8 / 6, 5);
    // Above the top: free.
    expect(o.segmentFraction(0, 6, 0, 0, 6, 6)).toBe(1);
    // Passes beside it.
    expect(o.segmentFraction(2, 1, 0, 2, 1, 6)).toBe(1);
  });

  it('rotated boxes use the sim frame', () => {
    const rot = Math.PI / 4;
    const c = { x: 0, z: 0, r: 3, bottom: 0, top: 1, box: { hx: 2, hz: 0.1, sin: Math.sin(rot), cos: Math.cos(rot) } };
    // Local X axis -> world (cos, -sin): the long side runs along (0.707, -0.707).
    expect(segmentBoxEntry(c, 3, -3, -6, 6, 0)).toBeGreaterThan(0); // along the long axis toward the centre
    expect(segmentBoxEntry(c, 3, 3, 0, 1, 0)).toBe(-1); // off to the side
  });

  it('hut camera blockers follow the stepped sim roof', () => {
    const hut = map.props.find((p) => p.kind === 'hut')!;
    const cams = cameraCollidersFor(hut, 0, map, heightAt(hut.x, hut.z, map));
    const sims = collidersForProp(hut, 0, map);
    expect(cams).toHaveLength(sims.length);
    expect(Math.max(...cams.map((c) => c.top))).toBeCloseTo(Math.max(...sims.map((c) => c.top)), 6);
    expect(cams.every((c) => c.box)).toBe(true);
  });

  it('palms use the leaning trunk segments; bushes keep a render-only cylinder; boats do not block', () => {
    const palm = map.props.find((p) => p.kind === 'palm')!;
    expect(cameraCollidersFor(palm, 0, map, 0)).toHaveLength(PROP_SHAPES.palm.length);
    const bush = map.props.find((p) => p.kind === 'bush');
    if (bush) expect(cameraCollidersFor(bush, 0, map, 0)).toHaveLength(1);
    const boat = map.props.find((p) => p.kind === 'boat');
    if (boat) expect(cameraCollidersFor(boat, 0, map, 0)).toHaveLength(0);
  });
});
