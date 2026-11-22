/**
 * M2c acceptance criteria without an exact owner test (qa-tester, Phase 3). Traceability: docs/qa/M2c-test-report.md.
 * Real World through the sim testkit on flat maps. Expected values are the spec's acceptance numbers where the spec
 * fixes them, otherwise computed from balance.json (the designer owns the tuning).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE, balanceForMap, effectiveWeapon, rocketBlastMaxDamage, type Balance } from '../../src/shared/balance';
import { SIM_DT } from '../../src/shared/constants';
import { createRng } from '../../src/shared/math';
import { applyArmorPiece } from '../../src/shared/sim/combat';
import { deployCloud } from '../../src/shared/sim/clouds';
import { rollGuaranteedGun, rollTier, spawnMatchLoot } from '../../src/shared/sim/loot';
import { flatMap, land, noSpreadBalance, playingWorld, run } from '../../src/shared/sim/testkit';
import { OFFICE as OFFICE_MAP } from '../../src/game/levels/office';
import type { DebugWorld } from '../../src/shared/sim/World';
import type { GunId, ItemId, ItemLevel, LootTier, MapData, PropPlacement, ScopeId, SimEvent } from '../../src/shared/types';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const B = BALANCE;
/** grenades.md falloff, written independently of src (test oracle): expected frag damage at 3D distance d. */
const fragDamageAt = (d: number, g: Balance['items']['grenade'] = BALANCE.items.grenade): number =>
  d <= g.innerRadius ? g.maxDamage : d > g.radius ? 0 : g.maxDamage * (1 + (g.minDamageFactor - 1) * ((d - g.innerRadius) / (g.radius - g.innerRadius)));
const GROUND = 2;
const EYE_Y = GROUND + B.player.eyeHeight;
const TICK = SIM_DT * 1000;
const ticks = (ms: number): number => Math.ceil(ms / TICK - 1e-9);
const BIG = (props: PropPlacement[] = []): MapData => flatMap({ islandRadius: 300, worldRadius: 330 }, props);
const clone = (b: Balance): Balance => structuredClone(b);

/** Shooter at (0, 0) facing -Z holding `gun` at `level`; target `dist` m ahead. */
function duel(gun: GunId, dist: number, level: ItemLevel = 1, balance: Balance = noSpreadBalance()) {
  // A third idle player far away keeps the match running after a kill (last one standing ends it).
  const { w, ids } = playingWorld(3, { map: BIG(), balance });
  const [s, t] = ids as [number, number];
  land(w, s, 0, 0);
  land(w, t, 0, -dist);
  land(w, ids[2]!, 200, 200);
  const sp = w.debugPlayer(s)!;
  sp.inv.slots[0] = { weapon: gun, mag: balance.weapons[gun].magSize, level, scope: null };
  sp.inv.activeSlot = 0;
  const tp = w.debugPlayer(t)!;
  const at = (y: number): number => Math.atan2(GROUND + y - EYE_Y, dist - B.player.radius);
  return { w, s, t, sp, tp, at };
}
/** One trigger click with the fire interval and mag reset. */
function click(w: DebugWorld, id: number, pitch: number, resetMag = true): SimEvent[] {
  const p = w.debugPlayer(id)!;
  p.nextFireAt = 0;
  const slot = p.inv.slots[0];
  if (slot && resetMag) slot.mag = B.weapons[slot.weapon].magSize;
  return [...run(w, 1, { [id]: () => ({ fire: true, pitch }) }), ...run(w, 1, { [id]: () => ({ fire: false, pitch }) })];
}
const BODY_Y = 0.6;
const HEAD_Y = 1.15;

