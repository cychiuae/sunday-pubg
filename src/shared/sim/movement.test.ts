import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import { createRng } from '../math';
import type { MovementInput, MovementState } from '../types';
import { ISLAND } from '../../game/levels/island';
import { DOCK_DECK_HEIGHT, PROP_SHAPES } from './colliders';
import { createMovementContext, groundHeightAt, isInWater, stepMovement, toMovementInput, type MovementContext } from './movement';
import { heightAt } from './terrain';
import { flatMap, input } from './testkit';

const b = BALANCE;
const mv = (over: Partial<MovementInput> = {}): MovementInput => ({
  moveForward: 0,
  moveRight: 0,
  yaw: 0,
  jump: false,
  sprint: false,
  speedMultiplier: 1,
  canSprint: true,
  stanceToggle: null,
  ads: false,
  held: 'fists',
  adsBlocked: false,
  ...over,
});
/** Settled standing, not aiming, no drop phase (a dropping state with dropPhase null is the M1 parachute-speed drop). */
const STANCE0 = { stance: 'stand', stanceFrom: 'stand', stanceMs: 0, adsMs: 0, dropPhase: null, dropMs: 0 } as const;
const grounded = (x: number, y: number, z: number): MovementState => ({
  pos: { x, y, z },
  vel: { x: 0, y: 0, z: 0 },
  grounded: true,
  dropping: false,
  ...STANCE0,
});
function simulate(state: MovementState, inp: MovementInput | ((i: number) => MovementInput), n: number, ctx: MovementContext) {
  let s = state;
  let landed = 0;
  let landingSpeed = 0;
  for (let i = 0; i < n; i++) {
    const r = stepMovement(s, typeof inp === 'function' ? inp(i) : inp, SIM_DT, ctx);
    s = r.state;
    if (r.landed) {
      landed++;
      landingSpeed = r.landingSpeed;
    }
  }
  return { s, landed, landingSpeed };
}
const hspeed = (s: MovementState) => Math.hypot(s.vel.x, s.vel.z);

