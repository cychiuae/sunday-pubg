/**
 * M2c client glue for the pickup prompt and remote scopes (UI M2c §3, §16.3). Owner: game-developer.
 *
 * The rules themselves are the sim's (src/shared/sim/scopes.ts `scopePickupPlan`, inventory.ts `upgradeSlotFor`):
 * these functions only turn them into the prompt fields and rebuild a spectated player's scope from their sight.
 */
import { compatibleScopes, type Balance } from '../shared/balance';
import { upgradeSlotFor } from '../shared/sim/inventory';
import { scopePickupPlan } from '../shared/sim/scopes';
import type { LocalPlayerState, LootState, M2cGunId, M2cSightType, ScopeId, SlotIndex } from '../shared/types';
import { FISTS_SLOT, GRENADE_SLOT, isM2cGunId, isMeleeId, isScopeId } from '../shared/types';

/** interactPromptChanged.scopeTarget: where E on a scope would go (sim scopePickupPlan), null if refused or not a scope. */
export function scopeTargetOf(
  loot: Pick<LootState, 'item'>,
  local: LocalPlayerState,
  activeSlot: SlotIndex,
  balance: Balance,
): 0 | 1 | 'pouch' | null {
  if (!isScopeId(loot.item)) return null;
  const plan = scopePickupPlan({ slots: local.slots, activeSlot, spareScope: local.spareScope }, loot.item, balance);
  return plan.kind === 'mount' ? plan.slot : plan.kind === 'pouch' ? 'pouch' : null;
}

/**
 * interactPromptChanged.replacesSlot (UI "Swap X for Y"): melee -> slot 2 when a melee weapon is carried (fists are not
 * an item); guns -> the upgrade-swap slot (sim upgradeSlotFor), else null while a gun slot is free, else the held gun
 * slot (slot 0 when holding fists, melee or a throwable: sim applyPickup). Other items: null.
 */
export function pickupReplacesSlot(loot: Pick<LootState, 'item' | 'level'>, local: LocalPlayerState, activeSlot: SlotIndex): SlotIndex | null {
  const item = loot.item;
  if (isMeleeId(item)) return local.melee ? FISTS_SLOT : null;
  if (!isM2cGunId(item)) return null;
  const up = upgradeSlotFor(local, item, loot.level ?? 1);
  if (up !== null) return up;
  if (local.slots[0] === null || local.slots[1] === null) return null;
  return activeSlot === FISTS_SLOT || activeSlot === GRENADE_SLOT ? 0 : (activeSlot as 0 | 1);
}

/**
 * The scope that gives `gun` the effective `sight` (remote players only send PlayerState.sight), or null for the
 * built-in sight. Used to rebuild a spectated player's ADS zoom (effectiveWeapon needs the scope id).
 */
export function scopeForSight(balance: Balance, gun: M2cGunId, sight: M2cSightType): ScopeId | null {
  if (sight === 'none') return null;
  for (const id of compatibleScopes(balance, gun)) if (balance.scopes[id].sight === sight) return id;
  return null;
}
