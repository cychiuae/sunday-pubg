import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { SIM_DT } from '../shared/constants';
import { createMovementContext, stepMovement, toMovementInput } from '../shared/sim/movement';
import { balanceWith, input as simInput, playingWorld } from '../shared/sim/testkit';
import type { LocalPlayerState, PlayerInput } from '../shared/types';
import {
  actionsFromSnapshot,
  actionsNowMs,
  snapshotOriginMs,
  actionStatusModel,
  cookRemainingMs,
  heldOf,
  statusOfActions,
  stepActions,
  type PredictedActions,
} from './actionPrediction';
import { Predictor, type PredictStatus, type PredictStep, type StatusModel } from './prediction';
import { makeLocal, makeMovement, NO_DROP_STEP } from './testFixtures';

const B = BALANCE;
const M = makeMovement();
const DROP = makeMovement({ dropping: true });
const ticksFor = (ms: number): number => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);

function inp(over: Partial<PlayerInput> = {}): PlayerInput {
  return simInput({ seq: 1, ...over });
}

function base(over: Partial<LocalPlayerState> = {}, hp = 40): PredictedActions {
  return actionsFromSnapshot(
    makeLocal(1, {
      slots: [{ weapon: 'pistol', mag: 3 }, null],
      activeSlot: 0,
      ammo: { ammo_light: 30, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0 },
      heals: { bandage: 2, medkit: 0 },
      ...over,
    }),
    hp,
  );
}

function stepN(a: PredictedActions, n: number, over: Partial<PlayerInput> = {}, dropping = false): PredictedActions {
  let s = a;
  const m = makeMovement({ dropping });
  for (let i = 0; i < n; i++) s = stepActions(s, inp(over), m, B);
  return s;
}

describe('stepActions (heal/reload/swap prediction)', () => {
  it('Q starts the heal in the same tick and it completes after useMs, applying the heal', () => {
    const started = stepActions(base(), inp({ useHeal: true }), M, B);
    expect(started.heal).toEqual({ item: 'bandage', remainingMs: B.items.bandage.useMs, totalMs: B.items.bandage.useMs });
    const n = ticksFor(B.items.bandage.useMs);
    const almost = stepN(started, n - 1);
    expect(almost.heal).not.toBeNull();
    const done = stepN(almost, 1);
    expect(done.heal).toBeNull();
    expect(done.hp).toBe(40 + B.items.bandage.heal);
    expect(done.inv.heals.bandage).toBe(1);
  });

  it('does not start while dropping, at full hp, or without heals', () => {
    expect(stepActions(base(), inp({ useHeal: true }), DROP, B).heal).toBeNull();
    expect(stepActions(base({}, B.player.maxHp), inp({ useHeal: true }), M, B).heal).toBeNull();
    expect(stepActions(base({ heals: { bandage: 0, medkit: 0 } }), inp({ useHeal: true }), M, B).heal).toBeNull();
  });

  it('a heal is cancelled by Q again, held fire, a slot switch, and a reload that starts', () => {
    const healing = stepActions(base(), inp({ useHeal: true }), M, B);
    expect(stepActions(healing, inp({ useHeal: true }), M, B).heal).toBeNull();
    expect(stepActions(healing, inp({ fire: true }), M, B).heal).toBeNull();
    const switched = stepActions(healing, inp({ selectSlot: 2 }), M, B);
    expect(switched.heal).toBeNull();
    expect(switched.swapRemainingMs).toBe(B.combat.swapMs);
    const reloading = stepActions(healing, inp({ reload: true }), M, B);
    expect(reloading.heal).toBeNull();
    expect(reloading.reload).toMatchObject({ slot: 0, weapon: 'pistol' });
  });

  it('switching to an empty slot, or a reload that cannot start (full mag, no reserve, swapping) keeps the heal', () => {
    const healing = stepActions(base(), inp({ useHeal: true }), M, B);
    expect(stepActions(healing, inp({ selectSlot: 1 }), M, B).heal).not.toBeNull();
    const fullMag = stepActions(base({ slots: [{ weapon: 'pistol', mag: B.weapons.pistol.magSize }, null] }), inp({ useHeal: true }), M, B);
    expect(stepActions(fullMag, inp({ reload: true }), M, B).heal).not.toBeNull();
    const noReserve = stepActions(base({ ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0 } }), inp({ useHeal: true }), M, B);
    expect(stepActions(noReserve, inp({ reload: true }), M, B).heal).not.toBeNull();
    const swapping = stepActions(base({ swapRemainingMs: 300 }), inp({ useHeal: true }), M, B);
    expect(stepActions(swapping, inp({ reload: true }), M, B).heal).not.toBeNull();
  });

  it('a heal start cancels a reload; a finished reload fills the mag from reserve', () => {
    const reloading = base({ reloadRemainingMs: 500, reloadTotalMs: B.weapons.pistol.reloadMs });
    expect(reloading.reload).toMatchObject({ slot: 0, weapon: 'pistol', remainingMs: 500 });
    const healed = stepActions(reloading, inp({ useHeal: true }), M, B);
    expect(healed.reload).toBeNull();
    expect(healed.heal).not.toBeNull();
    const done = stepN(reloading, ticksFor(500));
    expect(done.reload).toBeNull();
    expect(done.inv.slots[0]!.mag).toBe(B.weapons.pistol.magSize);
    expect(done.inv.ammo.ammo_light).toBe(30 - (B.weapons.pistol.magSize - 3));
  });

  it('does not mutate its input', () => {
    const a = base({ reloadRemainingMs: 10, reloadTotalMs: 1400 });
    const before = structuredClone(a);
    stepN(a, 3, { useHeal: true });
    expect(a).toEqual(before);
  });
});

