/**
 * Several rooms at once with the real World and a fake clock (NETCODE.md R7): two rooms on different maps and seeds
 * play fast matches to results and back, ticking independently. Every snapshot a socket rebuilds must equal its own
 * room's World state (so nothing from another room can leak in), delta snapshots rebuild exactly across the World
 * swap with zero resyncs, and a mid-match joiner spectates and is a waiting member afterwards.
 */
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysWithPrefix, t } from '../src/content/strings';
import { MAPS, getMap } from '../src/game/levels';
import { balanceForMap, type RoomsBalance } from '../src/shared/balance';
import { PROTOCOL_VERSION } from '../src/shared/constants';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../src/shared/protocol/delta';
import { CAP_ROWS } from '../src/shared/protocol/rows';
import { LAYOUT_FORMAT_VERSION, layoutHash } from '../src/shared/layout';
import { buildMatchLayout } from '../src/game/levels/layout';
import { LEVEL_LAYOUTS } from './app';
import { decodeServerMessage, encode, quantizeDeep, type ClientMessage, type ServerMessage } from '../src/shared/protocol/messages';
import { resolveMapChoice } from '../src/shared/sim/mapVote';
import { prepareMap } from '../src/shared/sim/movement';
import { createWorld } from '../src/shared/sim/World';
import { baselineLook, type DropRoute, type RoomState, type WorldSnapshot } from '../src/shared/types';
import { SILENT_LOGGER, type RoomSocket, type SimMap } from './common';
import { loadBalance } from './config';
import { RoomManager, type RoomManagerOptions } from './RoomManager';

const FAST = loadBalance(
  JSON.stringify({
    match: { countdownSeconds: 1, targetPlayers: 4, resultsSeconds: 1 },
    zone: { phases: [{ waitSeconds: 1, shrinkSeconds: 1, radiusFraction: 0.01, dps: 500 }] },
  }),
);
/** A second map id with the island's geometry, so the two rooms provably run different maps. */
const ISLAND_B = { ...getMap('island01'), id: 'islandB' } as SimMap;
const mapsById: Record<string, SimMap> = { island01: getMap('island01') as SimMap, islandB: ISLAND_B, office: MAPS.office as SimMap };

class Client implements RoomSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly dec = new SnapshotDeltaDecoder();
  room: RoomState | null = null;
  welcomes: { playerId: number; matchId: number; roomId?: string; mapId: string }[] = [];
  snapshots: WorldSnapshot[] = [];
  /** Each rebuilt snapshot paired with what the client's own room World says for it (checked at receipt). */
  mismatches: string[] = [];
  resyncs = 0;
  all: ServerMessage[] = [];
  conn!: { onMessage(d: string | null): void; onClose(): void };
  constructor(private readonly mgr: RoomManager) {}
  send(data: string): void {
    const m = decodeServerMessage(data);
    if (!m) throw new Error(`invalid frame ${data.slice(0, 200)}`);
    this.all.push(m);
    if (m.t === 'roomJoined' || m.t === 'room') this.room = m.room;
    if (m.t === 'welcome') {
      this.welcomes.push(m.welcome);
      this.dec.reset(); // as NetClient: a new World restarts ticks
    }
    if (m.t === 'snapshot') {
      const res = this.dec.apply(m.snap);
      if (!res.ok) {
        this.resyncs++;
        return;
      }
      this.snapshots.push(res.snap);
      // Compare with the World of *this* client's room, right now (the frame was just produced from it).
      const world = this.room ? this.mgr.room(this.room.id)?.world : null;
      const me = this.welcomes.at(-1)!;
      const server = world ? quantizeDeep(world.snapshotFor(me.playerId)) : null;
      if (!server || !isDeepStrictEqual(server, res.snap)) {
        this.mismatches.push(`tick ${res.snap.tick} room ${this.room?.id}`);
      }
    }
  }
  close(): void {
    this.readyState = 3;
  }
  msg(m: ClientMessage): void {
    this.conn.onMessage(encode(m));
  }
}

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => vi.useRealTimers());

function manager(over: Partial<RoomManagerOptions> = {}): RoomManager {
  return new RoomManager({
    balance: FAST,
    rooms: FAST.rooms as RoomsBalance,
    lockSeconds: FAST.match.mapVoteLockSeconds ?? 3,
    createWorld,
    getMap: (id) => mapsById[id]!,
    maps: ['island01', 'islandB', 'office'],
    pin: null,
    balanceForMap,
    prepareMap: (map, b) => prepareMap(map, b),
    resolveMapChoice,
    botNames: keysWithPrefix('bot.name').map((k) => t(k)),
    worldDrop: false,
    maxRooms: 8,
    maxConnections: 100,
    simHz: 30,
    snapshotHz: 20,
    inputHz: 30,
    seed: 99,
    log: SILENT_LOGGER,
    now: () => clock,
    loopDelayP99Ms: () => 0,
    autoPoll: false,
    ...over,
  });
}

