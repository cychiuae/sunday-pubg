/**
 * M2b QA (Phase D): rooms.md and maps.md acceptance criteria without an exact owner test, plus exploratory room edge
 * cases. RoomManager + GameRoom + Session + the real World on the real maps, fake sockets and a fake clock (same shape
 * as server/rooms.world.test.ts, which is the network-engineer's). Traceability: docs/qa/M2b-test-report.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keysWithPrefix, t } from '../../src/content/strings';
import { getMap } from '../../src/game/levels';
import { balanceForMap, type RoomsBalance } from '../../src/shared/balance';
import { PROTOCOL_VERSION } from '../../src/shared/constants';
import { decodeServerMessage, encode, type ClientMessage, type ServerMessage } from '../../src/shared/protocol/messages';
import { resolveMapChoice } from '../../src/shared/sim/mapVote';
import { prepareMap } from '../../src/shared/sim/movement';
import { createWorld } from '../../src/shared/sim/World';
import type { RoomState, WorldSnapshot } from '../../src/shared/types';
import { SILENT_LOGGER, type RoomSocket, type SimMap } from '../../server/common';
import { loadBalance } from '../../server/config';
import { RoomManager, type RoomManagerOptions } from '../../server/RoomManager';

/** Real countdown (10 s) and lock (3 s); a lethal one-phase zone so matches end quickly. */
const BAL = loadBalance(
  JSON.stringify({
    match: { resultsSeconds: 1 },
    zone: { phases: [{ waitSeconds: 1, shrinkSeconds: 1, radiusFraction: 0.01, dps: 500 }] },
  }),
);
const ROOMS = BAL.rooms as RoomsBalance;
const COUNTDOWN_MS = BAL.match.countdownSeconds * 1000;
const LOCK_MS = (BAL.match.mapVoteLockSeconds ?? 3) * 1000;

class Sock implements RoomSocket {
  readyState = 1;
  bufferedAmount = 0;
  all: ServerMessage[] = [];
  room: RoomState | null = null;
  welcomes: { playerId: number; matchId: number; roomId?: string; mapId: string }[] = [];
  latest: WorldSnapshot | null = null;
  conn!: { onMessage(d: string | null): void; onClose(): void };
  send(data: string): void {
    const m = decodeServerMessage(data);
    if (!m) throw new Error(`invalid frame ${data.slice(0, 200)}`);
    this.all.push(m);
    if (m.t === 'roomJoined' || m.t === 'room') this.room = m.room;
    if (m.t === 'roomLeft') this.room = null;
    if (m.t === 'welcome') this.welcomes.push(m.welcome);
    if (m.t === 'snapshot' && m.snap.base === undefined) this.latest = m.snap as unknown as WorldSnapshot; // no deltas advertised: always full
  }
  close(): void {
    this.readyState = 3;
  }
  msg(m: ClientMessage): void {
    this.conn.onMessage(encode(m));
  }
  rejects(): Extract<ServerMessage, { t: 'reject' }>[] {
    return this.all.filter((m): m is Extract<ServerMessage, { t: 'reject' }> => m.t === 'reject');
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
    balance: BAL,
    rooms: ROOMS,
    lockSeconds: LOCK_MS / 1000,
    createWorld,
    getMap: (id) => getMap(id) as SimMap,
    maps: ['island01', 'office'],
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
    seed: 4242,
    log: SILENT_LOGGER,
    now: () => clock,
    loopDelayP99Ms: () => 0,
    autoPoll: false,
    ...over,
  });
}

let tok = 0;
function client(mgr: RoomManager, name: string, token = `${name}-tok-${String(++tok).padStart(12, '0')}`): Sock {
  const c = new Sock();
  c.conn = mgr.connect(c, `10.0.${tok % 250}.1`)!;
  c.msg({ t: 'hello', name, protocolVersion: PROTOCOL_VERSION, clientToken: token });
  return c;
}

function run(mgr: RoomManager, ms: number): void {
  const step = 1000 / 30;
  let sincePoll = 0;
  for (let x = 0; x < ms; x += step) {
    clock += step;
    vi.advanceTimersByTime(step);
    sincePoll += step;
    if (sincePoll >= 100) {
      sincePoll = 0;
      mgr.poll();
    }
  }
}

function host(mgr: RoomManager, settings: Record<string, unknown> = {}, name = 'Host'): Sock {
  const h = client(mgr, name);
  h.msg({ t: 'createRoom', settings, rid: 1 } as ClientMessage);
  if (!h.room) throw new Error(`create failed ${JSON.stringify(h.rejects())}`);
  return h;
}
function guest(mgr: RoomManager, code: string, name = 'Guest', token?: string): Sock {
  const c = client(mgr, name, token);
  c.msg({ t: 'joinRoom', code, rid: 2 });
  return c;
}
const tally = (r: RoomState | null, opt: string): number => r?.votes?.find((v) => v.option === opt)?.count ?? -1;

