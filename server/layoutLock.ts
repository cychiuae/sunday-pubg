/**
 * M2c layout lock (ADR 0007 §1.3-§1.7, ARCHITECTURE §16.3, variety.md §2.3). Owner: network-engineer.
 *
 * At a room's map lock: choose the layout seed (the LAYOUT_SEED pin, else layoutSeedFor(worldSeed, attempt) with repeat
 * avoidance against the room's previous match on the same map), build and apply the layout (the level-designer's
 * generator, injected), and prepare the applied map (colliders, and nav on indoor maps) through a small LRU keyed by
 * `${mapId}:${seed}:${LAYOUT_FORMAT_VERSION}`. Synchronous: it runs inside the lock, in the 3 s before the carrier, and
 * blocks every room's event loop for its duration (accepted for M2c; see the timing log).
 */
import type { Balance } from '../src/shared/balance';
import {
  BASELINE_LAYOUT_SEED,
  LAYOUT_FORMAT_VERSION,
  LAYOUT_MAX_REROLLS,
  countRepeatedPicks,
  formatLayoutSeed,
  layoutHash,
  layoutSeedFor,
} from '../src/shared/layout';
import type { MapRuntime } from '../src/shared/sim/movement';
import { baselineLook, type LayoutPick, type LookId, type MapId, type MatchLayout, type MatchLayoutRef } from '../src/shared/types';
import type { SimMap } from './common';

/** The generator seam (src/game/levels/layout/, level-designer). app.ts passes the real one; room tests may omit it. */
export interface LayoutGenerator {
  /** `buildMatchLayout(base, seed, { decor: false })`. */
  build(base: SimMap, seed: number): MatchLayout;
  /** `applyLayout(base, layout)`. */
  apply(base: SimMap, layout: MatchLayout): SimMap;
  /** `pickVariants(base, seed)`: cheap, for repeat avoidance. */
  picks(base: SimMap, seed: number): LayoutPick[];
}

/** Server log of the variety.md §2.3 line and the timing warning. */
export const LAYOUT_WARN_MS = 250;
/** ADR 0007 §1.7: the server keeps the last 4 prepared layouts. */
export const LAYOUT_CACHE_SIZE = 4;

export interface SeedChoice {
  seed: number;
  /** 0 = first try. A pin is attempt 0. */
  attempt: number;
  /** Zones that repeat the previous match's pick (0 without a previous match on this map). */
  repeats: number;
  /** Zone count of the chosen seed's picks. */
  zones: number;
  pinned: boolean;
  /** pickVariants of the chosen seed (stored by the room for the next match's comparison). */
  picks: LayoutPick[];
}

/**
 * Repeat avoidance (ADR 0007 §1.6, director decision). A pin is never re-rolled. Without a previous match on this map,
 * attempt 0. Otherwise the first of attempts 0..8 with at most half of its zones repeating the previous picks; if none
 * qualifies, the fewest repeats (ties: the lowest attempt).
 */
export function chooseLayoutSeed(opts: {
  worldSeed: number;
  pin: number | null;
  previous: readonly LayoutPick[] | null;
  picksOf: (seed: number) => LayoutPick[];
}): SeedChoice {
  const { worldSeed, pin, previous, picksOf } = opts;
  if (pin !== null) {
    const picks = picksOf(pin);
    return { seed: pin, attempt: 0, repeats: previous ? countRepeatedPicks(previous, picks) : 0, zones: picks.length, pinned: true, picks };
  }
  let best: SeedChoice | null = null;
  for (let attempt = 0; attempt <= LAYOUT_MAX_REROLLS; attempt++) {
    const seed = layoutSeedFor(worldSeed, attempt);
    const picks = picksOf(seed);
    const repeats = previous ? countRepeatedPicks(previous, picks) : 0;
    const choice: SeedChoice = { seed, attempt, repeats, zones: picks.length, pinned: false, picks };
    if (repeats * 2 <= picks.length) return choice;
    if (best === null || repeats < best.repeats) best = choice;
  }
  return best as SeedChoice;
}

/** variety.md §2.3 pick list: `TL=pods(3) TR=rows BL=gaps(N2,N3)`. */
export function formatPicks(picks: readonly LayoutPick[]): string {
  return picks
    .map((p) => {
      const params = p.params ? Object.values(p.params).map(String).join(',') : '';
      return `${p.zone}=${p.variant}${params ? `(${params})` : ''}`;
    })
    .join(' ');
}

/** A prepared per-match map. */
export interface PreparedLayout {
  /** The applied map the World runs (the base map when there is no generator). */
  map: SimMap;
  ref: MatchLayoutRef;
  picks: LayoutPick[];
  fallbacks: number;
  balance: Balance;
  runtime?: MapRuntime;
  /** Build times of the entry (ms); `cached` = this lock reused it (no build now). */
  layoutMs: number;
  navMs: number;
}

export interface LockedLayout extends PreparedLayout {
  choice: SeedChoice;
  cached: boolean;
  /** A generated layout (false: no generator configured; the World runs the base map). */
  generated: boolean;
}

