/**
 * M2c rocket kinematics (rpg.md, ADR 0007 §6). Owner: tech-lead.
 *
 * A rocket is a straight line with small gravity and no drag, so its path is a closed form of its launch record.
 * The sim (src/shared/sim, game-developer) samples rocketPosAt at every tick time and sweeps the segment between two
 * samples; clients evaluate the same function at any render time. Same inputs, same IEEE operations, same result:
 * no extrapolation drift and no per-tick rocket data on the wire.
 */
import type { RocketState, Vec3 } from './types';

/** Position at server time `t` (ms). `gravity` = weapons.rpg.rocket.gravity (m/s^2, positive = down). t < firedAt clamps. */
export function rocketPosAt(r: RocketState, t: number, gravity: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const s = t > r.firedAt ? (t - r.firedAt) / 1000 : 0;
  out.x = r.pos.x + r.vel.x * s;
  out.y = r.pos.y + r.vel.y * s - 0.5 * gravity * s * s;
  out.z = r.pos.z + r.vel.z * s;
  return out;
}

/** Velocity at server time `t` (ms): only the vertical part changes. */
export function rocketVelAt(r: RocketState, t: number, gravity: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const s = t > r.firedAt ? (t - r.firedAt) / 1000 : 0;
  out.x = r.vel.x;
  out.y = r.vel.y - gravity * s;
  out.z = r.vel.z;
  return out;
}
