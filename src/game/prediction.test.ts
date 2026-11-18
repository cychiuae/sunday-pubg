import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import { getMap, DEFAULT_MAP_ID } from './levels';
import { createMovementContext, stepMovement, toMovementInput } from '../shared/sim/movement';
import type { MovementState, PlayerInput } from '../shared/types';
import { fixedStatus, Predictor, type PredictStatus, type PredictStep } from './prediction';
import { makeMovement, NO_DROP_STEP } from './testFixtures';

const DT = 1 / 30;
const STATUS: PredictStatus = { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false };
const OPTS = { snapDistance: 3, decayMs: 100, maxPending: 90 };
const FIXED = fixedStatus(STATUS);

/** Toy step: x += moveRight * 6 * dt. Deterministic and easy to reason about. */
const toyStep: PredictStep = (state, input) => ({
  state: { ...state, pos: { ...state.pos, x: state.pos.x + input.moveRight * 6 * input.dt } },
  jumped: false,
  landed: false,
  landingSpeed: 0,
  stanceChanged: null,
  stanceRefused: null,
  ...NO_DROP_STEP,
  adsEngaged: false,
});

function input(seq: number, moveRight = 1): PlayerInput {
  return {
    seq,
    dt: DT,
    moveForward: 0,
    moveRight,
    yaw: 0,
    pitch: 0,
    sprint: false,
    fire: false,
    jump: false,
    reload: false,
    interact: false,
    useHeal: false,
    selectSlot: -1,
    ads: false,
    stanceToggle: null,
  };
}