describe('rooms.md acceptance gaps (QA)', () => {
  it('AT1: max humans outside 1..16 is rejected bad_settings (create and host settings); 1 and 16 are accepted', () => {
    const mgr = manager();
    for (const bad of [0, 17, -1]) {
      const c = client(mgr, `Bad${bad}`);
      c.msg({ t: 'createRoom', settings: { maxHumans: bad }, rid: 1 } as ClientMessage);
      expect(c.room, `maxHumans ${bad}`).toBeNull();
      expect(c.rejects().at(-1)?.code, `maxHumans ${bad}`).toBe('bad_settings');
    }
    // A non-integer never creates a room (dropped by the decoder as a bad frame, no reject).
    const frac = client(mgr, 'Frac');
    frac.msg({ t: 'createRoom', settings: { maxHumans: 1.5 }, rid: 1 } as ClientMessage);
    expect(frac.room).toBeNull();
    const h = host(mgr, { maxHumans: 1 });
    expect(h.room!.settings.maxHumans).toBe(ROOMS.minMaxHumans);
    h.msg({ t: 'setRoomSettings', settings: { maxHumans: 17 }, rid: 3 } as ClientMessage);
    expect(h.rejects().at(-1)?.code).toBe('bad_settings');
    h.msg({ t: 'setRoomSettings', settings: { maxHumans: 16 }, rid: 4 } as ClientMessage);
    run(mgr, 300);
    expect(h.room!.settings.maxHumans).toBe(16);
  });

  it('AT2: fill on, one human, Start -> 12 participants (11 bots); fill off, 2 humans -> 2 players, no bots', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'island01' });
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 500);
    const ps = h.latest!.players;
    expect(ps).toHaveLength(BAL.match.targetPlayers);
    expect(ps.filter((p) => p.isBot)).toHaveLength(BAL.match.targetPlayers - 1);

    const mgr2 = manager();
    const h2 = host(mgr2, { mapMode: 'island01', fillBots: false });
    h2.msg({ t: 'startMatch', rid: 3 });
    expect(h2.rejects().at(-1)?.code).toBe('too_few_humans');
    const g = guest(mgr2, h2.room!.code);
    expect(g.room?.id).toBe(h2.room!.id);
    run(mgr2, 1500); // past the start rate bucket
    h2.msg({ t: 'startMatch', rid: 4 });
    run(mgr2, COUNTDOWN_MS + 500);
    expect(h2.latest!.players.map((p) => p.isBot)).toEqual([false, false]);
  });

  it('AT2: 14 humans with fill on -> no bots', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'island01', maxHumans: 16 });
    const gs = Array.from({ length: 13 }, (_, i) => guest(mgr, h.room!.code, `G${i}`));
    expect(gs.every((g) => g.room?.id === h.room!.id)).toBe(true);
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 500);
    expect(h.latest!.players).toHaveLength(14);
    expect(h.latest!.players.some((p) => p.isBot)).toBe(false);
  });

  it('AT5: the countdown lasts 10 s; the map is in the room state 3 s before the end and the match plays at 10 s', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'office' });
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, 200);
    expect(h.room!.phase).toBe('countdown');
    const endsAt = h.room!.countdownEndsAt!;
    expect(endsAt - h.room!.phaseSince).toBeCloseTo(COUNTDOWN_MS, -2);
    expect(h.room!.lockAt).toBeCloseTo(endsAt - LOCK_MS, -1);
    run(mgr, COUNTDOWN_MS - LOCK_MS - 400);
    expect(h.room!.map).toBeNull();
    run(mgr, 400);
    expect(h.room!.map?.id).toBe('office');
    expect(h.welcomes.at(-1)?.mapId).toBe('office');
    run(mgr, LOCK_MS + 300);
    expect(h.latest?.match.phase).toBe('playing');
  });

  it('AT7: map mode Office -> office with no vote panel (votes null, votes refused)', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'office' });
    expect(h.room!.votes).toBeNull();
    const g = guest(mgr, h.room!.code);
    g.msg({ t: 'vote', choice: 'island01' });
    expect(g.rejects().length).toBeGreaterThan(0);
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 300);
    expect(h.room!.map).toEqual({ id: 'office', via: expect.any(String) });
    expect(g.welcomes.at(-1)?.mapId).toBe('office');
  });
});

