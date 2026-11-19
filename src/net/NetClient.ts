/**
 * Browser network client (INetClient). Owner: network-engineer.
 * Socket lifecycle, the `hello` handshake (with the per-browser client token), M2b room requests and the room list,
 * input send, ping/pong clock sync, snapshot buffer + remote interpolation.
 * Local prediction/reconciliation is ClientGame's job; it reads `snapshot.local.lastProcessedInputSeq`.
 *
 * M2b (ADR 0006): every `welcome` starts a new World (ticks restart), so the delta decoder and the snapshot buffer are
 * reset on each one; leaving the room resets them too.
 */
import { PING_INTERVAL_MS, PROTOCOL_VERSION, WS_PATH } from '../shared/constants';
import {
  CLIENT_TOKEN_STORAGE_KEY,
  type InterpolatedWorld,
  type INetClient,
  type NetHandlers,
  type RoomJoinTarget,
  type RoomSettingsInput,
} from '../shared/contracts';
import {
  decodeServerMessage,
  encode,
  type ClientMessage,
  type DecodeHooks,
  type LobbyRequest,
} from '../shared/protocol/messages';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../shared/protocol/delta';
import { CAP_ROWS } from '../shared/protocol/rows';
import type {
  ConnectionStatus,
  MapVoteOption,
  MemberId,
  PlayerId,
  PlayerInput,
  RoomId,
  RoomSummary,
  WorldSnapshot,
} from '../shared/types';
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
  /** Where the client token lives (window.localStorage by default; null = none, a fresh token per NetClient). */
  storage?: TokenStorage | null;
  /** Random bytes for a new token (crypto.getRandomValues by default). */
  randomBytes?: (n: number) => Uint8Array;
}

/** The slice of Storage the client token needs. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

function base64url(bytes: Uint8Array): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2;
    for (let k = 0; k < chars; k++) out += abc[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/**
 * ADR 0006 §5: the per-browser token (128 random bits, base64url) from `storage`, created and stored when missing or
 * malformed. Storage failures (private mode, quota) fall back to an unsaved token.
 */
export function loadClientToken(storage: TokenStorage | null, randomBytes: (n: number) => Uint8Array): string {
  try {
    const have = storage?.getItem(CLIENT_TOKEN_STORAGE_KEY) ?? null;
    if (have !== null && TOKEN_RE.test(have)) return have;
  } catch {
    // unreadable storage: fall through to a fresh token
  }
  const token = base64url(randomBytes(16));
  try {
    storage?.setItem(CLIENT_TOKEN_STORAGE_KEY, token);
  } catch {
    // not persisted: the kick cooldown then lasts only for this page
  }
  return token;
}

const defaultStorage = (): TokenStorage | null => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
};
const defaultRandomBytes = (n: number): Uint8Array => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};

