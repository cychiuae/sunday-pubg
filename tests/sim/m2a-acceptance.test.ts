/**
 * M2a acceptance criteria that had no exact owner test (qa-tester gap pass, 2a-D1). The traceability table is in
 * docs/qa/M2a-test-report.md. Each test names its spec and criterion number. Everything runs on the real World
 * through the sim testkit on flat maps, so terrain noise and props play no part unless a test adds them.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../../src/shared/balance';
import { BALANCE } from '../../src/shared/balance';
import { SIM_DT } from '../../src/shared/constants';
import type { GunId, IslandMapData, MapData, SimEvent } from '../../src/shared/types';
import { explosionDamage } from '../../src/shared/sim/grenade';
import { flatMap, land, noSpreadBalance, playingWorld, run } from '../../src/shared/sim/testkit';
import type { DebugWorld } from '../../src/shared/sim/World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const ticks = (ms: number): number => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);
const GROUND = 2; // flatMap baseHeight
const EYE_Y = GROUND + BALANCE.player.eyeHeight;
/** grenades.md falloff, written independently of src (test oracle): expected frag damage at 3D distance d. */
const fragDamageAt = (d: number, g: Balance['items']['grenade'] = BALANCE.items.grenade): number =>
  d <= g.innerRadius ? g.maxDamage : d > g.radius ? 0 : g.maxDamage * (1 + (g.minDamageFactor - 1) * ((d - g.innerRadius) / (g.radius - g.innerRadius)));
const pitchTo = (fromY: number, toY: number, dist: number): number => Math.atan2(toY - fromY, dist);
const BIG = (over: Partial<IslandMapData> = {}): IslandMapData => flatMap({ islandRadius: 300, worldRadius: 330, ...over });

/** Shooter at (0, 0) facing -Z; target `dist` m away (feet to feet). */
function duel(dist: number, gun: GunId, balance: Balance = noSpreadBalance()) {
  const { w, ids } = playingWorld(2, { map: BIG(), balance });
  const [s, t] = ids as [number, number];
  land(w, s, 0, 0);
  land(w, t, 0, -dist);
  const sp = w.debugPlayer(s)!;
  sp.inv.slots[0] = { weapon: gun, mag: BALANCE.weapons[gun].magSize };
  sp.inv.activeSlot = 0;
  const tp = w.debugPlayer(t)!;
  // Aim at the near surface of the target cylinder so the hit height is what we ask for.
  const at = (y: number): number => pitchTo(EYE_Y, GROUND + y, dist - BALANCE.player.radius);
  return { w, s, t, sp, tp, at };
}

/** One trigger click (press, then release), with the fire interval and mag reset. */
function click(w: DebugWorld, id: number, pitch: number): SimEvent[] {
  const p = w.debugPlayer(id)!;
  p.nextFireAt = 0;
  const slot = p.inv.slots[0];
  if (slot) slot.mag = BALANCE.weapons[slot.weapon].magSize;
  return [...run(w, 1, { [id]: () => ({ fire: true, pitch }) }), ...run(w, 1, { [id]: () => ({ fire: false, pitch }) })];
}

