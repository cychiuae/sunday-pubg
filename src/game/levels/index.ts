import type { MapData } from '../../shared/types';
import { ISLAND } from './island';

export const MAPS = { island01: ISLAND } satisfies Record<string, MapData>;

export type MapId = keyof typeof MAPS;
export const DEFAULT_MAP_ID: MapId = 'island01';

/** Look up a map by id. Throws on unknown ids. */
export function getMap(id: string): MapData {
  if (!Object.prototype.hasOwnProperty.call(MAPS, id)) {
    throw new Error(`Unknown map id "${id}"`);
  }
  return MAPS[id as MapId];
}
