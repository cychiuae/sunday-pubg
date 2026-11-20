/**
 * M2c RPG and rockets (docs/design/systems/rpg.md "Acceptance tests" 1-11, sim side).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import { rocketPosAt } from '../rocket';
import type { ItemLevel, MapData, PropPlacement, SimEvent } from '../types';
import { flatMap, land, noSpreadBalance, playingWorld, roomMap, run } from './testkit';
import type { DebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const B = BALANCE;
const GROUND = 2;
const EYE = B.movement.stances.stand.eyeHeight;
const BIG = (props: PropPlacement[] = []): MapData => flatMap({ islandRadius: 320, worldRadius: 340 }, props);

function shooter(opts: { players?: number; map?: MapData; level?: ItemLevel; reserve?: number } = {}) {
  const { w, ids } = playingWorld(opts.players ?? 2, { map: opts.map ?? BIG(), balance: noSpreadBalance() });
  const s = ids[0]!;
  land(w, s, 0, 0);
  ids.slice(1).forEach((id, i) => land(w, id, 100 + i * 10, 100));
  const p = w.debugPlayer(s)!;
  p.inv.slots[0] = { weapon: 'rpg', mag: 1, level: opts.level ?? 1, scope: null };
  p.inv.activeSlot = 0;
  p.inv.ammo.ammo_rocket = opts.reserve ?? 0;
  return { w, ids, s, p };
}

function fireAndFly(w: DebugWorld, s: number, pitch: number, ticks = 150): SimEvent[] {
  return [...run(w, 1, { [s]: () => ({ fire: true, pitch }) }), ...run(w, ticks, { [s]: () => ({ fire: false, pitch }) })];
}
const chestPitch = (dist: number): number => Math.atan2(B.movement.stances.stand.height * 0.5 - EYE, dist);

describe('rpg (rpg.md acceptance)', () => {
  it('1: level shot from a standing eye hits the flat ground about 53.8 m out; explosion there', () => {
    const { w, s } = shooter();
    const ev = fireAndFly(w, s, 0, 60);
    const fired = ofType(ev, 'rocketFired')[0]!;
    expect(Math.hypot(fired.vel.x, fired.vel.z)).toBeCloseTo(B.weapons.rpg.rocket.speed, 6);
    const ex = ofType(ev, 'explosion')[0]!;
    expect(ex.source).toBe('rocket');
    const dist = Math.hypot(ex.pos.x, ex.pos.z);
    expect(Math.abs(dist - 53.8)).toBeLessThan(1);
    expect(ex.pos.y).toBeCloseTo(GROUND, 0);
    expect(ofType(ev, 'rocketDud')).toEqual([]);
  });

  it('2: fired 20 deg up with nothing to hit: air burst after 120 m of travel', () => {
    const { w, s } = shooter();
    const ev = fireAndFly(w, s, (20 * Math.PI) / 180, 120);
    const ex = ofType(ev, 'explosion')[0]!;
    expect(ex.airburst).toBe(true);
    const fired = ofType(ev, 'rocketFired')[0]!;
    const travelled = Math.hypot(ex.pos.x - fired.pos.x, ex.pos.y - fired.pos.y, ex.pos.z - fired.pos.z);
    expect(Math.abs(travelled - 120)).toBeLessThan(B.weapons.rpg.rocket.speed * SIM_DT + 0.2);
  });

  it('3/4: direct hit at 20 m: 48 (rocket) then 132 (explosion); unarmored dead; vest_2: hp 71.2/vest 35.8 then dead, vest gone', () => {
    for (const vest of [false, true]) {
      const { w, ids, s } = shooter();
      const t = ids[1]!;
      land(w, t, 0, -20);
      const tp = w.debugPlayer(t)!;
      if (vest) tp.vest = { tier: 2, durability: 55 };
      const ev = fireAndFly(w, s, chestPitch(20), 40);
      const dmg = ofType(ev, 'damage').filter((d) => d.victimId === t);
      expect(dmg.map((d) => [d.cause, d.amount])).toEqual([['rocket', 48], ['explosion', 132]]);
      expect(dmg.every((d) => d.weapon === 'rpg' && d.weaponLevel === 1)).toBe(true);
      const order = ev.map((e) => e.type).filter((x) => x === 'damage' || x === 'explosion');
      expect(order.slice(0, 3)).toEqual(['damage', 'explosion', 'damage']);
      expect(ofType(ev, 'explosion')[0]!.direct).toBe(true);
      if (vest) {
        expect(dmg[0]!.hpAfter).toBeCloseTo(71.2, 6);
        expect(dmg[0]!.vest!.absorbed).toBeCloseTo(19.2, 6);
        expect(tp.alive).toBe(false);
        expect(tp.vest).toBeNull();
      } else {
        expect(tp.alive).toBe(false);
        expect(ofType(ev, 'kill')[0]).toMatchObject({ weapon: 'rpg', weaponLevel: 1, direct: true, cause: 'explosion' });
      }
    }
  });

  it('5: L4 direct + blast kills through a fresh vest_2, vest_3 and vest_4', () => {
    for (const [tier, dur] of [[2, 55], [3, 75], [4, 100]] as const) {
      const { w, ids, s } = shooter({ level: 4 });
      const t = ids[1]!;
      land(w, t, 0, -20);
      const tp = w.debugPlayer(t)!;
      tp.vest = { tier, durability: dur };
      fireAndFly(w, s, chestPitch(20), 40);
      expect(tp.alive, `vest_${tier}`).toBe(false);
    }
  });

  it('6: splash: chest 3 m from the blast 75.9; behind a crate 0; helmets never change', () => {
    // Blast at the ground 30 m ahead (rocket into the ground); bystander standing 3 m from the chest-height blast point.
    const crate: PropPlacement = { kind: 'crate', x: 20, z: -30, rotY: 0, scale: 2 };
    const { w, ids, s } = shooter({ players: 3, map: BIG([crate]) });
    const [, open, hidden] = ids as [number, number, number];
    const aimDist = 30;
    const pitch = Math.atan2(GROUND - (GROUND + EYE), aimDist);
    const ev0 = fireAndFly(w, s, pitch, 0);
    // Predict the impact point from the launch record, then place the bystanders before the rocket lands.
    const fired = ofType(ev0, 'rocketFired')[0]!;
    let t = fired.firedAt;
    let pos = rocketPosAt(fired, t, B.weapons.rpg.rocket.gravity);
    while (pos.y > GROUND) {
      t += 1;
      pos = rocketPosAt(fired, t, B.weapons.rpg.rocket.gravity);
    }
    const chestH = B.movement.stances.stand.height * 0.5;
    // open: chest exactly 3 m from the blast point (pulled back collisionRadius along the flight).
    const op = w.debugPlayer(open)!;
    land(w, open, pos.x + Math.sqrt(9 - chestH * chestH), pos.z);
    op.helmet = { tier: 1, durability: 30 };
    land(w, hidden, 20, -34);
    const ev = run(w, 40, { [s]: () => ({}) });
    const dOpen = ofType(ev, 'damage').find((d) => d.victimId === open)!;
    expect(dOpen.amount).toBeGreaterThan(72);
    expect(dOpen.amount).toBeLessThan(79);
    expect(ofType(ev, 'damage').find((d) => d.victimId === hidden)).toBeUndefined();
    expect(op.helmet).toEqual({ tier: 1, durability: 30 });
  });

  it('7: dud: a target 3 m ahead takes 48, no explosion, the shooter takes nothing', () => {
    const { w, ids, s, p } = shooter();
    const t = ids[1]!;
    land(w, t, 0, -3);
    const ev = fireAndFly(w, s, chestPitch(3), 10);
    expect(ofType(ev, 'explosion')).toEqual([]);
    expect(ofType(ev, 'rocketDud')[0]).toMatchObject({ victimId: t, surface: 'player' });
    expect(ofType(ev, 'damage').map((d) => [d.victimId, d.amount, d.cause])).toEqual([[t, 48, 'rocket']]);
    expect(p.hp).toBe(B.player.maxHp);
  });

  it('8: arming: a wall 5.4 m from the eye = dud; 5.8 m = explosion and the shooter takes 0', () => {
    for (const [d, dud] of [[5.4, true], [5.8, false]] as const) {
      const map = roomMap([], [
        { x1: -10, z1: -d - 0.45, x2: 10, z2: -d - 0.45, thickness: 0.9, bottom: 0, top: 27, material: 'solid' },
      ]);
      const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
      const s = ids[0]!;
      land(w, s, 0, 0);
      land(w, ids[1]!, 40, 30);
      const p = w.debugPlayer(s)!;
      p.inv.slots[0] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
      p.inv.activeSlot = 0;
      const ev = fireAndFly(w, s, 0, 10);
      expect(ofType(ev, 'rocketDud').length).toBe(dud ? 1 : 0);
      expect(ofType(ev, 'explosion').length).toBe(dud ? 0 : 1);
      expect(p.hp).toBe(B.player.maxHp);
    }
  });

  it('9: glass: a rocket at an intact pane 20 m away: glassBroken then explosion; a player 2 m behind takes blast damage', () => {
    const map = roomMap([{ kind: 'pane', x: 0, y: 0, z: -20, rotY: 0, scale: 1 }]);
    const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -22.5);
    const p = w.debugPlayer(s)!;
    p.inv.slots[0] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
    p.inv.activeSlot = 0;
    const ev = fireAndFly(w, s, chestPitch(20), 30);
    const types = ev.map((e) => e.type).filter((x) => x === 'glassBroken' || x === 'explosion');
    expect(types).toEqual(['glassBroken', 'explosion']);
    expect(ofType(ev, 'glassBroken')[0]).toMatchObject({ cause: 'rocket', byId: s, paneId: 0 });
    expect(ofType(ev, 'damage').find((d) => d.victimId === t && d.cause === 'explosion')).toBeDefined();
    expect(w.snapshotFor(s).brokenPanes).toEqual([0]);
  });

  it('10: reload after firing with 2 reserve: mag 0 -> 1 after 3800 ms (L4 3040); reserve 1', () => {
    for (const [level, ms] of [[1, 3800], [4, 3040]] as const) {
      const { w, s, p } = shooter({ level, reserve: 2 });
      const ev = fireAndFly(w, s, 0.5, 0);
      expect(ofType(ev, 'reloadStart')[0]!.durationMs).toBeCloseTo(ms, 6);
      run(w, Math.ceil(ms / (SIM_DT * 1000)) + 1, { [s]: () => ({}) });
      expect(p.inv.slots[0]!.mag).toBe(1);
      expect(p.inv.ammo.ammo_rocket).toBe(1);
    }
  });

  it('11: determinism and the snapshot carries the launch record until the rocket ends', () => {
    const go = (): string => {
      const { w, ids, s } = shooter();
      land(w, ids[1]!, 2, -40);
      const first = fireAndFly(w, s, chestPitch(40), 3);
      const snap = w.snapshotFor(ids[1]!);
      expect(snap.rockets.length).toBe(1);
      const { type: _t, ...record } = ofType(first, 'rocketFired')[0]!;
      expect(snap.rockets[0]).toEqual(record);
      const rest = run(w, 80, { [s]: () => ({}) });
      expect(w.snapshotFor(ids[1]!).rockets).toEqual([]);
      return JSON.stringify([...first, ...rest]);
    };
    expect(go()).toBe(go());
  });

  it('SF2: the rocket sweeps a 0.12 m sphere: 0.1 m past a crate edge hits it, 0.2 m passes; same beside a player', () => {
    const rad = B.weapons.rpg.rocket.collisionRadius;
    for (const [gap, hits] of [[0.1, true], [0.2, false]] as const) {
      // Crate (half 0.5) centred 20 m ahead, its +X edge `gap` m to the left of the flight line (x = 0).
      const crate: PropPlacement = { kind: 'crate', x: -0.5 - gap, z: -20, rotY: 0, scale: 1 };
      const { w, s: sh } = shooter({ map: BIG([crate]) });
      const ev = fireAndFly(w, sh, 0, 40);
      const end = [...ofType(ev, 'explosion'), ...ofType(ev, 'rocketDud')][0]!;
      if (hits) expect(Math.abs(end.pos.z - -19.5)).toBeLessThan(0.6);
      else expect(end.pos.z).toBeLessThan(-25);
    }
    for (const [gap, hits] of [[0.1, true], [0.2, false]] as const) {
      const { w, ids, s: sh } = shooter();
      const t = ids[1]!;
      land(w, t, B.player.radius + gap, -20);
      w.debugPlayer(t)!.hp = 1e6;
      const ev = fireAndFly(w, sh, chestPitch(20), 40);
      const direct = ofType(ev, 'damage').some((d) => d.victimId === t && d.cause === 'rocket');
      expect(direct).toBe(hits);
    }
    expect(rad).toBeCloseTo(0.12, 9);
  });
});