describe('combat.md gaps', () => {
  it('AT2: a standing target hit at y = 0.7 is a body hit (23); at y = 1.0 a headshot (41.4)', () => {
    const d = duel(10, 'rifle');
    const body = ofType(click(d.w, d.s, d.at(0.7)), 'damage')[0]!;
    expect(body.headshot).toBe(false);
    expect(d.tp.hp).toBeCloseTo(100 - 23, 6);
    const e = duel(10, 'rifle');
    const head = ofType(click(e.w, e.s, e.at(1.0)), 'damage')[0]!;
    expect(head.headshot).toBe(true);
    expect(e.tp.hp).toBeCloseTo(100 - 41.4, 6);
  });

  it('AT3: three rifle headshots (no armor, 10 m) kill; two leave 17.2', () => {
    const d = duel(10, 'rifle');
    click(d.w, d.s, d.at(1.0));
    click(d.w, d.s, d.at(1.0));
    expect(d.tp.hp).toBeCloseTo(17.2, 6);
    expect(d.tp.alive).toBe(true);
    const ev = click(d.w, d.s, d.at(1.0));
    expect(d.tp.alive).toBe(false);
    expect(ofType(ev, 'kill')[0]).toMatchObject({ victimId: d.t, killerId: d.s, weapon: 'rifle', headshot: true });
  });

  it('AT5: shotgun 5 head + 4 body pellets vs helmet_2 + vest_2: helmet 39, vest 20.8, HP loss 89.7, one event', () => {
    // Real spread (7 deg) aimed at the neck line at 3 m. The pellet split is random (seeded), so we shoot until a
    // 5/4 split lands (raw 5 x 19.5 + 4 x 13 = 149.5), and check the armor arithmetic on every mixed event on the way.
    const d = duel(3, 'shotgun', BALANCE);
    const hb = BALANCE.items.helmet_2;
    const vb = BALANCE.items.vest_2;
    let exact = 0;
    let mixed = 0;
    for (let i = 0; i < 400 && exact === 0; i++) {
      d.tp.hp = 1e6;
      d.tp.helmet = { tier: 2, durability: hb.durability };
      d.tp.vest = { tier: 2, durability: vb.durability };
      const hp0 = d.tp.hp;
      const ev = click(d.w, d.s, d.at(1.0 - 0.06));
      const dmg = ofType(ev, 'damage');
      if (dmg.length === 0) continue;
      expect(dmg.length, 'one damage event per shot').toBe(1);
      const e = dmg[0]!;
      if (!e.helmet || !e.vest) continue;
      mixed++;
      expect(e.headshot).toBe(true);
      // Whatever the split: HP loss = raw - both absorbs, each absorb <= its durability.
      expect(hp0 - d.tp.hp).toBeCloseTo(e.amount - e.helmet.absorbed - e.vest.absorbed, 6);
      expect(e.helmet.absorbed).toBeLessThanOrEqual(hb.durability + 1e-9);
      expect(e.vest.absorbed).toBeLessThanOrEqual(vb.durability + 1e-9);
      if (Math.abs(e.amount - 149.5) < 1e-6 && Math.abs(e.helmet.absorbed - 39) < 1e-6) {
        exact++;
        expect(e.vest.absorbed).toBeCloseTo(20.8, 6);
        expect(hp0 - d.tp.hp).toBeCloseTo(89.7, 6);
      }
    }
    expect(mixed, 'mixed head+body shotgun events seen').toBeGreaterThan(0);
    expect(exact, 'a 5 head / 4 body split was observed and checked').toBeGreaterThan(0);
  });

  it('AT12 (world): 30 light ammo with 170 carried takes 10 and leaves 20; 5 sniper ammo with 18 takes 2', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 50, 0);
    const p = w.debugPlayer(id)!;
    p.inv.ammo.ammo_light = 170;
    w.debugLoot().push({ id: 900, item: 'ammo_light', qty: 30, mag: null, pos: { x: 0, y: GROUND, z: 0.3 }, tier: 'common', durability: null });
    run(w, 1, { [id]: () => ({ interact: true }) });
    expect(p.inv.ammo.ammo_light).toBe(180);
    expect(w.debugLoot().find((l) => l.id === 900)!.qty).toBe(20);
    w.debugLoot().length = 0;
    p.inv.ammo.ammo_sniper = 18;
    w.debugLoot().push({ id: 901, item: 'ammo_sniper', qty: 5, mag: null, pos: { x: 0, y: GROUND, z: 0.3 }, tier: 'epic', durability: null });
    run(w, 2, { [id]: (i) => ({ interact: i === 1 }) });
    expect(p.inv.ammo.ammo_sniper).toBe(20);
    expect(w.debugLoot().find((l) => l.id === 901)!.qty).toBe(3);
  });
});

