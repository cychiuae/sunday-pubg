/**
 * Frag grenade physics and blast math (docs/design/systems/grenades.md, ADR 0004 §3-4). Pure and RNG-free: the same
 * launch state gives the same path on the server (World), in ClientGame extrapolation and in the arc preview.
 */
import type { Balance } from '../balance';
import type { GrenadeArcView } from '../contracts';
import { aimDirection, clamp, DEG2RAD, forwardFromYaw, RAD2DEG } from '../math';
import { isIndoor } from '../maps';
import type { GrenadeContactSurface, Vec3 } from '../types';
import { platformHeightAt, raycastColliders, raycastStatic, type Collider } from './colliders';
import type { MovementContext } from './movement';
import { heightAt, raycastTerrain } from './terrain';

export interface GrenadeBody {
  /** Centre. */
  pos: Vec3;
  /** m/s. All zero while resting. */
  vel: Vec3;
  /** Has entered water (the one-off waterVelocityDamping was applied). */
  inWater: boolean;
}

/** @deprecated Alias of GrenadeContactSurface (includes 'glass' since the C-gate). */
export type GrenadeSurface = GrenadeContactSurface;

export interface GrenadeContact {
  /** Contact point (the surface point, before the collisionRadius push-out). */
  pos: Vec3;
  /** Indoor: the floor and the ceiling are 'terrain', the floor-rectangle edge is 'edge', glass parts are 'glass'. */
  surface: GrenadeSurface;
  /** Impact normal speed |dot(vel, n)| (water: the vertical speed at entry). */
  speed: number;
}

export interface GrenadeStepResult {
  body: GrenadeBody;
  contact: GrenadeContact | null;
}

/** Half-width of the central difference used for the terrain normal, metres. */
const TERRAIN_NORMAL_H = 0.05;
/** A collider face counts as the top/bottom cap when the hit is this close to it, metres. */
const CAP_EPSILON = 1e-4;
/**
 * A body with zero velocity stays put when it has support within this multiple of collisionRadius below its centre
 * (resting on a slope sits up to radius / n.y above the surface; rest requires n.y > 0.7).
 */
const SUPPORT_FACTOR = 2;
/** grenades.md "Flight physics": a bounce off a surface with normal n.y above this may come to rest (REVIEW-M2a L4). */
const REST_MIN_NORMAL_Y = 0.7;
/** grenades.md "Throw": the launch pitch (aim pitch + throwLiftDeg) is capped at this many degrees (REVIEW-M2a L4). */
const LAUNCH_PITCH_MAX_DEG = 89;

const len3 = (v: Vec3): number => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
const isZero = (v: Vec3): boolean => v.x === 0 && v.y === 0 && v.z === 0;

/** Unit terrain normal at (x, z) from the heightfield gradient. */
export function terrainNormal(x: number, z: number, ctx: MovementContext): Vec3 {
  const map = ctx.map;
  const h = TERRAIN_NORMAL_H;
  const dx = (heightAt(x + h, z, map) - heightAt(x - h, z, map)) / (2 * h);
  const dz = (heightAt(x, z + h, map) - heightAt(x, z - h, map)) / (2 * h);
  const l = Math.sqrt(dx * dx + 1 + dz * dz);
  return { x: -dx / l, y: 1 / l, z: -dz / l };
}

/** Outward normal of a collider prism at a point on its surface (+Y on the top cap, -Y on a raised bottom). */
function colliderNormal(c: Collider, p: Vec3, dir: Vec3): Vec3 {
  if (dir.y < 0 && Math.abs(p.y - c.top) < CAP_EPSILON) return { x: 0, y: 1, z: 0 };
  if (dir.y > 0 && Number.isFinite(c.bottom) && Math.abs(p.y - c.bottom) < CAP_EPSILON) return { x: 0, y: -1, z: 0 };
  if (c.shape === 'circle') {
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-9) return { x: -dir.x, y: 0, z: -dir.z };
    return { x: dx / l, y: 0, z: dz / l };
  }
  // Box: local X -> world (cos, -sin), local Z -> world (sin, cos).
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  const lx = dx * c.cos - dz * c.sin;
  const lz = dx * c.sin + dz * c.cos;
  if (Math.abs(lx) / Math.max(c.hx, 1e-9) >= Math.abs(lz) / Math.max(c.hz, 1e-9)) {
    const s = lx >= 0 ? 1 : -1;
    return { x: s * c.cos, y: 0, z: -s * c.sin };
  }
  const s = lz >= 0 ? 1 : -1;
  return { x: s * c.sin, y: 0, z: s * c.cos };
}

