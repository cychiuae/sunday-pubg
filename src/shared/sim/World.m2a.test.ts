/**
 * M2a acceptance tests on the World (combat.md, armor.md, stance.md, grenades.md). Pure helpers have their own files.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../balance';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { GunId, MapData, PropPlacement, SimEvent, Vec3 } from '../types';
import { bestSlotFor, createBotBrain } from './bots';
import { flatMap, land, noSpreadBalance, playingWorld, run } from './testkit';
import { createDebugWorld, type DebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const ticks = (ms: number) => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);
const GROUND = 2; // flatMap baseHeight
const EYE_Y = GROUND + BALANCE.player.eyeHeight;
const pitchTo = (fromY: number, toY: number, dist: number) => Math.atan2(toY - fromY, dist);
const BIG = (): MapData => flatMap({ islandRadius: 300, worldRadius: 330 });

/** Shooter at (0, 0) facing -Z, target `dist` m away. */
function duel(dist: number, gun: GunId, opts: { balance?: Balance; map?: MapData; mag?: number; reserve?: number } = {}) {
  const { w, ids } = playingWorld(2, { map: opts.map ?? BIG(), balance: opts.balance ?? noSpreadBalance() });
  const [s, t] = ids as [number, number];
  land(w, s, 0, 0);
  land(w, t, 0, -dist);
  const sp = w.debugPlayer(s)!;
  sp.inv.slots[0] = { weapon: gun, mag: opts.mag ?? BALANCE.weapons[gun].magSize };
  sp.inv.activeSlot = 0;
  sp.inv.ammo[BALANCE.weapons[gun].ammo!] = opts.reserve ?? 0;
  const tp = w.debugPlayer(t)!;
  return { w, s, t, sp, tp, body: pitchTo(EYE_Y, GROUND + 0.5, dist), head: pitchTo(EYE_Y, GROUND + 1.0, dist) };
}

/** One trigger click (press on one tick, release on the next), ignoring the fire interval. */
function click(w: DebugWorld, id: number, pitch: number): SimEvent[] {
  const p = w.debugPlayer(id)!;
  p.nextFireAt = 0;
  const s = p.inv.slots[0];
  if (s) s.mag = BALANCE.weapons[s.weapon].magSize;
  return [...run(w, 1, { [id]: () => ({ fire: true, pitch }) }), ...run(w, 1, { [id]: () => ({ fire: false, pitch }) })];
}

