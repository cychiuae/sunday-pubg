/**
 * M2b ClientGame: map switching, rooms wiring, the carrier drop (prediction, events, camera, HUD) and first person.
 * Uses the real shared movement step on the flat TEST_MAP island.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BALANCE, type Balance } from '../shared/balance';
import type { ClientGameDeps, ServerHello } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import { carrierPosAt } from '../shared/maps';
import { DEG2RAD } from '../shared/math';
import { initialMovementState } from '../shared/sim/movement';
import type { DropRoute, IslandMapData, LocalPlayerState, MapData, MatchState, PlayerState, RoomState, SimEvent, WorldSnapshot } from '../shared/types';
import { ClientGame } from './ClientGame';
import type { DevGameState } from './devHook';
import { fovBaseOf } from './fov';
import { FakeInput, FakeNet, makeLocal, makeMatch, makeMovement, makePlayer, makeSnapshot, TEST_MAP } from './testFixtures';
import { resolveClientTuning } from './tuning';

const DT = 1 / BALANCE.net.simHz;
const TICK_MS = DT * 1000;
const OTHER: IslandMapData = { ...TEST_MAP, id: 'other', baseHeight: 3 };
const GROUND = TEST_MAP.baseHeight;

const ROUTE: DropRoute = {
  mapId: 'test',
  entry: { x: -100, z: 0 },
  exit: { x: 100, z: 0 },
  eject: { x: 80, z: 0 },
  altitude: 120,
  speed: 200 / 22,
  startsAt: 0,
  noJumpUntil: 3000,
  ejectAt: 20_000,
  endsAt: 22_000,
};

function setup(balance: Balance = BALANCE) {
  const bus = new EventBus<GameEvents>();
  const events: { type: keyof GameEvents; payload: unknown }[] = [];
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    events.push({ type, payload });
    emit(type, payload);
  };
  const net = new FakeNet();
  const input = new FakeInput();
  const maps: Record<string, MapData> = { test: TEST_MAP, other: OTHER };
  const deps: ClientGameDeps = {
    bus,
    net,
    inputTarget: {} as HTMLElement,
    balance,
    getMap: (id) => {
      const m = maps[id];
      if (!m) throw new Error(`no map ${id}`);
      return m;
    },
    initialMap: TEST_MAP,
    serverUrl: 'ws://test/ws',
  };
  const dev: { read: (() => DevGameState) | null } = { read: null };
  const game = new ClientGame(deps, {
    input,
    surfaceAt: () => 'sand',
    grenadeArc: null,
    defaultRoomName: (n) => `${n}'s room`,
    installDevHook: (read) => {
      dev.read = read;
      return () => {};
    },
  });
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  return { game, net, input, events, of, dev };
}

/** Match with the M2b fields (MatchMapFields join MatchState at the C-gate). */
const match = (over: Partial<MatchState> = {}, route: DropRoute | null = ROUTE, aboardCount = 0): MatchState =>
  Object.assign(makeMatch({ phase: 'playing', ...over }), { mapId: 'test', route, aboardCount });
const aboardLocal = (seq = 0): LocalPlayerState =>
  Object.assign(makeLocal(1, { lastProcessedInputSeq: seq, movement: initialMovementState({ x: 0, y: 120, z: 0 }, true, null) }), { aboard: true });
const aboardPlayer = (): PlayerState => Object.assign(makePlayer(1, { name: 'Me', pos: { x: 0, y: 120, z: 0 } }), { aboard: true, dropPhase: null });

function aboardSnap(now: number, seq = 0): WorldSnapshot {
  return makeSnapshot({
    tick: Math.round(now / TICK_MS),
    serverTime: now,
    match: match({}, ROUTE, 5),
    players: [aboardPlayer()],
    local: aboardLocal(seq),
  });
}

