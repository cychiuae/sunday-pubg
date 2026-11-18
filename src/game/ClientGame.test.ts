import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import type { ClientGameDeps } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import type { GrenadeArcView } from '../shared/contracts';
import type { GunId, MovementStepResult, PlayerState, Vec3, WeaponId, WorldSnapshot } from '../shared/types';
import { ClientGame } from './ClientGame';
import { resolveClientTuning } from './tuning';
import { adsFullFovDeg, fovBaseOf } from './fov';
import type { DevGameState } from './devHook';
import type { PredictStep } from './prediction';
import { FakeInput, FakeNet, makeLocal, makeMatch, makeMovement, makePlayer, makeSnapshot, makeZone, TEST_MAP, NO_DROP_STEP } from './testFixtures';

const DT = 1 / BALANCE.net.simHz;

/**
 * Toy movement: walk along +x at 6 m/s for moveRight (half speed while healing), grounded, never jumps.
 * M2a: C/Z start an instant-length (200 ms) transition to crouch/prone; `ads` with a gun in hand advances adsMs.
 */
const toyStep: PredictStep = (state, input, status) => {
  const v = input.moveRight * 6 * (status.healing ? 0.5 : 1);
  const dtMs = input.dt * 1000;
  let { stance, stanceFrom, stanceMs } = state;
  stanceMs = Math.max(0, stanceMs - dtMs);
  let stanceChanged: MovementStepResult['stanceChanged'] = null;
  if (input.stanceToggle && stanceMs === 0) {
    const to = input.stanceToggle === stance ? 'stand' : input.stanceToggle;
    stanceChanged = { from: stance, to, forced: false, durationMs: 200 };
    stanceFrom = stance;
    stance = to;
    stanceMs = 200;
  }
  const canAds = input.ads && status.held !== 'fists' && status.held !== 'grenade' && stanceMs === 0;
  const adsMs = canAds ? Math.min(BALANCE.weapons[status.held as WeaponId].adsTimeMs, state.adsMs + dtMs) : 0;
  return {
    state: { ...state, pos: { ...state.pos, x: state.pos.x + v * input.dt }, vel: { x: v, y: 0, z: 0 }, stance, stanceFrom, stanceMs, adsMs },
    jumped: false,
    landed: false,
    landingSpeed: 0,
    stanceChanged,
    stanceRefused: null,
    ...NO_DROP_STEP,
    adsEngaged: canAds,
  };
};

interface ArcCall {
  eye: Vec3;
  proneSettled: boolean;
  fuseRemainingMs: number;
}

function setup() {
  const arcCalls: ArcCall[] = [];
  const bus = new EventBus<GameEvents>();
  const events: { type: keyof GameEvents; payload: unknown }[] = [];
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    events.push({ type, payload });
    emit(type, payload);
  };
  const net = new FakeNet();
  const input = new FakeInput();
  const deps: ClientGameDeps = {
    bus,
    net,
    inputTarget: {} as HTMLElement,
    balance: BALANCE,
    getMap: () => TEST_MAP,
    initialMap: TEST_MAP,
    serverUrl: 'ws://test/ws',
  };
  const dev: { read: (() => DevGameState) | null; removed: boolean } = { read: null, removed: false };
  const game = new ClientGame(deps, {
    input,
    step: toyStep,
    surfaceAt: () => 'sand',
    grenadeArc: (eye, _yaw, _pitch, proneSettled, fuseRemainingMs): GrenadeArcView => {
      arcCalls.push({ eye, proneSettled, fuseRemainingMs });
      return { points: [eye], end: eye, endReason: 'time', radius: BALANCE.items.grenade.radius };
    },
    installDevHook: (read) => {
      dev.read = read;
      return () => {
        dev.removed = true;
      };
    },
  });
  const types = () => events.map((e) => e.type);
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  return { game, net, input, bus, events, types, of, dev, arcCalls };
}

