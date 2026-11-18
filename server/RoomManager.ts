/**
 * The process-wide owner of sessions and rooms (ADR 0006 §1, NETCODE.md "Rooms"): the room table and codes, the
 * room list and its subscribers, the global caps (MAX_ROOMS, MAX_CONNECTIONS), per-IP limits, the prepared-map cache,
 * the event-loop delay monitor, and the hello / lobby message handling.
 */
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import type { Balance, RoomsBalance } from '../src/shared/balance';
import type { ServerHello } from '../src/shared/contracts';
import { PROTOCOL_VERSION } from '../src/shared/constants';
import { encodeQuantized as encode, type ClientMessage, type LobbyRequest } from '../src/shared/protocol/messages';
import type { MapChoice, MapChoiceInput } from '../src/shared/sim/mapVote';
import type { MapRuntime } from '../src/shared/sim/movement';
import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeRoomCode,
  type MapId,
  type RoomId,
  type RoomSettings,
  type RoomSummary,
} from '../src/shared/types';
import { CAP_DELTA } from '../src/shared/protocol/delta';
import {
  CLOSE,
  LOBBY_LIMITS,
  ROOM_TIMING,
  SILENT_LOGGER,
  mixSeed,
  type Logger,
  type RoomSocket,
  type SimMap,
  type WorldFactory,
} from './common';
import { GameRoom, applySettings, type GameRoomStats, type MatchDeps, type SeatStats } from './GameRoom';
import { NO_LAG, type LagConfig } from './lag';
import { Session, type LobbyBuckets, type SessionHost } from './Session';
import { RateLimiter, sanitizeName, validClientToken } from './validate';

export interface RoomManagerOptions {
  /** Base balance (validated). Per-map balances come from `balanceForMap`. */
  balance: Balance;
  /** `balance.rooms` with its fallback resolved (server/config.ts `roomsBalance`). */
  rooms: RoomsBalance;
  /** `match.mapVoteLockSeconds` with its fallback resolved. */
  lockSeconds: number;
  createWorld: WorldFactory;
  getMap(id: MapId): SimMap;
  maps: readonly MapId[];
  /** Validated `MAP` pin, else null. */
  pin: MapId | null;
  balanceForMap(base: Balance, mapId: MapId): Balance;
  prepareMap?(map: SimMap, balance: Balance): MapRuntime;
  resolveMapChoice(i: MapChoiceInput): MapChoice;
  botNames: readonly string[];
  worldDrop?: boolean;
  maxRooms: number;
  maxConnections: number;
  simHz: number;
  snapshotHz: number;
  inputHz: number;
  /** SEED env: room seeds become mixSeed(SEED, roomSerial). null = random per room. */
  seed: number | null;
  lag?: LagConfig;
  log?: Logger;
  /** Monotonic ms clock (performance.now by default). */
  now?: () => number;
  helloTimeoutMs?: number;
  /** Injected for tests: uniform integer in [0, max). Default crypto.randomInt. */
  randomInt?: (max: number) => number;
  /** Injected for tests: event-loop delay p99 in ms (default: a perf_hooks monitor). */
  loopDelayP99Ms?: () => number;
  /** Start the housekeeping interval (default true). Tests call `poll()` themselves. */
  autoPoll?: boolean;
}

/** What the transport calls into for one socket. */
export interface SessionConnection {
  readonly id: number;
  onMessage(data: string | null): void;
  onClose(): void;
}

export interface ManagerStats {
  ok: true;
  rooms: number;
  connections: number;
  /** Sessions in the browser (hello done, not in a room). */
  browser: number;
  listSubscribers: number;
  loopDelayP99Ms: number;
  loopDelayMaxMs: number;
  perRoom: GameRoomStats[];
}

const LOOP_WINDOW_MS = 10_000;
/**
 * perf_hooks samples the loop with a timer of this period and records the whole period (an idle loop reads about
 * 10 ms), so readings are reported minus it: 0 = no delay.
 */
const LOOP_RESOLUTION_MS = 10;
const loopMs = (ns: number): number => Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS);
const IP_CLEANUP_MS = 60_000;

