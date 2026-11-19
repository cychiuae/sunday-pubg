/**
 * Inventory, pickup and heal-selection rules (GDD 7.2-7.5, combat.md). Pure helpers; the World owns timing and events.
 * M2c: item levels and the upgrade swap (levels.md), the melee slot (melee.md), the throwable slot with frag and smoke
 * stacks (grenades.md "Throwable slot", smoke.md) and scopes with the one-scope pouch (scopes.md).
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
  ItemLevel,
  M2cThrowableId,
  MeleeId,
  MeleeSlotState,
  ScopeId,
  SlotIndex,
  ThrowableId,
  WeaponId,
  WeaponSlotState,
} from '../types';
import {
  AMMO_IDS,
  ARMOR_PIECES,
  armorIdOf,
  FISTS_SLOT,
  GRENADE_SLOT,
  GUN_IDS,
  HEAL_IDS,
  isArmorId,
  isMeleeId,
  isScopeId,
} from '../types';
import { scopePickupPlan } from './scopes';

export interface Inventory {
  /** Gun slots. The sim always writes `level` and `scope` (M2c). */
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  /** M2a: may be GRENADE_SLOT (3) = the throwable slot. Slot 2 = the melee slot (fists or `melee`). */
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  /** M2a: carried (uncooked) frag grenades. */
  grenades: number;
  /** M2c: the melee slot's weapon, null = fists. */
  melee: MeleeSlotState | null;
  /** M2c: carried smoke canisters. */
  smokes: number;
  /** M2c: the throwable slot's selected type (persists across slot changes). */
  selectedThrowable: M2cThrowableId;
  /** M2c: the spare-scope pouch (scopes.spareSlots = 1), null = empty. */
  spareScope: ScopeId | null;
}

/** M2a: the two worn armor pieces (SimPlayer satisfies this). Armor is worn, never carried. */
export interface WornArmor {
  vest: ArmorPieceState | null;
  helmet: ArmorPieceState | null;
}

/** Every ammo type at 0 (keyed by AMMO_IDS, so it widens with the AmmoId union). */
export function zeroAmmo(): Record<AmmoId, number> {
  const out = {} as Record<AmmoId, number>;
  for (const id of AMMO_IDS) out[id] = 0;
  return out;
}

export function createInventory(): Inventory {
  return {
    slots: [null, null],
    activeSlot: FISTS_SLOT,
    ammo: zeroAmmo(),
    heals: { bandage: 0, medkit: 0 },
    grenades: 0,
    melee: null,
    smokes: 0,
    selectedThrowable: 'grenade',
    spareScope: null,
  };
}

/** M2a name kept: a frag grenade item. */
export const isGrenade = (item: ItemId): item is 'grenade' => item === 'grenade';
/** M2c: frag or smoke (the throwable slot's stacks). */
export const isThrowable = (item: ItemId): item is ThrowableId => item === 'grenade' || item === 'smoke';

export const isGun = (item: ItemId | WeaponId): item is GunId => (GUN_IDS as readonly string[]).includes(item);
export const isAmmo = (item: ItemId): item is AmmoId => (AMMO_IDS as readonly string[]).includes(item);
export const isHeal = (item: ItemId): item is HealId => (HEAL_IDS as readonly string[]).includes(item);
/** M2c: items with a level (guns incl. the rpg, and melee weapons). */
export const isLeveled = (item: ItemId): item is GunId | MeleeId => isGun(item) || isMeleeId(item);

/** M2c: carried count of a throwable type. */
export const throwableCount = (inv: Pick<Inventory, 'grenades' | 'smokes'>, kind: M2cThrowableId): number =>
  kind === 'smoke' ? inv.smokes : inv.grenades;

/** M2c: the other throwable type. */
export const otherThrowable = (kind: M2cThrowableId): M2cThrowableId => (kind === 'smoke' ? 'grenade' : 'smoke');

/**
 * Weapon in hand for gun/melee logic: the melee weapon (or 'fists') for the melee slot, 'fists' for the throwable slot
 * (check activeHeld first).
 */
