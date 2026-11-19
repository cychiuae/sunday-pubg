/**
 * Loot table rolls and match-start loot spawning (docs/design/systems/loot.md).
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import type { Rng } from '../math';
import type { AnyMapData, GunId, ItemId, ItemLevel, LootId, LootState, LootTier, M2cItemId, ScopeId, Vec3 } from '../types';
import { GUN_IDS, isArmorId, ITEM_IDS } from '../types';
import { forEachColliderNear, overlapsCircle, type ColliderSet } from './colliders';
import { isAmmo, isGrenade, isGun, isHeal, isLeveled } from './inventory';
import { rollLevel } from './levels';
import { heightAt } from './terrain';

/** Server-side loot entity (LootState + the gun's loaded mag). */
export interface LootEntity {
  id: LootId;
  item: ItemId;
  qty: number;
  mag: number | null;
  pos: Vec3;
  /** Tier of the spawn point it came from; drops use dropTierOf(item) (LootState.tier). */
  tier: LootTier;
  /** M2a: remaining durability of an armor pickup (null for every other item). */
  durability: number | null;
  /** M2c: level of a weapon (guns and melee), null/absent for every other item (absent on a weapon = L1). */
  level?: ItemLevel | null;
  /** M2c: scope mounted on a ground gun, null/absent = built-in sight (and for non-guns). */
  scope?: ScopeId | null;
}

export function toLootState(l: LootEntity): LootState {
  const s: LootState = { id: l.id, item: l.item, qty: l.qty, pos: { x: l.pos.x, y: l.pos.y, z: l.pos.z }, tier: l.tier };
  if (l.durability !== null) s.durability = l.durability;
  if (l.level != null) s.level = l.level;
  else if (isLeveled(l.item)) s.level = 1;
  if (l.scope != null) s.scope = l.scope;
  return s;
}

/**
 * Rarity glow of dropped items (death, weapon swap and armor swap drops): a fixed per-item table (loot.md "UI",
 * M2a). Spawned items keep their spawn point's tier.
 */
const DROP_TIERS: Readonly<Record<M2cItemId, LootTier>> = {
  dmr: 'epic',
  sniper: 'epic',
  medkit: 'epic',
  vest_3: 'epic',
  helmet_3: 'epic',
  ammo_sniper: 'epic',
  rifle: 'rare',
  lmg: 'rare',
  smg: 'rare',
  shotgun: 'rare',
  vest_2: 'rare',
  helmet_2: 'rare',
  pistol: 'common',
  bandage: 'common',
  vest_1: 'common',
  helmet_1: 'common',
  grenade: 'common',
  ammo_light: 'common',
  ammo_heavy: 'common',
  ammo_shell: 'common',
  // M2c ids (gate prep): placeholder glow tiers so the table stays exhaustive after the C-gate. levels.md replaces the
  // tier glow with the item's level colour in Phase 2; scopes, ammo, heals and throwables then glow neutral.
  rpg: 'epic',
  ammo_rocket: 'epic',
  vest_4: 'epic',
  helmet_4: 'epic',
  scope_8x: 'epic',
  revolver: 'rare',
  dbshotgun: 'rare',
  machete: 'rare',
  paddle: 'rare',
  scope_4x: 'rare',
  knife: 'common',
  smoke: 'common',
  scope_red_dot: 'common',
  scope_2x: 'common',
};
export const dropTierOf = (item: ItemId): LootTier => DROP_TIERS[item];

/** Weighted pick from a tier table (ItemId -> weight, missing = 0). Null if the table is empty. */
export function rollTier(balance: Balance, tier: LootTier, rng: Rng): ItemId | null {
  const table = balance.loot.tiers[tier];
  let total = 0;
  for (const id of ITEM_IDS) total += Math.max(0, table[id] ?? 0);
  if (total <= 0) return null;
  let x = rng.next() * total;
  for (const id of ITEM_IDS) {
    const w = Math.max(0, table[id] ?? 0);
    if (w <= 0) continue;
    if (x < w) return id;
    x -= w;
  }
  // Floating-point edge: return the last item with weight.
  for (let i = ITEM_IDS.length - 1; i >= 0; i--) if ((table[ITEM_IDS[i]!] ?? 0) > 0) return ITEM_IDS[i]!;
  return null;
}

/** Quantity, mag and durability of a freshly spawned item (loot.md "Rules"). */
export function spawnQuantity(item: ItemId, balance: Balance): { qty: number; mag: number | null; durability: number | null } {
  if (isGun(item)) {
    return { qty: 1, mag: balance.loot.weaponSpawnsWithFullMag ? balance.weapons[item].magSize : 0, durability: null };
  }
  if (isAmmo(item)) return { qty: balance.items[item].pickupQty, mag: null, durability: null };
  if (isHeal(item)) return { qty: balance.items[item].spawnQty, mag: null, durability: null };
  if (isGrenade(item)) return { qty: balance.items.grenade.spawnQty, mag: null, durability: null };
  if (item === 'smoke') return { qty: balance.items.smoke.spawnQty, mag: null, durability: null };
  if (isArmorId(item)) return { qty: 1, mag: null, durability: balance.items[item].durability };
  // Melee weapons and scopes: one, no mag.
  return { qty: 1, mag: null, durability: null };
}

