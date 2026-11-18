import { describe, expect, it } from 'vitest';
import { BALANCE, type Balance } from '../shared/balance';
import type { ServerHello } from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import type { RoomMember, RoomState, RoomSummary } from '../shared/types';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/types';
import { membersByAge, roomDisplayName, RoomsModel } from './rooms';

const RULES = BALANCE.rooms ?? {
  defaultMaxHumans: 12, minMaxHumans: 1, maxMaxHumans: 16, fillWithBotsDefault: true, minHumansToStartWithBots: 1,
  minHumansToStartWithoutBots: 2, autoStartAllReadyMinHumans: 2, publicAutoStartMinHumans: 2, publicAutoStartSeconds: 60,
  nameMaxLength: 24, kickRejoinBlockSeconds: 120,
};
const B: Balance = { ...BALANCE, rooms: RULES };

const HELLO: ServerHello = {
  serverTime: 0,
  maps: ['island01', 'office'],
  pinnedMap: null,
  limits: { maxRooms: 8, roomNameMax: 24, maxHumansMin: 1, maxHumansMax: 16, maxHumansDefault: 12, fillBotsDefault: true },
};

const member = (memberId: number, over: Partial<RoomMember> = {}): RoomMember => ({
  memberId, name: `m${memberId}`, ready: false, vote: null, status: 'waiting', joinedAt: memberId * 10, ...over,
});

function room(over: Partial<RoomState> = {}): RoomState {
  return {
    id: 'r1', code: 'BCDFG',
    settings: { name: null, visibility: 'public', mapMode: 'vote', maxHumans: 12, fillBots: true },
    hostId: 1, hostName: 'm1', members: [member(1), member(2)], phase: 'waiting', phaseSince: 0, pinnedMap: null, map: null,
    countdownEndsAt: null, lockAt: null, autoStart: null, votes: null, botSeats: 10, matchId: null,
    ...over,
  };
}

function setup(fmt?: (n: string) => string) {
  const calls: { m: string; args: unknown[] }[] = [];
  const rec = (m: string) => (...args: unknown[]): void => void calls.push({ m, args });
  const net = {
    listRooms: rec('listRooms'), createRoom: rec('createRoom'), joinRoom: rec('joinRoom'), leaveRoom: rec('leaveRoom'),
    setRoomSettings: rec('setRoomSettings'), startMatch: rec('startMatch'), cancelCountdown: rec('cancelCountdown'),
    setReady: rec('setReady'), vote: rec('vote'), kick: rec('kick'),
  };
  const events: { type: keyof GameEvents; payload: unknown }[] = [];
  const bus = { emit: <K extends keyof GameEvents>(type: K, payload: GameEvents[K]) => void events.push({ type, payload }) };
  const model = new RoomsModel(net, bus, fmt);
  const sent = (m: string) => calls.filter((c) => c.m === m).map((c) => c.args);
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  return { model, calls, sent, events, of };
}

