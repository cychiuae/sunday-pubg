/**
 * M2c melee acceptance (docs/design/systems/melee.md "Acceptance tests" 1-12, sim side).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { MeleeId, PropPlacement, SimEvent } from '../types';
import { flatMap, land, noSpreadBalance, playingWorld, roomMap, run } from './testkit';
import type { DebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const GROUND = 2;
const B = BALANCE;
const EYE = B.movement.stances.stand.eyeHeight;
const TICK = SIM_DT * 1000;

/** Attacker at (0, 0) facing -Z with `weapon` in the melee slot; target `dist` m ahead (axis offset `side` m on +X). */
function duel(weapon: MeleeId, dist: number, opts: { side?: number; level?: 1 | 2 | 3 | 4; map?: ReturnType<typeof flatMap> } = {}) {
  const { w, ids } = playingWorld(2, { map: opts.map ?? flatMap(), balance: noSpreadBalance() });
  const [a, t] = ids as [number, number];
  land(w, a, 0, 0);
  land(w, t, opts.side ?? 0, -dist);
  const ap = w.debugPlayer(a)!;
  ap.inv.melee = { weapon, level: opts.level ?? 1 };
  ap.inv.activeSlot = 2;
  const tp = w.debugPlayer(t)!;
  return { w, a, t, ap, tp };
}
const chestPitch = (dist: number): number => Math.atan2(B.movement.stances.stand.height * 0.5 - EYE, dist);

/** Damage events (victim, amount, tick index). */
function damages(ev: SimEvent[]): Ev<'damage'>[] {
  return ofType(ev, 'damage');
}

function hold(w: DebugWorld, a: number, ticks: number, pitch: number, fire = true): { ev: SimEvent[]; at: number[] } {
  const at: number[] = [];
  const all: SimEvent[] = [];
  const click = w.timeMs + TICK;
  for (let i = 0; i < ticks; i++) {
    const ev = run(w, 1, { [a]: () => ({ fire, pitch }) });
    for (const d of damages(ev)) at.push(w.timeMs - click);
    all.push(...ev);
  }
  return { ev: all, at };
}