function playing(localAlive = true, extra: Partial<WorldSnapshot> = {}, others: PlayerState[] = []): WorldSnapshot {
  return makeSnapshot({
    match: makeMatch({ phase: 'playing', aliveCount: 1 + others.filter((p) => p.alive).length }),
    players: [makePlayer(1, { name: 'Me', alive: localAlive }), ...others],
    local: makeLocal(1, { movement: makeMovement() }),
    ...extra,
  });
}

describe('ClientGame', () => {
  it('join connects with the server url; welcome sets joined/localId; status is emitted', () => {
    const { game, net, of } = setup();
    game.join('Sandy');
    expect(net.connects).toEqual([{ url: 'ws://test/ws', name: 'Sandy' }]);
    net.pushStatus('connecting');
    net.pushStatus('connected');
    net.pushWelcome({ playerId: 1 });
    const { hud, frame } = game.update(0.016);
    expect(of('connectionStatus').map((e) => e.status)).toEqual(['connecting', 'connected']);
    expect(hud.joined).toBe(true);
    expect(hud.connection).toBe('connected');
    expect(frame.localId).toBe(1);
    expect(frame.camera.mode).toBe('orbit');
  });

  it('does nothing on the bus until update() (handlers only queue)', () => {
    const { net, events } = setup();
    net.pushStatus('connected');
    expect(events).toHaveLength(0);
  });

  it('phase change, countdown, lobby -> playing flow', () => {
    const { game, net, of } = setup();
    net.pushStatus('connected');
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(makeSnapshot({ match: makeMatch({ phase: 'countdown', phaseEndsAt: 3_000 }) }));
    net.now = 0;
    game.update(0.016);
    net.now = 1_200;
    const { hud } = game.update(0.016);
    expect(hud.countdownSecondsLeft).toBe(2);
    expect(of('matchPhaseChanged')).toEqual([{ phase: 'countdown', prev: null, endsAt: 3_000 }]);
    expect(of('countdown').map((c) => c.secondsLeft)).toEqual([3, 2]);
  });

  it('sends one input per fixed step with increasing seq and predicts locally', () => {
    const { game, net, input } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0); // processes snapshot -> predictor active
    input.state.keyDown('KeyD');
    game.update(DT * 3 + 1e-6);
    expect(net.sent.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(net.sent.every((i) => i.moveRight === 1 && i.dt === DT)).toBe(true);
    const { frame } = game.update(0);
    const me = frame.players.find((p) => p.isLocal)!;
    // Rendered = lerp(previous step, current step, accumulator / SIM_DT); the accumulator is ~0 here.
    expect(me.state.pos.x).toBeCloseTo(2 * 6 * DT, 4);
    // M2b first person: the camera is at the eye, within fpMaxCameraOffset of head bob.
    expect(frame.camera).toMatchObject({ mode: 'follow', view: 'firstPerson', firstPerson: true, subjectId: 1 });
    const T = resolveClientTuning(BALANCE);
    const eye = { x: me.state.pos.x, y: me.state.pos.y + BALANCE.movement.stances.stand.eyeHeight, z: me.state.pos.z };
    const c = frame.camera.target;
    expect(Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z)).toBeLessThanOrEqual(T.fpMaxCameraOffset + 1e-9);
    expect(frame.viewmodel).toMatchObject({ playerId: 1, item: 'fists', action: 'idle', visible: true });
  });

  it('caps fixed steps per frame', () => {
    const { game, net } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0);
    game.update(1);
    expect(net.sent.length).toBeLessThanOrEqual(5);
  });

  it('reconciles: server ack + authoritative state, pending inputs replayed', () => {
    const { game, net, input } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0);
    input.state.keyDown('KeyD');
    game.update(DT * 4 + 1e-6); // 4 inputs, x = 0.8
    // Server processed 2 inputs but was blocked: authoritative x = 0.1.
    net.pushSnapshot(playing(true, { local: makeLocal(1, { lastProcessedInputSeq: 2, movement: makeMovement({ pos: { x: 0.1, y: 0, z: 0 } }) }) }));
    game.update(0);
    // 0.1 + 2 replayed * 0.2 = 0.5 predicted; rendered smoothly decays toward it.
    let { frame } = game.update(0);
    let me = frame.players.find((p) => p.isLocal)!;
    expect(me.state.pos.x).toBeGreaterThan(0.5);
    input.state.keyUp('KeyD');
    for (let i = 0; i < 10; i++) ({ frame } = game.update(0.05));
    me = frame.players.find((p) => p.isLocal)!;
    expect(me.state.pos.x).toBeCloseTo(0.5, 2);
  });

  it('does not send inputs outside playing or when dead', () => {
    const { game, net } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(makeSnapshot({ match: makeMatch({ phase: 'lobby' }) }));
    game.update(DT * 2);
    expect(net.sent).toHaveLength(0);
    net.pushSnapshot(playing(false));
    game.update(DT * 2);
    expect(net.sent).toHaveLength(0);
  });

  it('translates server events and emits localHitConfirmed after playerDamaged', () => {
    const { game, net, types } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, {}, [makePlayer(2, { name: 'Crab' })]));
    net.pushEvents([
      { type: 'damage', victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: { x: 0, y: 1, z: 0 }, hpAfter: 80, vest: null, helmet: null },
    ]);
    game.update(0);
    const t = types();
    expect(t.indexOf('playerDamaged')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('localHitConfirmed')).toBe(t.indexOf('playerDamaged') + 1);
  });

  it('death -> death screen on own body -> spectate killer after deathScreenSeconds; Space cycles', () => {
    const { game, net, input, of } = setup();
    const crab = makePlayer(2, { name: 'Crab', isBot: true, pos: { x: 10, y: 0, z: 0 } });
    const gull = makePlayer(3, { name: 'Gull', pos: { x: -10, y: 0, z: 0 } });
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, {}, [crab, gull]));
    game.update(0);
    net.pushEvents([{ type: 'kill', victimId: 1, killerId: 2, weapon: 'smg', cause: 'weapon', placement: 3 }]);
    net.pushSnapshot(playing(false, {}, [crab, gull]));
    let { hud, frame } = game.update(0.016);
    expect(of('playerKilled')[0]).toMatchObject({ isLocalVictim: true, killerName: 'Crab' });
    expect(hud.spectate).toBeNull();
    // M2b: the death cam orbits the killer (alive, within 30 m) for deathScreenSeconds.
    expect(frame.camera).toMatchObject({ mode: 'orbit', view: 'death', subjectId: 2 });
    expect(frame.viewmodel).toBeNull();
    expect(hud.cameraView).toBe('orbit');

    ({ hud, frame } = game.update(BALANCE.match.deathScreenSeconds));
    expect(hud.spectate).toMatchObject({ targetId: 2, targetName: 'Crab' });
    expect(frame.camera.target.x).toBeCloseTo(10);
    expect(frame.players.find((p) => p.state.id === 2)?.isSpectateTarget).toBe(true);
    // M2b: FP spectate from their eye with their viewmodel; V toggles the chase cam.
    expect(frame.camera).toMatchObject({ view: 'firstPerson', subjectId: 2, firstPerson: true });
    expect(frame.viewmodel?.playerId).toBe(2);
    expect(hud.spectate?.view).toBe('firstPerson');
    input.state.keyDown('KeyV');
    ({ hud, frame } = game.update(0.016));
    expect(frame.camera).toMatchObject({ view: 'chase', subjectId: 2, firstPerson: false });
    expect(frame.viewmodel).toBeNull();
    expect(hud.spectate?.view).toBe('chase');
    expect(hud.cameraView).toBe('chase');
    input.state.keyUp('KeyV');

    input.state.keyDown('Space');
    ({ hud } = game.update(0.016));
    expect(hud.spectate?.targetId).toBe(3);
    expect(of('spectateTargetChanged').map((e) => e.targetId)).toEqual([2, 3]);
    expect(net.sent.every((i) => !i.jump)).toBe(true);
  });

  it('requestSpectate skips the rest of the death screen (BUG-001); no-op while alive', () => {
    const { game, net, of } = setup();
    const crab = makePlayer(2, { name: 'Crab', isBot: true, pos: { x: 10, y: 0, z: 0 } });
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, {}, [crab]));
    game.update(0);
    game.requestSpectate(); // alive: ignored
    expect(game.update(0.016).hud.spectate).toBeNull();

    net.pushEvents([{ type: 'kill', victimId: 1, killerId: 2, weapon: 'smg', cause: 'weapon', placement: 2 }]);
    net.pushSnapshot(playing(false, {}, [crab]));
    expect(game.update(0.016).hud.spectate).toBeNull(); // death card
    game.requestSpectate();
    game.requestSpectate(); // idempotent
    const { hud, frame } = game.update(0.016); // well before deathScreenSeconds
    expect(hud.spectate).toMatchObject({ targetId: 2, targetName: 'Crab' });
    expect(frame.camera.target.x).toBeCloseTo(10);
    expect(of('spectateTargetChanged')).toEqual([{ targetId: 2, targetName: 'Crab' }]);
  });

  it('mid-match joiner (local = null) spectates immediately', () => {
    const { game, net } = setup();
    net.pushWelcome({ playerId: 9 });
    net.pushSnapshot(makeSnapshot({ match: makeMatch({ phase: 'playing' }), players: [makePlayer(2, { name: 'Crab' })], local: null }));
    const { hud } = game.update(0.016);
    expect(hud.local).toBeNull();
    expect(hud.spectate?.targetId).toBe(2);
  });

  it('interact prompt for the nearest loot in pickup range, highlighted in the frame', () => {
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, { loot: [{ id: 7, item: 'rifle', qty: 1, pos: { x: 1, y: 0, z: 0 } }] }));
    game.update(0);
    const { frame } = game.update(0.016);
    expect(of('interactPromptChanged')).toEqual([{ lootId: 7, item: 'rifle', qty: 1, durability: null, maxDurability: null, refusal: null }]);
    expect(frame.highlightLootId).toBe(7);
  });

  it('zone: zoneChanged on first zone and localZoneStatusChanged when outside', () => {
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1 });
    const zone = makeZone({ center: { x: 100, z: 0 }, radius: 10 });
    net.pushSnapshot(playing(true, { zone }));
    const { hud } = game.update(0.016);
    expect(of('zoneChanged')).toHaveLength(1);
    expect(of('localZoneStatusChanged')).toEqual([{ outside: true }]);
    expect(hud.local?.outsideZone).toBe(true);
  });

  it('dryFire on trigger press with an empty magazine', () => {
    const { game, net, input, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, { local: makeLocal(1, { slots: [{ weapon: 'pistol', mag: 0 }, null], activeSlot: 0 }) }));
    game.update(0);
    input.state.buttonDown(0);
    game.update(DT + 1e-6);
    expect(of('dryFire')).toEqual([{ weapon: 'pistol' }]);
  });

  it('settings apply sensitivity to look', () => {
    const { game, input } = setup();
    game.setSettings({ mouseSensitivity: 2, invertY: false, masterVolume: 1 });
    input.state.look(100, 0);
    expect(input.state.yaw).toBeCloseTo(-100 * 0.002 * 2);
  });

  it('disconnect resets to not joined and emits status', () => {
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0);
    net.pushStatus('disconnected', 'closed');
    const { hud, frame } = game.update(0.016);
    expect(of('connectionStatus').at(-1)).toEqual({ status: 'disconnected', reason: 'closed' });
    expect(hud.joined).toBe(false);
    expect(hud.local).toBeNull();
    expect(frame.camera.mode).toBe('orbit');
    game.playAgain();
    expect(net.connects).toHaveLength(0); // never joined by name in this test
  });

  it('dispose disconnects, releases input and removes the dev hook', () => {
    const { game, net, input, dev } = setup();
    game.dispose();
    expect(net.status).toBe('disconnected');
    expect(input.disposed).toBe(true);
    expect(dev.removed).toBe(true);
  });

  it('HUD carries the camera FOV of this frame and the death screen length', () => {
    const { game, net } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    const { hud, frame } = game.update(0.016);
    expect(hud.cameraFovDeg).toBe(frame.camera.fovDeg);
    expect(hud.deathScreenSeconds).toBe(BALANCE.match.deathScreenSeconds);
  });

  it('heal slow-down is predicted from the Q press, not from a later snapshot (REVIEW-M1 m1)', () => {
    const { game, net, input } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(
      playing(true, {
        players: [makePlayer(1, { name: 'Me', hp: 40 })],
        local: makeLocal(1, { heals: { bandage: 1, medkit: 0 } }),
      }),
    );
    game.update(0);
    input.state.keyDown('KeyD');
    input.state.keyDown('KeyQ');
    game.update(DT + 1e-6); // Q edge (heal starts after this step's movement)
    input.state.keyUp('KeyQ');
    game.update(DT * 2); // still healing
    const { frame } = game.update(0);
    const me = frame.players.find((p) => p.isLocal)!;
    expect(net.sent.map((i) => i.useHeal)).toEqual([true, false, false]);
    // Rendered = previous fixed step (accumulator ~0). M2a World order: movement runs before the tick's edges, so
    // the Q tick moves at full speed and the next one already at half speed (no snapshot needed): 6 * DT + 3 * DT.
    expect(me.state.pos.x).toBeCloseTo((6 + 3) * DT, 4);
  });

  it('dev hook: plain read-only game state for E2E tests', () => {
    const { game, net, input, dev } = setup();
    net.pushStatus('connected');
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, { match: makeMatch({ matchId: 4, aliveCount: 2, totalPlayers: 2 }) }, [makePlayer(2, { name: 'Crab', isBot: true })]));
    game.update(0);
    input.state.keyDown('KeyD');
    game.update(DT * 2 + 1e-6);
    const s = dev.read!();
    expect(s).toMatchObject({
      connection: 'connected',
      joined: true,
      phase: 'playing',
      matchId: 4,
      localId: 1,
      localAlive: true,
      localHp: 100,
      localWeapon: 'fists',
      aliveCount: 2,
      totalPlayers: 2,
      pendingInputs: 2,
      lastCorrection: 0,
    });
    expect(s.localPos!.x).toBeGreaterThan(0);
    input.state.setLook(0.5, -0.25);
    expect(dev.read!()).toMatchObject({ localYaw: 0.5, localPitch: -0.25 });
    expect(s.players.map((p) => [p.id, p.name, p.isBot, p.alive])).toEqual([
      [1, 'Me', false, true],
      [2, 'Crab', true, true],
    ]);
  });

  // -----------------------------------------------------------------------------------------------
  // M2a
  // -----------------------------------------------------------------------------------------------

  /** Runs `n` fixed steps one frame at a time (update() caps steps per frame). */
  const ticks = (game: ClientGame, n: number): void => {
    for (let i = 0; i < n; i++) game.update(DT + 1e-9);
  };

  const withGun = (weapon: GunId, extra: Partial<WorldSnapshot> = {}): WorldSnapshot =>
    playing(true, {
      players: [makePlayer(1, { name: 'Me', weapon })],
      local: makeLocal(1, { slots: [{ weapon, mag: 5 }, null], activeSlot: 0 }),
      ...extra,
    });

  it('stance: C emits the local stanceChanged from prediction; the server echo is ignored; camera and HUD follow', () => {
    const { game, net, input, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0);
    input.state.keyDown('KeyC');
    game.update(DT + 1e-6);
    expect(net.sent[0]!.stanceToggle).toBe('crouch');
    expect(of('stanceChanged')).toEqual([
      { playerId: 1, from: 'stand', to: 'crouch', forced: false, durationMs: 200, pos: expect.any(Object), isLocal: true },
    ]);
    net.pushEvents([{ type: 'stanceChange', playerId: 1, from: 'stand', to: 'crouch', forced: false, durationMs: 200 }]);
    const mid = game.update(DT * 2);
    expect(of('stanceChanged')).toHaveLength(1);
    expect(mid.hud.local).toMatchObject({ stance: 'crouch', stanceFrom: 'stand' });
    expect(mid.hud.local!.stanceProgress).toBeGreaterThan(0);
    expect(mid.hud.local!.stanceProgress).toBeLessThan(1);
    const S = BALANCE.movement.stances;
    expect(mid.frame.camera.target.y).toBeLessThan(S.stand.eyeHeight);
    expect(mid.frame.camera.target.y).toBeGreaterThan(S.crouch.eyeHeight);
    const done = game.update(DT * 6);
    expect(done.frame.camera.target.y).toBeCloseTo(S.crouch.eyeHeight, 5);
    expect(done.frame.players.find((p) => p.isLocal)!.state).toMatchObject({ stance: 'crouch', stanceProgress: 1 });
  });

  it('ADS (hold): RMB aims from prediction, zooms the camera, scales look, emits localAdsChanged in and out', () => {
    const { game, net, input, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(withGun('rifle'));
    game.update(0);
    input.state.buttonDown(2);
    game.update(DT * 3 + 1e-6);
    expect(net.sent.every((i) => i.ads)).toBe(true);
    let { frame, hud } = game.update(0);
    expect(frame.ads).not.toBeNull();
    expect(hud.ads).toBe(frame.ads);
    expect(frame.ads!.sight).toBe('red_dot');
    expect(frame.ads!.progress).toBeGreaterThan(0);
    const playerFov = fovBaseOf(undefined).playerDeg;
    expect(frame.camera.fovDeg).toBeLessThan(playerFov);
    expect(frame.camera.firstPerson).toBe(true);
    expect(frame.viewmodel!.adsBlend).toBe(frame.ads!.cameraBlend);
    expect(input.state.currentLookScale).toBeCloseTo(1 / frame.ads!.zoom);
    expect(of('localAdsChanged')).toEqual([{ engaged: true, weapon: 'rifle', sight: 'red_dot' }]);
    expect(hud.crosshairSpreadDeg).toBeLessThan(BALANCE.weapons.rifle.spreadDeg);

    input.state.buttonUp(2);
    ({ frame } = game.update(DT + 1e-6));
    expect(of('localAdsChanged').at(-1)).toEqual({ engaged: false, weapon: 'rifle', sight: 'red_dot' });
    expect(frame.ads!.progress).toBe(0);
    ({ frame } = game.update(1));
    expect(frame.ads!.cameraBlend).toBe(0);
    expect(frame.camera.fovDeg).toBeCloseTo(fovBaseOf(undefined).playerDeg);
    expect(input.state.currentLookScale).toBe(1);
  });

  it('ADS sensitivity setting multiplies look speed at full zoom', () => {
    const { game, net, input } = setup();
    game.setSettings({ mouseSensitivity: 1, invertY: false, masterVolume: 1, adsSensitivity: 2 });
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(withGun('rifle'));
    game.update(0);
    input.state.buttonDown(2);
    ticks(game, 10);
    const { frame } = game.update(0);
    expect(frame.ads!.progress).toBe(1);
    // At the default FOV the look divisor equals the sight magnification.
    expect(input.state.currentLookScale).toBeCloseTo(2 / BALANCE.weapons.rifle.adsZoom);
  });

  it('scoped sniper: after adsTimeMs the camera is first person at the eye; the dev hook reports it', () => {
    const { game, net, input, dev } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(withGun('sniper'));
    game.update(0);
    input.state.buttonDown(2);
    ticks(game, Math.ceil(BALANCE.weapons.sniper.adsTimeMs / (DT * 1000)) + 1);
    const { frame } = game.update(0);
    expect(frame.ads).toMatchObject({ sight: 'scope_8x', progress: 1, scoped: true });
    expect(frame.camera).toMatchObject({ firstPerson: true, distance: 0, shoulderOffset: 0 });
    expect(frame.camera.fovDeg).toBeCloseTo(adsFullFovDeg(fovBaseOf(undefined).defaultDeg, BALANCE.weapons.sniper.adsZoom));
    // The viewmodel hides under the scope overlay.
    expect(frame.viewmodel!.visible).toBe(false);
    expect(dev.read!()).toMatchObject({ ads: true, adsProgress: 1, scoped: true, sight: 'scope_8x', cameraFirstPerson: true });
  });

  it('ADS toggle mode: one RMB click keeps aiming; death clears the latch', () => {
    const { game, net, input } = setup();
    game.setSettings({ mouseSensitivity: 1, invertY: false, masterVolume: 1, adsMode: 'toggle' });
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(withGun('rifle'));
    game.update(0.001);
    input.state.buttonDown(2);
    input.state.buttonUp(2);
    game.update(DT * 3);
    expect(net.sent.slice(-2).every((i) => i.ads)).toBe(true);
    net.pushEvents([{ type: 'kill', victimId: 1, killerId: null, weapon: null, cause: 'zone', placement: 2 }]);
    game.update(0);
    expect(input.state.adsActive).toBe(false);
  });

  it('grenades: snapshot and grenadeThrown entities are extrapolated into the frame; explosion removes them; danger list', () => {
    const { game, net } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(
      playing(true, {
        serverTime: 0,
        grenades: [{ id: 1, ownerId: 2, pos: { x: 3, y: 0.1, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 3_000, inWater: false }],
      }),
    );
    net.pushEvents(
      [{ type: 'grenadeThrown', id: 2, ownerId: 2, pos: { x: 40, y: 20, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 3_100, dropped: false }],
      10,
    );
    let { frame, hud } = game.update(0.016);
    expect(frame.grenades.map((g) => g.id)).toEqual([1, 2]);
    expect(frame.grenades[0]).toMatchObject({ resting: true, explodesAt: 3_000 });
    expect(hud.grenadeDanger.map((d) => d.id)).toEqual([1]);
    expect(hud.grenadeDanger[0]!.distance).toBeCloseTo(3);
    expect(hud.grenadeDanger[0]!.bearing).toBeCloseTo(Math.PI / 2); // +X is to the right at yaw 0
    net.pushEvents([{ type: 'explosion', id: 1, ownerId: 2, pos: { x: 3, y: 0.1, z: 0 }, radius: 6, inHand: false }]);
    ({ frame, hud } = game.update(0.016));
    expect(frame.grenades.map((g) => g.id)).toEqual([2]);
    expect(hud.grenadeDanger).toEqual([]);
  });

  it('explosion.localDistance is measured from the predicted eye', () => {
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing());
    game.update(0);
    const eye = BALANCE.movement.stances.stand.eyeHeight;
    net.pushEvents([{ type: 'explosion', id: 1, ownerId: 2, pos: { x: 0, y: eye, z: 4 }, radius: 6, inHand: false }]);
    game.update(0);
    expect(of('explosion')[0]!.localDistance).toBeCloseTo(4);
  });

  it('grenade slot: arc preview while ready; LMB cooks (predicted ring), release throws, recovery hides the arc', () => {
    const { game, net, input, arcCalls, dev } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(
      playing(true, {
        players: [makePlayer(1, { name: 'Me', weapon: 'grenade' })],
        local: makeLocal(1, { activeSlot: 3, grenades: 2 }),
      }),
    );
    let { frame, hud } = game.update(0);
    expect(frame.grenadeArc).not.toBeNull();
    expect(arcCalls.at(-1)!.fuseRemainingMs).toBe(BALANCE.items.grenade.fuseMs);
    expect(arcCalls.at(-1)!.eye.y).toBeCloseTo(BALANCE.movement.stances.stand.eyeHeight);
    expect(hud.local!.slots[3]).toEqual({ slot: 3, weapon: 'grenade', mag: null, count: 2 });
    expect(hud.crosshairSpreadDeg).toBe(0);

    input.state.buttonDown(0);
    net.now = 200;
    ({ frame, hud } = game.update(DT * 3 + 1e-6));
    expect(hud.local!.cook).not.toBeNull();
    expect(hud.local!.cook!.fuseRemainingMs).toBeLessThan(BALANCE.items.grenade.fuseMs);
    expect(frame.grenadeArc).not.toBeNull();
    expect(arcCalls.at(-1)!.fuseRemainingMs).toBeLessThan(BALANCE.items.grenade.fuseMs);
    expect(frame.players.find((p) => p.isLocal)!.state.anim.cooking).toBe(true);
    expect(dev.read!()).toMatchObject({ cooking: true, grenadeArc: true, localWeapon: 'grenade' });

    input.state.buttonUp(0);
    ({ frame, hud } = game.update(DT + 1e-6));
    expect(hud.local!.cook).toBeNull();
    expect(frame.grenadeArc).toBeNull(); // throw recovery
    ticks(game, Math.ceil(BALANCE.items.grenade.throwRecoveryMs / (DT * 1000)) + 1);
    ({ frame } = game.update(0));
    expect(frame.grenadeArc).not.toBeNull();
  });

  it('wheel reaches the grenade slot only while carrying grenades; keys 4/G send slot 3', () => {
    const { game, net, input } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(playing(true, { local: makeLocal(1, { activeSlot: 2, grenades: 1 }) }));
    game.update(0);
    input.state.wheel(120);
    game.update(DT + 1e-6);
    expect(net.sent.at(-1)!.selectSlot).toBe(3);
    input.state.keyDown('KeyG');
    game.update(DT);
    expect(net.sent.at(-1)!.selectSlot).toBe(3);
  });

  it('interact prompt predicts the betterArmor refusal and carries durability', () => {
    const { game, net, of } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(
      playing(true, {
        local: makeLocal(1, { vest: { tier: 2, durability: 40 } }),
        loot: [{ id: 8, item: 'vest_1', qty: 1, pos: { x: 1, y: 0, z: 0 }, durability: 20 }],
      }),
    );
    game.update(0.016);
    expect(of('interactPromptChanged')).toEqual([{ lootId: 8, item: 'vest_1', qty: 1, durability: 20, maxDurability: BALANCE.items.vest_1.durability, refusal: 'betterArmor' }]);
  });

  it('dev hook: M2a armor, grenade and stance fields', () => {
    const { game, net, dev } = setup();
    net.pushWelcome({ playerId: 1 });
    net.pushSnapshot(
      playing(true, {
        players: [makePlayer(1, { name: 'Me', vestTier: 2, helmetTier: 1 })],
        local: makeLocal(1, { vest: { tier: 2, durability: 30 }, helmet: { tier: 1, durability: 12 }, grenades: 3 }),
        grenades: [{ id: 5, ownerId: 1, pos: { x: 9, y: 0, z: 9 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 900, inWater: false }],
      }),
    );
    game.update(0.016);
    expect(dev.read!()).toMatchObject({
      stance: 'stand',
      stanceFrom: 'stand',
      stanceProgress: 1,
      ads: false,
      adsProgress: 0,
      vestTier: 2,
      helmetTier: 1,
      vestDurability: 30,
      helmetDurability: 12,
      grenades: 3,
      cooking: false,
      liveGrenades: [{ id: 5, ownerId: 1, pos: { x: 9, y: 0, z: 9 }, resting: true, explodesAt: 900 }],
      cameraFirstPerson: true,
      cameraView: 'firstPerson',
      viewmodel: { item: 'fists', action: 'idle', visible: true },
    });
    expect(dev.read!().cameraEyeHeight).toBeCloseTo(BALANCE.movement.stances.stand.eyeHeight);
    expect(dev.read!().players[0]).toMatchObject({ vestTier: 2, helmetTier: 1, stance: 'stand', weapon: 'fists' });
  });
});
