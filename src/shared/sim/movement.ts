/**
 * Shared, deterministic player movement. Runs on the server (authoritative) and in ClientGame (prediction).
 * `stepMovement` never mutates its arguments and reads nothing outside them.
 */
import type { Balance } from '../balance';
import type { MapData, MovementInput, MovementState, MovementStepResult, PlayerInput } from '../types';
import { buildColliders, platformHeightAt, resolveCircle, type ColliderSet, type PushOut } from './colliders';
import { heightAt } from './terrain';

export interface MovementContext {
  readonly map: MapData;
  readonly balance: Balance;
  readonly colliders: ColliderSet;
}

export function createMovementContext(map: MapData, balance: Balance): MovementContext {
  return { map, balance, colliders: buildColliders(map) };
}

export interface MovementStatus {
  alive: boolean;
  healing: boolean;
  reloading: boolean;
}

/**
 * Maps a PlayerInput plus status to what the movement step reads.
 * - Dead: no movement.
 * - Healing: speed x movement.healMoveMultiplier, no sprint.
 * - Holding fire cancels sprint (GDD 7.3). Reloading does not block sprint.
 * - Sprint only counts while moving forward (checked in stepMovement).
 */
export function toMovementInput(input: PlayerInput, status: MovementStatus, balance: Balance): MovementInput {
  if (!status.alive) {
    return { moveForward: 0, moveRight: 0, yaw: input.yaw, jump: false, sprint: false, speedMultiplier: 0, canSprint: false };
  }
  return {
    moveForward: finiteOr0(input.moveForward),
    moveRight: finiteOr0(input.moveRight),
    yaw: finiteOr0(input.yaw),
    jump: input.jump === true,
    sprint: input.sprint === true,
    speedMultiplier: status.healing ? balance.movement.healMoveMultiplier : 1,
    canSprint: !status.healing && !input.fire,
  };
}

/**
 * Move vectors longer than this are normalised; within it they pass unchanged. The tolerance keeps an already
 * normalised vector (hypot = 1 + 1 ulp) from being divided again, so client prediction, World.sanitize and the server's
 * sanitizeInput (server/validate.ts MAX_MOVE_LEN, same value) stay bit-identical.
 */
export const MAX_MOVE_INPUT_LEN = 1 + 1e-9;

const finiteOr0 = (v: number): number => (Number.isFinite(v) ? v : 0);

/** Feet below sea level by more than waterDepthThreshold. */
export function isInWater(state: MovementState, balance: Balance): boolean {
  return state.pos.y < -balance.movement.waterDepthThreshold;
}

/** Ground under (x, z) for someone whose feet are at feetY: terrain or a walkable prop top (dock, crate, boat). */
export function groundHeightAt(ctx: MovementContext, x: number, z: number, feetY: number): number {
  const t = heightAt(x, z, ctx.map);
  const p = platformHeightAt(ctx.colliders, x, z, feetY, ctx.balance.movement.stepHeight);
  return p > t ? p : t;
}

export function horizontalSpeed(state: MovementState): number {
  return Math.hypot(state.vel.x, state.vel.z);
}

/** Moves (vx, vz) toward (tx, tz) by at most maxDelta. */
function approach(vx: number, vz: number, tx: number, tz: number, maxDelta: number): [number, number] {
  const dx = tx - vx;
  const dz = tz - vz;
  const d = Math.hypot(dx, dz);
  if (d <= maxDelta || d < 1e-9) return [tx, tz];
  const k = maxDelta / d;
  return [vx + dx * k, vz + dz * k];
}