export function activeWeapon(inv: Pick<Inventory, 'activeSlot' | 'slots'> & { melee?: MeleeSlotState | null }): WeaponId {
  const a = inv.activeSlot;
  if (a === GRENADE_SLOT) return 'fists';
  if (a === FISTS_SLOT) return inv.melee?.weapon ?? 'fists';
  return inv.slots[a as 0 | 1]?.weapon ?? 'fists';
}

/** Item in hand: the selected throwable for slot 3. Snapshot `weapon`, weaponSwitch and the movement step's `held`. */
export function activeHeld(inv: Pick<Inventory, 'activeSlot' | 'slots'> & { melee?: MeleeSlotState | null; selectedThrowable?: M2cThrowableId }): HeldId {
  return inv.activeSlot === GRENADE_SLOT ? (inv.selectedThrowable ?? 'grenade') : activeWeapon(inv);
}

export function activeSlotState(inv: Pick<Inventory, 'activeSlot' | 'slots'>): WeaponSlotState | null {
  const a = inv.activeSlot;
  return a === FISTS_SLOT || a === GRENADE_SLOT ? null : (inv.slots[a as 0 | 1] ?? null);
}

/** M2c: level of the item in hand (gun slot level, melee level), null for fists and throwables. */
export function activeLevel(inv: Pick<Inventory, 'activeSlot' | 'slots'> & { melee?: MeleeSlotState | null }): ItemLevel | null {
  const a = inv.activeSlot;
  if (a === GRENADE_SLOT) return null;
  if (a === FISTS_SLOT) return inv.melee ? inv.melee.level : null;
  const s = inv.slots[a as 0 | 1];
  return s ? (s.level ?? 1) : null;
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
  /** M2c: level of a weapon (guns and melee); absent = L1. */
  level?: ItemLevel | null;
  /** M2c: scope mounted on a gun; absent/null = built-in sight. */
  scope?: ScopeId | null;
}

export type PickupRefusal = 'inventoryFull' | 'betterArmor' | 'scopePouchFull';

export interface PickupTaken {
  kind: 'taken';
  /** Units taken (1 for guns, melee, scopes and armor). */
  taken: number;
  /** Units left on the ground (0 = remove the entity). */
  remaining: number;
  /** A gun that was replaced (normal swap or upgrade swap) and must be dropped at the player's feet. */
  dropped: WeaponSlotState | null;
  /** M2a: a worn armor piece replaced by a better one; drop it at the feet with its durability. */
  droppedArmor: { item: ArmorId; durability: number } | null;
  /** M2c: the melee weapon replaced by a melee pickup. */
  droppedMelee: MeleeSlotState | null;
  /** M2c: a scope displaced by an auto-mount while the pouch was full. */
  droppedScope: ScopeId | null;
  /** Slot the new gun went into (null for non-guns). */
  slot: 0 | 1 | null;
  /** Active slot changed or the active weapon was replaced by a normal swap (cancel reload/heal, start swap). */
  activeChanged: boolean;
  /**
   * M2c (levels.md "Upgrade swap"): the gun slot replaced by a higher level copy, else null. No swap time and the active
   * slot does not change; the caller cancels a reload of that slot and ends ADS when it is the held slot.
   */
  upgradedSlot: 0 | 1 | null;
  /** M2c: a scope pickup was mounted on a gun (scopeChanged, auto). */
  scopeMount: { slot: 0 | 1; gun: GunId; from: ScopeId | null; to: ScopeId } | null;
  /** M2a: durability of the armor piece now worn (armor pickups only). */
  durability?: number;
}

export type PickupOutcome = { kind: 'refused'; reason: PickupRefusal } | PickupTaken;

const taken = (n: number, remaining: number): PickupTaken => ({
  kind: 'taken',
  taken: n,
  remaining,
  dropped: null,
  droppedArmor: null,
  droppedMelee: null,
  droppedScope: null,
  slot: null,
  activeChanged: false,
  upgradedSlot: null,
  scopeMount: null,
});

