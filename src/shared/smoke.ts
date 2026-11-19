/**
 * M2c smoke cloud shape and visibility (smoke.md, ADR 0007 §7). Owner: tech-lead.
 *
 * ONE implementation of "is this hidden by smoke" for every consumer, so "hidden to me" and "hidden to bots" agree:
 * - sim bots line of sight (src/shared/sim/bots.ts),
 * - ClientGame: HudView.inSmoke, localHitConfirmed.obscured, PlayerView.smokeHidden (name tags, spectate outline),
 * - render (the cloud volume's radius) and audio (the hiss envelope).
 * Pure, deterministic (only + - * / and comparisons), allocation-free. Never blocks bullets, melee, rockets, blasts.
 */
import type { SmokeCloudBalance } from './balance';
import type { SmokeCloudState, Vec3 } from './types';

/** Opaque radius at server time `t` (ms); 0 before the deploy and after the fade. Spec table: smoke.md "The cloud". */
export function smokeRadiusAt(c: SmokeCloudState, t: number, cfg: SmokeCloudBalance): number {
  const age = t - c.deployedAt;
  if (age < 0) return 0;
  const grow = cfg.growMs > 0 ? Math.min(1, age / cfg.growMs) : 1;
  const fade = cfg.fadeMs > 0 ? Math.min(1, Math.max(0, (t - c.fadeAt) / cfg.fadeMs)) : t >= c.fadeAt ? 1 : 0;
  return cfg.radius * grow * (1 - fade);
}

/** Server ms after which the cloud is gone (the sim removes it on the first tick at or after this). */
export const smokeGoneAt = (c: SmokeCloudState, cfg: SmokeCloudBalance): number => c.fadeAt + cfg.fadeMs;

/** Sphere centre: the deploy point raised by cloud.centerHeight. */
export function smokeCenter(c: SmokeCloudState, cfg: SmokeCloudBalance, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = c.pos.x;
  out.y = c.pos.y + cfg.centerHeight;
  out.z = c.pos.z;
  return out;
}

/** True when `p` is strictly inside any cloud's opaque sphere at time `t` (camera inside smoke: HudView.inSmoke). */
export function pointInSmoke(clouds: readonly SmokeCloudState[], p: Vec3, t: number, cfg: SmokeCloudBalance): boolean {
  for (const c of clouds) {
    const r = smokeRadiusAt(c, t, cfg);
    if (r <= 0) continue;
    const dx = p.x - c.pos.x;
    const dy = p.y - (c.pos.y + cfg.centerHeight);
    const dz = p.z - c.pos.z;
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}

/**
 * True when the segment from -> to passes through any cloud's opaque sphere at time `t` (segment vs sphere: the
 * closest point of the segment to the centre is closer than the radius). Two points closer than
 * cloud.closeSightRange always see each other (smoke.md "What smoke blocks"). Callers that test two target points
 * (head and chest) treat the target as hidden only when both are blocked.
 */
export function segmentBlockedBySmoke(
  clouds: readonly SmokeCloudState[],
  from: Vec3,
  to: Vec3,
  t: number,
  cfg: SmokeCloudBalance,
): boolean {
  if (clouds.length === 0) return false;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const len2 = dx * dx + dy * dy + dz * dz;
  if (len2 < cfg.closeSightRange * cfg.closeSightRange) return false;
  for (const c of clouds) {
    const r = smokeRadiusAt(c, t, cfg);
    if (r <= 0) continue;
    const cx = c.pos.x - from.x;
    const cy = c.pos.y + cfg.centerHeight - from.y;
    const cz = c.pos.z - from.z;
    // Parameter of the closest point, clamped to the segment.
    let u = len2 > 0 ? (cx * dx + cy * dy + cz * dz) / len2 : 0;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const ex = cx - dx * u;
    const ey = cy - dy * u;
    const ez = cz - dz * u;
    if (ex * ex + ey * ey + ez * ez < r * r) return true;
  }
  return false;
}