/** Highest support (terrain or walkable collider top) at or below y under (x, z). */
function supportBelow(ctx: MovementContext, x: number, y: number, z: number): number {
  const t = heightAt(x, z, ctx.map);
  const p = platformHeightAt(ctx.colliders, x, z, y, 0);
  return p > t ? p : t;
}

/**
 * One sim tick of grenade flight (grenades.md "Flight physics"): gravity, a point sweep against terrain, props and the
 * world-edge wall, at most one bounce per tick (rest of the motion dropped), rest detection, and the one-off water
 * damping. Players are not colliders. A body at rest (zero velocity with support under it) does not move.
 */
export function stepGrenade(body: GrenadeBody, dt: number, ctx: MovementContext): GrenadeStepResult {
  const g = ctx.balance.items.grenade;
  const r = g.collisionRadius;
  const pos = body.pos;
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;
  if (step === 0) return { body: { pos: { ...pos }, vel: { ...body.vel }, inWater: body.inWater }, contact: null };
  if (isZero(body.vel) && pos.y - supportBelow(ctx, pos.x, pos.y, pos.z) <= r * SUPPORT_FACTOR) {
    return { body: { pos: { ...pos }, vel: { x: 0, y: 0, z: 0 }, inWater: body.inWater }, contact: null };
  }
  const vel: Vec3 = { x: body.vel.x, y: body.vel.y - g.gravity * step, z: body.vel.z };
  const delta: Vec3 = { x: vel.x * step, y: vel.y * step, z: vel.z * step };
  const L = len3(delta);
  const next: Vec3 = { x: pos.x + delta.x, y: pos.y + delta.y, z: pos.z + delta.z };
  if (L < 1e-12) return { body: { pos: next, vel, inWater: body.inWater }, contact: null };
  const dir: Vec3 = { x: delta.x / L, y: delta.y / L, z: delta.z / L };

  // Earliest solid contact along the segment.
  let bestT = Infinity;
  let normal: Vec3 | null = null;
  let surface: GrenadeSurface = 'terrain';
  const prop = raycastColliders(ctx.colliders, pos, dir, L);
  if (prop) {
    bestT = prop.t;
    const hp = { x: pos.x + dir.x * prop.t, y: pos.y + dir.y * prop.t, z: pos.z + dir.z * prop.t };
    normal = colliderNormal(prop.collider, hp, dir);
    surface = prop.collider.glass === true ? 'glass' : 'prop';
  }
  const map = ctx.map;
  const tt = raycastTerrain(pos.x, pos.y, pos.z, dir.x, dir.y, dir.z, Math.min(L, bestT), map);
  if (tt >= 0 && tt < bestT) {
    bestT = tt;
    // Indoor: the floor (+Y) or the ceiling (-Y, ADR 0005 §2), whichever plane the segment hit.
    normal = isIndoor(map)
      ? { x: 0, y: dir.y > 0 ? -1 : 1, z: 0 }
      : terrainNormal(pos.x + dir.x * tt, pos.z + dir.z * tt, ctx);
    surface = 'terrain';
  }
  if (isIndoor(map)) {
    // Floor-rectangle edge (contact 'edge'): the first side the segment crosses, normal pointing back inside.
    const f = map.floor;
    const side = (o: number, d: number, lo: number, hi: number, nx: number, nz: number): void => {
      let t = -1;
      let sgn = 0;
      if (d > 1e-12 && o + d * L > hi) {
        t = (hi - o) / d;
        sgn = -1;
      } else if (d < -1e-12 && o + d * L < lo) {
        t = (lo - o) / d;
        sgn = 1;
      }
      if (sgn !== 0 && t < bestT) {
        bestT = Math.max(0, t);
        normal = { x: nx * sgn, y: 0, z: nz * sgn };
        surface = 'edge';
      }
    };
    side(pos.x, dir.x, f.minX, f.maxX, 1, 0);
    side(pos.z, dir.z, f.minZ, f.maxZ, 0, 1);
  }
  // World edge: horizontal distance from the origin reaches worldRadius.
  const R = isIndoor(map) ? Infinity : map.worldRadius;
  const a = dir.x * dir.x + dir.z * dir.z;
  if (a > 1e-12 && Number.isFinite(R) && next.x * next.x + next.z * next.z > R * R) {
    const bq = pos.x * dir.x + pos.z * dir.z;
    const cq = pos.x * pos.x + pos.z * pos.z - R * R;
    const disc = bq * bq - a * cq;
    if (disc >= 0) {
      const te = Math.max(0, (-bq + Math.sqrt(disc)) / a);
      if (te < bestT) {
        bestT = te;
        const ex = pos.x + dir.x * te;
        const ez = pos.z + dir.z * te;
        const el = Math.hypot(ex, ez) || 1;
        normal = { x: -ex / el, y: 0, z: -ez / el };
        surface = 'edge';
      }
    }
  }

  // Water entry (once): crossing y = 0 where the sea floor is below 0, before any solid contact.
  if (!body.inWater && pos.y >= 0 && next.y < 0 && dir.y < 0) {
    const tw = -pos.y / dir.y;
    const wx = pos.x + dir.x * tw;
    const wz = pos.z + dir.z * tw;
    if (tw <= bestT && heightAt(wx, wz, map) < 0) {
      const k = g.waterVelocityDamping;
      return {
        body: { pos: { x: wx, y: 0, z: wz }, vel: { x: vel.x * k, y: vel.y * k, z: vel.z * k }, inWater: true },
        contact: { pos: { x: wx, y: 0, z: wz }, surface: 'water', speed: Math.abs(vel.y) },
      };
    }
  }

  if (normal === null || !Number.isFinite(bestT)) {
    return { body: { pos: next, vel, inWater: body.inWater }, contact: null };
  }
  const n = normal;
  const cp: Vec3 = { x: pos.x + dir.x * bestT, y: pos.y + dir.y * bestT, z: pos.z + dir.z * bestT };
  const placed: Vec3 = { x: cp.x + n.x * r, y: cp.y + n.y * r, z: cp.z + n.z * r };
  const vnDot = vel.x * n.x + vel.y * n.y + vel.z * n.z;
  let out: Vec3 = vel;
  if (vnDot < 0) {
    const vn = { x: n.x * vnDot, y: n.y * vnDot, z: n.z * vnDot };
    const k = 1 - g.friction;
    out = {
      x: (vel.x - vn.x) * k - vn.x * g.restitution,
      y: (vel.y - vn.y) * k - vn.y * g.restitution,
      z: (vel.z - vn.z) * k - vn.z * g.restitution,
    };
    if (len3(out) < g.restSpeed && n.y > REST_MIN_NORMAL_Y) out = { x: 0, y: 0, z: 0 };
  }
  return { body: { pos: placed, vel: out, inWater: body.inWater }, contact: { pos: cp, surface, speed: Math.abs(vnDot) } };
}

