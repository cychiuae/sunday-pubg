/**
 * The Tide (docs/design/systems/zone.md). Deterministic for a given Rng.
 *
 * Timeline: phase i = wait(waitSeconds) then shrink(shrinkSeconds) from the previous circle to the target chosen at the
 * start of the wait. After the last phase: phaseIndex = phases.length (final collapse) holds for
 * finalCollapseDelaySeconds, then shrinks to radius 0 over finalCollapseSeconds; after that it stays closed.
 *
 * Centre selection follows zone.md (uniform in the containment disc, land check, fallback toward the origin) with one
 * addition so the circles trend toward `MapData.zoneCenters`: at match start one candidate F is chosen as the final
 * centre, and every target is additionally kept within (r_i - r_last) of F, so F is always reachable in the last
 * phase. Early phases stay close to uniform (that disc is large); later ones converge on F. The last phase first tries
 * the zoneCenters that satisfy containment (F first), exactly as zone.md says.
 */
import type { Balance } from '../balance';
import type { Rng } from '../math';
import type { MapData, Vec2, ZoneState } from '../types';
import { heightAt } from './terrain';

export interface ZoneRuntime {
  state: ZoneState;
  /** Circle at the start of the current shrink (lerp source). */
  fromCenter: Vec2;
  fromRadius: number;
  /** Server ms when the current shrink started (valid while shrinking). */
  shrinkStartAt: number;
  /** Chosen final-centre candidate (from map.zoneCenters), or null when the map has none. */
  finalCenter: Vec2 | null;
  /** Fully closed (collapse finished). */
  closed: boolean;
}

const phaseDurationMs = (balance: Balance, i: number, part: 'wait' | 'shrink'): number => {
  const z = balance.zone;
  if (i >= z.phases.length) return (part === 'wait' ? z.finalCollapseDelaySeconds : z.finalCollapseSeconds) * 1000;
  const p = z.phases[i]!;
  return (part === 'wait' ? p.waitSeconds : p.shrinkSeconds) * 1000;
};

export const phaseDps = (balance: Balance, i: number): number =>
  i < 0 ? 0 : i >= balance.zone.phases.length ? balance.zone.finalCollapseDps : balance.zone.phases[i]!.dps;

/**
 * Picks the target centre for phase `i` given the previous target circle (prevCenter, prevRadius) and the new radius.
 * Guarantees |c - prevCenter| + r <= prevRadius (when prevRadius >= r).
 *
 * With a final candidate F, the centre is also kept within (r - rLast) of F, which keeps F reachable by the last
 * phase (the two discs always intersect because F's final circle lies inside the previous circle by induction).
 * The sample is uniform inside the smaller of the two discs, rejected unless it is in both and on land.
 */
export function pickTargetCenter(
  i: number,
  prevCenter: Vec2,
  prevRadius: number,
  r: number,
  finalCenter: Vec2 | null,
  balance: Balance,
  map: MapData,
  rng: Rng,
): Vec2 {
  const z = balance.zone;
  const allowed = Math.max(0, prevRadius - r);
  const n = z.phases.length;
  // Last phase (zone.md): first try the map's candidates that satisfy containment (prefer the chosen final one).
  if (i === n - 1 && map.zoneCenters.length > 0) {
    const ok = (c: Vec2): boolean => Math.hypot(c.x - prevCenter.x, c.z - prevCenter.z) <= allowed + 1e-9;
    if (finalCenter && ok(finalCenter)) return { x: finalCenter.x, z: finalCenter.z };
    const reachable = map.zoneCenters.filter(ok);
    if (reachable.length > 0) {
      const c = rng.pick(reachable);
      return { x: c.x, z: c.z };
    }
  }
  const rLast = targetRadiusFor(balance, n - 1);
  const fR = finalCenter ? Math.max(0, r - rLast) : Infinity;
  const inContainment = (x: number, zz: number): boolean =>
    Math.hypot(x - prevCenter.x, zz - prevCenter.z) <= allowed + 1e-9;
  const inFinal = (x: number, zz: number): boolean =>
    !finalCenter || Math.hypot(x - finalCenter.x, zz - finalCenter.z) <= fR + 1e-9;
  const useFinalDisc = finalCenter !== null && fR < allowed;
  const sc = useFinalDisc && finalCenter ? finalCenter : prevCenter;
  const sr = useFinalDisc ? fR : allowed;
  const tries = Math.max(1, z.landCheckMaxTries);
  for (let t = 0; t < tries; t++) {
    const a = rng.next() * Math.PI * 2;
    const d = sr * Math.sqrt(rng.next());
    const x = sc.x + Math.cos(a) * d;
    const zz = sc.z + Math.sin(a) * d;
    if (!inContainment(x, zz) || !inFinal(x, zz)) continue;
    if (heightAt(x, zz, map) >= z.landCheckMinHeight) return { x, z: zz };
  }
  if (finalCenter) {
    // Step from the previous centre toward F as far as containment allows (always inside both discs).
    const dx = finalCenter.x - prevCenter.x;
    const dz = finalCenter.z - prevCenter.z;
    const d = Math.hypot(dx, dz);
    const k = d > allowed && d > 0 ? allowed / d : 1;
    return { x: prevCenter.x + dx * k, z: prevCenter.z + dz * k };
  }
  // zone.md fallback: 50% of the way toward the origin, clamped to the containment disc.
  const len = Math.hypot(prevCenter.x, prevCenter.z);
  if (len < 1e-9) return { x: prevCenter.x, z: prevCenter.z };
  const step = Math.min(len * 0.5, allowed);
  return { x: prevCenter.x - (prevCenter.x / len) * step, z: prevCenter.z - (prevCenter.z / len) * step };
}

