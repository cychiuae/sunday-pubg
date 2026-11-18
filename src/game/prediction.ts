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
import type { MovementState, MovementStepResult, PlayerInput, Vec3 } from '../shared/types';

export interface PredictStatus {
  alive: boolean;
  healing: boolean;
  reloading: boolean;
}

export type PredictStep = (state: MovementState, input: PlayerInput, status: PredictStatus) => MovementStepResult;

/**
 * Per-input movement status. `step` advances the action state `A` by one input (edges and timers, before the
 * movement step) and returns the status that input's movement step must use. `before` = movement state before it.
 */
export interface StatusModel<A> {
  step(actions: A, input: PlayerInput, before: MovementState): { actions: A; status: PredictStatus };
}

/** A model whose status never changes (tests, or a caller that has no action state). */
export function fixedStatus(status: PredictStatus): StatusModel<null> {
  return { step: () => ({ actions: null, status }) };
}

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

export const cloneMovementState = (s: MovementState): MovementState => ({
  pos: cloneVec3(s.pos),
  vel: cloneVec3(s.vel),
  grounded: s.grounded,
  dropping: s.dropping,
});

export class Predictor<A> {
  private pending: PlayerInput[] = [];
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

  get visualOffset(): Vec3 {
    return this.offset;
  }

  /** Stop predicting (dead, not a participant, disconnected). */
  reset(): void {
    this.pending = [];
    this.prev = null;
    this.cur = null;
    this.actions = null;
    this.lastStatus = null;
    this.offset = vec3();
  }

  /** Apply one local input. Returns null when inactive (the input is not kept). */
  apply(input: PlayerInput): MovementStepResult | null {
    if (!this.cur || this.actions === null) return null;
    const { actions, status } = this.model.step(this.actions.value, input, this.cur);
    const result = this.step(this.cur, input, status);
    this.actions = { value: actions };
    this.lastStatus = status;
    this.prev = this.cur;
    this.cur = cloneMovementState(result.state);
    this.pending.push(input);
    if (this.pending.length > this.opts.maxPending) this.pending.splice(0, this.pending.length - this.opts.maxPending);
    return result;
  }

  /**
   * Rebase on the authoritative movement and action state for `lastProcessedSeq` and replay unacknowledged inputs.
   * When inactive this starts prediction from the server state.
   */
  reconcile(server: MovementState, lastProcessedSeq: number, serverActions: A): ReconcileResult {
    this.pending = this.pending.filter((i) => i.seq > lastProcessedSeq);
    let next = cloneMovementState(server);
    let actions = serverActions;
    let status: PredictStatus | null = null;
    for (const input of this.pending) {
      const s = this.model.step(actions, input, next);
      actions = s.actions;
      status = s.status;
      next = cloneMovementState(this.step(next, input, s.status).state);
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

  /** Decay the visual correction offset; call once per frame. */
  decay(dt: number): void {
    if (this.opts.decayMs <= 0) {
      this.offset = vec3();
      return;
    }
    const k = Math.exp((-dt * 1000) / this.opts.decayMs);
    this.offset = { x: this.offset.x * k, y: this.offset.y * k, z: this.offset.z * k };
  }

  /** Rendered feet position: lerp(prev step, current step, alpha) + visual offset. Null when inactive. */
  renderPosition(alpha: number): Vec3 | null {
    if (!this.cur || !this.prev) return null;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const p = lerpVec3(this.prev.pos, this.cur.pos, a);
    return { x: p.x + this.offset.x, y: p.y + this.offset.y, z: p.z + this.offset.z };
  }
}
