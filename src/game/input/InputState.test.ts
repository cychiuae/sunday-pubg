import { describe, expect, it } from 'vitest';
import { PITCH_MAX, PITCH_MIN } from '../../shared/constants';
import { cycleSlot, InputState } from './InputState';

const DT = 1 / 30;

describe('InputState -> PlayerInput', () => {
  it('maps WASD to camera-relative move axes and normalises diagonals', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyW');
    expect(s.sample(1, DT).input).toMatchObject({ moveForward: 1, moveRight: 0 });
    s.keyDown('KeyD');
    const diag = s.sample(2, DT).input;
    expect(Math.hypot(diag.moveForward, diag.moveRight)).toBeCloseTo(1, 6);
    expect(diag.moveForward).toBeGreaterThan(0);
    expect(diag.moveRight).toBeGreaterThan(0);
    s.keyDown('KeyS');
    s.keyUp('KeyD');
    s.keyDown('KeyA');
    expect(s.sample(3, DT).input).toMatchObject({ moveForward: 0, moveRight: -1 });
  });

  it('carries seq, dt, yaw and pitch', () => {
    const s = new InputState(0.002);
    s.setLook(1, 0.2);
    const i = s.sample(7, DT).input;
    expect(i).toMatchObject({ seq: 7, dt: DT, yaw: 1, pitch: 0.2 });
  });

  it('latches edge buttons for exactly one input', () => {
    const s = new InputState(0.002);
    s.keyDown('Space');
    s.keyUp('Space'); // released before the tick: still sent once
    s.keyDown('KeyR');
    s.keyDown('KeyE');
    s.keyDown('KeyQ');
    s.keyDown('Digit2');
    const first = s.sample(1, DT).input;
    expect(first).toMatchObject({ jump: true, reload: true, interact: true, useHeal: true, selectSlot: 1 });
    const second = s.sample(2, DT).input;
    expect(second).toMatchObject({ jump: false, reload: false, interact: false, useHeal: false, selectSlot: -1 });
  });

  it('ignores OS key repeat for edges', () => {
    const s = new InputState(0.002);
    s.keyDown('Space');
    s.sample(1, DT);
    s.keyDown('Space', true);
    expect(s.sample(2, DT).input.jump).toBe(false);
  });

  it('holds sprint and fire while down', () => {
    const s = new InputState(0.002);
    s.keyDown('ShiftLeft');
    s.buttonDown(0);
    expect(s.sample(1, DT).input).toMatchObject({ sprint: true, fire: true });
    expect(s.sample(2, DT).input).toMatchObject({ sprint: true, fire: true });
    s.keyUp('ShiftLeft');
    s.buttonUp(0);
    expect(s.sample(3, DT).input).toMatchObject({ sprint: false, fire: false });
  });

  it('a click shorter than one tick still fires once and reports firePressed', () => {
    const s = new InputState(0.002);
    s.buttonDown(0);
    s.buttonUp(0);
    const a = s.sample(1, DT);
    expect(a.input.fire).toBe(true);
    expect(a.firePressed).toBe(true);
    const b = s.sample(2, DT);
    expect(b.input.fire).toBe(false);
    expect(b.firePressed).toBe(false);
  });

  it('release + re-press within one tick inserts a fire gap so semi-auto sees a new edge', () => {
    const s = new InputState(0.002);
    s.buttonDown(0);
    expect(s.sample(1, DT).input.fire).toBe(true);
    s.buttonUp(0);
    s.buttonDown(0);
    expect(s.sample(2, DT).input.fire).toBe(false);
    expect(s.sample(3, DT).input.fire).toBe(true);
  });

  it('a full click inside the gap tick still fires on the next tick', () => {
    const s = new InputState(0.002);
    s.buttonDown(0);
    s.sample(1, DT);
    s.buttonUp(0);
    s.buttonDown(0);
    s.buttonUp(0);
    expect(s.sample(2, DT).input.fire).toBe(false);
    expect(s.sample(3, DT).input.fire).toBe(true);
    expect(s.sample(4, DT).input.fire).toBe(false);
  });

  it('releaseAll clears held state (pointer lock lost) so the server does not repeat it', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyW');
    s.keyDown('ShiftLeft');
    s.buttonDown(0);
    s.sample(1, DT);
    s.releaseAll();
    expect(s.sample(2, DT).input).toMatchObject({ moveForward: 0, sprint: false, fire: false });
  });

  it('two keys bound to the same action: releasing one keeps it held', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyW');
    s.keyDown('ArrowUp');
    s.keyUp('KeyW');
    expect(s.sample(1, DT).input.moveForward).toBe(1);
  });

  it('mouse look: right turns right (yaw decreases), up looks up, sensitivity and invertY apply', () => {
    const s = new InputState(0.01);
    s.look(10, 0);
    expect(s.yaw).toBeCloseTo(-0.1);
    s.look(0, -10);
    expect(s.pitch).toBeCloseTo(0.1);
    s.setSensitivity(2, false);
    s.look(10, 0);
    expect(s.yaw).toBeCloseTo(-0.3);
    s.setSensitivity(1, true);
    s.look(0, -10);
    expect(s.pitch).toBeCloseTo(0);
  });

  it('clamps pitch and wraps yaw', () => {
    const s = new InputState(0.01);
    s.look(0, -100000);
    expect(s.pitch).toBe(PITCH_MAX);
    s.look(0, 100000);
    expect(s.pitch).toBe(PITCH_MIN);
    s.look(-1000, 0);
    expect(s.yaw).toBeGreaterThan(-Math.PI);
    expect(s.yaw).toBeLessThanOrEqual(Math.PI);
  });

  it('Space and LMB set the spectate-next latch, consumed once', () => {
    const s = new InputState(0.002);
    s.keyDown('Space');
    expect(s.consumeSpectateNext()).toBe(true);
    expect(s.consumeSpectateNext()).toBe(false);
    s.buttonDown(0);
    expect(s.consumeSpectateNext()).toBe(true);
  });

  it('clearEdges drops latched presses', () => {
    const s = new InputState(0.002);
    s.keyDown('Space');
    s.keyDown('Digit1');
    s.clearEdges();
    expect(s.sample(1, DT).input).toMatchObject({ jump: false, selectSlot: -1 });
  });

  it('mouse wheel resolves through the resolver; explicit keys win', () => {
    const s = new InputState(0.002);
    s.wheel(120);
    expect(s.sample(1, DT, (d) => (d === 1 ? 1 : 0)).input.selectSlot).toBe(1);
    s.wheel(-120);
    s.keyDown('Digit3');
    expect(s.sample(2, DT, () => 0).input.selectSlot).toBe(2);
  });
});

describe('cycleSlot', () => {
  it('skips empty weapon slots and wraps through fists', () => {
    expect(cycleSlot(2, [true, false], 1)).toBe(0);
    expect(cycleSlot(0, [true, false], 1)).toBe(2);
    expect(cycleSlot(0, [true, true], 1)).toBe(1);
    expect(cycleSlot(0, [true, true], -1)).toBe(2);
    expect(cycleSlot(2, [false, false], 1)).toBe(-1);
  });
});