/** M2c (loot.md "Guaranteed weapons"): weighted gun from loot.guaranteedWeapon.weights (GUN_IDS order). */
export function rollGuaranteedGun(balance: Balance, rng: Rng): GunId | null {
  const w = balance.loot.guaranteedWeapon.weights;
  let total = 0;
  for (const id of GUN_IDS) total += Math.max(0, w[id] ?? 0);
  if (!(total > 0)) return null;
  let x = rng.next() * total;
  let last: GunId | null = null;
  for (const id of GUN_IDS) {
    const v = Math.max(0, w[id] ?? 0);
    if (v <= 0) continue;
    last = id;
    if (x < v) return id;
    x -= v;
  }
  return last;
}

/** Uniform point in a disc of radius `r` around (x, z). */
export function scatterInDisc(x: number, z: number, r: number, rng: Rng): { x: number; z: number } {
  const a = rng.next() * Math.PI * 2;
  const d = r * Math.sqrt(rng.next());
  return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d };
}

/**
 * Rolls every map loot spawn: `spawnChance`, then a weighted item from its tier, plus `extraAmmoWithWeapon` ammo
 * stacks within `extraAmmoScatter` m of each gun. `groundY(x, z, y)` gives the resting height; `y` is the spawn's
 * support-height hint (M2b `LootSpawn.y`, desk plateaus) or undefined for ground spawns. The World resolves it with
 * groundHeightAt(ctx, x, z, y ?? terrain), so plateau loot lands on the desk, not under it.
 */
export function spawnMatchLoot(
  map: AnyMapData,
  balance: Balance,
  rng: Rng,
  nextId: () => LootId,
  groundY: (x: number, z: number, y: number | undefined) => number,
): LootEntity[] {
  const out: LootEntity[] = [];
  for (const sp of map.lootSpawns) {
    // M2c: guaranteed-weapon points always spawn one gun from loot.guaranteedWeapon at a level from its own table.
    const guaranteed = sp.guarantee === 'weapon';
    let item: ItemId | null;
    let level: ItemLevel | null = null;
    if (guaranteed) {
      item = rollGuaranteedGun(balance, rng);
      if (item) level = rollLevel(balance.loot.guaranteedWeapon.levels, rng);
    } else {
      if (rng.next() >= balance.loot.spawnChance) continue;
      item = rollTier(balance, sp.tier, rng);
      // levels.md "Rolling levels": a weapon rolled at a spot gets a level from levels.lootTiers[spot tier].
      if (item && isLeveled(item)) level = rollLevel(balance.levels.lootTiers[sp.tier], rng);
    }
    if (!item) continue;
    const { qty, mag, durability } = spawnQuantity(item, balance);
    out.push({
      id: nextId(),
      item,
      qty,
      mag,
      pos: { x: sp.x, y: groundY(sp.x, sp.z, sp.y), z: sp.z },
      tier: sp.tier,
      durability,
      level,
      scope: null,
    });
    if (isGun(item)) {
      const ammo = ammoFor(balance, item);
      for (let i = 0; i < balance.loot.extraAmmoWithWeapon; i++) {
        const p = scatterInDisc(sp.x, sp.z, balance.loot.extraAmmoScatter, rng);
        out.push({
          id: nextId(),
          item: ammo,
          qty: balance.items[ammo].pickupQty,
          mag: null,
          pos: { x: p.x, y: groundY(p.x, p.z, sp.y), z: p.z },
          tier: sp.tier,
          durability: null,
          level: null,
          scope: null,
        });
      }
    }
  }
  return out;
}

/** A spawn counts as inside a collider when the footprint holds it and the prism spans this far above its support. */
const INSIDE_PROBE_HEIGHT = 0.05;

/**
 * Level-data check (loot.md edge case): indices of map.lootSpawns that sit inside a prop collider. M2b: only colliders
 * whose vertical span contains the spawn's support height (`y`, else the terrain / floor) count, so under-desk and
 * desk-top spawns are not flagged by the desk top or the floor below.
 */
export function lootSpawnsInsideColliders(map: AnyMapData, set: ColliderSet): number[] {
  const bad: number[] = [];
  map.lootSpawns.forEach((sp, i) => {
    let inside = false;
    const probe = (sp.y ?? heightAt(sp.x, sp.z, map)) + INSIDE_PROBE_HEIGHT;
    forEachColliderNear(set, sp.x, sp.z, 0, (c) => {
      if (c.bottom <= probe && c.top > probe && overlapsCircle(c, sp.x, sp.z, 0)) inside = true;
    });
    if (inside) bad.push(i);
  });
  return bad;
}
