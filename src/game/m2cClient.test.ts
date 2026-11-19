/**
 * M2c client modules (pure): scope rules, local prediction (throwable cycle, melee swing, T switch), rockets, smoke,
 * per-match layout. ClientGame wiring is in ClientGame.m2c.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { BALANCE, effectiveWeapon } from '../shared/balance';
import { LAYOUT_FORMAT_VERSION } from '../shared/layout';
import { rocketPosAt } from '../shared/rocket';
import { smokeRadiusAt } from '../shared/smoke';
import type { LocalPlayerState, LootState, MatchLayout, PlayerInput, RocketState, ScopeId, SmokeCloudState, WeaponSlotState } from '../shared/types';
import { selectedThrowableOf } from '../shared/sim/actions';
import { actionsFromSnapshot, actionsNowMs, stepActions, type PredictedActions } from './actionPrediction';
import { pickupRefusal } from './derived';
import { adsSpecOf, AdsBlend } from './ads';
import { fovBaseOf } from './fov';
import { buildMatchMap, LayoutMismatchError, MapRuntimeCache, matchMapKey } from './layoutClient';
import { M2cLocalPredictor, predictedScopes, RemoteSwingTracker, type M2cStepEvents } from './m2cPrediction';
import { ROCKET_END_GRACE_MS, RocketTracker } from './rocketsView';
import { pickupReplacesSlot, scopeForSight, scopeTargetOf } from './scopes';
import { cameraWorldPos, hiddenBySmoke, SmokeTracker } from './smokeView';
import { makeLocal, makeMovement, TEST_LAYOUT_REF, TEST_MAP } from './testFixtures';

const B = BALANCE;
const CLOUD = B.items.smoke.cloud;

const gun = (weapon: WeaponSlotState['weapon'], extra: Partial<WeaponSlotState> = {}): WeaponSlotState => ({ weapon, mag: 1, ...extra });

describe('scope glue (sim scopes.ts / inventory.ts rules)', () => {
  it('scopeTarget follows the sim scopePickupPlan (acceptance 5)', () => {
    // Holding a rifle (red dot default) with an SMG in the other slot.
    const at = (slots: LocalPlayerState['slots'], scope: ScopeId, spare: ScopeId | null = null, active: 0 | 1 | 2 = 0) =>
      scopeTargetOf({ item: scope }, makeLocal(1, { slots, spareScope: spare }), active, B);
    expect(at([gun('rifle'), gun('smg')], 'scope_2x')).toBe(0);
    expect(at([gun('rifle', { scope: 'scope_2x' }), gun('smg')], 'scope_2x')).toBe(1);
    expect(at([gun('rifle', { scope: 'scope_2x' }), gun('smg')], 'scope_4x')).toBe(0);
    const full: LocalPlayerState['slots'] = [gun('rifle', { scope: 'scope_4x' }), gun('smg', { scope: 'scope_2x' })];
    expect(at(full, 'scope_red_dot', 'scope_2x')).toBeNull();
    expect(at(full, 'scope_red_dot')).toBe('pouch');
    expect(at([null, gun('smg')], 'scope_2x', null, 2)).toBe(1);
    expect(scopeTargetOf({ item: 'rifle' }, makeLocal(1), 0, B)).toBeNull();
  });

  it('replacesSlot: melee slot, upgrade swap, held slot with both full, null with a free slot', () => {
    expect(pickupReplacesSlot({ item: 'knife', level: 1 }, makeLocal(1), 2)).toBeNull();
    expect(pickupReplacesSlot({ item: 'paddle', level: 1 }, makeLocal(1, { melee: { weapon: 'knife', level: 2 } }), 0)).toBe(2);
    const twoGuns = makeLocal(1, { slots: [gun('smg'), gun('rifle', { level: 1 })] });
    expect(pickupReplacesSlot({ item: 'rifle', level: 3 }, twoGuns, 0)).toBe(1); // upgrade swap, whichever slot is held
    expect(pickupReplacesSlot({ item: 'rifle', level: 1 }, twoGuns, 0)).toBe(0); // same level: the held slot
    expect(pickupReplacesSlot({ item: 'dmr', level: 2 }, twoGuns, 2)).toBe(0); // holding fists: slot 0
    expect(pickupReplacesSlot({ item: 'dmr', level: 2 }, makeLocal(1, { slots: [gun('smg'), null] }), 0)).toBeNull();
    expect(pickupReplacesSlot({ item: 'bandage' }, twoGuns, 0)).toBeNull();
  });

  it('pickupRefusal is the sim rule: scopePouchFull, smoke stack full, armor', () => {
    const local = makeLocal(1, { activeSlot: 0, slots: [gun('rifle', { scope: 'scope_4x' }), gun('smg', { scope: 'scope_2x' })], spareScope: 'scope_2x', smokes: B.items.smoke.maxCarry });
    const loot = (item: LootState['item']): LootState => ({ id: 1, item, qty: 1, pos: { x: 0, y: 0, z: 0 } });
    expect(pickupRefusal(loot('scope_red_dot'), local, B)).toBe('scopePouchFull');
    expect(pickupRefusal(loot('smoke'), local, B)).toBe('inventoryFull');
    expect(pickupRefusal(loot('rifle'), local, B)).toBeNull();
  });

  it('scopeForSight rebuilds a remote scope from the effective sight', () => {
    expect(scopeForSight(B, 'rifle', 'scope_4x')).toBe('scope_4x');
    expect(scopeForSight(B, 'rifle', 'red_dot')).toBeNull(); // built-in
    expect(scopeForSight(B, 'smg', 'scope_2x')).toBe('scope_2x');
  });
});

describe('ADS with effective weapons (ADR 0007 §5)', () => {
  it('adsSpecOf uses effectiveWeapon (rifle + 4x: zoom 4, 345 ms) and AdsBlend reaches progress 1 at that time', () => {
    const spec = adsSpecOf(B, 'rifle', 1, 'scope_4x');
    const eff = effectiveWeapon(B, 'rifle', 1, 'scope_4x');
    expect(spec).toMatchObject({ sight: 'scope_4x', adsZoom: 4, adsTimeMs: eff.adsTimeMs });
    expect(spec.adsTimeMs).toBeCloseTo(345, 0);
    expect(adsSpecOf(B, 'rifle', 1, 'scope_4x')).toBe(spec); // cached
    const blend = new AdsBlend();
    const fov = fovBaseOf(undefined);
    const half = blend.update({ adsMs: spec.adsTimeMs / 2 }, 'rifle', B, 16, 100, fov, spec);
    expect(half.progress).toBeCloseTo(0.5);
    expect(half.scoped).toBe(false);
    const full = blend.update({ adsMs: spec.adsTimeMs }, 'rifle', B, 16, 100, fov, spec);
    expect(full).toMatchObject({ sight: 'scope_4x', progress: 1, scoped: true });
  });

  it('2x shows the overlay (hasScopeOverlay); red dot does not', () => {
    const fov = fovBaseOf(undefined);
    const s2 = adsSpecOf(B, 'smg', 1, 'scope_2x');
    expect(new AdsBlend().update({ adsMs: s2.adsTimeMs }, 'smg', B, 16, 100, fov, s2).scoped).toBe(true);
    const rd = adsSpecOf(B, 'smg', 1, 'scope_red_dot');
    expect(new AdsBlend().update({ adsMs: rd.adsTimeMs }, 'smg', B, 16, 100, fov, rd).scoped).toBe(false);
  });
});

// ---- Local feedback over the shared action step ----

const input = (seq: number, over: Partial<PlayerInput> = {}): PlayerInput => ({
  seq,
  dt: 1 / 30,
  moveForward: 0,
  moveRight: 0,
  yaw: 0,
  pitch: 0,
  sprint: false,
  fire: false,
  ads: false,
  jump: false,
  reload: false,
  interact: false,
  useHeal: false,
  selectSlot: -1,
  stanceToggle: null,
  ...over,
});

/** Drives the real shared step (stepActions) and feeds M2cLocalPredictor like ClientGame.fixedStep does. */
function driver(local: LocalPlayerState, tick = 100) {
  const p = new M2cLocalPredictor();
  let a: PredictedActions = actionsFromSnapshot(local, 100, tick, null, 0);
  let seq = 0;
  const events: M2cStepEvents[] = [];
  const press = (over: Partial<PlayerInput> = {}): M2cStepEvents => {
    const before = a;
    a = stepActions(before, input(++seq, over), makeMovement(), B);
    const ev = p.step(before, a, 1, B);
    events.push(ev);
    return ev;
  };
  return { p, press, events, get a() { return a; } };
}

