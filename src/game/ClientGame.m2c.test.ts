/**
 * M2c ClientGame (ADR 0007, ARCHITECTURE §16.5 G-client): per-match layout on welcome, the T key and predicted sight,
 * the predicted throwable cycle and melee swing, rockets, smoke (inSmoke, smokeHidden, obscured), broken glass,
 * frag-only danger, kill weapon for rocket blasts, and the M2c prompt fields. Real shared movement on TEST_MAP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BALANCE, effectiveWeapon } from '../shared/balance';
import type { ClientGameDeps } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import { LAYOUT_FORMAT_VERSION } from '../shared/layout';
import { rocketPosAt } from '../shared/rocket';
import type { LocalPlayerState, MapData, MatchLayout, MatchState, PlayerState, RocketState, SimEvent, SmokeCloudState, WorldSnapshot } from '../shared/types';
import { ClientGame } from './ClientGame';
import type { DevGameState } from './devHook';
import { LayoutMismatchError, type LayoutMismatchMode } from './layoutClient';
import { FakeInput, FakeNet, makeLocal, makeMatch, makeMovement, makePlayer, makeSnapshot, TEST_LAYOUT_REF, TEST_MAP } from './testFixtures';

const DT = 1 / BALANCE.net.simHz;
const GROUND = TEST_MAP.baseHeight;
const CLOUD = BALANCE.items.smoke.cloud;

interface SetupOpts {
  buildLayout?: ClientGameDeps['buildLayout'];
  getMap?: (id: string) => MapData;
  layoutMismatch?: LayoutMismatchMode;
}

function setup(opts: SetupOpts = {}) {
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
    getMap:
      opts.getMap ??
      ((id) => {
        if (id !== 'test') throw new Error(`no map ${id}`);
        return TEST_MAP;
      }),
    initialMap: TEST_MAP,
    serverUrl: 'ws://test/ws',
    ...(opts.buildLayout ? { buildLayout: opts.buildLayout } : {}),
  };
  const dev: { read: (() => DevGameState) | null } = { read: null };
  const game = new ClientGame(deps, {
    input,
    surfaceAt: () => 'sand',
    grenadeArc: null,
    ...(opts.layoutMismatch ? { layoutMismatch: opts.layoutMismatch } : {}),
    installDevHook: (read) => {
      dev.read = read;
      return () => {};
    },
  });
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  /** What `window.__game` returns (installDevHook structured-clones the read). */
  const devState = (): DevGameState => structuredClone(dev.read!());
  return { game, net, input, events, of, devState, devRead: () => dev.read!() };
}

const match = (over: Partial<MatchState> = {}): MatchState =>
  Object.assign(makeMatch({ phase: 'playing', ...over }), { mapId: 'test', route: null, aboardCount: 0 });

function groundSnap(over: Partial<LocalPlayerState> = {}, player: Partial<PlayerState> = {}, snap: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return makeSnapshot({
    match: match(),
    players: [makePlayer(1, { name: 'Me', pos: { x: 0, y: GROUND, z: 0 }, ...player })],
    local: makeLocal(1, { movement: makeMovement({ pos: { x: 0, y: GROUND, z: 0 } }), ...over }),
    ...snap,
  });
}

function start(o: ReturnType<typeof setup>, snap: WorldSnapshot): void {
  o.net.pushWelcome({ playerId: 1, mapId: 'test' });
  o.net.pushSnapshot(snap);
  o.game.update(0);
}

const step = (game: ClientGame) => game.update(DT + 1e-9);

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------

const layoutFor = (seed: number, over: Partial<MatchLayout> = {}): MatchLayout => ({
  version: LAYOUT_FORMAT_VERSION,
  mapId: 'test',
  seed,
  picks: [{ zone: 'z', variant: `v${seed}` }],
  look: 'golden',
  props: [],
  lootSpawns: [],
  hash: TEST_LAYOUT_REF.hash,
  fallbacks: 0,
  decor: [{ kind: 'starfish', x: 1, y: 0, z: 2, rotY: 0, scale: 1 }],
  ...over,
});