describe('armor.md M2c (tier 4)', () => {
  it('13: vest_4 at 100, body hit 50: absorbed 27.5, hp loss 22.5, vest 72.5', () => {
    const r = applyArmorPiece({ tier: 4, durability: 100 }, 50, B.items.vest_4.absorbFraction);
    expect(r.absorbed).toBeCloseTo(27.5, 9);
    expect(r.hpLoss).toBeCloseTo(22.5, 9);
    expect(r.piece!.durability).toBeCloseTo(72.5, 9);
  });

  it('14: sniper L1 head on a fresh helmet_4: hp 30 (helmet cap), helmet 3.2; L4: hp 30, helmet destroyed', () => {
    for (const [level, hp, helmet] of [[1, 30, 3.2], [4, 30, null]] as const) {
      const d = duel('sniper', 10, level);
      d.tp.helmet = { tier: 4, durability: B.items.helmet_4.durability };
      const ev = click(d.w, d.s, d.at(HEAD_Y));
      expect(ofType(ev, 'damage')[0]!.headshot, `L${level} headshot`).toBe(true);
      expect(d.tp.hp, `L${level} hp`).toBeCloseTo(hp, 6);
      if (helmet === null) expect(d.tp.helmet).toBeNull();
      else expect(d.tp.helmet!.durability).toBeCloseTo(helmet, 6);
    }
  });

  it('15: vest_3 at 10 + E on vest_4 -> wearing vest_4 at 100, vest_3 at 10 dropped; vest_4 at 5 + E on a fresh vest_3 -> refused betterArmor', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 200, 200);
    const p = w.debugPlayer(id)!;
    p.vest = { tier: 3, durability: 10 };
    w.debugLoot().push({ id: 901, item: 'vest_4', qty: 1, mag: null, pos: { ...p.move.pos }, tier: 'epic', durability: 100 });
    run(w, 2, { [id]: (i) => ({ interact: i === 0 }) });
    expect(p.vest).toEqual({ tier: 4, durability: 100 });
    const dropped = w.debugLoot().find((l) => l.item === 'vest_3');
    expect(dropped?.durability).toBeCloseTo(10, 6);
    // Second part.
    w.debugLoot().length = 0;
    p.vest = { tier: 4, durability: 5 };
    w.debugLoot().push({ id: 902, item: 'vest_3', qty: 1, mag: null, pos: { ...p.move.pos }, tier: 'epic', durability: 75 });
    const before = w.debugActionFailures().length;
    const ev2 = run(w, 2, { [id]: (i) => ({ interact: i === 0 }) });
    expect(p.vest).toEqual({ tier: 4, durability: 5 });
    const reasons = [...w.debugActionFailures().slice(before).map((f) => f.reason), ...ofType(ev2, 'actionFailed').map((f) => f.reason)];
    console.info(`[armor15] refusal reasons ${JSON.stringify(reasons)}, events ${JSON.stringify(ev2.map((e) => e.type))}`);
    expect(reasons).toContain('betterArmor');
  });

  it('16: rifle L1 body hits on a fresh vest_4 at 10 m: hp 16 after 8 hits, the 9th kills', () => {
    const d = duel('rifle', 10);
    d.tp.vest = { tier: 4, durability: B.items.vest_4.durability };
    for (let i = 0; i < 8; i++) click(d.w, d.s, d.at(BODY_Y));
    expect(d.tp.hp).toBeCloseTo(16, 6);
    expect(d.tp.alive).toBe(true);
    click(d.w, d.s, d.at(BODY_Y));
    expect(d.tp.alive).toBe(false);
  });
});

