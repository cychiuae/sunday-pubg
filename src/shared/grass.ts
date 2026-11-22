/**
 * Island v2 tall grass (docs/design/systems/grass.md). Owner: tech-lead.
 *
 * ONE implementation of "is this player hidden in the grass" for every consumer, so "hidden to me" and "hidden to
 * bots" agree:
 * - sim bots (src/shared/sim/bots.ts: target pick and retaliation),
 * - ClientGame: PlayerView.grassHidden (the renderer fades the model and drops the name tag), HudView.hiddenInGrass.
 * A 'grass' placement is a soft prop (no collider, see sim/colliders.ts PROP_SHAPES): a disc of radius
 * GRASS_PATCH_RADIUS x scale around (x, z). Pure and deterministic (only + - * / and comparisons).
 */
import type { GrassBalance } from './balance';
import type { AnyMapData, Stance } from './types';

/** Radius (m) of a 'grass' placement at scale 1: layout footprint, render model and concealment disc. */
export const GRASS_PATCH_RADIUS = 2.5;
/** Height (m) of the blades at scale 1 (render; above a crouched player's 0.95 m, below a standing head at 1.3 m). */
export const GRASS_HEIGHT = 1.15;

export interface GrassPatch {
  x: number;
  z: number;
  r: number;
}

const cache = new WeakMap<AnyMapData, readonly GrassPatch[]>();

/** The grass discs of a map (island 'grass' props; none indoors). Cached per map object. */
export function grassPatches(map: AnyMapData): readonly GrassPatch[] {
  let list = cache.get(map);
  if (list) return list;
  list = map.kind === 'island' ? map.props.filter((p) => p.kind === 'grass').map((p) => ({ x: p.x, z: p.z, r: GRASS_PATCH_RADIUS * p.scale })) : [];
  cache.set(map, list);
  return list;
}

/** True when (x, z) is at least `inset` m inside any patch. */
export function inGrass(patches: readonly GrassPatch[], x: number, z: number, inset: number): boolean {
  for (const g of patches) {
    const r = g.r - inset;
    if (r <= 0) continue;
    const dx = x - g.x;
    const dz = z - g.z;
    if (dx * dx + dz * dz <= r * r) return true;
  }
  return false;
}

/** The fields of a player the rule reads (SimPlayer and the client's PlayerState both supply them). */
export interface GrassSubject {
  x: number;
  z: number;
  /** Target stance. */
  stance: Stance;
  /** Stance the transition started from (=== stance when settled). */
  stanceFrom: Stance;
  /** Server ms of the last shot (-Infinity before the first). */
  lastShotAt: number;
}

const hidingStance = (s: Stance, cfg: GrassBalance): boolean => (s === 'crouch' ? cfg.hidesCrouched : s === 'prone' ? cfg.hidesProne : false);

/** The subject is in a hiding stance and inside a patch (ignores viewers): HudView.hiddenInGrass. */
export function concealedInGrass(patches: readonly GrassPatch[], s: GrassSubject, now: number, cfg: GrassBalance): boolean {
  if (patches.length === 0) return false;
  if (!hidingStance(s.stance, cfg) || !hidingStance(s.stanceFrom, cfg)) return false;
  if (now - s.lastShotAt < cfg.revealAfterShotMs) return false;
  return inGrass(patches, s.x, s.z, cfg.edgeInset);
}

/** True when `s` is hidden in the grass from a viewer at (vx, vz): concealed and farther than revealRange. */
export function grassHides(patches: readonly GrassPatch[], s: GrassSubject, vx: number, vz: number, now: number, cfg: GrassBalance): boolean {
  const dx = s.x - vx;
  const dz = s.z - vz;
  if (dx * dx + dz * dz <= cfg.revealRange * cfg.revealRange) return false;
  return concealedInGrass(patches, s, now, cfg);
}
