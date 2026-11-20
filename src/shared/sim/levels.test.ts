/**
 * M2c item levels in the sim (docs/design/systems/levels.md "Acceptance tests" 2-4, 8-10, 12; loot.md guaranteed weapons).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE, balanceForMap } from '../balance';
import { createRng } from '../math';
import { SIM_DT } from '../constants';
import type { LootSpawn, SimEvent } from '../types';
import { createInventory, applyPickup, deathDrops } from './inventory';
import { effWeapon, rollLevel } from './levels';
import { spawnMatchLoot } from './loot';
import { flatMap, land, noSpreadBalance, playingWorld, run } from './testkit';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const B = BALANCE;
const none = () => ({ vest: null, helmet: null });

describe('levels (levels.md)', () => {
  it('2: rifle body at 10 m: L1 23, L2 24.84, L3 26.68, L4 28.75; reload L1 2400, L4 2040', () => {
    const dmg = [1, 2, 3, 4].map((l) => effWeapon(B, 'rifle', l as 1).damage);
    [23, 24.84, 26.68, 28.75].forEach((v, i) => expect(dmg[i]).toBeCloseTo(v, 3));
    expect(effWeapon(B, 'rifle', 1).reloadMs).toBe(2400);
    expect(effWeapon(B, 'rifle', 4).reloadMs).toBeCloseTo(2040, 6);
  });

  it('3/4/5/6: pistol L4 30; shotgun L4 pellet 13, pump 765; sniper L1-L3 above 88, L4 96 and bolt 1120; dmr L4 57.5 and 320 ms', () => {
    expect(effWeapon(B, 'pistol', 4).damage).toBeCloseTo(30, 9);
    expect(effWeapon(B, 'shotgun', 4).damage).toBe(13);
    expect(effWeapon(B, 'shotgun', 4).fireIntervalMs).toBeCloseTo(765, 6);
    // Damage pass 2026-11: L1-L3 rose, L4 stays at the pre-pass 96.
    [88, 90.64, 93.28, 96].forEach((v, i) => expect(effWeapon(B, 'sniper', (i + 1) as 1).damage).toBeCloseTo(v, 6));
    expect(effWeapon(B, 'sniper', 4).fireIntervalMs).toBeCloseTo(1120, 6);
    expect(effWeapon(B, 'dmr', 4).damage).toBeCloseTo(57.5, 6);
    expect(effWeapon(B, 'dmr', 4).fireIntervalMs).toBeCloseTo(320, 6);
  });

  it('World: an L4 rifle hit deals 28.75 and the damage/kill events carry weapon and level; reload takes 2040 ms', () => {
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }), balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -10);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 1, level: 4, scope: null };
    sp.inv.activeSlot = 0;
    sp.inv.ammo.ammo_heavy = 60;
    const pitch = Math.atan2(2 + 0.5 - (2 + B.movement.stances.stand.eyeHeight), 10);
    const ev = run(w, 1, { [s]: () => ({ fire: true, pitch }) });
    const d = ofType(ev, 'damage')[0]!;
    expect(d.amount).toBeCloseTo(28.75, 6);
    expect(d).toMatchObject({ weapon: 'rifle', weaponLevel: 4, cause: 'weapon' });
    const reload = ofType(ev, 'reloadStart')[0]!;
    expect(reload.durationMs).toBeCloseTo(2040, 6);
    expect(reload.rounds).toBe(B.weapons.rifle.magSize);
    // Remote view of the held level.
    expect(w.snapshotFor(t).players.find((p) => p.id === s)).toMatchObject({ weaponLevel: 4, sight: B.weapons.rifle.sight });
  });

  it('8: 10,000 weapon rolls per spot tier match levels.lootTiers within 2 points; common never gives L4', () => {
    const rng = createRng(7);
    for (const tier of ['common', 'rare', 'epic'] as const) {
      const w = B.levels.lootTiers[tier];
      const sum = w.reduce((a, x) => a + x, 0);
      const n = [0, 0, 0, 0];
      for (let i = 0; i < 10_000; i++) n[rollLevel(w, rng) - 1]!++;
      n.forEach((c, i) => expect(Math.abs((c / 10_000) * 100 - (w[i]! / sum) * 100)).toBeLessThan(2));
      if (tier === 'common') expect(n[3]).toBe(0);
    }
  });

  it('9: a weapon dropped by a swap keeps its level and mag; picking it up again restores both', () => {
    const inv = createInventory();
    inv.slots = [{ weapon: 'smg', mag: 7, level: 3, scope: 'scope_2x' }, { weapon: 'rifle', mag: 2, level: 1, scope: null }];
    inv.activeSlot = 0;
    const o = applyPickup(inv, none(), { item: 'shotgun', qty: 1, mag: 5, level: 2 }, B);
    if (o.kind !== 'taken') throw new Error('refused');
    expect(o.dropped).toEqual({ weapon: 'smg', mag: 7, level: 3, scope: 'scope_2x' });
    expect(inv.slots[0]).toEqual({ weapon: 'shotgun', mag: 5, level: 2, scope: null });
    const back = applyPickup(inv, none(), { item: 'smg', qty: 1, mag: 7, level: 3, scope: 'scope_2x' }, B);
    expect(back.kind).toBe('taken');
    expect(inv.slots[0]).toEqual({ weapon: 'smg', mag: 7, level: 3, scope: 'scope_2x' });
    const drops = deathDrops(inv);
    expect(drops[0]).toEqual({ item: 'smg', qty: 1, mag: 7, level: 3, scope: 'scope_2x' });
  });

  it('10: upgrade swap: L1 rifle in slot 1, SMG held in slot 0, E on an L3 rifle: slot 1 upgraded, L1 dropped with its mag, still holding 0, no swap time', () => {
    const { w, ids } = playingWorld(2, { balance: noSpreadBalance() });
    const [a] = ids as [number];
    land(w, a, 0, 0);
    const p = w.debugPlayer(a)!;
    p.inv.slots = [{ weapon: 'smg', mag: 10, level: 1, scope: null }, { weapon: 'rifle', mag: 3, level: 1, scope: null }];
    p.inv.activeSlot = 0;
    w.debugLoot().push({ id: 700, item: 'rifle', qty: 1, mag: 30, pos: { ...p.move.pos }, tier: 'epic', durability: null, level: 3 });
    const ev = run(w, 1, { [a]: () => ({ interact: true }) });
    expect(p.inv.slots[1]).toEqual({ weapon: 'rifle', mag: B.weapons.rifle.magSize, level: 3, scope: null });
    expect(p.inv.activeSlot).toBe(0);
    expect(p.swapRemainingMs).toBe(0);
    expect(ofType(ev, 'weaponSwitch')).toEqual([]);
    expect(ofType(ev, 'pickup')[0]).toMatchObject({ item: 'rifle', level: 3 });
    expect(w.debugLoot().find((l) => l.item === 'rifle')).toMatchObject({ mag: 3, level: 1 });
    expect(w.snapshotFor(a).loot.find((l) => l.item === 'rifle')).toMatchObject({ level: 1 });
    // E on an L1 rifle with an L3 rifle and an empty slot: normal rule (empty slot).
    const inv = createInventory();
    inv.slots = [{ weapon: 'rifle', mag: 30, level: 3, scope: null }, null];
    inv.activeSlot = 0;
    applyPickup(inv, none(), { item: 'rifle', qty: 1, mag: 30, level: 1 }, B);
    expect(inv.slots[1]).toMatchObject({ weapon: 'rifle', level: 1 });
    expect(inv.slots[0]).toMatchObject({ level: 3 });
  });

  it('upgrade swap of the held, reloading slot cancels the reload and ends ADS', () => {
    const { w, ids } = playingWorld(2, { balance: noSpreadBalance() });
    const [a] = ids as [number];
    land(w, a, 0, 0);
    const p = w.debugPlayer(a)!;
    p.inv.slots = [{ weapon: 'rifle', mag: 0, level: 1, scope: null }, null];
    p.inv.activeSlot = 0;
    p.inv.ammo.ammo_heavy = 60;
    run(w, 1, { [a]: () => ({ reload: true }) });
    expect(p.reload).not.toBeNull();
    w.debugLoot().push({ id: 701, item: 'rifle', qty: 1, mag: 30, pos: { ...p.move.pos }, tier: 'epic', durability: null, level: 2 });
    const ev = run(w, 1, { [a]: () => ({ interact: true }) });
    expect(p.reload).toBeNull();
    expect(ofType(ev, 'reloadEnd')[0]).toMatchObject({ completed: false });
    expect(p.inv.slots[0]).toMatchObject({ level: 2, mag: B.weapons.rifle.magSize });
  });

  it('loot: guaranteed-weapon points always spawn a gun from loot.guaranteedWeapon at L1-L2 plus the extra ammo; weapons roll levels', () => {
    const spawns: LootSpawn[] = Array.from({ length: 400 }, (_, i) => ({ x: i, z: 0, tier: 'common' as const, guarantee: 'weapon' as const }));
    const map = flatMap({ lootSpawns: spawns });
    let id = 1;
    const loot = spawnMatchLoot(map, B, createRng(3), () => id++, () => 0);
    const guns = loot.filter((l) => l.level != null);
    expect(guns.length).toBe(400);
    const allowed = Object.keys(B.loot.guaranteedWeapon.weights);
    for (const g of guns) {
      expect(allowed).toContain(g.item);
      expect(g.level === 1 || g.level === 2).toBe(true);
      expect(g.mag).toBe(B.weapons[g.item as 'pistol'].magSize);
    }
    expect(loot.length).toBe(400 * (1 + B.loot.extraAmmoWithWeapon));
    const l2 = guns.filter((g) => g.level === 2).length / guns.length;
    expect(Math.abs(l2 - 0.2)).toBeLessThan(0.06);
    // Office override: the office weights.
    const office = balanceForMap(B, 'office');
    expect(office.loot.guaranteedWeapon.weights.smg).toBe(15);
  });

  it('time: SIM_DT sanity for the tests above', () => {
    expect(SIM_DT).toBeGreaterThan(0);
  });
});
