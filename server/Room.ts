/**
 * The single M1 room: owns the authoritative World, the fixed-step tick loop, and every connection's
 * network-edge state (validation, rate limits, snapshot/loot bookkeeping, artificial lag).
 * Spec: docs/tech/ARCHITECTURE.md §5, docs/tech/NETCODE.md.
 *
 * Transport-agnostic: server/app.ts adapts `ws` sockets to `RoomSocket`, tests use fakes.
 */
import type { Balance } from '../src/shared/balance';
import { MAX_QUEUED_INPUTS, PROTOCOL_VERSION } from '../src/shared/constants';
import {
  MAX_CLIENT_FRAME_CHARS,
  decodeClientMessage,
  encodeQuantized as encode,
  privateEventRecipient,
  quantizeDeep,
  type ErrorCode,
  type ServerMessage,
} from '../src/shared/protocol/messages';
import { CAP_DELTA, SnapshotDeltaEncoder } from '../src/shared/protocol/delta';
import type { MapData, MatchState, PlayerId, PlayerInput, SimEvent, WorldSnapshot } from '../src/shared/types';
import { LagQueue, NO_LAG, type LagConfig } from './lag';
import { RateLimiter, WindowCounter, mergeInputs, sanitizeInput, sanitizeName } from './validate';

/** The §4 World interface, restated structurally so the server does not depend on sim internals. */
export interface SimWorld {
  readonly tick: number;
  readonly timeMs: number;
  readonly map: MapData;
  addPlayer(name: string): PlayerId | null;
  removePlayer(id: PlayerId): void;
  applyInput(id: PlayerId, input: PlayerInput): void;
  step(dt: number): SimEvent[];
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot;
  getMatch(): MatchState;
}
export interface WorldFactoryOptions { map: MapData; balance: Balance; seed: number; botNames: readonly string[] }
export type WorldFactory = (opts: WorldFactoryOptions) => SimWorld;

/** Minimal socket surface the room needs (a `ws` WebSocket satisfies it). */
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

export interface RoomOptions {
  createWorld: WorldFactory;
  map: MapData;
  mapId: string;
  balance: Balance;
  seed: number;
  botNames: readonly string[];
  /** Tick and snapshot rates (the engine constants; passed in so tests can vary them). */
  simHz: number;
  snapshotHz: number;
  inputHz: number;
  lag?: LagConfig;
  log?: Logger;
  /** Monotonic ms clock (performance.now by default). */
  now?: () => number;
  /** Max simultaneous sockets (joined or not). Default 2 * match.maxPlayers + 4. */
  maxConnections?: number;
  /** Sockets that have not joined within this many ms are closed. */
  joinTimeoutMs?: number;
}

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
  defaultJoinTimeoutMs: 15_000,
} as const;

/** Close codes: 1000 normal, 1001 going away, 1008 policy violation, 1013 try again later. */
export const CLOSE = { normal: 1000, goingAway: 1001, policy: 1008, tryAgain: 1013 } as const;

interface Conn {
  readonly id: number;
  readonly socket: RoomSocket;
  readonly label: string;
  playerId: PlayerId | null;
  lastSeq: number;
  /** Validated inputs not yet forwarded to the World (jitter buffer; one per tick). */
  inputQ: PlayerInput[];
  /** Smallest queue depth seen in the current drain window. */
  minDepth: number;
  windowTicks: number;
  /** A drained input whose edge presses are folded into the next arriving input. */
  carry: PlayerInput | null;
  /** Snapshot wire format and delta base for this socket (set on join from the client's caps). */
  enc: SnapshotDeltaEncoder;
  readonly resyncLimiter: RateLimiter;
  /** Full-snapshot requests honoured / ignored by the rate limit. */
  resyncs: number;
  readonly inputLimiter: RateLimiter;
  readonly pingLimiter: RateLimiter;
  readonly badFrames: WindowCounter;
  readonly inLag: LagQueue;
  readonly outLag: LagQueue;
  closed: boolean;
  closing: boolean;
  joinTimer: ReturnType<typeof setTimeout> | null;
  bytesOut: number;
  /** Inputs rejected: rate limit, replayed/reordered seq. */
  rejectedInputs: number;
  /** Inputs merged into their successor (overflow or standing-queue drain). */
  mergedInputs: number;
  skippedSnapshots: number;
}

