/**
 * M2c rocket flight in the sim (rpg.md "Firing and flight", ADR 0007 §4). A rocket is its immutable launch record
 * (RocketState); its position at any time is `rocketPosAt` (src/shared/rocket.ts), so the server and clients agree
 * exactly. Each tick the World sweeps the segment between the positions at the previous and the current tick time
 * against, in order of first contact along the segment: terrain (indoor floor and ceiling), the water surface, props
 * and intact glass, the world edge, and the stance hitboxes of alive, non-dropping players other than the owner.
 * The travelled distance (summed chord lengths) ends the flight at `weapons.rpg.range` (air burst).
 */
import type { RocketBalance } from '../balance';
import { isIndoor } from '../maps';
import { rocketPosAt } from '../rocket';
import type { AnyMapData, PaneId, PlayerId, RocketContactSurface, RocketState, Vec3 } from '../types';
import { raycastColliders, raycastStatic, type ColliderSet } from './colliders';
import type { MeleeCandidate } from './melee';
import { rayCylinder } from './combat';
import { hitboxStanceOf, rayHitbox } from './stance';
import type { Balance } from '../balance';
import { heightAt } from './terrain';

/** A live rocket: the launch record plus the sim's bookkeeping. */
export interface RocketEntity {
  state: RocketState;
  /** Metres travelled up to `lastT`. */
  travelled: number;
  /** Server ms of the last swept sample. */
  lastT: number;
}

export interface RocketContact {
  /** Contact point on the surface (before the collisionRadius pull-back). */
  pos: Vec3;
  surface: RocketContactSurface;
  /** Travelled distance at the contact. */
  travelled: number;
  /** Unit direction of travel at the contact (blast pull-back). */
  dir: Vec3;
  victimId: PlayerId | null;
  pane: PaneId | null;
}

export const createRocket = (state: RocketState): RocketEntity => ({ state, travelled: 0, lastT: state.firedAt });

/**
 * Sweeps one tick of flight up to server time `t`. Returns the first contact (or the range end, surface 'range'),
 * else null and the entity advances. Players: `targets` (the World excludes the owner, dead, aboard and dropping).
 */
export function stepRocket(
  r: RocketEntity,
  t: number,
  rb: RocketBalance,
  range: number,
  colliders: ColliderSet,
  map: AnyMapData,
  targets: readonly MeleeCandidate[],
  b: Balance,
): RocketContact | null {
  const a = rocketPosAt(r.state, r.lastT, rb.gravity);
  const c = rocketPosAt(r.state, t, rb.gravity);
  const dx = c.x - a.x;
  const dy = c.y - a.y;
  const dz = c.z - a.z;
  const L = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(L > 0)) {
    r.lastT = t;
    return null;
  }
  const dir = { x: dx / L, y: dy / L, z: dz / L };
  const left = range - r.travelled;
  const maxT = Math.min(L, Math.max(0, left));
  let bestT = Infinity;
  let surface: RocketContactSurface = 'range';
  let victimId: PlayerId | null = null;
  let pane: PaneId | null = null;

  // REVIEW-M2c SF2 (rpg.md step 3): props, glass and players are swept with a sphere of collisionRadius: the centre ray
  // plus SWEEP_RING rays offset by the radius around it (the sphere's silhouette ring), earliest contact wins, and each
  // stance hitbox grown by the radius. Terrain (indoor floor / ceiling) and the water surface stay centre contacts, which
  // is what rpg.md acceptance 1-2 measure (a level shot lands 53.8 m out; the tide is hit at y = 0).
  const rad = Math.max(0, rb.collisionRadius);
  const stat = raycastStatic(colliders, map, a, dir, maxT);
  if (stat) {
    bestT = stat.t;
    surface = stat.kind === 'water' ? 'terrain' : stat.kind; // the sea floor under water: the water entry below wins
    if (stat.kind === 'glass' && stat.pane !== undefined) pane = stat.pane;
  }
  for (const off of sweepOffsets(dir, rad)) {
    if (off.x === 0 && off.y === 0 && off.z === 0) continue;
    const o = { x: a.x + off.x, y: a.y + off.y, z: a.z + off.z };
    const hit = raycastColliders(colliders, o, dir, Math.min(maxT, bestT));
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      surface = hit.collider.glass === true ? 'glass' : 'prop';
      pane = hit.collider.glass === true && hit.collider.pane !== undefined ? hit.collider.pane : null;
    }
  }
  // Water surface (y = 0) where the sea floor is below it.
  if (a.y >= 0 && a.y + dir.y * maxT < 0 && dir.y < 0) {
    const tw = -a.y / dir.y;
    if (tw < bestT && tw <= maxT && heightAt(a.x + dir.x * tw, a.z + dir.z * tw, map) < 0) {
      bestT = tw;
      surface = 'water';
      pane = null;
    }
  }
  // World edge (island worldRadius circle; indoor floor rectangle).
  const te = edgeT(a, dir, maxT, map);
  if (te !== null && te < bestT) {
    bestT = te;
    surface = 'edge';
    pane = null;
  }
  for (const p of targets) {
    const h = rayInflatedHitbox(a, dir, Math.min(maxT, bestT), p, rad, b);
    if (h && (h.t < bestT || (h.t === bestT && surface !== 'player'))) {
      bestT = h.t;
      surface = 'player';
      victimId = p.id;
      pane = null;
    }
  }
  if (Number.isFinite(bestT)) {
    r.lastT = t;
    return {
      pos: { x: a.x + dir.x * bestT, y: a.y + dir.y * bestT, z: a.z + dir.z * bestT },
      surface,
      travelled: r.travelled + bestT,
      dir,
      victimId,
      pane,
    };
  }
  if (left <= L) {
    r.lastT = t;
    return {
      pos: { x: a.x + dir.x * left, y: a.y + dir.y * left, z: a.z + dir.z * left },
      surface: 'range',
      travelled: range,
      dir,
      victimId: null,
      pane: null,
    };
  }
  r.travelled += L;
  r.lastT = t;
  return null;
}

