/**
 * Local movement prediction and server reconciliation (ARCHITECTURE §6). Pure: the movement step is injected,
 * so tests can drive it with a toy step and the game uses the shared `stepMovement`.
 *
 * - apply(): run one local input, keep it in `pending` until the server acknowledges it.
 * - reconcile(): drop acknowledged inputs, restart from the authoritative state, replay the rest. Differences up
 *   to `snapDistance` go into a visual offset that decays exponentially; larger ones snap.
 * - The movement status of each input (healing, ...) comes from a `StatusModel` that advances its own action
 *   state per input, exactly like the server does per tick. On reconcile the action state restarts from the
 *   snapshot too, so replayed inputs get the status the server used for them (REVIEW-M1 m1).
 * - renderPosition(alpha): lerp between the last two fixed steps plus the visual offset.
 */
import { cloneVec3, lerpVec3, vec3 } from '../shared/math';
import type { HeldId, MovementState, MovementStepResult, PlayerInput, ScopeId, Vec3 } from '../shared/types';

/**
 * Per-input status the movement step cannot see (structurally the sim's `MovementStatus`, passed to
 * `toMovementInput`). M2a adds the item in hand (sight, ADS time, ADS move multiplier), swapping (blocks ADS) and
 * the LMG fire slow-down window (approximated on the client, ADR 0004 Consequences).
 */
export interface PredictStatus {
  alive: boolean;
  healing: boolean;
  reloading: boolean;
  held: HeldId;
  swapping: boolean;
  fireSlowed: boolean;
  /** M2c: the held gun's mounted scope (MovementStatus.scope: ADS numbers via effectiveWeapon). Absent = built-in. */
  scope?: ScopeId | null;
}

export type PredictStep = (state: MovementState, input: PlayerInput, status: PredictStatus) => MovementStepResult;

/**
 * Per-input movement status, in the World's tick order (M2a, stance.md "Per-tick order"):
 * - `step` runs BEFORE the movement step: it advances the action state `A` (timers) and returns the status that
 *   input's movement step must use. `before` = movement state before it.
 * - `after` (optional) runs AFTER the movement step with the new movement state: it applies the input's edges
 *   (slot select, reload, heal, fire, grenade). `endAds` = an edge ended ADS (swap, reload or heal start), so the
 *   predicted adsMs is reset to 0 exactly like the server does.
 */
export interface StatusModel<A> {
  step(actions: A, input: PlayerInput, before: MovementState): { actions: A; status: PredictStatus };
  after?(actions: A, input: PlayerInput, after: MovementState): { actions: A; endAds: boolean };
}

/** A model whose status never changes (tests, or a caller that has no action state). */
export function fixedStatus(status: PredictStatus): StatusModel<null> {
  return { step: () => ({ actions: null, status }) };
}

/** Visual correction offsets below this (m) snap to 0 while decaying (no denormal tail). */
export const OFFSET_SNAP_M = 1e-6;

export interface PredictorOptions {
  snapDistance: number;
  decayMs: number;
  maxPending: number;
}

export interface ReconcileResult {
  /** Distance between the old and the new predicted position. */
  correction: number;
  snapped: boolean;
  replayed: number;
}

/** Copies every field (M2b: including the drop fields dropPhase / dropMs, on MovementState after the C-gate). */
export const cloneMovementState = (s: MovementState): MovementState => ({
  ...s,
  pos: cloneVec3(s.pos),
  vel: cloneVec3(s.vel),
});

export class Predictor<A> {
  private pending: PlayerInput[] = [];
  /** Action state after each pending input (same order as `pending`). */
  private history: A[] = [];
  private prev: MovementState | null = null;
  private cur: MovementState | null = null;
  /** Action state after the last applied/replayed input (null when inactive). */
  private actions: { value: A } | null = null;
  private lastStatus: PredictStatus | null = null;
  private offset: Vec3 = vec3();

  constructor(
    private readonly step: PredictStep,
    private readonly opts: PredictorOptions,
    private readonly model: StatusModel<A>,
  ) {}

  get active(): boolean {
    return this.cur !== null;
  }

  /** Latest predicted state (after the last applied/replayed input), or null when inactive. */
  get state(): MovementState | null {
    return this.cur;
  }

  /** State before the last fixed step (for interpolation and per-step deltas). */
  get previousState(): MovementState | null {
    return this.prev;
  }

  /** Predicted action state after the last input (null when inactive). */
  get predictedActions(): A | null {
    return this.actions ? this.actions.value : null;
  }

  /** Status used for the last applied or replayed input (null when inactive or nothing applied since reconcile). */
  get status(): PredictStatus | null {
    return this.lastStatus;
  }

  get pendingInputs(): readonly PlayerInput[] {
    return this.pending;
  }

  /**
   * Predicted action state right after input `seq` (null if it is not pending any more). Call before reconcile()
   * to carry state the snapshot does not include (fire timers, trigger latch) over to the reconciliation base.
   */
  actionsAfter(seq: number): A | null {
    const i = this.pending.findIndex((p) => p.seq === seq);
    return i === -1 ? null : (this.history[i] ?? null);
  }