describe('combat (combat.md M2a acceptance)', () => {
  it('AT6: sniper fires once while held; a click 1000 ms later does nothing; at >= 1400 ms it fires', () => {
    const d = duel(20, 'sniper', { reserve: 10 });
    d.tp.hp = 1e6;
    const held = run(d.w, 20, { [d.s]: () => ({ fire: true, pitch: d.body }) });
    expect(ofType(held, 'shot').length).toBe(1);
    run(d.w, 10, { [d.s]: () => ({ fire: false, pitch: d.body }) }); // released, now ~1000 ms after the shot
    expect(ofType(run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.body }) }), 'shot').length).toBe(0);
    run(d.w, 14, { [d.s]: () => ({ fire: false, pitch: d.body }) }); // past 1400 ms
    expect(ofType(run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.body }) }), 'shot').length).toBe(1);
  });

  it('AT18: sniper rules at 10 m and 250 m (no falloff)', () => {
    for (const dist of [10, 250]) {
      const shoot = (setup: (t: ReturnType<typeof duel>['tp']) => void, head: boolean) => {
        const d = duel(dist, 'sniper');
        setup(d.tp);
        click(d.w, d.s, head ? d.head : d.body);
        return d.tp;
      };
      expect(shoot(() => {}, false).hp).toBeCloseTo(12, 9);
      const v2 = shoot((t) => (t.vest = { tier: 2, durability: 55 }), false);
      expect(v2.hp).toBeCloseTo(47.2, 9);
      expect(v2.vest!.durability).toBeCloseTo(19.8, 9);
      // A bare head dies; any helmet caps the head loss at combat.helmetHeadshotCap.maxHpLoss (70).
      expect(shoot(() => {}, true).alive).toBe(false);
      for (const [tier, dur] of [[1, 30], [2, 45], [3, 75], [3, 1]] as const) {
        const t = shoot((p) => (p.helmet = { tier, durability: dur }), true);
        expect(t.hp, `helmet_${tier}@${dur}`).toBeCloseTo(30, 9);
        expect(t.helmet, `helmet_${tier}@${dur}`).toBeNull();
      }
      const h4 = shoot((t) => (t.helmet = { tier: 4, durability: 100 }), true);
      expect(h4.hp).toBeCloseTo(30, 9);
      expect(h4.helmet!.durability).toBeCloseTo(3.2, 9);
    }
  });

  it('AT19: shots-to-kill table (forced 0 spread, 5 m)', () => {
    // [gun, no armor body, no armor head, vest_2 body, helmet_2 head, vest_3 body, helmet_3 head]
    const table: [GunId, number, number, number, number, number, number][] = [
      ['pistol', 5, 3, 7, 4, 8, 5],
      ['smg', 6, 4, 10, 6, 11, 7],
      ['shotgun', 1, 1, 2, 1, 2, 1],
      ['rifle', 5, 3, 7, 4, 8, 5],
      ['lmg', 5, 4, 8, 5, 9, 6],
      ['dmr', 2, 2, 4, 2, 4, 2],
      ['sniper', 2, 1, 2, 2, 2, 2],
    ];
    const columns: { head: boolean; armor: 'vest' | 'helmet' | null; tier: 2 | 3 }[] = [
      { head: false, armor: null, tier: 2 },
      { head: true, armor: null, tier: 2 },
      { head: false, armor: 'vest', tier: 2 },
      { head: true, armor: 'helmet', tier: 2 },
      { head: false, armor: 'vest', tier: 3 },
      { head: true, armor: 'helmet', tier: 3 },
    ];
    for (const [gun, ...expected] of table) {
      columns.forEach((col, ci) => {
        const d = duel(5, gun);
        if (col.armor) d.tp[col.armor] = { tier: col.tier, durability: BALANCE.items[`${col.armor}_${col.tier}`].durability };
        let shots = 0;
        while (d.tp.alive && shots < 30) {
          click(d.w, d.s, col.head ? d.head : d.body);
          shots++;
        }
        expect([gun, ci, shots]).toEqual([gun, ci, expected[ci]]);
      });
    }
  });

  it('AT5-like: one shotgun event with head and body pellets routes each sum to its piece', () => {
    const d = duel(3, 'shotgun', { balance: BALANCE });
    d.tp.helmet = { tier: 2, durability: 45 };
    d.tp.vest = { tier: 2, durability: 55 };
    d.tp.hp = 1e6;
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      const ev = click(d.w, d.s, pitchTo(EYE_Y, GROUND + 0.8, 3));
      const dmg = ofType(ev, 'damage');
      if (dmg.length === 0) continue;
      expect(dmg.length).toBe(1);
      const e = dmg[0]!;
      if (e.vest && e.helmet) {
        found = true;
        expect(e.headshot).toBe(true);
        expect(e.helmet.tier).toBe(2);
        expect(e.vest.tier).toBe(2);
      }
      d.tp.helmet = { tier: 2, durability: 45 };
      d.tp.vest = { tier: 2, durability: 55 };
    }
    expect(found).toBe(true);
  });

  it('AT20: DMR body 50 / head 87.5 at 40 m; body 40 at 180 m+', () => {
    const at = (dist: number, head: boolean) => {
      const d = duel(dist + BALANCE.player.radius, 'dmr');
      return ofType(click(d.w, d.s, head ? pitchTo(EYE_Y, GROUND + 1.0, dist) : pitchTo(EYE_Y, GROUND + 0.5, dist)), 'damage')[0]!.amount;
    };
    expect(at(40, false)).toBeCloseTo(50, 6);
    expect(at(40, true)).toBeCloseTo(87.5, 6);
    expect(at(185, false)).toBeCloseTo(40, 6);
  });

  it('AT17: LMG firing slows to 2.75 m/s; 300 ms after the last shot it returns to 5.0', () => {
    const d = duel(30, 'lmg', { reserve: 0 });
    d.tp.hp = 1e9;
    run(d.w, 45, { [d.s]: () => ({ fire: true, moveForward: 1, pitch: 0.5 }) });
    expect(Math.hypot(d.sp.move.vel.x, d.sp.move.vel.z)).toBeCloseTo(2.75, 2);
    run(d.w, 45, { [d.s]: () => ({ fire: false, moveForward: 1 }) });
    expect(Math.hypot(d.sp.move.vel.x, d.sp.move.vel.z)).toBeCloseTo(5, 2);
  });

  it('AT14: a reload start ends ADS; ADS ramps again from 0 after it ends', () => {
    const d = duel(30, 'rifle', { mag: 10, reserve: 50 });
    run(d.w, 10, { [d.s]: () => ({ ads: true }) });
    expect(d.sp.move.adsMs).toBe(BALANCE.weapons.rifle.adsTimeMs);
    run(d.w, 1, { [d.s]: () => ({ ads: true, reload: true }) });
    expect(d.sp.move.adsMs).toBe(0);
    run(d.w, ticks(BALANCE.weapons.rifle.reloadMs) - 2, { [d.s]: () => ({ ads: true }) });
    expect(d.sp.move.adsMs).toBe(0);
    run(d.w, 4, { [d.s]: () => ({ ads: true }) });
    expect(d.sp.move.adsMs).toBeGreaterThan(0);
    expect(d.w.snapshotFor(d.t).players.find((p) => p.id === d.s)!.anim.ads).toBe(true);
  });
});

