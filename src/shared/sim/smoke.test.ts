/**
 * M2c smoke grenades and the throwable slot (smoke.md acceptance 1-3, 8, 9, 13, 14; grenades.md 20-25), sim side.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { SimEvent } from '../types';
import { addCloud, deployCloud } from './clouds';
import { stepGrenade, throwLaunch } from './grenade';
import { createMovementContext } from './movement';
import { flatMap, land, playingWorld, run } from './testkit';
import type { DebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const B = BALANCE;
const TICK = SIM_DT * 1000;
const ticks = (ms: number) => Math.ceil(ms / TICK - 1e-9);

function holder(opts: { smokes?: number; grenades?: number; selected?: 'grenade' | 'smoke'; slot?: 0 | 3 } = {}) {
  const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
  const [a, b] = ids as [number, number];
  land(w, a, 0, 0);
  land(w, b, 60, 60);
  const p = w.debugPlayer(a)!;
  p.inv.smokes = opts.smokes ?? 2;
  p.inv.grenades = opts.grenades ?? 0;
  p.inv.selectedThrowable = opts.selected ?? 'smoke';
  p.inv.slots[0] = { weapon: 'rifle', mag: 10, level: 1, scope: null };
  p.inv.activeSlot = opts.slot ?? 3;
  return { w, a, p };
}
const wait = (w: DebugWorld, a: number, ms: number): SimEvent[] => run(w, ticks(ms), { [a]: () => ({}) });

describe('smoke (smoke.md)', () => {
  it('1: a level throw: speed 15, launch pitch 8 deg, first contact 8.0 +- 0.5 m', () => {
    const map = flatMap();
    const ctx = createMovementContext(map, B);
    const eye = { x: 0, y: 2 + B.movement.stances.stand.eyeHeight, z: 0 };
    const l = throwLaunch(eye, 0, 0, false, ctx, 'smoke');
    expect(Math.hypot(l.vel.x, l.vel.y, l.vel.z)).toBeCloseTo(15, 6);
    expect((Math.atan2(l.vel.y, Math.hypot(l.vel.x, l.vel.z)) * 180) / Math.PI).toBeCloseTo(8, 6);
    let body = { pos: l.pos, vel: l.vel, inWater: false };
    for (let i = 0; i < 100; i++) {
      const r = stepGrenade(body, SIM_DT, ctx, 'smoke');
      if (r.contact) {
        expect(Math.abs(Math.hypot(r.contact.pos.x, r.contact.pos.z) - 8)).toBeLessThan(0.5);
        return;
      }
      body = r.body;
    }
    throw new Error('no contact');
  });

  it('2: not cookable: holding 5 s consumes nothing; release throws; the cloud deploys 1800 ms after release', () => {
    const { w, a, p } = holder();
    run(w, ticks(400), { [a]: () => ({}) }); // swap settled
    const held = run(w, ticks(5000), { [a]: () => ({ fire: true }) });
    expect(p.inv.smokes).toBe(2);
    expect(ofType(held, 'grenadeThrown')).toEqual([]);
    const rel = run(w, 1, { [a]: () => ({ fire: false }) });
    const relAt = w.timeMs;
    const thrown = ofType(rel, 'grenadeThrown')[0]!;
    expect(thrown).toMatchObject({ kind: 'smoke', dropped: false, explodesAt: relAt + B.items.smoke.fuseMs });
    expect(p.inv.smokes).toBe(1);
    let dep: Ev<'smokeDeployed'> | undefined;
    for (let i = 0; i < ticks(2500) && !dep; i++) dep = ofType(run(w, 1, { [a]: () => ({}) }), 'smokeDeployed')[0];
    expect(dep).toBeDefined();
    expect(Math.abs(dep!.deployedAt - relAt - B.items.smoke.fuseMs)).toBeLessThanOrEqual(TICK);
    expect(dep!.id).toBe(thrown.id);
    expect(dep!.fadeAt).toBe(dep!.deployedAt + B.items.smoke.cloud.growMs + B.items.smoke.cloud.holdMs);
    expect(ofType(run(w, 1), 'explosion')).toEqual([]);
    const snap = w.snapshotFor(a);
    expect(snap.smokes.map((c) => c.id)).toEqual([thrown.id]);
    expect(snap.grenades).toEqual([]);
    // Gone after the fade.
    wait(w, a, B.items.smoke.cloud.holdMs + B.items.smoke.cloud.growMs + B.items.smoke.cloud.fadeMs + 100);
    expect(w.snapshotFor(a).smokes).toEqual([]);
  });

  it('3: cancel: hold LMB, press 1: nothing thrown, count unchanged', () => {
    const { w, a, p } = holder();
    run(w, ticks(400), { [a]: () => ({}) });
    run(w, 5, { [a]: () => ({ fire: true }) });
    const ev = run(w, 1, { [a]: () => ({ fire: true, selectSlot: 0 }) });
    run(w, 3, { [a]: () => ({ fire: false }) });
    expect(ofType(ev, 'grenadeThrown')).toEqual([]);
    expect(p.inv.smokes).toBe(2);
    expect(p.inv.activeSlot).toBe(0);
  });

  it('8: maxActive: the 13th cloud makes the oldest start its fade at once', () => {
    const cfg = B.items.smoke.cloud;
    const clouds = [] as ReturnType<typeof deployCloud>[];
    for (let i = 1; i <= cfg.maxActive; i++) addCloud(clouds, deployCloud(i, 1, { x: i, y: 0, z: 0 }, false, i * 10, cfg), i * 10, cfg);
    expect(clouds.every((c) => c.fadeAt > 1000)).toBe(true);
    addCloud(clouds, deployCloud(99, 1, { x: 0, y: 0, z: 0 }, false, 1000, cfg), 1000, cfg);
    expect(clouds.find((c) => c.id === 1)!.fadeAt).toBe(1000);
    expect(clouds.filter((c) => c.fadeAt === 1000).length).toBe(1);
  });

  it('9: a canister in water deploys at y = 0', () => {
    expect(deployCloud(1, 1, { x: 0, y: -0.5, z: 0 }, true, 0, B.items.smoke.cloud).pos.y).toBe(0);
  });

  it('13: death with 2 smokes and 1 frag drops two stacks', () => {
    const { w, a, p } = holder({ smokes: 2, grenades: 1 });
    p.hp = 0.001;
    p.dying = { killerId: null, weapon: null, cause: 'zone' };
    run(w, 1);
    const items = w.debugLoot().map((l) => [l.item, l.qty]);
    expect(items).toContainEqual(['smoke', 2]);
    expect(items).toContainEqual(['grenade', 1]);
    void a;
  });
});

describe('throwable slot (grenades.md 20-25)', () => {
  it('20: 2 frags + 1 smoke, holding the rifle: 4 -> 350 ms frag; 4 -> 250 ms smoke; 4 -> frag', () => {
    const { w, a, p } = holder({ grenades: 2, smokes: 1, selected: 'grenade', slot: 0 });
    run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(p.inv.activeSlot).toBe(3);
    expect(p.inv.selectedThrowable).toBe('grenade');
    expect(p.swapRemainingMs).toBeGreaterThan(B.combat.swapMs - TICK - 1e-6);
    wait(w, a, B.combat.swapMs);
    const ev = run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(p.inv.selectedThrowable).toBe('smoke');
    expect(ofType(ev, 'weaponSwitch')[0]).toMatchObject({ weapon: 'smoke', slot: 3 });
    expect(p.swapRemainingMs).toBeGreaterThan(B.combat.throwableCycleMs - TICK - 1e-6);
    expect(p.swapRemainingMs).toBeLessThanOrEqual(B.combat.throwableCycleMs);
    expect(w.snapshotFor(a).players.find((x) => x.id === a)!.weapon).toBe('smoke');
    wait(w, a, B.combat.throwableCycleMs);
    run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(p.inv.selectedThrowable).toBe('grenade');
  });

  it('21/26: only smoke: 4 selects smoke, 4 again does nothing; no throwables: refused noGrenades', () => {
    const { w, a, p } = holder({ grenades: 0, smokes: 1, selected: 'grenade', slot: 0 });
    run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(p.inv.activeSlot).toBe(3);
    expect(p.inv.selectedThrowable).toBe('smoke');
    wait(w, a, B.combat.swapMs);
    const ev = run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(ev.filter((e) => e.type === 'weaponSwitch' || e.type === 'actionFailed')).toEqual([]);
    expect(p.swapRemainingMs).toBe(0);
    const e = holder({ grenades: 0, smokes: 0, slot: 0 });
    const ev2 = run(e.w, 1, { [e.a]: () => ({ selectSlot: 3 }) });
    expect(ofType(ev2, 'actionFailed')[0]).toMatchObject({ action: 'swap', reason: 'noGrenades' });
  });

  it('22: 4 while cooking a frag is ignored; the cook continues', () => {
    const { w, a, p } = holder({ grenades: 2, smokes: 1, selected: 'grenade' });
    wait(w, a, 400);
    run(w, 2, { [a]: () => ({ fire: true }) });
    expect(p.cook).not.toBeNull();
    run(w, 1, { [a]: () => ({ fire: true, selectSlot: 3 }) });
    expect(p.cook).not.toBeNull();
    expect(p.inv.selectedThrowable).toBe('grenade');
  });

  it('23/24: selection persists across slots; the last smoke auto-switches and selects the frag', () => {
    const { w, a, p } = holder({ grenades: 1, smokes: 1, selected: 'smoke', slot: 0 });
    run(w, 1, { [a]: () => ({ selectSlot: 3 }) });
    expect(p.inv.selectedThrowable).toBe('smoke');
    wait(w, a, 400);
    run(w, 2, { [a]: () => ({ fire: true }) });
    run(w, 1, { [a]: () => ({ fire: false }) });
    expect(p.inv.smokes).toBe(0);
    expect(p.inv.activeSlot).toBe(0);
    expect(p.inv.selectedThrowable).toBe('grenade');
  });

  it('25: carrying 3 frags: a frag stack is refused, a smoke stack is accepted (separate stacks)', () => {
    const { w, a, p } = holder({ grenades: 3, smokes: 0, slot: 0 });
    const pos = p.move.pos;
    w.debugLoot().push({ id: 801, item: 'grenade', qty: 2, mag: null, pos: { ...pos }, tier: 'common', durability: null });
    const ev = run(w, 1, { [a]: () => ({ interact: true }) });
    expect(ofType(ev, 'actionFailed')[0]).toMatchObject({ reason: 'inventoryFull' });
    w.debugLoot().length = 0;
    w.debugLoot().push({ id: 802, item: 'smoke', qty: 2, mag: null, pos: { ...pos }, tier: 'common', durability: null });
    run(w, 1, { [a]: () => ({ interact: false }) });
    run(w, 1, { [a]: () => ({ interact: true }) });
    expect(p.inv.smokes).toBe(2);
    expect(w.snapshotFor(a).local).toMatchObject({ smokes: 2, grenades: 3, selectedThrowable: 'smoke' });
  });
});
