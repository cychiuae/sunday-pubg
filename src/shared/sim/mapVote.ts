/**
 * Map choice at a room's lock (maps.md §1 "Resolution at the lock", ADR 0006 §4). Pure: the caller passes the room's
 * seeded Rng, so the same seed and votes always give the same map.
 *
 * Priority: server pin > fixed map from the room settings > vote (plurality, ties uniformly at random among the tied
 * options; a `random` win picks uniformly over all maps) > rotation (no votes: the map after `previous` in `maps`
 * order; the first match of a room is maps[0], island01).
 */
import type { Rng } from '../math';
import type { MapId, MapPickVia, MapVoteOption, RoomMapMode } from '../types';

export interface MapChoiceInput {
  /** Server `MAP` pin (already validated or not: an id outside `maps` is ignored). */
  pin: MapId | null;
  /** Room setting: a fixed map id or 'vote'. */
  mode: RoomMapMode;
  /** One entry per connected human with a vote (null / unknown options are ignored). */
  votes: readonly (MapVoteOption | null)[];
  /** Every map id, in display / rotation order (`['island01', 'office']`). */
  maps: readonly MapId[];
  /** Map of the room's previous match (null for the first match). */
  previous: MapId | null;
  rng: Rng;
}

export interface MapChoice {
  mapId: MapId;
  via: MapPickVia;
}

export function resolveMapChoice(i: MapChoiceInput): MapChoice {
  const { maps, rng } = i;
  if (maps.length === 0) throw new Error('resolveMapChoice: no maps');
  const known = (id: string | null): id is MapId => id !== null && maps.includes(id);
  if (known(i.pin)) return { mapId: i.pin, via: 'pinned' };
  if (i.mode !== 'vote' && known(i.mode)) return { mapId: i.mode, via: 'fixed' };

  // Tally in a fixed option order (maps, then 'random') so tie-breaking is deterministic for a given rng.
  const options: MapVoteOption[] = [...maps, 'random'];
  const tally = options.map(() => 0);
  let total = 0;
  for (const v of i.votes) {
    if (v === null) continue;
    const k = options.indexOf(v);
    if (k < 0) continue;
    tally[k]!++;
    total++;
  }
  if (total > 0) {
    const best = Math.max(...tally);
    const tied = options.filter((_, k) => tally[k] === best);
    const win = tied.length === 1 ? tied[0]! : tied[rng.int(tied.length)]!;
    if (win === 'random') return { mapId: maps[rng.int(maps.length)]!, via: 'random' };
    return { mapId: win, via: 'vote' };
  }
  const prev = i.previous === null ? -1 : maps.indexOf(i.previous);
  return { mapId: maps[(prev + 1) % maps.length]!, via: 'rotation' };
}
