import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, PITCH_MAX, PITCH_MIN, SIM_DT } from '../src/shared/constants';
import { makeInput } from '../src/shared/protocol/testing';
import { RateLimiter, WindowCounter, mergeInputs, sanitizeInput, sanitizeName } from './validate';

describe('sanitizeName', () => {
  it.each([
    ['  Coco  ', 'Coco'],
    ['Coco\u0000\u0007Loco', 'CocoLoco'],
    ['a‮evil', 'aevil'], // bidi override stripped
    ['zero​width', 'zerowidth'],
    ['a   b\tc\nd', 'a b c d'],
    ['Piña', 'Piña'],
    ['🌴🌴', '🌴🌴'],
  ])('%j -> %j', (raw, out) => expect(sanitizeName(raw)).toBe(out));

  it.each(['', '   ', '\u0000\u0001', 'x'.repeat(MAX_NAME_LENGTH + 1)])('rejects %j', (raw) => {
    expect(sanitizeName(raw)).toBeNull();
  });

  it('counts code points, not UTF-16 units', () => {
    expect(sanitizeName('🌴'.repeat(MAX_NAME_LENGTH))).not.toBeNull();
  });
});

describe('sanitizeInput', () => {
  it('leaves an already-normalised move vector bit-identical (no second division by a 1-ulp length)', () => {
    // Search a few angles for vectors whose hypot rounds to 1 + 1 ulp; dividing again would change them.
    let checked = 0;
    for (let i = 1; i < 2000; i++) {
      const a = (i / 2000) * Math.PI * 2;
      const f = Math.cos(a);
      const r = Math.sin(a);
      if (Math.hypot(f, r) <= 1) continue;
      checked++;
      const out = sanitizeInput(makeInput({ seq: 1, moveForward: f, moveRight: r }), 0)!;
      expect(out.moveForward).toBe(f);
      expect(out.moveRight).toBe(r);
    }
    expect(checked).toBeGreaterThan(0);
    const once = sanitizeInput(makeInput({ seq: 1, moveForward: 1, moveRight: 1 }), 0)!;
    const twice = sanitizeInput({ ...once, seq: 2 }, 1)!;
    expect([twice.moveForward, twice.moveRight]).toEqual([once.moveForward, once.moveRight]);
  });

  it('rejects non-increasing seq', () => {
    expect(sanitizeInput(makeInput({ seq: 5 }), 5)).toBeNull();
    expect(sanitizeInput(makeInput({ seq: 4 }), 5)).toBeNull();
    expect(sanitizeInput(makeInput({ seq: 6 }), 5)).not.toBeNull();
  });

  it('clamps axes, diagonal length, pitch, dt, and wraps yaw', () => {
    const out = sanitizeInput(
      makeInput({ seq: 1, moveForward: 50, moveRight: -50, pitch: 10, dt: 5, yaw: 7 * Math.PI }),
      0,
    )!;
    expect(Math.hypot(out.moveForward, out.moveRight)).toBeCloseTo(1);
    expect(out.moveForward).toBeCloseTo(Math.SQRT1_2);
    expect(out.moveRight).toBeCloseTo(-Math.SQRT1_2);
    expect(out.pitch).toBe(PITCH_MAX);
    expect(out.dt).toBe(SIM_DT);
    expect(out.yaw).toBeCloseTo(Math.PI);
    expect(sanitizeInput(makeInput({ seq: 1, pitch: -10, dt: -1 }), 0)).toMatchObject({ pitch: PITCH_MIN, dt: 0 });
  });

  it('leaves valid input unchanged', () => {
    const input = makeInput({ seq: 3, moveForward: 0.5, moveRight: 0.5, yaw: 1, pitch: 0.2 });
    expect(sanitizeInput(input, 2)).toEqual(input);
  });
});

describe('RateLimiter', () => {
  it('allows the burst, then the steady rate', () => {
    const r = new RateLimiter(60, 60, 0);
    let ok = 0;
    for (let i = 0; i < 100; i++) if (r.take(0)) ok++;
    expect(ok).toBe(60);
    // One second later: 60 more.
    ok = 0;
    for (let i = 0; i < 100; i++) if (r.take(1000)) ok++;
    expect(ok).toBe(60);
  });

  it('a 30 Hz client is never limited at 2x headroom', () => {
    const r = new RateLimiter(60, 60, 0);
    for (let i = 0; i < 300; i++) expect(r.take(i * (1000 / 30))).toBe(true);
  });
});

describe('WindowCounter', () => {
  it('counts hits within the window', () => {
    const w = new WindowCounter(1000);
    expect(w.hit(0)).toBe(1);
    expect(w.hit(500)).toBe(2);
    expect(w.hit(1600)).toBe(1);
  });
});

describe('mergeInputs', () => {
  it('keeps newer held state and ORs edge presses', () => {
    const older = makeInput({ seq: 1, moveForward: 1, jump: true, reload: true, fire: true, selectSlot: 0 });
    const newer = makeInput({ seq: 2, moveForward: -1, yaw: 2, interact: true });
    expect(mergeInputs(older, newer)).toEqual({
      ...newer,
      jump: true,
      reload: true,
      fire: true,
      interact: true,
      selectSlot: 0,
    });
    expect(mergeInputs(older, { ...newer, selectSlot: 2 }).selectSlot).toBe(2);
  });
});
