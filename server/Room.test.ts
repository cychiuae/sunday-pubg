import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BALANCE } from '../src/shared/balance';
import { MAX_INPUT_REPEAT_TICKS, MAX_QUEUED_INPUTS, PROTOCOL_VERSION, SIM_DT } from '../src/shared/constants';
import { playingWorld } from '../src/shared/sim/testkit';
import { decodeServerMessage, encode, type ServerMessage } from '../src/shared/protocol/messages';
import { makeInput, makeMatch, makePlayer, makeSnapshot } from '../src/shared/protocol/testing';
import type { MapData, MatchState, PlayerId, PlayerInput, SimEvent, WorldSnapshot } from '../src/shared/types';
import { Room, SILENT_LOGGER, type RoomSocket, type SimWorld } from './Room';

class FakeWorld implements SimWorld {
  tick = 0;
  timeMs = 0;
  map = { id: 'island01' } as MapData;
  humans = new Set<PlayerId>();
  removed: PlayerId[] = [];
  applied: [PlayerId, PlayerInput][] = [];
  nextId = 1;
  maxHumans = 3;
  lootVersion = 1;
  queuedEvents: SimEvent[] = [];
  throwOnStep = false;
  match: MatchState = makeMatch({ phase: 'lobby' });

  addPlayer(_name: string): PlayerId | null {
    if (this.humans.size >= this.maxHumans) return null;
    const id = this.nextId++;
    this.humans.add(id);
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
    this.timeMs = this.tick * dt * 1000;
    const ev = this.queuedEvents;
    this.queuedEvents = [];
    return ev;
  }
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot {
    return makeSnapshot(this.tick, [makePlayer(viewerId ?? 0)], {
      serverTime: this.timeMs,
      lootVersion: this.lootVersion,
      match: this.match,
    });
  }
  getMatch(): MatchState {
    return this.match;
  }
}

class FakeSocket implements RoomSocket {
  readyState = 1;
  bufferedAmount = 0;
  sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    const m = decodeServerMessage(data);
    if (!m) throw new Error(`room sent an invalid frame: ${data}`);
    this.sent.push(m);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  of<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }
}

let clock = 0;
let world: FakeWorld;
function makeRoom(over: Partial<ConstructorParameters<typeof Room>[0]> = {}): Room {
  return new Room({
    createWorld: () => world,
    map: world.map,
    mapId: 'island01',
    balance: BALANCE,
    seed: 1,
    botNames: ['Bot'],
    simHz: 30,
    snapshotHz: 20,
    inputHz: 30,
    log: SILENT_LOGGER,
    now: () => clock,
    ...over,
  });
}

function joined(room: Room, name = 'Coco') {
  const sock = new FakeSocket();
  const conn = room.connect(sock)!;
  conn.onMessage(encode({ t: 'join', name, protocolVersion: PROTOCOL_VERSION }));
  return { sock, conn };
}

beforeEach(() => {
  clock = 0;
  world = new FakeWorld();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => vi.useRealTimers());

describe('Room join', () => {
  it('welcomes a valid join', () => {
    const room = makeRoom();
    const { sock } = joined(room);
    expect(sock.of('welcome')).toEqual([
      { t: 'welcome', welcome: { playerId: 1, mapId: 'island01', serverTime: 0, matchId: 1 } },
    ]);
    expect(room.stats().joined).toBe(1);
  });

  it.each([
    ['bad_version', { t: 'join', name: 'A', protocolVersion: PROTOCOL_VERSION + 1 }],
    ['bad_name', { t: 'join', name: '   ', protocolVersion: PROTOCOL_VERSION }],
    ['bad_name', { t: 'join', name: 'x'.repeat(40), protocolVersion: PROTOCOL_VERSION }],
  ])('rejects with %s and closes', (code, msg) => {
    const room = makeRoom();
    const sock = new FakeSocket();
    room.connect(sock)!.onMessage(JSON.stringify(msg));
    expect(sock.of('error')[0]?.code).toBe(code);
    expect(sock.closed?.code).toBe(1008);
  });

  it('rejects with full when the world has no human slots', () => {
    world.maxHumans = 1;
    const room = makeRoom();
    joined(room, 'A');
    const { sock } = joined(room, 'B');
    expect(sock.of('error')[0]?.code).toBe('full');
    expect(sock.closed).not.toBeNull();
  });

  it('caps sockets and times out sockets that never join', () => {
    const room = makeRoom({ maxConnections: 2, joinTimeoutMs: 5000 });
    const a = new FakeSocket();
    const b = new FakeSocket();
    const c = new FakeSocket();
    room.connect(a);
    room.connect(b);
    expect(room.connect(c)).toBeNull();
    expect(c.closed?.code).toBe(1013);
    vi.advanceTimersByTime(5001);
    expect(a.closed?.reason).toBe('join_timeout');
  });

  it('drops inputs before join, answers pings before join', () => {
    const room = makeRoom();
    const sock = new FakeSocket();
    const conn = room.connect(sock)!;
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 1 }) }));
    conn.onMessage(encode({ t: 'ping', clientTime: 12 }));
    room.tickOnce();
    expect(world.applied).toHaveLength(0);
    expect(sock.of('pong')).toEqual([{ t: 'pong', clientTime: 12, serverTime: 0 }]);
    expect(sock.of('snapshot')).toHaveLength(0);
  });
});