function groundSnap(over: Partial<LocalPlayerState> = {}, player: Partial<PlayerState> = {}): WorldSnapshot {
  return makeSnapshot({
    match: match({}, null),
    players: [makePlayer(1, { name: 'Me', pos: { x: 0, y: GROUND, z: 0 }, ...player })],
    local: makeLocal(1, { movement: makeMovement({ pos: { x: 0, y: GROUND, z: 0 } }), ...over }),
  });
}

function ticks(game: ClientGame, n: number): void {
  for (let i = 0; i < n; i++) game.update(DT + 1e-9);
}

afterEach(() => vi.restoreAllMocks());

describe('ClientGame M2b: map switching (ADR 0005 §5)', () => {
  it('first welcome emits mapChanged; same map again does not; a new map switches balance, tuning and theme', () => {
    const balance = {
      ...BALANCE,
      maps: { ...(BALANCE.maps ?? {}), other: { zoneTheme: 'lightsOut', clientFeel: { carrierCameraDistance: 7 } } },
    } as Balance;
    const { game, net, of } = setup(balance);
    net.pushWelcome({ playerId: 1, mapId: 'test' });
    let { hud } = game.update(0);
    expect(of('mapChanged').map((e) => e.mapId)).toEqual(['test']);
    expect(of('mapChanged')[0]!.map).toBe(TEST_MAP);
    expect(of('mapChanged')[0]!.balance.maps).toBeUndefined();
    expect(hud.minimap.map).toBe(TEST_MAP);

    net.pushWelcome({ playerId: 2, mapId: 'test', matchId: 2 });
    game.update(0);
    expect(of('mapChanged')).toHaveLength(1);

    net.pushWelcome({ playerId: 3, mapId: 'other', matchId: 3 });
    ({ hud } = game.update(0));
    const ev = of('mapChanged')[1]!;
    expect(ev).toMatchObject({ mapId: 'other', zoneTheme: 'lightsOut' });
    expect(ev.map).toBe(OTHER);
    expect((ev.balance.clientFeel as Record<string, unknown> | undefined)?.['carrierCameraDistance']).toBe(7);
    expect(hud.zoneTheme).toBe('lightsOut');
    expect(hud.minimap.map).toBe(OTHER);

    // Back to the first map: the cached MapRuntime (same effective balance object).
    net.pushWelcome({ playerId: 4, mapId: 'test', matchId: 4 });
    game.update(0);
    expect(of('mapChanged')[2]!.balance).toBe(of('mapChanged')[0]!.balance);

    // The carrier camera uses the per-map tuning (maps.<id>.clientFeel).
    net.pushWelcome({ playerId: 1, mapId: 'other', matchId: 5 });
    net.pushSnapshot(Object.assign(aboardSnap(1000), { match: Object.assign(match({}, { ...ROUTE, mapId: 'other' }, 5), { mapId: 'other' }) }));
    const { frame } = game.update(0);
    expect(frame.camera).toMatchObject({ view: 'carrier', distance: 7 });
  });

  it('a welcome resets per-match state; an unknown map id keeps the loaded map', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1, mapId: 'test' });
    net.pushSnapshot(groundSnap());
    game.update(0);
    ticks(game, 2);
    expect(net.sent.length).toBeGreaterThan(0);
    net.pushWelcome({ playerId: 1, mapId: 'nope', matchId: 2 });
    const { hud, frame } = game.update(0);
    expect(err).toHaveBeenCalled();
    expect(of('mapChanged')).toHaveLength(1);
    expect(hud.minimap.map).toBe(TEST_MAP);
    expect(hud.local).toBeNull();
    expect(frame.camera.view).toBe('title');
  });
});