describe('ClientGame M2c: per-match layout (ADR 0007 §1.5)', () => {
  it('builds the layout from welcome.layout.seed, emits mapChanged per match with the applied map, layout and look', () => {
    const applied = { ...TEST_MAP, hills: [{ x: 1, z: 1, radius: 5, height: 1 }] } as MapData;
    const build = vi.fn((_base: MapData, seed: number) => ({ layout: layoutFor(seed), map: applied }));
    const o = setup({ buildLayout: build });
    o.net.pushWelcome({ playerId: 1, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 11, look: 'golden' } });
    const { hud, frame } = o.game.update(0);
    expect(build).toHaveBeenCalledWith(TEST_MAP, 11);
    const [mc] = o.of('mapChanged');
    expect(mc).toMatchObject({ mapId: 'test', map: applied, look: 'golden' });
    expect(mc!.layout?.seed).toBe(11);
    expect(hud.layout).toEqual({ seed: 11, look: 'golden' });
    expect(hud.minimap.layout).toMatchObject({ seed: 11 });
    expect(hud.minimap.map).toBe(applied);
    expect(frame.look).toBe('golden');
    // Same map and seed (mid-match rejoin): no rebuild. A new seed (next match): rebuild and emit again.
    o.net.pushWelcome({ playerId: 2, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 11, look: 'golden' } });
    o.game.update(0);
    expect(o.of('mapChanged')).toHaveLength(1);
    o.net.pushWelcome({ playerId: 3, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 12, look: 'golden' } });
    o.game.update(0);
    expect(o.of('mapChanged').map((e) => e.layout?.seed)).toEqual([11, 12]);
  });

  it('a hash mismatch throws from update() in tests (LayoutMismatchError)', () => {
    const o = setup({ buildLayout: (_b, seed) => ({ layout: layoutFor(seed, { hash: 999 }), map: TEST_MAP }) });
    o.net.pushWelcome({ playerId: 1, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 5 } });
    expect(() => o.game.update(0)).toThrow(LayoutMismatchError);
  });

  it('getMap returning undefined does not crash the welcome (runtimeFor guard)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = setup({ getMap: () => undefined as unknown as MapData });
    o.net.pushWelcome({ playerId: 1, mapId: 'ghost' });
    expect(() => o.game.update(0)).not.toThrow();
    expect(o.of('mapChanged')).toEqual([]);
    expect(err).toHaveBeenCalled();
  });
});

describe('ClientGame M2c: T sight switch (scopes.md, UI M2c §16.4)', () => {
  it('KeyT and cycleScope() send the cycleScope edge once; the HUD shows the target sight in the same frame', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 0, slots: [{ weapon: 'rifle', mag: 30, level: 2, scope: null }, null], spareScope: 'scope_4x' }, { weapon: 'rifle', weaponLevel: 2, sight: 'red_dot' }));
    o.input.state.keyDown('KeyT');
    const { hud } = step(o.game);
    expect(o.net.sent.filter((i) => i.cycleScope === true)).toHaveLength(1);
    expect(hud.local!.slots[0]).toMatchObject({ weapon: 'rifle', level: 2, scope: 'scope_4x', sight: 'scope_4x', builtInSight: 'red_dot' });
    expect(hud.local!.scopeStash).toEqual([]);
    expect(hud.local!.scopeSwapProgress).not.toBeNull();
    expect(hud.local!.slots[0]!.compatibleScopes).toEqual(BALANCE.scopes.compatible.rifle);
    o.input.state.keyUp('KeyT');
    step(o.game);
    expect(o.net.sent.filter((i) => i.cycleScope === true)).toHaveLength(1);
    o.game.cycleScope();
    step(o.game);
    expect(o.net.sent.filter((i) => i.cycleScope === true)).toHaveLength(2);
    expect(o.net.sent.at(-2)!.cycleScope).toBeUndefined();
  });
});