function client(mgr: RoomManager, name: string): Client {
  const c = new Client(mgr);
  c.conn = mgr.connect(c, '127.0.0.1')!;
  c.msg({ t: 'hello', name, protocolVersion: PROTOCOL_VERSION, clientToken: `${name}-token-0123456789`, caps: [CAP_DELTA, CAP_ROWS] });
  return c;
}

/** Real time passes: the rooms' own setTimeout loops tick; the manager polls every 100 ms. */
function run(mgr: RoomManager, ms: number): void {
  const step = 1000 / 30;
  let sincePoll = 0;
  for (let t = 0; t < ms; t += step) {
    clock += step;
    vi.advanceTimersByTime(step);
    sincePoll += step;
    if (sincePoll >= 100) {
      sincePoll = 0;
      mgr.poll();
    }
  }
}

describe('several rooms with the real World', () => {
  it('two rooms on different maps play to results and back twice; no leaks; deltas rebuild across World swaps', () => {
    const mgr = manager();
    const a = client(mgr, 'Ana');
    a.msg({ t: 'createRoom', settings: { mapMode: 'island01', visibility: 'private' } });
    const a2 = client(mgr, 'Abe');
    a2.msg({ t: 'joinRoom', code: a.room!.code });
    run(mgr, 400); // the rooms start at different times, so their ticks interleave
    const b = client(mgr, 'Bea');
    b.msg({ t: 'createRoom', settings: { mapMode: 'islandB' } });
    const b2 = client(mgr, 'Bob');
    b2.msg({ t: 'joinRoom', roomId: b.room!.id });
    a.msg({ t: 'startMatch' });
    run(mgr, 300);
    b.msg({ t: 'startMatch' });

    // Mid-match joiner in room B once it is playing.
    let late: Client | null = null;
    let matchesA = 0;
    let matchesB = 0;
    let prevA = a.room!.phase;
    let prevB = b.room!.phase;
    for (let i = 0; i < 400 && (matchesA < 2 || matchesB < 2); i++) {
      run(mgr, 100);
      if (!late && b.room!.phase === 'playing') {
        late = client(mgr, 'Late');
        late.msg({ t: 'joinRoom', code: b.room!.code });
        expect(late.room!.members.find((m) => m.name === 'Late')!.status).toBe('spectating');
      }
      if (prevA !== 'waiting' && a.room!.phase === 'waiting') {
        matchesA++;
        if (matchesA < 2) a.msg({ t: 'startMatch' });
      }
      if (prevB !== 'waiting' && b.room!.phase === 'waiting') {
        matchesB++;
        if (matchesB < 2) b.msg({ t: 'startMatch' });
      }
      prevA = a.room!.phase;
      prevB = b.room!.phase;
    }
    expect([matchesA, matchesB]).toEqual([2, 2]);

    for (const c of [a, a2, b, b2, late!]) {
      expect(c.mismatches).toEqual([]);
      expect(c.resyncs).toBe(0);
      expect(c.snapshots.length).toBeGreaterThan(40);
    }
    // Own room only: welcomes carry the room id, maps differ, match serials are per room.
    expect(a.welcomes.map((w) => [w.roomId, w.mapId, w.matchId])).toEqual([
      [a.room!.id, 'island01', 1],
      [a.room!.id, 'island01', 2],
    ]);
    expect(b.welcomes.map((w) => [w.roomId, w.mapId, w.matchId])).toEqual([
      [b.room!.id, 'islandB', 1],
      [b.room!.id, 'islandB', 2],
    ]);
    // Each match starts with a full snapshot of a fresh World (tick restarts) and every match reached results.
    for (const c of [a, b]) {
      const phasesByMatch = new Map<number, Set<string>>();
      for (const s of c.snapshots) {
        const set = phasesByMatch.get(s.match.matchId) ?? new Set();
        set.add(s.match.phase);
        phasesByMatch.set(s.match.matchId, set);
      }
      expect([...phasesByMatch.keys()]).toEqual([1, 2]);
      for (const set of phasesByMatch.values()) expect([...set]).toEqual(expect.arrayContaining(['playing', 'results']));
    }
    // The late joiner spectated the first match (local null throughout it) and was a waiting member after.
    const lateFirst = late!.snapshots.filter((s) => s.match.matchId === 1);
    expect(lateFirst.length).toBeGreaterThan(0);
    expect(lateFirst.every((s) => s.local === null)).toBe(true);
    expect(late!.welcomes.map((w) => w.matchId)).toEqual([1, 2]);
    expect(late!.snapshots.some((s) => s.match.matchId === 2 && s.local !== null)).toBe(true);
    // Per-room tick metrics.
    const per = mgr.stats().perRoom;
    expect(per).toHaveLength(2);
    for (const r of per) {
      expect(r.ticks).toBeGreaterThan(100);
      expect(r.avgTickMs).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(['island01', 'office'])('with the carrier drop on %s: the route is in the match state from the lock; deltas omit it and the decoder restores it', (mapId) => {
    const mgr = manager({ worldDrop: true });
    const h = client(mgr, 'Host');
    h.msg({ t: 'createRoom', settings: { mapMode: mapId } });
    h.msg({ t: 'startMatch' });
    run(mgr, 2500);
    expect(h.welcomes).toHaveLength(1);
    expect(h.welcomes[0]!.mapId).toBe(mapId);
    expect(h.mismatches).toEqual([]);
    expect(h.resyncs).toBe(0);
    const routes = h.snapshots.map((s) => (s.match as { route?: DropRoute | null }).route);
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.every((r) => r !== undefined && r !== null)).toBe(true);
    expect(new Set(routes.map((r) => JSON.stringify(r))).size).toBe(1);
    // On the wire, only the first (full) snapshot of the match carried it.
    const wireWithRoute = h.all.filter((m) => m.t === 'snapshot' && (m.snap.match as { route?: unknown }).route !== undefined);
    expect(wireWithRoute).toHaveLength(1);
    // M2c: the welcome names the layout the World runs (the base map, until the N2 layout lock); after the first
    // snapshot the local player rides as a patch (rows, carry-forward and local patches all matched the World above).
    const map = mapsById[mapId]!;
    expect((h.welcomes[0] as { layout?: unknown }).layout).toEqual({
      seed: 0, version: LAYOUT_FORMAT_VERSION, hash: layoutHash(map.props, map.lootSpawns), look: baselineLook(map.kind),
    });
    expect(h.all.filter((m) => m.t === 'snapshot' && m.snap.local === undefined).length).toBeGreaterThan(20);
  });

  // Island: two matches (the FAST zone ends them). Office: the first lock only (its own zone override keeps it running).
  it.each([
    ['island01', 2],
    ['office', 1],
  ] as const)('M2c layouts on %s: each match locks a layout; welcome.layout matches the client build; the World runs the applied map', (mapId, want) => {
    const mgr = manager({ layouts: LEVEL_LAYOUTS });
    const h = client(mgr, 'Host');
    h.msg({ t: 'createRoom', settings: { mapMode: mapId } });
    const g = client(mgr, 'Guest');
    g.msg({ t: 'joinRoom', code: h.room!.code });
    const roomStates: RoomState[] = [];
    let matches = 0;
    let prev = 'waiting';
    h.msg({ t: 'startMatch' });
    for (let i = 0; i < 400 && matches < want && !(want === 1 && h.snapshots.length > 40); i++) {
      run(mgr, 100);
      if (h.room!.map && h.room!.phase !== 'waiting') roomStates.push(h.room!);
      const world = mgr.room(h.room!.id)?.world;
      if (world && h.welcomes.length > 0) {
        // The World holds the layout-applied map (props and loot points of the welcome's seed).
        const w = h.welcomes.at(-1) as { layout?: { seed: number } };
        const built = buildMatchLayout(mapsById[mapId]!, w.layout!.seed, { decor: false });
        expect((world as unknown as { map: SimMap }).map.props).toEqual(built.props);
      }
      if (prev !== 'waiting' && h.room!.phase === 'waiting') {
        matches++;
        if (matches < want) h.msg({ t: 'startMatch' });
      }
      prev = h.room!.phase;
    }
    for (const c of [h, g]) {
      expect(c.mismatches).toEqual([]);
      expect(c.resyncs).toBe(0);
      expect(c.welcomes).toHaveLength(want);
    }
    const layouts = h.welcomes.map((w) => (w as { layout?: { seed: number; version: number; hash: number; look: string } }).layout!);
    for (const l of layouts) {
      const built = buildMatchLayout(mapsById[mapId]!, l.seed, { decor: true }); // what the browser builds
      expect(l).toEqual({ seed: l.seed, version: LAYOUT_FORMAT_VERSION, hash: built.hash, look: built.look });
      expect(l.seed).not.toBe(0);
    }
    if (want === 2) expect(layouts[0]!.seed).not.toBe(layouts[1]!.seed);
    // RoomState.map.layout (waiting-room card) = the welcome's seed and look, from the lock on.
    const cards = new Set(roomStates.map((r) => JSON.stringify(r.map!.layout)));
    expect([...cards]).toEqual(layouts.map((l) => JSON.stringify({ seed: l.seed, look: l.look })));
    expect(mgr.stats().layouts).toMatchObject({ builds: want, cacheHits: 0 });
  });
});
