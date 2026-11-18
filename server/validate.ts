/**
 * Semantic validation at the network edge (ARCHITECTURE.md §5). Shape checks live in
 * src/shared/protocol/messages.ts; this file clamps values and enforces ordering and rates.
 */
import { MAX_NAME_LENGTH, PITCH_MAX, PITCH_MIN, SIM_DT } from '../src/shared/constants';
import { clamp, wrapAngle } from '../src/shared/math';
import type { PlayerInput } from '../src/shared/types';

// Control (Cc), format (Cf: zero-width, bidi overrides), line/paragraph separators, private use, unassigned.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;

/** Returns the cleaned name, or null if it is empty or longer than MAX_NAME_LENGTH code points after cleaning. */
export function sanitizeName(raw: string, maxLength = MAX_NAME_LENGTH): string | null {
  const cleaned = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(STRIP, '').trim();
  const len = Array.from(cleaned).length;
  if (len < 1 || len > maxLength) return null;
  return cleaned;
}

/** Move vectors longer than this are normalised; within it they pass unchanged (see sanitizeInput). */
export const MAX_MOVE_LEN = 1 + 1e-9;

/**
 * Clamps a shape-valid input. Returns null when `seq` is not strictly greater than `lastSeq`
 * (replayed, duplicated or reordered input).
 */
export function sanitizeInput(input: PlayerInput, lastSeq: number): PlayerInput | null {
  if (input.seq <= lastSeq) return null;
  let f = clamp(input.moveForward, -1, 1);
  let r = clamp(input.moveRight, -1, 1);
  const len = Math.hypot(f, r);
  // Tolerance: a vector this function (or the client) already normalised can have hypot 1 + 1 ulp. Dividing again
  // would make the server's axes differ from the client's prediction by 1 ulp (REVIEW-M1 nit).
  if (len > MAX_MOVE_LEN) {
    f /= len;
    r /= len;
  }
  return {
    ...input,
    dt: clamp(input.dt, 0, SIM_DT),
    moveForward: f,
    moveRight: r,
    yaw: wrapAngle(input.yaw),
    pitch: clamp(input.pitch, PITCH_MIN, PITCH_MAX),
  };
}

/** Token bucket. `take()` returns false when the caller is over the rate. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    now: number,
  ) {
    this.tokens = burst;
    this.last = now;
  }
  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSecond);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/** Counts events in a sliding window; `hit()` returns the count inside the window including this one. */
export class WindowCounter {
  private times: number[] = [];
  constructor(private readonly windowMs: number) {}
  hit(now: number): number {
    this.times.push(now);
    while (this.times.length > 0 && now - (this.times[0] as number) > this.windowMs) this.times.shift();
    return this.times.length;
  }
}

/**
 * Folds `older` into `newer` when the server drops a queued input (queue overflow or standing-queue drain):
 * held axes/aim come from `newer`; edge buttons and `fire` are OR-ed so a press is never lost; a slot
 * selection survives unless `newer` selects another one.
 */
export function mergeInputs(older: PlayerInput, newer: PlayerInput): PlayerInput {
  return {
    ...newer,
    fire: older.fire || newer.fire,
    jump: older.jump || newer.jump,
    reload: older.reload || newer.reload,
    interact: older.interact || newer.interact,
    useHeal: older.useHeal || newer.useHeal,
    selectSlot: newer.selectSlot !== -1 ? newer.selectSlot : older.selectSlot,
  };
}
