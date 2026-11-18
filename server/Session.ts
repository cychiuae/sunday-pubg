/**
 * One socket's network edge (NETCODE.md R6.1): decoding, the bad-frame counter, rate limiters, simulated lag, the
 * hello timeout and byte stats, plus who the socket is (name, client token, capabilities) and where it is
 * (BROWSER or a room member). Rooms and the manager talk to the client only through a Session.
 *
 * Transport-agnostic: server/app.ts adapts `ws` sockets to `RoomSocket`; tests use fakes.
 */
import {
  MAX_CLIENT_FRAME_CHARS,
  decodeClientMessage,
  encodeQuantized as encode,
  type ClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '../src/shared/protocol/messages';
import type { MemberId, RejectCode } from '../src/shared/types';
import { CLOSE, EDGE, LOBBY_LIMITS, type Logger, type RoomSocket } from './common';
import { LagQueue, type LagConfig } from './lag';
import { RateLimiter, WindowCounter } from './validate';

export type SessionState = 'new' | 'browser' | 'room';

/** What a Session reports to its owner (the RoomManager). */
export interface SessionHost {
  readonly log: Logger;
  /** Called for every well-formed frame, after the simulated inbound lag. */
  onSessionMessage(s: Session, msg: ClientMessage): void;
  onSessionClose(s: Session): void;
}

/** Lobby request buckets (per session). */
export interface LobbyBuckets {
  create: RateLimiter;
  join: RateLimiter;
  list: RateLimiter;
  settings: RateLimiter;
  toggle: RateLimiter;
  start: RateLimiter;
  kick: RateLimiter;
}

/** Opaque handle of the room a session is in (GameRoom, kept generic to avoid an import cycle). */
export interface SessionRoomRef {
  readonly id: string;
}

export class Session {
  state: SessionState = 'new';
  name = '';
  /** Validated client token, or a random anonymous one (ADR 0006 §5). Keys only the kick cooldown. */
  token = '';
  /** Advertised `delta1` in hello. */
  deltas = false;
  /** Subscribed to room list deltas (BROWSER only; cleared on entering a room). */
  listSubscribed = false;
  room: SessionRoomRef | null = null;
  memberId: MemberId | null = null;

  closed = false;
  closing = false;
  bytesOut = 0;
  rejectedInputs = 0;
  /** Inputs that passed the session rate limit (the room's seat applies the rest of the edge rules). */
  readonly inputLimiter: RateLimiter;
  readonly resyncLimiter: RateLimiter;
  readonly pingLimiter: RateLimiter;
  readonly lobby: LobbyBuckets;
  private readonly badFrames = new WindowCounter(EDGE.badFrameWindowMs);
  private readonly inLag: LagQueue;
  private readonly outLag: LagQueue;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: number,
    readonly socket: RoomSocket,
    readonly ip: string,
    private readonly host: SessionHost,
    private readonly now: () => number,
    lag: LagConfig,
    inputHz: number,
    helloTimeoutMs: number,
  ) {
    const t = now();
    const half = lag.latencyMs / 2;
    this.inLag = new LagQueue(half, lag.jitterMs);
    this.outLag = new LagQueue(half, lag.jitterMs);
    this.inputLimiter = new RateLimiter(2 * inputHz, 2 * inputHz, t);
    this.resyncLimiter = new RateLimiter(EDGE.resyncsPerSecond, EDGE.resyncBurst, t);
    this.pingLimiter = new RateLimiter(EDGE.pingsPerSecond, EDGE.pingBurst, t);
    const L = LOBBY_LIMITS;
    this.lobby = {
      create: new RateLimiter(L.create[0], L.create[1], t),
      join: new RateLimiter(L.join[0], L.join[1], t),
      list: new RateLimiter(L.list[0], L.list[1], t),
      settings: new RateLimiter(L.settings[0], L.settings[1], t),
      toggle: new RateLimiter(L.toggle[0], L.toggle[1], t),
      start: new RateLimiter(L.start[0], L.start[1], t),
      kick: new RateLimiter(L.kick[0], L.kick[1], t),
    };
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.state === 'new' && !this.closed) this.closeConn(CLOSE.policy, 'hello_timeout');
    }, helloTimeoutMs);
  }

  get label(): string {
    return `${this.ip}#${this.id}`;
  }

  /** Transport entry: a text frame (null = binary). */
  onMessage(data: string | null): void {
    this.inLag.run(() => this.guard('message', () => this.handleFrame(data)));
  }

  /** Transport entry: the socket closed. Idempotent. */
  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.inLag.close();
    this.outLag.close();
    this.clearHelloTimer();
    this.guard('close', () => this.host.onSessionClose(this));
  }

  clearHelloTimer(): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
  }

  private handleFrame(data: string | null): void {
    if (this.closed || this.closing) return;
    if (data === null || data.length > MAX_CLIENT_FRAME_CHARS) {
      this.badFrame(data === null ? 'binary frame' : 'oversize frame');
      return;
    }
    const msg = decodeClientMessage(data);
    if (!msg) {
      this.badFrame('malformed frame');
      return;
    }
    this.host.onSessionMessage(this, msg);
  }

  badFrame(why: string): void {
    const n = this.badFrames.hit(this.now());
    if (n > EDGE.maxBadFrames) {
      this.host.log.warn(`[session] ${this.label}: too many bad frames (last: ${why}); closing`);
      this.fail('bad_message', why);
    }
  }

  send(msg: ServerMessage): void {
    this.sendRaw(encode(msg));
  }

  /** Non-fatal lobby refusal (the socket stays open). */
  reject(req: string, code: RejectCode, rid?: number, retryAfterMs?: number): void {
    this.send({
      t: 'reject',
      ...(rid !== undefined ? { rid } : {}),
      req,
      code,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  /** Sends an error and closes after it is delivered (through the lag queue if active). */
  fail(code: ErrorCode, message?: string): void {
    this.send(message === undefined ? { t: 'error', code } : { t: 'error', code, message });
    this.closeConn(CLOSE.policy, code);
  }

  closeConn(code: number, reason: string): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.outLag.run(() => this.socket.close(code, reason));
  }

  /** Immediate close (shutdown): no lag queue. */
  closeNow(code: number, reason: string): void {
    try {
      this.socket.close(code, reason);
    } catch {
      // already gone
    }
  }

  sendRaw(data: string): void {
    if (this.closed) return;
    this.outLag.run(() => {
      if (this.socket.readyState !== 1) return;
      try {
        this.socket.send(data);
        this.bytesOut += data.length;
      } catch (err) {
        this.host.log.warn(`[session] send to ${this.label} failed`, err);
      }
    });
  }

  /** Runs `fn`, logging instead of throwing: a bad handler must not kill the process. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.host.log.error(`[session] ${what} failed for ${this.label}`, err);
    }
  }
}