describe('ClientGame M2c: throwable slot (grenades.md "Throwable slot")', () => {
  it('G on the held slot cycles at once: throwableCycled, throwableSelected and slot 3 follow the prediction', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 3, grenades: 2, smokes: 1 }, { weapon: 'grenade' }));
    let { hud } = step(o.game);
    expect(hud.local!.throwableSelected).toBe('grenade');
    expect(hud.local!.throwables).toEqual({ grenade: 2, smoke: 1 });
    expect(hud.local!.throwableMax).toEqual({ grenade: BALANCE.items.grenade.maxCarry, smoke: BALANCE.items.smoke.maxCarry });
    o.input.state.keyDown('KeyG');
    ({ hud } = step(o.game));
    expect(o.of('throwableCycled')).toEqual([{ from: 'grenade', to: 'smoke' }]);
    expect(hud.local!.throwableSelected).toBe('smoke');
    expect(hud.local!.slots[3]).toMatchObject({ weapon: 'smoke', count: 1 });
    expect(hud.local!.weapon).toBe('smoke');
  });

  it('grenadeDanger lists frags only', () => {
    const o = setup();
    start(o, groundSnap());
    o.net.pushSnapshot(
      groundSnap({}, {}, {
        grenades: [
          { id: 1, ownerId: 2, pos: { x: 2, y: GROUND, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 3_000, inWater: false, kind: 'smoke' },
          { id: 2, ownerId: 2, pos: { x: 3, y: GROUND, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt: 3_000, inWater: false, kind: 'grenade' },
        ],
      }),
    );
    const { hud, frame } = o.game.update(0);
    expect(frame.grenades.map((g) => g.kind)).toEqual(['smoke', 'grenade']);
    expect(hud.grenadeDanger.map((d) => d.id)).toEqual([2]);
  });
});

describe('ClientGame M2c: melee (melee.md)', () => {
  it('LMB with a melee weapon: local meleeSwing from prediction, recovery ring, swing view; the echo is ignored', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 2, melee: { weapon: 'knife', level: 3 } }, { weapon: 'knife', weaponLevel: 3 }));
    let { hud } = step(o.game);
    expect(hud.local!.slots[2]).toMatchObject({ weapon: 'knife', level: 3 });
    expect(hud.local!.weaponLevel).toBe(3);
    o.input.state.buttonDown(0);
    let frame;
    ({ hud, frame } = step(o.game));
    const eff = effectiveWeapon(BALANCE, 'knife', 3);
    expect(o.of('meleeSwing')).toEqual([
      expect.objectContaining({ playerId: 1, weapon: 'knife', level: 3, windupMs: eff.hitFrameMs, cycleMs: eff.fireIntervalMs, isLocal: true }),
    ]);
    expect(hud.local!.meleeRecovery).not.toBeNull();
    expect(frame.players.find((p) => p.isLocal)!.swing).toMatchObject({ weapon: 'knife' });
    expect(frame.viewmodel).toMatchObject({ action: 'swing', item: 'knife', level: 3 });
    o.net.pushEvents([{ type: 'meleeSwing', playerId: 1, weapon: 'knife', level: 3, pos: { x: 0, y: GROUND, z: 0 }, hitAt: o.net.now + eff.hitFrameMs, cycleMs: eff.fireIntervalMs }]);
    o.game.update(0);
    expect(o.of('meleeSwing')).toHaveLength(1);
  });

  it('a remote meleeSwing becomes a bus event and PlayerView.swing', () => {
    const o = setup();
    start(o, groundSnap({}, {}, { players: [makePlayer(1, { pos: { x: 0, y: GROUND, z: 0 } }), makePlayer(2, { pos: { x: 3, y: GROUND, z: 0 }, weapon: 'paddle' })] }));
    o.net.now = 1_000;
    const eff = effectiveWeapon(BALANCE, 'paddle', 1);
    const hitAt = 1_000 - BALANCE.net.interpolationDelayMs + eff.hitFrameMs;
    o.net.pushEvents([{ type: 'meleeSwing', playerId: 2, weapon: 'paddle', level: 1, pos: { x: 3, y: GROUND, z: 0 }, hitAt, cycleMs: eff.fireIntervalMs }]);
    const { frame } = o.game.update(0);
    expect(o.of('meleeSwing')[0]).toMatchObject({ playerId: 2, isLocal: false });
    expect(frame.players.find((p) => p.state.id === 2)!.swing).toMatchObject({ weapon: 'paddle', progress: 0 });
  });
});

