import { describe, expect, it } from 'vitest';
import type { CameraView } from '../shared/contracts';
import { aimDirection, rightFromYaw } from '../shared/math';
import { CameraObstacles, CameraRig, desiredCameraPosition } from './cameraRig';

const view = (over: Partial<CameraView> = {}): CameraView => ({
  mode: 'follow',
  target: { x: 0, y: 2, z: 0 },
  yaw: 0,
  pitch: 0,
  distance: 3,
  shoulderOffset: 0.5,
  fovDeg: 70,
  ...over,
});

describe('desiredCameraPosition', () => {
  it('places the camera behind the pivot along -aim and to the right by the shoulder offset', () => {
    for (const [yaw, pitch] of [[0, 0], [1.2, -0.4], [-2.5, 0.6]]) {
      const cam = view({ yaw, pitch });
      const p = desiredCameraPosition(cam, { x: 0, y: 0, z: 0 });
      const aim = aimDirection(yaw, pitch);
      const right = rightFromYaw(yaw);
      expect(p.x).toBeCloseTo(cam.target.x + right.x * 0.5 - aim.x * 3, 6);
      expect(p.y).toBeCloseTo(cam.target.y - aim.y * 3, 6);
      expect(p.z).toBeCloseTo(cam.target.z + right.z * 0.5 - aim.z * 3, 6);
    }
  });

  it('yaw 0 looks toward -Z, so the camera sits at +Z', () => {
    const p = desiredCameraPosition(view({ shoulderOffset: 0 }), { x: 0, y: 0, z: 0 });
    expect(p.z).toBeCloseTo(3, 6);
    expect(p.x).toBeCloseTo(0, 6);
  });
});

describe('CameraObstacles', () => {
  const flat = () => 0;

  it('is unobstructed over flat ground', () => {
    const o = new CameraObstacles(flat, [], 50);
    expect(o.segmentFraction(0, 2, 0, 0, 2, 5)).toBe(1);
  });

  it('stops at a vertical cylinder in the way', () => {
    const o = new CameraObstacles(flat, [{ x: 0, z: 3, r: 0.5, bottom: 0, top: 5 }], 50);
    const f = o.segmentFraction(0, 2, 0, 0, 2, 6);
    // entry at z = 3 - 0.5 - pad(0.2) = 2.3 -> 2.3 / 6
    expect(f).toBeCloseTo(2.3 / 6, 3);
  });

  it('passes over a cylinder that is lower than the segment', () => {
    const o = new CameraObstacles(flat, [{ x: 0, z: 3, r: 0.5, bottom: 0, top: 1 }], 50);
    expect(o.segmentFraction(0, 2, 0, 0, 2, 6)).toBe(1);
  });

  it('ignores a cylinder that contains the pivot', () => {
    const o = new CameraObstacles(flat, [{ x: 0, z: 0, r: 1, bottom: 0, top: 5 }], 50);
    expect(o.segmentFraction(0, 2, 0, 0, 2, 6)).toBe(1);
  });

  it('stops before a hill (terrain plus clearance)', () => {
    // Ground rises to 3 m for z > 2.
    const o = new CameraObstacles((_x, z) => (z > 2 ? 3 : 0), [], 50);
    const f = o.segmentFraction(0, 2, 0, 0, 2, 6);
    expect(f * 6).toBeGreaterThan(1.8);
    expect(f * 6).toBeLessThanOrEqual(2.05);
  });

  it('keeps the camera above the sea surface', () => {
    const o = new CameraObstacles(() => -1, [], 50);
    expect(o.floorAt(0, 0)).toBeCloseTo(0.25, 6);
  });
});

describe('CameraRig', () => {
  it('pulls in immediately and eases back out', () => {
    let wall = true;
    // Height function with a wall behind the player that can be removed.
    const walled = new CameraObstacles((_x, z) => (wall && z > 1.5 ? 10 : 0), [], 50);
    const rig = new CameraRig(walled);
    const cam = view({ shoulderOffset: 0, pitch: 0 });
    rig.update(cam, 1 / 60);
    expect(rig.actualDistance).toBeLessThan(1.6);
    wall = false;
    rig.update(cam, 1 / 60);
    const afterOne = rig.actualDistance;
    expect(afterOne).toBeLessThan(3);
    for (let i = 0; i < 240; i++) rig.update(cam, 1 / 60);
    expect(rig.actualDistance).toBeCloseTo(3, 2);
  });

  it('never puts the camera below terrain even when the pivot is low', () => {
    const rig = new CameraRig(new CameraObstacles(() => 1, [], 50));
    const p = rig.update(view({ target: { x: 0, y: 1.1, z: 0 }, pitch: 0.8 }), 1 / 60);
    expect(p.y).toBeGreaterThanOrEqual(1.3 - 1e-6);
  });
});

describe('CameraRig orbit', () => {
  it('does not collide when the orbit pivot is underground, only clamps to the floor', () => {
    const rig = new CameraRig(new CameraObstacles(() => 10, [], 500));
    const p = rig.update(view({ mode: 'orbit', target: { x: 0, y: 0, z: 0 }, pitch: -0.4, distance: 120, shoulderOffset: 0 }), 1 / 60, false);
    expect(Math.hypot(p.x, p.z)).toBeGreaterThan(100);
    expect(p.y).toBeGreaterThan(10);
  });
});