describe('stepActions (M2a grenade slot, held item, fire window)', () => {
  const nade = (over: Partial<LocalPlayerState> = {}): PredictedActions => base({ grenades: 2, ...over }, 100);

  it('slot 3 needs grenades; selecting it swaps and records the weapon slot to return to', () => {
    expect(stepActions(base({ grenades: 0 }), inp({ selectSlot: 3 }), M, B).inv.activeSlot).toBe(0);
    const a = stepActions(nade(), inp({ selectSlot: 3 }), M, B);
    expect(a.inv.activeSlot).toBe(3);
    expect(a.swapRemainingMs).toBe(B.combat.swapMs);
    expect(a.lastGunSlot).toBe(0);
    expect(heldOf(a)).toBe('grenade');
    expect(statusOfActions(a)).toMatchObject({ held: 'grenade', swapping: true });
  });

  it('a fire press while ready pulls the pin (count - 1); not during swap, recovery, a stance transition or dropping', () => {
    const ready = nade({ activeSlot: 3 });
    const cooked = stepActions(ready, inp({ fire: true }), M, B);
    expect(cookRemainingMs(cooked)).toBeCloseTo(B.items.grenade.fuseMs, 6);
    expect(cooked.inv.grenades).toBe(1);
    expect(stepActions(nade({ activeSlot: 3, swapRemainingMs: 200 }), inp({ fire: true }), M, B).cook).toBeNull();
    expect(stepActions(nade({ activeSlot: 3, throwRecoveryMs: 300 }), inp({ fire: true }), M, B).cook).toBeNull();
    const transitioning = makeMovement({ stance: 'crouch', stanceFrom: 'stand', stanceMs: 100 });
    expect(stepActions(ready, inp({ fire: true }), transitioning, B).cook).toBeNull();
    expect(stepActions(ready, inp({ fire: true }), DROP, B).cook).toBeNull();
    // Holding fire through the end of recovery needs a new press.
    const held = stepN(nade({ activeSlot: 3, throwRecoveryMs: 50 }), 4, { fire: true });
    expect(held.cook).toBeNull();
  });

  it('release throws and starts recovery; the last grenade auto-switches back to the last weapon slot', () => {
    let a = stepActions(nade({ activeSlot: 3, grenades: 1 }), inp({ fire: true }), M, B);
    a = stepN(a, 5, { fire: true });
    expect(cookRemainingMs(a)).toBeCloseTo(B.items.grenade.fuseMs - 5 * SIM_DT * 1000, 6);
    const thrown = stepActions({ ...a, lastGunSlot: 0 }, inp({ fire: false }), M, B);
    expect(thrown.cook).toBeNull();
    expect(thrown.throwRecoveryMs).toBe(B.items.grenade.throwRecoveryMs);
    expect(thrown.inv.activeSlot).toBe(0);
    expect(thrown.swapRemainingMs).toBe(B.combat.swapMs);
    // With grenades left it stays on slot 3.
    const more = stepActions(stepActions(nade({ activeSlot: 3 }), inp({ fire: true }), M, B), inp(), M, B);
    expect(more.inv.activeSlot).toBe(3);
  });

  it('cook-out ends the cook in hand; Q and R are ignored while cooking; a slot key drops the grenade', () => {
    const cooking = stepActions(nade({ activeSlot: 3 }), inp({ fire: true }), M, B);
    const out = stepN(cooking, ticksFor(B.items.grenade.fuseMs), { fire: true });
    expect(out.cook).toBeNull();
    expect(out.throwRecoveryMs).toBeGreaterThan(0);
    const q = stepActions(cooking, inp({ fire: true, useHeal: true, reload: true }), M, B);
    expect(q.heal).toBeNull();
    expect(q.reload).toBeNull();
    const swapped = stepActions(cooking, inp({ fire: true, selectSlot: 2 }), M, B);
    expect(swapped.cook).toBeNull();
    expect(swapped.inv.activeSlot).toBe(2);
  });

  it('fire slow-down: a shot opens it for the next ticks while the same gun is in hand, until fireMoveWindowMs', () => {
    const lmg = base({ slots: [{ weapon: 'lmg', mag: 30 }, null], activeSlot: 0 }, 100);
    const shot = stepActions(lmg, inp({ fire: true }), M, B);
    expect(shot.fireSlowed).toBe(false);
    expect(shot.inv.slots[0]!.mag).toBe(29);
    expect(shot.lastShotWeapon).toBe('lmg');
    expect(statusOfActions(stepActions(shot, inp(), M, B)).fireSlowed).toBe(true);
    const after = stepN(shot, ticksFor(B.combat.fireMoveWindowMs));
    expect(after.fireSlowed).toBe(false);
    // Empty mag: auto-reload instead of a shot.
    const empty = stepActions(base({ slots: [{ weapon: 'lmg', mag: 0 }, null], ammo: { ammo_light: 0, ammo_heavy: 30, ammo_shell: 0, ammo_sniper: 0 } }), inp({ fire: true }), M, B);
    expect(empty.lastShotWeapon).toBeNull();
    expect(empty.reload).toMatchObject({ weapon: 'lmg' });
  });

  it('shots follow the fire interval; semi-auto needs a new click; the last round starts the auto-reload', () => {
    const lmg = base({ slots: [{ weapon: 'lmg', mag: 30 }, null], activeSlot: 0 }, 100);
    const n = 30;
    const burst = stepN(lmg, n, { fire: true });
    const expected = Math.floor(((n - 1) * SIM_DT * 1000) / B.weapons.lmg.fireIntervalMs) + 1;
    expect(30 - burst.inv.slots[0]!.mag).toBeGreaterThanOrEqual(expected - 1);
    expect(30 - burst.inv.slots[0]!.mag).toBeLessThanOrEqual(expected + 1);
    const pistol = base({ slots: [{ weapon: 'pistol', mag: 5 }, null], activeSlot: 0 }, 100);
    expect(stepN(pistol, 20, { fire: true }).inv.slots[0]!.mag).toBe(4);
    const last = stepActions(base({ slots: [{ weapon: 'pistol', mag: 1 }, null] }), inp({ fire: true }), M, B);
    expect(last.inv.slots[0]!.mag).toBe(0);
    expect(last.reload).toMatchObject({ weapon: 'pistol' });
  });

  it('snapshot base: cooking from cookExplodesAt, held item per slot', () => {
    const tick = 120; // 4000 ms at 30 Hz
    const a = actionsFromSnapshot(makeLocal(1, { activeSlot: 3, grenades: 1, cookExplodesAt: 5_000 }), 100, tick, {
      lastGunSlot: 1,
      nextFireAt: 0,
      lastShotAt: -Infinity,
      lastShotWeapon: null,
      triggerLatched: false,
      prevFire: true,
    });
    expect(cookRemainingMs(a)).toBeCloseTo(1_000, 6);
    expect(a.prevFire).toBe(true);
    expect(a.lastGunSlot).toBe(1);
    expect(actionsFromSnapshot(makeLocal(1, { cookExplodesAt: 5_000 }), 100).prevFire).toBe(true);
    expect(heldOf(a)).toBe('grenade');
    expect(heldOf(base())).toBe('pistol');
    expect(heldOf(base({ activeSlot: 2 }))).toBe('fists');
  });

  it('M2b: the World time origin (WorldOptions.timeOriginMs) shifts the predicted clock', () => {
    const origin = 1_234_567;
    const snap = { tick: 120, serverTime: origin + 120 * SIM_DT * 1000 };
    expect(snapshotOriginMs(snap)).toBeCloseTo(origin, 6);
    const a = actionsFromSnapshot(makeLocal(1, { activeSlot: 3, grenades: 1, cookExplodesAt: snap.serverTime + 900 }), 100, snap.tick, null, snapshotOriginMs(snap));
    expect(actionsNowMs(a)).toBeCloseTo(snap.serverTime, 6);
    expect(cookRemainingMs(a)).toBeCloseTo(900, 6);
    expect(cookRemainingMs(stepActions(a, inp({ fire: true }), M, B))).toBeCloseTo(900 - SIM_DT * 1000, 6);
  });
});