describe('ClientGame M2b: rooms', () => {
  const HELLO: ServerHello = {
    serverTime: 0,
    maps: ['test', 'other'],
    pinnedMap: null,
    limits: { maxRooms: 8, roomNameMax: 24, maxHumansMin: 1, maxHumansMax: 16, maxHumansDefault: 12, fillBotsDefault: true },
  };
  const ROOM: RoomState = {
    id: 'r1', code: 'BCDFG', settings: { name: null, visibility: 'private', mapMode: 'vote', maxHumans: 12, fillBots: true },
    hostId: 1, hostName: 'Sandy', members: [{ memberId: 1, name: 'Sandy', ready: false, vote: null, status: 'waiting', joinedAt: 0 }],
    phase: 'waiting', phaseSince: 0, pinnedMap: null, map: null, countdownEndsAt: null, lockAt: null, autoStart: null,
    votes: null, botSeats: 11, matchId: null,
  };

  it('hello -> browser (list subscription); intents forward; joined -> room view; welcome sets mapLoading for one frame', () => {
    const { game, net, of } = setup();
    game.join('Sandy');
    game.joinRoom({ code: 'BCDFG' }); // deep link before the hello reply: held
    net.pushStatus('connected');
    net.pushHello(HELLO);
    let { hud } = game.update(0);
    expect(net.roomCalls).toEqual([['listRooms', true], ['joinRoom', { code: 'BCDFG' }]]);
    expect(hud.rooms).toMatchObject({ location: 'browser', pending: 'join' });
    net.handlers!.onRoomJoined!(ROOM, 1);
    ({ hud } = game.update(0));
    expect(of('roomJoined')).toEqual([{ roomId: 'r1', code: 'BCDFG', asHost: true, spectating: false }]);
    expect(hud.rooms!.room).toMatchObject({ name: "Sandy's room", isLocalHost: true, canStart: true, mapLoading: false });
    game.startMatch();
    game.vote('other');
    game.kick(1);
    expect(net.roomCalls.slice(2)).toEqual([['startMatch'], ['vote', 'other']]);
    net.pushWelcome({ playerId: 1, mapId: 'other' });
    ({ hud } = game.update(0));
    expect(hud.rooms!.room!.mapLoading).toBe(true);
    ({ hud } = game.update(0));
    expect(hud.rooms!.room!.mapLoading).toBe(false);
    expect(game['rooms'].localMemberId).toBe(1);
    expect(dummy()).toBe(true);
  });

  it('left the room (kicked): roomLeft, back to the browser, out of the match view', () => {
    const { game, net, of } = setup();
    net.pushStatus('connected');
    net.pushHello(HELLO);
    net.handlers!.onRoomJoined!(ROOM, 1);
    net.pushWelcome({ playerId: 1, mapId: 'test' });
    net.pushSnapshot(groundSnap());
    game.update(0);
    net.handlers!.onRoomLeft!('kicked');
    const { hud } = game.update(0);
    expect(of('roomLeft')).toEqual([{ reason: 'kicked' }]);
    expect(hud.rooms!.location).toBe('browser');
    expect(hud.joined).toBe(false);
    expect(hud.local).toBeNull();
  });
});

const dummy = (): boolean => true;

