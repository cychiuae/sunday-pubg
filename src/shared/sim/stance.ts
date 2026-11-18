/**
 * Stance helpers (docs/design/systems/stance.md, ADR 0004 §1-2). Pure: reads only its arguments.
 * The single implementation of eye height, hitbox height, chest point, transition progress and the stance hitbox ray
 * test, used by World (hitscan, blast LOS), bots, ClientGame (camera pivot, prediction) and tests.
 */
import type { Balance } from '../balance';
import { PITCH_MAX, PITCH_MIN } from '../constants';
import { DEG2RAD } from '../math';
import type { AnyMapData, MovementState, Stance, StanceRequest, Vec3 } from '../types';
import { stanceTransitionKey } from '../types';
import { forEachColliderNear, overlapsCircle, type ColliderSet } from './colliders';
import { rayCylinder } from './combat';
import { heightAt } from './terrain';

type StanceFields = Pick<MovementState, 'stance' | 'stanceFrom' | 'stanceMs'>;

/**
 * Footprint shrink for the headroom overlap test, metres. Collision push-out leaves a player exactly touching a wall,
 * and "touching" must not count as "under" it (stance.md "Headroom": colliders the player stands next to never match).
 */
const HEADROOM_TOUCH_EPSILON = 1e-3;

/** Settled = no transition running. */
export const isStanceSettled = (m: Pick<MovementState, 'stanceMs'>): boolean => !(m.stanceMs > 0);

