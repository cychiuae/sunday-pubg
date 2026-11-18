/**
 * Inventory, pickup and heal-selection rules (GDD 7.2-7.5, combat.md). Pure helpers; the World owns timing and events.
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import type { AmmoId, GunId, HealId, ItemId, SlotIndex, WeaponId, WeaponSlotState } from '../types';
import { AMMO_IDS, FISTS_SLOT, GUN_IDS, HEAL_IDS } from '../types';

export interface Inventory {
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
}

export function createInventory(): Inventory {
  return {
    slots: [null, null],
    activeSlot: FISTS_SLOT,
    ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0 },
    heals: { bandage: 0, medkit: 0 },
  };
}

export const isGun = (item: ItemId | WeaponId): item is GunId => (GUN_IDS as readonly string[]).includes(item);
export const isAmmo = (item: ItemId): item is AmmoId => (AMMO_IDS as readonly string[]).includes(item);
export const isHeal = (item: ItemId): item is HealId => (HEAL_IDS as readonly string[]).includes(item);

export function activeWeapon(inv: Inventory): WeaponId {
  const a = inv.activeSlot;
  if (a === FISTS_SLOT) return 'fists';
  return inv.slots[a as 0 | 1]?.weapon ?? 'fists';
}

export function activeSlotState(inv: Inventory): WeaponSlotState | null {
  const a = inv.activeSlot;
  return a === FISTS_SLOT ? null : (inv.slots[a as 0 | 1] ?? null);
}

export function reserveFor(inv: Inventory, gun: GunId, balance: Balance): number {
  return inv.ammo[ammoFor(balance, gun)];
}

/** HP at or below which Q prefers a medkit over a bandage: `items.medkit.preferAtOrBelowHp`, else player.maxHp / 2. */
export function medkitPreferBelowHp(balance: Balance): number {
  return balance.items.medkit.preferAtOrBelowHp ?? balance.player.maxHp / 2;
}

/** Heal is useful: it would raise hp. */
const healHelps = (hp: number, item: HealId, balance: Balance): boolean => hp < balance.items[item].healCap;

/**
 * GDD 7.4 "Q picks the best heal". Returns null when the heal must fail (full HP, nothing usable).
 * Dropping/dead checks are the caller's.
 */
export function chooseHeal(hp: number, heals: Record<HealId, number>, balance: Balance): HealId | null {
  if (hp >= balance.player.maxHp) return null;
  const hasMed = heals.medkit > 0 && healHelps(hp, 'medkit', balance);
  const hasBand = heals.bandage > 0 && healHelps(hp, 'bandage', balance);
  if (hp >= balance.items.bandage.healCap) return hasMed ? 'medkit' : null;
  if (hp <= medkitPreferBelowHp(balance) && hasMed) return 'medkit';
  if (hasBand) return 'bandage';
  if (hasMed) return 'medkit';
  return null;
}

/** hp after a completed heal: max(hp, min(healCap, hp + heal)). */
export function healedHp(hp: number, item: HealId, balance: Balance): number {
  const h = balance.items[item];
  return Math.max(hp, Math.min(h.healCap, hp + h.heal));
}

export interface GroundItem {
  item: ItemId;
  qty: number;
  /** Loaded rounds for guns, null otherwise. */
  mag: number | null;
}

export type PickupOutcome =
  | { kind: 'refused' }
  | {
      kind: 'taken';
      /** Units taken (1 for guns/vests). */
      taken: number;
      /** Units left on the ground (0 = remove the entity). */
      remaining: number;
      /** A gun that was replaced and must be dropped at the player's feet. */
      dropped: WeaponSlotState | null;
      /** Slot the new gun went into (null for non-guns). */
      slot: 0 | 1 | null;
      /** Active slot changed or the active weapon was replaced (cancel reload/heal, start swap). */
      activeChanged: boolean;
    };

/**
 * Applies a pickup to the inventory (mutates `inv`, and returns the new armor via `armorOut`). Rules:
 * - Gun: first empty slot; if both are full, replace the held slot (slot 0 when holding fists) and drop the old one
 *   with its mag. Holding fists equips the new gun.
 * - Ammo: up to items.<ammo>.maxCarry, remainder stays. Heals: up to maxStack.
 * - Vest: armor = min(maxArmor, vest.armor); refused when that would not raise armor.
 */
export function applyPickup(
  inv: Inventory,
  armor: number,
  ground: GroundItem,
  balance: Balance,
): { outcome: PickupOutcome; armor: number } {
  const { item, qty } = ground;
  if (qty <= 0) return { outcome: { kind: 'refused' }, armor };
  if (isGun(item)) {
    const mag = Math.max(0, Math.min(balance.weapons[item].magSize, ground.mag ?? 0));
    const fresh: WeaponSlotState = { weapon: item, mag };
    const holdingFists = inv.activeSlot === FISTS_SLOT;
    let slot: 0 | 1;
    let dropped: WeaponSlotState | null = null;
    if (inv.slots[0] === null) slot = 0;
    else if (inv.slots[1] === null) slot = 1;
    else {
      slot = holdingFists ? 0 : (inv.activeSlot as 0 | 1);
      dropped = inv.slots[slot];
    }
    inv.slots[slot] = fresh;
    let activeChanged = false;
    if (holdingFists) {
      inv.activeSlot = slot;
      activeChanged = true;
    } else if (inv.activeSlot === slot) {
      activeChanged = true; // held weapon replaced
    }
    return { outcome: { kind: 'taken', taken: 1, remaining: qty - 1, dropped, slot, activeChanged }, armor };
  }
  if (isAmmo(item)) {
    const room = balance.items[item].maxCarry - inv.ammo[item];
    const taken = Math.max(0, Math.min(room, qty));
    if (taken <= 0) return { outcome: { kind: 'refused' }, armor };
    inv.ammo[item] += taken;
    return { outcome: { kind: 'taken', taken, remaining: qty - taken, dropped: null, slot: null, activeChanged: false }, armor };
  }
  if (isHeal(item)) {
    const room = balance.items[item].maxStack - inv.heals[item];
    const taken = Math.max(0, Math.min(room, qty));
    if (taken <= 0) return { outcome: { kind: 'refused' }, armor };
    inv.heals[item] += taken;
    return { outcome: { kind: 'taken', taken, remaining: qty - taken, dropped: null, slot: null, activeChanged: false }, armor };
  }
  // vest
  const newArmor = Math.min(balance.player.maxArmor, balance.items.vest.armor);
  if (armor >= newArmor) return { outcome: { kind: 'refused' }, armor };
  return {
    outcome: { kind: 'taken', taken: 1, remaining: qty - 1, dropped: null, slot: null, activeChanged: false },
    armor: newArmor,
  };
}

/** Everything a dead player drops: guns with mags, non-empty ammo pools and heals (not armor). */
export function deathDrops(inv: Inventory): GroundItem[] {
  const out: GroundItem[] = [];
  for (const s of inv.slots) if (s) out.push({ item: s.weapon, qty: 1, mag: s.mag });
  for (const a of AMMO_IDS) if (inv.ammo[a] > 0) out.push({ item: a, qty: inv.ammo[a], mag: null });
  for (const h of HEAL_IDS) if (inv.heals[h] > 0) out.push({ item: h, qty: inv.heals[h], mag: null });
  return out;
}

/** Rounds a reload would move into the mag (0 = reload is a no-op). */
export function reloadAmount(slot: WeaponSlotState, reserve: number, balance: Balance): number {
  return Math.max(0, Math.min(balance.weapons[slot.weapon].magSize - slot.mag, reserve));
}
