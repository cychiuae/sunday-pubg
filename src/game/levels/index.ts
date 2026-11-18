import type { AnyMapData, MapData } from '../../shared/types';
import { ISLAND } from './island';
import { OFFICE } from './office';

/** Every level by id (ARCHITECTURE §15.5). */
export const MAPS: Readonly<Record<string, AnyMapData>> = { island01: ISLAND, office: OFFICE };

/** Level ids in display order (map vote, room settings). */
export const MAP_IDS = ['island01', 'office'] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP_ID: MapId = 'island01';

/**
 * Look up a map by id. Throws on unknown ids.
 * TRANSITIONAL (ADR 0005 §1): typed `MapData`, which the C-gate flips to `AnyMapData`; no edit is needed here then.
 * Until the gate, callers that may receive 'office' should read `MAPS[id]` (AnyMapData) instead.
 */
export function getMap(id: string): MapData {
  if (!Object.prototype.hasOwnProperty.call(MAPS, id)) {
    throw new Error(`Unknown map id "${id}"`);
  }
  return MAPS[id] as MapData;
}
