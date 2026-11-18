/**
 * Inventory, pickup and heal-selection rules (GDD 7.2-7.5, combat.md). Pure helpers; the World owns timing and events.
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import type {
  AmmoId,
  ArmorId,
  ArmorPieceState,
  GunId,
  HealId,
  HeldId,
  ItemId,
  SlotIndex,
  ThrowableId,
  WeaponId,
  WeaponSlotState,
} from '../types';
import { AMMO_IDS, ARMOR_PIECES, armorIdOf, FISTS_SLOT, GRENADE_SLOT, GUN_IDS, HEAL_IDS, isArmorId } from '../types';

export interface Inventory {
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  /** M2a: may be GRENADE_SLOT (3). */
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  /** M2a: carried (uncooked) grenades. */
  grenades: number;
}

/** M2a: the two worn armor pieces (SimPlayer satisfies this). Armor is worn, never carried. */
export interface WornArmor {
  vest: ArmorPieceState | null;
  helmet: ArmorPieceState | null;
}

export function createInventory(): Inventory {
  return {
    slots: [null, null],
    activeSlot: FISTS_SLOT,
    ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0 },
    heals: { bandage: 0, medkit: 0 },
    grenades: 0,
  };
}

export const isGrenade = (item: ItemId): item is ThrowableId => item === 'grenade';

export const isGun = (item: ItemId | WeaponId): item is GunId => (GUN_IDS as readonly string[]).includes(item);
export const isAmmo = (item: ItemId): item is AmmoId => (AMMO_IDS as readonly string[]).includes(item);
export const isHeal = (item: ItemId): item is HealId => (HEAL_IDS as readonly string[]).includes(item);

/** Weapon in hand for gun/fist logic: 'fists' for the fists slot and for the grenade slot (check activeHeld first). */
export function activeWeapon(inv: Inventory): WeaponId {
  const a = inv.activeSlot;
  if (a === FISTS_SLOT || a === GRENADE_SLOT) return 'fists';
  return inv.slots[a as 0 | 1]?.weapon ?? 'fists';
}

/** M2a: item in hand ('grenade' for slot 3). Snapshot `weapon`, weaponSwitch and the movement step's `held`. */
export function activeHeld(inv: Inventory): HeldId {
  return inv.activeSlot === GRENADE_SLOT ? 'grenade' : activeWeapon(inv);
}

export function activeSlotState(inv: Inventory): WeaponSlotState | null {
  const a = inv.activeSlot;
  return a === FISTS_SLOT || a === GRENADE_SLOT ? null : (inv.slots[a as 0 | 1] ?? null);
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
  /** M2a: remaining durability for armor pieces (absent/null = fresh items[id].durability). */
  durability?: number | null;
}

export type PickupRefusal = 'inventoryFull' | 'betterArmor';

export type PickupOutcome =
  | { kind: 'refused'; reason: PickupRefusal }
  | {
      kind: 'taken';
      /** Units taken (1 for guns and armor). */
      taken: number;
      /** Units left on the ground (0 = remove the entity). */
      remaining: number;
      /** A gun that was replaced and must be dropped at the player's feet. */
      dropped: WeaponSlotState | null;
      /** M2a: a worn armor piece replaced by a better one; drop it at the feet with its durability. */
      droppedArmor: { item: ArmorId; durability: number } | null;
      /** Slot the new gun went into (null for non-guns). */
      slot: 0 | 1 | null;
      /** Active slot changed or the active weapon was replaced (cancel reload/heal, start swap). */
      activeChanged: boolean;
      /** M2a: durability of the armor piece now worn (armor pickups only). */
      durability?: number;
    };

const taken = (n: number, remaining: number): PickupOutcome => ({
  kind: 'taken',
  taken: n,
  remaining,
  dropped: null,
  droppedArmor: null,
  slot: null,
  activeChanged: false,
});

/** Would an armor pickup be accepted (armor.md "Equipping": N > T, where T = 0 when nothing is worn)? */
export function armorAccepted(worn: WornArmor, item: ArmorId): boolean {
  const { slot, tier } = ARMOR_PIECES[item];
  const cur = worn[slot];
  return tier > (cur ? cur.tier : 0);
}

/**
 * Refusal reason a pickup would get right now, or null if it would be (at least partly) taken. Pure; used by the World
 * and by prompt prediction.
 */