/** Sliding one-minute counter per key (failed code lookups per IP). */
class MinuteWindow {
  private readonly hits = new Map<string, number[]>();
  count(key: string, now: number): number {
    const arr = this.hits.get(key);
    if (!arr) return 0;
    while (arr.length > 0 && now - (arr[0] as number) > 60_000) arr.shift();
    if (arr.length === 0) this.hits.delete(key);
    return arr.length;
  }
  hit(key: string, now: number): void {
    const arr = this.hits.get(key) ?? [];
    arr.push(now);
    this.hits.set(key, arr);
  }
  cleanup(now: number): void {
    for (const k of [...this.hits.keys()]) this.count(k, now);
  }
}

export class RoomManager implements SessionHost {
  readonly log: Logger;
  private readonly now: () => number;
  private readonly t0: number;
  private readonly lag: LagConfig;
  private readonly randomInt: (max: number) => number;
  private readonly sessions = new Map<number, Session>();
  private nextSessionId = 1;
  private readonly rooms = new Map<RoomId, GameRoom>();
  private readonly byCode = new Map<string, GameRoom>();
  /** code -> monotonic ms until which it may not be reused. */
  private readonly codeCooldown = new Map<string, number>();
  private roomSerial = 0;
  private readonly deps: MatchDeps;
  private readonly prepared = new Map<MapId, { balance: Balance; runtime?: MapRuntime }>();

  // Room list.
  private listRev = 0;
  private published = new Map<RoomId, { summary: RoomSummary; json: string }>();
  private lastListFlush = Number.NEGATIVE_INFINITY;

  // Per-IP limits (brute-force and spam guards; never identity, ADR 0006 §5).
  private readonly createPerIp = new Map<string, RateLimiter>();
  private readonly failedCodes = new MinuteWindow();
  private lastIpCleanup = 0;

  // Event-loop delay.
  private readonly histogram: ELDHistogram | null;
  private lastWindowP99 = 0;
  private lastWindowMax = 0;
  private lastWindowAt = 0;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closedAll = false;

  constructor(private readonly opts: RoomManagerOptions) {
    this.log = opts.log ?? console;
    this.now = opts.now ?? (() => performance.now());
    this.t0 = this.now();
    this.lag = opts.lag ?? NO_LAG;
    this.randomInt = opts.randomInt ?? ((max) => cryptoRandomInt(max));
    this.lastWindowAt = this.t0;
    this.lastIpCleanup = this.t0;
    if (opts.loopDelayP99Ms) this.histogram = null;
    else {
      this.histogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      this.histogram.enable();
    }
    this.deps = {
      createWorld: opts.createWorld,
      getMap: opts.getMap,
      maps: opts.maps,
      pin: opts.pin,
      resolveMapChoice: opts.resolveMapChoice,
      botNames: opts.botNames,
      ...(opts.worldDrop !== undefined ? { worldDrop: opts.worldDrop } : {}),
      prepared: (mapId) => this.preparedFor(mapId),
    };
    if (opts.autoPoll !== false) {
      this.pollTimer = setInterval(() => this.poll(), ROOM_TIMING.pollMs);
      this.pollTimer.unref?.();
    }
  }

  /** Server clock ms (shared by every room; a room's World continues it through timeOriginMs). */
  clock(): number {
    return this.now() - this.t0;
  }

  /** Effective balance and prepared map, built once per map id (ADR 0005 §6). */
  private preparedFor(mapId: MapId): { balance: Balance; runtime?: MapRuntime } {
    let p = this.prepared.get(mapId);
    if (!p) {
      const balance = this.opts.balanceForMap(this.opts.balance, mapId);
      const t = this.now();
      const runtime = this.opts.prepareMap?.(this.opts.getMap(mapId), balance);
      p = runtime ? { balance, runtime } : { balance };
      this.prepared.set(mapId, p);
      this.log.info(`[rooms] prepared map ${mapId} in ${(this.now() - t).toFixed(1)} ms`);
    }
    return p;
  }

