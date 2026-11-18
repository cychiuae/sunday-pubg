/**
 * Render-side height. Owner: graphics-engineer.
 * Identical to the sim's heightAt inside worldRadius + REEF_START_OFFSET (where anyone can stand), then a smooth
 * render-only reef drop-off so the open sea beyond the playable boundary reads as deep water. The sim's sea floor
 * flattens at -SEA_FLOOR_DEPTH everywhere, which would make the whole ocean shallow-turquoise to the horizon.
 */
import { heightAt as simHeightAt } from '../shared/sim/terrain';
import type { IslandMapData } from '../shared/types';

export const REEF_START_OFFSET = 6;
export const REEF_WIDTH = 20;
export const REEF_DEPTH = 7;

export function visualHeight(
  x: number,
  z: number,
  map: IslandMapData,
  base: (x: number, z: number, map: IslandMapData) => number = simHeightAt,
): number {
  const h = base(x, z, map);
  const start = map.worldRadius + REEF_START_OFFSET;
  const r = Math.sqrt(x * x + z * z);
  if (r <= start) return h;
  const t = Math.min(1, (r - start) / REEF_WIDTH);
  return h - t * t * (3 - 2 * t) * REEF_DEPTH;
}
