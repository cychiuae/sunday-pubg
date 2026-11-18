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
import { decodeServerMessage, encode, quantizeDeep, type ClientMessage, type ServerMessage } from '../src/shared/protocol/messages';
import { resolveMapChoice } from '../src/shared/sim/mapVote';
import { prepareMap } from '../src/shared/sim/movement';
import { createWorld } from '../src/shared/sim/World';
import type { DropRoute, RoomState, WorldSnapshot } from '../src/shared/types';
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
  c.msg({ t: 'hello', name, protocolVersion: PROTOCOL_VERSION, clientToken: `${name}-token-0123456789`, caps: [CAP_DELTA] });
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
  });
});