  // -------------------------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------------------------
  /** Registers a socket. Returns null (and closes it) at the MAX_CONNECTIONS cap. */
  connect(socket: RoomSocket, ip = 'local'): SessionConnection | null {
    if (this.closedAll || this.sessions.size >= this.opts.maxConnections) {
      this.log.warn(`[rooms] rejecting ${ip}: ${this.sessions.size} connections`);
      socket.close(CLOSE.tryAgain, 'server_full');
      return null;
    }
    const id = this.nextSessionId++;
    const s = new Session(
      id,
      socket,
      ip,
      this,
      this.now,
      this.lag,
      this.opts.inputHz,
      this.opts.helloTimeoutMs ?? 15_000,
    );
    this.sessions.set(id, s);
    return { id, onMessage: (d) => s.onMessage(d), onClose: () => s.onClose() };
  }

  onSessionClose(s: Session): void {
    this.sessions.delete(s.id);
    const room = this.roomOf(s);
    if (room) {
      const left = room.removeMember(s);
      this.log.info(`[rooms] ${s.label} disconnected from ${room.id}`);
      if (left === 0) this.closeRoom(room);
    }
    s.state = 'browser';
  }

  private roomOf(s: Session): GameRoom | null {
    const r = s.room;
    return r instanceof GameRoom && this.rooms.get(r.id) === r ? r : null;
  }

  // -------------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------------
  onSessionMessage(s: Session, msg: ClientMessage): void {
    const now = this.now();
    if (msg.t === 'ping') {
      if (!s.pingLimiter.take(now)) return;
      s.send({ t: 'pong', clientTime: msg.clientTime, serverTime: this.roomOf(s)?.serverNow() ?? this.clock() });
      return;
    }
    if (msg.t === 'join') {
      // Legacy M1/M2a handshake (ADR 0006 §6): a stale cached client gets "please refresh".
      s.fail('bad_version', `server protocol ${PROTOCOL_VERSION} (hello)`);
      return;
    }
    if (msg.t === 'hello') {
      this.handleHello(s, msg.name, msg.protocolVersion, msg.clientToken, msg.caps ?? []);
      return;
    }
    if (s.state === 'new') {
      s.badFrame(`${msg.t} before hello`);
      return;
    }
    switch (msg.t) {
      case 'input': {
        const room = this.roomOf(s);
        if (!room) return; // outside a room: ignored, not a bad frame
        if (!s.inputLimiter.take(now)) {
          s.rejectedInputs++;
          return;
        }
        room.onInput(s, msg.input);
        return;
      }
      case 'resync': {
        const room = this.roomOf(s);
        if (!room || !s.resyncLimiter.take(now)) return;
        room.onResync(s);
        return;
      }
      default:
        this.handleLobby(s, msg, now);
    }
  }

  private handleHello(s: Session, rawName: string, version: number, token: string | undefined, caps: readonly string[]): void {
    if (s.state !== 'new') {
      s.badFrame('second hello');
      return;
    }
    if (version !== PROTOCOL_VERSION) {
      s.fail('bad_version', `server protocol ${PROTOCOL_VERSION}`);
      return;
    }
    const name = sanitizeName(rawName);
    if (name === null) {
      s.fail('bad_name');
      return;
    }
    s.name = name;
    s.token = validClientToken(token) ?? `anon-${s.id}-${this.randomInt(2 ** 30).toString(36)}`;
    s.deltas = caps.includes(CAP_DELTA);
    s.state = 'browser';
    s.clearHelloTimer();
    this.log.info(`[rooms] ${s.label} hello "${name}"`);
    s.send({ t: 'hello', hello: this.serverHello() });
  }

  serverHello(): ServerHello {
    const r = this.opts.rooms;
    return {
      serverTime: this.clock(),
      maps: [...this.opts.maps],
      pinnedMap: this.opts.pin,
      limits: {
        maxRooms: this.opts.maxRooms,
        roomNameMax: r.nameMaxLength,
        maxHumansMin: r.minMaxHumans,
        maxHumansMax: r.maxMaxHumans,
        maxHumansDefault: r.defaultMaxHumans,
        fillBotsDefault: r.fillWithBotsDefault,
      },
    };
  }

