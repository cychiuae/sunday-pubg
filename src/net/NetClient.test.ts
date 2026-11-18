import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/constants';
import { CLIENT_TOKEN_STORAGE_KEY, type NetHandlers, type ServerHello } from '../shared/contracts';
import { CAP_DELTA, SnapshotDeltaEncoder } from '../shared/protocol/delta';
import { encode, encodeQuantized, quantizeDeep, type ServerMessage } from '../shared/protocol/messages';
import { makeGrenade, makeInput, makeLocal, makePlayer, makeSnapshot } from '../shared/protocol/testing';
import type { ConnectionStatus, RoomState, RoomSummary, WorldSnapshot } from '../shared/types';
import { NetClient, loadClientToken, resolveWsUrl, type SocketLike, type TokenStorage } from './NetClient';

class FakeSocket implements SocketLike {
  readyState = 0;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMessage | string): void {
    this.onmessage?.({ data: typeof msg === 'string' ? msg : encode(msg) });
  }
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class MemStorage implements TokenStorage {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
}
const TOKEN = 'AAECAwQFBgcICQoLDA0ODw';

function setup(storage: TokenStorage | null = (() => {
  const m = new MemStorage();
  m.setItem(CLIENT_TOKEN_STORAGE_KEY, TOKEN);
  return m;
})()) {
  let now = 1000;
  const sockets: FakeSocket[] = [];
  const statuses: [ConnectionStatus, string | undefined][] = [];
  const snaps: WorldSnapshot[] = [];
  const handlers: NetHandlers = {
    onWelcome: vi.fn(),
    onSnapshot: (s) => snaps.push(s),
    onEvents: vi.fn(),
    onStatus: (s, r) => statuses.push([s, r]),
  };
  const net = new NetClient({
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    now: () => now,
    location: { protocol: 'https:', host: 'game.example:8443' },
    storage,
    randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => i),
  });
  net.setHandlers(handlers);
  return { net, sockets, statuses, snaps, handlers, advance: (ms: number) => (now += ms), nowRef: () => now };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('resolveWsUrl', () => {
  const loc = { protocol: 'http:', host: 'localhost:5173' };
  it.each([
    ['/ws', 'ws://localhost:5173/ws'],
    ['', 'ws://localhost:5173/ws'],
    ['ws://a:1/ws', 'ws://a:1/ws'],
    ['https://a/ws', 'wss://a/ws'],
  ])('%s -> %s', (url, out) => expect(resolveWsUrl(url, loc)).toBe(out));
  it('uses wss on https pages', () => {
    expect(resolveWsUrl('/ws', { protocol: 'https:', host: 'x' })).toBe('wss://x/ws');
  });
});

