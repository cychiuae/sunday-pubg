/**
 * Shared, deterministic player movement. Runs on the server (authoritative) and in ClientGame (prediction).
 * `stepMovement` never mutates its arguments and reads nothing outside them.
 */
import type { Balance } from '../balance';
import { effectiveWeapon, weaponBalance } from '../balance';
import { isIndoor } from '../maps';
import type {
  AnyMapData,
  DropPhase,
  HeldId,
  MovementInput,
  MovementState,
  MovementStepResult,
  PaneId,
  PlayerInput,
  ScopeId,
  Stance,
  StanceChange,
  StanceRefusal,
  StanceRequest,
} from '../types';
import { isM2cGunId, isM2cThrowableId, stanceTransitionKey } from '../types';
import { buildColliders, platformHeightAt, resolveCircle, withBrokenPanes, type ColliderSet, type PushOut } from './colliders';
import {
  headroomBlocked,
  hitboxHeightOf,
  isStanceSettled,
  stanceAllowedAtDepth,
  stanceWaterDepth,
  toggleTarget,
} from './stance';
import { buildNavGraph, type NavGraph } from './nav';
import { heightAt } from './terrain';

/** Stance and ADS timers complete when within this many ms of zero (float accumulation of 1000/30 ms steps). */
const STANCE_TIMER_EPSILON_MS = 1e-6;

export interface MovementContext {
  readonly map: AnyMapData;
  readonly balance: Balance;
  readonly colliders: ColliderSet;
}

/** `balance` must be the effective (per-map) balance (balanceForMap). */
export function createMovementContext(map: AnyMapData, balance: Balance): MovementContext {
  // BUG-011: thin raised kit parts narrower than half a player's radius never support feet.
  return { map, balance, colliders: buildColliders(map, balance.movement.stepHeight, balance.player.radius / 2) };
}

/**
 * M2c (ADR 0007 §7): the same context with `broken` glass panes open (movement, rays, grenade flight and blast line of
 * sight skip them). The World keeps one live set; ClientGame passes the snapshot's brokenPanes.
 */
export function withBrokenGlass(ctx: MovementContext, broken: ReadonlySet<PaneId>): MovementContext {
  return { ...ctx, colliders: withBrokenPanes(ctx.colliders, broken) };
}

/**
 * M2b (ADR 0005 §6): everything derived from one map and its effective balance, built once and shared by every World
 * on that map (the server caches one per map id) and by ClientGame (which passes `{ nav: false }`). The nav graph is
 * built only for indoor maps.
 */
export interface MapRuntime {
  readonly map: AnyMapData;
  readonly balance: Balance;
  readonly ctx: MovementContext;
  readonly nav: NavGraph | null;
  /**
   * M2c (ADR 0007 §1, §16.3): wall-clock build times in ms for the server's per-layout log line (colliders, nav). Logging
   * only; never used by a decision.
   */
  readonly buildMs?: { colliders: number; nav: number };
}

/**
 * `map` is the layout-APPLIED map of a match (applyLayout, ADR 0007 §1): the sim never builds layouts itself. The server
 * caches one runtime per (map id, layout seed). `clock` (the server passes performance.now; the sim never reads a wall
 * clock) fills `buildMs` for the per-layout log line; absent = no timing.
 */
export function prepareMap(map: AnyMapData, balance: Balance, opts: { nav?: boolean; clock?: () => number } = {}): MapRuntime {
  const clock = opts.clock;
  const t0 = clock ? clock() : 0;
  const ctx = createMovementContext(map, balance);
  const t1 = clock ? clock() : 0;
  const nav = isIndoor(map) && opts.nav !== false ? buildNavGraph(map, ctx.colliders, balance) : null;
  const t2 = clock ? clock() : 0;
  return clock ? { map, balance, ctx, nav, buildMs: { colliders: t1 - t0, nav: t2 - t1 } } : { map, balance, ctx, nav };
}

/** @deprecated Since the C-gate `MovementState` carries the drop fields; kept as an alias for existing imports. */
export type DropAwareMovementState = MovementState;