describe('stance.md gaps', () => {
  it('AT14: a spawned player is standing and settled (sim and snapshot)', () => {
    const { w, ids } = playingWorld(2);
    for (const id of ids) {
      const m = w.debugPlayer(id)!.move;
      expect([m.stance, m.stanceFrom, m.stanceMs]).toEqual(['stand', 'stand', 0]);
      const ps = w.snapshotFor(ids[0]!).players.find((p) => p.id === id)!;
      expect(ps).toMatchObject({ stance: 'stand', stanceFrom: 'stand', stanceProgress: 1 });
    }
  });

  it('AT9 (world): ads held through a C transition stays 0, ramps after the settle; anim.ads follows', () => {
    const d = duel(20, 'rifle');
    const adsTrace: number[] = [];
    const stanceMs: number[] = [];
    for (let i = 0; i < 14; i++) {
      run(d.w, 1, { [d.s]: () => ({ ads: true, stanceToggle: i === 0 ? 'crouch' : null }) });
      adsTrace.push(d.sp.move.adsMs);
      stanceMs.push(d.sp.move.stanceMs);
    }
    adsTrace.forEach((a, i) => {
      if (stanceMs[i]! > 0) expect(a, `tick ${i}`).toBe(0);
    });
    expect(adsTrace[adsTrace.length - 1]!).toBeGreaterThan(0);
    expect(d.w.snapshotFor(d.t).players.find((p) => p.id === d.s)!.anim.ads).toBe(true);
  });
});

describe('stance.md AT17 (reload half)', () => {
  it('a reload started standing continues through C and Z and completes (mag and reserve as without the stance change)', () => {
    const d = duel(20, 'rifle');
    d.sp.inv.slots[0]!.mag = 3;
    d.sp.inv.ammo.ammo_heavy = 50;
    const n = ticks(BALANCE.weapons.rifle.reloadMs) + 2;
    const ev = run(d.w, n, { [d.s]: (i) => ({ reload: i === 0, stanceToggle: i === 3 ? 'crouch' : i === 12 ? 'prone' : null }) });
    expect(ofType(ev, 'stanceChange').length).toBe(2);
    expect(ofType(ev, 'reloadEnd')[0]).toMatchObject({ playerId: d.s });
    expect(d.sp.inv.slots[0]!.mag).toBe(BALANCE.weapons.rifle.magSize);
    expect(d.sp.inv.ammo.ammo_heavy).toBe(50 - (BALANCE.weapons.rifle.magSize - 3));
  });
});