describe('NetClient', () => {
  it('connects, says hello with the client token, reports status, and accepts welcome', () => {
    const { net, sockets, statuses, handlers } = setup();
    net.connect('/ws', 'Coco');
    expect(sockets[0]!.url).toBe('wss://game.example:8443/ws');
    expect(net.status).toBe('connecting');
    sockets[0]!.open();
    expect(net.status).toBe('connected');
    expect(sockets[0]!.sent[0]).toEqual({
      t: 'hello',
      name: 'Coco',
      protocolVersion: PROTOCOL_VERSION,
      clientToken: TOKEN,
      caps: [CAP_DELTA],
    });
    sockets[0]!.receive({ t: 'welcome', welcome: { playerId: 7, mapId: 'island01', serverTime: 5000, matchId: 1, roomId: 'r1' } });
    expect(net.playerId).toBe(7);
    expect(handlers.onWelcome).toHaveBeenCalledOnce();
    expect(statuses.map((s) => s[0])).toEqual(['connecting', 'connected']);
  });

  it('only sends inputs after welcome', () => {
    const { net, sockets } = setup();
    net.connect('/ws', 'A');
    const s = sockets[0]!;
    s.open();
    net.sendInput(makeInput({ seq: 1 }));
    expect(s.sent.filter((m) => (m as { t: string }).t === 'input')).toHaveLength(0);
    s.receive({ t: 'welcome', welcome: { playerId: 1, mapId: 'island01', serverTime: 0, matchId: 1, roomId: 'r1' } });
    net.sendInput(makeInput({ seq: 2 }));
    expect(s.sent.at(-1)).toEqual({ t: 'input', input: makeInput({ seq: 2 }) });
  });

  it('syncs the clock from ping/pong', () => {
    const { net, sockets, advance, nowRef } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    vi.advanceTimersByTime(0); // first ping fires immediately
    const ping = sockets[0]!.sent.find((m) => (m as { t: string }).t === 'ping') as { clientTime: number };
    expect(ping.clientTime).toBe(1000);
    advance(60); // RTT 60
    sockets[0]!.receive({ t: 'pong', clientTime: ping.clientTime, serverTime: 90_030 });
    expect(net.rttMs).toBe(60);
    expect(net.serverNow()).toBeCloseTo(90_060); // serverTime + rtt/2
    advance(100);
    expect(net.serverNow()).toBeCloseTo(90_160);
    expect(nowRef()).toBe(1160);
  });

  it('refills omitted loot and buffers snapshots for interpolation', () => {
    const { net, sockets, snaps } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    const full = makeSnapshot(1, [makePlayer(1, { pos: { x: 0, y: 0, z: 0 } })], { serverTime: 1000, lootVersion: 3 });
    sockets[0]!.receive({ t: 'snapshot', snap: full });
    const { loot: _l, ...noLoot } = makeSnapshot(2, [makePlayer(1, { pos: { x: 4, y: 0, z: 0 } })], {
      serverTime: 1050,
      lootVersion: 3,
    });
    sockets[0]!.receive({ t: 'snapshot', snap: noLoot });
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.loot).toEqual(full.loot);
    expect(net.latestSnapshot()!.tick).toBe(2);
    expect(net.getInterpolated(1025)!.players[0]!.pos.x).toBeCloseTo(2);
  });

  it('rebuilds delta snapshots exactly, and asks for a resync (rate-limited) when a base is missing', () => {
    const { net, sockets, snaps } = setup();
    net.connect('/ws', 'A');
    const sock = sockets[0]!;
    sock.open();
    const enc = new SnapshotDeltaEncoder(true);
    const loot = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, item: 'ammo_light' as const, qty: 30, pos: { x: i, y: 0, z: 0 } }));
    const states = Array.from({ length: 8 }, (_, i) =>
      quantizeDeep(
        makeSnapshot(i + 1, [makePlayer(1, { pos: { x: i * 0.25, y: 0, z: 0 } }), makePlayer(2, { hp: 100 - i })], {
          serverTime: 1000 + i * 50,
          lootVersion: 1 + Math.floor(i / 2),
          loot: loot(20).slice(Math.floor(i / 2)),
        }),
      ),
    );
    const wires = states.map((st) => enc.encode(st));
    expect(wires[1]!.base).toBe(1);
    expect(wires[2]!.lootDelta).toEqual({ from: 1, add: [], remove: [1], qty: [] });
    for (const w of wires.slice(0, 3)) sock.receive({ t: 'snapshot', snap: w });
    expect(snaps).toEqual(states.slice(0, 3));
    // wires[3] is lost: 4..7 cannot apply; one resync goes out, not one per snapshot.
    sock.sent = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const w of wires.slice(4)) sock.receive({ t: 'snapshot', snap: w });
    expect(snaps).toHaveLength(3);
    expect(sock.sent).toEqual([{ t: 'resync' }]);
    expect(net.resyncCount).toBe(4);
    // The server answers with a full snapshot; deltas apply again after it.
    enc.reset();
    const later = [8, 9].map((tick) =>
      quantizeDeep(makeSnapshot(tick, [makePlayer(1, { pos: { x: tick, y: 0, z: 0 } })], { serverTime: 1000 + tick * 50, lootVersion: 9, loot: loot(3) })),
    );
    for (const st of later) sock.receive({ t: 'snapshot', snap: enc.encode(st) });
    expect(snaps.slice(3)).toEqual(later);
    warn.mockRestore();
  });

  it('ignores malformed frames without throwing', () => {
    const { net, sockets, snaps } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => sockets[0]!.receive('{"t":"snapshot","snap":{}}')).not.toThrow();
    expect(() => sockets[0]!.receive('not json')).not.toThrow();
    expect(snaps).toHaveLength(0);
    warn.mockRestore();
  });

  it('rate-limits the malformed-frame warning (one per 5 s, with a suppressed count)', () => {
    const { net, sockets, advance } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < 60; i++) {
      sockets[0]!.receive('{"t":"snapshot","snap":{}}'); // 20 Hz of broken snapshots for 3 s
      advance(50);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    advance(2000);
    sockets[0]!.receive('not json');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toMatch(/\+59 similar/);
    warn.mockRestore();
  });

  it('M2a: decodes server-encoded snapshots (packed anim), keeps grenades as received, interpolates stanceProgress', () => {
    const { net, sockets, snaps } = setup();
    net.connect('/ws', 'A');
    const sock = sockets[0]!;
    sock.open();
    const enc = new SnapshotDeltaEncoder(true);
    const anim = { ...makePlayer(2).anim, ads: true, cooking: true };
    const states = [0, 1, 2].map((i) =>
      quantizeDeep(
        makeSnapshot(10 + i, [makePlayer(2, { anim, weapon: 'grenade', vestTier: 2, helmetTier: 3, stance: 'prone', stanceFrom: 'stand', stanceProgress: 0.2 + i * 0.4 })], {
          serverTime: 1000 + i * 50,
          grenades: i === 2 ? [] : [makeGrenade(5, { pos: { x: i, y: 1.25, z: 0 } }), makeGrenade(6, { inWater: true })],
          local: makeLocal(2, { grenades: 1, cookExplodesAt: 3000, vest: { tier: 2, durability: 40 }, helmet: { tier: 3, durability: 70 } }),
        }),
      ),
    );
    for (const st of states) sock.onmessage?.({ data: encodeQuantized({ t: 'snapshot', snap: enc.encode(st) }) });
    expect(snaps).toEqual(states);
    expect(net.latestSnapshot()!.grenades).toEqual([]);
    expect(snaps[0]!.grenades).toEqual(states[0]!.grenades);
    const mid = net.getInterpolated(1025)!.players[0]!;
    expect(mid.stanceProgress).toBeCloseTo(0.4);
    expect(mid.anim).toEqual(anim);
    expect(mid.vestTier).toBe(2);
  });

  it('M2a: forwards the new events (grenades, stance, explosion damage)', () => {
    const { net, sockets, handlers } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    const v = { x: 1, y: 2, z: 3 };
    const events = [
      { type: 'stanceChange', playerId: 2, from: 'stand', to: 'crouch', forced: false, durationMs: 250 },
      { type: 'grenadeCook', playerId: 2, pos: v, explodesAt: 4000 },
      { type: 'grenadeThrown', id: 1, ownerId: 2, pos: v, vel: v, explodesAt: 4000, dropped: false },
      { type: 'grenadeBounce', id: 1, pos: v, surface: 'terrain', speed: 4 },
      { type: 'explosion', id: 1, ownerId: 2, pos: v, radius: 7, inHand: false },
      {
        type: 'damage', victimId: 3, attackerId: 2, amount: 50, headshot: false, cause: 'explosion', sourcePos: v, hpAfter: 70,
        vest: { tier: 1, absorbed: 20, broken: true }, helmet: null, grenadeId: 1,
      },
      { type: 'kill', victimId: 3, killerId: 2, weapon: 'grenade', cause: 'explosion', placement: 5 },
    ] as const;
    sockets[0]!.onmessage?.({ data: encodeQuantized({ t: 'events', tick: 4, serverTime: 133.333, events: [...events] }) });
    expect(handlers.onEvents).toHaveBeenCalledWith(events, 133.333);
  });

  it('delivers actionFailed and revision-1 fields to onEvents, and warns (rate-limited) about dropped events', () => {
    const { net, sockets, handlers } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = { type: 'actionFailed', playerId: 1, action: 'pickup', reason: 'inventoryFull' } as const;
    const kill = { type: 'kill', victimId: 2, killerId: 1, weapon: 'rifle', cause: 'weapon', placement: 2, headshot: true } as const;
    const frame = { t: 'events', tick: 3, serverTime: 100, events: [failed, kill, { type: 'futureThing' }] };
    for (let i = 0; i < 10; i++) sockets[0]!.receive(JSON.stringify(frame));
    expect(handlers.onEvents).toHaveBeenCalledTimes(10);
    expect(handlers.onEvents).toHaveBeenLastCalledWith([failed, kill], 100);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('futureThing');
    warn.mockRestore();
  });

  it('reports server errors with their code', () => {
    const { net, sockets, statuses } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    sockets[0]!.receive({ t: 'error', code: 'full' });
    sockets[0]!.serverClose(1008, 'full');
    expect(net.status).toBe('error');
    expect(statuses.at(-1)).toEqual(['error', 'full']);
  });

  it('reports a dropped connection as disconnected and a failed connect as error', () => {
    const a = setup();
    a.net.connect('/ws', 'A');
    a.sockets[0]!.open();
    a.sockets[0]!.serverClose(1006);
    expect(a.statuses.at(-1)).toEqual(['disconnected', 'close_1006']);

    const b = setup();
    b.net.connect('/ws', 'A');
    b.sockets[0]!.serverClose(1006);
    expect(b.statuses.at(-1)).toEqual(['error', 'connect_failed']);
  });

  it('reconnect replaces the old socket and ignores its late callbacks', () => {
    const { net, sockets, statuses } = setup();
    net.connect('/ws', 'A');
    sockets[0]!.open();
    net.connect('/ws', 'A');
    expect(sockets[0]!.closed).not.toBeNull();
    sockets[0]!.serverClose(1000); // handlers were detached; no status change
    expect(statuses.at(-1)![0]).toBe('connecting');
    sockets[1]!.open();
    expect(net.status).toBe('connected');
    net.disconnect();
    expect(net.status).toBe('idle');
    expect(net.playerId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// M2b rooms (ADR 0006)
// ---------------------------------------------------------------------------------------------
const summary = (id: string, over: Partial<RoomSummary> = {}): RoomSummary => ({
  id,
  name: null,
  hostName: 'H',
  mapMode: 'vote',
  mapId: null,
  humans: 1,
  maxHumans: 12,
  phase: 'waiting',
  phaseSince: 0,
  ...over,
});
const roomState = (over: Partial<RoomState> = {}): RoomState => ({
  id: 'r1',
  code: 'BCDFG',
  settings: { name: null, visibility: 'public', mapMode: 'vote', maxHumans: 12, fillBots: true },
  hostId: 1,
  hostName: 'H',
  members: [{ memberId: 1, name: 'H', ready: false, vote: null, status: 'waiting', joinedAt: 0 }],
  phase: 'waiting',
  phaseSince: 0,
  pinnedMap: null,
  map: null,
  countdownEndsAt: null,
  lockAt: null,
  autoStart: null,
  votes: [{ option: 'island01', count: 0 }, { option: 'office', count: 0 }, { option: 'random', count: 0 }],
  botSeats: 11,
  matchId: null,
  ...over,
});

describe('NetClient rooms', () => {
  it('creates and stores a 128-bit base64url token when storage has none (or a malformed one)', () => {
    const store = new MemStorage();
    const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => 255 - i);
    const t1 = loadClientToken(store, bytes);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(store.getItem(CLIENT_TOKEN_STORAGE_KEY)).toBe(t1);
    expect(loadClientToken(store, () => new Uint8Array(16))).toBe(t1); // stable per browser
    store.setItem(CLIENT_TOKEN_STORAGE_KEY, 'bad token!');
    expect(loadClientToken(store, bytes)).toBe(t1);
    const throwing: TokenStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadClientToken(throwing, bytes)).toBe(t1); // unsaved but well-formed
    expect(loadClientToken(null, bytes)).toBe(t1);
  });

  it('room requests carry rids; requests made while connecting follow the hello (deep link)', () => {
    const { net, sockets } = setup();
    net.connect('/ws', 'Coco');
    net.joinRoom({ code: 'BCDFG' });
    const s = sockets[0]!;
    expect(s.sent).toHaveLength(0);
    s.open();
    expect(s.sent.slice(0, 2).map((m) => (m as { t: string }).t)).toEqual(['hello', 'joinRoom']);
    expect(s.sent[1]).toEqual({ t: 'joinRoom', code: 'BCDFG', rid: 1 });
    net.createRoom({ name: 'X', visibility: 'private', mapMode: 'office', maxHumans: 4, fillBots: false });
    net.joinRoom({ roomId: 'r9' });
    net.leaveRoom();
    net.setRoomSettings({ maxHumans: 6 });
    net.startMatch();
    net.cancelCountdown();
    net.setReady(true);
    net.vote('random');
    net.kick(3);
    const tail = s.sent.slice(-9);
    expect(tail).toEqual([
      { t: 'createRoom', settings: { name: 'X', visibility: 'private', mapMode: 'office', maxHumans: 4, fillBots: false }, rid: 2 },
      { t: 'joinRoom', roomId: 'r9', rid: 3 },
      { t: 'leaveRoom', rid: 4 },
      { t: 'setRoomSettings', settings: { maxHumans: 6 }, rid: 5 },
      { t: 'startMatch', rid: 6 },
      { t: 'cancelCountdown', rid: 7 },
      { t: 'setReady', ready: true },
      { t: 'vote', choice: 'random' },
      { t: 'kick', memberId: 3, rid: 8 },
    ]);
    net.disconnect();
    net.startMatch();
    expect(s.sent.slice(-1)[0]).toEqual({ t: 'kick', memberId: 3, rid: 8 }); // no-op when idle
  });

  it('applies room list deltas, and re-subscribes on a revision gap', () => {
    const { net, sockets, handlers } = setup();
    const lists: RoomSummary[][] = [];
    handlers.onRoomList = (r) => lists.push(r);
    net.connect('/ws', 'A');
    const s = sockets[0]!;
    s.open();
    net.listRooms(true);
    s.receive({ t: 'roomList', rev: 4, rooms: [summary('r1'), summary('r2')] });
    s.receive({ t: 'roomListDelta', from: 4, rev: 5, upsert: [summary('r3'), summary('r1', { humans: 3 })], remove: ['r2'] });
    expect(lists.at(-1)!.map((r) => [r.id, r.humans])).toEqual([['r1', 3], ['r3', 1]]);
    const sentBefore = s.sent.length;
    s.receive({ t: 'roomListDelta', from: 7, rev: 8, upsert: [summary('r9')], remove: [] });
    expect(lists).toHaveLength(2); // not applied
    expect(s.sent.slice(sentBefore)).toEqual([{ t: 'listRooms', subscribe: true, rid: expect.any(Number) }]);
  });

  it('forwards hello, roomJoined, room, roomLeft and reject; resubscribes to the list after leaving', () => {
    const { net, sockets, handlers } = setup();
    const seen: string[] = [];
    handlers.onHello = (h: ServerHello) => seen.push(`hello:${h.maps.join(',')}`);
    handlers.onRoomJoined = (r, m) => seen.push(`joined:${r.id}:${m}`);
    handlers.onRoom = (r) => seen.push(`room:${r.phase}`);
    handlers.onRoomLeft = (why) => seen.push(`left:${why}`);
    handlers.onReject = (req, code, after) => seen.push(`reject:${req}:${code}:${after}`);
    net.connect('/ws', 'A');
    const s = sockets[0]!;
    s.open();
    s.receive({
      t: 'hello',
      hello: {
        serverTime: 100,
        maps: ['island01', 'office'],
        pinnedMap: null,
        limits: { maxRooms: 8, roomNameMax: 24, maxHumansMin: 1, maxHumansMax: 16, maxHumansDefault: 12, fillBotsDefault: true },
      },
    });
    net.listRooms(true);
    s.receive({ t: 'roomJoined', rid: 1, room: roomState(), memberId: 2 });
    s.receive({ t: 'room', room: roomState({ phase: 'countdown' }) });
    s.receive({ t: 'reject', rid: 5, req: 'createRoom', code: 'rate_limited', retryAfterMs: 900 });
    s.receive({ t: 'welcome', welcome: { playerId: 3, mapId: 'office', serverTime: 200, matchId: 1, roomId: 'r1' } });
    expect(net.playerId).toBe(3);
    const before = s.sent.length;
    s.receive({ t: 'roomLeft', reason: 'kicked' });
    expect(net.playerId).toBeNull();
    expect(seen).toEqual([
      'hello:island01,office',
      'joined:r1:2',
      'room:countdown',
      'reject:createRoom:rate_limited:900',
      'left:kicked',
    ]);
    expect(s.sent.slice(before)).toEqual([{ t: 'listRooms', subscribe: true, rid: expect.any(Number) }]);
  });

  it('resets the delta decoder and the snapshot buffer on every welcome (a new World restarts ticks)', () => {
    const { net, sockets, snaps } = setup();
    net.connect('/ws', 'A');
    const s = sockets[0]!;
    s.open();
    const enc1 = new SnapshotDeltaEncoder(true);
    s.receive({ t: 'welcome', welcome: { playerId: 1, mapId: 'island01', serverTime: 0, matchId: 1, roomId: 'r1' } });
    for (let tick = 100; tick < 110; tick++) {
      s.receive(encodeQuantized({ t: 'snapshot', snap: enc1.encode(quantizeDeep(makeSnapshot(tick, [makePlayer(1)]))) }));
    }
    expect(net.latestSnapshot()!.tick).toBe(109);
    // Next match: a new World, ticks from 1, a new encoder on the server (first snapshot full).
    s.receive({ t: 'welcome', welcome: { playerId: 4, mapId: 'office', serverTime: 9000, matchId: 2, roomId: 'r1' } });
    expect(net.latestSnapshot()).toBeNull();
    const enc2 = new SnapshotDeltaEncoder(true);
    for (let tick = 1; tick < 6; tick++) {
      s.receive(
        encodeQuantized({
          t: 'snapshot',
          snap: enc2.encode(quantizeDeep(makeSnapshot(tick, [makePlayer(4)], { serverTime: 9000 + tick * 33 }))),
        }),
      );
    }
    expect(net.resyncCount).toBe(0);
    expect(net.latestSnapshot()!.tick).toBe(5);
    expect(snaps.at(-1)!.players.map((p) => p.id)).toEqual([4]);
    expect(s.sent.filter((m) => (m as { t: string }).t === 'resync')).toHaveLength(0);
  });
});
