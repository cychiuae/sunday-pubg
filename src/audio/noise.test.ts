import { describe, expect, it } from 'vitest';
import { fillLoopNoise, fillNoise } from './noise';

describe('noise generation', () => {
  for (const color of ['white', 'pink', 'brown'] as const) {
    it(`${color} noise is normalised, finite and DC-free`, () => {
      const buf = new Float32Array(8000);
      fillNoise(buf, color, 42);
      let peak = 0;
      let sum = 0;
      for (const s of buf) {
        expect(Number.isFinite(s)).toBe(true);
        peak = Math.max(peak, Math.abs(s));
        sum += s;
      }
      expect(peak).toBeCloseTo(0.95, 2);
      expect(Math.abs(sum / buf.length)).toBeLessThan(0.02);
    });
  }

  it('is deterministic per seed', () => {
    const a = new Float32Array(256);
    const b = new Float32Array(256);
    fillNoise(a, 'pink', 7);
    fillNoise(b, 'pink', 7);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('brown noise is much smoother than white (low-frequency weighted)', () => {
    const w = new Float32Array(8000);
    const br = new Float32Array(8000);
    fillNoise(w, 'white', 3);
    fillNoise(br, 'brown', 3);
    const roughness = (x: Float32Array): number => {
      let d = 0;
      for (let i = 1; i < x.length; i++) d += Math.abs((x[i] as number) - (x[i - 1] as number));
      return d / x.length;
    };
    expect(roughness(br)).toBeLessThan(roughness(w) / 5);
  });

  it('loop buffers are seamless (wrap step no bigger than a typical step)', () => {
    const buf = new Float32Array(4000);
    fillLoopNoise(buf, 'brown', 9, 500);
    let maxStep = 0;
    for (let i = 1; i < buf.length; i++) maxStep = Math.max(maxStep, Math.abs((buf[i] as number) - (buf[i - 1] as number)));
    const wrap = Math.abs((buf[0] as number) - (buf[buf.length - 1] as number));
    expect(wrap).toBeLessThanOrEqual(maxStep * 1.5);
  });
});