/** Throw speed for an aim pitch (radians), before the prone multiplier (grenades.md "Throw"). */
export function throwSpeedFor(pitch: number, b: Balance): number {
  const g = b.items.grenade;
  const span = g.throwPitchMaxDeg - g.throwPitchMinDeg;
  const t = span > 0 ? clamp((pitch * RAD2DEG - g.throwPitchMinDeg) / span, 0, 1) : 1;
  return g.throwSpeedMin + (g.throwSpeedMax - g.throwSpeedMin) * t;
}

/**
 * Launch state of a thrown grenade (grenades.md "Throw"): speed from pitch (x throwSpeedProneMultiplier when settled
 * prone), launch pitch = min(89, pitch + throwLiftDeg), origin = eye + aim x throwOriginForward pulled back to
 * collisionRadius before any obstacle on that segment. Thrower velocity is not inherited.
 */
export function throwLaunch(
  eye: Vec3,
  yaw: number,
  pitch: number,
  proneSettled: boolean,
  ctx: MovementContext,
): { pos: Vec3; vel: Vec3 } {
  const g = ctx.balance.items.grenade;
  const speed = throwSpeedFor(pitch, ctx.balance) * (proneSettled ? g.throwSpeedProneMultiplier : 1);
  const launchPitch = Math.min(LAUNCH_PITCH_MAX_DEG, pitch * RAD2DEG + g.throwLiftDeg) * DEG2RAD;
  const ld = aimDirection(yaw, launchPitch);
  const aim = aimDirection(yaw, pitch);
  let reach = g.throwOriginForward;
  const hit = raycastStatic(ctx.colliders, ctx.map, eye, aim, reach);
  if (hit) reach = Math.max(0, hit.t - g.collisionRadius);
  return {
    pos: { x: eye.x + aim.x * reach, y: eye.y + aim.y * reach, z: eye.z + aim.z * reach },
    vel: { x: ld.x * speed, y: ld.y * speed, z: ld.z * speed },
  };
}