export interface ConnStats {
  /** Delta snapshots (client joined with `delta1`). */
  deltas: boolean;
  /** Full-snapshot requests honoured. */
  resyncs: number;
  playerId: PlayerId | null;
  queued: number;
  rejectedInputs: number;
  mergedInputs: number;
  skippedSnapshots: number;
  bytesOut: number;
}

/** Drops the oldest queued input, folding its edge buttons into the next one. */
function mergeOldest(q: PlayerInput[]): void {
  const oldest = q.shift();
  const next = q[0];
  if (oldest && next) q[0] = mergeInputs(oldest, next);
}

/** What the transport calls into for one socket. */
export interface RoomConnection {
  readonly id: number;
  onMessage(data: string | null): void;
  onClose(): void;
}

export interface RoomStats {
  connections: number;
  joined: number;
  tick: number;
  phase: MatchState['phase'];
  matchId: number;
  avgTickMs: number;
  maxTickMs: number;
  droppedTicks: number;
  bytesOut: number;
}

export class Room {
  readonly world: SimWorld;
  private readonly conns = new Map<number, Conn>();
  private nextConnId = 1;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly lag: LagConfig;
  private readonly dtMs: number;
  private readonly simDt: number;
  private readonly maxConnections: number;
  private readonly joinTimeoutMs: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private acc = 0;
  private lastLoopWall = 0;
  /** Wall time that corresponds to world.timeMs (for serverNow between ticks). */
  private lastTickWall = 0;
  private lastSnapIdx = -1;

  private tickMsSum = 0;
  private tickCount = 0;
  private maxTickMs = 0;
  private droppedTicks = 0;
  private bytesOut = 0;
  private errorCount = 0;

  constructor(private readonly opts: RoomOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.log = opts.log ?? console;
    this.lag = opts.lag ?? NO_LAG;
    this.simDt = 1 / opts.simHz;
    this.dtMs = 1000 / opts.simHz;
    this.maxConnections = opts.maxConnections ?? opts.balance.match.maxPlayers * 2 + 4;
    this.joinTimeoutMs = opts.joinTimeoutMs ?? EDGE.defaultJoinTimeoutMs;
    this.world = opts.createWorld({ map: opts.map, balance: opts.balance, seed: opts.seed, botNames: opts.botNames });
    this.lastTickWall = this.now();
  }

  // -------------------------------------------------------------------------------------------
  // Clock and loop
  // -------------------------------------------------------------------------------------------
  /** Server clock ms "now": sim time of the last tick plus wall time since it. */
  serverNow(): number {
    const since = Math.min(Math.max(0, this.now() - this.lastTickWall), this.dtMs * EDGE.maxCatchUpTicks);
    return this.world.timeMs + since;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.acc = 0;
    this.lastLoopWall = this.now();
    this.lastTickWall = this.lastLoopWall;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(this.loop, Math.max(1, this.dtMs - this.acc));
  }

  private readonly loop = (): void => {
    const now = this.now();
    this.acc += now - this.lastLoopWall;
    this.lastLoopWall = now;
    let steps = 0;
    while (this.acc >= this.dtMs && steps < EDGE.maxCatchUpTicks) {
      this.tickOnce();
      this.acc -= this.dtMs;
      steps++;
    }
    if (this.acc >= this.dtMs) {
      // Too far behind (GC pause, debugger, overloaded host): drop the time instead of spiralling.
      this.droppedTicks += Math.floor(this.acc / this.dtMs);
      this.acc = 0;
    }
    if (steps > 0) this.lastTickWall = now - this.acc;
    this.schedule();
  };