export interface LayoutServiceOptions {
  generator: LayoutGenerator | null;
  getMap(id: MapId): SimMap;
  balanceFor(mapId: MapId): Balance;
  prepareMap?(map: SimMap, balance: Balance): MapRuntime;
  pin: number | null;
  /** Monotonic ms (performance.now in production; the fake clock in tests). */
  now(): number;
}

/** The ref of a map run without a generated layout: seed 0, the base map's own hash, the baseline look. */
export function baseMapLayoutRef(map: SimMap): MatchLayoutRef {
  const m = map as Partial<Pick<SimMap, 'kind' | 'props' | 'lootSpawns'>>;
  return {
    seed: BASELINE_LAYOUT_SEED,
    version: LAYOUT_FORMAT_VERSION,
    hash: layoutHash(m.props ?? [], m.lootSpawns ?? []),
    look: baselineLook(m.kind === 'indoor' ? 'indoor' : 'island'),
  };
}

const keyOf = (mapId: MapId, seed: number): string => `${mapId}:${seed}:${LAYOUT_FORMAT_VERSION}`;

/** Seed choice, build and per-layout prepareMap with an LRU. One per process (shared by every room). */
export class LayoutService {
  private readonly cache = new Map<string, PreparedLayout>();
  /** Build stats over the process (healthz / load runs). */
  readonly stats = { builds: 0, hits: 0, maxLayoutMs: 0, maxNavMs: 0, sumLayoutMs: 0, sumNavMs: 0 };

  constructor(private readonly opts: LayoutServiceOptions) {}

  get pin(): number | null {
    return this.opts.pin;
  }

  /** Chooses the seed and returns the prepared layout (building it unless cached). Throws if the generator throws. */
  lock(mapId: MapId, worldSeed: number, previous: readonly LayoutPick[] | null): LockedLayout {
    const base = this.opts.getMap(mapId);
    const gen = this.opts.generator;
    // No generator (room tests with stub maps): the base map, described truthfully (seed 0, its own hash).
    const choice: SeedChoice = gen
      ? chooseLayoutSeed({ worldSeed, pin: this.opts.pin, previous, picksOf: (s) => gen.picks(base, s) })
      : { seed: BASELINE_LAYOUT_SEED, attempt: 0, repeats: 0, zones: 0, pinned: false, picks: [] };
    const key = keyOf(mapId, choice.seed);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU: move to the newest end
      this.cache.set(key, hit);
      this.stats.hits++;
      return { ...hit, choice, cached: true, generated: gen !== null };
    }
    const entry = this.prepare(mapId, () => {
      if (!gen) return { map: base, ref: baseMapLayoutRef(base), picks: [], fallbacks: 0 };
      const layout = gen.build(base, choice.seed);
      const ref: MatchLayoutRef = { seed: layout.seed, version: layout.version, hash: layout.hash, look: layout.look as LookId };
      return { map: gen.apply(base, layout), ref, picks: layout.picks, fallbacks: layout.fallbacks };
    });
    this.cache.set(key, entry);
    while (this.cache.size > LAYOUT_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
    return { ...entry, choice, cached: false, generated: gen !== null };
  }

  private prepare(
    mapId: MapId,
    build: () => { map: SimMap; ref: MatchLayoutRef; picks: LayoutPick[]; fallbacks: number },
  ): PreparedLayout {
    const t0 = this.opts.now();
    const built = build();
    const t1 = this.opts.now();
    const balance = this.opts.balanceFor(mapId);
    const runtime = this.opts.prepareMap?.(built.map, balance);
    const t2 = this.opts.now();
    const layoutMs = t1 - t0;
    const navMs = t2 - t1;
    const s = this.stats;
    s.builds++;
    s.sumLayoutMs += layoutMs;
    s.sumNavMs += navMs;
    s.maxLayoutMs = Math.max(s.maxLayoutMs, layoutMs);
    s.maxNavMs = Math.max(s.maxNavMs, navMs);
    return { ...built, balance, ...(runtime ? { runtime } : {}), layoutMs, navMs };
  }

  /** Cached keys, oldest first (tests). */
  cachedKeys(): string[] {
    return [...this.cache.keys()];
  }
}

/** The variety.md §2.3 per-match log line, plus the build timing and the repeat-avoidance outcome. */
export function layoutLogLine(matchId: number, mapId: MapId, l: LockedLayout): string {
  const c = l.choice;
  const timing = l.cached ? 'cached' : `layoutMs ${l.layoutMs.toFixed(1)} navMs ${l.navMs.toFixed(1)}`;
  const how = c.pinned ? 'pinned' : `attempt ${c.attempt}`;
  return (
    `match ${matchId} map ${mapId} layout ${formatLayoutSeed(l.ref.seed)} v${l.ref.version} look ${l.ref.look} ` +
    `picks ${formatPicks(l.picks) || '-'} | ${timing}, ${how}, repeats ${c.repeats}/${c.zones}, fallbacks ${l.fallbacks}, ` +
    `hash ${formatLayoutSeed(l.ref.hash)}`
  );
}