describe('Room edge validation', () => {
  it('closes after more than 5 bad frames in a second', () => {
    const room = makeRoom();
    const { sock, conn } = joined(room);
    for (let i = 0; i < 5; i++) conn.onMessage('garbage');
    expect(sock.closed).toBeNull();
    conn.onMessage(null); // binary frame
    expect(sock.of('error')[0]?.code).toBe('bad_message');
    expect(sock.closed?.code).toBe(1008);
  });

  it('bad frames spread out over time are tolerated', () => {
    const room = makeRoom();
    const { sock, conn } = joined(room);
    for (let i = 0; i < 20; i++) {
      clock += 300;
      conn.onMessage('x'.repeat(5000)); // oversize
    }
    expect(sock.closed).toBeNull();
  });

  it('a second join is a bad frame, not a second player', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    conn.onMessage(encode({ t: 'join', name: 'Again', protocolVersion: PROTOCOL_VERSION }));
    expect(world.humans.size).toBe(1);
  });

  it('applies sanitised inputs in order, one per tick, dropping replays', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 1, moveForward: 9 }) }));
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 3 }) }));
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 2 }) })); // reordered/replayed -> dropped
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 3 }) })); // duplicate -> dropped
    room.tickOnce();
    expect(world.applied.map(([, i]) => i.seq)).toEqual([1]);
    room.tickOnce();
    room.tickOnce();
    expect(world.applied.map(([, i]) => i.seq)).toEqual([1, 3]);
    expect(world.applied[0]![1].moveForward).toBe(1);
    expect(room.connStats(conn.id)!.rejectedInputs).toBe(2);
  });

  it('rate-limits input floods to 2 * inputHz per second', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    for (let seq = 1; seq <= 300; seq++) conn.onMessage(encode({ t: 'input', input: makeInput({ seq }) }));
    expect(room.connStats(conn.id)!.rejectedInputs).toBe(240);
    clock += 1000;
    for (let seq = 301; seq <= 400; seq++) conn.onMessage(encode({ t: 'input', input: makeInput({ seq }) }));
    expect(room.connStats(conn.id)!.rejectedInputs).toBe(280);
  });

  it('caps the queue at MAX_QUEUED_INPUTS, keeping the newest and merging edge presses forward', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    for (let s = 1; s <= 20; s++) {
      conn.onMessage(encode({ t: 'input', input: makeInput({ seq: s, jump: s === 2, selectSlot: s === 3 ? 1 : -1 }) }));
    }
    expect(room.connStats(conn.id)!.queued).toBe(MAX_QUEUED_INPUTS);
    room.tickOnce();
    const first = world.applied[0]![1];
    expect(first.seq).toBe(20 - MAX_QUEUED_INPUTS + 1);
    expect(first.jump).toBe(true); // press from dropped seq 2 survives
    expect(first.selectSlot).toBe(1);
  });

  it('drains a standing input queue (no permanent added latency after a burst)', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    let seq = 0;
    // A 100 ms stall delivers 3 inputs late in one burst; afterwards the client keeps a steady 1 per tick.
    for (let i = 0; i < 4; i++) conn.onMessage(encode({ t: 'input', input: makeInput({ seq: ++seq }) }));
    for (let tick = 0; tick < 90; tick++) {
      room.tickOnce();
      clock += 1000 / 30;
      conn.onMessage(encode({ t: 'input', input: makeInput({ seq: ++seq }) }));
    }
    const st = room.connStats(conn.id)!;
    expect(st.mergedInputs).toBe(3);
    expect(st.queued).toBeLessThanOrEqual(1);
    // Ack lag (newest sent - newest applied) back to ~1 tick.
    expect(seq - world.applied.at(-1)![1].seq).toBeLessThanOrEqual(1);
  });
});

describe('Room jitter buffer', () => {
  it('does not merge inputs under plain jitter (queue drains to 0 regularly)', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    let seq = 0;
    for (let tick = 0; tick < 120; tick++) {
      const n = tick % 2 === 0 ? 2 : 0; // bunched arrivals, same average rate
      for (let i = 0; i < n; i++) conn.onMessage(encode({ t: 'input', input: makeInput({ seq: ++seq }) }));
      clock += 1000 / 30;
      room.tickOnce();
    }
    expect(room.connStats(conn.id)!.mergedInputs).toBe(0);
    expect(world.applied.map(([, i]) => i.seq)).toEqual(Array.from({ length: world.applied.length }, (_, i) => i + 1));
  });
});