  /** One authoritative tick. Public for deterministic tests; the loop calls it at simHz. */
  tickOnce(): void {
    const t0 = this.now();
    // 1. Forward one validated input per player (the World consumes one per step).
    for (const c of this.conns.values()) {
      if (c.playerId === null) continue;
      const id = c.playerId;
      const q = c.inputQ;
      const input = q.shift();
      if (input) this.guard('applyInput', () => this.world.applyInput(id, input));
      if (q.length < c.minDepth) c.minDepth = q.length;
      if (++c.windowTicks >= EDGE.inputDrainWindowTicks) {
        for (let i = 0; i < c.minDepth && q.length > 0; i++) {
          if (q.length > 1) mergeOldest(q);
          else {
            const last = q.shift() as PlayerInput;
            c.carry = c.carry ? mergeInputs(c.carry, last) : last;
          }
          c.mergedInputs++;
        }
        c.minDepth = Number.POSITIVE_INFINITY;
        c.windowTicks = 0;
      }
    }
    // 2. Step the world and broadcast this tick's events as one batch.
    const events = this.guard('step', () => this.world.step(this.simDt)) ?? [];
    if (events.length > 0) this.broadcastEvents(events);
    // 3. Snapshots on 2 of every 3 ticks (snapshotHz / simHz).
    const snapIdx = Math.floor((this.world.tick * this.opts.snapshotHz) / this.opts.simHz);
    if (snapIdx !== this.lastSnapIdx) {
      this.lastSnapIdx = snapIdx;
      for (const c of this.conns.values()) if (c.playerId !== null) this.sendSnapshot(c);
    }
    if (!this.running) this.lastTickWall = this.now();

    const ms = this.now() - t0;
    this.tickMsSum += ms;
    this.tickCount++;
    if (ms > this.maxTickMs) this.maxTickMs = ms;
  }

  /**
   * One `events` frame per tick per joined socket. Public events are encoded once and shared. Private events
   * (`actionFailed`) go only to their own player, in order, inside that player's frame: telling everyone that an
   * opponent's reload failed for `noAmmo` would be an information leak.
   */
  private broadcastEvents(events: SimEvent[]): void {
    const tick = this.world.tick;
    const serverTime = this.world.timeMs;
    let owners: Set<PlayerId> | null = null;
    for (const ev of events) {
      const to = privateEventRecipient(ev);
      if (to !== null) (owners ??= new Set()).add(to);
    }
    const publicEvents = owners ? events.filter((ev) => privateEventRecipient(ev) === null) : events;
    const shared = publicEvents.length > 0 ? encode({ t: 'events', tick, serverTime, events: publicEvents }) : null;
    for (const c of this.conns.values()) {
      const id = c.playerId;
      if (id === null) continue;
      if (owners?.has(id)) {
        const own = events.filter((ev) => {
          const to = privateEventRecipient(ev);
          return to === null || to === id;
        });
        this.sendRaw(c, encode({ t: 'events', tick, serverTime, events: own }));
      } else if (shared !== null) {
        this.sendRaw(c, shared);
      }
    }
  }

  private sendSnapshot(c: Conn): void {
    if (c.closing || c.socket.readyState !== 1) return;
    if (c.socket.bufferedAmount > EDGE.terminateBytes) {
      this.log.warn(`[room] ${c.label} stalled (${c.socket.bufferedAmount} B buffered); closing`);
      this.closeConn(c, CLOSE.policy, 'stalled');
      return;
    }
    if (c.socket.bufferedAmount > EDGE.snapshotSkipBytes) {
      c.skippedSnapshots++;
      return;
    }
    const id = c.playerId;
    // Quantize before diffing so the delta base holds exactly what the client decodes.
    const full = this.guard('snapshotFor', () => quantizeDeep(this.world.snapshotFor(id)));
    if (!full) return;
    const wire = c.enc.encode(full);
    this.sendRaw(c, encode({ t: 'snapshot', snap: wire }));
  }