describe('maps.md acceptance gaps (QA)', () => {
  it('8: a voter who disconnects before the lock is removed from the tally (and does not decide the map)', () => {
    const mgr = manager();
    const h = host(mgr);
    const a = guest(mgr, h.room!.code, 'A');
    const b = guest(mgr, h.room!.code, 'B');
    h.msg({ t: 'vote', choice: 'island01' });
    a.msg({ t: 'vote', choice: 'office' });
    b.msg({ t: 'vote', choice: 'office' });
    run(mgr, 300);
    expect(tally(h.room, 'office')).toBe(2);
    a.conn.onClose();
    b.conn.onClose();
    run(mgr, 300);
    expect(tally(h.room, 'office')).toBe(0);
    expect(tally(h.room, 'island01')).toBe(1);
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 300);
    expect(h.room!.map).toEqual({ id: 'island01', via: 'vote' });
  });

  it('9: a mid-match joiner gets the running map in the welcome, can vote for the next match, and the vote persists', () => {
    const mgr = manager();
    // island01 so the test balance's lethal zone ends the match (the office has its own maps.office zone radii).
    const h = host(mgr, { mapMode: 'vote' });
    h.msg({ t: 'vote', choice: 'island01' });
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 1000);
    expect(h.room!.map?.id).toBe('island01');
    const late = guest(mgr, h.room!.code, 'Late');
    expect(late.room?.id).toBe(h.room!.id);
    expect(late.welcomes.at(-1)?.mapId).toBe('island01');
    expect(late.room!.members.find((m) => m.name === 'Late')?.status).toBe('spectating');
    late.msg({ t: 'vote', choice: 'office' });
    expect(late.rejects()).toHaveLength(0);
    // Let the match end (lethal zone) and the results pass.
    for (let i = 0; i < 60 && h.room!.phase !== 'waiting'; i++) run(mgr, 1000);
    expect(h.room!.phase).toBe('waiting');
    expect(h.room!.members.find((m) => m.name === 'Late')?.vote).toBe('office');
    expect(h.room!.members.find((m) => m.name === 'Host')?.vote).toBe('island01');
    expect(h.room!.members.find((m) => m.name === 'Late')?.status).toBe('waiting');
  });

  it('6 (server half): a vote sent right after joining counts (what ?map= does on join); an unknown option is rejected', () => {
    const mgr = manager();
    const h = host(mgr);
    const g = guest(mgr, h.room!.code);
    g.msg({ t: 'vote', choice: 'office' });
    run(mgr, 300);
    expect(tally(h.room, 'office')).toBe(1);
    g.conn.onMessage('{"t":"vote","choice":"xyz"}');
    run(mgr, 300);
    expect(tally(h.room, 'office')).toBe(1);
  });
});

describe('exploratory: rejoin, kick cooldown, host migration with the real World', () => {
  it('rejoining after a mid-match disconnect: the new socket spectates, is not a participant, and returns to the waiting room', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'island01', fillBots: false });
    const token = 'rejoin-token-0123456789ab';
    const g = guest(mgr, h.room!.code, 'Flaky', token);
    run(mgr, 1500);
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 500);
    expect(h.latest!.players.map((p) => p.name).sort()).toEqual(['Flaky', 'Host']);
    g.conn.onClose();
    run(mgr, 500);
    const again = guest(mgr, h.room!.code, 'Flaky', token);
    expect(again.room?.id).toBe(h.room!.id);
    const me = again.room!.members.filter((m) => m.name === 'Flaky');
    expect(me).toHaveLength(1);
    expect(me[0]!.status).toBe('spectating');
    expect(again.welcomes.at(-1)?.mapId).toBe('island01');
    run(mgr, 300);
    // Not dropped into the running match: the snapshot has no local state for it.
    expect(again.latest?.local ?? null).toBeNull();
    for (let i = 0; i < 60 && h.room!.phase !== 'waiting'; i++) run(mgr, 1000);
    expect(again.room!.phase).toBe('waiting');
    expect(again.room!.members.map((m) => m.name).sort()).toEqual(['Flaky', 'Host']);
  });

  it('kick cooldown keys on the client token: same token refused "kicked", a fresh token gets in', () => {
    const mgr = manager();
    const h = host(mgr);
    const token = 'kicked-token-0123456789a';
    const g = guest(mgr, h.room!.code, 'Pest', token);
    const mid = g.room!.members.find((m) => m.name === 'Pest')!.memberId;
    h.msg({ t: 'kick', memberId: mid, rid: 5 });
    run(mgr, 200);
    expect(g.room).toBeNull();
    const again = guest(mgr, h.room!.code, 'Pest', token);
    expect(again.room).toBeNull();
    expect(again.rejects().at(-1)?.code).toBe('kicked');
    run(mgr, (ROOMS.kickRejoinBlockSeconds - 5) * 1000);
    const still = guest(mgr, h.room!.code, 'Pest', token);
    expect(still.rejects().at(-1)?.code).toBe('kicked');
    run(mgr, 6000);
    const later = guest(mgr, h.room!.code, 'Pest', token);
    expect(later.room?.id).toBe(h.room!.id);
  });

  it('host leaves mid-match (real World): the oldest remaining human becomes host; the match keeps running', () => {
    const mgr = manager();
    const h = host(mgr, { mapMode: 'island01' });
    const a = guest(mgr, h.room!.code, 'Old');
    run(mgr, 50);
    const b = guest(mgr, h.room!.code, 'Young');
    h.msg({ t: 'startMatch', rid: 3 });
    run(mgr, COUNTDOWN_MS + 500);
    h.conn.onClose();
    run(mgr, 300);
    const oldId = a.room!.members.find((m) => m.name === 'Old')!.memberId;
    expect(a.room!.hostId).toBe(oldId);
    expect(b.room!.hostId).toBe(oldId);
    expect(a.latest!.match.phase).toBe('playing');
  });
});