describe('stance in the World (stance.md AT8, AT17)', () => {
  it('AT8: no shots during a crouch transition with LMB held; resumes on settle; a pistol click in a transition is dropped', () => {
    const d = duel(10, 'rifle', { reserve: 100 });
    d.tp.hp = 1e9;
    const perTick: SimEvent[][] = [];
    for (let i = 0; i < 12; i++) perTick.push(run(d.w, 1, { [d.s]: () => ({ fire: true, pitch: d.body, stanceToggle: i === 0 ? 'crouch' : null }) }));
    expect(ofType(perTick[0]!, 'stanceChange')[0]).toMatchObject({ from: 'stand', to: 'crouch', durationMs: 200 });
    const firstShot = perTick.findIndex((e) => ofType(e, 'shot').length > 0);
    // Transition runs ticks 0..5 (200 ms); the first shot comes on the settle tick or later.
    expect(firstShot).toBeGreaterThanOrEqual(ticks(200) - 1);
    expect(perTick.slice(0, ticks(200) - 1).every((e) => ofType(e, 'shot').length === 0)).toBe(true);
    expect(d.sp.move.stanceMs).toBe(0);

    const p = duel(10, 'pistol', { reserve: 100 });
    p.tp.hp = 1e9;
    run(p.w, 1, { [p.s]: () => ({ stanceToggle: 'prone' }) });
    const click1 = run(p.w, 2, { [p.s]: (i) => ({ fire: i === 0, pitch: p.body }) });
    const after = run(p.w, 30, { [p.s]: () => ({ fire: false, pitch: p.body }) });
    expect(ofType([...click1, ...after], 'shot').length).toBe(0);
  });

  it('AT17: a heal started standing continues through C and Z and completes', () => {
    const { w, ids } = playingWorld(2);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    p.hp = 50;
    p.inv.heals.bandage = 1;
    const ev = run(w, ticks(BALANCE.items.bandage.useMs) + 2, {
      [id]: (i) => ({ useHeal: i === 0, stanceToggle: i === 5 ? 'crouch' : i === 20 ? 'prone' : null }),
    });
    expect(ofType(ev, 'healEnd')[0]).toMatchObject({ completed: true });
    expect(ofType(ev, 'stanceChange').length).toBe(2);
    expect(p.hp).toBe(65);
  });

  it('refused stance requests emit actionFailed stance for humans', () => {
    const { w, ids } = playingWorld(2, { map: flatMap({ baseHeight: -0.3 }) });
    const ev = run(w, 1, { [ids[0]!]: () => ({ stanceToggle: 'prone' }) });
    expect(ofType(ev, 'actionFailed')).toEqual([{ type: 'actionFailed', playerId: ids[0], action: 'stance', reason: 'tooDeep' }]);
  });

  it('snapshots carry stance, progress, armor tiers (public) and durability (owner only)', () => {
    const { w, ids } = playingWorld(2);
    const [a, c] = ids as [number, number];
    w.debugPlayer(a)!.vest = { tier: 2, durability: 31 };
    run(w, 3, { [a]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null }) });
    const snapC = w.snapshotFor(c);
    const pa = snapC.players.find((p) => p.id === a)!;
    expect(pa).toMatchObject({ vestTier: 2, helmetTier: 0, stance: 'prone', stanceFrom: 'stand' });
    expect(pa.stanceProgress).toBeCloseTo(100 / 600, 6);
    expect(snapC.local!.vest).toBeNull();
    expect(w.snapshotFor(a).local).toMatchObject({ vest: { tier: 2, durability: 31 }, helmet: null, grenades: 0, cookExplodesAt: null });
    expect(w.snapshotFor(a).local!.movement.stance).toBe('prone');
  });
});