  // -------------------------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------------------------
  /** Registers a socket. Returns null (and closes it) when the room is at its connection cap. */
  connect(socket: RoomSocket, label = 'conn'): RoomConnection | null {
    if (this.conns.size >= this.maxConnections) {
      this.log.warn(`[room] rejecting ${label}: ${this.conns.size} connections`);
      socket.close(CLOSE.tryAgain, 'server_full');
      return null;
    }
    const id = this.nextConnId++;
    const now = this.now();
    const half = this.lag.latencyMs / 2;
    const c: Conn = {
      id,
      socket,
      label: `${label}#${id}`,
      playerId: null,
      lastSeq: 0,
      inputQ: [],
      minDepth: Number.POSITIVE_INFINITY,
      windowTicks: 0,
      carry: null,
      enc: new SnapshotDeltaEncoder(false),
      resyncLimiter: new RateLimiter(EDGE.resyncsPerSecond, EDGE.resyncBurst, now),
      resyncs: 0,
      inputLimiter: new RateLimiter(2 * this.opts.inputHz, 2 * this.opts.inputHz, now),
      pingLimiter: new RateLimiter(EDGE.pingsPerSecond, EDGE.pingBurst, now),
      badFrames: new WindowCounter(EDGE.badFrameWindowMs),
      inLag: new LagQueue(half, this.lag.jitterMs),
      outLag: new LagQueue(half, this.lag.jitterMs),
      closed: false,
      closing: false,
      joinTimer: null,
      bytesOut: 0,
      rejectedInputs: 0,
      mergedInputs: 0,
      skippedSnapshots: 0,
    };
    c.joinTimer = setTimeout(() => {
      c.joinTimer = null;
      if (c.playerId === null && !c.closed) this.closeConn(c, CLOSE.policy, 'join_timeout');
    }, this.joinTimeoutMs);
    this.conns.set(id, c);
    return {
      id,
      onMessage: (data) => c.inLag.run(() => this.guard('message', () => this.handleMessage(c, data))),
      onClose: () => this.guard('close', () => this.handleClose(c)),
    };
  }

  private handleMessage(c: Conn, data: string | null): void {
    if (c.closed || c.closing) return;
    if (data === null || data.length > MAX_CLIENT_FRAME_CHARS) {
      this.badFrame(c, data === null ? 'binary frame' : 'oversize frame');
      return;
    }
    const msg = decodeClientMessage(data);
    if (!msg) {
      this.badFrame(c, 'malformed frame');
      return;
    }
    const now = this.now();
    switch (msg.t) {
      case 'ping':
        if (!c.pingLimiter.take(now)) return;
        this.send(c, { t: 'pong', clientTime: msg.clientTime, serverTime: this.serverNow() });
        return;
      case 'join':
        this.handleJoin(c, msg.name, msg.protocolVersion, msg.caps ?? []);
        return;
      case 'resync':
        if (c.playerId === null || !c.enc.deltas) return;
        if (!c.resyncLimiter.take(now)) return;
        c.resyncs++;
        c.enc.reset();
        return;
      case 'input': {
        if (c.playerId === null) return; // inputs before join are dropped silently
        if (!c.inputLimiter.take(now)) {
          c.rejectedInputs++;
          return;
        }
        const clean = sanitizeInput(msg.input, c.lastSeq);
        if (!clean) {
          c.rejectedInputs++;
          return;
        }
        c.lastSeq = clean.seq;
        const input = c.carry ? mergeInputs(c.carry, clean) : clean;
        c.carry = null;
        c.inputQ.push(input);
        while (c.inputQ.length > MAX_QUEUED_INPUTS) {
          mergeOldest(c.inputQ);
          c.mergedInputs++;
        }
        return;
      }
    }
  }

