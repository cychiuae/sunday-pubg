/**
 * Browser network client (INetClient). Owner: network-engineer.
 * Socket lifecycle, join, input send, ping/pong clock sync, snapshot buffer + remote interpolation.
 * Local prediction/reconciliation is ClientGame's job; it reads `snapshot.local.lastProcessedInputSeq`.
 */
import { PING_INTERVAL_MS, PROTOCOL_VERSION, WS_PATH } from '../shared/constants';
import type { InterpolatedWorld, INetClient, NetHandlers } from '../shared/contracts';
import {
  decodeServerMessage,
  encode,
  type ClientMessage,
  type DecodeHooks,
} from '../shared/protocol/messages';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../shared/protocol/delta';
import type { ConnectionStatus, PlayerId, PlayerInput, WorldSnapshot } from '../shared/types';
import { ClockSync } from './clock';
import { LogLimiter } from './logLimiter';
import { SnapshotBuffer } from './SnapshotBuffer';

/** Minimal WebSocket surface (browser WebSocket satisfies it; tests inject a fake). */
export interface SocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type SocketFactory = (url: string) => SocketLike;

export interface NetClientOptions {
  createSocket?: SocketFactory;
  /** Monotonic ms clock (performance.now by default). */
  now?: () => number;
  /** For resolving relative URLs (window.location by default). */
  location?: { protocol: string; host: string };
  /** Min ms between repeats of the same warning (malformed frames, dropped events). Default 5000. */
  warnIntervalMs?: number;
}

const OPEN = 1;
/** Quick pings right after connect so the clock is good before the first snapshots matter. */
const INITIAL_PINGS = 3;
const INITIAL_PING_SPACING_MS = 150;
/** Stop queuing inputs on a stalled socket; the server would discard them as stale anyway. */
const MAX_BUFFERED_BYTES = 64 * 1024;
/** Re-request a full snapshot at most this often while delta snapshots cannot be applied. */
const RESYNC_RETRY_MS = 1000;

const NOOP_HANDLERS: NetHandlers = {
  onWelcome: () => {},
  onSnapshot: () => {},
  onEvents: () => {},
  onStatus: () => {},
};

