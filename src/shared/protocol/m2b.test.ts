/**
 * M2b protocol (ADR 0005, ADR 0006): hello and the lobby requests, the room server messages, the C-gate drop and map
 * fields ('glass' surfaces, the carrier route, the drop events), and the wire compaction that keeps the full snapshot
 * inside its 8 KB budget.
 */
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '../constants';
import type { DropRoute, RoomState, SimEvent, WorldSnapshot } from '../types';
import { SnapshotDeltaDecoder, SnapshotDeltaEncoder } from './delta';
import {
  M2B_FIELDS_REQUIRED,
  decodeClientMessage,
  decodeServerMessage,
  encode,
  encodeQuantized,
  isDropRoute,
  isSimEvent,
  quantizeDeep,
  type SnapshotMessage,
} from './messages';
import { makeLocal, makeMatch, makePlayer, makeSnapshot, makeWelcome } from './testing';

const route = (over: Partial<DropRoute> = {}): DropRoute => ({
  mapId: 'island01',
  entry: { x: -180, z: 120 },
  exit: { x: 175, z: -130 },
  eject: { x: 140, z: -110 },
  altitude: 120,
  speed: 40,
  startsAt: 10_000,
  noJumpUntil: 11_500,
  ejectAt: 18_000,
  endsAt: 19_000,
  ...over,
});

const snapMsg = (snap: WorldSnapshot): string => encodeQuantized({ t: 'snapshot', snap });

describe('C-gate switch', () => {
  it('M2B_FIELDS_REQUIRED flips together with PROTOCOL_VERSION 3 (flip both in the gate commit)', () => {
    expect(M2B_FIELDS_REQUIRED).toBe(PROTOCOL_VERSION >= 3);
  });
});

describe('client -> server (M2b)', () => {
  const d = (v: unknown) => decodeClientMessage(JSON.stringify(v));

  it('hello: name, version, token and caps; a malformed token is dropped, not fatal', () => {
    expect(d({ t: 'hello', name: 'A', protocolVersion: 3, clientToken: 'abcdefghijklmnop', caps: ['delta1'], x: 1 })).toEqual({
      t: 'hello', name: 'A', protocolVersion: 3, clientToken: 'abcdefghijklmnop', caps: ['delta1'],
    });
    expect(d({ t: 'hello', name: 'A', protocolVersion: 3, clientToken: 42 })).toEqual({ t: 'hello', name: 'A', protocolVersion: 3 });
    expect(d({ t: 'hello', name: 'A', protocolVersion: 3, clientToken: 'x'.repeat(500) })).toEqual({ t: 'hello', name: 'A', protocolVersion: 3 });
    expect(d({ t: 'hello', name: 5, protocolVersion: 3 })).toBeNull();
    expect(d({ t: 'hello', name: 'A', protocolVersion: '3' })).toBeNull();
    expect(d({ t: 'hello', name: 'A', protocolVersion: 3, caps: 'delta1' })).toBeNull();
  });

  it('the legacy join still decodes (so the server can answer bad_version)', () => {
    expect(d({ t: 'join', name: 'Old', protocolVersion: 2 })).toEqual({ t: 'join', name: 'Old', protocolVersion: 2 });
  });

  it.each([
    [{ t: 'listRooms', subscribe: true, rid: 0 }, { t: 'listRooms', subscribe: true, rid: 0 }],
    [{ t: 'createRoom', settings: { name: null, visibility: 'private', mapMode: 'office', maxHumans: 4, fillBots: false, evil: 1 } },
      { t: 'createRoom', settings: { name: null, visibility: 'private', mapMode: 'office', maxHumans: 4, fillBots: false } }],
    [{ t: 'createRoom' }, { t: 'createRoom', settings: {} }],
    [{ t: 'joinRoom', roomId: 'r3', rid: 7 }, { t: 'joinRoom', roomId: 'r3', rid: 7 }],
    [{ t: 'joinRoom', code: 'bcd-fg' }, { t: 'joinRoom', code: 'bcd-fg' }],
    [{ t: 'leaveRoom' }, { t: 'leaveRoom' }],
    [{ t: 'setRoomSettings', settings: { maxHumans: 6 } }, { t: 'setRoomSettings', settings: { maxHumans: 6 } }],
    [{ t: 'startMatch', rid: 2 ** 31 }, { t: 'startMatch', rid: 2 ** 31 }],
    [{ t: 'cancelCountdown' }, { t: 'cancelCountdown' }],
    [{ t: 'setReady', ready: false }, { t: 'setReady', ready: false }],
    [{ t: 'vote', choice: null }, { t: 'vote', choice: null }],
    [{ t: 'vote', choice: 'random' }, { t: 'vote', choice: 'random' }],
    [{ t: 'kick', memberId: 3 }, { t: 'kick', memberId: 3 }],
  ])('decodes %j', (raw, out) => expect(d(raw)).toEqual(out));

  it.each([
    { t: 'listRooms' },
    { t: 'listRooms', subscribe: 1 },
    { t: 'startMatch', rid: -1 },
    { t: 'startMatch', rid: 2 ** 31 + 1 },
    { t: 'startMatch', rid: 1.5 },
    { t: 'createRoom', settings: { visibility: 'secret' } },
    { t: 'createRoom', settings: { maxHumans: 4.5 } },
    { t: 'createRoom', settings: { name: 'x'.repeat(200) } },
    { t: 'createRoom', settings: 'all' },
    { t: 'setRoomSettings' },
    { t: 'joinRoom' },
    { t: 'joinRoom', roomId: 'r1', code: 'BCDFG' },
    { t: 'joinRoom', code: 12345 },
    { t: 'joinRoom', roomId: 'r'.repeat(40) },
    { t: 'setReady' },
    { t: 'vote' },
    { t: 'vote', choice: 3 },
    { t: 'kick', memberId: '1' },
    { t: 'teleport' },
  ])('rejects %j', (raw) => expect(d(raw)).toBeNull());
});

