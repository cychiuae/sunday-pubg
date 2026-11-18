import { describe, expect, it } from 'vitest';
import { DEFAULT_LOOK_MAX_DELTA_PX, LookFilter } from './lookFilter';
import { InputState } from './InputState';

describe('LookFilter (BUG-002)', () => {
  it('drops the re-centring spike on the first locked mousemove after taking the lock', () => {
    const f = new LookFilter();
    f.onLockChange(); // locked
    expect(f.filter(-639, -275, true)).toBeNull();
    expect(f.filter(0, 0, true)).toEqual({ dx: 0, dy: 0 });
    expect(f.filter(5, -3, true)).toEqual({ dx: 5, dy: -3 });
  });

  it('also drops the first locked move when it arrives before pointerlockchange', () => {
    const f = new LookFilter();
    f.filter(10, 10, false); // unlocked moves are ignored and arm the filter
    expect(f.filter(-480, -270, true)).toBeNull();
    f.onLockChange(); // late lock-change event re-arms; one more ordinary move is dropped, which is harmless
    expect(f.filter(1, 1, true)).toBeNull();
    expect(f.filter(2, 2, true)).toEqual({ dx: 2, dy: 2 });
  });

  it('re-arms on every new lock (Resume after Esc)', () => {
    const f = new LookFilter();
    f.onLockChange();
    f.filter(0, 0, true);
    expect(f.filter(3, 0, true)).toEqual({ dx: 3, dy: 0 });
    f.onLockChange(); // unlocked (Esc)
    expect(f.filter(50, 0, false)).toBeNull();
    f.onLockChange(); // locked again
    expect(f.filter(-600, 200, true)).toBeNull();
    expect(f.filter(3, 0, true)).toEqual({ dx: 3, dy: 0 });
  });

  it('clamps a later spike to the cap length, keeping its direction', () => {
    const f = new LookFilter();
    f.onLockChange();
    f.filter(0, 0, true);
    const out = f.filter(-639, -275, true)!;
    expect(Math.hypot(out.dx, out.dy)).toBeCloseTo(DEFAULT_LOOK_MAX_DELTA_PX);
    expect(out.dx / out.dy).toBeCloseTo(-639 / -275);
    expect(f.filter(DEFAULT_LOOK_MAX_DELTA_PX, 0, true)).toEqual({ dx: DEFAULT_LOOK_MAX_DELTA_PX, dy: 0 });
  });

  it('ignores non-finite movement', () => {
    const f = new LookFilter();
    f.onLockChange();
    f.filter(0, 0, true);
    expect(f.filter(Number.NaN, 1, true)).toBeNull();
  });

  it('with InputState: taking the lock does not move the view', () => {
    const f = new LookFilter();
    const s = new InputState(0.0022);
    const move = (dx: number, dy: number): void => {
      const d = f.filter(dx, dy, true);
      if (d) s.look(d.dx, d.dy);
    };
    f.onLockChange();
    move(-639, -275);
    move(0, 0);
    expect(s.yaw).toBe(0);
    expect(s.pitch).toBe(0);
  });
});