  private bucketFor(s: Session, t: LobbyRequest['t']): RateLimiter {
    const b: LobbyBuckets = s.lobby;
    switch (t) {
      case 'listRooms':
        return b.list;
      case 'createRoom':
        return b.create;
      case 'joinRoom':
      case 'leaveRoom':
        return b.join;
      case 'setRoomSettings':
        return b.settings;
      case 'startMatch':
      case 'cancelCountdown':
        return b.start;
      case 'setReady':
      case 'vote':
        return b.toggle;
      case 'kick':
        return b.kick;
    }
  }

  private handleLobby(s: Session, msg: LobbyRequest, now: number): void {
    const bucket = this.bucketFor(s, msg.t);
    if (!bucket.take(now)) {
      s.reject(msg.t, 'rate_limited', msg.rid, bucket.retryAfterMs(now));
      return;
    }
    const room = this.roomOf(s);
    const fail = (code: Parameters<Session['reject']>[1], retryAfterMs?: number): void =>
      s.reject(msg.t, code, msg.rid, retryAfterMs);
    switch (msg.t) {
      case 'listRooms':
        if (room) return fail('already_in_room');
        s.listSubscribed = msg.subscribe;
        if (msg.subscribe) {
          s.send({ t: 'roomList', rev: this.listRev, rooms: [...this.published.values()].map((p) => p.summary) });
        }
        return;
      case 'createRoom':
        if (room) return fail('already_in_room');
        this.createRoom(s, msg.settings, msg.rid, now);
        return;
      case 'joinRoom':
        if (room) return fail('already_in_room');
        this.joinRoom(s, msg, now);
        return;
      case 'leaveRoom':
        if (!room) return fail('not_in_room');
        this.leave(s, 'left');
        return;
    }
    if (!room) return fail('not_in_room');
    let code: ReturnType<GameRoom['startMatch']> = null;
    switch (msg.t) {
      case 'setRoomSettings':
        code = room.setSettings(s, msg.settings);
        break;
      case 'startMatch':
        code = room.startMatch(s);
        break;
      case 'cancelCountdown':
        code = room.cancelCountdown(s);
        break;
      case 'setReady':
        code = room.setReady(s, msg.ready);
        break;
      case 'vote':
        code = room.vote(s, msg.choice);
        break;
      case 'kick':
        code = room.kick(s, msg.memberId);
        break;
    }
    if (code !== null) fail(code);
  }

  private defaultSettings(): RoomSettings {
    const r = this.opts.rooms;
    return { name: null, visibility: 'public', mapMode: 'vote', maxHumans: r.defaultMaxHumans, fillBots: r.fillWithBotsDefault };
  }

  private createRoom(s: Session, patch: Partial<RoomSettings>, rid: number | undefined, now: number): void {
    let ipLimiter = this.createPerIp.get(s.ip);
    if (!ipLimiter) {
      const perMin = LOBBY_LIMITS.createPerIpPerMin;
      ipLimiter = new RateLimiter(perMin / 60, perMin, now);
      this.createPerIp.set(s.ip, ipLimiter);
    }
    if (!ipLimiter.take(now)) {
      s.reject('createRoom', 'rate_limited', rid, ipLimiter.retryAfterMs(now));
      return;
    }
    if (this.rooms.size >= this.opts.maxRooms) {
      s.reject('createRoom', 'max_rooms', rid);
      return;
    }
    if (this.loopDelayP99Ms() > ROOM_TIMING.busyLoopDelayP99Ms) {
      s.reject('createRoom', 'server_busy', rid);
      return;
    }
    const settings = applySettings(this.defaultSettings(), patch, this.opts.rooms, this.opts.maps, 1);
    if (!settings) {
      s.reject('createRoom', 'bad_settings', rid);
      return;
    }
    const code = this.newCode(now);
    if (code === null) {
      s.reject('createRoom', 'server_busy', rid);
      return;
    }
    const serial = ++this.roomSerial;
    const seed = this.opts.seed !== null ? mixSeed(this.opts.seed, serial) : this.randomInt(2 ** 32);
    const room = new GameRoom({
      id: `r${serial}`,
      code,
      seed,
      settings,
      balance: this.opts.balance,
      rooms: this.opts.rooms,
      lockSeconds: this.opts.lockSeconds,
      deps: this.deps,
      simHz: this.opts.simHz,
      snapshotHz: this.opts.snapshotHz,
      now: this.now,
      clock: () => this.clock(),
      log: this.log,
      evict: (victim, reason) => this.leave(victim, reason),
    });
    this.rooms.set(room.id, room);
    this.byCode.set(code, room);
    this.log.info(`[rooms] ${s.label} created ${room.id} (${settings.visibility}, ${settings.mapMode})`);
    this.enter(s, room, rid);
  }