describe('melee (melee.md acceptance)', () => {
  it('1: knife, click at t = 0 hits for 41 at 100 ms (+-1 tick); holding: 100, 450, 800 ms, the third kills', () => {
    const d = duel('knife', 1.5);
    const r = hold(d.w, d.a, 30, chestPitch(1.5));
    const dmg = damages(r.ev);
    expect(dmg.map((e) => e.amount)).toEqual([41, 41, 41]);
    expect(dmg.every((e) => e.cause === 'melee' && e.weapon === 'knife' && e.weaponLevel === 1)).toBe(true);
    const expected = [100, 450, 800];
    r.at.forEach((t, i) => expect(Math.abs(t - expected[i]!)).toBeLessThanOrEqual(TICK + 1e-6));
    expect(d.tp.alive).toBe(false);
    const kill = ofType(r.ev, 'kill')[0]!;
    expect(kill).toMatchObject({ weapon: 'knife', cause: 'melee', weaponLevel: 1 });
    // meleeSwing events: one per swing, hitAt 100 ms after the click.
    const swings = ofType(r.ev, 'meleeSwing');
    expect(swings.length).toBeGreaterThanOrEqual(3);
    expect(swings[0]).toMatchObject({ weapon: 'knife', level: 1, cycleMs: 350 });
  });

  it('2: machete L1 vs vest_2: 3 hits kill; after 2: hp 25.6, vest 5.4', () => {
    const d = duel('machete', 1.5);
    d.tp.vest = { tier: 2, durability: 55 };
    const p = chestPitch(1.5);
    hold(d.w, d.a, Math.ceil(660 / TICK) + 6, p);
    hold(d.w, d.a, 2, p, false);
    expect(d.tp.hp).toBeCloseTo(25.6, 6);
    expect(d.tp.vest!.durability).toBeCloseTo(5.4, 6);
    hold(d.w, d.a, 30, p);
    expect(d.tp.alive).toBe(false);
  });

  it('3: paddle centre ray on the head: 117 kills unarmored; helmet_1 leaves 13, helmet_2 leaves 28 (balance v9)', () => {
    const head = B.weapons.paddle.damage * B.weapons.paddle.headshotMultiplier;
    expect(head).toBe(117);
    // armor.md: a = min(D, H x f). helmet_1: min(30, 35.1) = 30 -> 87 loss, hp 13. helmet_2: min(45, 46.8) = 45 -> 72 loss, hp 28.
    for (const [helmet, hpLeft] of [[null, 0], ['helmet_1', 13], ['helmet_2', 28]] as const) {
      const d = duel('paddle', 1.5);
      if (helmet) d.tp.helmet = { tier: B.items[helmet].tier, durability: B.items[helmet].durability };
      const headPitch = Math.atan2(B.movement.stances.stand.height * 0.93 - EYE, 1.5);
      const r = hold(d.w, d.a, 12, headPitch);
      const hit = damages(r.ev)[0]!;
      expect(hit).toMatchObject({ headshot: true, amount: head });
      if (!helmet) {
        expect(d.tp.alive).toBe(false);
        continue;
      }
      const it = B.items[helmet];
      const a = Math.min(it.durability, head * it.absorbFraction);
      expect(d.tp.hp, helmet).toBeCloseTo(B.player.maxHp - (head - a), 6);
      expect(d.tp.hp, helmet).toBeCloseTo(hpLeft, 6);
      expect(d.tp.helmet, helmet).toBeNull();
    }
  });

  it('4: paddle knockback: about 7 m/s along the attacker yaw and >= 2.5 up; prone: horizontal only', () => {
    const d = duel('paddle', 2);
    d.tp.hp = 1e6;
    let ev: SimEvent[] = [];
    for (let i = 0; i < 12 && damages(ev).length === 0; i++) ev = run(d.w, 1, { [d.a]: () => ({ fire: true, pitch: chestPitch(2) }) });
    expect(d.tp.move.vel.z).toBeLessThan(-6.5);
    // The target's own step (same tick) already applied one tick of gravity to the 2.5 m/s lift.
    expect(d.tp.move.vel.y).toBeGreaterThanOrEqual(2.5 - B.movement.gravity * SIM_DT - 1e-9);
    expect(ofType(ev, 'meleeHit')[0]).toMatchObject({ knockback: true, surface: 'player' });

    const q = duel('paddle', 1.2);
    q.tp.hp = 1e6;
    q.tp.move = { ...q.tp.move, stance: 'prone', stanceFrom: 'prone', stanceMs: 0 };
    const pronePitch = Math.atan2(B.movement.stances.prone.height * 0.5 - EYE, 1.2);
    let ev2: SimEvent[] = [];
    for (let i = 0; i < 12 && damages(ev2).length === 0; i++) ev2 = run(q.w, 1, { [q.a]: () => ({ fire: true, pitch: pronePitch }) });
    expect(damages(ev2).length).toBe(1);
    expect(q.tp.move.vel.y).toBe(0);
    // Grounded prone target: ground friction already acted for one step after the 7 m/s push.
    const k = Math.max(0, 1 - B.movement.friction * SIM_DT);
    expect(Math.hypot(q.tp.move.vel.x, q.tp.move.vel.z)).toBeCloseTo(7 * k, 6);
  });

  it('5: sweep: axis 0.7 m off: knife hits body 41; 0.8 m off: knife misses, machete hits 62; never a headshot', () => {
    const level = 0; // aim level
    const k = duel('knife', 1.6, { side: 0.7 });
    k.tp.hp = 1e6;
    const r1 = hold(k.w, k.a, 6, level);
    expect(damages(r1.ev).map((e) => [e.amount, e.headshot])).toEqual([[41, false]]);
    const k2 = duel('knife', 1.6, { side: 0.8 });
    expect(damages(hold(k2.w, k2.a, 6, level).ev)).toEqual([]);
    const m = duel('machete', 1.6, { side: 0.8 });
    m.tp.hp = 1e6;
    expect(damages(hold(m.w, m.a, 10, level).ev).map((e) => [e.amount, e.headshot])).toEqual([[62, false]]);
  });

  it('6: reach: hitbox 2.1 m from the eye is outside knife reach (2.0) and inside machete reach (2.3)', () => {
    const dist = 2.1 + B.player.radius;
    const k = duel('knife', dist);
    expect(damages(hold(k.w, k.a, 6, 0).ev)).toEqual([]);
    const m = duel('machete', dist);
    m.tp.hp = 1e6;
    expect(damages(hold(m.w, m.a, 10, 0).ev).length).toBe(1);
  });

  it('7: a crate between eye and target blocks, even if the capsule overlaps the target', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -1.15, rotY: 0, scale: 1.5 };
    const d = duel('machete', 2.3, { map: flatMap({}, [crate]), side: 0.3 });
    const r = hold(d.w, d.a, 10, 0);
    expect(damages(r.ev)).toEqual([]);
    expect(ofType(r.ev, 'meleeHit')[0]).toMatchObject({ surface: 'prop' });
  });

  it('8: one target only: the nearer one in the capsule is hit', () => {
    const { w, ids } = playingWorld(3, { balance: noSpreadBalance() });
    const [a, near, far] = ids as [number, number, number];
    land(w, a, 0, 0);
    land(w, near, 0.65, -1.2);
    land(w, far, -0.65, -1.6);
    const ap = w.debugPlayer(a)!;
    ap.inv.melee = { weapon: 'machete', level: 1 };
    ap.inv.activeSlot = 2;
    const r = hold(w, a, 10, 0);
    expect(damages(r.ev).map((e) => e.victimId)).toEqual([near]);
  });

  it('9: a swap during the wind-up cancels the swing (no damage)', () => {
    const d = duel('paddle', 1.5);
    d.ap.inv.slots[0] = { weapon: 'pistol', mag: 5 };
    const p = chestPitch(1.5);
    const ev = [...run(d.w, 1, { [d.a]: () => ({ fire: true, pitch: p }) }), ...run(d.w, 1, { [d.a]: () => ({ fire: false, pitch: p, selectSlot: 0 }) }), ...run(d.w, 20, { [d.a]: () => ({ pitch: p }) })];
    expect(ofType(ev, 'meleeSwing').length).toBe(1);
    expect(damages(ev)).toEqual([]);
  });

  it('10: E on a paddle while carrying an L2 knife: the paddle takes the slot, the knife L2 drops; death drops the melee', () => {
    const d = duel('knife', 5, { level: 2 });
    const pos = d.ap.move.pos;
    d.w.debugLoot().push({ id: 900, item: 'paddle', qty: 1, mag: null, pos: { ...pos }, tier: 'rare', durability: null, level: 1 });
    const ev = run(d.w, 1, { [d.a]: () => ({ interact: true }) });
    expect(d.ap.inv.melee).toEqual({ weapon: 'paddle', level: 1 });
    expect(ofType(ev, 'pickup')[0]).toMatchObject({ item: 'paddle', level: 1 });
    expect(d.w.debugLoot().find((l) => l.item === 'knife')).toMatchObject({ level: 2 });
    expect(d.ap.inv.slots).toEqual([null, null]);
    expect(d.w.snapshotFor(d.a).local!.melee).toEqual({ weapon: 'paddle', level: 1 });
    expect(d.w.snapshotFor(d.a).players.find((x) => x.id === d.a)).toMatchObject({ weapon: 'paddle', weaponLevel: 1, sight: 'none' });
    d.ap.hp = 0.0001;
    d.ap.dying = { killerId: null, weapon: null, cause: 'zone' };
    run(d.w, 1);
    expect(d.w.debugLoot().filter((l) => l.item === 'paddle')).toHaveLength(1);
  });

  it('12: knife L4: cycle 280 ms, hit frame 80 ms; a click at 0 lands at 80 ms (+-1 tick) for 51.25', () => {
    const d = duel('knife', 1.5, { level: 4 });
    d.tp.hp = 1e6;
    const r = hold(d.w, d.a, 12, chestPitch(1.5));
    const first = damages(r.ev)[0]!;
    expect(first.amount).toBeCloseTo(51.25, 9);
    expect(first.weaponLevel).toBe(4);
    expect(Math.abs(r.at[0]! - 80)).toBeLessThanOrEqual(TICK + 1e-6);
    expect(ofType(r.ev, 'meleeSwing')[0]).toMatchObject({ cycleMs: 280 });
  });

  it('a prop on the centre ray: meleeHit surface prop, nobody hit', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -1.2, rotY: 0, scale: 1 };
    const d = duel('knife', 3, { map: flatMap({}, [crate]) });
    const ev = hold(d.w, d.a, 6, chestPitch(1.2)).ev;
    expect(ofType(ev, 'meleeHit')[0]).toMatchObject({ surface: 'prop', victimId: null });
    expect(damages(ev)).toEqual([]);
  });
});

