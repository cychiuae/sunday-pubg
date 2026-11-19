/**
 * M2c per-match layout on the client (ADR 0007 §1.5, ARCHITECTURE §16.3). Owner: game-developer.
 *
 * On every welcome the client rebuilds this match's map from the base map and `WelcomeInfo.layout.seed` through
 * `ClientGameDeps.buildLayout` (main.ts: buildMatchLayout with decor + applyLayout), then checks the generator version
 * and the sim-part hash against the server's. A mismatch means client and server would play on different maps:
 * it throws in dev builds and tests (LayoutMismatchError) and only logs in production (director decision).
 * Without `buildLayout` (tests, tools) or without a layout ref, the base map is used and the look comes from the ref
 * (else the baseline look).
 *
 * `MapRuntimeCache` keeps the prepared runtime (colliders) of the current and the previous layout only.
 */
import { LAYOUT_FORMAT_VERSION, formatLayoutSeed } from '../shared/layout';
import type { AnyMapData, LookId, MapData, MatchLayout, MatchLayoutRef } from '../shared/types';
import { baselineLook } from '../shared/types';

export type BuildLayoutFn = (base: MapData, seed: number) => { layout: MatchLayout; map: MapData };
/** What to do on a version or hash mismatch. */
export type LayoutMismatchMode = 'throw' | 'log';

export class LayoutMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutMismatchError';
  }
}

export interface MatchMap {
  mapId: string;
  /** The layout-applied map (the base map when no layout was built). */
  map: AnyMapData;
  /** The full layout (decor, picks, lightsOn), or null (no ref or no builder). */
  layout: MatchLayout | null;
  /** The server's layout ref (HUD seed and look), or null. */
  ref: MatchLayoutRef | null;
  look: LookId;
  /** Cache and change key: `mapId:seed:version`, or `mapId:base` without a ref. */
  key: string;
}

/** Key of a (map, layout) pair: a new key = a new match map (rebuild, mapChanged). */
export function matchMapKey(mapId: string, ref: MatchLayoutRef | null | undefined): string {
  return ref ? `${mapId}:${ref.seed >>> 0}:${ref.version}` : `${mapId}:base`;
}

/** Default mismatch mode: throw in Vite dev builds and Vitest, log in production. */
export function defaultMismatchMode(): LayoutMismatchMode {
  const env = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
  return env?.DEV === true || env?.MODE === 'test' ? 'throw' : 'log';
}

/**
 * Builds the match map for `base` and the server's `ref`. Version or hash mismatch: throws LayoutMismatchError in
 * 'throw' mode; in 'log' mode logs seed, version and both hashes and continues with the client's build.
 */
export function buildMatchMap(
  base: AnyMapData,
  ref: MatchLayoutRef | null | undefined,
  build: BuildLayoutFn | undefined,
  mode: LayoutMismatchMode,
): MatchMap {
  const key = matchMapKey(base.id, ref);
  if (!ref) return { mapId: base.id, map: base, layout: null, ref: null, look: baselineLook(base.kind), key };
  if (!build) return { mapId: base.id, map: base, layout: null, ref, look: ref.look, key };
  const built = build(base as MapData, ref.seed >>> 0);
  const layout = built.layout;
  const versionOk = layout.version === ref.version && ref.version === LAYOUT_FORMAT_VERSION;
  const hashOk = layout.hash >>> 0 === ref.hash >>> 0;
  if (!versionOk || !hashOk) {
    const msg =
      `[ClientGame] layout mismatch on ${base.id} seed ${formatLayoutSeed(ref.seed)}: ` +
      `server version ${ref.version} hash ${formatLayoutSeed(ref.hash)}, ` +
      `client version ${layout.version} (format ${LAYOUT_FORMAT_VERSION}) hash ${formatLayoutSeed(layout.hash)}`;
    if (mode === 'throw') throw new LayoutMismatchError(msg);
    console.error(msg);
  }
  return { mapId: base.id, map: built.map as AnyMapData, layout, ref, look: layout.look, key };
}

/** Prepared runtimes of the current and the previous match map (ADR 0007 §1.7: the client caches two). */
export class MapRuntimeCache<R> {
  private readonly entries: { key: string; value: R }[] = [];

  constructor(private readonly capacity = 2) {}

  get size(): number {
    return this.entries.length;
  }

  get(key: string, make: () => R): R {
    const i = this.entries.findIndex((e) => e.key === key);
    if (i >= 0) {
      const [hit] = this.entries.splice(i, 1);
      this.entries.push(hit!);
      return hit!.value;
    }
    const value = make();
    this.entries.push({ key, value });
    while (this.entries.length > this.capacity) this.entries.shift();
    return value;
  }

  has(key: string): boolean {
    return this.entries.some((e) => e.key === key);
  }
}