describe('movement', () => {
  const flat = createMovementContext(flatMap(), b);

  it('is deterministic and does not mutate its arguments', () => {
    const ctx = createMovementContext(ISLAND, b);
    const rng = createRng(42);
    const inputs = Array.from({ length: 600 }, () =>
      mv({
        moveForward: rng.range(-1, 1),
        moveRight: rng.range(-1, 1),
        yaw: rng.range(-3, 3),
        jump: rng.next() < 0.05,
        sprint: rng.next() < 0.5,
      }),
    );
    const start: MovementState = { pos: { x: 30, y: 40, z: 60 }, vel: { x: 0, y: 0, z: 0 }, grounded: false, dropping: true, ...STANCE0 };
    const frozen = JSON.stringify(start);
    const a = simulate(start, (i) => inputs[i]!, 600, ctx);
    const c = simulate(start, (i) => inputs[i]!, 600, ctx);
    expect(JSON.stringify(a.s)).toBe(JSON.stringify(c.s));
    expect(JSON.stringify(start)).toBe(frozen);
  });

  it('walks forward (yaw 0 = -Z) at walkSpeed and sprints at sprintSpeed', () => {
    const w = simulate(grounded(0, 2, 0), mv({ moveForward: 1 }), 30, flat).s;
    expect(hspeed(w)).toBeCloseTo(b.movement.walkSpeed, 5);
    expect(w.vel.z).toBeLessThan(0);
    const s = simulate(grounded(0, 2, 0), mv({ moveForward: 1, sprint: true }), 30, flat).s;
    expect(hspeed(s)).toBeCloseTo(b.movement.sprintSpeed, 5);
    // No sprint backwards or when canSprint is false.
    expect(hspeed(simulate(grounded(0, 2, 0), mv({ moveForward: -1, sprint: true }), 30, flat).s)).toBeCloseTo(b.movement.walkSpeed, 5);
    expect(hspeed(simulate(grounded(0, 2, 0), mv({ moveForward: 1, sprint: true, canSprint: false }), 30, flat).s)).toBeCloseTo(
      b.movement.walkSpeed,
      5,
    );
  });

  it('toMovementInput: healing slows and blocks sprint, holding fire blocks sprint, dead = no movement', () => {
    const i = input({ moveForward: 1, sprint: true });
    const heal = toMovementInput(i, { alive: true, healing: true, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, b);
    expect(heal.speedMultiplier).toBe(b.movement.healMoveMultiplier);
    expect(heal.canSprint).toBe(false);
    expect(toMovementInput({ ...i, fire: true }, { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, b).canSprint).toBe(false);
    expect(toMovementInput(i, { alive: false, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, b).speedMultiplier).toBe(0);
    const s = simulate(grounded(0, 2, 0), heal, 30, flat).s;
    expect(hspeed(s)).toBeCloseTo(b.movement.walkSpeed * b.movement.healMoveMultiplier, 5);
  });

  it('friction stops the player when input is released', () => {
    const moving = simulate(grounded(0, 2, 0), mv({ moveForward: 1 }), 30, flat).s;
    const stopped = simulate(moving, mv(), 30, flat).s;
    expect(hspeed(stopped)).toBeLessThan(0.01);
  });

  it('jumps about v^2/2g high and lands with landingSpeed ~ jumpVelocity', () => {
    let s = grounded(0, 2, 0);
    let maxY = 2;
    let jumped = false;
    let landing = 0;
    for (let i = 0; i < 60; i++) {
      const r = stepMovement(s, mv({ jump: i === 0 }), SIM_DT, flat);
      if (r.jumped) jumped = true;
      if (r.landed) landing = r.landingSpeed;
      s = r.state;
      maxY = Math.max(maxY, s.pos.y);
    }
    expect(jumped).toBe(true);
    const apex = (b.movement.jumpVelocity ** 2) / (2 * b.movement.gravity);
    expect(maxY - 2).toBeGreaterThan(apex * 0.85);
    expect(maxY - 2).toBeLessThan(apex * 1.05);
    expect(landing).toBeGreaterThan(b.movement.jumpVelocity * 0.85);
    expect(s.grounded).toBe(true);
    expect(s.pos.y).toBeCloseTo(2, 9);
  });

  it("can't walk through a rock; slides around it when off-centre", () => {
    const ctx = createMovementContext(flatMap({}, [{ kind: 'rock', x: 0, z: -5, rotY: 0, scale: 1 }]), b);
    const minD = PROP_SHAPES.rock[0]!.shape === 'circle' ? PROP_SHAPES.rock[0]!.r + b.player.radius - 1e-6 : 0;
    expect(minD).toBeGreaterThan(1.8);
    let s = grounded(0, 2, 0);
    for (let i = 0; i < 120; i++) {
      s = stepMovement(s, mv({ moveForward: 1 }), SIM_DT, ctx).state;
      expect(Math.hypot(s.pos.x, s.pos.z + 5)).toBeGreaterThanOrEqual(minD);
    }
    expect(s.pos.z).toBeGreaterThan(-5);
    // Off-centre: slides past.
    let t = grounded(0.5, 2, 0);
    for (let i = 0; i < 120; i++) {
      t = stepMovement(t, mv({ moveForward: 1 }), SIM_DT, ctx).state;
      expect(Math.hypot(t.pos.x, t.pos.z + 5)).toBeGreaterThanOrEqual(minD);
    }
    expect(t.pos.z).toBeLessThan(-8);
  });

  it('hops onto a crate (jump + forward) and stands on its top', () => {
    const ctx = createMovementContext(flatMap({}, [{ kind: 'crate', x: 0, z: -2, rotY: 0, scale: 1 }]), b);
    // Walking into it is blocked.
    const blocked = simulate(grounded(0, 2, 0), mv({ moveForward: 1 }), 60, ctx).s;
    expect(blocked.pos.z).toBeGreaterThan(-1.5 + 0.0);
    expect(blocked.pos.y).toBeCloseTo(2, 6);
    const on = simulate(grounded(0, 2, 0), (i) => mv({ moveForward: i < 14 ? 1 : 0, jump: i === 0 }), 60, ctx).s;
    expect(on.pos.y).toBeCloseTo(3, 6);
    expect(on.grounded).toBe(true);
  });

  it('is slowed in water deeper than waterDepthThreshold', () => {
    const ctx = createMovementContext(ISLAND, b);
    const x = 0;
    const z = -125; // sea north of the island
    const y = heightAt(x, z, ISLAND);
    const start = grounded(x, y, z);
    expect(isInWater(start, b)).toBe(true);
    const s = simulate(start, mv({ moveForward: 0, moveRight: 1 }), 30, ctx).s;
    expect(hspeed(s)).toBeCloseTo(b.movement.walkSpeed * b.movement.waterSpeedMultiplier, 3);
  });

  it('stops at the world radius', () => {
    const m = flatMap();
    const s = simulate(grounded(0, 2, -(m.worldRadius - 2)), mv({ moveForward: 1 }), 120, flat).s;
    expect(Math.hypot(s.pos.x, s.pos.z)).toBeLessThanOrEqual(m.worldRadius - b.player.radius + 1e-6);
  });

  it('drop phase: constant fall speed, steer speed, lands without dropping flag', () => {
    const start: MovementState = { pos: { x: 0, y: 32, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: false, dropping: true, ...STANCE0 };
    const r1 = stepMovement(start, mv({ moveForward: 1 }), SIM_DT, flat);
    expect(r1.state.vel.y).toBe(-b.movement.dropFallSpeed);
    expect(hspeed(r1.state)).toBeCloseTo(b.movement.dropSteerSpeed, 9);
    const end = simulate(start, mv({ moveForward: 1 }), 30 * 6, flat);
    expect(end.s.dropping).toBe(false);
    expect(end.s.grounded).toBe(true);
    expect(end.landed).toBe(1);
    expect(end.landingSpeed).toBe(b.movement.dropFallSpeed);
  });

  it('falling (not dropping) reports landing speed for fall damage, capped by terminal velocity', () => {
    const start: MovementState = { pos: { x: 0, y: 200, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: false, dropping: false, ...STANCE0 };
    const r = simulate(start, mv(), 30 * 10, flat);
    expect(r.landingSpeed).toBeLessThanOrEqual(b.movement.terminalVelocity);
    expect(r.landingSpeed).toBeGreaterThan(b.movement.fallDamageMinSpeed);
  });

  it('dock decks are walkable over the sea', () => {
    const ctx = createMovementContext(ISLAND, b);
    const dock = ISLAND.props.find((p) => p.kind === 'dock' && p.scale === 1)!;
    // Seaward end of the main dock (local +Z points out to sea).
    const x = dock.x + Math.sin(dock.rotY) * 6;
    const z = dock.z + Math.cos(dock.rotY) * 6;
    expect(heightAt(x, z, ISLAND)).toBeLessThan(0);
    expect(groundHeightAt(ctx, x, z, DOCK_DECK_HEIGHT)).toBeCloseTo(DOCK_DECK_HEIGHT, 9);
    // Walk from the landward end to the seaward end along the deck: stays on top.
    const yaw = Math.atan2(-Math.sin(dock.rotY), -Math.cos(dock.rotY)); // face local +Z
    const lx = dock.x - Math.sin(dock.rotY) * 2;
    const lz = dock.z - Math.cos(dock.rotY) * 2;
    let s = grounded(lx, groundHeightAt(ctx, lx, lz, DOCK_DECK_HEIGHT), lz);
    for (let i = 0; i < 30; i++) s = stepMovement(s, mv({ moveForward: 1, yaw }), SIM_DT, ctx).state;
    expect(s.pos.y).toBeCloseTo(DOCK_DECK_HEIGHT, 6);
    expect(heightAt(s.pos.x, s.pos.z, ISLAND)).toBeLessThan(0);
  });
});