describe('loot.md M2c and armor.md 18 (10,000 rolls, merged per-map balances)', () => {
  const EPIC_ONLY: ItemId[] = ['rpg', 'vest_4', 'helmet_4', 'scope_8x', 'ammo_rocket'];
  const NEVER_EPIC: ItemId[] = ['pistol', 'revolver', 'knife', 'machete', 'scope_red_dot', 'scope_2x', 'vest_1', 'helmet_1'];
  for (const mapId of ['island01', 'office']) {
    it(`8 / 9 / armor 18 (${mapId}): frequencies within 2 points of the weights; epic-only items never from common/rare; the epic table never gives the low items`, () => {
      const b = balanceForMap(BALANCE, mapId);
      for (const tier of ['common', 'rare', 'epic'] as LootTier[]) {
        const weights = Object.entries(b.loot.tiers[tier] as Record<string, number>).filter(([k, v]) => !k.startsWith('_') && v > 0);
        const total = weights.reduce((a, [, v]) => a + v, 0);
        const rng = createRng(1234 + tier.length);
        const counts: Record<string, number> = {};
        const N = 10_000;
        for (let i = 0; i < N; i++) {
          const it = rollTier(b, tier, rng);
          if (it) counts[it] = (counts[it] ?? 0) + 1;
        }
        for (const [id, wgt] of weights) {
          expect(Math.abs((counts[id] ?? 0) / N - wgt / total), `${mapId} ${tier} ${id}`).toBeLessThan(0.02);
        }
        if (tier !== 'epic') for (const id of EPIC_ONLY) expect(counts[id] ?? 0, `${mapId} ${tier} ${id}`).toBe(0);
        else for (const id of NEVER_EPIC) expect(counts[id] ?? 0, `${mapId} epic ${id}`).toBe(0);
      }
    });
  }

  function spawnOne(item: ItemId, tier: LootTier = 'epic') {
    const b = clone(BALANCE);
    b.loot.spawnChance = 1;
    for (const t of ['common', 'rare', 'epic'] as LootTier[]) b.loot.tiers[t] = { [item]: 1 } as never;
    const map = flatMap({ lootSpawns: [{ x: 0, z: 0, tier }] });
    let n = 0;
    return spawnMatchLoot(map, b, createRng(7), () => ++n, () => GROUND);
  }

  it('10: rpg spawn: mag 1 and 2 ammo_rocket stacks of 1 within 0.8 m; melee: no extras; smoke qty 2; scope qty 1, no level', () => {
    const rpg = spawnOne('rpg');
    const gun = rpg.find((l) => l.item === 'rpg')!;
    expect(gun.mag).toBe(1);
    const rockets = rpg.filter((l) => l.item === 'ammo_rocket');
    expect(rockets.map((r) => r.qty)).toEqual([1, 1]);
    for (const r of rockets) expect(Math.hypot(r.pos.x - gun.pos.x, r.pos.z - gun.pos.z)).toBeLessThanOrEqual(0.8 + 1e-9);
    for (const m of ['knife', 'machete', 'paddle'] as ItemId[]) expect(spawnOne(m, 'rare').map((l) => l.item)).toEqual([m]);
    const smoke = spawnOne('smoke', 'rare');
    expect(smoke.map((l) => [l.item, l.qty])).toEqual([['smoke', 2]]);
    for (const s of ['scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x'] as ItemId[]) {
      const l = spawnOne(s, 'epic');
      expect(l).toHaveLength(1);
      expect(l[0]!.qty).toBe(1);
      expect(l[0]!.level ?? null).toBeNull();
    }
  });

  it('14: spawnChance 0: every guaranteed point still spawns exactly one gun + 2 ammo stacks; island/office gun mix and L1/L2 split within 2 points', () => {
    for (const mapId of ['island01', 'office']) {
      const b = clone(balanceForMap(BALANCE, mapId));
      b.loot.spawnChance = 0;
      const spawns = Array.from({ length: 10_000 }, (_, i) => ({ x: (i % 100) * 3, z: Math.floor(i / 100) * 3, tier: 'common' as LootTier, guarantee: 'weapon' as const }));
      const map = flatMap({ lootSpawns: [...spawns, { x: 900, z: 900, tier: 'epic' }] });
      let n = 0;
      const loot = spawnMatchLoot(map, b, createRng(99), () => ++n, () => GROUND);
      const guns = loot.filter((l) => l.mag !== null);
      expect(guns).toHaveLength(10_000);
      expect(loot.length - guns.length).toBe(20_000);
      const share = (pred: (l: (typeof guns)[number]) => boolean) => guns.filter(pred).length / guns.length;
      const want = b.loot.guaranteedWeapon.weights as Record<string, number>;
      const tot = Object.entries(want).filter(([k]) => !k.startsWith('_')).reduce((a, [, v]) => a + v, 0);
      for (const [id, wgt] of Object.entries(want)) if (!id.startsWith('_')) expect(Math.abs(share((l) => l.item === id) - wgt / tot), `${mapId} ${id}`).toBeLessThan(0.02);
      const lv = b.loot.guaranteedWeapon.levels as readonly number[];
      const lt = lv.reduce((a, v) => a + v, 0);
      for (let k = 0; k < 4; k++) expect(Math.abs(share((l) => (l.level ?? 1) === k + 1) - lv[k]! / lt), `${mapId} L${k + 1}`).toBeLessThan(0.02);
      expect(share((l) => (l.level ?? 1) >= 3)).toBe(0);
      // rollGuaranteedGun is what the generator uses; it only returns guns.
      expect(rollGuaranteedGun(b, createRng(1))).not.toBeNull();
    }
  });
});