describe('armor.md gaps', () => {
  it('AT1 (world): vest_2 at 55 takes body hits 30 / 100 / 10: hp 82 / 22 / 15, vest 43 / 3 / broken, event shows the break', () => {
    // Three real rifle body hits whose raw damage is patched to 30 / 100 / 10; each starts from the previous state.
    const hits = [30, 100, 10];
    const expected = [
      { hp: 82, vest: 43 },
      { hp: 22, vest: 3 },
      { hp: 15, vest: null },
    ];
    let broke: Ev<'damage'> | null = null;
    hits.forEach((dmg, i) => {
      const d = duel(10, 'rifle', noSpreadBalance((b) => (b.weapons.rifle.damage = dmg)));
      d.tp.hp = i === 0 ? 100 : expected[i - 1]!.hp;
      d.tp.vest = i === 0 ? { tier: 2, durability: 55 } : { tier: 2, durability: expected[i - 1]!.vest! };
      const ev = ofType(click(d.w, d.s, d.at(0.5)), 'damage')[0]!;
      expect(d.tp.hp).toBeCloseTo(expected[i]!.hp, 6);
      if (expected[i]!.vest === null) {
        expect(d.tp.vest).toBeNull();
        broke = ev;
      } else expect(d.tp.vest!.durability).toBeCloseTo(expected[i]!.vest!, 6);
    });
    expect(broke).not.toBeNull();
    expect(broke!.vest).toMatchObject({ tier: 2, broken: true });
    expect(broke!.vest!.absorbed).toBeCloseTo(3, 6);
  });

  it('AT2: a head hit never changes vest durability; a body hit never changes helmet durability', () => {
    const d = duel(10, 'rifle');
    d.tp.hp = 1e6;
    d.tp.vest = { tier: 2, durability: 55 };
    d.tp.helmet = { tier: 2, durability: 45 };
    click(d.w, d.s, d.at(1.0));
    expect(d.tp.vest).toEqual({ tier: 2, durability: 55 });
    expect(d.tp.helmet!.durability).toBeLessThan(45);
    const h = d.tp.helmet!.durability;
    click(d.w, d.s, d.at(0.5));
    expect(d.tp.helmet!.durability).toBe(h);
    expect(d.tp.vest!.durability).toBeLessThan(55);
  });

  it('AT3: a fall-damage landing leaves vest and helmet durability unchanged', () => {
    const { w, ids } = playingWorld(2);
    const p = w.debugPlayer(ids[0]!)!;
    p.vest = { tier: 3, durability: 75 };
    p.helmet = { tier: 3, durability: 75 };
    p.move = { ...p.move, pos: { ...p.move.pos, y: GROUND + 12 }, grounded: false };
    const ev = run(w, 60);
    const fall = ofType(ev, 'damage').filter((e) => e.cause === 'fall' && e.victimId === ids[0]);
    expect(fall.length).toBe(1);
    expect(fall[0]!.vest).toBeNull();
    expect(p.hp).toBeLessThan(100);
    expect(p.vest).toEqual({ tier: 3, durability: 75 });
    expect(p.helmet).toEqual({ tier: 3, durability: 75 });
  });

  it('AT4: grenade damage 50 vs vest_1 (35) + helmet_3 (75): absorb 15, hp 65, vest 20, helmet 75', () => {
    // Distance where explosionDamage = 50 (bisection on the shipped falloff).
    let lo = BALANCE.items.grenade.innerRadius;
    let hi = BALANCE.items.grenade.radius;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (explosionDamage(mid, BALANCE) > 50) lo = mid;
      else hi = mid;
    }
    const dist = (lo + hi) / 2;
    expect(explosionDamage(dist, BALANCE)).toBeCloseTo(50, 6);
    const { w, ids } = playingWorld(2, { map: BIG() });
    const [a, b] = ids as [number, number];
    land(w, a, 0, 0);
    land(w, b, 40, 0);
    const v = w.debugPlayer(b)!;
    v.vest = { tier: 1, durability: 35 };
    v.helmet = { tier: 3, durability: 75 };
    const gy = GROUND + BALANCE.items.grenade.collisionRadius;
    const chestY = GROUND + BALANCE.movement.stances.stand.height / 2;
    const dx = Math.sqrt(dist * dist - (chestY - gy) ** 2);
    w.debugSpawnGrenade(a, { x: 40 + dx, y: gy, z: 0 }, { x: 0, y: 0, z: 0 }, 50);
    const dmg = ofType(run(w, 4), 'damage').find((e) => e.victimId === b)!;
    expect(dmg.amount).toBeCloseTo(50, 4);
    expect(dmg.vest!.absorbed).toBeCloseTo(15, 4);
    expect(dmg.helmet).toBeNull();
    expect(v.hp).toBeCloseTo(65, 4);
    expect(v.vest!.durability).toBeCloseTo(20, 4);
    expect(v.helmet).toEqual({ tier: 3, durability: 75 });
  });

  it('AT8: a piece destroyed by the killing hit drops nothing; the surviving helmet drops with its durability', () => {
    const d = duel(10, 'rifle');
    d.tp.hp = 1;
    d.tp.vest = { tier: 1, durability: 1 };
    d.tp.helmet = { tier: 1, durability: 30 };
    click(d.w, d.s, d.at(0.5));
    expect(d.tp.alive).toBe(false);
    const near = d.w.debugLoot().filter((l) => Math.hypot(l.pos.x, l.pos.z + 10) <= BALANCE.combat.deathDropScatter + 1e-6);
    expect(near.some((l) => l.item.startsWith('vest'))).toBe(false);
    expect(near.find((l) => l.item === 'helmet_1')!.durability).toBe(30);
  });
});