/** ws(s) URL for `url`: absolute ws(s) URLs pass through, http(s) map to ws(s), paths resolve against location. */
export function resolveWsUrl(url: string, loc: { protocol: string; host: string } | undefined): string {
  const u = url.trim();
  if (/^wss?:\/\//i.test(u)) return u;
  if (/^https?:\/\//i.test(u)) return u.replace(/^http/i, 'ws');
  if (!loc) throw new Error(`cannot resolve relative WebSocket URL "${u}" without location`);
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const path = u === '' ? WS_PATH : u.startsWith('/') ? u : `/${u}`;
  return `${proto}//${loc.host}${path}`;
}

export class NetClient implements INetClient {
  private handlers: NetHandlers = NOOP_HANDLERS;
  private socket: SocketLike | null = null;
  private _status: ConnectionStatus = 'idle';
  private _playerId: PlayerId | null = null;
  private readonly clock = new ClockSync();
  private readonly buffer = new SnapshotBuffer();
  /** Rebuilds full snapshots from delta snapshots (protocol/delta.ts). */
  private readonly deltas = new SnapshotDeltaDecoder();
  private lastResyncAt = Number.NEGATIVE_INFINITY;
  /** Snapshots dropped because their delta base did not match (diagnostics, tests). */
  private _resyncs = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private initialPingTimers: ReturnType<typeof setTimeout>[] = [];
  private opened = false;
  private serverError: string | null = null;

  private readonly createSocket: SocketFactory;
  private readonly now: () => number;
  private readonly loc: { protocol: string; host: string } | undefined;
  /** Malformed frames arrive at snapshot rate when something is wrong; warn once per key per interval. */
  private readonly warnings: LogLimiter;
  private readonly decodeHooks: DecodeHooks = {
    onDroppedEvent: (ev) => {
      const type = typeof ev === 'object' && ev !== null && 'type' in ev ? String((ev as { type: unknown }).type) : '?';
      this.warnings.warn(`event:${type.slice(0, 40)}`, `[net] dropped unknown or malformed server event "${type.slice(0, 40)}"`, ev);
    },
  };

  constructor(opts: NetClientOptions = {}) {
    this.createSocket =
      opts.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.now = opts.now ?? (() => performance.now());
    this.loc = opts.location ?? (typeof location !== 'undefined' ? location : undefined);
    this.warnings = new LogLimiter(this.now, opts.warnIntervalMs ?? 5000);
  }

  get status(): ConnectionStatus {
    return this._status;
  }
  get playerId(): PlayerId | null {
    return this._playerId;
  }
  get rttMs(): number {
    return this.clock.rttMs;
  }
  /** Number of undecodable delta snapshots since connect (each one triggers or awaits a resync). */
  get resyncCount(): number {
    return this._resyncs;
  }

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers;
  }

  connect(url: string, name: string): void {
    this.teardown();
    this.resetSession();
    let wsUrl: string;
    let socket: SocketLike;
    try {
      wsUrl = resolveWsUrl(url, this.loc);
      socket = this.createSocket(wsUrl);
    } catch (err) {
      console.error('[net] connect failed', err);
      this.setStatus('error', 'connect_failed');
      return;
    }
    this.socket = socket;
    this.setStatus('connecting');

    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.setStatus('connected');
      this.sendMsg({ t: 'join', name, protocolVersion: PROTOCOL_VERSION, caps: [CAP_DELTA] });
      this.startPings();
    };
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      this.handleMessage(ev.data);
    };
    socket.onerror = () => {
      // A close event always follows; status is reported there.
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.stopPings();
      this.socket = null;
      if (this.serverError !== null) return; // already reported as 'error' with the server's code
      if (!this.opened) this.setStatus('error', 'connect_failed');
      else this.setStatus('disconnected', ev.reason || `close_${ev.code}`);
    };
  }

  disconnect(): void {
    const had = this.socket !== null;
    this.teardown();
    this._playerId = null;
    if (had || this._status !== 'idle') this.setStatus('idle', 'client_disconnect');
  }

  sendInput(input: PlayerInput): void {
    const s = this.socket;
    if (!s || this._status !== 'connected' || this._playerId === null || s.readyState !== OPEN) return;
    if (s.bufferedAmount > MAX_BUFFERED_BYTES) return;
    this.sendMsg({ t: 'input', input });
  }

  serverNow(): number {
    return this.clock.serverNow(this.now());
  }

  getInterpolated(renderTime: number): InterpolatedWorld | null {
    return this.buffer.sample(renderTime);
  }

  latestSnapshot(): WorldSnapshot | null {
    return this.buffer.latest();
  }

  // -------------------------------------------------------------------------------------------
  private handleMessage(data: unknown): void {
    const msg = decodeServerMessage(data, this.decodeHooks);
    if (!msg) {
      const size = typeof data === 'string' ? `${data.length} chars` : typeof data;
      this.warnings.warn('malformed', `[net] dropped malformed server frame (${size})`);
      return;
    }
    switch (msg.t) {
      case 'welcome':
        this._playerId = msg.welcome.playerId;
        this.clock.roughSync(msg.welcome.serverTime, this.now());
        this.call(() => this.handlers.onWelcome(msg.welcome));
        return;
      case 'snapshot': {
        const res = this.deltas.apply(msg.snap);
        if (!res.ok) {
          this.requestResync(res.reason);
          return;
        }
        const snap = res.snap;
        this.clock.roughSync(snap.serverTime, this.now());
        if (this.buffer.push(snap)) this.call(() => this.handlers.onSnapshot(snap));
        return;
      }
      case 'events':
        if (msg.events.length > 0) this.call(() => this.handlers.onEvents(msg.events, msg.serverTime));
        return;
      case 'pong':
        this.clock.addSample(msg.clientTime, msg.serverTime, this.now());
        return;
      case 'error':
        this.serverError = msg.code;
        this.setStatus('error', msg.code);
        return;
    }
  }

  /** A delta snapshot did not fit our state: ask for a full one (rate-limited while earlier deltas drain). */
  private requestResync(reason: string): void {
    this._resyncs++;
    const now = this.now();
    if (now - this.lastResyncAt < RESYNC_RETRY_MS) return;
    this.lastResyncAt = now;
    this.warnings.warn('resync', `[net] snapshot delta did not apply (${reason}); requesting a full snapshot`);
    this.sendMsg({ t: 'resync' });
  }

  private startPings(): void {
    this.stopPings();
    for (let i = 0; i < INITIAL_PINGS; i++) {
      this.initialPingTimers.push(setTimeout(() => this.ping(), i * INITIAL_PING_SPACING_MS));
    }
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  private stopPings(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const t of this.initialPingTimers) clearTimeout(t);
    this.initialPingTimers = [];
  }

  private ping(): void {
    if (this.socket?.readyState === OPEN) this.sendMsg({ t: 'ping', clientTime: this.now() });
  }

  private sendMsg(msg: ClientMessage): void {
    try {
      this.socket?.send(encode(msg));
    } catch (err) {
      this.warnings.warn('send', '[net] send failed', err);
    }
  }

  private setStatus(status: ConnectionStatus, reason?: string): void {
    this._status = status;
    this.call(() => this.handlers.onStatus(status, reason));
  }

  private call(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[net] handler threw', err);
    }
  }

  private teardown(): void {
    this.stopPings();
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = null;
      s.onmessage = null;
      s.onclose = null;
      s.onerror = null;
      try {
        s.close(1000, 'client_disconnect');
      } catch {
        // ignore
      }
    }
  }

  private resetSession(): void {
    this._playerId = null;
    this.opened = false;
    this.serverError = null;
    this.buffer.clear();
    this.deltas.reset();
    this.lastResyncAt = Number.NEGATIVE_INFINITY;
    this._resyncs = 0;
    this.clock.reset();
  }
}
