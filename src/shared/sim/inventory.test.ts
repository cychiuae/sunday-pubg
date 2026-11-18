import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { applyPickup, chooseHeal, createInventory, deathDrops, healedHp, reloadAmount, type WornArmor } from './inventory';

const none = (): WornArmor => ({ vest: null, helmet: null });

const b = BALANCE;

describe('inventory rules', () => {
  it('heal selection and caps (combat.md AT8, GDD 7.4)', () => {
    expect(healedHp(70, 'bandage', b)).toBe(75);
    expect(chooseHeal(75, { bandage: 3, medkit: 0 }, b)).toBeNull();
    expect(chooseHeal(75, { bandage: 3, medkit: 1 }, b)).toBe('medkit');
    expect(healedHp(30, 'medkit', b)).toBe(100);
    expect(chooseHeal(100, { bandage: 3, medkit: 1 }, b)).toBeNull();
    expect(chooseHeal(40, { bandage: 3, medkit: 1 }, b)).toBe('medkit');
    expect(chooseHeal(60, { bandage: 3, medkit: 1 }, b)).toBe('bandage');
    expect(chooseHeal(60, { bandage: 0, medkit: 1 }, b)).toBe('medkit');
    expect(chooseHeal(60, { bandage: 0, medkit: 0 }, b)).toBeNull();
  });

  it('reload partially fills from a small reserve (AT6)', () => {
    expect(reloadAmount({ weapon: 'pistol', mag: 3 }, 5, b)).toBe(5);
    expect(reloadAmount({ weapon: 'pistol', mag: 12 }, 50, b)).toBe(0);
    expect(reloadAmount({ weapon: 'pistol', mag: 3 }, 0, b)).toBe(0);
  });

  it('gun pickup fills the first empty slot and equips when holding fists', () => {
    const inv = createInventory();
    const r = applyPickup(inv, none(), { item: 'smg', qty: 1, mag: 30 }, b);
    expect(r).toMatchObject({ kind: 'taken', slot: 0, dropped: null, activeChanged: true });
    expect(inv.activeSlot).toBe(0);
    const r2 = applyPickup(inv, none(), { item: 'rifle', qty: 1, mag: 7 }, b);
    expect(r2).toMatchObject({ kind: 'taken', slot: 1, activeChanged: false });
    expect(inv.slots[1]).toEqual({ weapon: 'rifle', mag: 7 });
  });

  it('full inventory: replaces the held weapon and drops it with its mag (AT10)', () => {
    const inv = createInventory();
    inv.slots = [
      { weapon: 'pistol', mag: 4 },
      { weapon: 'smg', mag: 11 },
    ];
    inv.activeSlot = 1;
    const r = applyPickup(inv, none(), { item: 'shotgun', qty: 1, mag: 5 }, b);
    expect(r).toMatchObject({ kind: 'taken', slot: 1, dropped: { weapon: 'smg', mag: 11 }, activeChanged: true });
    expect(inv.slots[1]).toEqual({ weapon: 'shotgun', mag: 5 });
    // Holding fists with both full: replaces slot 1 (index 0) and equips it.
    inv.activeSlot = 2;
    const r2 = applyPickup(inv, none(), { item: 'rifle', qty: 1, mag: 25 }, b);
    expect(r2).toMatchObject({ kind: 'taken', slot: 0, dropped: { weapon: 'pistol', mag: 4 } });
    expect(inv.activeSlot).toBe(0);
  });

  it('ammo pickup is capped by maxCarry; the rest stays (AT11)', () => {
    const inv = createInventory();
    inv.ammo.ammo_light = 170;
    const r = applyPickup(inv, none(), { item: 'ammo_light', qty: 30, mag: null }, b);
    expect(r).toMatchObject({ kind: 'taken', taken: 10, remaining: 20 });
    expect(inv.ammo.ammo_light).toBe(180);
    expect(applyPickup(inv, none(), { item: 'ammo_light', qty: 20, mag: null }, b).kind).toBe('refused');
  });

  it('heal stacks capped by maxStack', () => {
    const inv = createInventory();
    inv.heals.bandage = 9;
    const r = applyPickup(inv, none(), { item: 'bandage', qty: 3, mag: null }, b);
    expect(r).toMatchObject({ kind: 'taken', taken: 1, remaining: 2 });
  });

  it('armor: higher tier replaces and drops the old piece with its durability; same or lower is refused (armor.md AT5-7)', () => {
    const inv = createInventory();
    const worn: WornArmor = { vest: { tier: 1, durability: 20 }, helmet: null };
    const r = applyPickup(inv, worn, { item: 'vest_2', qty: 1, mag: null, durability: 55 }, b);
    expect(r).toMatchObject({ kind: 'taken', taken: 1, remaining: 0, droppedArmor: { item: 'vest_1', durability: 20 }, durability: 55 });
    expect(worn.vest).toEqual({ tier: 2, durability: 55 });
    worn.vest = { tier: 2, durability: 1 };
    expect(applyPickup(inv, worn, { item: 'vest_1', qty: 1, mag: null, durability: 35 }, b)).toEqual({ kind: 'refused', reason: 'betterArmor' });
    worn.vest = { tier: 2, durability: 10 };
    expect(applyPickup(inv, worn, { item: 'vest_2', qty: 1, mag: null, durability: 55 }, b).kind).toBe('refused');
    expect(worn.vest).toEqual({ tier: 2, durability: 10 });
    const h = applyPickup(inv, worn, { item: 'helmet_1', qty: 1, mag: null, durability: 12 }, b);
    expect(h).toMatchObject({ kind: 'taken', droppedArmor: null, durability: 12 });
    expect(worn.helmet).toEqual({ tier: 1, durability: 12 });
    // Absent durability = a fresh piece.
    applyPickup(inv, worn, { item: 'helmet_3', qty: 1, mag: null }, b);
    expect(worn.helmet).toEqual({ tier: 3, durability: b.items.helmet_3.durability });
  });

  it('grenades: up to maxCarry, partial pickup leaves the rest (grenades.md AT16)', () => {
    const inv = createInventory();
    inv.grenades = 3;
    expect(applyPickup(inv, none(), { item: 'grenade', qty: 2, mag: null }, b)).toEqual({ kind: 'refused', reason: 'inventoryFull' });
    inv.grenades = 2;
    expect(applyPickup(inv, none(), { item: 'grenade', qty: 2, mag: null }, b)).toMatchObject({ kind: 'taken', taken: 1, remaining: 1 });
    expect(inv.grenades).toBe(3);
  });

  it('sniper ammo caps at maxCarry (combat.md AT12)', () => {
    const inv = createInventory();
    inv.ammo.ammo_sniper = 18;
    expect(applyPickup(inv, none(), { item: 'ammo_sniper', qty: 5, mag: null }, b)).toMatchObject({ taken: 2, remaining: 3 });
  });

  it('a gun picked up while holding the grenade slot with both slots full replaces slot 0 and equips it', () => {
    const inv = createInventory();
    inv.slots = [
      { weapon: 'pistol', mag: 4 },
      { weapon: 'smg', mag: 11 },
    ];
    inv.activeSlot = 3;
    const r = applyPickup(inv, none(), { item: 'dmr', qty: 1, mag: 10 }, b);
    expect(r).toMatchObject({ kind: 'taken', slot: 0, dropped: { weapon: 'pistol', mag: 4 }, activeChanged: true });
    expect(inv.activeSlot).toBe(0);
  });

  it('death drops guns, ammo, heals, grenades and worn armor with durability (armor.md AT8)', () => {
    const inv = createInventory();
    inv.slots = [{ weapon: 'pistol', mag: 4 }, null];
    inv.ammo.ammo_shell = 7;
    inv.heals.medkit = 1;
    inv.grenades = 2;
    expect(deathDrops(inv, { vest: { tier: 2, durability: 30 }, helmet: { tier: 1, durability: 30 } }, b)).toEqual([
      { item: 'pistol', qty: 1, mag: 4 },
      { item: 'ammo_shell', qty: 7, mag: null },
      { item: 'medkit', qty: 1, mag: null },
      { item: 'grenade', qty: 2, mag: null },
      { item: 'vest_2', qty: 1, mag: null, durability: 30 },
      { item: 'helmet_1', qty: 1, mag: null, durability: 30 },
    ]);
    expect(deathDrops(inv, none(), b).some((g) => g.item.startsWith('vest'))).toBe(false);
  });
});