export interface MovementStatus {
  alive: boolean;
  healing: boolean;
  reloading: boolean;
  /** M2a: item in hand (snapshot `weapon` / World active slot). */
  held: HeldId;
  /** M2a: a weapon swap is running (combat.swapMs). Blocks ADS. */
  swapping: boolean;
  /**
   * M2a: within combat.fireMoveWindowMs of a shot with the held weapon (server-exact; ClientGame approximates it with
   * fire held + mag > 0 + settled, ADR 0004 Consequences). Applies weapons[held].fireMoveMultiplier.
   */
  fireSlowed: boolean;
  /**
   * M2c (scopes.md): the scope mounted on the held gun (null / absent = its built-in sight). toMovementInput turns it into
   * MovementInput.adsSpec via effectiveWeapon, so ADS time and walk speed match the server with a scope mounted.
   */
  scope?: ScopeId | null;
  /**
   * M2c: an explicit ADS spec (client prediction may compute it from the predicted scope). When present it wins over
   * `scope`.
   */
  adsSpec?: MovementInput['adsSpec'];
}

/** A valid stance request, else null (defensive: the protocol already rejects other values). */
const stanceRequestOf = (v: unknown): StanceRequest | null => (v === 'crouch' || v === 'prone' ? v : null);

/**
 * Maps a PlayerInput plus status to what the movement step reads.
 * - Dead: no movement, no stance request, no ADS (adsBlocked).
 * - Healing: speed x movement.healMoveMultiplier, no sprint. Fire window: x weapons[held].fireMoveMultiplier.
 * - Holding fire cancels sprint (GDD 7.3). Reloading does not block sprint. ADS suppression is done by the step.
 * - adsBlocked = reloading || healing || swapping (dropping, transitions and sight 'none' are the step's checks).
 */
export function toMovementInput(input: PlayerInput, status: MovementStatus, balance: Balance): MovementInput {
  if (!status.alive) {
    return {
      moveForward: 0,
      moveRight: 0,
      yaw: input.yaw,
      jump: false,
      sprint: false,
      speedMultiplier: 0,
      canSprint: false,
      stanceToggle: null,
      ads: false,
      held: status.held,
      adsBlocked: true,
    };
  }
  const heldNow = status.held;
  const fireMult = status.fireSlowed && !isM2cThrowableId(heldNow) ? weaponBalance(balance, heldNow).fireMoveMultiplier : 1;
  return {
    moveForward: finiteOr0(input.moveForward),
    moveRight: finiteOr0(input.moveRight),
    yaw: finiteOr0(input.yaw),
    jump: input.jump === true,
    sprint: input.sprint === true,
    speedMultiplier: (status.healing ? balance.movement.healMoveMultiplier : 1) * fireMult,
    canSprint: !status.healing && !input.fire,
    stanceToggle: stanceRequestOf(input.stanceToggle),
    ads: input.ads === true,
    held: status.held,
    adsBlocked: status.reloading || status.healing || status.swapping,
    ...(status.adsSpec ? { adsSpec: status.adsSpec } : adsSpecFor(heldNow, status.scope ?? null, balance)),
  };
}

/** M2c: `{ adsSpec }` for a gun with a mounted scope; {} otherwise (the step then reads weapons[held], the M2b rule). */
function adsSpecFor(held: HeldId, scope: ScopeId | null, balance: Balance): Pick<MovementInput, 'adsSpec'> {
  if (scope === null || isM2cThrowableId(held) || !isM2cGunId(held)) return {};
  const e = effectiveWeapon(balance, held, 1, scope);
  if (e.scope === null) return {};
  return { adsSpec: { sight: e.sight, adsTimeMs: e.adsTimeMs, adsMoveMultiplier: e.adsMoveMultiplier } };
}

/**
 * Spawn / default movement state: standing, settled, not aiming. `dropping` with no phase = the M1 parachute-speed
 * drop (drop-less test Worlds); pass `dropPhase: 'freefall'` for a carrier jump (drop.md).
 */