  private joinRoom(s: Session, msg: Extract<LobbyRequest, { t: 'joinRoom' }>, now: number): void {
    let room: GameRoom | undefined;
    if ('roomId' in msg) {
      room = this.rooms.get(msg.roomId);
      if (!room) {
        s.reject('joinRoom', 'room_not_found', msg.rid);
        return;
      }
    } else {
      if (this.failedCodes.count(s.ip, now) >= LOBBY_LIMITS.failedCodesPerIpPerMin) {
        s.reject('joinRoom', 'rate_limited', msg.rid, 60_000);
        return;
      }
      const code = normalizeRoomCode(msg.code);
      if (code === null) {
        this.failedCodes.hit(s.ip, now);
        s.reject('joinRoom', 'bad_code', msg.rid);
        return;
      }
      room = this.byCode.get(code);
      if (!room) {
        this.failedCodes.hit(s.ip, now);
        s.reject('joinRoom', 'room_not_found', msg.rid);
        return;
      }
    }
    const block = room.joinBlock(s.token);
    if (block) {
      s.reject('joinRoom', block, msg.rid);
      return;
    }
    this.enter(s, room, msg.rid);
  }

  private enter(s: Session, room: GameRoom, rid: number | undefined): void {
    s.listSubscribed = false; // the list goes to the browser only
    s.state = 'room';
    room.addMember(s, rid);
  }

  /** Leave, kick: the member goes back to the browser. */
  private leave(s: Session, reason: 'left' | 'kicked'): void {
    const room = this.roomOf(s);
    if (!room) return;
    const left = room.removeMember(s);
    s.state = 'browser';
    s.send({ t: 'roomLeft', reason });
    this.log.info(`[rooms] ${s.label} ${reason} ${room.id}`);
    if (left === 0) this.closeRoom(room);
  }

  private closeRoom(room: GameRoom): void {
    room.dispose();
    this.rooms.delete(room.id);
    if (this.byCode.get(room.code) === room) this.byCode.delete(room.code);
    this.codeCooldown.set(room.code, this.now() + ROOM_TIMING.codeReuseCooldownMs);
    this.log.info(`[rooms] closed ${room.id}`);
  }