describe('ClientGame M2c: rockets, smoke and glass (ADR 0007 §4, §6, §7)', () => {
  const rocket: RocketState = { id: 7, ownerId: 2, level: 3, pos: { x: 0, y: 5, z: 0 }, vel: { x: 45, y: 0, z: 0 }, firedAt: 0 };

  it('FrameView.rockets uses rocketPosAt at serverTime; a rocket explosion ends it and the kill weapon is rpg', () => {
    const o = setup();
    start(o, groundSnap({}, {}, { rockets: [rocket], players: [makePlayer(1, { pos: { x: 0, y: GROUND, z: 0 } }), makePlayer(2), makePlayer(3)] }));
    o.net.now = 200;
    let { frame } = o.game.update(0);
    expect(frame.rockets).toEqual([
      expect.objectContaining({ id: 7, level: 3, pos: rocketPosAt(rocket, 200, BALANCE.weapons.rpg.rocket.gravity), origin: rocket.pos }),
    ]);
    const evs: SimEvent[] = [
      { type: 'explosion', id: 7, ownerId: 2, pos: { x: 9, y: 5, z: 0 }, radius: 5, inHand: false, source: 'rocket' },
      { type: 'damage', victimId: 3, attackerId: 2, amount: 110, headshot: false, cause: 'explosion', sourcePos: { x: 9, y: 5, z: 0 }, hpAfter: 0, vest: null, helmet: null, grenadeId: 7 },
      { type: 'kill', victimId: 3, killerId: 2, weapon: null, cause: 'explosion', placement: 3 },
    ];
    o.net.pushEvents(evs);
    ({ frame } = o.game.update(0));
    expect(frame.rockets).toEqual([]);
    expect(o.of('explosion')[0]).toMatchObject({ source: 'rocket' });
    expect(o.of('playerDamaged')[0]).toMatchObject({ weapon: 'rpg' });
    expect(o.of('playerKilled')[0]).toMatchObject({ weapon: 'rpg', cause: 'explosion' });
  });

  it('smoke: FrameView.smokes, HudView.inSmoke, PlayerView.smokeHidden and localHitConfirmed.obscured', () => {
    const o = setup();
    const t = CLOUD.growMs + 100;
    const players = [makePlayer(1, { pos: { x: 0, y: GROUND, z: 0 } }), makePlayer(2, { pos: { x: 20, y: GROUND, z: 0 } }), makePlayer(3, { pos: { x: 0, y: GROUND, z: -20 } })];
    const far: SmokeCloudState = { id: 4, ownerId: 2, pos: { x: 10, y: GROUND, z: 0 }, deployedAt: 0, fadeAt: CLOUD.growMs + CLOUD.holdMs };
    start(o, groundSnap({}, {}, { players, smokes: [far], serverTime: 0 }));
    o.net.now = t;
    let { frame, hud } = o.game.update(0);
    expect(frame.smokes).toEqual([expect.objectContaining({ id: 4, radius: CLOUD.radius, center: { x: 10, y: GROUND + CLOUD.centerHeight, z: 0 } })]);
    expect(hud.inSmoke).toBe(false);
    expect(frame.players.find((p) => p.state.id === 2)!.smokeHidden).toBe(true);
    expect(frame.players.find((p) => p.state.id === 3)!.smokeHidden).toBe(false);
    o.net.pushEvents([
      { type: 'damage', victimId: 2, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: { x: 0, y: 1, z: 0 }, hpAfter: 80, vest: null, helmet: null, weapon: 'rifle', weaponLevel: 2 },
      { type: 'damage', victimId: 3, attackerId: 1, amount: 20, headshot: false, cause: 'weapon', sourcePos: { x: 0, y: 1, z: 0 }, hpAfter: 80, vest: null, helmet: null, weapon: 'rifle', weaponLevel: 2 },
    ]);
    o.game.update(0);
    expect(o.of('localHitConfirmed').map((e) => [e.victimId, e.obscured, e.weapon, e.weaponLevel])).toEqual([
      [2, true, 'rifle', 2],
      [3, false, 'rifle', 2],
    ]);
    // A cloud on the camera: inSmoke.
    o.net.pushEvents([{ type: 'smokeDeployed', id: 9, ownerId: 2, pos: { x: 0, y: GROUND, z: 0 }, deployedAt: 0, fadeAt: CLOUD.growMs + CLOUD.holdMs }]);
    ({ hud } = o.game.update(0));
    expect(hud.inSmoke).toBe(true);
    expect(o.of('smokeDeployed')[0]).toMatchObject({ id: 9, isLocalOwner: false });
  });

  it('brokenPanes: snapshot list plus glassBroken events, ascending, per match', () => {
    const o = setup();
    start(o, groundSnap({}, {}, { brokenPanes: [4] }));
    o.net.pushEvents([{ type: 'glassBroken', paneId: 1, pos: { x: 0, y: 1, z: 0 }, byId: 2, cause: 'melee' }]);
    const { frame } = o.game.update(0);
    expect(frame.brokenPanes).toEqual([1, 4]);
    expect(o.of('glassBroken')[0]).toMatchObject({ paneId: 1, cause: 'melee', isLocal: false });
  });
});