describe('combat.md M2c', () => {
  it('24: revolver: 3 body hits kill, 2 headshots kill; mag 6, reload 2600 ms; at 60 m+ a body hit deals 27.6', () => {
    const d = duel('revolver', 10);
    click(d.w, d.s, d.at(BODY_Y));
    click(d.w, d.s, d.at(BODY_Y));
    expect(d.tp.alive).toBe(true);
    click(d.w, d.s, d.at(BODY_Y));
    expect(d.tp.alive).toBe(false);
    const h = duel('revolver', 10);
    click(h.w, h.s, h.at(HEAD_Y));
    expect(h.tp.alive).toBe(true);
    click(h.w, h.s, h.at(HEAD_Y));
    expect(h.tp.alive).toBe(false);
    expect(B.weapons.revolver.magSize).toBe(6);
    expect(B.weapons.revolver.reloadMs).toBe(2600);
    const far = duel('revolver', 70);
    const dmg = ofType(click(far.w, far.s, far.at(BODY_Y)), 'damage')[0]!;
    expect(dmg.amount).toBeCloseTo(27.6, 6);
  });

  it('25: double barrel: one barrel per click (>= 250 ms apart); 1 m full pellets = 140 (dead); two barrels kill a fresh vest_4; reload refills 2 in 2800 ms', () => {
    const d = duel('dbshotgun', 1);
    const ev = click(d.w, d.s, d.at(BODY_Y));
    expect(ofType(ev, 'shot')).toHaveLength(1);
    expect(ofType(ev, 'damage').reduce((a, e) => a + e.amount, 0)).toBeCloseTo(140, 6);
    expect(d.tp.alive).toBe(false);
    expect(d.sp.inv.slots[0]!.mag).toBe(1);
    // Two barrels on a fresh vest_4.
    const v = duel('dbshotgun', 1);
    v.tp.vest = { tier: 4, durability: 100 };
    click(v.w, v.s, v.at(BODY_Y));
    expect(v.tp.alive).toBe(true);
    run(v.w, ticks(260));
    click(v.w, v.s, v.at(BODY_Y), false);
    expect(v.tp.alive).toBe(false);
    expect(v.sp.inv.slots[0]!.mag).toBe(0);
    // Reload: 2 shells in 2800 ms.
    v.sp.inv.ammo.ammo_shell = 10;
    run(v.w, ticks(300));
    const rl = run(v.w, 1, { [v.s]: () => ({ reload: true }) });
    console.info(`[dbshotgun] reload events ${JSON.stringify(rl.map((e) => e.type))} mag ${v.sp.inv.slots[0]!.mag} alive ${v.sp.alive}`);
    run(v.w, ticks(2800) - 2, { [v.s]: () => ({}) });
    expect(v.sp.inv.slots[0]!.mag).toBe(0);
    run(v.w, 3, { [v.s]: () => ({}) });
    expect(v.sp.inv.slots[0]!.mag).toBe(2);
    expect(v.sp.inv.ammo.ammo_shell).toBe(8);
  });

  it('25 (spread): at 8 m on a standing target, the mean damage per barrel over 1,000 seeded shots is 8-25', () => {
    const { w, ids } = playingWorld(2, { map: BIG(), balance: clone(BALANCE), seed: 5 });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -8);
    const sp = w.debugPlayer(s)!;
    const tp = w.debugPlayer(t)!;
    sp.inv.slots[0] = { weapon: 'dbshotgun', mag: 2, level: 1, scope: null };
    sp.inv.activeSlot = 0;
    let total = 0;
    for (let i = 0; i < 1000; i++) {
      tp.hp = 1e9;
      const ev = click(w, s, Math.atan2(GROUND + BODY_Y - EYE_Y, 8 - B.player.radius));
      total += ofType(ev, 'damage').reduce((a, e) => a + e.amount, 0);
    }
    const mean = total / 1000;
    console.info(`[dbshotgun] mean damage per barrel at 8 m: ${mean.toFixed(2)}`);
    expect(mean).toBeGreaterThanOrEqual(8);
    expect(mean).toBeLessThanOrEqual(25);
  });

  it('26: a knife kill reports weapon knife with its level (kill event)', () => {
    const { w, ids } = playingWorld(2, { map: BIG(), balance: noSpreadBalance() });
    const [a, t] = ids as [number, number];
    land(w, a, 0, 0);
    land(w, t, 0, -1.5);
    const ap = w.debugPlayer(a)!;
    ap.inv.melee = { weapon: 'knife', level: 3 };
    ap.inv.activeSlot = 2;
    w.debugPlayer(t)!.hp = 1;
    const pitch = Math.atan2(B.movement.stances.stand.height * 0.5 - B.movement.stances.stand.eyeHeight, 1.5);
    const ev = run(w, 30, { [a]: () => ({ fire: true, pitch }) });
    expect(ofType(ev, 'kill')[0]).toMatchObject({ weapon: 'knife', weaponLevel: 3 });
  });

  it('27: key 3 (selectSlot 2) selects the melee slot: the melee weapon if carried, fists otherwise', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 200, 200);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 30, level: 1, scope: null };
    p.inv.activeSlot = 0;
    run(w, ticks(600), { [id]: (i) => ({ selectSlot: i === 0 ? 2 : -1 }) });
    expect(p.inv.activeSlot).toBe(2);
    expect(w.snapshotFor(id).players[0]!.weapon).toBe('fists');
    p.inv.melee = { weapon: 'machete', level: 2 };
    run(w, ticks(600), { [id]: (i) => ({ selectSlot: i === 0 ? 0 : -1 }) });
    run(w, ticks(600), { [id]: (i) => ({ selectSlot: i === 0 ? 2 : -1 }) });
    const me = w.snapshotFor(id).players[0]!;
    expect(me.weapon).toBe('machete');
    expect(me.weaponLevel).toBe(2);
  });

  it('28: equal-level pickup: an L2 rifle in slot 0 and an empty slot 1, E on an L2 rifle fills slot 1', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 200, 200);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 30, level: 2, scope: null };
    p.inv.slots[1] = null;
    p.inv.activeSlot = 0;
    w.debugLoot().push({ id: 903, item: 'rifle', qty: 1, mag: 20, pos: { ...p.move.pos }, tier: 'rare', durability: null, level: 2 });
    run(w, 2, { [id]: (i) => ({ interact: i === 0 }) });
    expect(p.inv.slots[1]).toMatchObject({ weapon: 'rifle', level: 2, mag: 20 });
    expect(w.debugLoot().some((l) => l.id === 903)).toBe(false);
  });
});