export function pickupRefusal(inv: Inventory, worn: WornArmor, ground: GroundItem, balance: Balance): PickupRefusal | null {
  const { item } = ground;
  if (isArmorId(item)) return armorAccepted(worn, item) ? null : 'betterArmor';
  if (isGun(item)) return null;
  if (isAmmo(item)) return inv.ammo[item] >= balance.items[item].maxCarry ? 'inventoryFull' : null;
  if (isHeal(item)) return inv.heals[item] >= balance.items[item].maxStack ? 'inventoryFull' : null;
  return inv.grenades >= balance.items.grenade.maxCarry ? 'inventoryFull' : null;
}

/**
 * Applies a pickup (mutates `inv` and `worn`). Rules:
 * - Gun: first empty slot; if both are full, replace the held slot (slot 0 when holding fists or the grenade slot) and
 *   drop the old one with its mag. Holding fists or the grenade slot equips the new gun.
 * - Ammo: up to items.<ammo>.maxCarry, remainder stays. Heals: up to maxStack. Grenades: up to items.grenade.maxCarry.
 * - Armor (armor.md): all-or-nothing; tier N > worn tier T is worn with the ground durability and the old piece (if
 *   any) drops with its remaining durability; N <= T is refused 'betterArmor'.
 */
export function applyPickup(inv: Inventory, worn: WornArmor, ground: GroundItem, balance: Balance): PickupOutcome {
  const { item, qty } = ground;
  if (qty <= 0) return { kind: 'refused', reason: 'inventoryFull' };
  if (isGun(item)) {
    const mag = Math.max(0, Math.min(balance.weapons[item].magSize, ground.mag ?? 0));
    const fresh: WeaponSlotState = { weapon: item, mag };
    const holdingFists = inv.activeSlot === FISTS_SLOT || inv.activeSlot === GRENADE_SLOT;
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
    return { kind: 'taken', taken: 1, remaining: qty - 1, dropped, droppedArmor: null, slot, activeChanged };
  }
  if (isArmorId(item)) {
    if (!armorAccepted(worn, item)) return { kind: 'refused', reason: 'betterArmor' };
    const { slot, tier } = ARMOR_PIECES[item];
    const old = worn[slot];
    const fresh = balance.items[item].durability;
    const d = ground.durability ?? fresh;
    const durability = d > 0 ? d : fresh;
    worn[slot] = { tier, durability };
    return {
      ...(taken(1, qty - 1) as Extract<PickupOutcome, { kind: 'taken' }>),
      droppedArmor: old ? { item: armorIdOf(slot, old.tier), durability: old.durability } : null,
      durability,
    };
  }
  let room: number;
  if (isAmmo(item)) room = balance.items[item].maxCarry - inv.ammo[item];
  else if (isHeal(item)) room = balance.items[item].maxStack - inv.heals[item];
  else room = balance.items.grenade.maxCarry - inv.grenades;
  const n = Math.max(0, Math.min(room, qty));
  if (n <= 0) return { kind: 'refused', reason: 'inventoryFull' };
  if (isAmmo(item)) inv.ammo[item] += n;
  else if (isHeal(item)) inv.heals[item] += n;
  else inv.grenades += n;
  return taken(n, qty - n);
}

/**
 * Everything a dead player drops: guns with mags, non-empty ammo pools, heals, the grenade stack (M2a) and, with
 * `armor.dropOnDeath`, the worn vest and helmet with their remaining durability (M2a).
 */
export function deathDrops(inv: Inventory, worn: WornArmor | null = null, balance: Balance | null = null): GroundItem[] {
  const out: GroundItem[] = [];
  for (const s of inv.slots) if (s) out.push({ item: s.weapon, qty: 1, mag: s.mag });
  for (const a of AMMO_IDS) if (inv.ammo[a] > 0) out.push({ item: a, qty: inv.ammo[a], mag: null });
  for (const h of HEAL_IDS) if (inv.heals[h] > 0) out.push({ item: h, qty: inv.heals[h], mag: null });
  if (inv.grenades > 0) out.push({ item: 'grenade', qty: inv.grenades, mag: null });
  if (worn && balance?.armor.dropOnDeath) {
    for (const slot of ['vest', 'helmet'] as const) {
      const piece = worn[slot];
      if (piece && piece.durability > 0) {
        out.push({ item: armorIdOf(slot, piece.tier), qty: 1, mag: null, durability: piece.durability });
      }
    }
  }
  return out;
}

/** Rounds a reload would move into the mag (0 = reload is a no-op). */
export function reloadAmount(slot: WeaponSlotState, reserve: number, balance: Balance): number {
  return Math.max(0, Math.min(balance.weapons[slot.weapon].magSize - slot.mag, reserve));
}