const targetRadiusFor = (balance: Balance, i: number): number =>
  i >= balance.zone.phases.length ? 0 : balance.zone.phases[i]!.radiusFraction * balance.zone.startRadius;

/** Zone at match start (phase 0 wait begins at `nowMs`, target chosen immediately). */
export function createZone(balance: Balance, map: MapData, rng: Rng, nowMs: number): ZoneRuntime {
  const z = balance.zone;
  const finalCenter = map.zoneCenters.length > 0 ? rng.pick(map.zoneCenters) : null;
  const center = { x: 0, z: 0 };
  const rt: ZoneRuntime = {
    state: {
      phaseIndex: 0,
      phaseCount: z.phases.length,
      center,
      radius: z.startRadius,
      targetCenter: { x: 0, z: 0 },
      targetRadius: z.startRadius,
      phaseEndsAt: nowMs + phaseDurationMs(balance, 0, 'wait'),
      shrinking: false,
      dps: phaseDps(balance, 0),
    },
    fromCenter: { x: 0, z: 0 },
    fromRadius: z.startRadius,
    shrinkStartAt: nowMs,
    finalCenter: finalCenter ? { x: finalCenter.x, z: finalCenter.z } : null,
    closed: false,
  };
  beginWait(rt, 0, balance, map, rng);
  return rt;
}

function beginWait(rt: ZoneRuntime, i: number, balance: Balance, map: MapData, rng: Rng): void {
  const s = rt.state;
  s.phaseIndex = i;
  s.shrinking = false;
  s.dps = phaseDps(balance, i);
  const r = targetRadiusFor(balance, i);
  const c =
    i >= balance.zone.phases.length
      ? { x: s.center.x, z: s.center.z }
      : pickTargetCenter(i, s.center, s.radius, r, rt.finalCenter, balance, map, rng);
  s.targetCenter = c;
  s.targetRadius = r;
}

/**
 * Advances the zone to `nowMs`. Returns true when the phase index or shrinking flag changed.
 */
export function updateZone(rt: ZoneRuntime, balance: Balance, map: MapData, rng: Rng, nowMs: number): boolean {
  const s = rt.state;
  let changed = false;
  // Process every boundary that has passed (handles large dt).
  while (!rt.closed && nowMs >= s.phaseEndsAt) {
    changed = true;
    if (!s.shrinking) {
      // wait -> shrink
      rt.fromCenter = { x: s.center.x, z: s.center.z };
      rt.fromRadius = s.radius;
      rt.shrinkStartAt = s.phaseEndsAt;
      s.shrinking = true;
      s.phaseEndsAt = s.phaseEndsAt + phaseDurationMs(balance, s.phaseIndex, 'shrink');
    } else {
      // shrink end -> next phase wait (or closed)
      s.center = { x: s.targetCenter.x, z: s.targetCenter.z };
      s.radius = s.targetRadius;
      const endAt = s.phaseEndsAt;
      if (s.phaseIndex >= balance.zone.phases.length) {
        rt.closed = true;
        s.shrinking = false;
        s.radius = 0;
        break;
      }
      beginWait(rt, s.phaseIndex + 1, balance, map, rng);
      s.phaseEndsAt = endAt + phaseDurationMs(balance, s.phaseIndex, 'wait');
    }
  }
  if (s.shrinking) {
    const dur = s.phaseEndsAt - rt.shrinkStartAt;
    const t = dur <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - rt.shrinkStartAt) / dur));
    s.center = {
      x: rt.fromCenter.x + (s.targetCenter.x - rt.fromCenter.x) * t,
      z: rt.fromCenter.z + (s.targetCenter.z - rt.fromCenter.z) * t,
    };
    s.radius = rt.fromRadius + (s.targetRadius - rt.fromRadius) * t;
  }
  return changed;
}

/** Outside = horizontal distance from centre > radius (on the edge counts as inside). */
export function isOutsideZone(s: ZoneState, x: number, z: number): boolean {
  const dx = x - s.center.x;
  const dz = z - s.center.z;
  return dx * dx + dz * dz > s.radius * s.radius;
}

/** Nearest point on the zone edge to (x, z) (for damage-direction UI). */
export function nearestEdgePoint(s: ZoneState, x: number, z: number): Vec2 {
  const dx = x - s.center.x;
  const dz = z - s.center.z;
  const d = Math.hypot(dx, dz);
  if (d < 1e-9) return { x: s.center.x + s.radius, z: s.center.z };
  return { x: s.center.x + (dx / d) * s.radius, z: s.center.z + (dz / d) * s.radius };
}

export const cloneZoneState = (s: ZoneState): ZoneState => ({
  ...s,
  center: { x: s.center.x, z: s.center.z },
  targetCenter: { x: s.targetCenter.x, z: s.targetCenter.z },
});