describe('melee.md gaps', () => {
  it('9 (death half): the attacker dies during the wind-up: no damage', () => {
    const { w, ids } = playingWorld(3, { map: BIG(), balance: noSpreadBalance() });
    const [a, t, k] = ids as [number, number, number];
    land(w, a, 0, 0);
    land(w, t, 0, -1.5);
    land(w, k, 0, 10);
    const ap = w.debugPlayer(a)!;
    ap.inv.melee = { weapon: 'paddle', level: 1 };
    ap.inv.activeSlot = 2;
    const pitch = Math.atan2(B.movement.stances.stand.height * 0.5 - B.movement.stances.stand.eyeHeight, 1.5);
    const ev = run(w, 1, { [a]: () => ({ fire: true, pitch }) });
    expect(ofType(ev, 'meleeSwing')).toHaveLength(1);
    ap.hp = 0.01;
    // A third player kills the attacker before the paddle's hit frame.
    const kp = w.debugPlayer(k)!;
    kp.inv.slots[0] = { weapon: 'sniper', mag: 5, level: 1, scope: null };
    kp.inv.activeSlot = 0;
    kp.nextFireAt = 0;
    const yaw = 0; // k at +Z looks toward -Z at a
    const after = run(w, 30, { [k]: (i) => ({ fire: i === 0, yaw, pitch: Math.atan2(GROUND + BODY_Y - EYE_Y, 10 - B.player.radius) }) });
    expect(ap.alive).toBe(false);
    expect(ofType(after, 'damage').filter((d) => d.victimId === t)).toEqual([]);
  });
});

describe('rpg.md 8 (bystander part)', () => {
  it('a bystander 1 m from a direct-hit target takes blast damage per distance', () => {
    const { w, ids } = playingWorld(3, { map: BIG(), balance: noSpreadBalance() });
    const [s, t, by] = ids as [number, number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -20);
    land(w, by, 1, -20);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
    sp.inv.activeSlot = 0;
    w.debugPlayer(t)!.hp = 1e6;
    const pitch = Math.atan2(B.movement.stances.stand.height * 0.5 - B.movement.stances.stand.eyeHeight, 20);
    const ev = [...run(w, 1, { [s]: () => ({ fire: true, pitch }) }), ...run(w, 60, { [s]: () => ({ pitch }) })];
    const ex = ofType(ev, 'explosion')[0]!;
    expect(ex.direct).toBe(true);
    const hit = ofType(ev, 'damage').find((d) => d.victimId === by);
    expect(hit, 'bystander damaged').toBeDefined();
    expect(hit!.cause).toBe('explosion');
    expect(hit!.amount).toBeGreaterThan(0);
  });
});