describe('grenades.md gaps', () => {
  it('AT12 (world): a drop from 3 m emits grenadeBounce events; a grenade set down at rest emits none', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const r = BALANCE.items.grenade.collisionRadius;
    w.debugSpawnGrenade(ids[0]!, { x: 10, y: GROUND + 3 + r, z: 10 }, { x: 0, y: 0, z: 0 }, 3000);
    const evs = run(w, ticks(2500));
    const bounces = ofType(evs, 'grenadeBounce');
    expect(bounces.length).toBeGreaterThanOrEqual(1);
    expect(bounces[0]!.speed).toBeCloseTo(Math.sqrt(2 * BALANCE.items.grenade.gravity * 3), 0);
    expect(bounces.every((b) => b.speed >= BALANCE.items.grenade.bounceEventMinSpeed)).toBe(true);
    const g = w.debugGrenades()[0]!;
    expect(Math.hypot(g.body.vel.x, g.body.vel.y, g.body.vel.z)).toBe(0);

    const q = playingWorld(2, { map: BIG() });
    q.w.debugSpawnGrenade(q.ids[0]!, { x: 10, y: GROUND + r + 0.05, z: 10 }, { x: 0, y: 0, z: 0 }, 3000);
    expect(ofType(run(q.w, ticks(1000)), 'grenadeBounce').length).toBe(0);
  });

  it('AT13 (world): into 0.6 m water: one water contact, rests on the seabed, explodes; a standing player 3 m away takes the 3 m falloff damage +- 1 (v9: 92.75)', () => {
    const SEABED = -0.6;
    const map = flatMap({ islandRadius: 300, worldRadius: 330, baseHeight: SEABED });
    const { w, ids } = playingWorld(2, { map });
    const [a, b] = ids as [number, number];
    for (const id of ids) {
      const p = w.debugPlayer(id)!;
      p.move = { ...p.move, pos: { x: id === a ? -40 : 0, y: SEABED, z: 0 }, grounded: true, vel: { x: 0, y: 0, z: 0 } };
    }
    const v = w.debugPlayer(b)!;
    const chestY = SEABED + BALANCE.movement.stances.stand.height / 2;
    const restY = SEABED + BALANCE.items.grenade.collisionRadius;
    const dx = Math.sqrt(9 - (chestY - restY) ** 2);
    w.debugSpawnGrenade(a, { x: dx, y: 0.5, z: 0 }, { x: 0, y: 0, z: 0 }, 2500);
    const ev = run(w, ticks(2600));
    const water = ofType(ev, 'grenadeBounce').filter((e) => e.surface === 'water');
    expect(water.length).toBe(1);
    expect(ofType(ev, 'explosion').length).toBe(1);
    const dmg = ofType(ev, 'damage').find((e) => e.victimId === b)!;
    const expected = fragDamageAt(3);
    expect(dmg.amount).toBeGreaterThan(expected - 1);
    expect(dmg.amount).toBeLessThan(expected + 1);
    expect(v.hp).toBeCloseTo(100 - dmg.amount, 6);
  });

  it('AT16 (world): holding 3, a stack of 2 is refused inventoryFull; holding 2 takes 1 and leaves 1', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 50, 0);
    const p = w.debugPlayer(id)!;
    p.inv.grenades = 3;
    w.debugLoot().push({ id: 910, item: 'grenade', qty: 2, mag: null, pos: { x: 0, y: GROUND, z: 0.3 }, tier: 'common', durability: null });
    const ev = run(w, 1, { [id]: () => ({ interact: true }) });
    expect(ofType(ev, 'actionFailed')[0]).toMatchObject({ action: 'pickup', reason: 'inventoryFull' });
    p.inv.grenades = 2;
    run(w, 2, { [id]: (i) => ({ interact: i === 1 }) });
    expect(p.inv.grenades).toBe(3);
    expect(w.debugLoot().find((l) => l.id === 910)!.qty).toBe(1);
  });
});
