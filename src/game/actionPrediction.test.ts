import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { SIM_DT } from '../shared/constants';
import { createMovementContext, stepMovement, toMovementInput } from '../shared/sim/movement';
import { balanceWith, input as simInput, playingWorld } from '../shared/sim/testkit';
import type { LocalPlayerState, PlayerInput } from '../shared/types';
import { actionsFromSnapshot, actionStatusModel, stepActions, type PredictedActions } from './actionPrediction';
import { Predictor, type PredictStatus, type PredictStep, type StatusModel } from './prediction';
import { makeLocal } from './testFixtures';

const B = BALANCE;
const ticksFor = (ms: number): number => Math.ceil(ms / (SIM_DT * 1000) - 1e-9);

function inp(over: Partial<PlayerInput> = {}): PlayerInput {
  return simInput({ seq: 1, ...over });
}

function base(over: Partial<LocalPlayerState> = {}, hp = 40): PredictedActions {
  return actionsFromSnapshot(
    makeLocal(1, {
      slots: [{ weapon: 'pistol', mag: 3 }, null],
      activeSlot: 0,
      ammo: { ammo_light: 30, ammo_heavy: 0, ammo_shell: 0 },
      heals: { bandage: 2, medkit: 0 },
      ...over,
    }),
    hp,
  );
}

function stepN(a: PredictedActions, n: number, over: Partial<PlayerInput> = {}, dropping = false): PredictedActions {
  let s = a;
  for (let i = 0; i < n; i++) s = stepActions(s, inp(over), dropping, B);
  return s;
}

describe('stepActions (heal/reload/swap prediction)', () => {
  it('Q starts the heal in the same tick and it completes after useMs, applying the heal', () => {
    const started = stepActions(base(), inp({ useHeal: true }), false, B);
    expect(started.heal).toEqual({ item: 'bandage', remainingMs: B.items.bandage.useMs });
    const n = ticksFor(B.items.bandage.useMs);
    const almost = stepN(started, n - 1);
    expect(almost.heal).not.toBeNull();
    const done = stepN(almost, 1);
    expect(done.heal).toBeNull();
    expect(done.hp).toBe(40 + B.items.bandage.heal);
    expect(done.heals.bandage).toBe(1);
  });

  it('does not start while dropping, at full hp, or without heals', () => {
    expect(stepActions(base(), inp({ useHeal: true }), true, B).heal).toBeNull();
    expect(stepActions(base({}, B.player.maxHp), inp({ useHeal: true }), false, B).heal).toBeNull();
    expect(stepActions(base({ heals: { bandage: 0, medkit: 0 } }), inp({ useHeal: true }), false, B).heal).toBeNull();
  });

  it('a heal is cancelled by Q again, held fire, a slot switch, and a reload that starts', () => {
    const healing = stepActions(base(), inp({ useHeal: true }), false, B);
    expect(stepActions(healing, inp({ useHeal: true }), false, B).heal).toBeNull();
    expect(stepActions(healing, inp({ fire: true }), false, B).heal).toBeNull();
    const switched = stepActions(healing, inp({ selectSlot: 2 }), false, B);
    expect(switched.heal).toBeNull();
    expect(switched.swapMs).toBe(B.combat.swapMs);
    const reloading = stepActions(healing, inp({ reload: true }), false, B);
    expect(reloading.heal).toBeNull();
    expect(reloading.reload).toMatchObject({ slot: 0, weapon: 'pistol' });
  });

  it('switching to an empty slot, or a reload that cannot start (full mag, no reserve, swapping) keeps the heal', () => {
    const healing = stepActions(base(), inp({ useHeal: true }), false, B);
    expect(stepActions(healing, inp({ selectSlot: 1 }), false, B).heal).not.toBeNull();
    const fullMag = stepActions(base({ slots: [{ weapon: 'pistol', mag: B.weapons.pistol.magSize }, null] }), inp({ useHeal: true }), false, B);
    expect(stepActions(fullMag, inp({ reload: true }), false, B).heal).not.toBeNull();
    const noReserve = stepActions(base({ ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0 } }), inp({ useHeal: true }), false, B);
    expect(stepActions(noReserve, inp({ reload: true }), false, B).heal).not.toBeNull();
    const swapping = stepActions(base({ swapRemainingMs: 300 }), inp({ useHeal: true }), false, B);
    expect(stepActions(swapping, inp({ reload: true }), false, B).heal).not.toBeNull();
  });

  it('a heal start cancels a reload; a finished reload fills the mag from reserve', () => {
    const reloading = base({ reloadRemainingMs: 500, reloadTotalMs: B.weapons.pistol.reloadMs });
    expect(reloading.reload).toMatchObject({ slot: 0, weapon: 'pistol', remainingMs: 500 });
    const healed = stepActions(reloading, inp({ useHeal: true }), false, B);
    expect(healed.reload).toBeNull();
    expect(healed.heal).not.toBeNull();
    const done = stepN(reloading, ticksFor(500));
    expect(done.reload).toBeNull();
    expect(done.slots[0]!.mag).toBe(B.weapons.pistol.magSize);
    expect(done.ammo.ammo_light).toBe(30 - (B.weapons.pistol.magSize - 3));
  });

  it('does not mutate its input', () => {
    const a = base({ reloadRemainingMs: 10, reloadTotalMs: 1400 });
    const before = structuredClone(a);
    stepN(a, 3, { useHeal: true });
    expect(a).toEqual(before);
  });
});