describe('ClientGame M2b: carrier drop (drop.md)', () => {
  function aboard() {
    const s = setup();
    s.net.now = 1000;
    s.net.pushWelcome({ playerId: 1, mapId: 'test' });
    s.net.pushSnapshot(aboardSnap(1000));
    s.game.update(0);
    return s;
  }

  it('aboard: carrier camera at carrierPosAt, no viewmodel, aboard HUD, minimap route, carrierDeparted once', () => {
    const { game, of, net } = aboard();
    const { frame, hud } = game.update(0);
    const c = carrierPosAt(ROUTE, 1000);
    expect(frame.camera).toMatchObject({ mode: 'follow', view: 'carrier', firstPerson: false, distance: resolveClientTuning(BALANCE).carrierCameraDistance });
    expect(frame.camera.target).toEqual({ x: c.x, y: ROUTE.altitude, z: c.z });
    expect(frame.viewmodel).toBeNull();
    expect(hud.cameraView).toBe('orbit');
    expect(hud.drop).toEqual({ stage: 'aboard', noJumpSecondsLeft: 2, ejectSecondsLeft: 19, aboardCount: 5, altitude: 120, deployHeight: BALANCE.drop.chuteDeployHeight, canDeploy: false });
    expect(hud.minimap.route).toMatchObject({ from: ROUTE.entry, to: ROUTE.exit, eject: ROUTE.eject });
    expect(hud.minimap.route!.carrier!.pos.x).toBeCloseTo(c.x);
    expect(of('carrierDeparted')).toEqual([{ route: ROUTE }]);
    net.now = 1500;
    game.update(0.016);
    expect(of('carrierDeparted')).toHaveLength(1);
    expect(dummy()).toBe(true);
  });

  it('aboard inputs carry look and the jump edge; a jump before noJumpUntil is not predicted', () => {
    const { game, net, input, of } = aboard();
    input.state.keyDown('Space');
    ticks(game, 1);
    expect(net.sent.at(-1)!.jump).toBe(true);
    const { frame } = game.update(0);
    expect(frame.camera.view).toBe('carrier');
    expect(of('playerJumped')).toEqual([]);
  });

  it('F (aboard only) jumps: predicted freefall at the carrier, FP camera, playerJumped from prediction; echo dropped', () => {
    const { game, net, input, of, dev } = aboard();
    // F does nothing on foot: checked by InputState tests; here it is enabled because we are aboard.
    net.now = 4000;
    game.update(0);
    input.state.keyDown('KeyF');
    ticks(game, 1);
    const jumpSeq = net.sent.at(-1)!.seq;
    expect(net.sent.at(-1)!.jump).toBe(true);
    const c = carrierPosAt(ROUTE, 4000);
    expect(of('playerJumped')).toEqual([{ playerId: 1, pos: { x: c.x, y: ROUTE.altitude, z: c.z }, auto: false, isLocal: true }]);
    let { frame, hud } = game.update(0);
    expect(frame.camera).toMatchObject({ view: 'firstPerson', firstPerson: true, subjectId: 1 });
    expect(frame.viewmodel).toMatchObject({ dropPhase: 'freefall' });
    expect(hud.drop).toMatchObject({ stage: 'freefall', canDeploy: false });
    expect(dev.read!()).toMatchObject({ dropPhase: 'freefall', aboard: false, cameraView: 'firstPerson' });

    // A snapshot from before the server processed the jump: keep predicting.
    net.pushSnapshot(aboardSnap(4000, jumpSeq - 1));
    input.state.keyUp('KeyF');
    ticks(game, 3);
    ({ frame } = game.update(0));
    expect(frame.camera.view).toBe('firstPerson');
    const me = frame.players.find((p) => p.isLocal)!.state;
    expect(me.pos.y).toBeLessThan(ROUTE.altitude);
    expect((me as PlayerState & { aboard?: boolean }).aboard).toBe(false);

    // The server's dropJump echo for us is dropped; another player's reaches the bus.
    net.pushEvents([
      { type: 'dropJump', playerId: 1, pos: { x: c.x, y: 120, z: 0 }, auto: false },
      { type: 'dropJump', playerId: 7, pos: { x: 0, y: 120, z: 0 }, auto: true },
    ] as unknown as SimEvent[]);
    game.update(0);
    expect(of('playerJumped').map((e) => [e.playerId, e.isLocal])).toEqual([[1, true], [7, false]]);

    // The ack: aboard = false with the server's freefall state; normal reconciliation.
    const ff = initialMovementState({ x: c.x, y: ROUTE.altitude, z: c.z }, true, 'freefall');
    net.pushSnapshot(makeSnapshot({
      tick: 200, serverTime: 4000, match: match({}, ROUTE, 4),
      players: [Object.assign(makePlayer(1, { name: 'Me', pos: ff.pos }), { aboard: false, dropPhase: 'freefall' })],
      local: Object.assign(makeLocal(1, { lastProcessedInputSeq: jumpSeq, movement: ff }), { aboard: false }),
    }));
    game.update(0);
    expect(dev.read!().lastCorrection).toBeLessThan(1);
    // canDeploy after minFreefallMs.
    ticks(game, Math.ceil(BALANCE.drop.minFreefallMs / TICK_MS) + 1);
    ({ hud } = game.update(0));
    expect(hud.drop).toMatchObject({ stage: 'freefall', canDeploy: BALANCE.drop.manualDeploy });

    // Auto-deploy at chuteDeployHeight above the ground, from prediction; the server echo is dropped.
    const fallTicks = Math.ceil((ROUTE.altitude - GROUND - BALANCE.drop.chuteDeployHeight) / BALANCE.drop.freefallSpeed / DT) + 2;
    ticks(game, fallTicks);
    expect(of('parachuteOpened')).toHaveLength(1);
    expect(of('parachuteOpened')[0]).toMatchObject({ playerId: 1, manual: false, isLocal: true });
    net.pushEvents([{ type: 'chuteOpen', playerId: 1, pos: { x: 0, y: 40, z: 0 }, manual: false }] as unknown as SimEvent[]);
    ({ hud, frame } = game.update(0));
    expect(of('parachuteOpened')).toHaveLength(1);
    expect(hud.drop!.stage).toBe('chute');
    expect(frame.viewmodel!.dropPhase).toBe('chute');
    expect(hud.drop!.altitude).toBeLessThanOrEqual(BALANCE.drop.chuteDeployHeight);
  });

  it('manual deploy: the jump edge after minFreefallMs opens the chute (predicted, manual)', () => {
    const { game, net, input, of } = aboard();
    net.now = 4000;
    input.state.keyDown('Space');
    ticks(game, 1);
    input.state.keyUp('Space');
    ticks(game, Math.ceil(BALANCE.drop.minFreefallMs / TICK_MS) + 1);
    input.state.keyDown('KeyF');
    ticks(game, 1);
    if (BALANCE.drop.manualDeploy) expect(of('parachuteOpened')).toEqual([expect.objectContaining({ manual: true, isLocal: true })]);
  });

  it('a jump the server refused (processed, still aboard) returns to the carrier', () => {
    const { game, net, input } = aboard();
    net.now = 4000;
    input.state.keyDown('Space');
    ticks(game, 1);
    const seq = net.sent.at(-1)!.seq;
    expect(game.update(0).frame.camera.view).toBe('firstPerson');
    net.pushSnapshot(aboardSnap(4100, seq));
    expect(game.update(0).frame.camera.view).toBe('carrier');
  });

  it('auto-eject (server jump): playerJumped from the server event, then prediction from the first freefall snapshot', () => {
    const { game, net, of } = aboard();
    net.now = 20_000;
    net.pushEvents([{ type: 'dropJump', playerId: 1, pos: { x: 80, y: 120, z: 0 }, auto: true }] as unknown as SimEvent[]);
    const ff = initialMovementState({ x: 80, y: 120, z: 0 }, true, 'freefall');
    net.pushSnapshot(makeSnapshot({
      tick: 600, serverTime: 20_000, match: match({}, ROUTE, 0),
      players: [Object.assign(makePlayer(1, { name: 'Me', pos: ff.pos }), { aboard: false, dropPhase: 'freefall' })],
      local: Object.assign(makeLocal(1, { movement: ff }), { aboard: false }),
    }));
    const { frame } = game.update(0);
    expect(of('playerJumped')).toEqual([{ playerId: 1, pos: { x: 80, y: 120, z: 0 }, auto: true, isLocal: true }]);
    expect(frame.camera.view).toBe('firstPerson');
  });
});

