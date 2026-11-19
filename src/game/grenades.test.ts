import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { GRENADE_EXTRAPOLATION_MAX_MS } from '../shared/constants';
import type { GrenadeView } from '../shared/contracts';
import { stepGrenade } from '../shared/sim/grenade';
import { createMovementContext } from '../shared/sim/movement';
import type { GrenadeState } from '../shared/types';
import { ArcPreview, buildGrenadeArc, DEFAULT_DANGER_MARGIN_M, grenadeDanger, GrenadeTracker, sharedGrenadeStep, type GrenadeStepFn } from './grenades';
import { TEST_MAP } from './testFixtures';

const DT = 1 / BALANCE.net.simHz;
const TICK_MS = DT * 1000;

/** Toy physics: constant velocity, no gravity (easy to reason about); counts calls. */
function linear(): { step: GrenadeStepFn; calls: () => number } {
  let n = 0;
  return {
    step: (b, dt) => {
      n++;
      return { pos: { x: b.pos.x + b.vel.x * dt, y: b.pos.y + b.vel.y * dt, z: b.pos.z + b.vel.z * dt }, vel: { ...b.vel }, inWater: b.inWater };
    },
    calls: () => n,
  };
}

const g = (over: Partial<GrenadeState> = {}): GrenadeState => ({
  id: 1,
  ownerId: 7,
  pos: { x: 0, y: 5, z: 0 },
  vel: { x: 3, y: 0, z: 0 },
  explodesAt: 5_000,
  inWater: false,
  kind: 'grenade',
  ...over,
});

describe('GrenadeTracker (ADR 0004 §3 extrapolation)', () => {
  it('extrapolates the snapshot sample to now with the step at SIM_DT, lerping inside the last tick', () => {
    const toy = linear();
    const t = new GrenadeTracker(toy.step, DT);
    t.onSnapshot([g()], 1_000);
    expect(t.views(1_000)[0]!.pos.x).toBeCloseTo(0);
    expect(t.views(1_000 + 2 * TICK_MS)[0]!.pos.x).toBeCloseTo(3 * 2 * DT);
    const v = t.views(1_000 + 2.5 * TICK_MS)[0]!;
    expect(v.pos.x).toBeCloseTo(3 * 2.5 * DT);
    expect(v).toMatchObject({ id: 1, ownerId: 7, explodesAt: 5_000, resting: false });
  });

  it(`caps extrapolation at GRENADE_EXTRAPOLATION_MAX_MS (${GRENADE_EXTRAPOLATION_MAX_MS} ms) past the sample`, () => {
    const t = new GrenadeTracker(linear().step, DT);
    t.onSnapshot([g()], 0);
    const capped = t.views(GRENADE_EXTRAPOLATION_MAX_MS)[0]!.pos.x;
    expect(t.views(10_000)[0]!.pos.x).toBeCloseTo(capped);
    expect(capped).toBeCloseTo((3 * GRENADE_EXTRAPOLATION_MAX_MS) / 1000);
    // Before the sample (clock jitter): no rewind.
    expect(t.views(-50)[0]!.pos.x).toBe(0);
  });

  it('caches stepped bodies per sample; resting grenades are not stepped', () => {
    const toy = linear();
    const t = new GrenadeTracker(toy.step, DT);
    t.onSnapshot([g(), g({ id: 2, vel: { x: 0, y: 0, z: 0 } })], 0);
    t.views(5 * TICK_MS);
    const after = toy.calls();
    t.views(5 * TICK_MS);
    expect(toy.calls()).toBe(after);
    const resting = t.views(5 * TICK_MS).find((v) => v.id === 2)!;
    expect(resting.resting).toBe(true);
    expect(after).toBe(5); // only grenade 1 stepped
  });

  it('grenadeThrown adds a grenade before the snapshot lists it; a newer snapshot re-anchors it', () => {
    const t = new GrenadeTracker(linear().step, DT);
    t.onThrown({ id: 4, ownerId: 2, pos: { x: 1, y: 1, z: 1 }, vel: { x: 0, y: 0, z: -6 }, explodesAt: 4_000 }, 500);
    // An older snapshot (taken before the throw) neither removes nor overrides it.
    t.onSnapshot([], 450);
    expect(t.views(500).map((v) => v.id)).toEqual([4]);
    t.onSnapshot([g({ id: 4, ownerId: 2, pos: { x: 1, y: 1, z: 0 }, vel: { x: 0, y: 0, z: -6 } })], 550);
    expect(t.views(550)[0]!.pos.z).toBeCloseTo(0);
  });

  it('removes on explosion (and ignores stale samples after it) or when a newer snapshot drops it; sorted by id', () => {
    const t = new GrenadeTracker(linear().step, DT);
    t.onSnapshot([g({ id: 3 }), g({ id: 1 }), g({ id: 2 })], 0);
    expect(t.views(0).map((v) => v.id)).toEqual([1, 2, 3]);
    t.onExplosion(2);
    t.onSnapshot([g({ id: 3 }), g({ id: 1 }), g({ id: 2 })], 0);
    expect(t.views(0).map((v) => v.id)).toEqual([1, 3]);
    t.onSnapshot([g({ id: 3 })], 50);
    expect(t.views(50).map((v) => v.id)).toEqual([3]);
    t.reset();
    expect(t.size).toBe(0);
  });

  it('with the shared stepGrenade: the client extrapolation matches stepping the sim directly', () => {
    const ctx = createMovementContext(TEST_MAP, BALANCE);
    const t = new GrenadeTracker(sharedGrenadeStep(() => ctx), DT);
    const start = g({ pos: { x: 0, y: 6, z: 0 }, vel: { x: 4, y: 3, z: 0 } });
    t.onSnapshot([start], 0);
    let body = { pos: start.pos, vel: start.vel, inWater: false };
    for (let i = 0; i < 6; i++) body = stepGrenade(body, DT, ctx).body;
    const v = t.views(6 * TICK_MS)[0]!;
    expect(v.pos.x).toBeCloseTo(body.pos.x, 9);
    expect(v.pos.y).toBeCloseTo(body.pos.y, 9);
  });
});

