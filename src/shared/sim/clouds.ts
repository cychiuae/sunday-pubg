/**
 * M2c smoke clouds in the sim (smoke.md "The cloud", ADR 0007 §6). A cloud is an immutable record (SmokeCloudState)
 * whose shape is the pure `smokeRadiusAt` (src/shared/smoke.ts); the sim only creates it, forces an earlier fade when
 * more than `cloud.maxActive` exist, and removes it once gone.
 */
import type { SmokeCloudBalance } from '../balance';
import { smokeGoneAt } from '../smoke';
import type { PlayerId, SmokeCloudState, Vec3 } from '../types';

/** The cloud a canister makes at `now` (deploy point `pos`; in water: the point at y = 0 above it). */
export function deployCloud(id: number, ownerId: PlayerId, pos: Vec3, inWater: boolean, now: number, cfg: SmokeCloudBalance): SmokeCloudState {
  return {
    id,
    ownerId,
    pos: { x: pos.x, y: inWater ? 0 : pos.y, z: pos.z },
    deployedAt: now,
    fadeAt: now + cfg.growMs + cfg.holdMs,
  };
}

/**
 * Adds `cloud` to the list (kept in id order). Over maxActive, the oldest clouds that are not fading yet start their
 * fade at `now` (smoke.md: a 13th cloud makes the oldest fade at once). REVIEW-M2c N2: cloud records are never mutated;
 * a forced fade REPLACES the record in the list with a copy, so snapshots and delta bases that still hold the old object
 * keep seeing the old value.
 */
export function addCloud(clouds: SmokeCloudState[], cloud: SmokeCloudState, now: number, cfg: SmokeCloudBalance): void {
  clouds.push(cloud);
  clouds.sort((a, b) => a.id - b.id);
  let excess = clouds.filter((c) => c.fadeAt > now).length - Math.max(0, cfg.maxActive);
  const oldest = [...clouds].sort((a, b) => a.deployedAt - b.deployedAt || a.id - b.id);
  for (const c of oldest) {
    if (excess <= 0) break;
    if (c.id === cloud.id || c.fadeAt <= now) continue;
    clouds[clouds.indexOf(c)] = { ...c, pos: { ...c.pos }, fadeAt: now };
    excess--;
  }
}

/** Drops clouds whose fade has ended. Returns the kept list. */
export const liveClouds = (clouds: readonly SmokeCloudState[], now: number, cfg: SmokeCloudBalance): SmokeCloudState[] =>
  clouds.filter((c) => now < smokeGoneAt(c, cfg));