describe('M2cLocalPredictor over the shared step: throwable slot (grenades.md "Throwable slot")', () => {
  it('4 / G on the held, ready slot: throwableCycled and the cycle arms; one type carried: nothing', () => {
    const d = driver(makeLocal(1, { activeSlot: 3, grenades: 2, smokes: 1 }));
    const ev = d.press({ selectSlot: 3 });
    expect(ev.throwableCycled).toEqual({ from: 'grenade', to: 'smoke' });
    expect(selectedThrowableOf(d.a.inv)).toBe('smoke');
    expect(d.p.cycleProgress(B, actionsNowMs(d.a))).toBe(0);
    // A second press inside throwableCycleMs is ignored by the shared step.
    expect(d.press({ selectSlot: 3 }).throwableCycled).toBeNull();
    const only = driver(makeLocal(1, { activeSlot: 3, grenades: 2, smokes: 0 }));
    expect(only.press({ selectSlot: 3 }).throwableCycled).toBeNull();
  });

  it('selecting the slot with the selected type empty picks the other type (no cycle event)', () => {
    const d = driver(makeLocal(1, { activeSlot: 0, slots: [gun('rifle'), null], grenades: 0, smokes: 1 }));
    expect(d.press({ selectSlot: 3 }).throwableCycled).toBeNull();
    expect(d.a.inv.activeSlot).toBe(3);
    expect(selectedThrowableOf(d.a.inv)).toBe('smoke');
  });
});