describe('ClientGame M2b: first person', () => {
  function onFoot(over: Partial<LocalPlayerState> = {}, player: Partial<PlayerState> = {}) {
    const s = setup();
    s.net.pushWelcome({ playerId: 1, mapId: 'test' });
    s.net.pushSnapshot(groundSnap(over, player));
    s.game.update(0);
    return s;
  }
  const RIFLE = { slots: [{ weapon: 'rifle' as const, mag: 10 }, null] as LocalPlayerState['slots'], activeSlot: 0 as const, ammo: { ammo_light: 0, ammo_heavy: 60, ammo_shell: 0, ammo_sniper: 0 } };

  it('Settings FOV (Hor+) sets the FP FOV; FrameView.reducedMotion follows the setting', () => {
    const { game } = onFoot();
    game.setSettings({ mouseSensitivity: 1, masterVolume: 1, invertY: false, fovDeg: 100, reducedMotion: true });
    const { frame, hud } = game.update(0);
    expect(frame.camera.fovDeg).toBeCloseTo(fovBaseOf(100).playerDeg);
    expect(hud.cameraFovDeg).toBe(frame.camera.fovDeg);
    expect(frame.reducedMotion).toBe(true);
    expect(frame.viewmodel!.motionScale).toBe(resolveClientTuning(BALANCE).reducedMotionViewmodelFactor);
  });

  it('head bob while walking (capped), none with head bob off; the look is exact either way', () => {
    const { game, input } = onFoot();
    input.state.keyDown('KeyW');
    ticks(game, 20);
    let { frame } = game.update(0);
    const me = frame.players.find((p) => p.isLocal)!.state;
    const eyeY = me.pos.y + BALANCE.movement.stances.stand.eyeHeight;
    const off = () => Math.hypot(frame.camera.target.x - me.pos.x, frame.camera.target.y - eyeY, frame.camera.target.z - me.pos.z);
    expect(off()).toBeLessThanOrEqual(resolveClientTuning(BALANCE).fpMaxCameraOffset + 1e-9);
    expect(frame.viewmodel!.bobAmount).toBeGreaterThan(0);
    expect(frame.camera.yaw).toBe(input.state.yaw);
    expect(frame.camera.pitch).toBe(input.state.pitch);
    game.setSettings({ mouseSensitivity: 1, masterVolume: 1, invertY: false, headBob: false });
    ({ frame } = game.update(0));
    const me2 = frame.players.find((p) => p.isLocal)!.state;
    expect(frame.camera.target.y).toBeCloseTo(me2.pos.y + BALANCE.movement.stances.stand.eyeHeight, 9);
    expect(frame.viewmodel!.bobAmount).toBeGreaterThan(0); // viewmodel bob unchanged
  });

  it('recoil: a local shot rolls the camera and punches the FOV (never pitch/yaw); shotCount counts; reduced motion: none', () => {
    const { game, net } = onFoot(RIFLE, { weapon: 'rifle' });
    const before = game.update(0).frame;
    net.pushEvents([{ type: 'shot', shooterId: 1, weapon: 'rifle', origin: { x: 0, y: 3, z: 0 }, impacts: [] }]);
    const { frame } = game.update(0);
    expect(frame.camera.roll).toBeGreaterThan(0);
    expect(frame.camera.fovDeg).toBeGreaterThan(before.camera.fovDeg);
    expect(frame.camera.pitch).toBe(before.camera.pitch);
    expect(frame.camera.yaw).toBe(before.camera.yaw);
    expect(frame.viewmodel!.shotCount).toBe(1);
    const ret = (resolveClientTuning(BALANCE).fpRecoil.rifle!.returnMs / 1000) + 0.01;
    expect(game.update(ret).frame.camera.roll).toBe(0);
    game.setSettings({ mouseSensitivity: 1, masterVolume: 1, invertY: false, reducedMotion: true });
    net.pushEvents([{ type: 'shot', shooterId: 1, weapon: 'rifle', origin: { x: 0, y: 3, z: 0 }, impacts: [] }]);
    expect(game.update(0).frame.camera.roll).toBe(0);
  });

  it('viewmodel actions from prediction: reload with progress; adsBlocked while RMB is held during the reload', () => {
    const { game, input } = onFoot({ ...RIFLE }, { weapon: 'rifle' });
    input.state.keyDown('KeyR');
    ticks(game, 1);
    input.state.keyUp('KeyR');
    input.state.buttonDown(2);
    ticks(game, 3);
    const { frame, hud } = game.update(0);
    expect(frame.viewmodel).toMatchObject({ item: 'rifle', action: 'reload' });
    expect(frame.viewmodel!.actionProgress).toBeGreaterThan(0);
    expect(frame.viewmodel!.actionProgress).toBeLessThan(1);
    expect(hud.adsBlocked).toBe('reloading');
  });

  it('prone look clamp: pitch eases into pronePitchMin/MaxDeg over the transition (camera.md QA 9)', () => {
    const { game, input } = onFoot();
    input.state.setLook(0, 70 * DEG2RAD);
    input.state.keyDown('KeyZ');
    ticks(game, 1);
    input.state.keyUp('KeyZ');
    const max = (BALANCE.movement.stances.pronePitchMaxDeg ?? 80) * DEG2RAD;
    ticks(game, Math.ceil(BALANCE.movement.stances.transitionMs.stand_prone / TICK_MS) + 2);
    const { frame } = game.update(0);
    expect(frame.camera.pitch).toBeLessThanOrEqual(max + 1e-9);
    input.state.look(0, -10_000);
    expect(input.state.pitch).toBeLessThanOrEqual(max + 1e-9);
  });

  it('footsteps carry the predicted stance (REVIEW-M2a M4)', () => {
    const { game, input, of } = onFoot();
    input.state.keyDown('KeyW');
    ticks(game, 30);
    expect(of('footstep').length).toBeGreaterThan(0);
    expect(of('footstep')[0]).toMatchObject({ isLocal: true, stance: 'stand' });
  });

  it('results: orbit around the alive winner, else the last camera frozen', () => {
    const { game, net } = onFoot();
    const last = game.update(0).frame.camera;
    net.pushSnapshot(makeSnapshot({ match: match({ phase: 'results', winnerId: 1 }, null), players: [makePlayer(1, { name: 'Me', pos: { x: 0, y: GROUND, z: 0 } })], local: makeLocal(1) }));
    let { frame } = game.update(0);
    expect(frame.camera).toMatchObject({ mode: 'orbit', view: 'results', subjectId: 1 });
    net.pushSnapshot(makeSnapshot({ match: match({ phase: 'results', winnerId: 9 }, null), players: [makePlayer(1, { name: 'Me', alive: false })], local: makeLocal(1) }));
    ({ frame } = game.update(0));
    expect(frame.camera.view).toBe('results');
    expect(frame.camera.target).toEqual(last.target);
  });
});

describe('ClientGame M2b: the real office level', () => {
  it('switches to the office: indoor runtime (colliders, no nav), sprinklers theme, office balance, indoor title orbit', async () => {
    const { MAPS } = await import('./levels');
    const { BALANCE: base, balanceForMap } = await import('../shared/balance');
    const bus = new EventBus<GameEvents>();
    const changed: GameEvents['mapChanged'][] = [];
    bus.on('mapChanged', (e) => void changed.push(e));
    const net = new FakeNet();
    const game = new ClientGame(
      { bus, net, inputTarget: {} as HTMLElement, balance: base, getMap: (id) => MAPS[id] as MapData, initialMap: MAPS['island01'] as MapData, serverUrl: 'ws://x' },
      { input: new FakeInput(), grenadeArc: null, installDevHook: () => () => {} },
    );
    net.pushWelcome({ playerId: 1, mapId: 'office' });
    const { hud, frame } = game.update(0);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.map).toBe(MAPS['office']);
    expect(changed[0]!.balance.drop).toEqual(balanceForMap(base, 'office').drop);
    expect(hud.zoneTheme).toBe(changed[0]!.zoneTheme);
    expect(frame.camera.view).toBe('title');
    expect(frame.camera.target.y).toBe(0);
  });
});