/**
 * Real World vs Predictor with one-way latency of LAT ticks in both directions (REVIEW-M1 m1, and the World part of
 * m2). The player walks, sprints, strafes diagonally, turns and jumps, and starts, cancels (Q, fire) and finishes
 * heals. Returns the largest reconciliation correction.
 */
interface Scenario {
  setup(sp: ReturnType<ReturnType<typeof playingWorld>['w']['debugPlayer']> & object): void;
  script(t: number): Partial<PlayerInput>;
  /** Assert the heal really ran (the M1 scenario). */
  checkHeal: boolean;
}

const HEAL_SCENARIO: Scenario = {
  setup: (sp) => {
    sp.hp = 30;
    sp.inv.heals.bandage = 3;
  },
  script: (t) => {
    const healAt = new Set([10, 100, 130, 140, 175]);
    const fireAt = new Set([160, 161]);
    const jumpAt = new Set([40, 120, 200, 260]);
    return {
      moveForward: 1,
      moveRight: t > 220 && t < 250 ? -1 : 0,
      yaw: 0.4 + t * 0.002,
      sprint: t < 60 || t > 90,
      jump: jumpAt.has(t),
      useHeal: healAt.has(t),
      fire: fireAt.has(t),
    };
  },
  checkHeal: true,
};