describe('Predictor', () => {
  it('is inactive until the first reconcile, then starts from the server state', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    expect(p.active).toBe(false);
    expect(p.apply(input(1))).toBeNull();
    p.reconcile(makeMovement({ pos: { x: 5, y: 1, z: 2 } }), 0, null);
    expect(p.active).toBe(true);
    expect(p.state?.pos).toEqual({ x: 5, y: 1, z: 2 });
    expect(p.renderPosition(0.5)).toEqual({ x: 5, y: 1, z: 2 });
  });

  it('drops acknowledged inputs and replays the rest on top of the server state', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement(), 0, null);
    for (let i = 1; i <= 5; i++) p.apply(input(i));
    expect(p.pendingInputs).toHaveLength(5);
    expect(p.state?.pos.x).toBeCloseTo(1.0);

    // Server applied inputs 1..3 exactly like us.
    const res = p.reconcile(makeMovement({ pos: { x: 0.6, y: 0, z: 0 } }), 3, null);
    expect(p.pendingInputs.map((i) => i.seq)).toEqual([4, 5]);
    expect(res.replayed).toBe(2);
    expect(res.correction).toBeCloseTo(0);
    expect(p.state?.pos.x).toBeCloseTo(1.0);
  });

  it('small corrections are smoothed with a decaying visual offset', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement(), 0, null);
    for (let i = 1; i <= 3; i++) p.apply(input(i));
    const before = p.renderPosition(1)!;
    // Server says we were blocked 0.5 m earlier.
    const res = p.reconcile(makeMovement({ pos: { x: 0.1, y: 0, z: 0 } }), 2, null);
    expect(res.snapped).toBe(false);
    expect(p.state?.pos.x).toBeCloseTo(0.3);
    // Rendered position does not jump...
    expect(p.renderPosition(1)!.x).toBeCloseTo(before.x);
    // ...and converges to the corrected prediction as the offset decays.
    for (let i = 0; i < 60; i++) p.decay(1 / 60);
    expect(p.renderPosition(1)!.x).toBeCloseTo(0.3, 3);
  });

  it('large corrections snap', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement(), 0, null);
    p.apply(input(1));
    const res = p.reconcile(makeMovement({ pos: { x: 50, y: 0, z: 0 } }), 1, null);
    expect(res.snapped).toBe(true);
    expect(p.renderPosition(0)).toEqual({ x: 50, y: 0, z: 0 });
    expect(p.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('renderPosition lerps between the last two steps', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement(), 0, null);
    p.apply(input(1));
    expect(p.renderPosition(0)!.x).toBeCloseTo(0);
    expect(p.renderPosition(0.5)!.x).toBeCloseTo(0.1);
    expect(p.renderPosition(1)!.x).toBeCloseTo(0.2);
  });

  it('caps the pending buffer', () => {
    const p = new Predictor(toyStep, { ...OPTS, maxPending: 4 }, FIXED);
    p.reconcile(makeMovement(), 0, null);
    for (let i = 1; i <= 10; i++) p.apply(input(i));
    expect(p.pendingInputs.map((i) => i.seq)).toEqual([7, 8, 9, 10]);
  });

  it('reset deactivates and clears pending', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement(), 0, null);
    p.apply(input(1));
    p.reset();
    expect(p.active).toBe(false);
    expect(p.pendingInputs).toHaveLength(0);
  });

  it('with the shared stepMovement, replaying the same inputs reproduces the server state exactly (no correction)', () => {
    const map = getMap(DEFAULT_MAP_ID);
    const ctx = createMovementContext(map, BALANCE);
    const step: PredictStep = (state, i, status) =>
      stepMovement(state, toMovementInput(i, status, BALANCE), i.dt, ctx);
    const spawn = map.playerSpawns[0]!;
    // Start on the ground near a spawn: drop a few seconds first using the real sim.
    let ground: MovementState = makeMovement({ pos: { x: spawn.x, y: 20, z: spawn.z }, grounded: false });
    for (let i = 0; i < 120; i++) ground = step(ground, input(0, 0), STATUS).state;

    const client = new Predictor(step, OPTS, FIXED);
    client.reconcile(ground, 0, null);
    const inputs = Array.from({ length: 20 }, (_, k) => ({ ...input(k + 1, k % 2 ? 1 : 0.5), moveForward: 1, jump: k === 5 }));
    for (const i of inputs) client.apply(i);

    // Server processed the first 12 with the same function.
    let server = ground;
    for (const i of inputs.slice(0, 12)) server = step(server, i, STATUS).state;
    const res = client.reconcile(server, 12, null);
    expect(res.correction).toBeLessThan(1e-9);
  });

  it('M2a (stance.md test 16): C/Z/Space/sprint/ADS inputs predict identical stance and ADS state, no correction', () => {
    const map = getMap(DEFAULT_MAP_ID);
    const ctx = createMovementContext(map, BALANCE);
    const rifle: PredictStatus = { ...STATUS, held: 'rifle' };
    const step: PredictStep = (state, i, status) => stepMovement(state, toMovementInput(i, status, BALANCE), i.dt, ctx);
    const spawn = map.playerSpawns[0]!;
    let ground: MovementState = makeMovement({ pos: { x: spawn.x, y: 20, z: spawn.z }, grounded: false });
    for (let i = 0; i < 120; i++) ground = step(ground, input(0, 0), rifle).state;

    const script = (k: number): PlayerInput => ({
      ...input(k + 1, 0),
      moveForward: 1,
      yaw: k * 0.01,
      stanceToggle: k === 2 ? 'crouch' : k === 20 ? 'prone' : k === 60 ? 'crouch' : null,
      jump: k === 75 || k === 90,
      sprint: k >= 100 && k < 110,
      ads: (k >= 10 && k < 40) || k >= 112,
    });
    const inputs = Array.from({ length: 130 }, (_, k) => script(k));
    const client = new Predictor(step, OPTS, fixedStatus(rifle));
    client.reconcile(ground, 0, null);
    const predicted: MovementState[] = [];
    for (const i of inputs) predicted.push(client.apply(i)!.state);

    let server = ground;
    const seen = new Set<string>();
    for (let k = 0; k < inputs.length; k++) {
      server = step(server, inputs[k]!, rifle).state;
      const c = predicted[k]!;
      expect([c.stance, c.stanceFrom, c.stanceMs, c.adsMs]).toEqual([server.stance, server.stanceFrom, server.stanceMs, server.adsMs]);
      seen.add(server.stance);
    }
    // The script really visits every stance and aims.
    expect([...seen].sort()).toEqual(['crouch', 'prone', 'stand']);
    expect(predicted.some((m) => m.adsMs > 0)).toBe(true);
    const res = client.reconcile(server, inputs.length, null);
    expect(res.correction).toBeLessThan(1e-9);
  });

  it('M2b: seedPending (inactive only) replays inputs sent before prediction started that the server has not acked', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.seedPending([input(1), input(2), input(3)]);
    const res = p.reconcile(makeMovement(), 1, null);
    expect(res.replayed).toBe(2);
    expect(p.state!.pos.x).toBeCloseTo(2 * 6 * DT);
    // Ignored while active.
    p.seedPending([input(9), input(10)]);
    expect(p.pendingInputs.map((i) => i.seq)).toEqual([2, 3]);
  });

  it('M2b: movement states keep the drop fields (dropPhase, dropMs) through apply and reconcile', () => {
    const step: PredictStep = (state, i) => {
      const r = toyStep(state, i, STATUS);
      const d = state as MovementState & { dropMs?: number };
      return { ...r, state: Object.assign(r.state, { dropPhase: 'freefall', dropMs: (d.dropMs ?? 0) + 1 }) };
    };
    const p = new Predictor(step, OPTS, FIXED);
    p.reconcile(Object.assign(makeMovement({ dropping: true }), { dropPhase: 'freefall', dropMs: 5 }), 0, null);
    p.apply(input(1));
    p.apply(input(2));
    expect(p.state).toMatchObject({ dropPhase: 'freefall', dropMs: 7 });
    p.reconcile(Object.assign(makeMovement({ dropping: true }), { dropPhase: 'freefall', dropMs: 6 }), 1, null);
    expect(p.state).toMatchObject({ dropMs: 7 });
  });

  it('the decaying correction offset snaps to exactly 0 (no denormal tail on the rendered position)', () => {
    const p = new Predictor(toyStep, OPTS, FIXED);
    p.reconcile(makeMovement({ pos: { x: 0, y: 0, z: 0 } }), 0, null);
    p.apply(input(1, 0));
    p.reconcile(makeMovement({ pos: { x: 0, y: 0.5, z: 0 } }), 0, null); // 0.5 m correction -> visual offset
    expect(p.visualOffset.y).not.toBe(0);
    for (let i = 0; i < 2000; i++) p.decay(1 / 60);
    expect(p.visualOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(Object.is(p.renderPosition(1)!.y, 0.5)).toBe(true);
    // Stays exactly 0 afterwards; never a denormal.
    p.decay(1 / 60);
    expect(p.visualOffset.y).toBe(0);
  });
});