describe('smoke.md gaps', () => {
  function cloudBetween() {
    const d = duel('rifle', 20);
    const cfg = B.items.smoke.cloud;
    const c = deployCloud(1, d.t, { x: 0, y: GROUND, z: -10 }, false, d.w.timeMs, cfg);
    d.w.debugClouds().push(c);
    run(d.w, ticks(3000));
    return d;
  }

  it('6: a rifle shot through a holding cloud hits the target behind it for full damage', () => {
    const d = cloudBetween();
    const ev = click(d.w, d.s, d.at(BODY_Y));
    const dmg = ofType(ev, 'damage')[0];
    expect(dmg?.victimId).toBe(d.t);
    expect(dmg!.amount).toBeCloseTo(B.weapons.rifle.damage, 6);
  });

  it('7: a frag exploding inside a cloud damages a player 3 m away (3 m falloff damage, unarmored; v9: 92.75)', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const [a, t] = ids as [number, number];
    land(w, a, 50, 50);
    land(w, t, 0, -3);
    w.debugClouds().push(deployCloud(1, a, { x: 0, y: GROUND, z: 0 }, false, w.timeMs, B.items.smoke.cloud));
    run(w, ticks(3000));
    const chest = GROUND + B.movement.stances.stand.height * 0.5;
    w.debugSpawnGrenade(a, { x: 0, y: chest, z: 0 }, { x: 0, y: 0, z: 0 }, 1);
    const ev = run(w, 2);
    const dmg = ofType(ev, 'damage').find((e) => e.victimId === t)!;
    expect(dmg.amount).toBeCloseTo(fragDamageAt(3), 1);
  });

  it('10: late join: a viewer joining 10 s after a deploy receives the cloud in its first snapshot and it is at full radius', () => {
    const { w, ids } = playingWorld(2, { map: BIG() });
    const [a] = ids as [number, number];
    land(w, a, 0, 0);
    const c = deployCloud(7, a, { x: 5, y: GROUND, z: 5 }, false, w.timeMs, B.items.smoke.cloud);
    w.debugClouds().push(c);
    run(w, ticks(10_000));
    const late = w.addPlayer('Late')!;
    const snap = w.snapshotFor(late) as unknown as { smokes?: { id: number }[] };
    expect(snap.smokes?.map((x) => x.id)).toEqual([7]);
    const spec = w.snapshotFor(null) as unknown as { smokes?: { id: number }[] };
    expect(spec.smokes?.map((x) => x.id)).toEqual([7]);
  });

  it('14: determinism: same seed and inputs give identical canister paths and deploy ticks', () => {
    const go = () => {
      const { w, ids } = playingWorld(2, { map: BIG(), seed: 3 });
      const [a, b] = ids as [number, number];
      land(w, a, 0, 0);
      land(w, b, 40, 40);
      const p = w.debugPlayer(a)!;
      p.inv.smokes = 2;
      p.inv.selectedThrowable = 'smoke';
      p.inv.activeSlot = 3;
      const ev = run(w, 200, { [a]: (i) => ({ fire: i >= 20 && i < 30, pitch: 0.3, yaw: 0.4 }) });
      const path = w.debugGrenades().map((g) => ({ ...g.body.pos }));
      return { ev: ofType(ev, 'smokeDeployed'), clouds: JSON.stringify(w.debugClouds()), path: JSON.stringify(path) };
    };
    const x = go();
    const y = go();
    expect(x.ev.length).toBe(1);
    expect(x).toEqual(y);
  });
});