describe('armor in the World (armor.md)', () => {
  function picker() {
    const { w, ids } = playingWorld(2);
    land(w, ids[1]!, 50, 0);
    const id = ids[0]!;
    land(w, id, 0, 0);
    return { w, id, p: w.debugPlayer(id)! };
  }
  const put = (w: DebugWorld, id: number, item: 'vest_1' | 'vest_2' | 'helmet_1', durability: number) =>
    w.debugLoot().push({ id, item, qty: 1, mag: null, pos: { x: 0, y: GROUND, z: 0.3 }, tier: 'common', durability });

  it('AT5: wearing vest_1 at 20, pick up vest_2 (55): the vest_1 drops with 20', () => {
    const { w, id, p } = picker();
    p.vest = { tier: 1, durability: 20 };
    put(w, 500, 'vest_2', 55);
    const ev = run(w, 1, { [id]: () => ({ interact: true }) });
    expect(ofType(ev, 'pickup')[0]).toMatchObject({ item: 'vest_2', durability: 55 });
    expect(p.vest).toEqual({ tier: 2, durability: 55 });
    const drop = w.debugLoot().find((l) => l.item === 'vest_1')!;
    expect(drop.durability).toBe(20);
    expect(w.snapshotFor(id).loot.find((l) => l.item === 'vest_1')!.durability).toBe(20);
  });

  it('AT6/7: same or lower tier refused betterArmor; a helmet_1 at 12 is worn at 12', () => {
    const { w, id, p } = picker();
    p.vest = { tier: 2, durability: 1 };
    put(w, 501, 'vest_1', 35);
    expect(ofType(run(w, 1, { [id]: () => ({ interact: true }) }), 'actionFailed')[0]).toMatchObject({ action: 'pickup', reason: 'betterArmor' });
    w.debugLoot().length = 0;
    put(w, 502, 'helmet_1', 12);
    run(w, 1, { [id]: () => ({ interact: true }) });
    expect(p.helmet).toEqual({ tier: 1, durability: 12 });
  });

  it('AT10: rifle body hits on a full-HP vest_3 player: 7 hits leave 14 HP, the 8th kills', () => {
    const d = duel(10, 'rifle');
    d.tp.vest = { tier: 3, durability: 75 };
    for (let i = 0; i < 7; i++) click(d.w, d.s, d.body);
    expect(d.tp.hp).toBeCloseTo(14, 6);
    expect(d.tp.vest).toBeNull();
    click(d.w, d.s, d.body);
    expect(d.tp.alive).toBe(false);
  });

  it('AT12: same-tick deaths are placed by hp + vest + helmet durability at the start of the tick', () => {
    const { w, ids } = playingWorld(3, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const [a, c, e] = ids as [number, number, number];
    land(w, a, 0, -200);
    land(w, c, 0, 200);
    land(w, e, 0, 0);
    const pa = w.debugPlayer(a)!;
    const pc = w.debugPlayer(c)!;
    pa.hp = 0.5;
    pa.helmet = { tier: 1, durability: 5 }; // 5.5 total
    pc.hp = 0.7; // 0.7 total
    const kills = ofType(run(w, ticks(BALANCE.zone.damageTickMs) + 1), 'kill');
    expect(kills.find((k) => k.victimId === a)!.placement).toBe(2);
    expect(kills.find((k) => k.victimId === c)!.placement).toBe(3);
  });
});

describe('grenades in the World (grenades.md)', () => {
  function thrower(opts: { map?: MapData; balance?: Balance; players?: number } = {}) {
    const { w, ids } = playingWorld(opts.players ?? 2, { map: opts.map ?? BIG(), balance: opts.balance });
    ids.forEach((id, i) => land(w, id, i * 40, 0));
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    p.inv.grenades = 2;
    p.inv.activeSlot = 3;
    return { w, ids, id, p };
  }
  /** Grenade resting on the ground so the target chest is `d` m away in 3D. */
  const groundAt = (feet: Vec3, d: number): Vec3 => {
    const pos = { y: GROUND + BALANCE.items.grenade.collisionRadius };
    const dy = feet.y + BALANCE.movement.stances.stand.height / 2 - pos.y;
    return { x: feet.x + Math.sqrt(d * d - dy * dy), y: pos.y, z: feet.z };
  };

  it('AT3: cook-out at the eye after 3500 ms kills an unarmored thrower; vest_2 leaves 28 HP and vest 7', () => {
    for (const vest of [null, { tier: 2 as const, durability: 55 }]) {
      const t = thrower();
      t.p.vest = vest;
      const ev: SimEvent[] = [];
      let explodedAt = -1;
      const start = t.w.timeMs;
      for (let i = 0; i < ticks(3600); i++) {
        const e = run(t.w, 1, { [t.id]: () => ({ fire: true }) });
        if (ofType(e, 'explosion').length && explodedAt < 0) explodedAt = t.w.timeMs;
        ev.push(...e);
      }
      expect(ofType(ev, 'grenadeCook').length).toBe(1);
      const cookAt = start + SIM_DT * 1000;
      expect(explodedAt - cookAt).toBeCloseTo(3500, 0);
      expect(ofType(ev, 'explosion')[0]).toMatchObject({ inHand: true, ownerId: t.id });
      if (!vest) expect(t.p.alive).toBe(false);
      else {
        expect(t.p.hp).toBeCloseTo(28, 6);
        expect(t.p.vest!.durability).toBeCloseTo(7, 6);
      }
    }
  });

  it('AT4: release after a 1000 ms cook: entity fuse 2500 ms, explosion 3500 ms after the pin pull (+-1 tick)', () => {
    const t = thrower();
    const n = ticks(1000);
    const ev = run(t.w, n + 1, { [t.id]: (i) => ({ fire: i < n, pitch: 0.3 }) });
    const cook = ofType(ev, 'grenadeCook')[0]!;
    const thrown = ofType(ev, 'grenadeThrown')[0]!;
    expect(thrown.dropped).toBe(false);
    expect(thrown.explodesAt).toBe(cook.explodesAt);
    expect(t.w.snapshotFor(t.id).grenades.map((g) => g.id)).toEqual([thrown.id]);
    expect(t.w.snapshotFor(t.id).local!.throwRecoveryMs).toBeGreaterThan(0);
    const rest = run(t.w, ticks(3000));
    const ex = ofType(rest, 'explosion')[0]!;
    expect(ex.id).toBe(thrown.id);
    expect(t.w.debugGrenades().length).toBe(0);
    expect(cook.explodesAt - (cook.explodesAt - BALANCE.items.grenade.fuseMs)).toBe(3500);
  });

  it('AT5-7: falloff, LOS (crate blocks, bush and players do not), vest only', () => {
    const props: PropPlacement[] = [
      { kind: 'crate', x: 40 + 1.5, z: 0, rotY: 0, scale: 1 },
      { kind: 'bush', x: 80 + 1.5, z: 0, rotY: 0, scale: 1 },
    ];
    const t = thrower({ map: flatMap({ islandRadius: 300, worldRadius: 330 }, props), players: 4 });
    const [, b1, b2, b3] = t.ids as [number, number, number, number];
    const v1 = t.w.debugPlayer(b1)!; // behind the crate
    const v2 = t.w.debugPlayer(b2)!; // behind the bush
    const v3 = t.w.debugPlayer(b3)!; // in the open, vest_2 + helmet_3
    v3.vest = { tier: 2, durability: 55 };
    v3.helmet = { tier: 3, durability: 75 };
    for (const v of [v1, v2, v3]) t.w.debugSpawnGrenade(t.id, groundAt(v.move.pos, 3), { x: 0, y: 0, z: 0 }, 50);
    const ev = run(t.w, 3);
    expect(ofType(ev, 'explosion').length).toBe(3);
    const dmg = ofType(ev, 'damage');
    expect(dmg.find((e) => e.victimId === b1)).toBeUndefined();
    expect(dmg.find((e) => e.victimId === b2)!.amount).toBeCloseTo(79.5, 6);
    const e3 = dmg.find((e) => e.victimId === b3)!;
    expect(e3).toMatchObject({ cause: 'explosion', attackerId: t.id, headshot: false, helmet: null });
    expect(e3.vest!.absorbed).toBeCloseTo(31.8, 6);
    expect(v3.hp).toBeCloseTo(52.3, 6);
    expect(v3.helmet).toEqual({ tier: 3, durability: 75 });
    // Events order: explosion before its damage.
    expect(ev.findIndex((e) => e.type === 'explosion')).toBeLessThan(ev.findIndex((e) => e.type === 'damage'));
  });

  it('AT8: self-kill credits the last enemy within the window, else nobody; weapon grenade', () => {
    for (const credited of [true, false]) {
      const t = thrower();
      const other = t.ids[1]!;
      if (credited) t.p.lastDamagedBy = { id: other, at: t.w.timeMs };
      t.w.debugSpawnGrenade(t.id, groundAt(t.p.move.pos, 2), { x: 0, y: 0, z: 0 }, 50);
      const kill = ofType(run(t.w, 3), 'kill')[0]!;
      expect(kill).toMatchObject({ victimId: t.id, killerId: credited ? other : null, weapon: 'grenade', cause: 'explosion' });
      expect(t.p.hp).toBe(0);
    }
  });

  it('AT9: a grenade kills after its owner died: kill credit to the owner', () => {
    const t = thrower({ players: 3 });
    const victim = t.w.debugPlayer(t.ids[1]!)!;
    victim.hp = 10;
    t.w.debugSpawnGrenade(t.id, groundAt(victim.move.pos, 2), { x: 0, y: 0, z: 0 }, 200);
    t.p.dying = { killerId: null, weapon: null, cause: 'zone' };
    run(t.w, 1);
    expect(t.p.alive).toBe(false);
    const kill = ofType(run(t.w, 10), 'kill')[0]!;
    expect(kill).toMatchObject({ victimId: victim.id, killerId: t.id, weapon: 'grenade' });
    expect(t.p.kills).toBe(1);
  });

  it('AT10: switching to slot 1 after a 1000 ms cook drops a 2 m/s grenade with 2500 ms fuse; the swap completes', () => {
    const t = thrower();
    t.p.inv.slots[0] = { weapon: 'pistol', mag: 12 };
    const n = ticks(1000);
    run(t.w, n, { [t.id]: () => ({ fire: true }) });
    const ev = run(t.w, 1, { [t.id]: () => ({ fire: true, selectSlot: 0 }) });
    const g = ofType(ev, 'grenadeThrown')[0]!;
    expect(g.dropped).toBe(true);
    expect(Math.hypot(g.vel.x, g.vel.z)).toBeCloseTo(BALANCE.items.grenade.dropOnSwitchSpeed, 9);
    expect(g.explodesAt - t.w.timeMs).toBeCloseTo(2500, -2);
    expect(ofType(ev, 'weaponSwitch')[0]).toMatchObject({ weapon: 'pistol', slot: 0 });
    expect(t.p.cook).toBeNull();
  });

  it('AT11: death while cooking drops the grenade at the eye with zero velocity', () => {
    const t = thrower();
    run(t.w, 5, { [t.id]: () => ({ fire: true }) });
    t.p.dying = { killerId: null, weapon: null, cause: 'zone' };
    const ev = run(t.w, 1, { [t.id]: () => ({ fire: true }) });
    const g = ofType(ev, 'grenadeThrown')[0]!;
    expect(g).toMatchObject({ dropped: true, ownerId: t.id, vel: { x: 0, y: 0, z: 0 } });
    expect(g.pos.y).toBeCloseTo(EYE_Y, 6);
    // The stack dropped with the other death drops (one left after the cook).
    expect(t.w.debugLoot().find((l) => l.item === 'grenade')!.qty).toBe(1);
  });

  it('AT15: slot 4 with 0 grenades is refused; throwing the last grenade auto-switches to the last gun slot', () => {
    const t = thrower();
    t.p.inv.slots[1] = { weapon: 'smg', mag: 30 };
    t.p.inv.activeSlot = 1;
    t.p.inv.grenades = 0;
    expect(ofType(run(t.w, 1, { [t.id]: () => ({ selectSlot: 3 }) }), 'actionFailed')[0]).toMatchObject({ action: 'swap', reason: 'noGrenades' });
    t.p.inv.grenades = 1;
    const sw = run(t.w, 1, { [t.id]: () => ({ selectSlot: 3 }) });
    expect(ofType(sw, 'weaponSwitch')[0]).toMatchObject({ weapon: 'grenade', slot: 3 });
    run(t.w, ticks(BALANCE.combat.swapMs) + 1);
    const ev = run(t.w, 3, { [t.id]: (i) => ({ fire: i === 0 }) });
    expect(ofType(ev, 'grenadeThrown').length).toBe(1);
    expect(ofType(ev, 'weaponSwitch')[0]).toMatchObject({ weapon: 'smg', slot: 1 });
  });

  it('AT17: match end removes live grenades without an explosion', () => {
    const t = thrower();
    t.w.debugSpawnGrenade(t.id, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, 2000);
    const other = t.w.debugPlayer(t.ids[1]!)!;
    other.dying = { killerId: null, weapon: null, cause: 'zone' };
    const ev = run(t.w, 2);
    expect(ofType(ev, 'matchEnded').length).toBe(1);
    expect(ofType([...ev, ...run(t.w, 90)], 'explosion').length).toBe(0);
    expect(t.w.debugGrenades().length).toBe(0);
  });

  it('AT18: while cooking Q, R and E do nothing; a stance toggle works', () => {
    const t = thrower();
    t.p.hp = 50;
    t.p.inv.heals.bandage = 1;
    t.w.debugLoot().push({ id: 700, item: 'bandage', qty: 1, mag: null, pos: { ...t.p.move.pos }, tier: 'common', durability: null });
    run(t.w, 2, { [t.id]: () => ({ fire: true }) });
    const ev = run(t.w, 1, { [t.id]: () => ({ fire: true, useHeal: true, reload: true, interact: true, stanceToggle: 'crouch' }) });
    expect(ofType(ev, 'healStart').length + ofType(ev, 'pickup').length + ofType(ev, 'reloadStart').length).toBe(0);
    expect(ofType(ev, 'stanceChange').length).toBe(1);
    expect(t.w.snapshotFor(t.id).players.find((p) => p.id === t.id)!.anim.cooking).toBe(true);
  });

  it('AT14: same seed and inputs => identical grenade events and damage', () => {
    const once = () => {
      const t = thrower({ players: 3 });
      const evs: SimEvent[] = [];
      evs.push(...run(t.w, 200, { [t.id]: (i) => ({ fire: i % 60 < 20, pitch: 0.2, yaw: i * 0.02 }) }));
      return JSON.stringify(evs.filter((e) => e.type.startsWith('grenade') || e.type === 'explosion' || e.type === 'damage'));
    };
    const a = once();
    expect(a).toBe(once());
    expect(a).toContain('grenadeThrown');
  });
});

describe('bots (M2a)', () => {
  it('weaponPrefs: sniper/dmr at long range, smg up close', () => {
    const { w, ids } = playingWorld(1);
    const p = w.debugPlayer(ids[0]!)!;
    p.inv.slots = [
      { weapon: 'smg', mag: 30 },
      { weapon: 'sniper', mag: 5 },
    ];
    expect(bestSlotFor(p, 5, BALANCE)).toBe(0);
    expect(bestSlotFor(p, 60, BALANCE)).toBe(1);
    p.inv.slots[1] = { weapon: 'dmr', mag: 10 };
    expect(bestSlotFor(p, 50, BALANCE)).toBe(1);
  });

  /** One idle human plus one bot (a second bot far away keeps the match running). */
  function botWorld(seed = 3) {
    const balance = noSpreadBalance((x) => {
      x.match.minHumansToStart = 1;
      x.match.targetPlayers = 3;
      x.match.countdownSeconds = 0;
      x.match.spawnJitter = 0;
      x.match.endWhenNoHumansAlive = false;
      x.loot.spawnChance = 0;
      x.bots.lootPhaseSeconds = 0;
      x.bots.eagernessRampSeconds = 0;
    });
    const props: PropPlacement[] = [{ kind: 'rock', x: 0, z: -12, rotY: 0, scale: 1.2 }];
    const w = createDebugWorld({ map: flatMap({ islandRadius: 300, worldRadius: 330 }, props), balance, seed, botNames: ['B'], drop: false });
    const human = w.addPlayer('H')!;
    for (let i = 0; i < 5 && w.getMatch().phase !== 'playing'; i++) w.step(SIM_DT);
    const bots = [human + 1, human + 2].map((id) => w.debugPlayer(id)!);
    land(w, human, 100, 100);
    land(w, bots[1]!.id, -150, -150);
    const bot = bots[0]!;
    return { w, human, bot, balance };
  }

  it('picks up a better helmet and wears it', () => {
    const { w, human, bot } = botWorld();
    land(w, bot.id, 0, 0);
    bot.brain = createBotBrain(w.timeMs, 0, 'balanced');
    bot.brain.landedAt = w.timeMs;
    w.debugLoot().length = 0;
    w.debugLoot().push({ id: 800, item: 'helmet_2', qty: 1, mag: null, pos: { x: 3, y: GROUND, z: 0 }, tier: 'rare', durability: 45 });
    run(w, 150, { [human]: () => ({}) });
    expect(bot.helmet).toEqual({ tier: 2, durability: 45 });
  });

  it('AT19: throws at a target that went behind a rock (chance forced to 1); lands near the last-known position', () => {
    const { w, human, bot, balance } = botWorld();
    balance.bots.grenade = { ...balance.bots.grenade, throwChancePerDecision: 1 };
    balance.bots.personalities = { ...balance.bots.personalities, balanced: { ...balance.bots.personalities?.balanced, grenadeChanceMultiplier: 1 } };
    land(w, bot.id, 0, 8);
    land(w, human, 0, -20); // 28 m away, behind the rock at z = -12 from z = +8
    bot.inv.grenades = 1;
    bot.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    bot.inv.activeSlot = 0;
    bot.brain = createBotBrain(w.timeMs, 0, 'balanced');
    bot.brain.landedAt = 0;
    bot.brain.targetId = human;
    bot.brain.targetVisible = false;
    bot.brain.lastSeenAt = w.timeMs;
    bot.brain.lastSeenPos = { x: 0, z: -20 };
    bot.yaw = 0;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 200; i++) {
      ev.push(...run(w, 1, { [human]: () => ({}) }));
    }
    const thrown = ofType(ev, 'grenadeThrown');
    expect(thrown.length).toBe(1);
    expect(thrown[0]!.dropped).toBe(false);
    const ex = ofType(ev, 'explosion')[0]!;
    const aimErr = balance.bots.grenade!.aimErrorMetres!;
    expect(Math.hypot(ex.pos.x - 0, ex.pos.z + 20)).toBeLessThan(aimErr + 3);
  });

  it('flees a visible live grenade within fleeRadius', () => {
    const { w, human, bot } = botWorld();
    land(w, bot.id, 0, 30);
    bot.brain = createBotBrain(w.timeMs, 0, 'balanced');
    bot.brain.landedAt = 0;
    w.debugLoot().length = 0;
    w.debugSpawnGrenade(human, { x: 2, y: GROUND + 0.08, z: 30 }, { x: 0, y: 0, z: 0 }, 3000);
    run(w, 45, { [human]: () => ({}) });
    expect(Math.hypot(bot.move.pos.x - 2, bot.move.pos.z - 30)).toBeGreaterThan(6);
    expect(bot.move.pos.x).toBeLessThan(0);
  });
});
