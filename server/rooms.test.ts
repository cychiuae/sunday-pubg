/**
 * RoomManager + GameRoom + Session with fake sockets, a fake clock and a scripted World (NETCODE.md R7 "RoomManager
 * with fake sockets and fake timers"), plus the M1 Room match-path tests ported to rooms (jitter buffer, private
 * events, slow clients, the fixed-step loop, simulated lag).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE, type RoomsBalance } from '../src/shared/balance';
import { MAX_QUEUED_INPUTS, PROTOCOL_VERSION } from '../src/shared/constants';
import { CAP_DELTA } from '../src/shared/protocol/delta';
import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from '../src/shared/protocol/messages';
import { makeInput, makeLocal, makeMatch, makePlayer, makeSnapshot } from '../src/shared/protocol/testing';
import { resolveMapChoice } from '../src/shared/sim/mapVote';
import {
  ROOM_CODE_ALPHABET,
  type MatchPhase,
  type MatchState,
  type PlayerId,
  type PlayerInput,
  type RoomState,
  type RoomSummary,
  type SimEvent,
  type WorldSnapshot,
} from '../src/shared/types';
import { SILENT_LOGGER, type Logger, type RoomSocket, type SimMap, type SimWorld, type WorldFactoryOptions } from './common';
import { RoomManager, type RoomManagerOptions, type SessionConnection } from './RoomManager';

const ROOMS = BALANCE.rooms as RoomsBalance;
const LOCK_MS = (BALANCE.match.mapVoteLockSeconds ?? 3) * 1000;
const COUNTDOWN_MS = BALANCE.match.countdownSeconds * 1000;

class FakeWorld implements SimWorld {
  tick = 0;
  timeMs: number;
  readonly map: SimMap;
  finished = false;
  phase: MatchPhase = 'countdown';
  humans = new Map<PlayerId, string>();
  /** Added before 'playing' (spectators added later get local = null, like the real World). */
  participants = new Set<PlayerId>();
  removed: PlayerId[] = [];
  applied: [PlayerId, PlayerInput][] = [];
  nextId = 1;
  lootVersion = 1;
  queuedEvents: SimEvent[] = [];
  throwOnStep = false;
  constructor(readonly opts: WorldFactoryOptions) {
    this.timeMs = opts.timeOriginMs ?? 0;
    this.map = opts.map;
  }
  addPlayer(name: string): PlayerId | null {
    const id = this.nextId++;
    this.humans.set(id, name);
    if (this.phase === 'countdown') this.participants.add(id);
    return id;
  }
  removePlayer(id: PlayerId): void {
    this.humans.delete(id);
    this.removed.push(id);
  }
  applyInput(id: PlayerId, input: PlayerInput): void {
    this.applied.push([id, input]);
  }
  step(dt: number): SimEvent[] {
    if (this.throwOnStep) throw new Error('sim bug');
    this.tick++;
    this.timeMs = (this.opts.timeOriginMs ?? 0) + this.tick * dt * 1000;
    const ev = this.queuedEvents;
    this.queuedEvents = [];
    return ev;
  }
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot {
    return makeSnapshot(this.tick, [makePlayer(viewerId ?? 0)], {
      serverTime: this.timeMs,
      lootVersion: this.lootVersion,
      match: this.getMatch(),
      local: viewerId !== null && this.phase === 'playing' && this.participants.has(viewerId) ? makeLocal(viewerId) : null,
    });
  }
  getMatch(): MatchState {
    return makeMatch({ phase: this.phase, matchId: this.opts.matchStart?.matchId ?? 1, mapId: this.map.id });
  }
}

class FakeSocket implements RoomSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    const m = decodeServerMessage(data);
    if (!m) throw new Error(`server sent an invalid frame: ${data.slice(0, 300)}`);
    this.sent.push(m);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    return this.of(t).at(-1);
  }
}

interface Client {
  sock: FakeSocket;
  conn: SessionConnection;
  send(msg: ClientMessage | string): void;
  /** The latest room state this client saw (roomJoined or room). */
  room(): RoomState | undefined;
  rejects(): Extract<ServerMessage, { t: 'reject' }>[];
}

let clock = 0;
let worlds: FakeWorld[] = [];
let busy = 0;
let rand: () => number = Math.random;

function makeManager(over: Partial<RoomManagerOptions> = {}): RoomManager {
  return new RoomManager({
    balance: BALANCE,
    rooms: ROOMS,
    lockSeconds: LOCK_MS / 1000,
    createWorld: (o) => {
      const w = new FakeWorld(o);
      worlds.push(w);
      return w;
    },
    getMap: (id) => ({ id }) as SimMap,
    maps: ['island01', 'office'],
    pin: null,
    balanceForMap: (b) => b,
    resolveMapChoice,
    botNames: ['Bot'],
    maxRooms: 3,
    maxConnections: 40,
    simHz: 30,
    snapshotHz: 20,
    inputHz: 30,
    seed: 7,
    log: SILENT_LOGGER,
    now: () => clock,
    randomInt: (max) => Math.floor(rand() * max),
    loopDelayP99Ms: () => busy,
    autoPoll: false,
    ...over,
  });
}

let token = 0;
function connect(mgr: RoomManager, ip = '10.0.0.1'): Client {
  const sock = new FakeSocket();
  const conn = mgr.connect(sock, ip)!;
  return {
    sock,
    conn,
    send: (msg) => conn.onMessage(typeof msg === 'string' ? msg : encode(msg)),
    room: () => {
      for (let i = sock.sent.length - 1; i >= 0; i--) {
        const m = sock.sent[i]!;
        if (m.t === 'room' || m.t === 'roomJoined') return m.room;
        if (m.t === 'roomLeft') return undefined;
      }
      return undefined;
    },
    rejects: () => sock.of('reject'),
  };
}