/** Offset rays around the centre for the sphere sweep: the centre plus 8 points on a ring of radius `r`. */
const SWEEP_RING = 8;
function sweepOffsets(d: Vec3, r: number): Vec3[] {
  const out: Vec3[] = [{ x: 0, y: 0, z: 0 }];
  if (!(r > 0)) return out;
  // Orthonormal (u, v) perpendicular to d.
  const ax = Math.abs(d.y) < 0.99 ? 0 : 1;
  const ay = Math.abs(d.y) < 0.99 ? 1 : 0;
  let ux = ay * d.z;
  let uy = -ax * d.z;
  let uz = ax * d.y - ay * d.x;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = d.y * uz - d.z * uy;
  const vy = d.z * ux - d.x * uz;
  const vz = d.x * uy - d.y * ux;
  for (let i = 0; i < SWEEP_RING; i++) {
    const t = (i / SWEEP_RING) * Math.PI * 2;
    const c = Math.cos(t) * r;
    const s = Math.sin(t) * r;
    out.push({ x: ux * c + vx * s, y: uy * c + vy * s, z: uz * c + vz * s });
  }
  return out;
}

/** Ray vs a player's stance hitbox grown by `r` on every side (sphere-vs-hitbox sweep, cheap form). */
function rayInflatedHitbox(o: Vec3, d: Vec3, maxT: number, p: MeleeCandidate, r: number, b: Balance): { t: number } | null {
  const stance = hitboxStanceOf(p.move, b);
  const h = b.movement.stances[stance].height;
  if (stance !== 'prone') {
    const hit = rayCylinder(o, d, { x: p.feet.x, y: p.feet.y - r, z: p.feet.z }, b.player.radius + r, h + 2 * r, maxT);
    return hit ? { t: hit.t } : null;
  }
  if (r === 0) return rayHitbox(o, d, maxT, p.feet, p.yaw, p.move, b);
  const hb = b.combat.hitbox;
  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  const rx = Math.cos(p.yaw);
  const rz = -Math.sin(p.yaw);
  const px = o.x - p.feet.x;
  const pz = o.z - p.feet.z;
  let t0 = -Infinity;
  let t1 = Infinity;
  const slab = (o0: number, dd: number, lo: number, hi: number): boolean => {
    if (Math.abs(dd) < 1e-12) return o0 >= lo && o0 <= hi;
    let a0 = (lo - o0) / dd;
    let a1 = (hi - o0) / dd;
    if (a0 > a1) [a0, a1] = [a1, a0];
    if (a0 > t0) t0 = a0;
    if (a1 < t1) t1 = a1;
    return t0 <= t1;
  };
  const hl = hb.proneLength / 2 + r;
  const hw = hb.proneWidth / 2 + r;
  if (!slab(px * fx + pz * fz, d.x * fx + d.z * fz, -hl, hl)) return null;
  if (!slab(px * rx + pz * rz, d.x * rx + d.z * rz, -hw, hw)) return null;
  if (!slab(o.y - p.feet.y, d.y, -r, h + r)) return null;
  if (t1 < 0) return null;
  const t = Math.max(0, t0);
  return t <= maxT ? { t } : null;
}

/** Distance along a unit ray to the world boundary within maxT, else null. */
function edgeT(o: Vec3, d: Vec3, maxT: number, map: AnyMapData): number | null {
  if (isIndoor(map)) {
    const f = map.floor;
    let best: number | null = null;
    const side = (oc: number, dc: number, lo: number, hi: number): void => {
      let t = -1;
      if (dc > 1e-12 && oc + dc * maxT > hi) t = (hi - oc) / dc;
      else if (dc < -1e-12 && oc + dc * maxT < lo) t = (lo - oc) / dc;
      if (t >= 0 && (best === null || t < best)) best = t;
    };
    side(o.x, d.x, f.minX, f.maxX);
    side(o.z, d.z, f.minZ, f.maxZ);
    return best;
  }
  const R = map.worldRadius;
  const ex = o.x + d.x * maxT;
  const ez = o.z + d.z * maxT;
  if (ex * ex + ez * ez <= R * R) return null;
  const a = d.x * d.x + d.z * d.z;
  if (a < 1e-12) return null;
  const bq = o.x * d.x + o.z * d.z;
  const cq = o.x * o.x + o.z * o.z - R * R;
  const disc = bq * bq - a * cq;
  if (disc < 0) return null;
  return Math.max(0, (-bq + Math.sqrt(disc)) / a);
}