describe('glass (melee.md "Glass", acceptance 11)', () => {
  it('a knife centre ray breaks a pane (glassBroken); then a rifle shot passes the opening; an intact pane still stops a pistol', () => {
    const map = roomMap([{ kind: 'pane', x: 0, y: 0, z: -1.5, rotY: 0, scale: 1 }, { kind: 'pane', x: 20, y: 0, z: -1.5, rotY: 0, scale: 1 }]);
    const { w, ids } = playingWorld(3, { map, balance: noSpreadBalance() });
    const [a, t, t2] = ids as [number, number, number];
    land(w, a, 0, 0);
    land(w, t, 0, -4);
    land(w, t2, 20, -4);
    const ap = w.debugPlayer(a)!;
    ap.inv.melee = { weapon: 'knife', level: 1 };
    ap.inv.activeSlot = 2;
    const ev = hold(w, a, 6, 0).ev;
    expect(ofType(ev, 'glassBroken')).toEqual([{ type: 'glassBroken', paneId: 0, pos: expect.any(Object), byId: a, cause: 'melee' }]);
    expect(ofType(ev, 'meleeHit')[0]).toMatchObject({ surface: 'glass', victimId: null });
    expect(damages(ev)).toEqual([]);
    expect(w.snapshotFor(a).brokenPanes).toEqual([0]);
    // Rifle through the opening.
    ap.inv.slots[0] = { weapon: 'rifle', mag: 30 };
    ap.inv.activeSlot = 0;
    run(w, 12, { [a]: () => ({}) });
    const pitch = Math.atan2(B.movement.stances.stand.height * 0.5 - EYE, 4);
    const shot = run(w, 1, { [a]: () => ({ fire: true, pitch }) });
    expect(damages(shot).map((e) => e.victimId)).toEqual([t]);
    // Pistol at the intact pane: stops at the glass.
    land(w, a, 20, 0);
    ap.inv.slots[0] = { weapon: 'pistol', mag: 10 };
    ap.nextFireAt = 0;
    run(w, 12, { [a]: () => ({}) });
    const shot2 = run(w, 1, { [a]: () => ({ fire: true, pitch }) });
    expect(damages(shot2)).toEqual([]);
    expect(ofType(shot2, 'shot')[0]!.impacts[0]!.surface).toBe('glass');
    // Movement passes the broken pane.
    expect(w.debugContext().colliders.broken?.has(0)).toBe(true);
  });
});
