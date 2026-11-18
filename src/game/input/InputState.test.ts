import { describe, expect, it } from 'vitest';
import { PITCH_MAX, PITCH_MIN } from '../../shared/constants';
import { ADS_BUTTON, cycleSlot, DEFAULT_KEY_BINDINGS, InputState } from './InputState';

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

  it('M2a: cycles 0 -> 1 -> 2 -> 3 -> 0, with slot 3 only while carrying grenades', () => {
    expect(cycleSlot(2, [true, true], 1, true)).toBe(3);
    expect(cycleSlot(3, [true, true], 1, true)).toBe(0);
    expect(cycleSlot(0, [true, true], -1, true)).toBe(3);
    expect(cycleSlot(2, [true, true], 1, false)).toBe(0);
    expect(cycleSlot(2, [false, false], 1, true)).toBe(3);
    expect(cycleSlot(3, [false, false], 1, false)).toBe(2);
  });
});

describe('M2a input mapping', () => {
  it('keys 4 and G (and numpad 4) select slot 3', () => {
    for (const code of ['Digit4', 'KeyG', 'Numpad4']) {
      const s = new InputState(0.002);
      s.keyDown(code);
      expect(s.sample(1, DT).input.selectSlot, code).toBe(3);
    }
  });

  it('C sends stanceToggle crouch and Z prone for exactly one input; the later press wins', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyC');
    expect(s.sample(1, DT).input.stanceToggle).toBe('crouch');
    expect(s.sample(2, DT).input.stanceToggle).toBeNull();
    s.keyDown('KeyZ');
    expect(s.sample(3, DT).input.stanceToggle).toBe('prone');
    s.keyDown('KeyC');
    s.keyUp('KeyC');
    s.keyUp('KeyZ');
    s.keyDown('KeyZ');
    s.keyDown('KeyC');
    expect(s.sample(4, DT).input.stanceToggle).toBe('crouch');
    s.keyDown('KeyZ', true); // OS repeat: no new edge
    expect(s.sample(5, DT).input.stanceToggle).toBeNull();
  });

  it('Space stays the jump edge (the movement step turns it into a stance change when crouched or prone)', () => {
    const s = new InputState(0.002);
    s.keyDown('Space');
    expect(s.sample(1, DT).input).toMatchObject({ jump: true, stanceToggle: null });
  });

  it('Ctrl is never bound (Ctrl+W closes the tab)', () => {
    expect(DEFAULT_KEY_BINDINGS['ControlLeft']).toBeUndefined();
    expect(DEFAULT_KEY_BINDINGS['ControlRight']).toBeUndefined();
    expect(new InputState(0.002).keyDown('ControlLeft')).toBe(false);
  });

  it('hold mode: ads follows RMB; RMB never fires or cycles spectate', () => {
    const s = new InputState(0.002);
    expect(s.sample(1, DT).input.ads).toBe(false);
    s.buttonDown(ADS_BUTTON);
    expect(s.sample(2, DT).input).toMatchObject({ ads: true, fire: false });
    expect(s.sample(3, DT).input.ads).toBe(true);
    expect(s.consumeSpectateNext()).toBe(false);
    s.buttonUp(ADS_BUTTON);
    expect(s.sample(4, DT).input.ads).toBe(false);
  });

  it('toggle mode: each press flips the latch; it clears on slot keys, wheel changes, sprint, releaseAll and death', () => {
    const s = new InputState(0.002);
    s.setAdsMode('toggle');
    const click = (): void => {
      s.buttonDown(ADS_BUTTON);
      s.buttonUp(ADS_BUTTON);
    };
    click();
    expect(s.sample(1, DT).input.ads).toBe(true);
    expect(s.sample(2, DT).input.ads).toBe(true);
    click();
    expect(s.sample(3, DT).input.ads).toBe(false);

    click();
    s.keyDown('Digit2');
    expect(s.sample(4, DT).input.ads).toBe(false);

    click();
    s.wheel(120);
    expect(s.sample(5, DT, () => 1).input.ads).toBe(false);
    click();
    s.wheel(120);
    expect(s.sample(6, DT, () => -1).input.ads).toBe(true); // no slot change: latch kept

    s.keyDown('ShiftLeft');
    expect(s.sample(7, DT).input.ads).toBe(false);
    s.keyUp('ShiftLeft');

    click();
    s.releaseAll();
    expect(s.sample(8, DT).input.ads).toBe(false);

    click();
    s.clearAdsToggle();
    expect(s.sample(9, DT).input.ads).toBe(false);
  });

  it('toggle mode: a press while ADS is not allowed (fists, grenade) does not latch; switching mode drops it', () => {
    const s = new InputState(0.002);
    s.setAdsMode('toggle');
    s.setAdsAllowed(false);
    s.buttonDown(ADS_BUTTON);
    s.buttonUp(ADS_BUTTON);
    expect(s.sample(1, DT).input.ads).toBe(false);
    s.setAdsAllowed(true);
    s.buttonDown(ADS_BUTTON);
    s.buttonUp(ADS_BUTTON);
    expect(s.sample(2, DT).input.ads).toBe(true);
    s.setAdsMode('hold');
    expect(s.sample(3, DT).input.ads).toBe(false);
  });

  it('look scale multiplies the look speed (ADS zoom and sensitivity); invalid values reset it to 1', () => {
    const s = new InputState(0.01);
    s.setLookScale(0.25);
    s.look(10, 0);
    expect(s.yaw).toBeCloseTo(-0.025);
    s.setLookScale(Number.NaN);
    expect(s.currentLookScale).toBe(1);
    s.setLookScale(0);
    expect(s.currentLookScale).toBe(1);
  });
});

describe('M2b input mapping', () => {
  const DT = 1 / 30;

  it('F is the jump edge only while enabled (aboard or dropping); Space always is', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyF');
    expect(s.sample(1, DT).input.jump).toBe(false);
    s.keyUp('KeyF');
    s.setAltJumpEnabled(true);
    s.keyDown('KeyF');
    expect(s.sample(2, DT).input.jump).toBe(true);
    expect(s.sample(3, DT).input.jump).toBe(false);
    // F never cycles spectate targets.
    expect(s.consumeSpectateNext()).toBe(false);
  });

  it('V latches the spectate view toggle once per press', () => {
    const s = new InputState(0.002);
    s.keyDown('KeyV');
    s.keyDown('KeyV', true);
    expect(s.consumeViewToggle()).toBe(true);
    expect(s.consumeViewToggle()).toBe(false);
  });

  it('pitch limits: look stays inside; an out-of-range pitch only moves inward and eases in', () => {
    const s = new InputState(0.01);
    s.setLook(0, 1.2);
    s.setPitchLimits(-0.5, 0.8);
    s.look(0, -10); // look up: would go further out -> held
    expect(s.pitch).toBeCloseTo(1.2);
    s.look(0, 5); // look down by 0.05: allowed
    expect(s.pitch).toBeCloseTo(1.15);
    s.easePitchIntoLimits(0.5);
    expect(s.pitch).toBeCloseTo(0.975);
    s.easePitchIntoLimits(1);
    expect(s.pitch).toBeCloseTo(0.8);
    s.look(0, -1000);
    expect(s.pitch).toBeCloseTo(0.8);
    s.look(0, 1000);
    expect(s.pitch).toBeCloseTo(-0.5);
    s.setPitchLimits(-10, 10);
    expect(s.pitchLimits.max).toBeLessThan(10);
  });
});