describe('ClientGame M2c: pickup prompt (UI M2c §3, §16.3)', () => {
  it('carries level, replacesSlot and scopeTarget, and refuses a scope with a full pouch', () => {
    const o = setup();
    const local = {
      activeSlot: 0 as const,
      slots: [{ weapon: 'rifle' as const, mag: 30, level: 1 as const, scope: 'scope_4x' as const }, { weapon: 'smg' as const, mag: 25, scope: 'scope_2x' as const }] as LocalPlayerState['slots'],
      spareScope: 'scope_2x' as const,
    };
    start(
      o,
      groundSnap(local, { weapon: 'rifle' }, { loot: [{ id: 5, item: 'rifle', qty: 1, pos: { x: 0.5, y: GROUND, z: 0 }, level: 3, scope: null }] }),
    );
    step(o.game);
    expect(o.of('interactPromptChanged').at(-1)).toMatchObject({ lootId: 5, item: 'rifle', level: 3, replacesSlot: 0, scopeTarget: null, refusal: null });
    o.net.pushSnapshot(groundSnap(local, { weapon: 'rifle' }, { loot: [{ id: 6, item: 'scope_red_dot', qty: 1, pos: { x: 0.5, y: GROUND, z: 0 } }] }));
    step(o.game);
    expect(o.of('interactPromptChanged').at(-1)).toMatchObject({ lootId: 6, level: null, scopeTarget: null, refusal: 'scopePouchFull' });
  });
});

