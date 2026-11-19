/**
 * Engine constants (not gameplay tuning). Owner: tech-lead.
 * Tick/snapshot rates come from balance.json `net` so there is one source of truth.
 */
import { BALANCE } from './balance';
import { DEG2RAD } from './math';

export const SIM_HZ = BALANCE.net.simHz; // 30
export const SIM_DT = 1 / SIM_HZ; // seconds per sim tick
export const SNAPSHOT_HZ = BALANCE.net.snapshotHz; // 20
export const INPUT_HZ = BALANCE.net.inputHz; // 30 (== SIM_HZ: one input per local fixed step)
export const INTERP_DELAY_MS = BALANCE.net.interpolationDelayMs; // 100

/** WebSocket path. Dev: Vite proxies it to the server; prod: same origin. */
export const WS_PATH = '/ws';
/**
 * M2a (ADR 0004 §6): 2. New PlayerInput fields (ads, stanceToggle, selectSlot 3), PlayerState stance/armor tiers,
 * grenades in snapshots and new SimEvents. Client and server must match; mismatches get `error bad_version`.
 * M2b (ADR 0006 §6, C-gate): 3. `hello` replaces `join`, room messages, drop fields, 'glass' surfaces.
 * M2c (ADR 0007 §6, §10): becomes 4 at the M2c C-gate (compact rows, M2c fields and events, welcome.layout).
 */
export const PROTOCOL_VERSION = 4;
export const PING_INTERVAL_MS = 1000;

/** Server keeps at most this many queued inputs per player; older ones are dropped. */
export const MAX_QUEUED_INPUTS = 8;
/**
 * M1-fix (consumer: game-developer, World.dequeue). When a human's input queue is empty the sim repeats the last
 * input's held fields for at most this many consecutive ticks (absorbs jitter), then uses neutral held fields
 * (no move/sprint/fire; keep yaw/pitch). Stops hidden/stalled tabs from running or firing forever.
 */
export const MAX_INPUT_REPEAT_TICKS = 6;
/**
 * Revision 1b (producer: Renderer.getGraphicsStatus). After webglcontextlost, the renderer reports 'failed' if
 * webglcontextrestored has not fired within this many ms (ADR 0003 §5).
 */
export const CONTEXT_RESTORE_TIMEOUT_MS = 5000;
/**
 * M2a (ADR 0004 §3; consumer: ClientGame grenade view). Client-side grenade extrapolation from the latest snapshot
 * (or grenadeThrown event) runs the shared stepGrenade forward to serverNow(), but never more than this many ms
 * past the source sample. Beyond it the grenade holds still until fresher data arrives.
 */
export const GRENADE_EXTRAPOLATION_MAX_MS = 250;
/** Client runs at most this many local fixed steps per frame (spiral-of-death guard). */
export const MAX_STEPS_PER_FRAME = 5;

export const PITCH_MIN = -80 * DEG2RAD;
export const PITCH_MAX = 80 * DEG2RAD;

export const MAX_NAME_LENGTH = 16;