describe('grenadeDanger (HUD)', () => {
  const view = (id: number, x: number, y: number, z: number): GrenadeView => ({
    id,
    ownerId: 1,
    pos: { x, y, z },
    vel: { x: 0, y: 0, z: 0 },
    explodesAt: 1_000 + id,
    resting: true,
    kind: 'grenade',
  });
  const limit = BALANCE.items.grenade.radius + (BALANCE.items.grenade.dangerMargin ?? DEFAULT_DANGER_MARGIN_M);
  const chest = { x: 0, y: 0, z: 0 };

  it('lists grenades within radius + 2 m (3D), nearest first, with the horizontal distance', () => {
    const list = grenadeDanger([view(1, 0, 0, -5), view(2, 0, 0, -2), view(3, 0, 0, -(limit + 0.1)), view(4, 0, limit, 0.5)], chest, 0, BALANCE, 400);
    expect(list.map((d) => d.id)).toEqual([2, 1]);
    expect(list[0]).toEqual({ id: 2, distance: 2, bearing: 0, explodesAt: 1_002, fuseRemainingMs: 602 });
    expect(grenadeDanger([view(2, 0, 0, -2)], chest, 0, BALANCE, 5_000)[0]!.fuseRemainingMs).toBe(0);
  });

  it('bearing is relative to the camera yaw: 0 ahead, +PI/2 right, PI behind', () => {
    // Yaw 0 looks toward -Z; right is +X.
    const [ahead, right, behind, left] = [view(1, 0, 0, -3), view(2, 3, 0, 0), view(3, 0, 0, 3), view(4, -3, 0, 0)];
    const b = (v: GrenadeView, yaw = 0): number => grenadeDanger([v], chest, yaw, BALANCE, 0)[0]!.bearing;
    expect(b(ahead)).toBeCloseTo(0);
    expect(b(right)).toBeCloseTo(Math.PI / 2);
    expect(b(behind)).toBeCloseTo(Math.PI);
    expect(b(left)).toBeCloseTo(-Math.PI / 2);
    // Turning right by 90 deg (yaw - PI/2) puts the +X grenade ahead.
    expect(b(right, -Math.PI / 2)).toBeCloseTo(0);
  });
});

