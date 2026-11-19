/**
 * M2c scopes (docs/design/systems/scopes.md "Acceptance tests" 1-9, sim side).
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import { GUN_IDS, type SimEvent } from '../types';
import { effectiveSpreadDeg } from './combat';
import { applyPickup, createInventory } from './inventory';
import { effWeapon } from './levels';
import { initialMovementState, stepMovement, toMovementInput, createMovementContext } from './movement';
import { scopeCyclePlan } from './scopes';
import { flatMap, input, land, noSpreadBalance, playingWorld, run } from './testkit';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const B = BALANCE;
const none = () => ({ vest: null, helmet: null });
const ticks = (ms: number) => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);

describe('scopes (scopes.md)', () => {
  it('1: defaults unchanged for every gun with no scope', () => {
    for (const g of GUN_IDS) {
      const e = effWeapon(B, g, 1, null);
      const w = B.weapons[g];
      expect([e.adsZoom, e.adsTimeMs, e.adsSpreadMultiplier, e.adsMoveMultiplier]).toEqual([w.adsZoom, w.adsTimeMs, w.adsSpreadMultiplier, w.adsMoveMultiplier]);
    }
  });

  it('2/3/4: rifle + 4x: zoom 4, 345 ms, ADS cone 0.674, walk 2.76 m/s; hip cone unchanged; DMR / sniper values', () => {
    const r4 = effWeapon(B, 'rifle', 1, 'scope_4x');
    expect(r4.adsZoom).toBe(4);
    expect(r4.adsTimeMs).toBeCloseTo(345, 6);
    const still = { horizontalSpeed: 0, airborne: false, adsProgress: 1 };
    expect(effectiveSpreadDeg('rifle', B, still, { scope: 'scope_4x' })).toBeCloseTo(0.674, 3);
    expect(effectiveSpreadDeg('rifle', B, { ...still, adsProgress: 0 }, { scope: 'scope_4x' })).toBeCloseTo(B.weapons.rifle.spreadDeg, 9);
    expect(effWeapon(B, 'dmr', 1, 'scope_red_dot').adsTimeMs).toBeCloseTo(200, 6);
    expect(effWeapon(B, 'dmr', 1, 'scope_8x').adsTimeMs).toBeCloseTo(380, 6);
    expect(effWeapon(B, 'sniper', 1, 'scope_4x').adsTimeMs).toBeCloseTo(315.8, 1);
    // Movement: full ADS walk with the 4x mounted = walkSpeed x adsMove (0.5525).
    const ctx = createMovementContext(flatMap(), B);
    let m = initialMovementState({ x: 0, y: 2, z: 0 }, false);
    const status = { alive: true, healing: false, reloading: false, held: 'rifle' as const, swapping: false, fireSlowed: false, scope: 'scope_4x' as const };
    for (let i = 0; i < 60; i++) m = stepMovement(m, toMovementInput(input({ moveForward: 1, ads: true }), status, B), SIM_DT, ctx).state;
    expect(m.adsMs).toBeCloseTo(345, 6);
    expect(Math.hypot(m.vel.x, m.vel.z)).toBeCloseTo(B.movement.walkSpeed * 0.5525, 3);
  });

  it('5: pickup rules: 2x -> rifle; 2x -> SMG; 4x -> rifle (2x to the pouch); red dot -> refused scopePouchFull', () => {
    const inv = createInventory();
    inv.slots = [{ weapon: 'rifle', mag: 1, level: 1, scope: null }, { weapon: 'smg', mag: 1, level: 1, scope: null }];
    inv.activeSlot = 0;
    const take = (item: 'scope_2x' | 'scope_4x' | 'scope_red_dot') => applyPickup(inv, none(), { item, qty: 1, mag: null }, B);
    expect(take('scope_2x')).toMatchObject({ kind: 'taken', scopeMount: { slot: 0, to: 'scope_2x', from: null } });
    expect(take('scope_2x')).toMatchObject({ kind: 'taken', scopeMount: { slot: 1, to: 'scope_2x' } });
    expect(take('scope_4x')).toMatchObject({ kind: 'taken', scopeMount: { slot: 0, from: 'scope_2x', to: 'scope_4x' }, droppedScope: null });
    expect(inv.spareScope).toBe('scope_2x');
    expect(take('scope_red_dot')).toEqual({ kind: 'refused', reason: 'scopePouchFull' });
  });

  it('6: holding a DMR (4x default), E on a 4x: not mounted, goes to the pouch', () => {
    const inv = createInventory();
    inv.slots = [{ weapon: 'dmr', mag: 1, level: 1, scope: null }, null];
    inv.activeSlot = 0;
    applyPickup(inv, none(), { item: 'scope_4x', qty: 1, mag: null }, B);
    expect(inv.slots[0]!.scope).toBeNull();
    expect(inv.spareScope).toBe('scope_4x');
  });

  it('7: T: exchange after 600 ms with no shots during it; remove to the pouch; refusals', () => {
    const { w, ids } = playingWorld(2, { map: flatMap(), balance: noSpreadBalance() });
    const [a, b] = ids as [number, number];
    land(w, a, 0, 0);
    land(w, b, 50, 50);
    const p = w.debugPlayer(a)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 30, level: 1, scope: 'scope_4x' };
    p.inv.activeSlot = 0;
    p.inv.spareScope = 'scope_2x';
    const start = run(w, 1, { [a]: () => ({ cycleScope: true }) });
    expect(ofType(start, 'scopeChanged')).toEqual([]);
    const during = run(w, ticks(500), { [a]: () => ({ fire: true }) });
    expect(ofType(during, 'shot')).toEqual([]);
    const end = run(w, ticks(200), { [a]: () => ({}) });
    expect(ofType(end, 'scopeChanged')[0]).toMatchObject({ slot: 0, gun: 'rifle', from: 'scope_4x', to: 'scope_2x', auto: false });
    expect(p.inv.slots[0]!.scope).toBe('scope_2x');
    expect(p.inv.spareScope).toBe('scope_4x');
    expect(w.snapshotFor(a).players.find((x) => x.id === a)!.sight).toBe('scope_2x');
    // Rifle + 4x, empty pouch: T removes it.
    p.inv.slots[0]!.scope = 'scope_4x';
    p.inv.spareScope = null;
    run(w, 1, { [a]: () => ({ cycleScope: true }) });
    run(w, ticks(700), { [a]: () => ({}) });
    expect(p.inv.slots[0]!.scope).toBeNull();
    expect(p.inv.spareScope).toBe('scope_4x');
    // Refusals (pure rules).
    const plan = (scope: 'scope_4x' | null, pouch: 'scope_8x' | null, weapon: 'rifle' | 'rpg' = 'rifle') =>
      scopeCyclePlan({ slots: [{ weapon, mag: 1, scope }, null], activeSlot: 0, spareScope: pouch }, B);
    expect(plan(null, 'scope_8x')).toEqual({ kind: 'refused', reason: 'scopeNoneFits' });
    expect(plan('scope_4x', 'scope_8x')).toEqual({ kind: 'refused', reason: 'scopePouchFull' });
    expect(plan(null, null, 'rpg')).toEqual({ kind: 'refused', reason: 'scopeCantFit' });
    expect(scopeCyclePlan({ slots: [null, null], activeSlot: 2, spareScope: null }, B)).toMatchObject({ reason: 'scopeCantFit' });
    // T while ADS: nothing.
    p.inv.spareScope = null;
    p.inv.slots[0]!.scope = 'scope_4x';
    run(w, ticks(400), { [a]: () => ({ ads: true }) });
    run(w, 1, { [a]: () => ({ ads: true, cycleScope: true }) });
    expect(p.scopeSwap).toBeNull();
    // A knife: refused scopeCantFit (actionFailed for humans).
    p.inv.melee = { weapon: 'knife', level: 1 };
    run(w, 1, { [a]: () => ({ selectSlot: 2 }) });
    run(w, ticks(400), { [a]: () => ({}) });
    const ref = run(w, 1, { [a]: () => ({ cycleScope: true }) });
    expect(ofType(ref, 'actionFailed')[0]).toMatchObject({ action: 'scope', reason: 'scopeCantFit' });
  });

  it('8: death drops a gun with its scope and the pouch scope as its own pickup', () => {
    const { w, ids } = playingWorld(2, { map: flatMap() });
    const [a] = ids as [number];
    land(w, a, 0, 0);
    const p = w.debugPlayer(a)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 3, level: 2, scope: 'scope_4x' };
    p.inv.spareScope = 'scope_2x';
    p.hp = 0.001;
    p.dying = { killerId: null, weapon: null, cause: 'zone' };
    run(w, 1);
    expect(w.debugLoot().find((l) => l.item === 'rifle')).toMatchObject({ scope: 'scope_4x', level: 2, mag: 3 });
    expect(w.debugLoot().find((l) => l.item === 'scope_2x')).toBeDefined();
    expect(w.snapshotFor(ids[1]!).loot.find((l) => l.item === 'rifle')).toMatchObject({ scope: 'scope_4x', level: 2 });
  });
});