export function initialMovementState(
  pos: { x: number; y: number; z: number },
  dropping: boolean,
  dropPhase: DropPhase | null = dropping ? 'chute' : null,
): MovementState {
  return {
    pos: { x: pos.x, y: pos.y, z: pos.z },
    vel: { x: 0, y: 0, z: 0 },
    grounded: !dropping,
    dropping,
    stance: 'stand',
    stanceFrom: 'stand',
    stanceMs: 0,
    adsMs: 0,
    dropPhase: dropping ? dropPhase : null,
    dropMs: 0,
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

/** Ground under (x, z) for someone whose feet are at feetY: terrain / floor or a walkable prop top (dock, crate, desk). */
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

/**
 * One movement tick. M2b drop phases (drop.md "Freefall and parachute", ADR 0005 §8), while `dropping`:
 * - freefall: fall at drop.freefallSpeed, steer at drop.freefallSteerSpeed. Opens the parachute when the height above
 *   the terrain or floor below (props ignored) is <= drop.chuteDeployHeight ('auto'), or on the jump edge at
 *   dropMs >= drop.minFreefallMs when drop.manualDeploy ('manual'). Checked at the start of the step, so the
 *   parachute speeds apply on the tick it opens.
 * - chute (and a phase-less M1 drop): movement.dropFallSpeed / dropSteerSpeed.
 * - dropMs advances by dt; landing on any walkable top ends the drop (no fall damage: the World skips it).
 */
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
  const b = ctx.balance;
  const st = m.stances;

  // ---- Stance (stance.md per-tick order) ----
  let stance: Stance = state.stance;
  let stanceFrom: Stance = state.stanceFrom;
  let stanceMs = state.stanceMs > 0 ? state.stanceMs : 0;
  let stanceChanged: StanceChange | null = null;
  let stanceRefused: StanceRefusal | null = null;
  let jumpConsumed = input.stanceToggle !== null;
  const start = (to: Stance, forced: boolean): void => {
    const durationMs = st.transitionMs[stanceTransitionKey(stance, to)];
    stanceChanged = { from: stance, to, forced, durationMs };
    stanceFrom = stance;
    stance = to;
    stanceMs = durationMs > 0 ? durationMs : 0;
  };
  const settledAtStart = !(stanceMs > 0);
  const depth = stanceWaterDepth(ctx.map, state.pos);
  // 1. Forced water stand-up (settled only; ignores headroom).
  if (settledAtStart && stance !== 'stand' && !stanceAllowedAtDepth(stance, depth, b)) {
    start('stand', true);
  } else {
    // 2. Request: stanceToggle, then Space when not standing, then held sprint when crouched.
    let target: Stance | null = null;
    let silent = false;
    let fallback: Stance | null = null;
    if (input.stanceToggle !== null) {
      target = toggleTarget(stance, input.stanceToggle);
      if (input.stanceToggle === 'prone' && stance === 'prone') fallback = 'crouch';
    } else if (input.jump && stance !== 'stand') {
      jumpConsumed = true;
      target = stance === 'prone' ? 'crouch' : 'stand';
    } else if (
      stance === 'crouch' &&
      input.sprint &&
      input.canSprint &&
      !input.ads &&
      input.moveForward > 0 &&
      input.speedMultiplier > 0
    ) {
      target = 'stand';
      silent = true;
    }
    // 3. Validation (ignored silently while dropping, airborne, transitioning or when the target is the current).
    if (target !== null && !state.dropping && state.grounded && settledAtStart && target !== stance) {
      const hCur = st[stance].height;
      if (!stanceAllowedAtDepth(target, depth, b)) {
        if (!silent) stanceRefused = 'tooDeep';
      } else if (headroomBlocked(ctx.colliders, state.pos, hCur, st[target].height, b)) {
        if (fallback && fallback !== stance && !headroomBlocked(ctx.colliders, state.pos, hCur, st[fallback].height, b)) {
          start(fallback, false);
        } else if (!silent) {
          stanceRefused = 'noHeadroom';
        }
      } else {
        start(target, false);
      }
    }
  }
  // 4. Advance the transition timer.
  if (stanceMs > 0) {
    stanceMs -= step * 1000;
    if (stanceMs <= STANCE_TIMER_EPSILON_MS) stanceMs = 0;
  }
  if (stanceMs === 0) stanceFrom = stance;
  const settled = stanceMs === 0;
  const stanceNow = { stance, stanceFrom, stanceMs };

  // ---- ADS (combat.md "ADS") ----
  const heldIn = input.held;
  const heldW = isM2cThrowableId(heldIn) ? null : (input.adsSpec ?? weaponBalance(b, heldIn));
  const adsEngaged =
    input.ads && heldW !== null && heldW.sight !== 'none' && !input.adsBlocked && !state.dropping && settled && stanceChanged === null;
  const adsMs = adsEngaged && heldW ? Math.min(heldW.adsTimeMs, (state.adsMs > 0 ? state.adsMs : 0) + step * 1000) : 0;
  const stanceMult = isStanceSettled(stanceNow)
    ? st[stance].speedMultiplier
    : Math.min(st[stanceFrom].speedMultiplier, st[stance].speedMultiplier);
  const adsMult = adsEngaged && heldW ? heldW.adsMoveMultiplier : 1;
  const bodyHeight = hitboxHeightOf(stanceNow, b);

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

  /** Vertical velocity before this tick's gravity (non-drop airborne), for the exact landing speed. */
  let vyStart: number | null = null;
  // A dropping state without a phase is the M1 parachute-speed drop (drop-less test Worlds).
  let dropPhase: DropPhase | null = dropping ? (state.dropPhase ?? 'chute') : null;
  const dropMsIn = dropping && state.dropMs > 0 ? state.dropMs : 0;
  let chuteOpened: 'manual' | 'auto' | null = null;
  if (dropping) {
    const d = b.drop;
    if (dropPhase === 'freefall') {
      if (py - heightAt(px, pz, ctx.map) <= d.chuteDeployHeight) chuteOpened = 'auto';
      else if (input.jump && d.manualDeploy && dropMsIn >= d.minFreefallMs) chuteOpened = 'manual';
      if (chuteOpened !== null) dropPhase = 'chute';
    }
    const ff = dropPhase === 'freefall';
    const steer = (ff ? d.freefallSteerSpeed : m.dropSteerSpeed) * mult;
    vx = wx * steer;
    vz = wz * steer;
    vy = -(ff ? d.freefallSpeed : m.dropFallSpeed);
  } else {
    const inWater = py < -m.waterDepthThreshold;
    const sprinting =
      input.sprint && input.canSprint && !input.ads && input.moveForward > 0 && settled && stance === 'stand';
    const maxSpeed =
      (sprinting ? m.sprintSpeed : m.walkSpeed) * mult * stanceMult * adsMult * (inWater ? m.waterSpeedMultiplier : 1);
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
      if (input.jump && !jumpConsumed && mult > 0 && settled && stance === 'stand') {
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
      vyStart = vy;
      vy -= m.gravity * step;
      if (vy < -m.terminalVelocity) vy = -m.terminalVelocity;
    }
  }

  // Horizontal move + collision against walls at the current feet height.
  const desiredX = px + vx * step;
  const desiredZ = pz + vz * step;
  const out: PushOut = { x: desiredX, z: desiredZ };
  resolveCircle(ctx.colliders, desiredX, desiredZ, playerRadius, py, m.stepHeight, out, bodyHeight);
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

  // World boundary (hard wall). Island: the worldRadius circle. Indoor: the floor rectangle inset by player.radius.
  const map = ctx.map;
  if (isIndoor(map)) {
    const f = map.floor;
    const loX = f.minX + playerRadius;
    const hiX = f.maxX - playerRadius;
    const loZ = f.minZ + playerRadius;
    const hiZ = f.maxZ - playerRadius;
    if (nx < loX) {
      nx = loX;
      if (vx < 0) vx = 0;
    } else if (nx > hiX) {
      nx = hiX;
      if (vx > 0) vx = 0;
    }
    if (nz < loZ) {
      nz = loZ;
      if (vz < 0) vz = 0;
    } else if (nz > hiZ) {
      nz = hiZ;
      if (vz > 0) vz = 0;
    }
  } else {
    const limit = map.worldRadius - playerRadius;
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
    // Under gravity: trapezoid (exact for constant gravity), so jump apex and fall heights match the spec's
    // closed forms (apex v^2 / 2g, impact sqrt(2 g h); maps.md 2.4). Drops fall at a constant speed.
    py += (vyStart === null ? vy : (vyStart + vy) * 0.5) * step;
    const ground = groundHeightAt(ctx, nx, nz, Math.max(prevY, py));
    if (py <= ground) {
      landed = true;
      // M2b (maps.md 2.4): the exact impact speed sqrt(v0^2 + 2 g (y0 - ground)) under gravity, so fall damage matches
      // the spec's sqrt(2 g h) instead of the end-of-tick velocity. Drops fall at a constant speed.
      // REVIEW-M2b L2: still rising at the end of the tick (snapped onto a ledge on the way up) = no downward impact.
      landingSpeed = vyStart === null
        ? Math.max(0, -vy)
        : vy >= 0
          ? 0
          : Math.min(m.terminalVelocity, Math.sqrt(Math.max(0, vyStart * vyStart + 2 * m.gravity * (prevY - ground))));
      py = ground;
      vy = 0;
      grounded = true;
      dropping = false;
    }
  }
  const dropMs = dropping ? dropMsIn + step * 1000 : 0;
  if (!dropping) dropPhase = null;

  return {
    state: {
      pos: { x: nx, y: py, z: nz },
      vel: { x: vx, y: vy, z: vz },
      grounded,
      dropping,
      stance,
      stanceFrom,
      stanceMs,
      adsMs,
      dropPhase,
      dropMs,
    },
    chuteOpened,
    jumped,
    landed,
    landingSpeed,
    stanceChanged,
    stanceRefused,
    adsEngaged,
  };
}

const clamp1 = (v: number): number => (Number.isFinite(v) ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0);