describe('buildGrenadeArc', () => {
  it('runs the shared throw launch + arc prediction and adds the blast radius', () => {
    const ctx = createMovementContext(TEST_MAP, BALANCE);
    const arc = buildGrenadeArc(
      { eye: { x: 0, y: 10, z: 0 }, yaw: 0, pitch: 0, proneSettled: false, fuseRemainingMs: BALANCE.items.grenade.fuseMs, maxSeconds: 2.5 },
      ctx,
      BALANCE,
    );
    expect(arc.radius).toBe(BALANCE.items.grenade.radius);
    expect(arc.kind).toBe('grenade');
    expect(arc.points.length).toBeGreaterThan(2);
    // Thrown forward (-Z) from the eye.
    expect(arc.points[arc.points.length - 1]!.z).toBeLessThan(arc.points[0]!.z);
    expect(['fuse', 'rest', 'time']).toContain(arc.endReason);
    // A short remaining fuse ends the preview on the fuse.
    const short = buildGrenadeArc(
      { eye: { x: 0, y: 10, z: 0 }, yaw: 0, pitch: 0.5, proneSettled: false, fuseRemainingMs: 200, maxSeconds: 2.5 },
      ctx,
      BALANCE,
    );
    expect(short.endReason).toBe('fuse');
    expect(short.points.length).toBeLessThan(arc.points.length);
  });

  it('M2c (REVIEW-M2c SF3): a smoke throw carries kind smoke, the cloud radius and the smoke fuse', () => {
    const ctx = createMovementContext(TEST_MAP, BALANCE);
    const smoke = BALANCE.items.smoke;
    const arc = buildGrenadeArc(
      { eye: { x: 0, y: 10, z: 0 }, yaw: 0, pitch: 0.5, proneSettled: false, fuseRemainingMs: smoke.fuseMs, maxSeconds: 5, kind: 'smoke' },
      ctx,
      BALANCE,
    );
    expect(arc.kind).toBe('smoke');
    expect(arc.radius).toBe(smoke.cloud.radius);
    // The preview stops on the smoke fuse (or earlier at rest), never past it.
    expect(arc.points.length - 1).toBeLessThanOrEqual(Math.ceil(smoke.fuseMs / (1000 / BALANCE.net.simHz)));
    expect(['fuse', 'rest']).toContain(arc.endReason);
  });
});

describe('ArcPreview (REVIEW-M2a M2)', () => {
  const input = { eye: { x: 0, y: 10, z: 0 }, yaw: 0, pitch: 0, proneSettled: false, fuseRemainingMs: 3000, maxSeconds: 2.5 };

  it('reuses the cached view until the aim, eye or prone flag moves, or the fuse advances a tick', () => {
    const ctx = createMovementContext(TEST_MAP, BALANCE);
    const p = new ArcPreview((i, out) => buildGrenadeArc(i, ctx, BALANCE, out), 1000 / BALANCE.net.simHz);
    const a = p.get(input);
    expect(p.get({ ...input, eye: { x: 0.001, y: 10, z: 0 }, yaw: 1e-5, fuseRemainingMs: 2990 })).toBe(a);
    expect(p.computations).toBe(1);
    const pts = a.points;
    const b = p.get({ ...input, yaw: 0.2 });
    expect(p.computations).toBe(2);
    // One reused buffer: the points array (and its objects) survive across computations.
    expect(b.points).toBe(pts);
    p.get({ ...input, yaw: 0.2, fuseRemainingMs: 2900 });
    p.get({ ...input, yaw: 0.2, fuseRemainingMs: 2900, proneSettled: true });
    expect(p.computations).toBe(4);
    p.reset();
    p.get(input);
    expect(p.computations).toBe(5);
  });

  it('the reused-buffer arc equals a fresh one', () => {
    const ctx = createMovementContext(TEST_MAP, BALANCE);
    const out = { points: [] as { x: number; y: number; z: number }[] };
    buildGrenadeArc({ ...input, pitch: 0.6 }, ctx, BALANCE, out);
    const reused = buildGrenadeArc(input, ctx, BALANCE, out);
    const fresh = buildGrenadeArc(input, ctx, BALANCE);
    expect(reused.points.map((q) => ({ ...q }))).toEqual(fresh.points);
    expect(reused.end).toEqual(fresh.end);
  });
});