  private handleJoin(c: Conn, rawName: string, version: number, caps: readonly string[]): void {
    if (c.playerId !== null) {
      this.badFrame(c, 'second join');
      return;
    }
    if (version !== PROTOCOL_VERSION) {
      this.fail(c, 'bad_version', `server protocol ${PROTOCOL_VERSION}`);
      return;
    }
    const name = sanitizeName(rawName);
    if (name === null) {
      this.fail(c, 'bad_name');
      return;
    }
    const id = this.world.addPlayer(name);
    if (id === null) {
      this.fail(c, 'full');
      return;
    }
    c.playerId = id;
    c.enc = new SnapshotDeltaEncoder(caps.includes(CAP_DELTA));
    if (c.joinTimer) clearTimeout(c.joinTimer);
    c.joinTimer = null;
    const match = this.world.getMatch();
    this.log.info(`[room] ${c.label} joined as player ${id} "${name}" (phase ${match.phase})`);
    this.send(c, {
      t: 'welcome',
      welcome: { playerId: id, mapId: this.opts.mapId, serverTime: this.serverNow(), matchId: match.matchId },
    });
  }

  private handleClose(c: Conn): void {
    if (c.closed) return;
    c.closed = true;
    c.inLag.close();
    c.outLag.close();
    if (c.joinTimer) clearTimeout(c.joinTimer);
    this.conns.delete(c.id);
    if (c.playerId !== null) {
      const id = c.playerId;
      c.playerId = null;
      this.guard('removePlayer', () => this.world.removePlayer(id));
      this.log.info(`[room] ${c.label} left (player ${id})`);
    }
  }

  private badFrame(c: Conn, why: string): void {
    const n = c.badFrames.hit(this.now());
    if (n > EDGE.maxBadFrames) {
      this.log.warn(`[room] ${c.label}: too many bad frames (last: ${why}); closing`);
      this.fail(c, 'bad_message', why);
    }
  }

  /** Sends an error and closes after it is delivered (through the lag queue if active). */
  private fail(c: Conn, code: ErrorCode, message?: string): void {
    this.send(c, message === undefined ? { t: 'error', code } : { t: 'error', code, message });
    this.closeConn(c, CLOSE.policy, code);
  }

  private closeConn(c: Conn, code: number, reason: string): void {
    if (c.closing || c.closed) return;
    c.closing = true;
    c.outLag.run(() => c.socket.close(code, reason));
  }

  private send(c: Conn, msg: ServerMessage): void {
    this.sendRaw(c, encode(msg));
  }

  private sendRaw(c: Conn, data: string): void {
    if (c.closed) return;
    c.outLag.run(() => {
      if (c.socket.readyState !== 1) return;
      try {
        c.socket.send(data);
        c.bytesOut += data.length;
        this.bytesOut += data.length;
      } catch (err) {
        this.log.warn(`[room] send to ${c.label} failed`, err);
      }
    });
  }

  /** Runs `fn`, logging (rate-limited) instead of throwing. A bad sim tick or handler must not kill the room. */
  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= 20 || this.errorCount % 500 === 0) {
        this.log.error(`[room] ${what} failed (error #${this.errorCount})`, err);
      }
      return undefined;
    }
  }

  /** Closes every socket (graceful shutdown). */
  closeAll(code: number = CLOSE.goingAway, reason = 'server_shutdown'): void {
    for (const c of this.conns.values()) {
      try {
        c.socket.close(code, reason);
      } catch {
        // already gone
      }
      this.handleClose(c);
    }
  }

  connStats(connId: number): ConnStats | null {
    const c = this.conns.get(connId);
    if (!c) return null;
    return {
      deltas: c.enc.deltas,
      resyncs: c.resyncs,
      playerId: c.playerId,
      queued: c.inputQ.length,
      rejectedInputs: c.rejectedInputs,
      mergedInputs: c.mergedInputs,
      skippedSnapshots: c.skippedSnapshots,
      bytesOut: c.bytesOut,
    };
  }

  stats(): RoomStats {
    let joined = 0;
    for (const c of this.conns.values()) if (c.playerId !== null) joined++;
    const m = this.world.getMatch();
    return {
      connections: this.conns.size,
      joined,
      tick: this.world.tick,
      phase: m.phase,
      matchId: m.matchId,
      avgTickMs: this.tickCount > 0 ? this.tickMsSum / this.tickCount : 0,
      maxTickMs: this.maxTickMs,
      droppedTicks: this.droppedTicks,
      bytesOut: this.bytesOut,
    };
  }
}