/** Transition progress in [0, 1]; 1 = settled. progress = 1 - stanceMs / transitionMs[from_to]. */
export function stanceProgress(m: StanceFields, b: Balance): number {
  if (isStanceSettled(m) || m.stanceFrom === m.stance) return 1;
  const total = b.movement.stances.transitionMs[stanceTransitionKey(m.stanceFrom, m.stance)];
  if (!(total > 0)) return 1;
  const p = 1 - m.stanceMs / total;
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** Eye height above the feet: settled = stances[stance].eyeHeight; in a transition, lerped by progress. */
export function eyeHeightOf(m: StanceFields, b: Balance): number {
  const s = b.movement.stances;
  const to = s[m.stance].eyeHeight;
  if (isStanceSettled(m) || m.stanceFrom === m.stance) return to;
  const from = s[m.stanceFrom].eyeHeight;
  return from + (to - from) * stanceProgress(m, b);
}

/** The stance whose hitbox applies: the settled stance, or the taller of stanceFrom / stance during a transition. */
export function hitboxStanceOf(m: StanceFields, b: Balance): Stance {
  if (isStanceSettled(m) || m.stanceFrom === m.stance) return m.stance;
  const s = b.movement.stances;
  return s[m.stanceFrom].height >= s[m.stance].height ? m.stanceFrom : m.stance;
}

/** Hitbox and collision height (feet to top): the taller stance during transitions. */
export const hitboxHeightOf = (m: StanceFields, b: Balance): number => b.movement.stances[hitboxStanceOf(m, b)].height;

/** Feet + half the hitbox height (grenade LOS and distance, bot aim). */
export function chestPoint(feet: Vec3, m: StanceFields, b: Balance): Vec3 {
  return { x: feet.x, y: feet.y + hitboxHeightOf(m, b) * 0.5, z: feet.z };
}

/** Feet + eye height (shot origin, throw origin, bot line of sight). */
export function eyePoint(feet: Vec3, m: StanceFields, b: Balance): Vec3 {
  return { x: feet.x, y: feet.y + eyeHeightOf(m, b), z: feet.z };
}

/**
 * Ray (unit `dir`) vs the stance hitbox of a player with feet at `feet` and look yaw `yaw` (ADR 0004 §2).
 * - stand / crouch (and every transition): vertical cylinder r player.radius, h = that stance's height; head zone from
 *   player.headZoneFraction (stand) or combat.hitbox.crouchHeadZoneFraction (crouch).
 * - settled prone: level box centred on the feet (x, z), long axis along the yaw, head = the front proneHeadLength m.
 * Returns the entry distance (<= maxT) and whether it is a head hit, or null.
 */
export function rayHitbox(
  o: Vec3,
  dir: Vec3,
  maxT: number,
  feet: Vec3,
  yaw: number,
  m: StanceFields,
  b: Balance,
): { t: number; headshot: boolean } | null {
  const stance = hitboxStanceOf(m, b);
  const height = b.movement.stances[stance].height;
  if (stance !== 'prone') {
    const hit = rayCylinder(o, dir, feet, b.player.radius, height, maxT);
    if (!hit) return null;
    const frac = stance === 'crouch' ? b.combat.hitbox.crouchHeadZoneFraction : b.player.headZoneFraction;
    return { t: hit.t, headshot: hit.y >= feet.y + height * (1 - frac) - 1e-9 };
  }
  const hb = b.combat.hitbox;
  // Local axes: forward f = (-sin yaw, 0, -cos yaw), right r = (cos yaw, 0, -sin yaw).
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const px = o.x - feet.x;
  const py = o.y - feet.y;
  const pz = o.z - feet.z;
  const of = px * fx + pz * fz;
  const or = px * rx + pz * rz;
  const df = dir.x * fx + dir.z * fz;
  const dr = dir.x * rx + dir.z * rz;
  const halfL = hb.proneLength / 2;
  const halfW = hb.proneWidth / 2;
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (o0: number, d: number, lo: number, hi: number): boolean => {
    if (Math.abs(d) < 1e-12) return o0 >= lo && o0 <= hi;
    let a = (lo - o0) / d;
    let c = (hi - o0) / d;
    if (a > c) {
      const tmp = a;
      a = c;
      c = tmp;
    }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    return t0 <= t1;
  };
  if (!slab(of, df, -halfL, halfL) || !slab(or, dr, -halfW, halfW) || !slab(py, dir.y, 0, height)) return null;
  if (t1 < 0) return null;
  const t = Math.max(0, t0);
  if (t > maxT) return null;
  const hitF = of + df * t;
  return { t, headshot: hitF >= halfL - hb.proneHeadLength - 1e-9 };
}

/**
 * Water depth at the feet for stance rules: max(0, -ground), where ground is the terrain or the feet height when the
 * feet are above it (a dock deck or a crate over water is dry). stance.md defines depth as max(0, -terrainHeight) for a
 * player on the seabed; this is identical there.
 */
export function stanceWaterDepth(map: AnyMapData, pos: Vec3): number {
  const ground = Math.max(heightAt(pos.x, pos.z, map), pos.y);
  return ground < 0 ? -ground : 0;
}

/** Highest stance allowed at this water depth (stance.md table). */
export function stanceAllowedAtDepth(stance: Stance, depth: number, b: Balance): boolean {
  const s = b.movement.stances;
  if (stance === 'prone') return depth <= s.proneMaxWaterDepth;
  if (stance === 'crouch') return depth <= s.crouchMaxWaterDepth;
  return true;
}

/**
 * Headroom (stance.md): raising the body from height hCur to hNew is blocked when a prop collider overlaps the footprint
 * circle and its vertical span [bottom, top] intersects (feetY + hCur, feetY + hNew + headroomMargin].
 * Always false when movement.stances.headroomCheck is off or hNew <= hCur.
 */
export function headroomBlocked(colliders: ColliderSet, feet: Vec3, hCur: number, hNew: number, b: Balance): boolean {
  const s = b.movement.stances;
  if (!s.headroomCheck || hNew <= hCur) return false;
  const lo = feet.y + hCur;
  const hi = feet.y + hNew + s.headroomMargin;
  const r = Math.max(0, b.player.radius - HEADROOM_TOUCH_EPSILON);
  let blocked = false;
  forEachColliderNear(colliders, feet.x, feet.z, r, (c) => {
    if (blocked) return;
    if (c.bottom <= hi && c.top > lo && overlapsCircle(c, feet.x, feet.z, r)) blocked = true;
  });
  return blocked;
}

/**
 * Target stance of a C ('crouch') or Z ('prone') toggle from a settled stance (stance.md "Keys"). The Z-from-prone
 * fallback to crouch is applied by the movement step.
 */
export function toggleTarget(current: Stance, req: StanceRequest): Stance {
  if (req === 'crouch') return current === 'crouch' ? 'stand' : 'crouch';
  return current === 'prone' ? 'stand' : 'prone';
}

/**
 * M2b (ADR 0005 §9, camera.md "Prone pitch"): the sim pitch range for a movement state. While prone or in a
 * transition with prone at either end: movement.stances.pronePitchMinDeg/MaxDeg (radians out), else the global
 * PITCH_MIN..PITCH_MAX. One rule for World sanitize, bots and the client look clamp.
 */
export function pitchLimits(m: Pick<MovementState, 'stance' | 'stanceFrom' | 'stanceMs'>, b: Balance): { min: number; max: number } {
  const s = b.movement.stances;
  const prone = m.stance === 'prone' || (!isStanceSettled(m) && m.stanceFrom === 'prone');
  if (!prone || s.pronePitchMinDeg === undefined || s.pronePitchMaxDeg === undefined) return { min: PITCH_MIN, max: PITCH_MAX };
  return {
    min: Math.max(PITCH_MIN, s.pronePitchMinDeg * DEG2RAD),
    max: Math.min(PITCH_MAX, s.pronePitchMaxDeg * DEG2RAD),
  };
}
