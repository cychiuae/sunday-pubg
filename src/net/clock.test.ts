import { describe, expect, it } from 'vitest';
import { CLOCK_SLEW_RATE, CLOCK_SNAP_MS, ClockSync } from './clock';

/** Simulates a ping: server clock = client clock + trueOffset; up/down one-way delays. */
function ping(c: ClockSync, now: number, trueOffset: number, up: number, down: number): number {
  const serverTime = now + up + trueOffset;
  const recv = now + up + down;
  c.addSample(now, serverTime, recv);
  return recv;
}

describe('ClockSync', () => {
  it('estimates the offset exactly with symmetric latency', () => {
    const c = new ClockSync();
    const recv = ping(c, 1000, 5000, 40, 40);
    expect(c.serverNow(recv)).toBeCloseTo(recv + 5000);
    expect(c.rttMs).toBe(80);
  });

  it('prefers the lowest-RTT sample of the last 5 (queuing delay rejection)', () => {
    const c = new ClockSync();
    let now = 0;
    now = ping(c, now + 1000, 2000, 25, 25); // clean
    now = ping(c, now + 1000, 2000, 25, 300); // one-way queuing spike: sample offset is 137.5 ms off
    now = ping(c, now + 1000, 2000, 200, 25);
    expect(c.serverNow(now)).toBeCloseTo(now + 2000, 0);
  });

  it('slews small corrections smoothly and keeps serverNow monotonic', () => {
    const c = new ClockSync();
    let now = ping(c, 0, 1000, 20, 20);
    // The true offset drifts by +100 ms (< snap threshold).
    for (let i = 0; i < 5; i++) now = ping(c, now + 1000, 1100, 20, 20);
    let prev = c.serverNow(now);
    for (let t = 1; t <= 2000; t += 16) {
      const s = c.serverNow(now + t);
      expect(s).toBeGreaterThan(prev);
      // Never runs faster than real time plus the slew rate.
      expect(s - prev).toBeLessThanOrEqual(16 * (1 + CLOCK_SLEW_RATE) + 1e-6);
      prev = s;
    }
    expect(c.serverNow(now + 2000) - (now + 2000)).toBeCloseTo(1100, 0);
  });

  it('snaps large corrections', () => {
    const c = new ClockSync();
    let now = ping(c, 0, 0, 10, 10);
    for (let i = 0; i < 5; i++) now = ping(c, now + 1000, CLOCK_SNAP_MS * 4, 10, 10);
    expect(c.serverNow(now) - now).toBeCloseTo(CLOCK_SNAP_MS * 4);
  });

  it('roughSync gives a lower bound before any ping and is ignored afterwards', () => {
    const c = new ClockSync();
    c.roughSync(500, 100);
    expect(c.serverNow(100)).toBe(500);
    c.roughSync(400, 100); // older hint does not move it back
    expect(c.serverNow(100)).toBe(500);
    const recv = ping(c, 200, 1000, 10, 10);
    c.roughSync(99999, recv);
    expect(c.serverNow(recv)).toBeCloseTo(recv + 1000);
  });
});
