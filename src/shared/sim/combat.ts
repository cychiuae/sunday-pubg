/**
 * Pure combat math (docs/design/systems/combat.md "Shot resolution"). The World wires these into the tick.
 */
import type { Balance, WeaponBalance } from '../balance';
import { DEG2RAD, type Rng } from '../math';
import type { Vec3, WeaponId } from '../types';

/**
 * Cone half-angle in degrees: spreadDeg x moveSpreadMultiplier (if horizontal speed > combat.moveSpreadSpeedThreshold)
 * x combat.airSpreadMultiplier (if airborne). ClientGame uses this for the crosshair.
 */
export function effectiveSpreadDeg(
  weapon: WeaponId,
  balance: Balance,
  status: { horizontalSpeed: number; airborne: boolean },
): number {
  const w = balance.weapons[weapon];
  let s = w.spreadDeg;
  if (status.horizontalSpeed > balance.combat.moveSpreadSpeedThreshold) s *= w.moveSpreadMultiplier;
  if (status.airborne) s *= balance.combat.airSpreadMultiplier;
  return s;
}

/** 1 at or below falloffStart, linear to minDamageFactor at falloffEnd, flat beyond. */
export function falloffFactor(w: WeaponBalance, dist: number): number {
  if (dist <= w.falloffStart) return 1;
  if (dist >= w.falloffEnd || w.falloffEnd <= w.falloffStart) return w.minDamageFactor;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 + (w.minDamageFactor - 1) * t;
}

/** Headshot if the hit is at or above feetY + height * (1 - headZoneFraction). */
export function isHeadshot(hitY: number, feetY: number, balance: Balance): boolean {
  const p = balance.player;
  return hitY >= feetY + p.height * (1 - p.headZoneFraction) - 1e-9;
}

/** Damage of one pellet before armor. */
export function pelletDamage(w: WeaponBalance, dist: number, headshot: boolean): number {
  return w.damage * (headshot ? w.headshotMultiplier : 1) * falloffFactor(w, dist);
}

export interface ArmorResult {
  hp: number;
  armor: number;
  /** HP actually removed (after armor). */
  hpTaken: number;
  armorTaken: number;
}

/** `a = min(armor, dmg * absorbFraction)`; armor -= a; hp -= dmg - a. With ignoreArmor the whole amount hits hp. */
export function applyDamage(hp: number, armor: number, dmg: number, absorbFraction: number, ignoreArmor = false): ArmorResult {
  const a = ignoreArmor ? 0 : Math.min(armor, dmg * absorbFraction);
  const hpTaken = dmg - a;
  return { hp: hp - hpTaken, armor: armor - a, hpTaken, armorTaken: a };
}

/** Uniform random direction inside a cone of half-angle `halfAngleRad` around unit `dir`. */
export function sampleCone(dir: Vec3, halfAngleRad: number, rng: Rng): Vec3 {
  if (halfAngleRad <= 0) return { x: dir.x, y: dir.y, z: dir.z };
  const cosMax = Math.cos(halfAngleRad);
  const cosT = 1 - rng.next() * (1 - cosMax);
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  const phi = rng.next() * Math.PI * 2;
  // Orthonormal basis (u, v) perpendicular to dir.
  const ax = Math.abs(dir.y) < 0.99 ? 0 : 1;
  const ay = Math.abs(dir.y) < 0.99 ? 1 : 0;
  // u = normalize(a x dir)
  let ux = ay * dir.z;
  let uy = -ax * dir.z;
  let uz = ax * dir.y - ay * dir.x;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // v = dir x u
  const vx = dir.y * uz - dir.z * uy;
  const vy = dir.z * ux - dir.x * uz;
  const vz = dir.x * uy - dir.y * ux;
  const cp = Math.cos(phi) * sinT;
  const sp = Math.sin(phi) * sinT;
  return {
    x: dir.x * cosT + ux * cp + vx * sp,
    y: dir.y * cosT + uy * cp + vy * sp,
    z: dir.z * cosT + uz * cp + vz * sp,
  };
}

export const spreadRad = (deg: number): number => deg * DEG2RAD;

/**
 * Unit ray vs vertical cylinder (feet at `feet`, radius, height). Returns entry distance t >= 0 (<= maxT) and hit y,
 * or null.
 */
export function rayCylinder(
  o: Vec3,
  d: Vec3,
  feet: Vec3,
  radius: number,
  height: number,
  maxT: number,
): { t: number; y: number } | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  const fx = o.x - feet.x;
  const fz = o.z - feet.z;
  const a = d.x * d.x + d.z * d.z;
  const c = fx * fx + fz * fz - radius * radius;
  if (a < 1e-12) {
    if (c > 0) return null;
  } else {
    const b = fx * d.x + fz * d.z;
    const disc = b * b - a * c;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    t0 = (-b - sq) / a;
    t1 = (-b + sq) / a;
  }
  const yLo = feet.y;
  const yHi = feet.y + height;
  if (Math.abs(d.y) < 1e-12) {
    if (o.y < yLo || o.y > yHi) return null;
  } else {
    let s0 = (yLo - o.y) / d.y;
    let s1 = (yHi - o.y) / d.y;
    if (s0 > s1) {
      const tmp = s0;
      s0 = s1;
      s1 = tmp;
    }
    if (s0 > t0) t0 = s0;
    if (s1 < t1) t1 = s1;
  }
  if (t0 > t1 || t1 < 0) return null;
  const t = Math.max(0, t0);
  if (t > maxT) return null;
  return { t, y: o.y + d.y * t };
}

/** Sum of all pellets' damage at a given distance, body hits (for bot weapon choice). */
export function expectedBodyDps(w: WeaponBalance, dist: number, targetRadius: number): number {
  if (dist > w.range) return 0;
  const half = Math.max(spreadRad(w.spreadDeg), 1e-4);
  // Rough fraction of pellets landing on a target of this radius at this distance.
  const hitFrac = Math.min(1, targetRadius / Math.max(1e-3, dist * Math.tan(half)));
  return (w.damage * w.pellets * falloffFactor(w, dist) * hitFrac * 1000) / Math.max(1, w.fireIntervalMs);
}
