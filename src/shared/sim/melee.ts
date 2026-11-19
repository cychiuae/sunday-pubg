/**
 * M2c melee hit check (melee.md "Swing" step 3). Pure: the World passes the attacker's eye and aim on the hit-frame
 * tick, the candidate players and the (broken-glass aware) colliders.
 *
 * 1. Centre ray along the aim, length `range`, against terrain, props, glass and the stance hitboxes of the candidates.
 *    The first hit decides: a player (head or body by the hit point), a glass pane (it breaks, nobody is hit), or
 *    terrain / a prop (a thud, nobody is hit).
 * 2. Only when the centre ray hit nothing within range: the sweep. Candidates whose stance hitbox comes within
 *    `sweepRadius` of the aim segment, whose nearest hitbox point is within `range` of the eye (reach), and with a clear
 *    line from the eye to that point (terrain, props and intact glass block). The nearest point closest to the eye wins
 *    (tie: lower id). Sweep hits are body hits.
 */
import type { Balance } from '../balance';
import type { AnyMapData, MovementState, PaneId, PlayerId, Vec3 } from '../types';
import { lineOfSight, raycastStatic, type ColliderSet, type StaticHitKind } from './colliders';
import { hitboxStanceOf, rayHitbox } from './stance';

export interface MeleeCandidate {
  id: PlayerId;
  feet: Vec3;
  yaw: number;
  move: Pick<MovementState, 'stance' | 'stanceFrom' | 'stanceMs'>;
}

export type MeleeHitResult =
  | { kind: 'player'; id: PlayerId; headshot: boolean; point: Vec3; sweep: boolean }
  | { kind: 'glass'; pane: PaneId; point: Vec3 }
  | { kind: 'static'; surface: Exclude<StaticHitKind, 'glass'>; point: Vec3 }
  | null;

/** Iterations of the ternary search for the closest approach of the aim segment to a hitbox (convex distance). */
const SEARCH_ITERATIONS = 48;

/** Nearest point of a player's stance hitbox to `p` (cylinder standing / crouching, yawed box prone). */
export function nearestHitboxPoint(p: Vec3, c: MeleeCandidate, b: Balance): Vec3 {
  const stance = hitboxStanceOf(c.move, b);
  const h = b.movement.stances[stance].height;
  const y = Math.min(c.feet.y + h, Math.max(c.feet.y, p.y));
  if (stance !== 'prone') {
    const dx = p.x - c.feet.x;
    const dz = p.z - c.feet.z;
    const d = Math.hypot(dx, dz);
    const r = b.player.radius;
    if (d <= r) return { x: p.x, y, z: p.z };
    return { x: c.feet.x + (dx / d) * r, y, z: c.feet.z + (dz / d) * r };
  }
  const hb = b.combat.hitbox;
  const fx = -Math.sin(c.yaw);
  const fz = -Math.cos(c.yaw);
  const rx = Math.cos(c.yaw);
  const rz = -Math.sin(c.yaw);
  const px = p.x - c.feet.x;
  const pz = p.z - c.feet.z;
  const lf = Math.max(-hb.proneLength / 2, Math.min(hb.proneLength / 2, px * fx + pz * fz));
  const lr = Math.max(-hb.proneWidth / 2, Math.min(hb.proneWidth / 2, px * rx + pz * rz));
  return { x: c.feet.x + fx * lf + rx * lr, y, z: c.feet.z + fz * lf + rz * lr };
}

const dist3 = (a: Vec3, c: Vec3): number => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z);

/** Closest approach of the segment eye -> eye + aim x range to a hitbox: the hitbox point and its distance. */
export function segmentToHitbox(eye: Vec3, aim: Vec3, range: number, c: MeleeCandidate, b: Balance): { point: Vec3; dist: number } {
  const at = (t: number): Vec3 => ({ x: eye.x + aim.x * t, y: eye.y + aim.y * t, z: eye.z + aim.z * t });
  const f = (t: number): number => {
    const q = at(t);
    return dist3(q, nearestHitboxPoint(q, c, b));
  };
  let lo = 0;
  let hi = range;
  for (let i = 0; i < SEARCH_ITERATIONS; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) <= f(m2)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const q = at(t);
  const point = nearestHitboxPoint(q, c, b);
  return { point, dist: dist3(q, point) };
}

export function meleeHitCheck(
  eye: Vec3,
  aim: Vec3,
  range: number,
  sweepRadius: number,
  candidates: readonly MeleeCandidate[],
  colliders: ColliderSet,
  map: AnyMapData,
  b: Balance,
): MeleeHitResult {
  // REVIEW-M2c N3: only players whose feet are within reach + sweep + the largest hitbox half-extent can be hit.
  const hb = b.combat.hitbox;
  const reach = range + Math.max(0, sweepRadius) + Math.max(b.player.radius, Math.hypot(hb.proneLength, hb.proneWidth) / 2);
  candidates = candidates.filter((c) => Math.hypot(c.feet.x - eye.x, c.feet.z - eye.z) <= reach);
  // 1. Centre ray.
  const stat = raycastStatic(colliders, map, eye, aim, range);
  let maxT = stat ? stat.t : range;
  let best: { id: PlayerId; headshot: boolean; t: number } | null = null;
  for (const c of candidates) {
    const h = rayHitbox(eye, aim, maxT, c.feet, c.yaw, c.move, b);
    if (h && h.t <= maxT && (!best || h.t < best.t || (h.t === best.t && c.id < best.id))) {
      best = { id: c.id, headshot: h.headshot, t: h.t };
      maxT = h.t;
    }
  }
  const pointAt = (t: number): Vec3 => ({ x: eye.x + aim.x * t, y: eye.y + aim.y * t, z: eye.z + aim.z * t });
  if (best) return { kind: 'player', id: best.id, headshot: best.headshot, point: pointAt(best.t), sweep: false };
  if (stat) {
    if (stat.kind === 'glass' && stat.pane !== undefined) return { kind: 'glass', pane: stat.pane, point: pointAt(stat.t) };
    return { kind: 'static', surface: stat.kind === 'glass' ? 'prop' : stat.kind, point: pointAt(stat.t) };
  }
  // 2. Sweep (the centre ray hit nothing within range).
  if (!(sweepRadius > 0)) return null;
  let pick: { id: PlayerId; point: Vec3; eyeDist: number } | null = null;
  for (const c of candidates) {
    const s = segmentToHitbox(eye, aim, range, c, b);
    if (s.dist > sweepRadius) continue;
    const eyeDist = dist3(eye, s.point);
    if (eyeDist > range) continue;
    if (!lineOfSight(colliders, map, eye, s.point)) continue;
    if (!pick || eyeDist < pick.eyeDist || (eyeDist === pick.eyeDist && c.id < pick.id)) pick = { id: c.id, point: s.point, eyeDist };
  }
  return pick ? { kind: 'player', id: pick.id, headshot: false, point: pick.point, sweep: true } : null;
}
