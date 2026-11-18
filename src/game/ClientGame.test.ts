import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import type { ClientGameDeps } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import type { PlayerState, WorldSnapshot } from '../shared/types';
import { ClientGame } from './ClientGame';
import type { DevGameState } from './devHook';
import type { PredictStep } from './prediction';
import { FakeInput, FakeNet, makeLocal, makeMatch, makeMovement, makePlayer, makeSnapshot, makeZone, TEST_MAP } from './testFixtures';

const DT = 1 / BALANCE.net.simHz;

/** Toy movement: walk along +x at 6 m/s for moveRight (half speed while healing), grounded, never jumps. */
const toyStep: PredictStep = (state, input, status) => {
  const v = input.moveRight * 6 * (status.healing ? 0.5 : 1);
  return {
    state: { ...state, pos: { ...state.pos, x: state.pos.x + v * input.dt }, vel: { x: v, y: 0, z: 0 } },
    jumped: false,
    landed: false,
    landingSpeed: 0,
  };
};

function setup() {
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
    installDevHook: (read) => {
      dev.read = read;
      return () => {
        dev.removed = true;
      };
    },
  });
  const types = () => events.map((e) => e.type);
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  return { game, net, input, bus, events, types, of, dev };
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
    expect(frame.camera.mode).toBe('follow');
    expect(frame.camera.target.y).toBeCloseTo(BALANCE.player.eyeHeight);
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
      { type: 'damage', victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: { x: 0, y: 1, z: 0 }, hpAfter: 80, armorAfter: 0 },
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
    expect(frame.camera.mode).toBe('follow');

    ({ hud, frame } = game.update(BALANCE.match.deathScreenSeconds));
    expect(hud.spectate).toMatchObject({ targetId: 2, targetName: 'Crab' });
    expect(frame.camera.target.x).toBeCloseTo(10);
    expect(frame.players.find((p) => p.state.id === 2)?.isSpectateTarget).toBe(true);

    input.state.keyDown('Space');
    ({ hud } = game.update(0.016));
    expect(hud.spectate?.targetId).toBe(3);
    expect(of('spectateTargetChanged').map((e) => e.targetId)).toEqual([2, 3]);
    expect(net.sent.every((i) => !i.jump)).toBe(true);
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
    expect(of('interactPromptChanged')).toEqual([{ lootId: 7, item: 'rifle', qty: 1 }]);
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
    game.update(DT + 1e-6); // Q edge + first step at half speed
    input.state.keyUp('KeyQ');
    game.update(DT * 2); // still healing
    const { frame } = game.update(0);
    const me = frame.players.find((p) => p.isLocal)!;
    expect(net.sent.map((i) => i.useHeal)).toEqual([true, false, false]);
    // Rendered = previous fixed step (accumulator ~0): 2 steps at half speed (6 m/s would give 2 * 6 * DT).
    expect(me.state.pos.x).toBeCloseTo(2 * 3 * DT, 4);
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
    expect(s.players.map((p) => [p.id, p.name, p.isBot, p.alive])).toEqual([
      [1, 'Me', false, true],
      [2, 'Crab', true, true],
    ]);
  });
});