/**
 * Real World vs Predictor with one-way latency of LAT ticks in both directions (REVIEW-M1 m1, and the World part of
 * m2). The player walks, sprints, strafes diagonally, turns and jumps, and starts, cancels (Q, fire) and finishes
 * heals. Returns the largest reconciliation correction.
 */
function runAgainstWorld<A>(model: StatusModel<A>, baseOf: (local: LocalPlayerState, hp: number) => A): number {
  const LAT = 4;
  const TICKS = 300;
  const balance = balanceWith(() => {});
  // Two humans: a one-player match ends on the first tick. The second one idles at another spawn.
  const { w, ids } = playingWorld(2, { balance });
  const id = ids[0]!;
  const sp = w.debugPlayer(id)!;
  sp.hp = 30;
  sp.inv.heals.bandage = 3;

  const ctx = createMovementContext(w.debugContext().map, balance);
  const step: PredictStep = (s, i, status) => stepMovement(s, toMovementInput(i, status, balance), i.dt, ctx);
  const predictor = new Predictor(step, { snapDistance: 3, decayMs: 100, maxPending: 90 }, model);

  const healAt = new Set([10, 100, 130, 140, 175]);
  const fireAt = new Set([160, 161]);
  const jumpAt = new Set([40, 120, 200, 260]);
  const toServer: { at: number; input: PlayerInput }[] = [];
  const toClient: { at: number; snap: ReturnType<typeof w.snapshotFor> }[] = [];
  let worst = 0;
  let reconciles = 0;
  let healTicks = 0;

  const first = w.snapshotFor(id);
  predictor.reconcile(first.local!.movement, first.local!.lastProcessedInputSeq, baseOf(first.local!, sp.hp));

  for (let t = 1; t <= TICKS; t++) {
    // Client: one input per tick, predicted immediately.
    const i = simInput({
      seq: t,
      moveForward: 1,
      moveRight: t > 220 && t < 250 ? -1 : 0,
      yaw: 0.4 + t * 0.002,
      sprint: t < 60 || t > 90,
      jump: jumpAt.has(t),
      useHeal: healAt.has(t),
      fire: fireAt.has(t),
    });
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
      const res = predictor.reconcile(snap.local!.movement, snap.local!.lastProcessedInputSeq, baseOf(snap.local!, me.hp));
      worst = Math.max(worst, res.correction);
      reconciles++;
    }
  }
  expect(reconciles).toBeGreaterThan(200);
  // The scenario really heals for a while (otherwise the test proves nothing).
  expect(healTicks).toBeGreaterThan(ticksFor(B.items.bandage.useMs));
  return worst;
}

describe('heal-aware prediction against the real World', () => {
  it('predicting the heal state from local inputs gives no correction through heal start, cancel and finish', () => {
    const worst = runAgainstWorld(actionStatusModel(balanceWith(() => {})), actionsFromSnapshot);
    expect(worst).toBeLessThan(1e-6);
  });

  it('control: using the snapshot heal flag for every pending input (the old behaviour) does cause corrections', () => {
    const snapshotStatus: StatusModel<PredictStatus> = { step: (status) => ({ actions: status, status }) };
    const worst = runAgainstWorld(snapshotStatus, (local) => ({
      alive: true,
      healing: local.healRemainingMs > 0,
      reloading: local.reloadRemainingMs > 0,
    }));
    expect(worst).toBeGreaterThan(0.01);
  });
});