describe('ClientGame M2c: dev hook fields (BUG-014)', () => {
  it('layout: the server ref, the client build and whether the hashes matched; look', () => {
    const o = setup({ buildLayout: (_b, seed) => ({ layout: layoutFor(seed), map: TEST_MAP }) });
    expect(o.devState().layout).toBeNull();
    o.net.pushWelcome({ playerId: 1, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 11, look: 'golden' } });
    o.game.update(0);
    expect(o.devState().layout).toEqual({
      mapId: 'test',
      seed: 11,
      version: TEST_LAYOUT_REF.version,
      hash: TEST_LAYOUT_REF.hash,
      look: 'golden',
      clientVersion: LAYOUT_FORMAT_VERSION,
      clientHash: TEST_LAYOUT_REF.hash,
      hashMatched: true,
    });
    expect(o.devState().look).toBe('golden');
  });

  it('layout: a mismatch in log mode reports hashMatched false and both hashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = setup({ buildLayout: (_b, seed) => ({ layout: layoutFor(seed, { hash: 999 }), map: TEST_MAP }), layoutMismatch: 'log' });
    o.net.pushWelcome({ playerId: 1, mapId: 'test', layout: { ...TEST_LAYOUT_REF, seed: 5 } });
    o.game.update(0);
    expect(o.devState().layout).toMatchObject({ seed: 5, hash: TEST_LAYOUT_REF.hash, clientHash: 999, hashMatched: false });
  });

  it('per-slot level and scope, the spare scope and the held level follow the T prediction', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 0, slots: [{ weapon: 'rifle', mag: 30, level: 2, scope: null }, null], spareScope: 'scope_4x' }, { weapon: 'rifle', weaponLevel: 2, sight: 'red_dot' }));
    step(o.game);
    let d = o.devState();
    expect(d.weaponLevel).toBe(2);
    expect(d.localSlots).toHaveLength(4);
    expect(d.localSlots[0]).toEqual({ slot: 0, item: 'rifle', level: 2, scope: null, sight: 'red_dot' });
    expect(d.localSlots[1]).toMatchObject({ slot: 1, item: null, level: null, scope: null });
    expect(d.spareScope).toBe('scope_4x');
    expect(d.scopeSwapProgress).toBeNull();
    o.input.state.keyDown('KeyT');
    step(o.game);
    d = o.devState();
    expect(d.localSlots[0]).toMatchObject({ scope: 'scope_4x', sight: 'scope_4x' });
    expect(d.spareScope).toBeNull();
    expect(d.scopeSwapProgress).not.toBeNull();
  });

  it('selected throwable and counts follow the G prediction', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 3, grenades: 2, smokes: 1 }, { weapon: 'grenade' }));
    step(o.game);
    expect(o.devState()).toMatchObject({ selectedThrowable: 'grenade', throwables: { grenade: 2, smoke: 1 } });
    o.input.state.keyDown('KeyG');
    step(o.game);
    expect(o.devState()).toMatchObject({ selectedThrowable: 'smoke', throwables: { grenade: 2, smoke: 1 }, localWeapon: 'smoke' });
  });

  it('local melee swing and recovery', () => {
    const o = setup();
    start(o, groundSnap({ activeSlot: 2, melee: { weapon: 'knife', level: 3 } }, { weapon: 'knife', weaponLevel: 3 }));
    step(o.game);
    expect(o.devState()).toMatchObject({ weaponLevel: 3, meleeSwing: null, meleeRecovery: null });
    o.input.state.buttonDown(0);
    step(o.game);
    const d = o.devState();
    expect(d.meleeSwing).toMatchObject({ weapon: 'knife' });
    expect(d.meleeRecovery).not.toBeNull();
    expect(d.players.find((p) => p.id === 1)!.swing).toEqual(d.meleeSwing);
  });

  it('rockets, smoke clouds, inSmoke, broken panes and per-player smokeHidden as drawn', () => {
    const o = setup();
    const t = CLOUD.growMs + 100;
    const rocket: RocketState = { id: 7, ownerId: 2, level: 3, pos: { x: 0, y: 5, z: 0 }, vel: { x: 45, y: 0, z: 0 }, firedAt: 0 };
    const players = [
      makePlayer(1, { pos: { x: 0, y: GROUND, z: 0 } }),
      makePlayer(2, { pos: { x: 20, y: GROUND, z: 0 }, weapon: 'rifle', weaponLevel: 4, sight: 'red_dot' }),
      makePlayer(3, { pos: { x: 0, y: GROUND, z: -20 } }),
    ];
    const far: SmokeCloudState = { id: 4, ownerId: 2, pos: { x: 10, y: GROUND, z: 0 }, deployedAt: 0, fadeAt: CLOUD.growMs + CLOUD.holdMs };
    start(o, groundSnap({}, {}, { players, smokes: [far], rockets: [rocket], brokenPanes: [4], serverTime: 0 }));
    o.net.pushEvents([{ type: 'glassBroken', paneId: 1, pos: { x: 0, y: 1, z: 0 }, byId: 2, cause: 'melee' }]);
    o.net.now = t;
    o.game.update(0);
    const d = o.devState();
    expect(d.rockets).toEqual([
      { id: 7, ownerId: 2, level: 3, pos: rocketPosAt(rocket, t, BALANCE.weapons.rpg.rocket.gravity), vel: expect.any(Object), origin: rocket.pos, firedAt: 0 },
    ]);
    expect(d.smokes).toEqual([
      { id: 4, ownerId: 2, pos: far.pos, center: { x: 10, y: GROUND + CLOUD.centerHeight, z: 0 }, radius: CLOUD.radius, deployedAt: 0, fadeAt: far.fadeAt },
    ]);
    expect(d.inSmoke).toBe(false);
    expect(d.brokenPanes).toEqual([1, 4]);
    const byId = new Map(d.players.map((p) => [p.id, p]));
    expect(byId.get(1)!.smokeHidden).toBe(false);
    expect(byId.get(2)).toMatchObject({ smokeHidden: true, weaponLevel: 4, sight: 'red_dot', swing: null });
    expect(byId.get(3)!.smokeHidden).toBe(false);
    o.net.pushEvents([{ type: 'smokeDeployed', id: 9, ownerId: 2, pos: { x: 0, y: GROUND, z: 0 }, deployedAt: 0, fadeAt: CLOUD.growMs + CLOUD.holdMs }]);
    o.game.update(0);
    expect(o.devState().inSmoke).toBe(true);
    expect(o.devState().smokes.map((c) => c.id).sort()).toEqual([4, 9]);
  });

  it('devState() itself returns copies (no live references), even before the hook clones', () => {
    const o = setup();
    const rocket: RocketState = { id: 7, ownerId: 2, level: 3, pos: { x: 0, y: 5, z: 0 }, vel: { x: 45, y: 0, z: 0 }, firedAt: 0 };
    start(o, groundSnap({ activeSlot: 3, grenades: 2, smokes: 1 }, {}, { brokenPanes: [4], rockets: [rocket] }));
    const a = o.devRead();
    a.brokenPanes.push(99);
    a.throwables!.smoke = 50;
    a.rockets[0]!.origin.x = 123;
    const b = o.devRead();
    expect(b.brokenPanes).toEqual([4]);
    expect(b.throwables!.smoke).toBe(1);
    expect(b.rockets[0]!.origin.x).toBe(0);
    expect(o.game.update(0).frame.brokenPanes).toEqual([4]);
  });
});

