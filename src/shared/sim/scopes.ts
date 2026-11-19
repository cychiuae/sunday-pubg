/**
 * M2c scope attachments in the sim (scopes.md): pickup auto-mount rules and the T sight switch. Pure helpers on the
 * inventory; the World and the shared action step apply them and emit `scopeChanged`.
 */
import { compatibleScopes, effectiveSight, scopeFits, sightRank, type Balance } from '../balance';
import type { ActionFailReason, ScopeId, SlotIndex, WeaponSlotState } from '../types';

/** The inventory fields the scope rules read. */
export interface ScopeInventory {
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  activeSlot: SlotIndex;
  spareScope?: ScopeId | null;
}

/** Rank of a gun slot's current sight (mounted scope, else built-in). */
export function slotSightRank(b: Balance, s: WeaponSlotState): number {
  return sightRank(b, effectiveSight(b, s.weapon, s.scope ?? null));
}

/** Rank of the sight a scope gives. */
export const scopeRank = (b: Balance, scope: ScopeId): number => sightRank(b, b.scopes[scope].sight);

/** The gun slot accepts `scope` and its current sight ranks lower (scopes.md pickup rules 1 and 2). */
export function wouldMount(b: Balance, s: WeaponSlotState | null, scope: ScopeId): boolean {
  return s !== null && scopeFits(b, s.weapon, scope) && slotSightRank(b, s) < scopeRank(b, scope);
}

export type ScopePickupPlan =
  /** Mount on gun slot `slot`; the scope it carried (if any) goes to the pouch when empty, else to the ground. */
  | { kind: 'mount'; slot: 0 | 1; displaced: ScopeId | null; displacedTo: 'pouch' | 'ground' | null }
  | { kind: 'pouch' }
  | { kind: 'refused'; reason: 'scopePouchFull' };

/** scopes.md "Picking up a scope (E)": held gun, then the other gun, then the pouch, else refused. */
export function scopePickupPlan(inv: ScopeInventory, scope: ScopeId, b: Balance): ScopePickupPlan {
  const held = inv.activeSlot === 0 || inv.activeSlot === 1 ? inv.activeSlot : null;
  const order: (0 | 1)[] = held === 1 ? [1, 0] : held === 0 ? [0, 1] : [0, 1];
  const pouchEmpty = (inv.spareScope ?? null) === null;
  for (const i of order) {
    const s = inv.slots[i];
    // Rule 1 is the held gun; rule 2 the other gun. Holding no gun: both slots are "other" (slot 0 first).
    if (wouldMount(b, s, scope)) {
      const displaced = s!.scope ?? null;
      return { kind: 'mount', slot: i, displaced, displacedTo: displaced === null ? null : pouchEmpty ? 'pouch' : 'ground' };
    }
  }
  if (pouchEmpty) return { kind: 'pouch' };
  return { kind: 'refused', reason: 'scopePouchFull' };
}

export type ScopeCyclePlan =
  | { kind: 'refused'; reason: Extract<ActionFailReason, 'scopeCantFit' | 'scopeNoneFits' | 'scopePouchFull'> }
  /** After scopes.swapMs: slot `slot` gets `to` (null = built-in) and the pouch gets `pouch`. */
  | { kind: 'swap'; slot: 0 | 1; from: ScopeId | null; to: ScopeId | null; pouch: ScopeId | null };

/**
 * scopes.md "T": with a one-scope pouch: a fitting pouch scope is exchanged with the mounted one (or none); an empty
 * pouch takes the mounted scope (built-in sight again). Refusals: no gun or a gun that accepts no scope ->
 * scopeCantFit; nothing mounted and nothing fitting in the pouch -> scopeNoneFits; a scope mounted and a pouch scope
 * that does not fit -> scopePouchFull.
 */
export function scopeCyclePlan(inv: ScopeInventory, b: Balance): ScopeCyclePlan {
  const a = inv.activeSlot;
  const s = a === 0 || a === 1 ? inv.slots[a] : null;
  if (!s || (a !== 0 && a !== 1) || compatibleScopes(b, s.weapon).length === 0) return { kind: 'refused', reason: 'scopeCantFit' };
  const mounted = s.scope ?? null;
  const pouch = inv.spareScope ?? null;
  if (pouch !== null && scopeFits(b, s.weapon, pouch)) return { kind: 'swap', slot: a, from: mounted, to: pouch, pouch: mounted };
  if (pouch === null && mounted !== null) return { kind: 'swap', slot: a, from: mounted, to: null, pouch: mounted };
  if (mounted === null) return { kind: 'refused', reason: 'scopeNoneFits' };
  return { kind: 'refused', reason: 'scopePouchFull' };
}