describe('server -> client (M2b)', () => {
  const state = (over: Partial<RoomState> = {}): RoomState => ({
    id: 'r1',
    code: 'BCDFG',
    settings: { name: 'Lunch', visibility: 'public', mapMode: 'vote', maxHumans: 12, fillBots: true },
    hostId: 1,
    hostName: 'H',
    members: [{ memberId: 1, name: 'H', ready: false, vote: 'office', status: 'playing', joinedAt: 12.5 }],
    phase: 'countdown',
    phaseSince: 1000,
    pinnedMap: null,
    map: { id: 'office', via: 'vote' },
    countdownEndsAt: 11_000,
    lockAt: 8000,
    autoStart: null,
    votes: [{ option: 'island01', count: 0 }, { option: 'office', count: 1 }, { option: 'random', count: 0 }],
    botSeats: 11,
    matchId: 3,
    ...over,
  });

  it('round-trips every room message', () => {
    const msgs = [
      {
        t: 'hello',
        hello: {
          serverTime: 5,
          maps: ['island01', 'office'],
          pinnedMap: 'office',
          limits: { maxRooms: 8, roomNameMax: 24, maxHumansMin: 1, maxHumansMax: 16, maxHumansDefault: 12, fillBotsDefault: true },
        },
      },
      { t: 'roomList', rev: 0, rooms: [] },
      {
        t: 'roomListDelta',
        from: 3,
        rev: 4,
        upsert: [{ id: 'r1', name: null, hostName: 'H', mapMode: 'office', mapId: 'office', humans: 2, maxHumans: 8, phase: 'playing', phaseSince: 9 }],
        remove: ['r2'],
      },
      { t: 'roomJoined', rid: 4, room: state(), memberId: 1 },
      { t: 'roomJoined', room: state({ autoStart: { reason: 'timer', at: 70_000 }, map: null, votes: null, matchId: null }), memberId: 2 },
      { t: 'room', room: state({ phase: 'waiting', countdownEndsAt: null, lockAt: null }) },
      { t: 'roomLeft', reason: 'kicked' },
      { t: 'reject', rid: 9, req: 'joinRoom', code: 'room_full' },
      { t: 'reject', req: 'createRoom', code: 'rate_limited', retryAfterMs: 1200 },
      { t: 'welcome', welcome: makeWelcome({ playerId: 2, mapId: 'office', serverTime: 1, matchId: 3, roomId: 'r1' }) },
    ] as const;
    for (const m of msgs) expect(decodeServerMessage(encodeQuantized(m as never))).toEqual(m);
  });

  it.each([
    { t: 'hello', hello: { serverTime: 5, maps: ['a'], pinnedMap: null } },
    { t: 'roomList', rev: -1, rooms: [] },
    { t: 'roomListDelta', from: 1, rev: 2, upsert: [{ id: 'r1' }], remove: [] },
    { t: 'roomJoined', room: { id: 'r1' }, memberId: 1 },
    { t: 'room', room: { ...{}, phase: 'lobby' } },
    { t: 'roomLeft', reason: 'bored' },
    { t: 'reject', req: 'x', code: 'nope' },
  ])('rejects malformed %j', (m) => expect(decodeServerMessage(JSON.stringify(m))).toBeNull());

  it('rejects a room state with a bad member status, a bad map pick or a missing tally entry shape', () => {
    const bad = [
      state({ members: [{ memberId: 1, name: 'H', ready: false, vote: null, status: 'afk' as 'waiting', joinedAt: 0 }] }),
      state({ map: { id: 'office', via: 'magic' as 'vote' } }),
      state({ votes: [{ option: 'office', count: -1 }] }),
    ];
    for (const room of bad) expect(decodeServerMessage(JSON.stringify({ t: 'room', room }))).toBeNull();
  });
});

