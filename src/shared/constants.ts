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
export const PROTOCOL_VERSION = 1;
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
/** Client runs at most this many local fixed steps per frame (spiral-of-death guard). */
export const MAX_STEPS_PER_FRAME = 5;

export const PITCH_MIN = -80 * DEG2RAD;
export const PITCH_MAX = 80 * DEG2RAD;

export const MAX_NAME_LENGTH = 16;
