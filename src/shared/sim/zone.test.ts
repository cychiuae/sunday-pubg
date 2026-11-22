import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { createRng } from '../math';
import { ISLAND } from '../../game/levels/island';
import { heightAt } from './terrain';
import { createZone, isOutsideZone, updateZone } from './zone';

const b = BALANCE;
/** Total tide timeline (all phases + final collapse), ms. Tests that need every target run past this. */
const TIMELINE_MS =
  (b.zone.phases.reduce((a, p) => a + p.waitSeconds + p.shrinkSeconds, 0) + b.zone.finalCollapseDelaySeconds + b.zone.finalCollapseSeconds) *
  1000;

function runZone(seed: number, untilMs: number, stepMs = 1000 / 30) {
  const rng = createRng(seed);
  const z = createZone(b, ISLAND, rng, 0);
  const targets: { x: number; z: number; r: number }[] = [{ x: z.state.targetCenter.x, z: z.state.targetCenter.z, r: z.state.targetRadius }];
  let lastPhase = 0;
  for (let t = 0; t <= untilMs; t += stepMs) {
    updateZone(z, b, ISLAND, rng, t);
    if (z.state.phaseIndex !== lastPhase) {
      lastPhase = z.state.phaseIndex;
      targets.push({ x: z.state.targetCenter.x, z: z.state.targetCenter.z, r: z.state.targetRadius });
    }
  }
  return { z, targets };
}

describe('zone (the tide)', () => {
  it('phase 1 shrink begins at 60 s; radius at 82.5 s = 153 (zone.md AT1, balance v9, island v2 startRadius 180)', () => {
    const rng = createRng(1);
    const z = createZone(b, ISLAND, rng, 0);
    const p1 = b.zone.phases[0]!;
    const startMs = p1.waitSeconds * 1000;
    expect(startMs).toBe(60_000);
    updateZone(z, b, ISLAND, rng, startMs - 1);
    expect(z.state.shrinking).toBe(false);
    expect(z.state.radius).toBe(b.zone.startRadius);
    updateZone(z, b, ISLAND, rng, startMs);
    expect(z.state.shrinking).toBe(true);
    // Halfway through the shrink: midpoint of 180 and 0.70 x 180 = 126.
    updateZone(z, b, ISLAND, rng, startMs + (p1.shrinkSeconds * 1000) / 2);
    expect(z.state.radius).toBeCloseTo((b.zone.startRadius * (1 + p1.radiusFraction)) / 2, 9);
    expect(z.state.radius).toBeCloseTo(153, 9);
  });

  it('timeline: each phase ends after its wait + shrink; the collapse waits, shrinks, then closes (AT6, from balance)', () => {
    const rng = createRng(2);
    const z = createZone(b, ISLAND, rng, 0);
    const endS = phaseEndsS(b);
    const lastS = endS[endS.length - 1]!;
    const collapseStart = (lastS + b.zone.finalCollapseDelaySeconds) * 1000;
    const closeAt = collapseStart + b.zone.finalCollapseSeconds * 1000;
    for (let i = 0; i < endS.length; i++) {
      updateZone(z, b, ISLAND, rng, endS[i]! * 1000 - 1);
      expect(z.state.phaseIndex).toBe(i);
      expect(z.state.shrinking).toBe(true);
      updateZone(z, b, ISLAND, rng, endS[i]! * 1000);
      expect(z.state.phaseIndex).toBe(i + 1);
      expect(z.state.radius).toBeCloseTo(b.zone.phases[i]!.radiusFraction * b.zone.startRadius, 9);
    }
    expect(z.state.dps).toBe(b.zone.finalCollapseDps);
    updateZone(z, b, ISLAND, rng, collapseStart - 1);
    expect(z.state.shrinking).toBe(false);
    updateZone(z, b, ISLAND, rng, collapseStart);
    expect(z.state.shrinking).toBe(true);
    updateZone(z, b, ISLAND, rng, closeAt - 1);
    expect(z.closed).toBe(false);
    expect(z.state.radius).toBeGreaterThan(0);
    updateZone(z, b, ISLAND, rng, closeAt);
    expect(z.state.radius).toBe(0);
    expect(z.closed).toBe(true);
    expect(TIMELINE_MS).toBe(closeAt);
  });

  it('every target lies inside the previous one and on land, over 1000 seeds (AT2)', () => {
    for (let seed = 1; seed <= 1000; seed++) {
      const { targets } = runZone(seed, TIMELINE_MS, 5000);
      expect(targets.length).toBeGreaterThanOrEqual(b.zone.phases.length);
      let prev = { x: 0, z: 0, r: b.zone.startRadius };
      for (const t of targets) {
        expect(Math.hypot(t.x - prev.x, t.z - prev.z) + t.r).toBeLessThanOrEqual(prev.r + 1e-9);
        if (t.r > 0) expect(heightAt(t.x, t.z, ISLAND)).toBeGreaterThanOrEqual(b.zone.landCheckMinHeight - 1e-9);
        prev = t;
      }
    }
  });

  it('final circle trends to a map.zoneCenters candidate', () => {
    let hits = 0;
    for (let seed = 1; seed <= 200; seed++) {
      // The phase-6 target is picked when phase 6 starts (440 s), so run the whole timeline.
      const { targets } = runZone(seed, TIMELINE_MS, 5000);
      const last = targets[b.zone.phases.length - 1]!;
      if (ISLAND.zoneCenters.some((c) => Math.hypot(c.x - last.x, c.z - last.z) < 1e-6)) hits++;
    }
    expect(hits).toBe(200);
  });

  it('same seed => identical zone sequence (AT5)', () => {
    const a = runZone(77, TIMELINE_MS).targets;
    const c = runZone(77, TIMELINE_MS).targets;
    expect(c).toEqual(a);
  });

  it('on the edge counts as inside', () => {
    const z = createZone(b, ISLAND, createRng(1), 0);
    expect(isOutsideZone(z.state, 180, 0)).toBe(false);
    expect(isOutsideZone(z.state, 180.01, 0)).toBe(true);
  });
});

/** Phase end times in s from balance: cumulative waitSeconds + shrinkSeconds per phase. */
function phaseEndsS(bal: typeof b): number[] {
  let t = 0;
  return bal.zone.phases.map((p) => (t += p.waitSeconds + p.shrinkSeconds));
}
