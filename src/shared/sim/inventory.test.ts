import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { applyPickup, chooseHeal, createInventory, deathDrops, healedHp, reloadAmount } from './inventory';

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
    const r = applyPickup(inv, 0, { item: 'smg', qty: 1, mag: 30 }, b);
    expect(r.outcome).toMatchObject({ kind: 'taken', slot: 0, dropped: null, activeChanged: true });
    expect(inv.activeSlot).toBe(0);
    const r2 = applyPickup(inv, 0, { item: 'rifle', qty: 1, mag: 7 }, b);
    expect(r2.outcome).toMatchObject({ kind: 'taken', slot: 1, activeChanged: false });
    expect(inv.slots[1]).toEqual({ weapon: 'rifle', mag: 7 });
  });

  it('full inventory: replaces the held weapon and drops it with its mag (AT10)', () => {
    const inv = createInventory();
    inv.slots = [
      { weapon: 'pistol', mag: 4 },
      { weapon: 'smg', mag: 11 },
    ];
    inv.activeSlot = 1;
    const r = applyPickup(inv, 0, { item: 'shotgun', qty: 1, mag: 5 }, b);
    expect(r.outcome).toMatchObject({ kind: 'taken', slot: 1, dropped: { weapon: 'smg', mag: 11 }, activeChanged: true });
    expect(inv.slots[1]).toEqual({ weapon: 'shotgun', mag: 5 });
    // Holding fists with both full: replaces slot 1 (index 0) and equips it.
    inv.activeSlot = 2;
    const r2 = applyPickup(inv, 0, { item: 'rifle', qty: 1, mag: 25 }, b);
    expect(r2.outcome).toMatchObject({ kind: 'taken', slot: 0, dropped: { weapon: 'pistol', mag: 4 } });
    expect(inv.activeSlot).toBe(0);
  });

  it('ammo pickup is capped by maxCarry; the rest stays (AT11)', () => {
    const inv = createInventory();
    inv.ammo.ammo_light = 170;
    const r = applyPickup(inv, 0, { item: 'ammo_light', qty: 30, mag: null }, b);
    expect(r.outcome).toMatchObject({ kind: 'taken', taken: 10, remaining: 20 });
    expect(inv.ammo.ammo_light).toBe(180);
    expect(applyPickup(inv, 0, { item: 'ammo_light', qty: 20, mag: null }, b).outcome.kind).toBe('refused');
  });

  it('heal stacks capped by maxStack', () => {
    const inv = createInventory();
    inv.heals.bandage = 9;
    const r = applyPickup(inv, 0, { item: 'bandage', qty: 3, mag: null }, b);
    expect(r.outcome).toMatchObject({ kind: 'taken', taken: 1, remaining: 2 });
  });

  it('vest refused at 50 armor, sets 50 at 10 armor (AT12)', () => {
    const inv = createInventory();
    expect(applyPickup(inv, 50, { item: 'vest', qty: 1, mag: null }, b).outcome.kind).toBe('refused');
    const r = applyPickup(inv, 10, { item: 'vest', qty: 1, mag: null }, b);
    expect(r.outcome.kind).toBe('taken');
    expect(r.armor).toBe(50);
  });

  it('death drops everything except armor', () => {
    const inv = createInventory();
    inv.slots = [{ weapon: 'pistol', mag: 4 }, null];
    inv.ammo.ammo_shell = 7;
    inv.heals.medkit = 1;
    expect(deathDrops(inv)).toEqual([
      { item: 'pistol', qty: 1, mag: 4 },
      { item: 'ammo_shell', qty: 7, mag: null },
      { item: 'medkit', qty: 1, mag: null },
    ]);
  });
});
