/**
 * Client grenade views (ADR 0004 §3-4, grenades.md "What the UI must show"). Owner: game-developer.
 *
 * - GrenadeTracker keeps each live grenade's latest authoritative sample (snapshot list or grenadeThrown event,
 *   stamped with its server time) and extrapolates it to `now` with the shared `stepGrenade` at SIM_DT, lerping
 *   inside the last tick. Extrapolation stops GRENADE_EXTRAPOLATION_MAX_MS past the sample. A grenade disappears
 *   on its `explosion` event, or when a snapshot at or after its sample time no longer lists it.
 * - grenadeDanger: live grenades within items.grenade.radius + items.grenade.dangerMargin (3D, from the local chest).
 * - grenadeArc: the local throw preview from `throwLaunch` + `predictGrenadeArc` (same functions the World uses).
 *   REVIEW-M2a M2: ArcPreview reuses one point buffer and recomputes only when the throw origin, aim or prone flag moved
 *   past a small epsilon, or the cook fuse advanced by a sim tick.
 *
 * Grenades never touch players, so extrapolation is exact up to snapshot quantisation.
 */
import type { Balance } from '../shared/balance';
import { GRENADE_EXTRAPOLATION_MAX_MS } from '../shared/constants';
import type { GrenadeArcView, GrenadeView, HudGrenadeDangerView } from '../shared/contracts';
import { wrapAngle } from '../shared/math';
import { predictGrenadeArc, stepGrenade, throwLaunch, type GrenadeBody } from '../shared/sim/grenade';
import type { MovementContext } from '../shared/sim/movement';
import type { GrenadeId, GrenadeState, PlayerId, Vec3 } from '../shared/types';

/**
 * Fallback for the optional items.grenade.dangerMargin (grenades.md "Danger indicator": radius + 2 m). balance.json sets
 * it; this only covers a balance without the key (REVIEW-M2a M7).
 */
export const DEFAULT_DANGER_MARGIN_M = 2;

/** One physics step of a grenade body (injectable for tests). */
export type GrenadeStepFn = (body: GrenadeBody, dt: number) => GrenadeBody;

interface Sample {
  id: GrenadeId;
  ownerId: PlayerId;
  explodesAt: number;
  /** Server ms of `bodies[0]`. */
  time: number;
  /** bodies[k] = the body k ticks after the sample (lazily extended cache). */
  bodies: GrenadeBody[];
}

const cloneBody = (b: GrenadeBody): GrenadeBody => ({ pos: { ...b.pos }, vel: { ...b.vel }, inWater: b.inWater });
const isZero = (v: Vec3): boolean => v.x === 0 && v.y === 0 && v.z === 0;

export class GrenadeTracker {
  private readonly samples = new Map<GrenadeId, Sample>();
  /** Exploded ids (a stale list entry must not resurrect them). Cleared per match. */
  private readonly exploded = new Set<GrenadeId>();

  /** `simDt` in seconds. */
  constructor(
    private readonly step: GrenadeStepFn,
    private readonly simDt: number,
  ) {}

  get size(): number {
    return this.samples.size;
  }

  reset(): void {
    this.samples.clear();
    this.exploded.clear();
  }

  /** Authoritative list at `serverTime` (WorldSnapshot.grenades). */
  onSnapshot(grenades: readonly GrenadeState[], serverTime: number): void {
    const listed = new Set<GrenadeId>();
    for (const g of grenades) {
      listed.add(g.id);
      if (this.exploded.has(g.id)) continue;
      this.put(g.id, g.ownerId, g.explodesAt, serverTime, { pos: g.pos, vel: g.vel, inWater: g.inWater });
    }
    for (const [id, s] of this.samples) {
      if (!listed.has(id) && s.time <= serverTime) this.samples.delete(id);
    }
  }

  /** SimEvent grenadeThrown (pos/vel at the event tick's `serverTime`). */
  onThrown(ev: { id: GrenadeId; ownerId: PlayerId; pos: Vec3; vel: Vec3; explodesAt: number }, serverTime: number): void {
    if (this.exploded.has(ev.id)) return;
    this.put(ev.id, ev.ownerId, ev.explodesAt, serverTime, { pos: ev.pos, vel: ev.vel, inWater: false });
  }

  /** SimEvent explosion: remove at once. */
  onExplosion(id: GrenadeId): void {
    this.samples.delete(id);
    this.exploded.add(id);
  }

  /** Every live grenade extrapolated to `now` (server ms), sorted by id. */
  views(now: number): GrenadeView[] {
    const out: GrenadeView[] = [];
    const tickMs = this.simDt * 1000;
    for (const s of this.samples.values()) {
      const elapsed = Math.min(Math.max(0, now - s.time), GRENADE_EXTRAPOLATION_MAX_MS);
      const k = tickMs > 0 ? Math.floor(elapsed / tickMs) : 0;
      const frac = tickMs > 0 ? (elapsed - k * tickMs) / tickMs : 0;
      const a = this.bodyAt(s, k);
      let pos = a.pos;
      let vel = a.vel;
      if (frac > 0 && !isZero(a.vel)) {
        const b = this.bodyAt(s, k + 1);
        pos = { x: a.pos.x + (b.pos.x - a.pos.x) * frac, y: a.pos.y + (b.pos.y - a.pos.y) * frac, z: a.pos.z + (b.pos.z - a.pos.z) * frac };
        vel = b.vel;
      }
      out.push({ id: s.id, ownerId: s.ownerId, pos: { ...pos }, vel: { ...vel }, explodesAt: s.explodesAt, resting: isZero(vel) });
    }
    return out.sort((x, y) => x.id - y.id);
  }