describe('scopes.md gaps', () => {
  it('9: a remote player holding a rifle with a 4x reports sight scope_4x; with a 2x, scope_2x', () => {
    for (const scope of ['scope_4x', 'scope_2x'] as ScopeId[]) {
      const d = duel('rifle', 20);
      d.sp.inv.slots[0]!.scope = scope;
      run(d.w, 2);
      const seen = d.w.snapshotFor(d.t).players.find((p) => p.id === d.s)!;
      expect(seen.sight).toBe(scope);
    }
  });

  it('10: 10,000 rolls per tier: scope weights within 2 points; common never 2x/4x/8x; 8x only from epic', () => {
    for (const tier of ['common', 'rare', 'epic'] as LootTier[]) {
      const rng = createRng(77 + tier.length);
      const N = 10_000;
      const counts: Record<string, number> = {};
      for (let i = 0; i < N; i++) {
        const it = rollTier(B, tier, rng);
        if (it) counts[it] = (counts[it] ?? 0) + 1;
      }
      const w = B.loot.tiers[tier] as Record<string, number>;
      const tot = Object.entries(w).filter(([k]) => !k.startsWith('_')).reduce((a, [, v]) => a + v, 0);
      for (const s of ['scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x']) {
        expect(Math.abs((counts[s] ?? 0) / N - (w[s] ?? 0) / tot), `${tier} ${s}`).toBeLessThan(0.02);
      }
      if (tier === 'common') for (const s of ['scope_2x', 'scope_4x', 'scope_8x']) expect(counts[s] ?? 0).toBe(0);
      if (tier !== 'epic') expect(counts.scope_8x ?? 0).toBe(0);
    }
  });
});

describe('levels.md 12 (snapshot)', () => {
  it('a remote player held weapon level is visible to others; a ground weapon pickup carries its level', () => {
    const d = duel('smg', 20, 3);
    d.w.debugLoot().push({ id: 904, item: 'shotgun', qty: 1, mag: 5, pos: { x: 3, y: GROUND, z: 3 }, tier: 'rare', durability: null, level: 4 });
    run(d.w, 2);
    const snap = d.w.snapshotFor(d.t);
    expect(snap.players.find((p) => p.id === d.s)!.weaponLevel).toBe(3);
    expect(snap.loot!.find((l) => l.id === 904)!.level).toBe(4);
  });
});

describe('levels.md 14: L4 design invariants on the shipped balance', () => {
  it('sniper: body < maxHp at every level, L4 unchanged by the damage pass (96), helmeted head capped < maxHp; RPG blast scales with level', () => {
    const max = B.player.maxHp;
    for (const lv of [1, 2, 3, 4] as const) expect(effectiveWeapon(B, 'sniper', lv).damage).toBeLessThan(max);
    expect(effectiveWeapon(B, 'sniper', 4).damage).toBeCloseTo(96, 9);
    expect(B.combat.helmetHeadshotCap.weapons).toContain('sniper');
    expect(B.combat.helmetHeadshotCap.maxHpLoss).toBeLessThan(max);
    expect(rocketBlastMaxDamage(B, 4)).toBeGreaterThan(rocketBlastMaxDamage(B, 1));
  });
});

describe('late join with broken glass, a live cloud and a rocket in flight (exploratory, real office)', () => {
  it('a player joining after a knife broke a pane receives brokenPanes, the cloud and the rocket in its first snapshot', () => {
    const { w, ids } = playingWorld(3, { map: OFFICE_MAP, balance: noSpreadBalance() });
    const [a, b, c] = ids as [number, number, number];
    // Pane 34: glass wall along X at z = 46 (x 9.59-15.035); stand 1.4 m south of it, facing +Z (yaw pi).
    land(w, a, 12.3, 44.6);
    land(w, b, -80, -30);
    land(w, c, 80, -30);
    const ap = w.debugPlayer(a)!;
    ap.inv.melee = { weapon: 'knife', level: 1 };
    ap.inv.activeSlot = 2;
    const ev = run(w, 20, { [a]: (i) => ({ fire: i === 0, yaw: Math.PI, pitch: 0 }) });
    const g = ofType(ev, 'glassBroken')[0];
    expect(g?.cause).toBe('melee');
    const pane = g!.paneId;
    // A cloud and a rocket in flight.
    w.debugClouds().push(deployCloud(42, b, { x: -80, y: 0, z: -20 }, false, w.timeMs, B.items.smoke.cloud));
    const cp = w.debugPlayer(c)!;
    cp.inv.slots[0] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
    cp.inv.activeSlot = 0;
    run(w, 1, { [c]: () => ({ fire: true, yaw: Math.PI / 2, pitch: 0.2 }) });
    expect(w.debugRockets().length).toBe(1);
    const late = w.addPlayer('Late')!;
    const snap = w.snapshotFor(late) as unknown as { brokenPanes?: number[]; smokes?: { id: number }[]; rockets?: { id: number }[] };
    expect(snap.brokenPanes).toContain(pane);
    expect(snap.smokes?.map((x) => x.id)).toContain(42);
    expect(snap.rockets?.length).toBe(1);
  });
});