function runAgainstWorld<A>(
  model: StatusModel<A>,
  baseOf: (local: LocalPlayerState, hp: number, tick: number, carry: A | null) => A,
  scenario: Scenario = HEAL_SCENARIO,
): number {
  const LAT = 4;
  const TICKS = 300;
  const balance = balanceWith(() => {});
  // Two humans: a one-player match ends on the first tick. The second one idles at another spawn.
  const { w, ids } = playingWorld(2, { balance });
  const id = ids[0]!;
  const sp = w.debugPlayer(id)!;
  scenario.setup(sp);

  const ctx = createMovementContext(w.debugContext().map, balance);
  const step: PredictStep = (s, i, status) => stepMovement(s, toMovementInput(i, status, balance), i.dt, ctx);
  const predictor = new Predictor(step, { snapDistance: 3, decayMs: 100, maxPending: 90 }, model);

  const toServer: { at: number; input: PlayerInput }[] = [];
  const toClient: { at: number; snap: ReturnType<typeof w.snapshotFor> }[] = [];
  let worst = 0;
  let reconciles = 0;
  let healTicks = 0;

  const first = w.snapshotFor(id);
  predictor.reconcile(first.local!.movement, first.local!.lastProcessedInputSeq, baseOf(first.local!, sp.hp, first.tick, null));

  for (let t = 1; t <= TICKS; t++) {
    // Client: one input per tick, predicted immediately.
    const i = simInput({ seq: t, ...scenario.script(t) });
    predictor.apply(i);
    if (predictor.status?.healing) healTicks++;
    toServer.push({ at: t + LAT, input: i });

    // Server: inputs that arrived this tick, then one step, then a snapshot on its way back.
    while (toServer.length && toServer[0]!.at <= t) w.applyInput(id, toServer.shift()!.input);
    w.step(SIM_DT);
    toClient.push({ at: t + LAT, snap: w.snapshotFor(id) });

    // Client: snapshots that arrived this tick.
    while (toClient.length && toClient[0]!.at <= t) {
      const snap = toClient.shift()!.snap;
      const me = snap.players.find((p) => p.id === id)!;
      const res = predictor.reconcile(
        snap.local!.movement,
        snap.local!.lastProcessedInputSeq,
        baseOf(snap.local!, me.hp, snap.tick, predictor.actionsAfter(snap.local!.lastProcessedInputSeq)),
      );
      worst = Math.max(worst, res.correction);
      reconciles++;
    }
  }
  expect(reconciles).toBeGreaterThan(200);
  // The scenario really heals for a while (otherwise the test proves nothing).
  if (scenario.checkHeal) expect(healTicks).toBeGreaterThan(ticksFor(B.items.bandage.useMs));
  return worst;
}