describe('RoomsModel: browser', () => {
  it("'none' before the hello reply; hello -> browser + list subscription; limits from hello and the code rules", () => {
    const { model, sent } = setup();
    expect(model.view(B, 0, false)).toEqual({ location: 'none', browser: null, room: null, pending: null });
    model.onHello(HELLO);
    expect(sent('listRooms')).toEqual([[true]]);
    const v = model.view(B, 0, false);
    expect(v.location).toBe('browser');
    expect(v.browser!.loaded).toBe(false);
    expect(v.browser!.limits).toEqual({
      roomNameMax: 24, maxHumansMin: 1, maxHumansMax: 16, maxHumansDefault: 12, fillBotsDefault: true,
      maps: ['island01', 'office'], codeLength: ROOM_CODE_LENGTH, codeAlphabet: ROOM_CODE_ALPHABET, pinnedMapId: null,
    });
  });

  it('list entries: display names (null -> default with the host name), elapsed seconds while playing', () => {
    const { model } = setup((n) => `${n}'s room`);
    model.onHello(HELLO);
    const list: RoomSummary[] = [
      { id: 'a', name: 'Desk Wars', hostName: 'Ann', mapMode: 'office', mapId: null, humans: 2, maxHumans: 12, phase: 'waiting', phaseSince: 0 },
      { id: 'b', name: null, hostName: 'Bo', mapMode: 'vote', mapId: 'island01', humans: 5, maxHumans: 8, phase: 'playing', phaseSince: 1000 },
    ];
    model.onRoomList(list);
    const rows = model.view(B, 62_500, false).browser!.rooms;
    expect(rows[0]).toEqual({ id: 'a', name: 'Desk Wars', mapMode: 'office', mapId: null, humans: 2, maxHumans: 12, status: 'waiting', elapsedSeconds: null });
    expect(rows[1]).toMatchObject({ name: "Bo's room", status: 'playing', elapsedSeconds: 61 });
    expect(roomDisplayName(null, 'Cy')).toBe('Cy');
  });

  it('create/join before the hello reply are held and sent after it (deep link); pending until the reply', () => {
    const { model, sent } = setup();
    model.joinRoom({ code: 'BCDFG' });
    expect(sent('joinRoom')).toEqual([]);
    model.onHello(HELLO);
    expect(sent('joinRoom')).toEqual([[{ code: 'BCDFG' }]]);
    expect(model.view(B, 0, false).pending).toBe('join');
    // A second request while one is in flight is ignored.
    model.createRoom(room().settings);
    expect(sent('createRoom')).toEqual([]);
  });

  it('rejects map to roomJoinFailed / roomCreateFailed and clear pending; max_rooms disables Create', () => {
    const { model, of } = setup();
    model.onHello(HELLO);
    model.joinRoom({ code: 'BCDFG' });
    model.onReject('joinRoom', 'room_full');
    expect(of('roomJoinFailed')).toEqual([{ reason: 'full', code: 'BCDFG' }]);
    expect(model.view(B, 0, false).pending).toBeNull();
    model.joinRoom({ roomId: 'x' });
    model.onReject('joinRoom', 'kicked');
    expect(of('roomJoinFailed')[1]).toEqual({ reason: 'kicked', code: null });
    model.createRoom(room().settings);
    model.onReject('createRoom', 'max_rooms');
    expect(of('roomCreateFailed')).toEqual([{ reason: 'roomLimit' }]);
    expect(model.view(B, 0, false).browser!.canCreate).toBe(false);
  });
});

