/**
 * Pure combat math (docs/design/systems/combat.md "Shot resolution"). The World wires these into the tick.
 */
import type { Balance, WeaponBalance } from '../balance';
import { weaponBalance } from '../balance';
import { clamp, DEG2RAD, type Rng } from '../math';
import type { ArmorPieceState, ItemLevel, M2cHeldId, MovementState, ScopeId, Stance, Vec3, WeaponId } from '../types';
import { isM2cThrowableId } from '../types';
import { effWeapon } from './levels';

/** M2c: the level and mounted scope of the weapon instance in hand (absent = L1, built-in sight). */
export interface WeaponInstance {
  level?: ItemLevel;
  scope?: ScopeId | null;
}

/** Shooter status for the spread cone (combat.md "Spread"). The M2a fields default to hip fire, standing, settled. */
export interface SpreadStatus {
  horizontalSpeed: number;
  airborne: boolean;
  /** adsProgressOf(...) in [0, 1]. Default 0. */
  adsProgress?: number;
  /** Default 'stand'. */
  stance?: Stance;
  /** S applies only while settled. Default true. */
  stanceSettled?: boolean;
}

/**
 * Cone half-angle in degrees: spreadDeg x A x S x M x J (combat.md "Spread"), no clamps.
 * A = 1 + (adsSpreadMultiplier - 1) x adsProgress; S = combat.stanceSpreadMultiplier[stance] when settled, else 1;
 * M = moveSpreadMultiplier when horizontal speed > combat.moveSpreadSpeedThreshold; J = combat.airSpreadMultiplier
 * when airborne. ClientGame uses this for the crosshair.
 */
export function effectiveSpreadDeg(weapon: WeaponId, balance: Balance, status: SpreadStatus, inst: WeaponInstance = {}): number {
  const w = effWeapon(balance, weapon, inst.level ?? 1, inst.scope ?? null);
  let s = w.spreadDeg;
  const ads = clamp(status.adsProgress ?? 0, 0, 1);
  if (ads > 0) s *= 1 + (w.adsSpreadMultiplier - 1) * ads;
  if (status.stanceSettled !== false) s *= balance.combat.stanceSpreadMultiplier[status.stance ?? 'stand'];
  if (status.horizontalSpeed > balance.combat.moveSpreadSpeedThreshold) s *= w.moveSpreadMultiplier;
  if (status.airborne) s *= balance.combat.airSpreadMultiplier;
  return s;
}

/**
 * ADS progress in [0, 1] = adsMs / weapons[held].adsTimeMs (combat.md "ADS"). 0 for the grenade slot, sight 'none'
 * and adsTimeMs <= 0 (only fists, which never engage).
 */
export function adsProgressOf(m: Pick<MovementState, 'adsMs'>, held: M2cHeldId, b: Balance, scope: ScopeId | null = null): number {
  if (isM2cThrowableId(held)) return 0;
  const w = scope === null ? weaponBalance(b, held) : effWeapon(b, held, 1, scope);
  if (w.sight === 'none' || !(w.adsTimeMs > 0) || !(m.adsMs > 0)) return 0;
  return clamp(m.adsMs / w.adsTimeMs, 0, 1);
}

/** 1 at or below falloffStart, linear to minDamageFactor at falloffEnd, flat beyond. */
export function falloffFactor(w: WeaponBalance, dist: number): number {
  if (dist <= w.falloffStart) return 1;
  if (dist >= w.falloffEnd || w.falloffEnd <= w.falloffStart) return w.minDamageFactor;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return 1 + (w.minDamageFactor - 1) * t;
}

/** Damage of one pellet before armor. */
export function pelletDamage(w: WeaponBalance, dist: number, headshot: boolean): number {
  return w.damage * (headshot ? w.headshotMultiplier : 1) * falloffFactor(w, dist);
}

/** Destroyed below this durability (float accumulation; armor.md "piece.durability <= 1e-6"). */
export const ARMOR_BREAK_EPSILON = 1e-6;

export interface ArmorPieceResult {
  /** The piece after the hit; null when it was destroyed (or there was none). */
  piece: ArmorPieceState | null;
  /** Durability removed. */
  absorbed: number;
  /** The piece reached 0 this hit. */
  broken: boolean;
  /** HP lost = dmg - absorbed. */
  hpLoss: number;
}

/**
 * One armor piece takes `dmg` (armor.md "Damage application"): a = min(durability, dmg x absorbFraction);
 * durability -= a; hp loss = dmg - a; destroyed at 0. With no piece the whole amount is HP loss.
 */
export function applyArmorPiece(piece: ArmorPieceState | null, dmg: number, absorbFraction: number): ArmorPieceResult {
  if (!piece || !(dmg > 0)) return { piece, absorbed: 0, broken: false, hpLoss: Math.max(0, dmg) };
  const a = Math.min(piece.durability, dmg * absorbFraction);
  const left = piece.durability - a;
  const broken = left <= ARMOR_BREAK_EPSILON;
  return { piece: broken ? null : { tier: piece.tier, durability: left }, absorbed: a, broken, hpLoss: dmg - a };
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

/**
 * Sum of all pellets' damage per second at a distance, body hits (bot weapon choice). `spreadDeg` overrides the cone
 * (bots pass the ADS cone when they will aim at that distance).
 */
export function expectedBodyDps(w: WeaponBalance, dist: number, targetRadius: number, spreadDeg = w.spreadDeg): number {
  if (dist > w.range) return 0;
  const half = Math.max(spreadRad(spreadDeg), 1e-4);
  // Rough fraction of pellets landing on a target of this radius at this distance.
  const hitFrac = Math.min(1, targetRadius / Math.max(1e-3, dist * Math.tan(half)));
  return (w.damage * w.pellets * falloffFactor(w, dist) * hitFrac * 1000) / Math.max(1, w.fireIntervalMs);
}