/** Would an armor pickup be accepted (armor.md "Equipping": N > T, where T = 0 when nothing is worn)? */
export function armorAccepted(worn: WornArmor, item: ArmorId): boolean {
  const { slot, tier } = ARMOR_PIECES[item];
  const cur = worn[slot];
  return tier > (cur ? cur.tier : 0);
}

/** M2c: max carry of a throwable type. */
export const throwableMax = (b: Balance, kind: M2cThrowableId): number => (kind === 'smoke' ? b.items.smoke.maxCarry : b.items.grenade.maxCarry);

/**
 * levels.md "Upgrade swap": the gun slot holding the same id at a LOWER level than `level` (the lowest such level;
 * tie: slot 0), else null.
 */
export function upgradeSlotFor(inv: Pick<Inventory, 'slots'>, gun: GunId, level: ItemLevel): 0 | 1 | null {
  let best: 0 | 1 | null = null;
  let bestLevel = Infinity;
  for (const i of [0, 1] as const) {
    const s = inv.slots[i];
    if (!s || s.weapon !== gun) continue;
    const l = s.level ?? 1;
    if (l < level && l < bestLevel) {
      best = i;
      bestLevel = l;
    }
  }
  return best;
}

/**
 * Refusal reason a pickup would get right now, or null if it would be (at least partly) taken. Pure; used by the World
 * and by prompt prediction.
 */
export function pickupRefusal(inv: Inventory, worn: WornArmor, ground: GroundItem, balance: Balance): PickupRefusal | null {
  const { item } = ground;
  if (isArmorId(item)) return armorAccepted(worn, item) ? null : 'betterArmor';
  if (isGun(item) || isMeleeId(item)) return null;
  if (isScopeId(item)) return scopePickupPlan(inv, item, balance).kind === 'refused' ? 'scopePouchFull' : null;
  if (isAmmo(item)) return inv.ammo[item] >= balance.items[item].maxCarry ? 'inventoryFull' : null;
  if (isHeal(item)) return inv.heals[item] >= balance.items[item].maxStack ? 'inventoryFull' : null;
  if (isThrowable(item)) return throwableCount(inv, item) >= throwableMax(balance, item) ? 'inventoryFull' : null;
  return null;
}

/**
 * Applies a pickup (mutates `inv` and `worn`). Rules:
 * - Gun (levels.md, combat.md): a slot with the same id at a lower level is upgraded in place (no swap); else the first
 *   empty slot; if both are full, replace the held slot (slot 0 when holding the melee or throwable slot) and drop the
 *   old one with its mag, level and scope. Holding the melee or throwable slot equips the new gun.
 * - Melee (melee.md): always taken into the melee slot; the old melee weapon drops. Holding the melee slot = a swap.
 * - Scope (scopes.md): auto-mount on the held gun, else the other gun, else the pouch, else refused scopePouchFull.
 * - Ammo: up to items.<ammo>.maxCarry, remainder stays. Heals: up to maxStack. Throwables: each type up to its
 *   maxCarry; picking one up while carrying none selects it.
 * - Armor (armor.md): all-or-nothing; tier N > worn tier T is worn with the ground durability and the old piece (if
 *   any) drops with its remaining durability; N <= T is refused 'betterArmor'.
 */