export function stepMovement(
  state: MovementState,
  input: MovementInput,
  dt: number,
  ctx: MovementContext,
): MovementStepResult {
  const m = ctx.balance.movement;
  const playerRadius = ctx.balance.player.radius;
  let px = state.pos.x;
  let py = state.pos.y;
  let pz = state.pos.z;
  let vx = state.vel.x;
  let vy = state.vel.y;
  let vz = state.vel.z;
  let grounded = state.grounded;
  let dropping = state.dropping;
  let jumped = false;
  let landed = false;
  let landingSpeed = 0;
  const step = dt > 0 && Number.isFinite(dt) ? dt : 0;

  // Camera-relative wish direction (forward = (-sin, -cos), right = (cos, -sin)).
  let f = clamp1(input.moveForward);
  let r = clamp1(input.moveRight);
  const wl = Math.hypot(f, r);
  if (wl > MAX_MOVE_INPUT_LEN) {
    f /= wl;
    r /= wl;
  }
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  const wx = -sy * f + cy * r;
  const wz = -cy * f - sy * r;
  const wishLen = Math.min(1, wl);
  const mult = Math.max(0, input.speedMultiplier);

  if (dropping) {
    const steer = m.dropSteerSpeed * mult;
    vx = wx * steer;
    vz = wz * steer;
    vy = -m.dropFallSpeed;
  } else {
    const inWater = py < -m.waterDepthThreshold;
    const sprinting = input.sprint && input.canSprint && input.moveForward > 0;
    const maxSpeed = (sprinting ? m.sprintSpeed : m.walkSpeed) * mult * (inWater ? m.waterSpeedMultiplier : 1);
    const tx = wx * maxSpeed;
    const tz = wz * maxSpeed;
    if (grounded) {
      if (wishLen > 1e-6) {
        [vx, vz] = approach(vx, vz, tx, tz, m.accel * step);
      } else {
        const k = Math.max(0, 1 - m.friction * step);
        vx *= k;
        vz *= k;
      }
      if (input.jump && mult > 0) {
        vy = m.jumpVelocity;
        grounded = false;
        jumped = true;
      } else {
        vy = 0;
      }
    } else if (wishLen > 1e-6) {
      [vx, vz] = approach(vx, vz, tx, tz, m.accel * m.airControl * step);
    }
    if (!grounded) {
      vy -= m.gravity * step;
      if (vy < -m.terminalVelocity) vy = -m.terminalVelocity;
    }
  }

  // Horizontal move + collision against walls at the current feet height.
  const desiredX = px + vx * step;
  const desiredZ = pz + vz * step;
  const out: PushOut = { x: desiredX, z: desiredZ };
  resolveCircle(ctx.colliders, desiredX, desiredZ, playerRadius, py, m.stepHeight, out, ctx.balance.player.height);
  let nx = out.x;
  let nz = out.z;
  const cx = nx - desiredX;
  const cz = nz - desiredZ;
  const cl = Math.hypot(cx, cz);
  if (cl > 1e-9) {
    // Slide: remove the velocity component pointing into the obstacle.
    const ux = cx / cl;
    const uz = cz / cl;
    const vn = vx * ux + vz * uz;
    if (vn < 0) {
      vx -= ux * vn;
      vz -= uz * vn;
    }
  }

  // World boundary (hard wall).
  const limit = ctx.map.worldRadius - playerRadius;
  const rr = Math.hypot(nx, nz);
  if (rr > limit && rr > 1e-9) {
    const ux = nx / rr;
    const uz = nz / rr;
    nx = ux * limit;
    nz = uz * limit;
    const vn = vx * ux + vz * uz;
    if (vn > 0) {
      vx -= ux * vn;
      vz -= uz * vn;
    }
  }

  // Vertical.
  if (grounded) {
    const ground = groundHeightAt(ctx, nx, nz, py);
    const snapDown = m.stepHeight + Math.hypot(vx, vz) * step;
    if (ground >= py - snapDown) {
      py = ground;
      vy = 0;
    } else {
      grounded = false;
      vy = 0;
    }
  } else {
    const prevY = py;
    py += vy * step;
    const ground = groundHeightAt(ctx, nx, nz, Math.max(prevY, py));
    if (py <= ground) {
      landed = true;
      landingSpeed = Math.max(0, -vy);
      py = ground;
      vy = 0;
      grounded = true;
      dropping = false;
    }
  }

  return {
    state: { pos: { x: nx, y: py, z: nz }, vel: { x: vx, y: vy, z: vz }, grounded, dropping },
    jumped,
    landed,
    landingSpeed,
  };
}

const clamp1 = (v: number): number => (Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0);