  get visualOffset(): Vec3 {
    return this.offset;
  }

  /**
   * M2b: inputs already sent while not predicting (aboard the carrier) that the server may still process as movement
   * (the auto-eject happens on a server tick). Only while inactive: the next reconcile() keeps those newer than its
   * acknowledged seq and replays them, so starting prediction mid-flight needs no correction.
   */
  seedPending(inputs: readonly PlayerInput[]): void {
    if (this.cur) return;
    this.pending = inputs.slice(-this.opts.maxPending);
    this.history = [];
  }

  /** Stop predicting (dead, not a participant, disconnected). */
  reset(): void {
    this.pending = [];
    this.history = [];
    this.prev = null;
    this.cur = null;
    this.actions = null;
    this.lastStatus = null;
    this.offset = vec3();
  }

  /** Apply one local input. Returns null when inactive (the input is not kept). */
  apply(input: PlayerInput): MovementStepResult | null {
    if (!this.cur || this.actions === null) return null;
    const { actions, status, result } = this.runOne(this.cur, this.actions.value, input);
    this.actions = { value: actions };
    this.lastStatus = status;
    this.prev = this.cur;
    this.cur = cloneMovementState(result.state);
    this.pending.push(input);
    this.history.push(actions);
    if (this.pending.length > this.opts.maxPending) {
      const drop = this.pending.length - this.opts.maxPending;
      this.pending.splice(0, drop);
      this.history.splice(0, drop);
    }
    return result;
  }

  /**
   * Rebase on the authoritative movement and action state for `lastProcessedSeq` and replay unacknowledged inputs.
   * When inactive this starts prediction from the server state.
   */
  reconcile(server: MovementState, lastProcessedSeq: number, serverActions: A): ReconcileResult {
    this.pending = this.pending.filter((i) => i.seq > lastProcessedSeq);
    this.history = [];
    let next = cloneMovementState(server);
    let actions = serverActions;
    let status: PredictStatus | null = null;
    for (const input of this.pending) {
      const r = this.runOne(next, actions, input);
      actions = r.actions;
      status = r.status;
      this.history.push(actions);
      next = cloneMovementState(r.result.state);
    }
    this.actions = { value: actions };
    this.lastStatus = status;

    if (!this.cur || !this.prev) {
      this.cur = next;
      this.prev = cloneMovementState(next);
      this.offset = vec3();
      return { correction: 0, snapped: true, replayed: this.pending.length };
    }

    const old = this.cur.pos;
    const dx = old.x - next.pos.x;
    const dy = old.y - next.pos.y;
    const dz = old.z - next.pos.z;
    const correction = Math.hypot(dx, dy, dz);
    const snapped = correction > this.opts.snapDistance;

    if (snapped) {
      this.prev = cloneMovementState(next);
      this.offset = vec3();
    } else {
      // Shift the previous step by the same correction so lerp(prev, cur) stays continuous, and hide the jump
      // in the visual offset (decays to zero).
      this.prev = {
        ...cloneMovementState(this.prev),
        pos: { x: this.prev.pos.x - dx, y: this.prev.pos.y - dy, z: this.prev.pos.z - dz },
      };
      this.offset = { x: this.offset.x + dx, y: this.offset.y + dy, z: this.offset.z + dz };
    }
    this.cur = next;
    return { correction, snapped, replayed: this.pending.length };
  }

  /** One input: status model (timers) -> movement step -> status model edges (may end ADS). */
  private runOne(state: MovementState, actions: A, input: PlayerInput): { actions: A; status: PredictStatus; result: MovementStepResult } {
    const pre = this.model.step(actions, input, state);
    let result = this.step(state, input, pre.status);
    let next = pre.actions;
    if (this.model.after) {
      const post = this.model.after(pre.actions, input, result.state);
      next = post.actions;
      if (post.endAds && result.state.adsMs !== 0) result = { ...result, state: { ...result.state, adsMs: 0 } };
    }
    return { actions: next, status: pre.status, result };
  }

  /** Decay the visual correction offset; call once per frame. */
  decay(dt: number): void {
    if (this.opts.decayMs <= 0) {
      this.offset = vec3();
      return;
    }
    const k = Math.exp((-dt * 1000) / this.opts.decayMs);
    // Snap the tail to exactly 0 (sub-micrometre offsets are invisible), so it never decays into denormals.
    const snap = (v: number): number => (Math.abs(v * k) < OFFSET_SNAP_M ? 0 : v * k);
    this.offset = { x: snap(this.offset.x), y: snap(this.offset.y), z: snap(this.offset.z) };
  }

  /** Rendered feet position: lerp(prev step, current step, alpha) + visual offset. Null when inactive. */
  renderPosition(alpha: number): Vec3 | null {
    if (!this.cur || !this.prev) return null;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const p = lerpVec3(this.prev.pos, this.cur.pos, a);
    return { x: p.x + this.offset.x, y: p.y + this.offset.y, z: p.z + this.offset.z };
  }
}
