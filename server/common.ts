/**
 * Types and edge constants shared by Session, GameRoom and RoomManager (M2b rooms, ADR 0006, NETCODE.md "Rooms").
 */
import type { Balance } from '../src/shared/balance';
import type { WorldOptions } from '../src/shared/sim/World';
import type { MatchState, PlayerId, PlayerInput, SimEvent, WorldSnapshot } from '../src/shared/types';

/** The map type the sim's World takes (the union after the C-gate). */
export type SimMap = WorldOptions['map'];

/**
 * The sim's World options (ADR 0006 §2: `timeOriginMs`, `matchStart`, `runtime`, `drop` on top of the M1 ones). The
 * server passes `matchStart` for every room match.
 */
export type WorldFactoryOptions = WorldOptions;

/** The §4 World interface, restated structurally so the server does not depend on sim internals. */
export interface SimWorld {
  readonly tick: number;
  readonly timeMs: number;
  readonly map: SimMap;
  /** ADR 0006 §2: true once the results of a `matchStart` World have ended. Optional until the sim lands it. */
  readonly finished?: boolean;
  addPlayer(name: string): PlayerId | null;
  removePlayer(id: PlayerId): void;
  applyInput(id: PlayerId, input: PlayerInput): void;
  step(dt: number): SimEvent[];
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot;
  getMatch(): MatchState;
}
export type WorldFactory = (opts: WorldFactoryOptions) => SimWorld;

/** Minimal socket surface a session needs (a `ws` WebSocket satisfies it). */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly bufferedAmount: number;
  /** 1 = OPEN (WebSocket.OPEN). */
  readonly readyState: number;
}

export interface Logger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
}
export const SILENT_LOGGER: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Edge limits (not gameplay tuning). */
export const EDGE = {
  /** More than this many bad frames inside BAD_FRAME_WINDOW_MS -> error bad_message + close. */
  maxBadFrames: 5,
  badFrameWindowMs: 1000,
  pingsPerSecond: 5,
  pingBurst: 10,
  /** Full-snapshot requests from delta clients (each costs one full snapshot, ~5-15 KB). */
  resyncsPerSecond: 1,
  resyncBurst: 3,
  /** Skip snapshots for a connection whose socket buffer is above this (slow client). */
  snapshotSkipBytes: 128 * 1024,
  /** Close a connection whose socket buffer exceeds this (stalled client). */
  terminateBytes: 1024 * 1024,
  maxCatchUpTicks: 4,
  /**
   * Jitter buffer: one input is forwarded to the World per player per tick. If the queue never drained below
   * N during this many ticks, N inputs are merged away (standing latency removed).
   */
  inputDrainWindowTicks: 30,
  /** Sockets that have not sent `hello` within this many ms are closed. */
  defaultHelloTimeoutMs: 15_000,
} as const;

/**
 * M2b lobby rate limits (NETCODE.md R4 as amended by ADR 0006 §6). Token buckets: [perSecond, burst]. Ops limits, not
 * gameplay numbers.
 */
export const LOBBY_LIMITS = {
  create: [1 / 10, 2],
  join: [2, 5],
  list: [2, 4],
  settings: [4, 8],
  toggle: [4, 8],
  start: [1, 2],
  kick: [2, 4],
  /** Per IP (the office shares one IP, so these are generous): creates and failed code lookups per minute. */
  createPerIpPerMin: 20,
  failedCodesPerIpPerMin: 20,
} as const;

/** Room housekeeping (ms). */
export const ROOM_TIMING = {
  /** Manager poll: countdown lock, auto-start timers, coalesced room broadcasts, list flush checks. */
  pollMs: 100,
  /** At most 5 `room` broadcasts per second per room. */
  roomBroadcastMinMs: 200,
  /** Room list deltas are batched this long. */
  listFlushMs: 500,
  /** A closed room's code is not reused for this long (a stale shared code never lands in a stranger's room). */
  codeReuseCooldownMs: 10 * 60_000,
  /** Code generation retries before `server_busy`. */
  codeAttempts: 20,
  /** `createRoom` is refused with `server_busy` while the event-loop delay p99 is above this. */
  busyLoopDelayP99Ms: 20,
} as const;

/** Close codes: 1000 normal, 1001 going away, 1008 policy violation, 1013 try again later. */
export const CLOSE = { normal: 1000, goingAway: 1001, policy: 1008, tryAgain: 1013 } as const;

/**
 * Seed mixer (same construction as the sim's): `mixSeed(roomSeed, matchSerial)` gives each match its World seed,
 * and `mixSeed(SEED, roomSerial)` each room its seed when SEED is set.
 */
export function mixSeed(seed: number, a: number): number {
  let h = Math.imul(seed ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(a + 0x3c6ef372, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

export type { Balance };
