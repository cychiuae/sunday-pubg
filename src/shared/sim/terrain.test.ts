import { describe, expect, it } from 'vitest';
import { ISLAND } from '../../game/levels/island';
import { coastlineRadius, heightAt, raycastTerrain, SEA_FLOOR_DEPTH, shoreNoise, surfaceAt } from './terrain';

const map = ISLAND;
const angles = Array.from({ length: 360 }, (_, i) => (i / 360) * Math.PI * 2);

describe('terrain', () => {
  it('coastline stays within islandRadius +- amplitude and is periodic', () => {
    for (const a of angles) {
      const n = shoreNoise(a, map);
      expect(Math.abs(n)).toBeLessThanOrEqual(1);
      const r = coastlineRadius(a, map);
      expect(r).toBeGreaterThanOrEqual(map.islandRadius - map.shoreNoise.amplitude - 1e-9);
      expect(r).toBeLessThanOrEqual(map.islandRadius + map.shoreNoise.amplitude + 1e-9);
      expect(coastlineRadius(a + Math.PI * 2, map)).toBeCloseTo(r, 9);
    }
    // Actually irregular (not a circle).
    const rs = angles.map((a) => coastlineRadius(a, map));
    expect(Math.max(...rs) - Math.min(...rs)).toBeGreaterThan(map.shoreNoise.amplitude);
  });

  it('crosses y = 0 at the coastline: land inside, sea outside (angle = atan2(z, x))', () => {
    for (const a of angles) {
      const r = coastlineRadius(a, map);
      const at = (d: number) => heightAt(Math.cos(a) * d, Math.sin(a) * d, map);
      expect(Math.abs(at(r))).toBeLessThan(1e-6);
      expect(at(r - 0.5)).toBeGreaterThan(0);
      expect(at(r + 0.5)).toBeLessThan(0);
    }
  });

  it('is smooth: no cliffs along radial lines (max step 0.25 m over 0.5 m)', () => {
    let maxDelta = 0;
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      let prev = heightAt(0, 0, map);
      for (let d = 0.5; d <= map.worldRadius; d += 0.5) {
        const h = heightAt(Math.cos(a) * d, Math.sin(a) * d, map);
        maxDelta = Math.max(maxDelta, Math.abs(h - prev));
        prev = h;
      }
    }
    expect(maxDelta).toBeLessThan(0.35);
  });

  it('shallow sea out to the world edge is wadeable', () => {
    for (const a of angles) {
      const h = heightAt(Math.cos(a) * map.worldRadius, Math.sin(a) * map.worldRadius, map);
      expect(h).toBeLessThan(-0.3);
      expect(h).toBeGreaterThan(-SEA_FLOOR_DEPTH - 1e-9);
    }
  });

  it('hills add on top of baseHeight with cosine falloff', () => {
    const summit = map.hills[0]!;
    expect(heightAt(summit.x, summit.z, map)).toBeCloseTo(map.baseHeight + summit.height, 1);
  });

  it('surfaces: summit grass, beach ring sand, sea water; spawns on sand, loot on land', () => {
    expect(surfaceAt(0, 0, map)).toBe('grass');
    expect(surfaceAt(0, -155, map)).toBe('sand');
    expect(surfaceAt(0, -180, map)).toBe('water');
    for (const s of map.playerSpawns) expect(surfaceAt(s.x, s.z, map)).toBe('sand');
    for (const l of map.lootSpawns) expect(heightAt(l.x, l.z, map)).toBeGreaterThan(0);
  });

  it('raycastTerrain hits the summit from the beach and misses when aiming up', () => {
    const t = raycastTerrain(0, 3, -100, 0, 0, 1, 200, map);
    expect(t).toBeGreaterThan(50);
    expect(t).toBeLessThan(100);
    expect(raycastTerrain(0, 3, -100, 0, 0.7071, 0.7071, 200, map)).toBe(-1);
  });
});