describe('RoomsModel: waiting room', () => {
  function joined(r: RoomState = room(), memberId = 1) {
    const s = setup();
    s.model.onHello(HELLO);
    s.model.joinRoom({ roomId: r.id });
    s.model.onRoomJoined(r, memberId);
    return s;
  }

  it('roomJoined event and the room view: members oldest first, host crown, local flags, start rules', () => {
    const { model, of } = joined(room({ members: [member(2, { joinedAt: 5, ready: true }), member(1, { joinedAt: 10 })] }));
    expect(of('roomJoined')).toEqual([{ roomId: 'r1', code: 'BCDFG', asHost: true, spectating: false }]);
    const v = model.view(B, 0, false);
    expect(v.location).toBe('room');
    expect(v.pending).toBeNull();
    const r = v.room!;
    expect(r.members.map((m) => [m.id, m.isHost, m.isLocal, m.ready])).toEqual([[2, false, false, true], [1, true, true, false]]);
    expect(r.isLocalHost).toBe(true);
    expect(r.canStart).toBe(true);
    expect(r.startBlockedReason).toBeNull();
    expect(r.vote!.options.map((o) => o.option)).toEqual(['island01', 'office', 'random']);
    expect(r.vote!.locked).toBe(false);
  });

  it('fill off with one human: Start is blocked (needTwoWithoutBots); non-hosts never can start', () => {
    const solo = room({ members: [member(1)], settings: { ...room().settings, fillBots: false } });
    expect(joined(solo).model.view(B, 0, false).room).toMatchObject({ canStart: false, startBlockedReason: 'needTwoWithoutBots' });
    expect(joined(room(), 2).model.view(B, 0, false).room).toMatchObject({ canStart: false, isLocalHost: false, startBlockedReason: null });
  });

  it('countdown, cancel window before the lock, auto-start, votes and the mapLoading flag', () => {
    const r = room({ phase: 'countdown', countdownEndsAt: 10_000, lockAt: 7_000, votes: [{ option: 'office', count: 2 }], members: [member(1, { vote: 'office' }), member(2, { vote: 'office' })] });
    const { model, sent } = joined(r);
    const v = model.view(B, 2_100, true).room!;
    expect(v.countdownSecondsLeft).toBe(8);
    expect(v.canCancel).toBe(true);
    expect(v.mapLoading).toBe(true);
    expect(v.vote!.options.find((o) => o.option === 'office')!.count).toBe(2);
    expect(v.vote!.mine).toBe('office');
    expect(model.view(B, 7_500, false).room!.canCancel).toBe(false);
    model.cancelCountdown(7_500);
    expect(sent('cancelCountdown')).toEqual([]);
    model.cancelCountdown(5_000);
    expect(sent('cancelCountdown')).toEqual([[]]);
    const timer = joined(room({ autoStart: { reason: 'timer', at: 60_000 } })).model.view(B, 30_200, false).room!;
    expect(timer.autoStart).toEqual({ reason: 'timer', secondsLeft: 30 });
  });

  it('room updates emit host, member, settings and map-lock events', () => {
    const { model, of } = joined(room(), 2);
    model.onRoom(room({ hostId: 2, hostName: 'm2', members: [member(2), member(3)] }));
    expect(of('roomHostChanged')).toEqual([{ hostId: 2, hostName: 'm2', isLocal: true }]);
    expect(of('roomMemberChanged')).toEqual([
      { memberId: 3, name: 'm3', change: 'joined' },
      { memberId: 1, name: 'm1', change: 'left' },
    ]);
    model.onRoom(room({ hostId: 3, hostName: 'm3', members: [member(2), member(3)], settings: { ...room().settings, maxHumans: 6 } }));
    expect(of('roomSettingsChanged')).toEqual([{ byHost: true }]);
    model.onRoom(room({ hostId: 3, hostName: 'm3', members: [member(2), member(3)], settings: { ...room().settings, maxHumans: 6 }, phase: 'countdown', map: { id: 'office', via: 'vote' }, matchId: 4 }));
    expect(of('mapVoteLocked')).toEqual([{ mapId: 'office', via: 'vote' }]);
    expect(model.view(B, 0, false).room!.vote!.locked).toBe(true);
  });

  it('intents: host-only actions from the host in the right phase; ready and vote; kick never self', () => {
    const host = joined();
    host.model.startMatch();
    host.model.setRoomSettings({ maxHumans: 4 });
    host.model.kick(1);
    host.model.kick(2);
    host.model.kick(99);
    host.model.setReady(true); // the host has no ready tick
    host.model.vote('island01');
    expect(host.sent('startMatch')).toEqual([[]]);
    expect(host.sent('setRoomSettings')).toEqual([[{ maxHumans: 4 }]]);
    expect(host.sent('kick')).toEqual([[2]]);
    expect(host.sent('setReady')).toEqual([]);
    expect(host.sent('vote')).toEqual([['island01']]);
    const guest = joined(room(), 2);
    guest.model.startMatch();
    guest.model.setReady(true);
    expect(guest.sent('startMatch')).toEqual([]);
    expect(guest.sent('setReady')).toEqual([[true]]);
    const pinned = joined(room({ pinnedMap: 'office' }));
    pinned.model.vote('island01');
    expect(pinned.sent('vote')).toEqual([]);
    expect(pinned.model.view(B, 0, false).room!.vote).toMatchObject({ locked: true, pinned: true });
  });

  it('leaving: roomLeft, back to the browser with a fresh list subscription', () => {
    const { model, of, sent } = joined();
    model.leaveRoom();
    expect(model.view(B, 0, false).pending).toBe('leave');
    model.onRoomLeft('kicked');
    expect(of('roomLeft')).toEqual([{ reason: 'kicked' }]);
    expect(model.view(B, 0, false)).toMatchObject({ location: 'browser', pending: null, room: null });
    expect(sent('listRooms')).toEqual([[true], [true]]);
    model.reset();
    expect(model.view(B, 0, false).location).toBe('none');
  });

  it('joined mid-match: spectating', () => {
    const { model, of } = joined(room({ phase: 'playing', members: [member(1, { status: 'playing' }), member(2, { status: 'spectating' })] }), 2);
    expect(of('roomJoined')[0]!.spectating).toBe(true);
    expect(model.view(B, 0, false).room).toMatchObject({ localSpectating: true });
    expect(membersByAge([member(3, { joinedAt: 1 }), member(2, { joinedAt: 1 })]).map((m) => m.memberId)).toEqual([2, 3]);
  });
});
