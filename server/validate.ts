/**
 * Semantic validation at the network edge (ARCHITECTURE.md §5). Shape checks live in
 * src/shared/protocol/messages.ts; this file clamps values and enforces ordering and rates.
 */
import { MAX_NAME_LENGTH, PITCH_MAX, PITCH_MIN, SIM_DT } from '../src/shared/constants';
import { clamp, wrapAngle } from '../src/shared/math';
import { decodeStanceToggle } from '../src/shared/protocol/messages';
import { MAX_MOVE_INPUT_LEN } from '../src/shared/sim/movement';
import type { PlayerInput, SlotIndex } from '../src/shared/types';

/** M2a: valid `selectSlot` values (-1 = no change, 3 = grenade slot). */
const SELECT_SLOTS: readonly (SlotIndex | -1)[] = [-1, 0, 1, 2, 3];

// Control (Cc), format (Cf: zero-width, bidi overrides), line/paragraph separators, private use, unassigned.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;

/**
 * M2b: a room name as stored (ADR 0006 §6): cleaned like a player name and capped (truncated) at `maxLength` code
 * points. Empty after cleaning (or null) -> null, which clients render as the default "{host}'s room".
 */
export function sanitizeRoomName(raw: string | null, maxLength: number): string | null {
  if (raw === null) return null;
  const cleaned = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(STRIP, '').trim();
  const capped = Array.from(cleaned).slice(0, Math.max(0, maxLength)).join('').trim();
  return capped.length > 0 ? capped : null;
}

/** M2b (ADR 0006 §5): a well-formed client token, else null (the session is then anonymous). */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
export function validClientToken(raw: string | undefined): string | null {
  return raw !== undefined && TOKEN_RE.test(raw) ? raw : null;
}

/** Returns the cleaned name, or null if it is empty or longer than MAX_NAME_LENGTH code points after cleaning. */
export function sanitizeName(raw: string, maxLength = MAX_NAME_LENGTH): string | null {
  const cleaned = raw.normalize('NFC').replace(/\s+/gu, ' ').replace(STRIP, '').trim();
  const len = Array.from(cleaned).length;
  if (len < 1 || len > maxLength) return null;
  return cleaned;
}

/**
 * Move vectors longer than this are normalised; within it they pass unchanged (see sanitizeInput). The sim's own
 * constant (REVIEW-M2a L5), so the server and prediction can never disagree on the tolerance.
 */
export const MAX_MOVE_LEN = MAX_MOVE_INPUT_LEN;

/**
 * Clamps a shape-valid input. Returns null when `seq` is not strictly greater than `lastSeq`
 * (replayed, duplicated or reordered input).
 * M2a: repeats the decoder's rules as defence in depth (this is the last stop before the World): `ads` is coerced
 * to a boolean, and an unknown `stanceToggle` or a `selectSlot` outside {-1, 0, 1, 2, 3} rejects the input.
 */
export function sanitizeInput(input: PlayerInput, lastSeq: number): PlayerInput | null {
  if (input.seq <= lastSeq) return null;
  const stanceToggle = decodeStanceToggle(input.stanceToggle);
  if (stanceToggle === undefined) return null;
  if (!SELECT_SLOTS.includes(input.selectSlot)) return null;
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
    ads: input.ads === true,
    stanceToggle,
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
  /** True when the bucket has refilled completely (idle; safe to forget). */
  full(now: number): boolean {
    return this.tokens + (Math.max(0, now - this.last) / 1000) * this.perSecond >= this.burst;
  }
  /** ms until `take()` would succeed again (0 if it would now). Call after a failed `take` (no refill side effect). */
  retryAfterMs(now: number): number {
    const tokens = Math.min(this.burst, this.tokens + (Math.max(0, now - this.last) / 1000) * this.perSecond);
    return tokens >= 1 ? 0 : Math.ceil(((1 - tokens) / this.perSecond) * 1000);
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
 * held axes/aim (and M2a `ads`) come from `newer`; edge buttons and `fire` are OR-ed so a press is never lost; a slot
 * selection survives unless `newer` selects another one. M2a `stanceToggle` works like `selectSlot`: the later
 * request wins, an older one survives a null (the same "later press wins" rule the client applies to C and Z).
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
    stanceToggle: newer.stanceToggle ?? older.stanceToggle,
  };
}