/** Lobby requests issued before the socket opens are queued (deep link: connect, then joinRoom right away). */
const MAX_QUEUED_REQUESTS = 16;

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
  /** M2b room list as last rebuilt (rev -1 = none) and whether the caller wants it (re-subscribed after a room). */
  private readonly roomList = new Map<RoomId, RoomSummary>();
  private listRev = -1;
  private listWanted = false;
  private queued: LobbyRequest[] = [];
  private rid = 0;
  private readonly storage: TokenStorage | null;
  private readonly randomBytes: (n: number) => Uint8Array;
  private token: string | null = null;

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
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.randomBytes = opts.randomBytes ?? defaultRandomBytes;
  }

  /** The per-browser client token (loaded or created on first use). */
  get clientToken(): string {
    this.token ??= loadClientToken(this.storage, this.randomBytes);
    return this.token;
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
      this.sendMsg({ t: 'hello', name, protocolVersion: PROTOCOL_VERSION, clientToken: this.clientToken, caps: [CAP_DELTA, CAP_ROWS] });
      // Requests made while connecting follow the hello in order (the server handles frames in order).
      const q = this.queued;
      this.queued = [];
      for (const m of q) this.sendMsg(m);
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

  // -------------------------------------------------------------------------------------------
  // M2b rooms (ADR 0006). No-ops when idle or disconnected; queued while connecting.
  // -------------------------------------------------------------------------------------------
  listRooms(subscribe: boolean): void {
    this.listWanted = subscribe;
    this.request({ t: 'listRooms', subscribe, rid: this.nextRid() });
  }
  createRoom(settings: RoomSettingsInput): void {
    this.request({ t: 'createRoom', settings, rid: this.nextRid() });
  }
  joinRoom(target: RoomJoinTarget): void {
    const rid = this.nextRid();
    this.request('roomId' in target ? { t: 'joinRoom', roomId: target.roomId, rid } : { t: 'joinRoom', code: target.code, rid });
  }
  leaveRoom(): void {
    this.request({ t: 'leaveRoom', rid: this.nextRid() });
  }
  setRoomSettings(patch: Partial<RoomSettingsInput>): void {
    this.request({ t: 'setRoomSettings', settings: patch, rid: this.nextRid() });
  }
  startMatch(): void {
    this.request({ t: 'startMatch', rid: this.nextRid() });
  }
  cancelCountdown(): void {
    this.request({ t: 'cancelCountdown', rid: this.nextRid() });
  }
  setReady(ready: boolean): void {
    this.request({ t: 'setReady', ready });
  }
  vote(option: MapVoteOption | null): void {
    this.request({ t: 'vote', choice: option });
  }
  kick(memberId: MemberId): void {
    this.request({ t: 'kick', memberId, rid: this.nextRid() });
  }

  private nextRid(): number {
    this.rid = (this.rid + 1) % 2 ** 31;
    return this.rid;
  }

  private request(msg: LobbyRequest): void {
    if (this._status === 'connecting' && !this.opened) {
      if (this.queued.length < MAX_QUEUED_REQUESTS) this.queued.push(msg);
      return;
    }
    if (this._status !== 'connected' || this.socket?.readyState !== OPEN) return;
    this.sendMsg(msg);
  }

  /** Starts a new match's stream: a new World restarts ticks, so the old delta base and buffer are meaningless. */
  private resetMatchStream(): void {
    this.buffer.clear();
    this.deltas.reset();
    this.lastResyncAt = Number.NEGATIVE_INFINITY;
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
        this.resetMatchStream();
        this._playerId = msg.welcome.playerId;
        this.clock.roughSync(msg.welcome.serverTime, this.now());
        this.call(() => this.handlers.onWelcome(msg.welcome));
        return;
      case 'hello': {
        const hello = msg.hello;
        this.clock.roughSync(hello.serverTime, this.now());
        this.call(() => this.handlers.onHello?.(hello));
        return;
      }
      case 'roomList':
        this.roomList.clear();
        for (const r of msg.rooms) this.roomList.set(r.id, r);
        this.listRev = msg.rev;
        this.emitRoomList();
        return;
      case 'roomListDelta':
        if (msg.from !== this.listRev) {
          // Missed a revision (or subscribed between flushes): ask for the full list again.
          if (this.listWanted) this.sendMsg({ t: 'listRooms', subscribe: true, rid: this.nextRid() });
          return;
        }
        for (const id of msg.remove) this.roomList.delete(id);
        for (const r of msg.upsert) this.roomList.set(r.id, r);
        this.listRev = msg.rev;
        this.emitRoomList();
        return;
      case 'roomJoined': {
        const { room, memberId } = msg;
        this.listRev = -1; // the server stops the list while we are in a room
        this.call(() => this.handlers.onRoomJoined?.(room, memberId));
        return;
      }
      case 'room': {
        const room = msg.room;
        this.call(() => this.handlers.onRoom?.(room));
        return;
      }
      case 'roomLeft': {
        const reason = msg.reason;
        this._playerId = null;
        this.resetMatchStream();
        this.call(() => this.handlers.onRoomLeft?.(reason));
        // Back in the browser: resume the list if the caller had it open.
        if (this.listWanted && reason !== 'closed') this.sendMsg({ t: 'listRooms', subscribe: true, rid: this.nextRid() });
        return;
      }
      case 'reject': {
        const { req, code, retryAfterMs } = msg;
        this.call(() => this.handlers.onReject?.(req, code, retryAfterMs));
        return;
      }
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

  private emitRoomList(): void {
    const rooms = [...this.roomList.values()];
    this.call(() => this.handlers.onRoomList?.(rooms));
  }

  private resetSession(): void {
    this.roomList.clear();
    this.listRev = -1;
    this.listWanted = false;
    this.queued = [];
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
