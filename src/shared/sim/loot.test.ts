import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { createRng } from '../math';
import { GUN_IDS, type ItemId } from '../types';
import { ISLAND } from '../../game/levels/island';
import { isAmmo, isGun } from './inventory';
import { rollTier, spawnMatchLoot } from './loot';
import { balanceWith } from './testkit';

describe('loot', () => {
  it('spawnChance 1: every spawn has exactly one item plus ammo extras for weapons (loot.md AT1, AT3)', () => {
    const b = balanceWith((x) => (x.loot.spawnChance = 1));
    let id = 1;
    const loot = spawnMatchLoot(ISLAND, b, createRng(5), () => id++, () => 0);
    const primaries = loot.filter((l) => ISLAND.lootSpawns.some((s) => s.x === l.pos.x && s.z === l.pos.z));
    expect(primaries.length).toBe(ISLAND.lootSpawns.length);
    // LootState.tier: every item carries its spawn point's tier (extra ammo shares the gun's tier).
    for (const l of primaries) expect(l.tier).toBe(ISLAND.lootSpawns.find((s) => s.x === l.pos.x && s.z === l.pos.z)!.tier);
    const guns = primaries.filter((l) => isGun(l.item));
    expect(loot.length).toBe(ISLAND.lootSpawns.length + guns.length * b.loot.extraAmmoWithWeapon);
    for (const g of guns) {
      const gun = g.item as (typeof GUN_IDS)[number];
      expect(g.mag).toBe(b.weapons[gun].magSize);
      const ammo = b.weapons[gun].ammo!;
      const near = loot.filter(
        (l) => l.item === ammo && l !== g && Math.hypot(l.pos.x - g.pos.x, l.pos.z - g.pos.z) <= b.loot.extraAmmoScatter + 1e-9,
      );
      expect(near.length).toBeGreaterThanOrEqual(b.loot.extraAmmoWithWeapon);
      for (const n of near) expect(n.qty).toBe(b.items[ammo].pickupQty);
    }
    expect(new Set(loot.map((l) => l.id)).size).toBe(loot.length);
  });

  it('common table frequencies match weights within 2% over 10,000 rolls (AT2)', () => {
    const rng = createRng(11);
    const counts = new Map<ItemId, number>();
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const it = rollTier(BALANCE, 'common', rng)!;
      counts.set(it, (counts.get(it) ?? 0) + 1);
    }
    const table = BALANCE.loot.tiers.common;
    const total = Object.values(table).reduce((a, v) => a + (v ?? 0), 0);
    for (const [item, w] of Object.entries(table)) {
      expect(Math.abs((counts.get(item as ItemId) ?? 0) / N - (w ?? 0) / total)).toBeLessThan(0.02);
    }
  });

  it('epic table never yields pistol or ammo (AT4)', () => {
    const rng = createRng(12);
    for (let i = 0; i < 5000; i++) {
      const it = rollTier(BALANCE, 'epic', rng)!;
      expect(it).not.toBe('pistol');
      expect(isAmmo(it)).toBe(false);
    }
  });
});