/** Short drop when switching away while cooking: origin = eye, velocity = horizontal look x dropOnSwitchSpeed. */
export function dropLaunch(eye: Vec3, yaw: number, ctx: MovementContext): { pos: Vec3; vel: Vec3 } {
  const f = forwardFromYaw(yaw);
  const s = ctx.balance.items.grenade.dropOnSwitchSpeed;
  return { pos: { ...eye }, vel: { x: f.x * s, y: 0, z: f.z * s } };
}

/**
 * Arc preview (ADR 0004 §4): samples stepGrenade at the sim tick from `launch` until the fuse ends, the grenade rests,
 * or `maxSeconds` pass. points[0] is the launch position; one point per tick after it.
 * REVIEW-M2a M2: pass `out` to reuse its point objects across calls (the returned `points` is then `out.points`,
 * truncated to the new length; callers must copy before the next call if they keep it).
 */
export function predictGrenadeArc(
  launch: { pos: Vec3; vel: Vec3 },
  fuseRemainingMs: number,
  ctx: MovementContext,
  maxSeconds: number,
  out?: { points: Vec3[] },
): Omit<GrenadeArcView, 'radius'> {
  const dt = 1 / ctx.balance.net.simHz;
  let body: GrenadeBody = { pos: { ...launch.pos }, vel: { ...launch.vel }, inWater: false };
  const points: Vec3[] = out ? out.points : [];
  let n = 0;
  const put = (v: Vec3): void => {
    const p = points[n];
    if (p) {
      p.x = v.x;
      p.y = v.y;
      p.z = v.z;
    } else points[n] = { x: v.x, y: v.y, z: v.z };
    n++;
  };
  const done = (endReason: GrenadeArcView['endReason']): Omit<GrenadeArcView, 'radius'> => {
    points.length = n;
    return { points, end: { ...body.pos }, endReason };
  };
  put(body.pos);
  let fuse = fuseRemainingMs;
  const maxTicks = Math.max(0, Math.ceil((maxSeconds * 1000) / (dt * 1000) - 1e-9));
  for (let i = 0; i < maxTicks; i++) {
    body = stepGrenade(body, dt, ctx).body;
    put(body.pos);
    fuse -= dt * 1000;
    if (fuse <= 1e-6) return done('fuse');
    if (isZero(body.vel)) return done('rest');
  }
  return done('time');
}

/**
 * Blast damage at 3D distance `dist` from the blast to the target's chest (grenades.md "Explosion"): maxDamage within
 * innerRadius, linear to maxDamage x minDamageFactor at radius, 0 beyond.
 */
export function explosionDamage(dist: number, b: Balance): number {
  const g = b.items.grenade;
  if (!(dist <= g.radius)) return 0;
  if (dist <= g.innerRadius) return g.maxDamage;
  const span = g.radius - g.innerRadius;
  const t = span > 0 ? (dist - g.innerRadius) / span : 1;
  return g.maxDamage * (1 + (g.minDamageFactor - 1) * t);
}