  private put(id: GrenadeId, ownerId: PlayerId, explodesAt: number, time: number, body: GrenadeBody): void {
    const prev = this.samples.get(id);
    if (prev && prev.time > time) return; // never replace a fresher sample
    this.samples.set(id, { id, ownerId, explodesAt, time, bodies: [cloneBody(body)] });
  }

  private bodyAt(s: Sample, k: number): GrenadeBody {
    while (s.bodies.length <= k) {
      const last = s.bodies[s.bodies.length - 1] as GrenadeBody;
      s.bodies.push(isZero(last.vel) ? last : this.step(last, this.simDt));
    }
    return s.bodies[k] as GrenadeBody;
  }
}

/** Default GrenadeStepFn: the shared stepGrenade on the current map. */
export function sharedGrenadeStep(ctx: () => MovementContext): GrenadeStepFn {
  return (body, dt) => stepGrenade(body, dt, ctx()).body;
}

/**
 * HUD danger list: grenades whose 3D distance from `chest` is <= radius + dangerMargin, nearest (horizontal) first.
 * `bearing` is relative to `cameraYaw`: 0 ahead, +PI/2 right, in (-PI, PI]. `fuseRemainingMs` = explodesAt - now
 * (server ms), the same clock as the cook ring.
 */
export function grenadeDanger(
  grenades: readonly GrenadeView[],
  chest: Vec3,
  cameraYaw: number,
  balance: Balance,
  now: number,
): HudGrenadeDangerView[] {
  const g = balance.items.grenade;
  const limit = g.radius + (g.dangerMargin ?? DEFAULT_DANGER_MARGIN_M);
  const fx = -Math.sin(cameraYaw);
  const fz = -Math.cos(cameraYaw);
  const rx = Math.cos(cameraYaw);
  const rz = -Math.sin(cameraYaw);
  const out: HudGrenadeDangerView[] = [];
  for (const n of grenades) {
    const dx = n.pos.x - chest.x;
    const dy = n.pos.y - chest.y;
    const dz = n.pos.z - chest.z;
    if (Math.hypot(dx, dy, dz) > limit) continue;
    const ahead = dx * fx + dz * fz;
    const right = dx * rx + dz * rz;
    const bearing = ahead === 0 && right === 0 ? 0 : wrapAngle(Math.atan2(right, ahead));
    out.push({
      id: n.id,
      distance: Math.hypot(dx, dz),
      bearing: bearing === -Math.PI ? Math.PI : bearing,
      explodesAt: n.explodesAt,
      fuseRemainingMs: Math.max(0, n.explodesAt - now),
    });
  }
  return out.sort((a, b) => a.distance - b.distance || a.id - b.id);
}

export interface ArcInput {
  /** Predicted eye position (render feet + stance eye height). */
  eye: Vec3;
  yaw: number;
  pitch: number;
  /** Settled prone (throw speed x throwSpeedProneMultiplier). */
  proneSettled: boolean;
  /** items.grenade.fuseMs before the pin pull, else the remaining cook fuse. */
  fuseRemainingMs: number;
  maxSeconds: number;
}

/**
 * The local throw preview (FrameView.grenadeArc). `out` (optional) is reused for the points (REVIEW-M2a M2): the
 * returned `points` is then `out.points`, so callers must not keep it across calls.
 */
export function buildGrenadeArc(input: ArcInput, ctx: MovementContext, balance: Balance, out?: { points: Vec3[] }): GrenadeArcView {
  const launch = throwLaunch(input.eye, input.yaw, input.pitch, input.proneSettled, ctx);
  const arc = predictGrenadeArc(launch, Math.max(0, input.fuseRemainingMs), ctx, input.maxSeconds, out);
  return { ...arc, radius: balance.items.grenade.radius };
}

/** Recompute thresholds of ArcPreview (plumbing, not feel): 1 cm of eye travel, 0.05 deg of aim. */
export const ARC_EYE_EPSILON_M = 0.01;
export const ARC_ANGLE_EPSILON_RAD = 0.05 * (Math.PI / 180);

/**
 * REVIEW-M2a M2: cached arc preview. Returns the last view unless the eye, yaw or pitch moved past the epsilons, the
 * prone flag changed, or the fuse advanced by at least one sim tick (`tickMs`) since the last computation. The points
 * live in one reused buffer.
 */
export class ArcPreview {
  private readonly buffer: { points: Vec3[] } = { points: [] };
  private last: { input: ArcInput; view: GrenadeArcView } | null = null;
  private builds = 0;

  constructor(
    private readonly build: (input: ArcInput, out: { points: Vec3[] }) => GrenadeArcView,
    private readonly tickMs: number,
  ) {}

  /** Number of real computations (tests). */
  get computations(): number {
    return this.builds;
  }

  reset(): void {
    this.last = null;
  }

  get(input: ArcInput): GrenadeArcView {
    const l = this.last;
    if (l && !this.moved(l.input, input)) return l.view;
    this.builds++;
    const view = this.build(input, this.buffer);
    this.last = { input: { ...input, eye: { ...input.eye } }, view };
    return view;
  }

  private moved(a: ArcInput, b: ArcInput): boolean {
    return (
      Math.hypot(a.eye.x - b.eye.x, a.eye.y - b.eye.y, a.eye.z - b.eye.z) > ARC_EYE_EPSILON_M ||
      Math.abs(wrapAngle(a.yaw - b.yaw)) > ARC_ANGLE_EPSILON_RAD ||
      Math.abs(a.pitch - b.pitch) > ARC_ANGLE_EPSILON_RAD ||
      a.proneSettled !== b.proneSettled ||
      a.maxSeconds !== b.maxSeconds ||
      Math.abs(a.fuseRemainingMs - b.fuseRemainingMs) >= this.tickMs
    );
  }
}