describe('Room tick output', () => {
  it('sends 20 snapshots per 30 ticks, omitting unchanged loot', () => {
    const room = makeRoom();
    const { sock } = joined(room);
    for (let i = 0; i < 30; i++) room.tickOnce();
    expect(sock.of('snapshot').length).toBeGreaterThanOrEqual(20);
    sock.sent = [];
    for (let i = 0; i < 30; i++) room.tickOnce();
    expect(sock.of('snapshot')).toHaveLength(20);
    world.lootVersion = 9; // force a fresh loot send to check omission below
    sock.sent = [];
    for (let i = 0; i < 30; i++) room.tickOnce();
    const snaps = sock.of('snapshot');
    expect(snaps[0]!.snap.loot).toBeDefined();
    expect(snaps.slice(1).every((s) => s.snap.loot === undefined)).toBe(true);
    world.lootVersion = 10;
    room.tickOnce();
    room.tickOnce();
    const after = sock.of('snapshot').slice(snaps.length);
    expect(after[0]!.snap.loot).toBeDefined();
  });

  it('batches one events message per tick and broadcasts it', () => {
    const room = makeRoom();
    const a = joined(room, 'A');
    const b = joined(room, 'B');
    world.queuedEvents = [
      { type: 'spawn', playerId: 1, pos: { x: 0, y: 30, z: 0 } },
      { type: 'spawn', playerId: 2, pos: { x: 1, y: 30, z: 0 } },
    ];
    room.tickOnce();
    room.tickOnce();
    for (const s of [a.sock, b.sock]) {
      const ev = s.of('events');
      expect(ev).toHaveLength(1);
      expect(ev[0]!.events).toHaveLength(2);
      expect(ev[0]!.tick).toBe(1);
    }
  });

  it('removes the player on close and stops sending', () => {
    const room = makeRoom();
    const { sock, conn } = joined(room);
    conn.onClose();
    expect(world.removed).toEqual([1]);
    room.tickOnce();
    room.tickOnce();
    expect(sock.of('snapshot')).toHaveLength(0);
    conn.onClose(); // idempotent
    expect(world.removed).toEqual([1]);
  });

  it('survives a throwing world step', () => {
    const errors: unknown[] = [];
    const room = makeRoom({ log: { ...SILENT_LOGGER, error: (...a: unknown[]) => errors.push(a) } });
    const { sock } = joined(room);
    world.throwOnStep = true;
    room.tickOnce();
    world.throwOnStep = false;
    room.tickOnce();
    room.tickOnce();
    expect(errors).toHaveLength(1);
    expect(sock.of('snapshot').length).toBeGreaterThan(0);
  });

  it('skips snapshots to a slow client and closes a stalled one', () => {
    const room = makeRoom();
    const { sock } = joined(room);
    sock.bufferedAmount = 200 * 1024;
    for (let i = 0; i < 3; i++) room.tickOnce();
    expect(sock.of('snapshot')).toHaveLength(0);
    expect(sock.closed).toBeNull();
    sock.bufferedAmount = 2 * 1024 * 1024;
    for (let i = 0; i < 3; i++) room.tickOnce();
    expect(sock.closed?.reason).toBe('stalled');
  });

  it('serverNow advances between ticks from wall time', () => {
    const room = makeRoom();
    room.tickOnce(); // world.timeMs = 33.3, lastTickWall = 0
    clock += 10;
    expect(room.serverNow()).toBeCloseTo(1000 / 30 + 10);
  });
});

describe('Room fixed-step loop', () => {
  it('runs simHz ticks per second of wall time without drift', () => {
    const room = makeRoom();
    room.start();
    for (let i = 0; i < 1000; i++) {
      clock += 7; // irregular wakeups relative to 33.3 ms
      vi.advanceTimersByTime(7);
    }
    room.stop();
    // 7 s of wall time -> 210 ticks (+-1 for the boundary).
    expect(Math.abs(world.tick - 210)).toBeLessThanOrEqual(1);
  });

  it('drops time after a long stall instead of spiralling', () => {
    const room = makeRoom();
    room.start();
    clock += 5000;
    vi.advanceTimersByTime(40);
    room.stop();
    expect(world.tick).toBe(4);
    expect(room.stats().droppedTicks).toBeGreaterThan(100);
  });
});

describe('Room simulated lag', () => {
  it('delays outbound frames by half the configured RTT', () => {
    const room = makeRoom({ lag: { latencyMs: 200, jitterMs: 0 } });
    const sock = new FakeSocket();
    const conn = room.connect(sock)!;
    conn.onMessage(encode({ t: 'ping', clientTime: 1 }));
    expect(sock.sent).toHaveLength(0);
    vi.advanceTimersByTime(99);
    expect(sock.sent).toHaveLength(0);
    vi.advanceTimersByTime(110);
    expect(sock.of('pong')).toHaveLength(1);
  });
});

