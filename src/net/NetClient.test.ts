import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '../shared/constants';
import type { NetHandlers } from '../shared/contracts';
import { CAP_DELTA, SnapshotDeltaEncoder } from '../shared/protocol/delta';
import { encode, quantizeDeep, type ServerMessage } from '../shared/protocol/messages';
import { makeInput, makePlayer, makeSnapshot } from '../shared/protocol/testing';
import type { ConnectionStatus, WorldSnapshot } from '../shared/types';
import { NetClient, resolveWsUrl, type SocketLike } from './NetClient';

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

function setup() {
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
  it('connects, joins, reports status, and accepts welcome', () => {
    const { net, sockets, statuses, handlers } = setup();
    net.connect('/ws', 'Coco');
    expect(sockets[0]!.url).toBe('wss://game.example:8443/ws');
    expect(net.status).toBe('connecting');
    sockets[0]!.open();
    expect(net.status).toBe('connected');
    expect(sockets[0]!.sent[0]).toEqual({ t: 'join', name: 'Coco', protocolVersion: PROTOCOL_VERSION, caps: [CAP_DELTA] });
    sockets[0]!.receive({ t: 'welcome', welcome: { playerId: 7, mapId: 'island01', serverTime: 5000, matchId: 1 } });
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
    s.receive({ t: 'welcome', welcome: { playerId: 1, mapId: 'island01', serverTime: 0, matchId: 1 } });
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