  /** A fresh code: not used by an open room, nor by one closed in the last 10 minutes. null after 20 tries. */
  private newCode(now: number): string | null {
    for (const [c, until] of this.codeCooldown) if (until <= now) this.codeCooldown.delete(c);
    for (let attempt = 0; attempt < ROOM_TIMING.codeAttempts; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[this.randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.byCode.has(code) && !this.codeCooldown.has(code)) return code;
    }
    this.log.warn('[rooms] could not find a free room code');
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------------------------
  /** Every ROOM_TIMING.pollMs: room timers and coalesced broadcasts, the list flush, the loop-delay window. */
  poll(): void {
    if (this.closedAll) return;
    const now = this.now();
    for (const room of [...this.rooms.values()]) room.poll();
    if (now - this.lastListFlush >= ROOM_TIMING.listFlushMs) this.flushList(now);
    if (this.histogram && now - this.lastWindowAt >= LOOP_WINDOW_MS) {
      this.lastWindowP99 = this.histogram.count > 0 ? loopMs(this.histogram.percentile(99)) : 0;
      this.lastWindowMax = this.histogram.count > 0 ? loopMs(this.histogram.max) : 0;
      this.histogram.reset();
      this.lastWindowAt = now;
    }
    if (now - this.lastIpCleanup >= IP_CLEANUP_MS) {
      this.lastIpCleanup = now;
      this.failedCodes.cleanup(now);
      for (const [ip, lim] of this.createPerIp) if (lim.retryAfterMs(now) === 0 && lim.full(now)) this.createPerIp.delete(ip);
    }
  }

  /** Batched room-list delta, encoded once and shared by every subscriber (ADR 0006 §6). Public rooms only. */
  flushList(now = this.now()): void {
    this.lastListFlush = now;
    const current = new Map<RoomId, { summary: RoomSummary; json: string }>();
    for (const room of this.rooms.values()) {
      if (room.settings.visibility !== 'public') continue;
      const summary = room.summary();
      current.set(room.id, { summary, json: JSON.stringify(summary) });
    }
    const upsert: RoomSummary[] = [];
    const remove: RoomId[] = [];
    for (const [id, cur] of current) if (this.published.get(id)?.json !== cur.json) upsert.push(cur.summary);
    for (const id of this.published.keys()) if (!current.has(id)) remove.push(id);
    if (upsert.length === 0 && remove.length === 0) return;
    const from = this.listRev;
    this.listRev++;
    this.published = current;
    let data: string | null = null;
    for (const s of this.sessions.values()) {
      if (!s.listSubscribed || s.state !== 'browser') continue;
      data ??= encode({ t: 'roomListDelta', from, rev: this.listRev, upsert, remove });
      s.sendRaw(data);
    }
  }

  loopDelayP99Ms(): number {
    if (this.opts.loopDelayP99Ms) return this.opts.loopDelayP99Ms();
    const h = this.histogram;
    const cur = h && h.count > 0 ? loopMs(h.percentile(99)) : 0;
    return Math.max(cur, this.lastWindowP99);
  }

  private loopDelayMaxMs(): number {
    const h = this.histogram;
    const cur = h && h.count > 0 ? loopMs(h.max) : 0;
    return Math.max(cur, this.lastWindowMax);
  }

  /** Graceful shutdown: members get `roomLeft closed`, then every socket closes with 1001. */
  closeAll(): void {
    if (this.closedAll) return;
    for (const room of [...this.rooms.values()]) {
      for (const s of room.sessions()) {
        s.send({ t: 'roomLeft', reason: 'closed' });
        room.removeMember(s);
        s.state = 'browser';
      }
      this.closeRoom(room);
    }
    this.closedAll = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.histogram?.disable();
    for (const s of [...this.sessions.values()]) {
      s.closeNow(CLOSE.goingAway, 'server_shutdown');
      s.onClose();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Introspection (healthz, tests, tools)
  // -------------------------------------------------------------------------------------------
  stats(): ManagerStats {
    let browser = 0;
    let subs = 0;
    for (const s of this.sessions.values()) {
      if (s.state === 'browser') browser++;
      if (s.listSubscribed) subs++;
    }
    return {
      ok: true,
      rooms: this.rooms.size,
      connections: this.sessions.size,
      browser,
      listSubscribers: subs,
      loopDelayP99Ms: round2(this.loopDelayP99Ms()),
      loopDelayMaxMs: round2(this.loopDelayMaxMs()),
      perRoom: [...this.rooms.values()].map((r) => {
        const st = r.stats();
        return { ...st, avgTickMs: round2(st.avgTickMs), maxTickMs: round2(st.maxTickMs), matchAvgTickMs: round2(st.matchAvgTickMs), matchMaxTickMs: round2(st.matchMaxTickMs) };
      }),
    };
  }

  room(id: RoomId): GameRoom | undefined {
    return this.rooms.get(id);
  }

  roomList(): GameRoom[] {
    return [...this.rooms.values()];
  }

  session(id: number): Session | undefined {
    return this.sessions.get(id);
  }

  seatStats(sessionId: number): SeatStats | null {
    const s = this.sessions.get(sessionId);
    const room = s ? this.roomOf(s) : null;
    return s && room ? room.seatStats(s) : null;
  }
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