describe('ClientGame M2c: BUG-016 smokeHidden with the cloud on the line of sight', () => {
  // QA run e2e-r7 numbers: cloud record, A eye (74.5, 3.5, 13.6) in first person, B standing at (97.5, 16.3), now 351421.9.
  // The e2e false readings came from B being DEAD (killed by the melee test's knife swings, then spectating A): a dead
  // remote and the spectated subject are never smoke-hidden. These tests pin all three cases.
  const CLOUD_REC: SmokeCloudState = { id: 1, ownerId: 1, pos: { x: 83.575, y: 2.525, z: 14.593 }, deployedAt: 343628.577, fadeAt: 363128.577 };
  const A_FEET = { x: 74.5, y: 3.5 - BALANCE.movement.stances.stand.eyeHeight, z: 13.6 };
  const B_FEET = { x: 97.5, y: 2.45, z: 16.3 };
  const NOW = 351_421.9;

  function scene(local: { id: number; alive: boolean }, b: { alive: boolean }) {
    const o = setup();
    o.net.now = 343_700;
    const players = [makePlayer(1, { name: 'A', pos: A_FEET }), makePlayer(2, { name: 'B', pos: B_FEET, alive: b.alive, hp: b.alive ? 40 : 0 })];
    const snap = makeSnapshot({
      match: match(),
      players: local.alive ? players : [players[0]!, { ...players[1]!, alive: false, hp: 0 }],
      local: makeLocal(local.id, { movement: makeMovement({ pos: local.id === 1 ? A_FEET : B_FEET }) }),
      smokes: [CLOUD_REC],
      serverTime: 343_700,
    });
    o.net.pushWelcome({ playerId: local.id, mapId: 'test' });
    o.net.pushSnapshot(snap);
    o.game.update(0);
    o.net.now = NOW;
    return o;
  }

  it('A (local, first person, alive) sees a live B behind the cloud as hidden; the hook reports the same', () => {
    const o = scene({ id: 1, alive: true }, { alive: true });
    const { frame } = o.game.update(0);
    expect(frame.camera.view).toBe('firstPerson');
    expect(frame.smokes).toHaveLength(1);
    expect(frame.players.find((p) => p.state.id === 2)!.smokeHidden).toBe(true);
    expect(o.devState().players.find((p) => p.id === 2)).toMatchObject({ alive: true, smokeHidden: true });
  });

  it('a dead B is never smoke-hidden (no name tag to hide); the hook shows alive false', () => {
    const o = scene({ id: 1, alive: true }, { alive: false });
    const { frame } = o.game.update(0);
    expect(frame.players.find((p) => p.state.id === 2)!.smokeHidden).toBe(false);
    expect(o.devState().players.find((p) => p.id === 2)).toMatchObject({ alive: false, smokeHidden: false });
  });

  it('dead B spectating A: A is the camera subject, so A is not smoke-hidden on B', () => {
    const o = scene({ id: 2, alive: false }, { alive: false });
    // Death screen, then spectate after match.deathScreenSeconds.
    o.game.update(BALANCE.match.deathScreenSeconds + 0.1);
    const { frame } = o.game.update(0);
    expect(frame.camera.subjectId).toBe(1);
    expect(frame.players.find((p) => p.state.id === 1)!.smokeHidden).toBe(false);
    expect(o.devState().spectateTargetId).toBe(1);
  });
});