describe('M2cLocalPredictor over the shared step: melee swing (melee.md "Swing")', () => {
  it('LMB: local meleeSwing on the click, recovery after the hit frame, automatic re-swing one cycle later', () => {
    const d = driver(makeLocal(1, { activeSlot: 2, melee: { weapon: 'machete', level: 2 } }), 30);
    const eff = effectiveWeapon(B, 'machete', 2);
    const ev = d.press({ fire: true });
    expect(ev.meleeSwing).toMatchObject({ playerId: 1, weapon: 'machete', level: 2, cycleMs: eff.fireIntervalMs, isLocal: true });
    expect(ev.meleeSwing!.windupMs).toBeCloseTo(eff.hitFrameMs);
    const t0 = d.p.lastSwingStart;
    expect(d.p.meleeRecovery(t0 + eff.hitFrameMs / 2)).toBe(0);
    expect(d.p.meleeRecovery(t0 + (eff.hitFrameMs + eff.fireIntervalMs) / 2)).toBeCloseTo(0.5);
    expect(d.p.swingView(t0 + eff.fireIntervalMs / 2)).toMatchObject({ weapon: 'machete', progress: 0.5 });
    const ticks = Math.ceil(eff.fireIntervalMs / (1000 / 30)) + 1;
    for (let i = 0; i < ticks; i++) d.press({ fire: true });
    expect(d.events.filter((e) => e.meleeSwing).length).toBe(2);
  });

  it('no swing with fists; a slot change cancels the swing view', () => {
    const f = driver(makeLocal(1, { activeSlot: 2 }));
    expect(f.press({ fire: true }).meleeSwing).toBeNull();
    const d = driver(makeLocal(1, { activeSlot: 2, slots: [gun('rifle'), null], melee: { weapon: 'knife', level: 1 } }));
    expect(d.press({ fire: true }).meleeSwing).not.toBeNull();
    d.press({ selectSlot: 0 });
    expect(d.p.swingView(actionsNowMs(d.a))).toBeNull();
  });
});

describe('predictedScopes: T switch target during the switch (scopes.md "T")', () => {
  it('shows the target and pouch at once, progress over scopes.swapMs, and the applied scope after it', () => {
    const d = driver(makeLocal(1, { activeSlot: 0, slots: [gun('rifle', { scope: 'scope_2x' }), null], spareScope: 'scope_4x' }));
    d.press({ cycleScope: true });
    let sc = predictedScopes(d.a, B);
    expect(sc).toMatchObject({ slotScopes: ['scope_4x', null], spare: 'scope_2x' });
    expect(d.a.inv.slots[0]!.scope).toBe('scope_2x'); // the sim applies it at the end
    expect(sc.progress).not.toBeNull();
    for (let i = 0; i < Math.ceil(B.scopes.swapMs / (1000 / 30)) + 1; i++) d.press();
    sc = predictedScopes(d.a, B);
    expect(d.a.inv.slots[0]!.scope).toBe('scope_4x');
    expect(sc).toEqual({ slotScopes: ['scope_4x', null], spare: 'scope_2x', progress: null });
  });

  it('T while aiming or with nothing that fits starts no switch', () => {
    const none = driver(makeLocal(1, { activeSlot: 0, slots: [gun('rifle'), null] }));
    none.press({ cycleScope: true });
    expect(predictedScopes(none.a, B).progress).toBeNull();
    const local = makeLocal(1, { activeSlot: 0, slots: [gun('rifle'), null], spareScope: 'scope_4x' });
    const aiming = stepActions(actionsFromSnapshot(local, 100, 10, null, 0), input(1, { cycleScope: true, ads: true }), makeMovement({ adsMs: 50 }), B);
    expect(aiming.scopeSwap ?? null).toBeNull();
  });
});