describe('heal-aware prediction against the real World', () => {
  it('predicting the heal state from local inputs gives no correction through heal start, cancel and finish', () => {
    const worst = runAgainstWorld(actionStatusModel(balanceWith(() => {})), (l, hp, tick, carry) => actionsFromSnapshot(l, hp, tick, carry));
    expect(worst).toBeLessThan(1e-6);
  });

  it('M2a: ADS, stance toggles, swaps, an LMG burst (fire slow-down), a reload and grenade throws predict with no correction', () => {
    const scenario: Scenario = {
      setup: (sp) => {
        sp.inv.slots = [{ weapon: 'rifle', mag: 25 }, { weapon: 'lmg', mag: 60 }];
        sp.inv.activeSlot = 0;
        sp.inv.ammo.ammo_heavy = 120;
        sp.inv.grenades = 2;
      },
      script: (t) => ({
        moveForward: 1,
        moveRight: t % 50 < 10 ? 1 : 0,
        yaw: 0.4 + t * 0.003,
        sprint: (t > 5 && t < 15) || (t > 150 && t < 160),
        ads: (t >= 10 && t < 45) || (t >= 85 && t < 100),
        stanceToggle: t === 30 ? 'crouch' : t === 60 ? 'prone' : t === 80 ? 'prone' : t === 120 ? 'crouch' : null,
        jump: t === 140,
        selectSlot: t === 90 ? 1 : t === 170 ? 3 : t === 230 ? 0 : -1,
        fire: (t >= 100 && t < 115) || (t >= 180 && t < 190) || (t >= 205 && t < 212),
        reload: t === 125,
      }),
      checkHeal: false,
    };
    const model = actionStatusModel(balanceWith(() => {}));
    const worst = runAgainstWorld(model, (l, hp, tick, carry) => actionsFromSnapshot(l, hp, tick, carry), scenario);
    expect(worst).toBeLessThan(1e-6);
  });

  it('Predictor runs edges after the movement step: a heal start ends ADS (adsMs reset) like the server', () => {
    const local = makeLocal(1, { slots: [{ weapon: 'rifle', mag: 25 }, null], activeSlot: 0, heals: { bandage: 1, medkit: 0 } });
    const seen: PredictStatus[] = [];
    const step: PredictStep = (s, _i, status) => {
      seen.push(status);
      return { state: { ...s, adsMs: s.adsMs + 10 }, jumped: false, landed: false, landingSpeed: 0, stanceChanged: null, stanceRefused: null, adsEngaged: true, ...NO_DROP_STEP };
    };
    const p = new Predictor(step, { snapDistance: 3, decayMs: 100, maxPending: 90 }, actionStatusModel(B));
    p.reconcile(makeMovement(), 0, actionsFromSnapshot(local, 40));
    p.apply(inp({ seq: 1 }));
    expect(p.state!.adsMs).toBe(10);
    p.apply(inp({ seq: 2, useHeal: true }));
    // Movement ran without the heal (pre-edge status), then the heal start ended ADS.
    expect(seen[1]!.healing).toBe(false);
    expect(p.state!.adsMs).toBe(0);
    p.apply(inp({ seq: 3 }));
    expect(seen[2]!.healing).toBe(true);
  });

  it('control: using the snapshot heal flag for every pending input (the old behaviour) does cause corrections', () => {
    const snapshotStatus: StatusModel<PredictStatus> = { step: (status) => ({ actions: status, status }) };
    const worst = runAgainstWorld(snapshotStatus, (local): PredictStatus => ({
      alive: true,
      healing: local.healRemainingMs > 0,
      reloading: local.reloadRemainingMs > 0,
      held: local.activeSlot === 3 ? 'grenade' : local.activeSlot === 2 ? 'fists' : (local.slots[local.activeSlot]?.weapon ?? 'fists'),
      swapping: local.swapRemainingMs > 0,
      fireSlowed: false,
    }));
    expect(worst).toBeGreaterThan(0.01);
  });
});
