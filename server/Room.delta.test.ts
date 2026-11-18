/**
 * Delta snapshots end to end through the Room with the real World (bots fighting, looting, zone, match end, next
 * match): the client's rebuilt snapshot must equal what the server holds, tick for tick.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysWithPrefix, t } from '../src/content/strings';
import { DEFAULT_MAP_ID, getMap } from '../src/game/levels';
import { PROTOCOL_VERSION } from '../src/shared/constants';
import { CAP_DELTA, SnapshotDeltaDecoder } from '../src/shared/protocol/delta';
import { decodeServerMessage, encode, quantizeDeep, type SnapshotMessage } from '../src/shared/protocol/messages';
import { createWorld } from '../src/shared/sim/World';
import type { WorldSnapshot } from '../src/shared/types';
import { loadBalance } from './config';
import { Room, SILENT_LOGGER, type RoomSocket, type SimWorld } from './Room';

class RawSocket implements RoomSocket {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  send(data: string): void {
    this.frames.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  take(): string[] {
    const f = this.frames;
    this.frames = [];
    return f;
  }
}

let clock = 0;
beforeEach(() => {
  clock = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => vi.useRealTimers());

function setup(caps: string[] | undefined) {
  const balance = loadBalance(
    '{"match":{"countdownSeconds":0.5,"resultsSeconds":1,"minHumansToStart":1},"zone":{"phases":[{"waitSeconds":5,"shrinkSeconds":5,"radiusFraction":0.3,"dps":20}]}}',
  );
  let world!: SimWorld;
  const room = new Room({
    createWorld: (o) => (world = createWorld(o)),
    map: getMap(DEFAULT_MAP_ID),
    mapId: DEFAULT_MAP_ID,
    balance,
    seed: 11,
    botNames: keysWithPrefix('bot.name').map((k) => t(k)),
    simHz: 30,
    snapshotHz: 20,
    inputHz: 30,
    log: SILENT_LOGGER,
    now: () => clock,
  });
  const sock = new RawSocket();
  const conn = room.connect(sock)!;
  conn.onMessage(encode(caps ? { t: 'join', name: 'Delta', protocolVersion: PROTOCOL_VERSION, caps } : { t: 'join', name: 'Full', protocolVersion: PROTOCOL_VERSION }));
  const id = (decodeServerMessage(sock.take()[0]) as { welcome: { playerId: number } }).welcome.playerId;
  return { room, sock, conn, world, id };
}

const snapshotsIn = (frames: string[]): SnapshotMessage[] =>
  frames.map((f) => decodeServerMessage(f)).filter((m): m is SnapshotMessage => m?.t === 'snapshot');

describe('delta snapshots through the Room (real World)', () => {
  it('the rebuilt snapshot equals the server state on every snapshot across a whole match and the next one', () => {
    const { room, sock, world, id } = setup([CAP_DELTA]);
    const dec = new SnapshotDeltaDecoder();
    let checked = 0;
    let deltaBytes = 0;
    let fullLootSends = 0;
    let lootDeltas = 0;
    const phases = new Set<string>();
    const matchIds = new Set<number>();
    for (let tick = 0; tick < 30 * 60; tick++) {
      clock += 1000 / 30;
      room.tickOnce();
      for (const msg of snapshotsIn(sock.take())) {
        if (msg.snap.loot && checked > 0) fullLootSends++;
        if (msg.snap.lootDelta) lootDeltas++;
        deltaBytes += JSON.stringify(msg).length;
        const res = dec.apply(msg.snap);
        if (!res.ok) throw new Error(`decode failed at tick ${msg.snap.tick}: ${res.reason}`);
        const server: WorldSnapshot = quantizeDeep(world.snapshotFor(id));
        expect(res.snap).toEqual(server);
        phases.add(res.snap.match.phase);
        matchIds.add(res.snap.match.matchId);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1100);
    expect(lootDeltas).toBeGreaterThan(10);
    expect([...phases]).toEqual(expect.arrayContaining(['playing', 'results']));
    expect(matchIds.size).toBeGreaterThan(1);
    expect(room.connStats(1)!.resyncs).toBe(0);
    expect(fullLootSends).toBeLessThan(lootDeltas);
    expect(deltaBytes).toBeGreaterThan(0);
  });

  it('a dropped or reordered snapshot fails to apply, the resync request brings the client back in sync', () => {
    const { room, sock, conn, world, id } = setup([CAP_DELTA]);
    const dec = new SnapshotDeltaDecoder();
    const step = (): SnapshotMessage[] => {
      clock += 1000 / 30;
      room.tickOnce();
      return snapshotsIn(sock.take());
    };
    // Into the match, in sync.
    for (let i = 0; i < 30 * 8; i++) for (const m of step()) expect(dec.apply(m.snap).ok).toBe(true);
    // Drop one snapshot: the next delta's base is unknown.
    let dropped: SnapshotMessage | undefined;
    while (!dropped) dropped = step()[0];
    let next: SnapshotMessage | undefined;
    while (!next) next = step()[0];
    expect(next.snap.base).toBe(dropped.snap.tick);
    expect(dec.apply(next.snap)).toMatchObject({ ok: false });
    // Reordered: the late one cannot be applied either (the decoder reset itself).
    expect(dec.apply(dropped.snap).ok).toBe(false);
    conn.onMessage(encode({ t: 'resync' }));
    let full: SnapshotMessage | undefined;
    while (!full) full = step()[0];
    expect(full.snap.base).toBeUndefined();
    expect(full.snap.loot).toBeDefined();
    const res = dec.apply(full.snap);
    expect(res.ok && res.snap).toEqual(quantizeDeep(world.snapshotFor(id)));
    for (let i = 0; i < 60; i++) {
      for (const m of step()) {
        const r = dec.apply(m.snap);
        expect(r.ok && r.snap).toEqual(quantizeDeep(world.snapshotFor(id)));
      }
    }
    expect(room.connStats(conn.id)!.resyncs).toBe(1);
  });

  it('rate-limits resync requests', () => {
    const { room, conn } = setup([CAP_DELTA]);
    for (let i = 0; i < 20; i++) conn.onMessage(encode({ t: 'resync' }));
    expect(room.connStats(conn.id)!.resyncs).toBe(3);
  });

  it('clients without the capability get the M1 format: full players, loot only when its version changes', () => {
    const { room, sock } = setup(undefined);
    let withLoot = 0;
    let total = 0;
    for (let i = 0; i < 30 * 15; i++) {
      clock += 1000 / 30;
      room.tickOnce();
      for (const m of snapshotsIn(sock.take())) {
        total++;
        expect(m.snap.base).toBeUndefined();
        expect(m.snap.lootDelta).toBeUndefined();
        if (m.snap.loot) withLoot++;
      }
    }
    expect(withLoot).toBeGreaterThan(0);
    expect(withLoot).toBeLessThan(total);
    expect(room.connStats(1)!.deltas).toBe(false);
  });
});
