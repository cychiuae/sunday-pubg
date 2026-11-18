/**
 * Loot table rolls and match-start loot spawning (docs/design/systems/loot.md).
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import type { Rng } from '../math';
import type { ItemId, LootId, LootState, LootTier, MapData, Vec3 } from '../types';
import { ITEM_IDS } from '../types';
import { forEachColliderNear, overlapsCircle, type ColliderSet } from './colliders';
import { isAmmo, isGun, isHeal } from './inventory';

/** Server-side loot entity (LootState + the gun's loaded mag). */
export interface LootEntity {
  id: LootId;
  item: ItemId;
  qty: number;
  mag: number | null;
  pos: Vec3;
  /** Tier of the spawn point it came from; death drops and swap drops are 'common' (LootState.tier). */
  tier: LootTier;
}

export const toLootState = (l: LootEntity): LootState => ({
  id: l.id,
  item: l.item,
  qty: l.qty,
  pos: { x: l.pos.x, y: l.pos.y, z: l.pos.z },
  tier: l.tier,
});

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

/** Quantity and mag of a freshly spawned item. */
export function spawnQuantity(item: ItemId, balance: Balance): { qty: number; mag: number | null } {
  if (isGun(item)) {
    return { qty: 1, mag: balance.loot.weaponSpawnsWithFullMag ? balance.weapons[item].magSize : 0 };
  }
  if (isAmmo(item)) return { qty: balance.items[item].pickupQty, mag: null };
  if (isHeal(item)) return { qty: balance.items[item].spawnQty, mag: null };
  return { qty: 1, mag: null };
}

/** Uniform point in a disc of radius `r` around (x, z). */
export function scatterInDisc(x: number, z: number, r: number, rng: Rng): { x: number; z: number } {
  const a = rng.next() * Math.PI * 2;
  const d = r * Math.sqrt(rng.next());
  return { x: x + Math.cos(a) * d, z: z + Math.sin(a) * d };
}

/**
 * Rolls every map loot spawn: `spawnChance`, then a weighted item from its tier, plus `extraAmmoWithWeapon` ammo
 * stacks within `extraAmmoScatter` m of each gun. `groundY(x, z)` gives the resting height.
 */
export function spawnMatchLoot(
  map: MapData,
  balance: Balance,
  rng: Rng,
  nextId: () => LootId,
  groundY: (x: number, z: number) => number,
): LootEntity[] {
  const out: LootEntity[] = [];
  for (const sp of map.lootSpawns) {
    if (rng.next() >= balance.loot.spawnChance) continue;
    const item = rollTier(balance, sp.tier, rng);
    if (!item) continue;
    const { qty, mag } = spawnQuantity(item, balance);
    out.push({ id: nextId(), item, qty, mag, pos: { x: sp.x, y: groundY(sp.x, sp.z), z: sp.z }, tier: sp.tier });
    if (isGun(item)) {
      const ammo = ammoFor(balance, item);
      for (let i = 0; i < balance.loot.extraAmmoWithWeapon; i++) {
        const p = scatterInDisc(sp.x, sp.z, balance.loot.extraAmmoScatter, rng);
        out.push({
          id: nextId(),
          item: ammo,
          qty: balance.items[ammo].pickupQty,
          mag: null,
          pos: { x: p.x, y: groundY(p.x, p.z), z: p.z },
          tier: sp.tier,
        });
      }
    }
  }
  return out;
}

/** Level-data check (loot.md edge case): indices of map.lootSpawns that sit inside a prop collider. */
export function lootSpawnsInsideColliders(map: MapData, set: ColliderSet): number[] {
  const bad: number[] = [];
  map.lootSpawns.forEach((sp, i) => {
    let inside = false;
    forEachColliderNear(set, sp.x, sp.z, 0, (c) => {
      if (overlapsCircle(c, sp.x, sp.z, 0)) inside = true;
    });
    if (inside) bad.push(i);
  });
  return bad;
}