describe('Room private events', () => {
  it('sends actionFailed only to its own player, in order, inside that player\'s events frame', () => {
    const room = makeRoom();
    const a = joined(room, 'A'); // player 1
    const b = joined(room, 'B'); // player 2
    const c = joined(room, 'C'); // player 3
    const spawn: SimEvent = { type: 'spawn', playerId: 1, pos: { x: 0, y: 30, z: 0 } };
    const failA: SimEvent = { type: 'actionFailed', playerId: 1, action: 'reload', reason: 'noAmmo' };
    const failB: SimEvent = { type: 'actionFailed', playerId: 2, action: 'heal', reason: 'noHeals' };
    world.queuedEvents = [failA, spawn, failB];
    room.tickOnce();
    expect(a.sock.of('events').map((m) => m.events)).toEqual([[failA, spawn]]);
    expect(b.sock.of('events').map((m) => m.events)).toEqual([[spawn, failB]]);
    expect(c.sock.of('events').map((m) => m.events)).toEqual([[spawn]]);
    for (const s of [a.sock, b.sock, c.sock]) expect(s.of('events')[0]!.tick).toBe(1);
  });

  it('sends no frame to others when a tick has only private events', () => {
    const room = makeRoom();
    const a = joined(room, 'A');
    const b = joined(room, 'B');
    world.queuedEvents = [{ type: 'actionFailed', playerId: 1, action: 'pickup', reason: 'inventoryFull' }];
    room.tickOnce();
    expect(a.sock.of('events')).toHaveLength(1);
    expect(b.sock.of('events')).toHaveLength(0);
  });
});

describe('Room input repeat (ADR 0002 section 4)', () => {
  it('never synthesises or repeats inputs: an empty queue forwards nothing (the World owns bounded repeat)', () => {
    const room = makeRoom();
    const { conn } = joined(room);
    conn.onMessage(encode({ t: 'input', input: makeInput({ seq: 1, moveForward: 1, fire: true }) }));
    for (let i = 0; i < 20; i++) room.tickOnce();
    expect(world.applied).toHaveLength(1);
  });

  it('with the real World, a starved player stops after MAX_INPUT_REPEAT_TICKS instead of running forever', () => {
    const { w, ids } = playingWorld(1);
    const id = ids[0]!;
    let applied = 0;
    const adapter: SimWorld = {
      get tick() {
        return w.tick;
      },
      get timeMs() {
        return w.timeMs;
      },
      map: w.map,
      addPlayer: () => id, // the testkit already added and landed the human
      removePlayer: (pid) => w.removePlayer(pid),
      applyInput: (pid, input) => {
        applied++;
        w.applyInput(pid, input);
      },
      step: (dt) => w.step(dt),
      snapshotFor: (v) => w.snapshotFor(v),
      getMatch: () => w.getMatch(),
    };
    const room = makeRoom({ createWorld: () => adapter, map: w.map });
    const { conn, sock } = joined(room);
    expect(sock.of('welcome')[0]!.welcome.playerId).toBe(id);
    const pos = () => ({ ...w.debugPlayer(id)!.move.pos });

    // Walk forward for 15 ticks at the normal rate, then the tab is hidden: no more inputs.
    for (let seq = 1; seq <= 15; seq++) {
      conn.onMessage(encode({ t: 'input', input: makeInput({ seq, dt: SIM_DT, moveForward: 1 }) }));
      clock += 1000 / 30;
      room.tickOnce();
    }
    const atStall = pos();
    const trail: { x: number; z: number }[] = [];
    for (let i = 0; i < 90; i++) {
      clock += 1000 / 30;
      room.tickOnce();
      trail.push(pos());
    }
    expect(applied).toBe(15); // the Room added no repeats of its own
    // The bounded repeat still absorbs a short gap: the player kept moving for the first ticks.
    expect(Math.hypot(trail[1]!.x - atStall.x, trail[1]!.z - atStall.z)).toBeGreaterThan(0);
    // ...and then stops (friction brings it to rest well within 2 s); without the cap it would walk all 3 s.
    const last = trail.at(-1)!;
    const before = trail[trail.length - 31]!;
    expect(Math.hypot(last.x - before.x, last.z - before.z)).toBeLessThan(1e-6);
    // Distance after the stall is bounded by the repeat window plus braking, far less than 3 s of walking.
    const walk = BALANCE.movement.walkSpeed;
    expect(Math.hypot(last.x - atStall.x, last.z - atStall.z)).toBeLessThan(walk * (MAX_INPUT_REPEAT_TICKS * SIM_DT + 1));
  });
});
