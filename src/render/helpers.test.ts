import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { getMap } from '../game/levels';
import { heightAt } from '../shared/sim/terrain';
import type { PlayerAnim } from '../shared/types';
import { computePose, DEATH_POOF_AT_S, makePose, type PoseInput } from './characterPose';
import { tierForPosition } from './LootLayer';
import { propMatrix } from './PropLayer';
import { buildPolarGrid, geometricRadii, ringRadii } from './radialMesh';
import { buildTerrain, terrainColor } from './TerrainMesh';
import { linearRgb, makeSpec, ParticleSystem } from './vfx/Particles';
import { visualHeight } from './visualTerrain';

const map = getMap('island01');

describe('radial mesh', () => {
  it('ring radii are monotonic and hit band edges', () => {
    const r = ringRadii(0, [{ until: 10, step: 3 }, { until: 12, step: 0.5 }]);
    expect(r[0]).toBe(0);
    for (let i = 1; i < r.length; i++) expect(r[i]).toBeGreaterThan(r[i - 1]);
    expect(r).toContain(10);
    expect(r[r.length - 1]).toBe(12);
    const g = geometricRadii(100, 1000, 5);
    expect(g).toHaveLength(5);
    expect(g[4]).toBe(1000);
  });

  it('polar grid faces point up', () => {
    const geo = buildPolarGrid([0, 1, 2], 8);
    geo.computeVertexNormals();
    const n = geo.getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBeGreaterThan(0.99);
    expect(geo.index!.count / 3).toBe(8 + 16);
  });
});

describe('terrain', () => {
  it('matches heightAt within 0.05 m at sampled points (B8)', () => {
    const { mesh } = buildTerrain(map, (x, z) => visualHeight(x, z, map), () => 'sand', map.worldRadius + 45);
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const idx = geo.index!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    let worst = 0;
    // Sample triangle centroids and edge midpoints inside the playable world.
    for (let t = 0; t < idx.count / 3; t += 7) {
      a.fromBufferAttribute(pos, idx.getX(t * 3));
      b.fromBufferAttribute(pos, idx.getX(t * 3 + 1));
      c.fromBufferAttribute(pos, idx.getX(t * 3 + 2));
      for (const [u, v, w] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5]]) {
        const x = a.x * u + b.x * v + c.x * w;
        const z = a.z * u + b.z * v + c.z * w;
        if (Math.hypot(x, z) > map.worldRadius) continue;
        const y = a.y * u + b.y * v + c.y * w;
        worst = Math.max(worst, Math.abs(y - heightAt(x, z, map)));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('visual height equals sim height inside the world and drops off outside', () => {
    expect(visualHeight(50, 20, map)).toBe(heightAt(50, 20, map));
    expect(visualHeight(map.worldRadius, 0, map)).toBe(heightAt(map.worldRadius, 0, map));
    expect(visualHeight(map.worldRadius + 40, 0, map)).toBeLessThan(heightAt(map.worldRadius + 40, 0, map) - 5);
  });

  it('colours: wet sand near the waterline, grass inland', () => {
    expect(terrainColor(0.05, 'sand', 0, 0, 0)).not.toBe(terrainColor(1.5, 'sand', 0, 0, 0));
    expect(terrainColor(3, 'grass', 0, 0, 0)).not.toBe(terrainColor(1.5, 'sand', 0, 0, 0));
  });
});

describe('props', () => {
  it('rotY follows three.js rotation.y: local +Z -> (sin rotY, cos rotY)', () => {
    const m = propMatrix({ kind: 'hut', x: 1, z: 2, rotY: 0.7, scale: 2 }, 3);
    const ref = new THREE.Matrix4().compose(
      new THREE.Vector3(1, 3, 2),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7),
      new THREE.Vector3(2, 2, 2),
    );
    m.elements.forEach((e, i) => expect(e).toBeCloseTo(ref.elements[i], 6));
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(m);
    expect(dir.x).toBeCloseTo(Math.sin(0.7), 6);
    expect(dir.z).toBeCloseTo(Math.cos(0.7), 6);
  });
});

describe('loot tier lookup', () => {
  it('uses the nearest spawn within the radius, else common', () => {
    const spawns = [
      { x: 0, z: 0, tier: 'epic' as const },
      { x: 10, z: 0, tier: 'rare' as const },
    ];
    expect(tierForPosition(spawns, 0.5, 0.2, 2)).toBe('epic');
    expect(tierForPosition(spawns, 9, 0, 2)).toBe('rare');
    expect(tierForPosition(spawns, 5, 0, 2)).toBe('common');
  });
});

describe('character pose', () => {
  const anim = (over: Partial<PlayerAnim> = {}): PlayerAnim => ({
    moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false,
    healing: false, ...over,
  });
  const input = (over: Partial<PoseInput> = {}): PoseInput => ({
    time: 1, anim: anim(), weapon: 'rifle', pitch: 0, speed: 0, sprintSpeed: 7.2, velY: 0, walkPhase: 0, recoil: 0, hit: 0,
    deathTime: -1, seed: 0, ...over,
  });

  it('aims the gun arm forward and follows pitch', () => {
    const p = computePose(input({ pitch: 0.3 }), makePose());
    expect(p.armRX).toBeCloseTo(Math.PI / 2 + 0.3, 6);
    expect(p.weaponVisible).toBe(true);
  });

  it('swings legs in opposition while running', () => {
    const p = computePose(input({ anim: anim({ moving: true, sprinting: true }), speed: 7, walkPhase: Math.PI / 2 }), makePose());
    expect(p.legLX).toBeGreaterThan(0.5);
    expect(p.legRX).toBeCloseTo(-p.legLX, 6);
  });

  it('spreads arms during the drop and hides the weapon', () => {
    const p = computePose(input({ anim: anim({ dropping: true }) }), makePose());
    expect(p.armLZ).toBeLessThan(-1);
    expect(p.armRZ).toBeGreaterThan(1);
    expect(p.rootTiltX).toBeLessThan(-0.5);
    expect(p.weaponVisible).toBe(false);
  });

  it('topples and shrinks to nothing by the poof time', () => {
    const mid = computePose(input({ deathTime: 0.5 }), makePose());
    expect(mid.rootTiltX).toBeGreaterThan(1.3);
    const end = computePose(input({ deathTime: DEATH_POOF_AT_S }), makePose());
    expect(end.scale).toBe(0);
  });

  it('recoil kicks the aim arm up', () => {
    const a = computePose(input(), makePose());
    const b = computePose(input({ recoil: 1 }), makePose());
    expect(b.armRX).toBeGreaterThan(a.armRX);
  });
});

describe('particles', () => {
  it('emits, ages out and never exceeds capacity', () => {
    const ps = new ParticleSystem(4, 0x000000);
    const s = makeSpec();
    s.life = 0.5;
    for (let i = 0; i < 10; i++) ps.emit(s);
    expect(ps.liveCount).toBe(4);
    ps.update(0.25);
    expect(ps.liveCount).toBe(4);
    ps.update(0.3);
    expect(ps.liveCount).toBe(0);
    expect(linearRgb(0xffffff)).toEqual([1, 1, 1]);
  });
});