function hello(mgr: RoomManager, name = 'Coco', opts: { ip?: string; token?: string | null; deltas?: boolean } = {}): Client {
  const c = connect(mgr, opts.ip);
  const t = opts.token === undefined ? `token-${String(++token).padStart(16, '0')}` : opts.token;
  c.send({
    t: 'hello',
    name,
    protocolVersion: PROTOCOL_VERSION,
    ...(t !== null ? { clientToken: t } : {}),
    ...(opts.deltas ? { caps: [CAP_DELTA] } : {}),
  });
  return c;
}

function create(mgr: RoomManager, name = 'Host', settings: Record<string, unknown> = {}, ip?: string): Client & { code: string; id: string } {
  const c = hello(mgr, name, { ip });
  c.send({ t: 'createRoom', settings, rid: 1 } as ClientMessage);
  const joined = c.sock.last('roomJoined');
  if (!joined) throw new Error(`create failed: ${JSON.stringify(c.rejects())}`);
  return Object.assign(c, { code: joined.room.code, id: joined.room.id });
}

function join(mgr: RoomManager, code: string, name = 'Guest', opts: { ip?: string; token?: string | null } = {}): Client {
  const c = hello(mgr, name, opts);
  c.send({ t: 'joinRoom', code, rid: 2 });
  return c;
}

/** Advances the fake clock in poll steps (the manager's housekeeping interval). */
function advance(mgr: RoomManager, ms: number, step = 100): void {
  for (let t = 0; t < ms; t += step) {
    clock += Math.min(step, ms - t);
    mgr.poll();
  }
}

const roomOf = (mgr: RoomManager, id: string) => mgr.room(id)!;