export function applyPickup(inv: Inventory, worn: WornArmor, ground: GroundItem, balance: Balance): PickupOutcome {
  const { item, qty } = ground;
  if (qty <= 0) return { kind: 'refused', reason: 'inventoryFull' };
  if (isGun(item)) {
    const mag = Math.max(0, Math.min(balance.weapons[item].magSize, ground.mag ?? 0));
    const level = ground.level ?? 1;
    const fresh: WeaponSlotState = { weapon: item, mag, level, scope: ground.scope ?? null };
    const up = upgradeSlotFor(inv, item, level);
    if (up !== null) {
      const dropped = inv.slots[up];
      inv.slots[up] = fresh;
      return { ...taken(1, qty - 1), dropped, slot: up, upgradedSlot: up };
    }
    const holdingNoGun = inv.activeSlot === FISTS_SLOT || inv.activeSlot === GRENADE_SLOT;
    let slot: 0 | 1;
    let dropped: WeaponSlotState | null = null;
    if (inv.slots[0] === null) slot = 0;
    else if (inv.slots[1] === null) slot = 1;
    else {
      slot = holdingNoGun ? 0 : (inv.activeSlot as 0 | 1);
      dropped = inv.slots[slot];
    }
    inv.slots[slot] = fresh;
    let activeChanged = false;
    if (holdingNoGun) {
      inv.activeSlot = slot;
      activeChanged = true;
    } else if (inv.activeSlot === slot) {
      activeChanged = true; // held weapon replaced
    }
    return { ...taken(1, qty - 1), dropped, slot, activeChanged };
  }
  if (isMeleeId(item)) {
    const old = inv.melee;
    inv.melee = { weapon: item, level: ground.level ?? 1 };
    return { ...taken(1, qty - 1), droppedMelee: old, activeChanged: inv.activeSlot === FISTS_SLOT };
  }
  if (isScopeId(item)) {
    const plan = scopePickupPlan(inv, item, balance);
    if (plan.kind === 'refused') return { kind: 'refused', reason: plan.reason };
    if (plan.kind === 'pouch') {
      inv.spareScope = item;
      return taken(1, qty - 1);
    }
    const s = inv.slots[plan.slot]!;
    const from = s.scope ?? null;
    s.scope = item;
    let droppedScope: ScopeId | null = null;
    if (plan.displaced !== null) {
      if (plan.displacedTo === 'pouch') inv.spareScope = plan.displaced;
      else droppedScope = plan.displaced;
    }
    return { ...taken(1, qty - 1), droppedScope, scopeMount: { slot: plan.slot, gun: s.weapon, from, to: item } };
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
      ...taken(1, qty - 1),
      droppedArmor: old ? { item: armorIdOf(slot, old.tier), durability: old.durability } : null,
      durability,
    };
  }
  let room: number;
  if (isAmmo(item)) room = balance.items[item].maxCarry - inv.ammo[item];
  else if (isHeal(item)) room = balance.items[item].maxStack - inv.heals[item];
  else if (isThrowable(item)) room = throwableMax(balance, item) - throwableCount(inv, item);
  else room = 0;
  const n = Math.max(0, Math.min(room, qty));
  if (n <= 0) return { kind: 'refused', reason: 'inventoryFull' };
  if (isAmmo(item)) inv.ammo[item] += n;
  else if (isHeal(item)) inv.heals[item] += n;
  else if (isThrowable(item)) {
    // grenades.md "Selection persists": picking up a throwable while carrying none selects it.
    if (inv.grenades + inv.smokes === 0) inv.selectedThrowable = item;
    if (item === 'smoke') inv.smokes += n;
    else inv.grenades += n;
  }
  return taken(n, qty - n);
}

/**
 * Everything a dead player drops: guns with mags, levels and scopes, the melee weapon with its level, non-empty ammo
 * pools, heals, each throwable stack, the pouch scope and, with `armor.dropOnDeath`, the worn vest and helmet with
 * their remaining durability.
 */
export function deathDrops(inv: Inventory, worn: WornArmor | null = null, balance: Balance | null = null): GroundItem[] {
  const out: GroundItem[] = [];
  for (const s of inv.slots) {
    if (s) out.push({ item: s.weapon, qty: 1, mag: s.mag, level: s.level ?? 1, scope: s.scope ?? null });
  }
  if (inv.melee) out.push({ item: inv.melee.weapon, qty: 1, mag: null, level: inv.melee.level });
  for (const a of AMMO_IDS) if (inv.ammo[a] > 0) out.push({ item: a, qty: inv.ammo[a], mag: null });
  for (const h of HEAL_IDS) if (inv.heals[h] > 0) out.push({ item: h, qty: inv.heals[h], mag: null });
  if (inv.grenades > 0) out.push({ item: 'grenade', qty: inv.grenades, mag: null });
  if (inv.smokes > 0) out.push({ item: 'smoke', qty: inv.smokes, mag: null });
  if (inv.spareScope !== null) out.push({ item: inv.spareScope, qty: 1, mag: null });
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
