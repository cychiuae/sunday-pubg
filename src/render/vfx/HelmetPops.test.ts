import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/balance';
import type { PlayerState } from '../../shared/types';
import { PlayerViews } from '../PlayerViews';
import { HelmetPops, popLaunch, stepPop, type HelmetPop } from './HelmetPops';

describe('helmet knock-off (HelmetPops)', () => {
  it('launches up and away from the shooter, tumbling about a horizontal axis', () => {
    const vel = new THREE.Vector3(), axis = new THREE.Vector3();
    popLaunch({ x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.5, z: -10 }, 0, vel, axis);
    expect(vel.y).toBeGreaterThan(0);
    expect(vel.z).toBeGreaterThan(0); // shooter at -Z: flies toward +Z
    expect(Math.abs(vel.x)).toBeLessThan(1e-9);
    expect(axis.y).toBe(0);
    expect(axis.dot(new THREE.Vector3(vel.x, 0, vel.z))).toBeCloseTo(0);
    // Shot from straight above: off the back of the character (faces -Z, so yaw 0 -> +Z).
    popLaunch({ x: 3, y: 1.2, z: 3 }, { x: 3, y: 20, z: 3 }, 0, vel, axis);
    expect(vel.z).toBeGreaterThan(0);
  });

  it('falls, bounces to rest on the floor, then shrinks away', () => {
    const obj = new THREE.Object3D();
    obj.position.set(0, 1.3, 0);
    const p: HelmetPop = {
      obj, tier: 2, age: 0, vel: new THREE.Vector3(), axis: new THREE.Vector3(), spin: 13, floorY: 0, baseScale: 1, done: false,
    };
    popLaunch(obj.position, { x: 0, y: 1.3, z: -5 }, 0, p.vel, p.axis);
    let minY = Infinity, alive = true, t = 0;
    const dt = 1 / 60;
    while (alive && t < 5) {
      alive = stepPop(p, dt);
      minY = Math.min(minY, obj.position.y);
      t += dt;
      if (t > 1.6 && t < 1.7) {
        expect(p.vel.y).toBe(0); // at rest
        expect(obj.scale.x).toBe(1);
      }
    }
    expect(alive).toBe(false);
    expect(t).toBeGreaterThan(2);
    expect(t).toBeLessThan(2.5);
    expect(minY).toBeGreaterThanOrEqual(0); // never sinks into the ground
    expect(obj.position.z).toBeGreaterThan(0.5);
    expect(obj.visible).toBe(false);
  });

  it('pools helmet models and reports where each one vanished', () => {
    const gone: number[][] = [];
    const pops = new HelmetPops((x, y, z) => gone.push([x, y, z]));
    const head = new THREE.Matrix4().makeTranslation(0, 1, 0);
    pops.spawn(3, head, { x: 0, y: 1, z: -5 }, 0, 0, true);
    expect(pops.count).toBe(1);
    expect(pops.group.children[0].name).toBe('helmet:3');
    for (let i = 0; i < 200; i++) pops.update(1 / 60);
    expect(pops.count).toBe(0);
    expect(gone.length).toBe(1);
    expect(pops.group.children.length).toBe(0);
    pops.spawn(3, head, { x: 0, y: 1, z: -5 }, 0, 0, true);
    pops.spawn(1, head, { x: 0, y: 1, z: -5 }, 0, 0, false);
    expect(pops.count).toBe(2);
    pops.clear();
    expect(pops.count).toBe(0);
    pops.dispose();
  });
});

describe('PlayerViews.onHelmetBroken', () => {
  const anim = { moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false, healing: false, ads: false, cooking: false };
  const mk = (helmetTier: number): PlayerState => ({
    id: 1, name: 'P1', pos: { x: 0, y: 0, z: 0 }, velY: 0, yaw: 0, pitch: 0, hp: 100, vestTier: 0, helmetTier, alive: true,
    weapon: 'fists', stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, anim: { ...anim }, appearance: { skin: 0, outfit: 0, hair: 0 },
    isBot: true, kills: 0, weaponLevel: null, sight: 'none',
  }) as unknown as PlayerState;
  const frame = (time: number) => ({ time, dt: 1 / 60, serverTime: time * 1000, cam: new THREE.Vector3(0, 2, 10), follow: false, hideId: null, localAds: 0 });
  type Internals = { views: Map<number, { wear: { helmet: number } }>; helmetPops: HelmetPops };

  it('knocks the helmet off at once, even while the interpolated snapshot still shows it', () => {
    const gone: number[] = [];
    const views = new PlayerViews(BALANCE, { onPoof: () => {}, onHelmetGone: () => gone.push(1) });
    const internals = views as unknown as Internals;
    views.update([{ state: mk(2), isLocal: false, isSpectateTarget: false }], frame(1));
    expect(internals.views.get(1)!.wear.helmet).toBe(2);

    views.onHelmetBroken(1, 2, { x: 0, y: 1.5, z: -10 });
    expect(internals.helmetPops.count).toBe(1);
    // Snapshot lags: still says tier 2, but the head is drawn bare.
    views.update([{ state: mk(2), isLocal: false, isSpectateTarget: false }], frame(1.05));
    expect(internals.views.get(1)!.wear.helmet).toBe(0);
    views.update([{ state: mk(0), isLocal: false, isSpectateTarget: false }], frame(1.15));
    expect(internals.views.get(1)!.wear.helmet).toBe(0);
    // A new helmet picked up later is drawn.
    views.update([{ state: mk(3), isLocal: false, isSpectateTarget: false }], frame(1.3));
    expect(internals.views.get(1)!.wear.helmet).toBe(3);
    for (let t = 1.3; t < 4; t += 1 / 60) views.update([{ state: mk(3), isLocal: false, isSpectateTarget: false }], frame(t));
    expect(internals.helmetPops.count).toBe(0);
    expect(gone.length).toBe(1);
    views.dispose();
  });

  it('does not launch a helmet from a body that is not drawn (first-person subject)', () => {
    const views = new PlayerViews(BALANCE, { onPoof: () => {} });
    views.update([{ state: mk(1), isLocal: true, isSpectateTarget: false }], { ...frame(1), hideId: 1 });
    views.onHelmetBroken(1, 1, { x: 0, y: 1.5, z: -10 });
    expect((views as unknown as Internals).helmetPops.count).toBe(0);
    views.dispose();
  });
});