beforeEach(() => {
  clock = 0;
  worlds = [];
  busy = 0;
  let s = 12345;
  rand = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => vi.useRealTimers());

// =============================================================================================
describe('hello and the session edge', () => {
  it('answers hello with the maps, the pin and the limits', () => {
    const mgr = makeManager();
    const c = hello(mgr);
    expect(c.sock.of('hello')).toEqual([
      {
        t: 'hello',
        hello: {
          serverTime: 0,
          maps: ['island01', 'office'],
          pinnedMap: null,
          limits: {
            maxRooms: 3,
            roomNameMax: ROOMS.nameMaxLength,
            maxHumansMin: ROOMS.minMaxHumans,
            maxHumansMax: ROOMS.maxMaxHumans,
            maxHumansDefault: ROOMS.defaultMaxHumans,
            fillBotsDefault: ROOMS.fillWithBotsDefault,
          },
        },
      },
    ]);
  });

  it('a legacy join gets error bad_version and the socket closes (ADR 0006 §6)', () => {
    const mgr = makeManager();
    const c = connect(mgr);
    c.send({ t: 'join', name: 'Old', protocolVersion: 2 });
    expect(c.sock.of('error')[0]?.code).toBe('bad_version');
    expect(c.sock.closed?.code).toBe(1008);
  });

  it.each([
    ['bad_version', { t: 'hello', name: 'A', protocolVersion: PROTOCOL_VERSION + 1 }],
    ['bad_name', { t: 'hello', name: '   ', protocolVersion: PROTOCOL_VERSION }],
    ['bad_name', { t: 'hello', name: 'x'.repeat(40), protocolVersion: PROTOCOL_VERSION }],
  ])('rejects hello with %s and closes', (code, msg) => {
    const mgr = makeManager();
    const c = connect(mgr);
    c.send(JSON.stringify(msg));
    expect(c.sock.of('error')[0]?.code).toBe(code);
    expect(c.sock.closed?.code).toBe(1008);
  });

  it('before hello only ping is accepted; lobby requests and inputs are bad frames', () => {
    const mgr = makeManager();
    const c = connect(mgr);
    c.send({ t: 'ping', clientTime: 5 });
    expect(c.sock.of('pong')).toEqual([{ t: 'pong', clientTime: 5, serverTime: 0 }]);
    for (let i = 0; i < 5; i++) c.send({ t: 'listRooms', subscribe: true });
    expect(c.sock.closed).toBeNull();
    c.send({ t: 'input', input: makeInput({ seq: 1 }) });
    expect(c.sock.of('error')[0]?.code).toBe('bad_message');
    expect(c.sock.of('roomList')).toHaveLength(0);
  });

  it('a second hello is a bad frame, not a second identity', () => {
    const mgr = makeManager();
    const c = hello(mgr, 'A');
    c.send({ t: 'hello', name: 'B', protocolVersion: PROTOCOL_VERSION });
    expect(c.sock.of('hello')).toHaveLength(1);
    expect(mgr.session(c.conn.id)!.name).toBe('A');
  });

  it('closes sockets that never say hello, and caps connections at MAX_CONNECTIONS', () => {
    const mgr = makeManager({ maxConnections: 2, helloTimeoutMs: 5000 });
    const a = connect(mgr);
    hello(mgr);
    const s = new FakeSocket();
    expect(mgr.connect(s, 'x')).toBeNull();
    expect(s.closed?.code).toBe(1013);
    vi.advanceTimersByTime(5001);
    expect(a.sock.closed?.reason).toBe('hello_timeout');
  });

  it('a malformed client token makes the session anonymous (not a bad frame)', () => {
    const mgr = makeManager();
    const c = hello(mgr, 'A', { token: 'short!' });
    expect(c.sock.closed).toBeNull();
    expect(mgr.session(c.conn.id)!.token).toMatch(/^anon-/);
    const ok = hello(mgr, 'B', { token: 'abcdefghijklmnop_-12' });
    expect(mgr.session(ok.conn.id)!.token).toBe('abcdefghijklmnop_-12');
  });

  it('closes after more than 5 bad frames in a second; spread-out bad frames are tolerated', () => {
    const mgr = makeManager();
    const a = hello(mgr, 'A');
    for (let i = 0; i < 20; i++) {
      clock += 300;
      a.send('x'.repeat(5000));
    }
    expect(a.sock.closed).toBeNull();
    clock += 2000;
    for (let i = 0; i < 5; i++) a.send('garbage');
    expect(a.sock.closed).toBeNull();
    a.conn.onMessage(null);
    expect(a.sock.of('error')[0]?.code).toBe('bad_message');
  });
});

// =============================================================================================
describe('rooms: create, join, list, limits', () => {
  it('create: the creator is host; defaults from the rooms balance; a code from the alphabet; rid echoed', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const j = h.sock.last('roomJoined')!;
    expect(j.rid).toBe(1);
    expect(j.memberId).toBe(1);
    expect(j.room.hostId).toBe(1);
    expect(j.room.hostName).toBe('Host');
    expect(j.room.settings).toEqual({
      name: null,
      visibility: 'public',
      mapMode: 'vote',
      maxHumans: ROOMS.defaultMaxHumans,
      fillBots: ROOMS.fillWithBotsDefault,
    });
    expect(j.room.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{5}$`));
    expect(j.room.phase).toBe('waiting');
    expect(j.room.votes?.map((v) => v.option)).toEqual(['island01', 'office', 'random']);
    expect(j.room.botSeats).toBe(BALANCE.match.targetPlayers - 1);
  });

  it.each([
    [{ maxHumans: 0 }],
    [{ maxHumans: ROOMS.maxMaxHumans + 1 }],
    [{ mapMode: 'moon' }],
  ])('create with %j gets bad_settings', (settings) => {
    const mgr = makeManager();
    const c = hello(mgr);
    c.send({ t: 'createRoom', settings, rid: 9 } as ClientMessage);
    expect(c.rejects()).toEqual([{ t: 'reject', rid: 9, req: 'createRoom', code: 'bad_settings' }]);
  });

  it('room names are sanitised and capped; an empty name becomes null', () => {
    const mgr = makeManager();
    const a = create(mgr, 'A', { name: `  Big​   ${'x'.repeat(40)}` });
    expect(a.room()!.settings.name).toBe(`Big ${'x'.repeat(ROOMS.nameMaxLength - 4)}`);
    const b = create(mgr, 'B', { name: ' ​ ' });
    expect(b.room()!.settings.name).toBeNull();
  });

  it('join by id and by code (case-insensitive, dashes and spaces ignored); bad codes and unknown rooms reject', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const byCode = join(mgr, `${h.code.slice(0, 2).toLowerCase()}-${h.code.slice(2)} `);
    expect(byCode.sock.last('roomJoined')?.memberId).toBe(2);
    const byId = hello(mgr, 'Third');
    byId.send({ t: 'joinRoom', roomId: h.id, rid: 4 });
    expect(byId.sock.last('roomJoined')).toMatchObject({ rid: 4, memberId: 3 });
    const bad = join(mgr, 'OOOOO');
    expect(bad.rejects()[0]).toMatchObject({ code: 'bad_code', rid: 2 });
    const missing = join(mgr, 'ZZZZZ');
    expect(missing.rejects()[0]?.code).toBe('room_not_found');
    const missingId = hello(mgr);
    missingId.send({ t: 'joinRoom', roomId: 'r99' });
    expect(missingId.rejects()[0]?.code).toBe('room_not_found');
    advance(mgr, 300);
    expect(h.room()!.members.map((m) => m.name)).toEqual(['Host', 'Guest', 'Third']);
  });

  it('failed code lookups are limited to 20 per minute per IP (a brute-force guard)', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const guesser = hello(mgr, 'G', { ip: '1.2.3.4' });
    for (let i = 0; i < 25; i++) {
      clock += 600; // under the session bucket
      guesser.send({ t: 'joinRoom', code: 'ZZZZZ' });
    }
    const codes = guesser.rejects().map((r) => r.code);
    expect(codes.filter((c) => c === 'room_not_found')).toHaveLength(20);
    expect(codes.at(-1)).toBe('rate_limited');
    // Even the right code is refused until the window passes; another IP is unaffected.
    guesser.send({ t: 'joinRoom', code: h.code });
    expect(guesser.rejects().at(-1)?.code).toBe('rate_limited');
    expect(join(mgr, h.code, 'Other', { ip: '5.6.7.8' }).sock.of('roomJoined')).toHaveLength(1);
    clock += 61_000;
    guesser.send({ t: 'joinRoom', code: h.code });
    expect(guesser.sock.of('roomJoined')).toHaveLength(1);
  });

  it('already_in_room and not_in_room', () => {
    const mgr = makeManager();
    const h = create(mgr);
    h.send({ t: 'createRoom', settings: {}, rid: 3 });
    h.send({ t: 'listRooms', subscribe: true, rid: 4 });
    expect(h.rejects().map((r) => [r.req, r.code])).toEqual([
      ['createRoom', 'already_in_room'],
      ['listRooms', 'already_in_room'],
    ]);
    const b = hello(mgr);
    for (const msg of [
      { t: 'leaveRoom' }, { t: 'startMatch' }, { t: 'setReady', ready: true }, { t: 'vote', choice: 'office' },
      { t: 'kick', memberId: 1 }, { t: 'setRoomSettings', settings: {} }, { t: 'cancelCountdown' },
    ]) {
      b.send(msg as ClientMessage);
    }
    expect(b.rejects().every((r) => r.code === 'not_in_room')).toBe(true);
    expect(b.rejects()).toHaveLength(7);
  });

  it('room_full, max_rooms and server_busy', () => {
    const mgr = makeManager({ maxRooms: 2 });
    const h = create(mgr, 'H', { maxHumans: 2 });
    join(mgr, h.code);
    expect(join(mgr, h.code).rejects()[0]?.code).toBe('room_full');
    create(mgr, 'H2');
    const third = hello(mgr);
    third.send({ t: 'createRoom', settings: {} });
    expect(third.rejects()[0]?.code).toBe('max_rooms');
    const mgr2 = makeManager();
    busy = 25;
    const c = hello(mgr2);
    c.send({ t: 'createRoom', settings: {} });
    expect(c.rejects()[0]?.code).toBe('server_busy');
  });

  it('createRoom is rate-limited per session (burst 2, then 1 per 10 s) with retryAfterMs', () => {
    const mgr = makeManager();
    const c = hello(mgr);
    c.send({ t: 'createRoom', settings: {}, rid: 1 });
    c.send({ t: 'leaveRoom' });
    c.send({ t: 'createRoom', settings: {}, rid: 2 });
    c.send({ t: 'leaveRoom' });
    c.send({ t: 'createRoom', settings: {}, rid: 3 });
    const r = c.rejects().at(-1)!;
    expect(r).toMatchObject({ req: 'createRoom', code: 'rate_limited', rid: 3 });
    expect(r.retryAfterMs).toBeGreaterThan(9000);
    expect(r.retryAfterMs).toBeLessThanOrEqual(10_000);
    clock += 10_000;
    c.send({ t: 'createRoom', settings: {}, rid: 4 });
    expect(c.sock.last('roomJoined')?.rid).toBe(4);
  });

  it('the room closes when its last member leaves, and its code is not reused for 10 minutes', () => {
    rand = () => 0; // every code is "22222"
    const mgr = makeManager();
    const h = create(mgr);
    expect(h.code).toBe('22222');
    const g = join(mgr, h.code);
    h.send({ t: 'leaveRoom' });
    expect(h.sock.last('roomLeft')).toEqual({ t: 'roomLeft', reason: 'left' });
    expect(mgr.stats().rooms).toBe(1);
    g.conn.onClose(); // disconnect = leave
    expect(mgr.stats().rooms).toBe(0);
    expect(join(mgr, '22222').rejects()[0]?.code).toBe('room_not_found');
    const again = hello(mgr);
    again.send({ t: 'createRoom', settings: {} });
    expect(again.rejects()[0]?.code).toBe('server_busy'); // the only code is cooling down
    clock += 10 * 60_000 + 1;
    again.send({ t: 'createRoom', settings: {} });
    expect(again.sock.last('roomJoined')?.room.code).toBe('22222');
  });

  it('private rooms never appear in the list; list deltas go to subscribed browser sessions only', () => {
    const mgr = makeManager();
    const watcher = hello(mgr, 'W');
    watcher.send({ t: 'listRooms', subscribe: true });
    expect(watcher.sock.last('roomList')).toEqual({ t: 'roomList', rev: 0, rooms: [] });
    const notSubscribed = hello(mgr, 'N');
    const pub = create(mgr, 'Pub');
    const priv = create(mgr, 'Priv', { visibility: 'private' });
    advance(mgr, 500);
    const d = watcher.sock.last('roomListDelta')!;
    expect(d.from).toBe(0);
    expect(d.rev).toBe(1);
    expect(d.upsert.map((s) => s.id)).toEqual([pub.id]);
    expect(JSON.stringify(d)).not.toContain(pub.code);
    expect(JSON.stringify(watcher.sock.sent)).not.toContain(priv.id);
    expect(notSubscribed.sock.of('roomListDelta')).toHaveLength(0);
    // Entering a room unsubscribes.
    watcher.send({ t: 'joinRoom', roomId: pub.id });
    const before = watcher.sock.of('roomListDelta').length;
    create(mgr, 'Pub2');
    advance(mgr, 600);
    expect(watcher.sock.of('roomListDelta')).toHaveLength(before);
    // Switching a room to private removes it from the list.
    const w2 = hello(mgr, 'W2');
    w2.send({ t: 'listRooms', subscribe: true });
    expect(w2.sock.last('roomList')!.rooms.map((r) => r.id).sort()).toEqual([pub.id, 'r3'].sort());
    pub.send({ t: 'setRoomSettings', settings: { visibility: 'private' } });
    advance(mgr, 600);
    expect(w2.sock.last('roomListDelta')!.remove).toEqual([pub.id]);
  });

  it('property: a subscriber rebuilding the list from roomList + deltas equals the public list after every flush', () => {
    const mgr = makeManager({ maxRooms: 6, maxConnections: 1000 });
    const watcher = hello(mgr, 'W');
    watcher.send({ t: 'listRooms', subscribe: true });
    const rebuilt = new Map<string, RoomSummary>();
    let rev = watcher.sock.last('roomList')!.rev;
    let seen = watcher.sock.sent.length;
    const members: (Client & { inRoom: string | null })[] = [];
    for (let step = 0; step < 300; step++) {
      const r = rand();
      if (r < 0.25 || members.length === 0) {
        const c = Object.assign(hello(mgr, `P${step}`, { ip: `10.0.${step % 200}.1` }), { inRoom: null as string | null });
        c.send({ t: 'createRoom', settings: { visibility: rand() < 0.3 ? 'private' : 'public' } });
        c.inRoom = c.sock.last('roomJoined')?.room.id ?? null;
        members.push(c);
      } else {
        const c = members[Math.floor(rand() * members.length)]!;
        const open = mgr.roomList();
        if (c.inRoom === null && open.length > 0) {
          clock += 600;
          c.send({ t: 'joinRoom', roomId: open[Math.floor(rand() * open.length)]!.id });
          const j = c.sock.last('roomJoined');
          if (j && c.sock.sent.at(-1) === j) c.inRoom = j.room.id;
        } else if (c.inRoom !== null && r < 0.6) {
          clock += 600;
          c.send({ t: 'leaveRoom' });
          c.inRoom = null;
        } else if (c.inRoom !== null && r < 0.75) {
          c.send({ t: 'setRoomSettings', settings: { maxHumans: 2 + Math.floor(rand() * 10) } });
        } else if (c.inRoom !== null) {
          c.conn.onClose();
          c.inRoom = null;
          members.splice(members.indexOf(c), 1);
        }
      }
      advance(mgr, 100 + Math.floor(rand() * 600));
      for (const m of watcher.sock.sent.slice(seen)) {
        if (m.t !== 'roomListDelta') continue;
        expect(m.from).toBe(rev);
        for (const id of m.remove) rebuilt.delete(id);
        for (const s of m.upsert) rebuilt.set(s.id, s);
        rev = m.rev;
      }
      seen = watcher.sock.sent.length;
      mgr.flushList();
      for (const m of watcher.sock.sent.slice(seen)) {
        if (m.t !== 'roomListDelta') continue;
        for (const id of m.remove) rebuilt.delete(id);
        for (const s of m.upsert) rebuilt.set(s.id, s);
        rev = m.rev;
      }
      seen = watcher.sock.sent.length;
      const expected = mgr
        .roomList()
        .filter((g) => g.settings.visibility === 'public')
        .map((g) => g.summary());
      expect([...rebuilt.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        expected.sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
  });
});

// =============================================================================================
describe('rooms: host, settings, kick', () => {
  it('host-only requests get not_host', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const g = join(mgr, h.code);
    g.send({ t: 'setRoomSettings', settings: { fillBots: false } });
    g.send({ t: 'startMatch' });
    g.send({ t: 'kick', memberId: 1 });
    g.send({ t: 'cancelCountdown' });
    expect(g.rejects().map((r) => r.code)).toEqual(['not_host', 'not_host', 'not_host', 'not_host']);
  });

  it('settings: waiting phase only; maxHumans not below the member count; changes broadcast (coalesced)', () => {
    const mgr = makeManager();
    const h = create(mgr);
    join(mgr, h.code);
    const g2 = join(mgr, h.code);
    h.send({ t: 'setRoomSettings', settings: { maxHumans: 2 } });
    expect(h.rejects().at(-1)?.code).toBe('bad_settings');
    h.send({ t: 'setRoomSettings', settings: { maxHumans: 3, mapMode: 'office', name: 'Lunch' } });
    advance(mgr, 200);
    expect(g2.room()!.settings).toMatchObject({ maxHumans: 3, mapMode: 'office', name: 'Lunch' });
    expect(g2.room()!.votes).toBeNull();
    // Toggle spam is coalesced to at most 5 room broadcasts per second.
    const before = g2.sock.of('room').length;
    for (let i = 0; i < 20; i++) {
      clock += 50;
      h.send({ t: 'setRoomSettings', settings: { fillBots: i % 2 === 0 } });
      mgr.poll();
    }
    expect(g2.sock.of('room').length - before).toBeLessThanOrEqual(6);
    clock += 3000; // past the settings bucket
    h.send({ t: 'startMatch' });
    h.send({ t: 'setRoomSettings', settings: { maxHumans: 4 } });
    expect(h.rejects().at(-1)?.code).toBe('bad_state');
  });

  it('host migration to the oldest remaining member (ties: lower memberId) in waiting, countdown and mid-match', () => {
    const mgr = makeManager();
    const h = create(mgr, 'H');
    clock += 10;
    const a = join(mgr, h.code, 'A');
    const b = join(mgr, h.code, 'B'); // same joinedAt as A? no: clock moved before A only
    clock += 10;
    const c = join(mgr, h.code, 'C');
    // Waiting.
    h.send({ t: 'leaveRoom' });
    advance(mgr, 200);
    expect(a.room()!.hostId).toBe(2);
    expect(a.room()!.hostName).toBe('A');
    // Countdown.
    a.send({ t: 'startMatch' });
    a.conn.onClose();
    advance(mgr, 200);
    expect(b.room()!.phase).toBe('countdown');
    expect(b.room()!.hostId).toBe(3); // B joined with A at the same ms; A is gone, B (lower id than C) is oldest
    // Mid-match.
    advance(mgr, COUNTDOWN_MS);
    worlds[0]!.phase = 'playing';
    roomOf(mgr, h.id).tickOnce();
    const bPid = b.sock.last('welcome')!.welcome.playerId;
    b.send({ t: 'leaveRoom' });
    advance(mgr, 200);
    expect(c.room()!.phase).toBe('playing');
    expect(c.room()!.hostId).toBe(4);
    expect(worlds[0]!.removed).toEqual([bPid]); // B's World player removed
  });

  it('kick: back to the browser, the same client token cannot rejoin for kickRejoinBlockSeconds', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const g = join(mgr, h.code, 'G', { token: 'kicked-token-000000' });
    h.send({ t: 'kick', memberId: 1 });
    expect(h.rejects().at(-1)?.code).toBe('bad_state'); // not yourself
    h.send({ t: 'kick', memberId: 2 });
    expect(g.sock.last('roomLeft')).toEqual({ t: 'roomLeft', reason: 'kicked' });
    expect(mgr.session(g.conn.id)!.state).toBe('browser');
    g.send({ t: 'joinRoom', code: h.code });
    expect(g.rejects().at(-1)?.code).toBe('kicked');
    // A reconnect with the same token is blocked too (it is per browser, never per IP).
    expect(join(mgr, h.code, 'G2', { token: 'kicked-token-000000' }).rejects()[0]?.code).toBe('kicked');
    expect(join(mgr, h.code, 'Office mate', { token: 'other-token-0000000' }).sock.of('roomJoined')).toHaveLength(1);
    clock += ROOMS.kickRejoinBlockSeconds * 1000 + 1;
    g.send({ t: 'joinRoom', code: h.code });
    expect(g.sock.of('roomJoined')).toHaveLength(2);
  });
});

// =============================================================================================
describe('rooms: countdown, vote lock, match, return to the waiting room', () => {
  it('Start: too_few_humans with fill off and one human; the countdown and the lock time are announced', () => {
    const mgr = makeManager();
    const h = create(mgr, 'H', { fillBots: false });
    h.send({ t: 'startMatch' });
    expect(h.rejects().at(-1)?.code).toBe('too_few_humans');
    join(mgr, h.code);
    clock = 1000;
    h.send({ t: 'startMatch' });
    const st = h.room()!;
    expect(st.phase).toBe('countdown');
    expect(st.countdownEndsAt).toBe(1000 + COUNTDOWN_MS);
    expect(st.lockAt).toBe(1000 + COUNTDOWN_MS - LOCK_MS);
    expect(st.map).toBeNull();
    h.send({ t: 'startMatch' });
    expect(h.rejects().at(-1)?.code).toBe('bad_state');
  });

  it('the vote lock: the map is resolved at lockAt from the votes; the World gets matchStart and timeOriginMs; welcome to all', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const g = join(mgr, h.code);
    const g2 = join(mgr, h.code);
    h.send({ t: 'vote', choice: 'office' });
    g.send({ t: 'vote', choice: 'office' });
    g2.send({ t: 'vote', choice: 'island01' });
    h.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS - LOCK_MS - 100);
    expect(worlds).toHaveLength(0);
    g2.send({ t: 'vote', choice: 'island01' }); // still open
    advance(mgr, 100);
    expect(worlds).toHaveLength(1);
    const w = worlds[0]!;
    expect(w.map.id).toBe('office');
    expect(w.opts.matchStart).toEqual({ countdownMs: LOCK_MS, fillBots: true, matchId: 1 });
    expect(w.opts.timeOriginMs).toBeCloseTo(COUNTDOWN_MS - LOCK_MS, 6);
    expect([...w.humans.values()]).toEqual(['Host', 'Guest', 'Guest']);
    for (const c of [h, g, g2]) {
      expect(c.sock.last('welcome')!.welcome).toMatchObject({ mapId: 'office', matchId: 1, roomId: h.id });
    }
    expect(h.room()!.map).toEqual({ id: 'office', via: 'vote' });
    expect(h.room()!.members.every((m) => m.status === 'playing')).toBe(true);
    // A vote after the lock is accepted but does not change this match's map.
    g.send({ t: 'vote', choice: 'island01' });
    g2.send({ t: 'vote', choice: 'island01' });
    expect(g.rejects()).toHaveLength(0);
    expect(worlds).toHaveLength(1);
    expect(w.map.id).toBe('office');
  });

  it('cancel: host only, before the lock; after the lock bad_state; falling below the start minimum cancels', () => {
    const mgr = makeManager();
    const h = create(mgr, 'H', { fillBots: false });
    const g = join(mgr, h.code);
    h.send({ t: 'startMatch' });
    h.send({ t: 'cancelCountdown' });
    expect(h.room()!.phase).toBe('waiting');
    clock += 2000; // past the start bucket
    h.send({ t: 'startMatch' });
    g.conn.onClose(); // 1 human, fill off: below the minimum
    expect(h.room()!.phase).toBe('waiting');
    const g2 = join(mgr, h.code);
    clock += 2000;
    h.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS - LOCK_MS);
    expect(worlds).toHaveLength(1);
    h.send({ t: 'cancelCountdown' });
    expect(h.rejects().at(-1)?.code).toBe('bad_state');
    expect(g2.room()!.phase).toBe('countdown');
  });

  it('auto-start: all ready (the host counts as ready) with >= 2 humans; one ready human alone does nothing', () => {
    const mgr = makeManager();
    const h = create(mgr, 'H', { visibility: 'private' });
    h.send({ t: 'setReady', ready: true }); // the host has no tick
    expect(h.room()!.phase).toBe('waiting');
    const a = join(mgr, h.code);
    const b = join(mgr, h.code);
    a.send({ t: 'setReady', ready: true });
    expect(h.room()!.phase).toBe('waiting');
    b.send({ t: 'setReady', ready: true });
    expect(h.room()!.phase).toBe('countdown');
  });

  it('auto-start: the public timer runs with >= 2 humans and resets when one leaves; private rooms have none', () => {
    const mgr = makeManager();
    const pub = create(mgr, 'P');
    const priv = create(mgr, 'Q', { visibility: 'private' });
    const g = join(mgr, pub.code);
    join(mgr, priv.code);
    advance(mgr, 200);
    const at = pub.room()!.autoStart;
    expect(at).toEqual({ reason: 'timer', at: expect.any(Number) });
    expect(priv.room()!.autoStart).toBeNull();
    advance(mgr, 30_000);
    g.send({ t: 'leaveRoom' });
    advance(mgr, 200);
    expect(pub.room()!.autoStart).toBeNull();
    join(mgr, pub.code);
    advance(mgr, ROOMS.publicAutoStartSeconds * 1000 - 300);
    expect(pub.room()!.phase).toBe('waiting');
    advance(mgr, 400);
    expect(pub.room()!.phase).toBe('countdown');
    expect(priv.room()!.phase).toBe('waiting');
  });

  it('a mid-match joiner spectates, then everyone returns to the same waiting room: ready reset, votes kept', () => {
    const mgr = makeManager();
    const h = create(mgr);
    const g = join(mgr, h.code);
    g.send({ t: 'vote', choice: 'office' });
    g.send({ t: 'setReady', ready: false });
    h.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS);
    const w = worlds[0]!;
    const room = roomOf(mgr, h.id);
    // After the lock, before playing: a joiner is a participant.
    const early = join(mgr, h.code, 'Early');
    expect(early.sock.last('roomJoined')!.room.members.find((m) => m.name === 'Early')?.status).toBe('playing');
    expect(early.sock.last('welcome')!.welcome.mapId).toBe('office');
    w.phase = 'playing';
    room.tickOnce();
    // During playing: spectating, with snapshots whose local is null.
    const late = join(mgr, h.code, 'Late');
    expect(late.sock.last('welcome')!.welcome).toMatchObject({ mapId: 'office', roomId: h.id });
    expect(late.sock.last('roomJoined')!.room.members.find((m) => m.name === 'Late')?.status).toBe('spectating');
    for (let i = 0; i < 3; i++) room.tickOnce();
    expect(late.sock.last('snapshot')!.snap.local).toBeNull();
    expect(h.sock.last('snapshot')!.snap.local).not.toBeNull();
    late.send({ t: 'vote', choice: 'island01' }); // votes for the next match
    w.phase = 'results';
    room.tickOnce();
    advance(mgr, 200);
    expect(h.room()!.phase).toBe('results');
    w.finished = true;
    room.tickOnce();
    const st = late.room()!;
    expect(st.phase).toBe('waiting');
    expect(st.matchId).toBeNull();
    expect(st.map).toBeNull();
    expect(st.code).toBe(h.code);
    expect(st.members.map((m) => [m.name, m.status, m.ready, m.vote])).toEqual([
      ['Host', 'waiting', false, null],
      ['Guest', 'waiting', false, 'office'],
      ['Early', 'waiting', false, null],
      ['Late', 'waiting', false, 'island01'],
    ]);
    expect(room.world).toBeNull();
    // Inputs and resyncs outside a World are ignored, not bad frames.
    for (let i = 1; i <= 10; i++) h.send({ t: 'input', input: makeInput({ seq: i }) });
    h.send({ t: 'resync' });
    expect(h.sock.closed).toBeNull();
  });

  it('rotation per room with no votes: island01, then office, then island01; two rooms rotate independently', () => {
    const mgr = makeManager();
    const a = create(mgr, 'A');
    const b = create(mgr, 'B');
    const playOne = (c: Client & { id: string }): string => {
      c.send({ t: 'startMatch' });
      advance(mgr, COUNTDOWN_MS);
      const w = worlds.at(-1)!;
      w.finished = true;
      roomOf(mgr, c.id).tickOnce();
      return w.map.id;
    };
    expect([playOne(a), playOne(a), playOne(b), playOne(a), playOne(b)]).toEqual([
      'island01', 'office', 'island01', 'island01', 'office',
    ]);
  });

  it('MAP pins every room: votes are refused, the map is the pin', () => {
    const mgr = makeManager({ pin: 'office' });
    const h = create(mgr, 'H', { mapMode: 'island01' });
    expect(h.room()!.pinnedMap).toBe('office');
    expect(h.room()!.votes).toBeNull();
    h.send({ t: 'vote', choice: 'island01' });
    expect(h.rejects().at(-1)?.code).toBe('bad_state');
    h.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS);
    expect(worlds[0]!.map.id).toBe('office');
    expect(h.room()!.map).toEqual({ id: 'office', via: 'pinned' });
  });
});

// =============================================================================================
describe('match traffic (the M1 Room tests, now per room)', () => {
  function inMatch(over: Partial<RoomManagerOptions> = {}, deltas = false) {
    const mgr = makeManager(over);
    const h = create(mgr);
    if (deltas) {
      // Re-hello is not allowed; use a delta joiner as the measured client instead.
    }
    const g = hello(mgr, 'G', { deltas });
    g.send({ t: 'joinRoom', code: h.code });
    h.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS);
    const w = worlds[0]!;
    w.phase = 'playing';
    const room = roomOf(mgr, h.id);
    const pid = g.sock.last('welcome')!.welcome.playerId;
    const stats = () => mgr.seatStats(g.conn.id)!;
    const applied = () => w.applied.filter(([id]) => id === pid).map(([, i]) => i);
    return { mgr, h, g, w, room, pid, stats, applied };
  }

  it('applies sanitised inputs in order, one per tick, dropping replays', () => {
    const { g, room, stats, applied } = inMatch();
    g.send({ t: 'input', input: makeInput({ seq: 1, moveForward: 9 }) });
    g.send({ t: 'input', input: makeInput({ seq: 3 }) });
    g.send({ t: 'input', input: makeInput({ seq: 2 }) });
    g.send({ t: 'input', input: makeInput({ seq: 3 }) });
    room.tickOnce();
    expect(applied().map((i) => i.seq)).toEqual([1]);
    room.tickOnce();
    room.tickOnce();
    expect(applied().map((i) => i.seq)).toEqual([1, 3]);
    expect(applied()[0]!.moveForward).toBe(1);
    expect(stats().rejectedInputs).toBe(2);
  });

  it('rate-limits input floods to 2 * inputHz per second', () => {
    const { g, mgr } = inMatch();
    for (let seq = 1; seq <= 300; seq++) g.send({ t: 'input', input: makeInput({ seq }) });
    expect(mgr.session(g.conn.id)!.rejectedInputs).toBe(240);
  });

  it('caps the queue at MAX_QUEUED_INPUTS, keeping the newest and merging edge presses forward', () => {
    const { g, room, stats, applied } = inMatch();
    for (let s = 1; s <= 20; s++) {
      g.send({ t: 'input', input: makeInput({ seq: s, jump: s === 2, selectSlot: s === 3 ? 1 : -1 }) });
    }
    expect(stats().queued).toBe(MAX_QUEUED_INPUTS);
    room.tickOnce();
    const first = applied()[0]!;
    expect(first.seq).toBe(20 - MAX_QUEUED_INPUTS + 1);
    expect(first.jump).toBe(true);
    expect(first.selectSlot).toBe(1);
  });

  it('drains a standing input queue; plain jitter merges nothing', () => {
    const { g, room, stats, applied } = inMatch();
    let seq = 0;
    for (let i = 0; i < 4; i++) g.send({ t: 'input', input: makeInput({ seq: ++seq }) });
    for (let tick = 0; tick < 90; tick++) {
      room.tickOnce();
      clock += 1000 / 30;
      g.send({ t: 'input', input: makeInput({ seq: ++seq }) });
    }
    expect(stats().mergedInputs).toBe(3);
    expect(seq - applied().at(-1)!.seq).toBeLessThanOrEqual(1);

    const j = inMatch();
    let s2 = 0;
    for (let tick = 0; tick < 120; tick++) {
      const n = tick % 2 === 0 ? 2 : 0;
      for (let i = 0; i < n; i++) j.g.send({ t: 'input', input: makeInput({ seq: ++s2 }) });
      clock += 1000 / 30;
      j.room.tickOnce();
    }
    expect(j.stats().mergedInputs).toBe(0);
  });

  it('20 snapshots per 30 ticks; one events frame per tick; actionFailed only to its owner', () => {
    const { h, g, w, room, pid } = inMatch();
    h.sock.sent = [];
    g.sock.sent = [];
    for (let i = 0; i < 30; i++) room.tickOnce();
    expect(g.sock.of('snapshot').length).toBeGreaterThanOrEqual(20);
    g.sock.sent = [];
    for (let i = 0; i < 30; i++) room.tickOnce();
    expect(g.sock.of('snapshot')).toHaveLength(20);
    g.sock.sent = [];
    h.sock.sent = [];
    const spawn: SimEvent = { type: 'spawn', playerId: pid, pos: { x: 0, y: 30, z: 0 } };
    const fail: SimEvent = { type: 'actionFailed', playerId: pid, action: 'reload', reason: 'noAmmo' };
    w.queuedEvents = [fail, spawn];
    room.tickOnce();
    expect(g.sock.of('events').map((m) => m.events)).toEqual([[fail, spawn]]);
    expect(h.sock.of('events').map((m) => m.events)).toEqual([[spawn]]);
    w.queuedEvents = [fail];
    room.tickOnce();
    expect(h.sock.of('events')).toHaveLength(1);
  });

  it('skips snapshots to a slow client and closes a stalled one; survives a throwing step', () => {
    const errors: unknown[] = [];
    const log: Logger = { ...SILENT_LOGGER, error: (...a: unknown[]) => errors.push(a) };
    const { g, w, room } = inMatch({ log });
    g.sock.sent = [];
    g.sock.bufferedAmount = 200 * 1024;
    for (let i = 0; i < 3; i++) room.tickOnce();
    expect(g.sock.of('snapshot')).toHaveLength(0);
    expect(g.sock.closed).toBeNull();
    w.throwOnStep = true;
    room.tickOnce();
    w.throwOnStep = false;
    expect(errors).toHaveLength(1);
    g.sock.bufferedAmount = 2 * 1024 * 1024;
    for (let i = 0; i < 3; i++) room.tickOnce();
    expect(g.sock.closed?.reason).toBe('stalled');
  });

  it('pong uses the room clock during a match (the World time continues the server clock)', () => {
    const { g, room, w } = inMatch();
    room.tickOnce();
    clock += 10;
    g.send({ t: 'ping', clientTime: 1 });
    const t = g.sock.last('pong')!.serverTime;
    expect(t).toBeGreaterThanOrEqual(w.timeMs);
    expect(t).toBeLessThanOrEqual(w.timeMs + 4 * (1000 / 30) + 0.001); // at most maxCatchUpTicks ahead (wire: 3 dp)
  });

  it('the fixed-step loop runs simHz without drift and drops time after a long stall', () => {
    const { room, w } = inMatch();
    vi.advanceTimersByTime(40); // the first loop turn absorbs the countdown already elapsed
    const t0 = w.tick;
    for (let i = 0; i < 1000; i++) {
      clock += 7;
      vi.advanceTimersByTime(7);
    }
    expect(Math.abs(w.tick - t0 - 210)).toBeLessThanOrEqual(1);
    const t1 = w.tick;
    clock += 5000;
    vi.advanceTimersByTime(40);
    expect(w.tick - t1).toBe(4);
    expect(room.stats().droppedTicks).toBeGreaterThan(100);
    expect(room.stats().avgTickMs).toBeGreaterThanOrEqual(0);
  });

  it('resync requests reset the delta base and are rate-limited', () => {
    const { g, mgr, room } = inMatch({}, true);
    room.tickOnce();
    room.tickOnce();
    for (let i = 0; i < 20; i++) g.send({ t: 'resync' });
    expect(mgr.seatStats(g.conn.id)!.resyncs).toBe(3);
  });

  it('simulated lag delays outbound frames by half the configured RTT', () => {
    const mgr = makeManager({ lag: { latencyMs: 200, jitterMs: 0 } });
    const c = connect(mgr);
    c.send({ t: 'ping', clientTime: 1 });
    expect(c.sock.sent).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(c.sock.sent).toHaveLength(0);
    vi.advanceTimersByTime(110);
    expect(c.sock.of('pong')).toHaveLength(1);
  });
});

describe('several rooms at once (scripted Worlds)', () => {
  it('each room has its own World, seed and serials; no frame of one room reaches another', () => {
    const mgr = makeManager();
    const a = create(mgr, 'A');
    const b = create(mgr, 'B', { mapMode: 'office' });
    const a2 = join(mgr, a.code, 'A2');
    const b2 = join(mgr, b.code, 'B2');
    a.send({ t: 'startMatch' });
    advance(mgr, 1000);
    b.send({ t: 'startMatch' });
    advance(mgr, COUNTDOWN_MS);
    const [wa, wb] = worlds as [FakeWorld, FakeWorld];
    expect(wa.map.id).toBe('island01');
    expect(wb.map.id).toBe('office');
    expect(wa.opts.seed).not.toBe(wb.opts.seed);
    wa.phase = 'playing';
    wb.phase = 'playing';
    wa.queuedEvents = [{ type: 'spawn', playerId: 1, pos: { x: 1, y: 2, z: 3 } }];
    for (let i = 0; i < 5; i++) roomOf(mgr, a.id).tickOnce();
    for (let i = 0; i < 2; i++) roomOf(mgr, b.id).tickOnce();
    for (const c of [b, b2]) {
      expect(c.sock.of('events')).toHaveLength(0);
      const snaps = c.sock.of('snapshot');
      expect(snaps.every((s) => (s.snap.match as { mapId?: string }).mapId === 'office')).toBe(true);
      expect(Math.max(...snaps.map((s) => s.snap.tick))).toBe(2);
      expect(c.sock.of('welcome').every((m) => m.welcome.roomId === b.id)).toBe(true);
    }
    for (const c of [a, a2]) {
      expect(c.sock.of('events')).toHaveLength(1);
      expect(c.sock.of('snapshot').every((s) => (s.snap.match as { mapId?: string }).mapId === 'island01')).toBe(true);
    }
    expect(mgr.stats().perRoom.map((r) => [r.id, r.tick])).toEqual([[a.id, 5], [b.id, 2]]);
  });
});