describe('C-gate snapshot and event fields', () => {
  it('the carrier route: finite numbers and startsAt <= noJumpUntil <= ejectAt <= endsAt', () => {
    expect(isDropRoute(route())).toBe(true);
    expect(isDropRoute(route({ noJumpUntil: 9000 }))).toBe(false);
    expect(isDropRoute(route({ ejectAt: 20_000 }))).toBe(false);
    expect(isDropRoute({ ...route(), altitude: 'high' })).toBe(false);
    expect(isDropRoute({ ...route(), entry: { x: 1 } })).toBe(false);
    const ok = decodeServerMessage(snapMsg(makeSnapshot(1, [], { match: makeMatch({ route: route() }) })));
    expect(ok).not.toBeNull();
    const bad = decodeServerMessage(snapMsg(makeSnapshot(1, [], { match: makeMatch({ route: route({ endsAt: 1 }) }) })));
    expect(bad).toBeNull();
  });

  it('drop fields are validated when present (and required after the gate)', () => {
    const ok = makeSnapshot(1, [makePlayer(1, { aboard: true }), makePlayer(2, { dropPhase: 'chute' })]);
    expect(decodeServerMessage(snapMsg(ok))).not.toBeNull();
    const bad = makeSnapshot(1, [makePlayer(1, { dropPhase: 'flying' as 'chute' })]);
    expect(decodeServerMessage(snapMsg(bad))).toBeNull();
    const badLocal = makeSnapshot(1, [], { local: makeLocal(1, { aboard: 'yes' as unknown as boolean }) });
    expect(decodeServerMessage(snapMsg(badLocal))).toBeNull();
    const badMatch = makeSnapshot(1, [], { match: makeMatch({ aboardCount: -1 }) });
    expect(decodeServerMessage(snapMsg(badMatch))).toBeNull();
  });

  it("'glass' surfaces, dropJump and chuteOpen events", () => {
    const events = [
      { type: 'shot', shooterId: 1, weapon: 'rifle', origin: { x: 0, y: 1, z: 0 }, impacts: [{ point: { x: 1, y: 1, z: 1 }, surface: 'glass', playerId: null, headshot: false }] },
      { type: 'grenadeBounce', id: 3, pos: { x: 0, y: 1, z: 0 }, surface: 'glass', speed: 4, kind: 'grenade' },
      { type: 'dropJump', playerId: 2, pos: { x: 1, y: 120, z: 2 }, auto: false },
      { type: 'chuteOpen', playerId: 2, pos: { x: 1, y: 40, z: 2 }, manual: true },
    ] as unknown as SimEvent[];
    for (const e of events) expect(isSimEvent(e)).toBe(true);
    expect(isSimEvent({ type: 'dropJump', playerId: 2, pos: { x: 1, y: 1, z: 1 } })).toBe(false);
    expect(isSimEvent({ type: 'chuteOpen', playerId: 2, pos: { x: 1, y: 1, z: 1 }, manual: 'y' })).toBe(false);
    const m = decodeServerMessage(encodeQuantized({ t: 'events', tick: 1, serverTime: 2, events }));
    expect(m?.t === 'events' && m.events).toHaveLength(4);
  });
});

