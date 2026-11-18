import { describe, expect, it } from 'vitest';
import {
  AIR_MAX_CUTOFF_HZ,
  AIR_MIN_CUTOFF_HZ,
  airCutoffHz,
  dbToGain,
  distanceGain,
  effectivePriority,
  gainToDb,
  listenerForward,
  panningModelFor,
  semitonesToRatio,
  variation,
  volumeToGain,
} from './spatial';

describe('distanceGain', () => {
  it('is 1 inside refDistance', () => {
    expect(distanceGain(0, 5, 100, 1)).toBe(1);
    expect(distanceGain(5, 5, 100, 1)).toBe(1);
  });

  it('follows the inverse law before the edge fade', () => {
    // ref / (ref + rolloff * (d - ref)) = 2 / (2 + 1 * 8) = 0.2
    expect(distanceGain(10, 2, 100, 1)).toBeCloseTo(0.2, 6);
  });

  it('decreases monotonically and reaches exactly 0 at maxDistance', () => {
    let prev = Infinity;
    for (let d = 0; d <= 130; d += 1) {
      const g = distanceGain(d, 6, 130, 0.8);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
    expect(distanceGain(130, 6, 130, 0.8)).toBe(0);
    expect(distanceGain(500, 6, 130, 0.8)).toBe(0);
  });

  it('fades linearly to silence over the last 20% of the range (no pop at the cull radius)', () => {
    const inv = 2 / (2 + 1 * (90 - 2));
    expect(distanceGain(90, 2, 100, 1)).toBeCloseTo(inv * 0.5, 6);
  });

  it('handles NaN distance as silent and infinite range as pure inverse', () => {
    expect(distanceGain(Number.NaN, 2, 100, 1)).toBe(0);
    expect(distanceGain(1000, 10, Infinity, 1)).toBeCloseTo(10 / 1000, 6);
  });
});

describe('air absorption', () => {
  it('is bright up close and clamped far away', () => {
    expect(airCutoffHz(0)).toBe(AIR_MAX_CUTOFF_HZ);
    expect(airCutoffHz(50)).toBeLessThan(airCutoffHz(20));
    expect(airCutoffHz(10_000)).toBe(AIR_MIN_CUTOFF_HZ);
    expect(airCutoffHz(-5)).toBe(AIR_MAX_CUTOFF_HZ);
  });

  it('uses HRTF only for nearby sounds', () => {
    expect(panningModelFor(5)).toBe('HRTF');
    expect(panningModelFor(100)).toBe('equalpower');
  });
});

describe('effectivePriority', () => {
  it('ranks closer sounds above farther ones of the same base priority', () => {
    expect(effectivePriority(70, 5, 130)).toBeGreaterThan(effectivePriority(70, 100, 130));
  });
  it('never lets distance bridge a 10-point base gap', () => {
    expect(effectivePriority(70, 129, 130)).toBeGreaterThan(effectivePriority(60, 0, 130));
    expect(effectivePriority(70, 0, 130)).toBeLessThan(effectivePriority(80, 1e9, 130));
  });
  it('gives 2D sounds the full closeness bonus', () => {
    expect(effectivePriority(50, null, 30)).toBe(55);
  });
});

describe('level helpers', () => {
  it('converts dB and semitones', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-20)).toBeCloseTo(0.1, 6);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(semitonesToRatio(12)).toBeCloseTo(2, 6);
  });

  it('maps the volume slider with a squared taper and clamps bad input', () => {
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(0.5)).toBeCloseTo(0.25, 6);
    expect(volumeToGain(-1)).toBe(0);
    expect(volumeToGain(3)).toBe(1);
    expect(volumeToGain(Number.NaN)).toBe(0);
  });

  it('keeps per-play variation inside the jitter range', () => {
    const out: [number, number] = [0, 0];
    for (const r of [0, 0.25, 0.5, 0.999]) {
      variation(2, 3, () => r, out);
      expect(out[0]).toBeGreaterThanOrEqual(semitonesToRatio(-2) - 1e-9);
      expect(out[0]).toBeLessThanOrEqual(semitonesToRatio(2) + 1e-9);
      expect(out[1]).toBeGreaterThanOrEqual(dbToGain(-3) - 1e-9);
      expect(out[1]).toBeLessThanOrEqual(dbToGain(3) + 1e-9);
    }
    expect(variation(0, 0, () => 0.9, out)).toEqual([1, 1]);
  });

  it('computes listener forward with yaw 0 looking toward -Z', () => {
    const f = listenerForward(0, { x: 9, y: 9, z: 9 });
    expect(f.x).toBeCloseTo(0, 9);
    expect(f.y).toBe(0);
    expect(f.z).toBeCloseTo(-1, 9);
    const r = listenerForward(Math.PI / 2, { x: 0, y: 0, z: 0 });
    expect(r.x).toBeCloseTo(-1, 9);
  });
});
