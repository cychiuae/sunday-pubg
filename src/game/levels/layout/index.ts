/**
 * M2c per-match layouts (ADR 0007 §1; docs/design/levels/variety.md). Owner: level-designer.
 *
 * - `buildMatchLayout(base, seed, { decor })`: the pure generator. Same (base map data, seed, LAYOUT_FORMAT_VERSION)
 *   -> same MatchLayout on the server and every client. `decor: false` (the server) skips the client part (decor and
 *   lit panels) and gives a byte-identical sim part (props, lootSpawns, hash).
 * - `applyLayout(base, layout)`: the per-match map (same AnyMapData type, props and lootSpawns replaced).
 * - `pickVariants(base, seed)`: the rolled zone picks only (cheap), for repeat avoidance with `countRepeatedPicks`
 *   (src/shared/layout.ts). They equal `buildMatchLayout(...).picks` except when a variant fell back to its baseline
 *   (`fallbacks` > 0), which then reports the baseline.
 *
 * Seed 0 (BASELINE_LAYOUT_SEED) is the baseline: today's (M2b) props and loot positions, every zone's baseline pick,
 * the baseline look, plus guaranteed-weapon flags on existing commons.
 *
 * Imports only src/shared/*.ts, the level modules and the variety JSON. The sim never imports this module.
 */
import { LAYOUT_FORMAT_VERSION, layoutHash } from '../../../shared/layout';
import { isIndoor } from '../../../shared/maps';
import { baselineLook, isLookId } from '../../../shared/types';
import type { AnyMapData, IslandMapData, IndoorMapData, LayoutPick, LookId, MatchLayout, PropPlacement, IndoorPropPlacement } from '../../../shared/types';
import { buildIslandLayout, islandPicks, rollIsland } from './island';
import { buildOfficeLayout, officePicks, rollOffice } from './office';

export { DECOR_KINDS, type DecorKind } from './grammar';

export interface BuildLayoutOptions {
  /** Build the client-only part (decor, lit panels). Default true; the server passes false. */
  decor?: boolean;
}

const lookOf = (base: AnyMapData, id: string): LookId => (isLookId(id) ? id : baselineLook(base.kind));

/** The pure per-match generator (ADR 0007 §1.2). */
export function buildMatchLayout(base: AnyMapData, seed: number, opts: BuildLayoutOptions = {}): MatchLayout {
  const s = seed >>> 0;
  const decor = opts.decor !== false;
  if (isIndoor(base)) {
    const parts = buildOfficeLayout(base, s, { decor });
    const layout: MatchLayout = {
      version: LAYOUT_FORMAT_VERSION,
      mapId: base.id,
      seed: s,
      picks: parts.picks,
      look: lookOf(base, parts.look),
      props: parts.props,
      lootSpawns: parts.lootSpawns,
      hash: layoutHash(parts.props, parts.lootSpawns),
      fallbacks: parts.fallbacks,
      decor: parts.decor,
    };
    if (parts.lightsOn) layout.lightsOn = parts.lightsOn;
    return layout;
  }
  const parts = buildIslandLayout(base, s, { decor });
  return {
    version: LAYOUT_FORMAT_VERSION,
    mapId: base.id,
    seed: s,
    picks: parts.picks,
    look: lookOf(base, parts.look),
    props: parts.props,
    lootSpawns: parts.lootSpawns,
    hash: layoutHash(parts.props, parts.lootSpawns),
    fallbacks: parts.fallbacks,
    decor: parts.decor,
  };
}

/** The per-match map: the base map with this layout's props and loot spawns (same kind, same type). */
export function applyLayout<M extends AnyMapData>(base: M, layout: MatchLayout): M {
  if (layout.mapId !== base.id) throw new Error(`applyLayout: layout is for "${layout.mapId}", map is "${base.id}"`);
  if (isIndoor(base)) {
    const map: IndoorMapData = { ...(base as IndoorMapData), props: layout.props as IndoorPropPlacement[], lootSpawns: layout.lootSpawns };
    return map as unknown as M;
  }
  const map: IslandMapData = { ...(base as IslandMapData), props: layout.props as PropPlacement[], lootSpawns: layout.lootSpawns };
  return map as unknown as M;
}

/** The rolled zone picks of a seed, without building anything (repeat avoidance, ADR 0007 §1.6). */
export function pickVariants(base: AnyMapData, seed: number): LayoutPick[] {
  const s = seed >>> 0;
  return isIndoor(base) ? officePicks(rollOffice(s)) : islandPicks(rollIsland(s));
}