describe('M2b wire compaction', () => {
  it('a full snapshot omits resting drop fields (object format); the decoder restores them exactly', () => {
    const snap = quantizeDeep(
      makeSnapshot(5, [makePlayer(1), makePlayer(2, { aboard: true }), makePlayer(3, { dropPhase: 'freefall' })], {
        local: makeLocal(1),
        match: makeMatch({ route: route() }),
      }),
    );
    // The object format (sessions without CAP_ROWS); in rows the drop fields are 0/1/2 columns (m2c.test.ts).
    const wire = encodeQuantized({ t: 'snapshot', snap }, { rows: false });
    expect(wire).not.toContain('"aboard":false');
    expect(wire).not.toContain('"dropPhase":null');
    expect(wire).not.toContain('"dropMs":0');
    expect(wire).toContain('"aboard":true');
    expect(wire).toContain('"dropPhase":"freefall"');
    const back = decodeServerMessage(wire) as SnapshotMessage;
    const dec = new SnapshotDeltaDecoder();
    const res = dec.apply(back.snap);
    expect(res.ok && res.snap).toEqual(snap);
  });

  it('patches keep a drop field returning to its resting value; the route rides only in full snapshots', () => {
    const enc = new SnapshotDeltaEncoder(true);
    const dec = new SnapshotDeltaDecoder();
    const r = route();
    const frames: string[] = [];
    const states = [
      makeSnapshot(1, [makePlayer(1, { aboard: true })], { match: makeMatch({ route: r }), local: makeLocal(1, { aboard: true }) }),
      makeSnapshot(2, [makePlayer(1, { dropPhase: 'freefall' })], { match: makeMatch({ route: r }), local: makeLocal(1) }),
      makeSnapshot(3, [makePlayer(1, { dropPhase: 'chute' })], { match: makeMatch({ route: r }), local: makeLocal(1) }),
      makeSnapshot(4, [makePlayer(1)], { match: makeMatch({ route: r }), local: makeLocal(1) }),
    ].map((s) => quantizeDeep(s));
    for (const s of states) {
      const f = encodeQuantized({ t: 'snapshot', snap: enc.encode(s) });
      frames.push(f);
      const m = decodeServerMessage(f) as SnapshotMessage;
      const res = dec.apply(m.snap);
      expect(res.ok && res.snap).toEqual(s);
    }
    expect(frames.filter((f) => f.includes('"route"'))).toHaveLength(1);
    expect(frames[1]).toContain('"aboard":false'); // a patch carries the change back to the resting value
    expect(frames[3]).toContain('"dropPhase":null');
    // A new route (a new World would also mean a reset encoder) is sent again.
    const s5 = quantizeDeep(makeSnapshot(5, [makePlayer(1)], { match: makeMatch({ route: route({ altitude: 99 }) }) }));
    const f5 = encodeQuantized({ t: 'snapshot', snap: enc.encode(s5) });
    expect(f5).toContain('"altitude":99');
    expect((dec.apply((decodeServerMessage(f5) as SnapshotMessage).snap) as { snap: WorldSnapshot }).snap).toEqual(s5);
  });

  it('after the gate a missing route is rejected in a full snapshot and allowed in a delta (carried from the base)', () => {
    const plain = makeSnapshot(1, [makePlayer(1)]);
    delete (plain.match as { route?: unknown }).route;
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: plain }))).toBeNull();
    expect(decodeServerMessage(encode({ t: 'snapshot', snap: { ...plain, base: 0 } }))).not.toBeNull();
    const noRoomId = { t: 'welcome', welcome: { playerId: 1, mapId: 'island01', serverTime: 0, matchId: 1 } };
    expect(decodeServerMessage(JSON.stringify(noRoomId))).toBeNull();
  });
});
