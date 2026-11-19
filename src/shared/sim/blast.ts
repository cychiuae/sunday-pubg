/**
 * M2c (rpg.md, grenades.md "Explosion", ADR 0007 §4): the blast model shared by frag grenades and rockets. Damage at the
 * 3D distance from the blast to a target's chest: `maxDamage` within innerRadius, linear to maxDamage x minDamageFactor
 * at `radius`, 0 beyond. `maxDamage` is passed separately so the rocket can scale it by level (rocketBlastMaxDamage).
 * Line of sight runs from pos + losHeightOffset to the chest; props, terrain and intact glass block, players and smoke do
 * not. Vests absorb, helmets never do (the World applies armor).
 */
import type { BlastBalance } from '../balance';
import type { AnyMapData, Vec3 } from '../types';
import { lineOfSight, type ColliderSet } from './colliders';

/** Blast damage at chest distance `dist` (grenades.md "Explosion" with `blast.*`). */
export function blastDamage(dist: number, blast: BlastBalance, maxDamage: number = blast.maxDamage): number {
  if (!(dist <= blast.radius)) return 0;
  if (dist <= blast.innerRadius) return maxDamage;
  const span = blast.radius - blast.innerRadius;
  const t = span > 0 ? (dist - blast.innerRadius) / span : 1;
  return maxDamage * (1 + (blast.minDamageFactor - 1) * t);
}

/** A target the blast may reach: its chest point (stance aware) and an id for the caller. */
export interface BlastTarget<T> {
  target: T;
  chest: Vec3;
}

/**
 * Every target hit by a blast at `pos`, in the order given, with its damage (> 0) and chest distance. LOS from
 * pos + losHeightOffset to the chest through `colliders` (pass a set whose broken panes are open).
 */
export function blastHits<T>(
  pos: Vec3,
  blast: BlastBalance,
  maxDamage: number,
  targets: readonly BlastTarget<T>[],
  colliders: ColliderSet,
  map: AnyMapData,
): { target: T; damage: number; dist: number }[] {
  const out: { target: T; damage: number; dist: number }[] = [];
  const losFrom = { x: pos.x, y: pos.y + blast.losHeightOffset, z: pos.z };
  for (const t of targets) {
    const c = t.chest;
    const d = Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z);
    if (d > blast.radius) continue;
    const dmg = blastDamage(d, blast, maxDamage);
    if (dmg <= 0) continue;
    if (!lineOfSight(colliders, map, losFrom, c)) continue;
    out.push({ target: t.target, damage: dmg, dist: d });
  }
  return out;
}
