import { describe, expect, it } from 'vitest';
import type { GrenadeView } from '../shared/contracts';
import { AUDIO_TUNING } from './cues';
import { FuseTicker, fuseTickIntervalS } from './fuseTicks';

const ORIGIN = { x: 0, y: 0, z: 0 };
const nade = (id: number, x: number, explodesAt: number): GrenadeView => ({
  id, ownerId: 2, pos: { x, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, explodesAt, resting: true, kind: 'grenade',
});

/** Runs the ticker at 60 fps from `t0` to `t1` (server ms); returns the tick times and urgencies. */
function run(ticker: FuseTicker, list: GrenadeView[], t0: number, t1: number, fuseMs: number | null): { t: number; u: number }[] {
  const out: { t: number; u: number }[] = [];
  for (let t = t0; t <= t1; t += 1000 / 60) ticker.update(list, t, ORIGIN, fuseMs, (_p, u) => out.push({ t, u }));
  return out;
}

describe('fuse ticks (IAudio.setGrenades)', () => {
  it('interval shrinks from slow (full fuse) to fast (last moment)', () => {
    expect(fuseTickIntervalS(1)).toBeCloseTo(AUDIO_TUNING.fuseTickSlowS, 9);
    expect(fuseTickIntervalS(0)).toBeCloseTo(AUDIO_TUNING.fuseTickFastS, 9);
    expect(fuseTickIntervalS(0.5)).toBeLessThan(fuseTickIntervalS(0.9));
    expect(fuseTickIntervalS(Number.NaN)).toBeCloseTo(AUDIO_TUNING.fuseTickFastS, 9);
  });

  it('ticks a nearby grenade faster and more urgently as its fuse runs out', () => {
    const ticks = run(new FuseTicker(), [nade(1, 3, 3500)], 0, 3490, 3500);
    expect(ticks.length).toBeGreaterThan(8);
    const gaps = ticks.slice(1).map((k, i) => k.t - (ticks[i] as { t: number }).t);
    expect(gaps.at(-1) as number).toBeLessThan(gaps[0] as number);
    expect((ticks.at(-1) as { u: number }).u).toBeGreaterThan((ticks[0] as { u: number }).u);
  });

  it('skips grenades out of range and exploded ones', () => {
    expect(run(new FuseTicker(), [nade(1, AUDIO_TUNING.fuseTickRangeM + 1, 3500)], 0, 3000, 3500)).toEqual([]);
    expect(run(new FuseTicker(), [nade(1, 1, 100)], 200, 1000, 3500)).toEqual([]);
  });

  it('without a balance fuse, urgency is relative to the fuse left when first seen', () => {
    const ticks = run(new FuseTicker(), [nade(1, 1, 2000)], 0, 1990, null);
    expect((ticks[0] as { u: number }).u).toBeCloseTo(0, 6);
    expect((ticks.at(-1) as { u: number }).u).toBeGreaterThan(0.7);
  });

  it('forgets grenades that left the frame', () => {
    const ticker = new FuseTicker();
    ticker.update([nade(1, 1, 3000), nade(2, 2, 3000)], 0, ORIGIN, 3500, () => undefined);
    expect(ticker.size).toBe(2);
    ticker.update([nade(2, 2, 3000)], 16, ORIGIN, 3500, () => undefined);
    expect(ticker.size).toBe(1);
    ticker.reset();
    expect(ticker.size).toBe(0);
  });
});