describe('RemoteSwingTracker', () => {
  it('wind-up starts hitFrameMs before hitAt and ends after the cycle', () => {
    const t = new RemoteSwingTracker();
    const eff = effectiveWeapon(B, 'paddle', 1);
    t.onSwing({ playerId: 4, weapon: 'paddle', level: 1, hitAt: 1_000, cycleMs: eff.fireIntervalMs }, B);
    const start = 1_000 - eff.hitFrameMs;
    expect(t.view(4, start - 1)).toBeNull();
    expect(t.view(4, start)).toMatchObject({ weapon: 'paddle', progress: 0 });
    expect(t.view(4, start + eff.fireIntervalMs / 2)!.progress).toBeCloseTo(0.5);
    expect(t.view(4, start + eff.fireIntervalMs)).toBeNull();
    expect(t.view(4, start + 1)).toBeNull(); // pruned
  });
});

// ---- Rockets and smoke ----

const rocket = (id: number, firedAt = 0): RocketState => ({ id, ownerId: 2, level: 2, pos: { x: 0, y: 10, z: 0 }, vel: { x: 45, y: 0, z: 0 }, firedAt });

describe('RocketTracker (rocketPosAt, ADR 0007 §4)', () => {
  it('draws rockets with the shared closed form; events add and end them; ended ids never return', () => {
    const r = new RocketTracker();
    r.onFired(rocket(5, 1_000));
    const [v] = r.views(1_500, B);
    expect(v!.pos).toEqual(rocketPosAt(rocket(5, 1_000), 1_500, B.weapons.rpg.rocket.gravity));
    expect(v!.origin).toEqual({ x: 0, y: 10, z: 0 });
    expect(v!.level).toBe(2);
    // A snapshot older than the launch does not drop it.
    r.onSnapshot([], 900);
    expect(r.size).toBe(1);
    r.onEnded(5);
    r.onSnapshot([rocket(5, 1_000)], 1_100);
    expect(r.views(1_200, B)).toEqual([]);
    // Late joiner: from the snapshot list; gone when a later snapshot omits it.
    r.onSnapshot([rocket(6, 2_000)], 2_100);
    expect(r.views(2_100, B).map((x) => x.id)).toEqual([6]);
    r.onSnapshot([], 2_200);
    expect(r.size).toBe(0);
  });

  it('drops a rocket whose end event was lost after its max flight time', () => {
    const r = new RocketTracker();
    r.onFired(rocket(1, 0));
    const flight = (B.weapons.rpg.range / B.weapons.rpg.rocket.speed) * 1000;
    expect(r.views(flight, B)).toHaveLength(1);
    expect(r.views(flight + ROCKET_END_GRACE_MS + 1, B)).toEqual([]);
  });
});

const cloud = (id: number, deployedAt = 0, pos = { x: 0, y: 0, z: 0 }): SmokeCloudState => ({
  id,
  ownerId: 3,
  pos,
  deployedAt,
  fadeAt: deployedAt + CLOUD.growMs + CLOUD.holdMs,
});

