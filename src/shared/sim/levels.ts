/**
 * M2c item levels in the sim (levels.md, ADR 0007 §2): the cached effective-weapon lookup used on hot paths (fire,
 * reload, spread, ADS), level rolls for loot, and the bots' level value. Every number comes from `effectiveWeapon`
 * (balance.ts), the one stat rule shared with client prediction, the HUD and bots.
 */
import { effectiveWeapon, type Balance, type EffectiveWeapon, type LevelArray } from '../balance';
import type { Rng } from '../math';
import type { ItemLevel, M2cWeaponId, MeleeSlotState, ScopeId, WeaponSlotState } from '../types';
import { ITEM_LEVELS } from '../types';

const cache = new WeakMap<Balance, Map<string, EffectiveWeapon>>();

/**
 * effectiveWeapon(b, id, level, scope), cached per balance object and (id, level, scope). The result is shared and
 * frozen (read-only).
 */
export function effWeapon(b: Balance, id: M2cWeaponId, level: ItemLevel = 1, scope: ScopeId | null = null): EffectiveWeapon {
  let m = cache.get(b);
  if (!m) {
    m = new Map();
    cache.set(b, m);
  }
  const key = `${id}|${level}|${scope ?? ''}`;
  let e = m.get(key);
  if (!e) {
    // REVIEW-M2c N1: frozen, so no caller can change everyone's effective stats.
    e = Object.freeze(effectiveWeapon(b, id, level, scope));
    m.set(key, e);
  }
  return e;
}

/** Level of a gun slot (absent = L1, levels.md "A weapon created without a roll is L1"). */
export const slotLevel = (s: Pick<WeaponSlotState, 'level'> | MeleeSlotState | null | undefined): ItemLevel => s?.level ?? 1;

/** Effective stats of the gun in a slot (its level and mounted scope). */
export const slotWeapon = (b: Balance, s: WeaponSlotState): EffectiveWeapon => effWeapon(b, s.weapon, s.level ?? 1, s.scope ?? null);

/** Weighted level pick from relative weights for L1..L4 (levels.lootTiers.<tier>, loot.guaranteedWeapon.levels). */
export function rollLevel(weights: LevelArray, rng: Rng): ItemLevel {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (!(total > 0)) return 1;
  let x = rng.next() * total;
  for (let i = 0; i < ITEM_LEVELS.length; i++) {
    const w = Math.max(0, weights[i] ?? 0);
    if (w <= 0) continue;
    if (x < w) return ITEM_LEVELS[i]!;
    x -= w;
  }
  for (let i = ITEM_LEVELS.length - 1; i >= 0; i--) if ((weights[i] ?? 0) > 0) return ITEM_LEVELS[i]!;
  return 1;
}

/** Bots: lootValue multiplier for a weapon level (levels.botValueMultiplier). */
export const levelValue = (b: Balance, level: ItemLevel): number => b.levels.botValueMultiplier[level - 1] ?? 1;
