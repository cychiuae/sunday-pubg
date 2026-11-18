/**
 * Display-side zone helpers. The server owns the zone; snapshots carry it at 20 Hz. While shrinking, centre and
 * radius move linearly to the target, reaching it at `phaseEndsAt`, so the client can evaluate the exact circle at
 * any server time between snapshots (smooth tide wall and timer).
 */
import { clamp, lerp } from '../shared/math';
import type { Vec2, Vec3, ZoneState } from '../shared/types';

/** The zone as of `now` (server ms), extrapolated from a snapshot taken at `snapshotTime`. */
export function zoneAt(zone: ZoneState, snapshotTime: number, now: number): ZoneState {
  if (!zone.shrinking) return zone;
  const remaining = zone.phaseEndsAt - snapshotTime;
  if (remaining <= 0) return { ...zone, center: { ...zone.targetCenter }, radius: zone.targetRadius };
  const t = clamp((now - snapshotTime) / remaining, 0, 1);
  return {
    ...zone,
    center: { x: lerp(zone.center.x, zone.targetCenter.x, t), z: lerp(zone.center.z, zone.targetCenter.z, t) },
    radius: lerp(zone.radius, zone.targetRadius, t),
  };
}

/** Outside = horizontal distance from the centre > radius (the edge counts as inside, zone.md). */
export function isOutsideZone(pos: Vec2 | Vec3, zone: ZoneState): boolean {
  const dx = pos.x - zone.center.x;
  const dz = pos.z - zone.center.z;
  return dx * dx + dz * dz > zone.radius * zone.radius;
}

/** Whole seconds until `endsAt` (>= 0). */
export function secondsUntil(endsAt: number, now: number): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}