describe('SmokeTracker and visibility (smoke.ts helpers)', () => {
  it('views use smokeRadiusAt and smokeCenter; clouds vanish at smokeGoneAt', () => {
    const s = new SmokeTracker();
    s.onDeployed(cloud(3, 1_000));
    const [v] = s.views(1_000 + CLOUD.growMs / 2, CLOUD);
    expect(v!.radius).toBeCloseTo(smokeRadiusAt(cloud(3, 1_000), 1_000 + CLOUD.growMs / 2, CLOUD));
    expect(v!.center).toEqual({ x: 0, y: CLOUD.centerHeight, z: 0 });
    const gone = 1_000 + CLOUD.growMs + CLOUD.holdMs + CLOUD.fadeMs;
    expect(s.views(gone - 1, CLOUD)).toHaveLength(1);
    expect(s.views(gone, CLOUD)).toEqual([]);
  });

  it('a snapshot replaces a cloud (forced earlier fadeAt) and drops unlisted older ones', () => {
    const s = new SmokeTracker();
    s.onDeployed(cloud(1, 0));
    s.onSnapshot([{ ...cloud(1, 0), fadeAt: 2_000 }], 1_000);
    expect(s.active(1_000, CLOUD)[0]!.fadeAt).toBe(2_000);
    s.onSnapshot([], 1_100);
    expect(s.active(1_100, CLOUD)).toEqual([]);
  });

  it('hiddenBySmoke needs both head and chest blocked; cameraWorldPos pulls a 3P camera back', () => {
    const c = cloud(1, 0, { x: 10, y: 0, z: 0 });
    const t = CLOUD.growMs + 1;
    const cam = { x: 0, y: CLOUD.centerHeight, z: 0 };
    const head = { x: 20, y: CLOUD.centerHeight + 0.3, z: 0 };
    const chest = { x: 20, y: CLOUD.centerHeight, z: 0 };
    expect(hiddenBySmoke([c], cam, head, chest, t, CLOUD)).toBe(true);
    const highHead = { x: 20, y: 30, z: 0 };
    expect(hiddenBySmoke([c], cam, highHead, chest, t, CLOUD)).toBe(false);
    expect(hiddenBySmoke([], cam, head, chest, t, CLOUD)).toBe(false);
    const p = cameraWorldPos({
      mode: 'follow',
      target: { x: 0, y: 2, z: 0 },
      yaw: 0,
      pitch: 0,
      distance: 4,
      shoulderOffset: 0,
      fovDeg: 70,
      firstPerson: false,
      view: 'chase',
      subjectId: 1,
      roll: 0,
    });
    expect(p.z).toBeCloseTo(4); // yaw 0 looks toward -Z, so the boom is behind on +Z
    expect(p.y).toBeCloseTo(2);
  });
});

// ---- Layout ----

describe('layoutClient (ADR 0007 §1.5)', () => {
  const layoutOf = (over: Partial<MatchLayout> = {}): MatchLayout => ({
    version: LAYOUT_FORMAT_VERSION,
    mapId: TEST_MAP.id,
    seed: 0,
    picks: [],
    look: 'golden',
    props: [],
    lootSpawns: [],
    hash: TEST_LAYOUT_REF.hash,
    fallbacks: 0,
    decor: [],
    ...over,
  });

  it('builds through buildLayout with the server seed, uses the layout look, keys by map, seed and version', () => {
    const build = vi.fn((base, _seed: number) => ({ layout: layoutOf(), map: { ...base, id: base.id } }));
    const ref = { ...TEST_LAYOUT_REF, seed: 77, look: 'golden' as const };
    const mm = buildMatchMap(TEST_MAP, ref, build, 'throw');
    expect(build).toHaveBeenCalledWith(TEST_MAP, 77);
    expect(mm).toMatchObject({ mapId: 'test', look: 'golden', key: matchMapKey('test', ref) });
    expect(mm.layout).not.toBeNull();
    expect(matchMapKey('test', null)).toBe('test:base');
  });

  it('hash or version mismatch: throws in throw mode, logs and continues in log mode', () => {
    const build = () => ({ layout: layoutOf({ hash: 123 }), map: TEST_MAP });
    expect(() => buildMatchMap(TEST_MAP, TEST_LAYOUT_REF, build, 'throw')).toThrow(LayoutMismatchError);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(buildMatchMap(TEST_MAP, TEST_LAYOUT_REF, build, 'log').map).toBe(TEST_MAP);
    expect(err).toHaveBeenCalledOnce();
    err.mockRestore();
    const oldVersion = () => ({ layout: layoutOf({ version: LAYOUT_FORMAT_VERSION + 1 }), map: TEST_MAP });
    expect(() => buildMatchMap(TEST_MAP, TEST_LAYOUT_REF, oldVersion, 'throw')).toThrow(/version/);
  });

  it('without a builder or ref: the base map; look from the ref, else the baseline', () => {
    expect(buildMatchMap(TEST_MAP, { ...TEST_LAYOUT_REF, look: 'overcast' }, undefined, 'throw')).toMatchObject({ map: TEST_MAP, layout: null, look: 'overcast' });
    expect(buildMatchMap(TEST_MAP, null, undefined, 'throw')).toMatchObject({ map: TEST_MAP, layout: null, ref: null, look: 'noon' });
  });

  it('MapRuntimeCache keeps the current and previous entries', () => {
    const c = new MapRuntimeCache<number>(2);
    let made = 0;
    c.get('a', () => ++made);
    c.get('b', () => ++made);
    expect(c.get('a', () => ++made)).toBe(1);
    c.get('c', () => ++made);
    expect(c.has('b')).toBe(false);
    expect(c.has('a') && c.has('c')).toBe(true);
    expect(c.size).toBe(2);
  });
});
