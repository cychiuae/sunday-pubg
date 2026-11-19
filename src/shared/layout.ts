/**
 * M2c per-match layout contract helpers (ADR 0007 §1). Owner: tech-lead.
 *
 * The generator itself (`buildMatchLayout`, `applyLayout`) lives in src/game/levels/layout/ (level-designer). This file
 * holds what the server, ClientGame, tools and tests must agree on: the format version, the seed derivation, the
 * canonical hash, the LAYOUT_SEED parser and the repeat count. Pure; no Math.random, no time.
 */
import { fnv1a32, mixSeed, roundMm, roundMrad } from './detmath';
import type { IndoorPropPlacement, LayoutPick, LootSpawn, PropPlacement } from './types';

/**
 * Bump when a generator or variety-data change alters ANY output for an existing seed (the LV1 golden hashes catch an
 * unintended change). Server and client must build with the same version (WelcomeInfo.layout.version).
 * History: 1 = M2c launch; 2 = BUG-015 (second `ep.perchSW` candidate; office seed 0x00000001 moved, baseline unchanged).
 */
export const LAYOUT_FORMAT_VERSION = 2;
/** "LAYO". layoutSeed = mixSeed(worldSeed, LAYOUT_SALT + attempt) (variety.md §2.1). */
export const LAYOUT_SALT = 0x4c41594f;
/** Seed 0 = the baseline layout (every zone's baseline variant, baseline look). */
export const BASELINE_LAYOUT_SEED = 0;
/** Repeat avoidance (variety.md §9 decision 1): re-roll attempts 1..LAYOUT_MAX_REROLLS after attempt 0. */
export const LAYOUT_MAX_REROLLS = 8;

/**
 * The layout seed of attempt `attempt` (0 = first try) for a World seed. Never returns BASELINE_LAYOUT_SEED (a mixed 0
 * becomes 1), so only a LAYOUT_SEED pin can select the baseline.
 */
export function layoutSeedFor(worldSeed: number, attempt = 0): number {
  const s = mixSeed(worldSeed >>> 0, (LAYOUT_SALT + attempt) >>> 0);
  return s === BASELINE_LAYOUT_SEED ? 1 : s;
}

/**
 * Parses LAYOUT_SEED (server env) and `?layoutSeed=` (offline previews): a decimal uint32, `0x` hex, or `baseline`.
 * Returns null for empty or invalid input (the server warns once and ignores it).
 */
export function parseLayoutSeed(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim().toLowerCase();
  if (s === '') return null;
  if (s === 'baseline') return BASELINE_LAYOUT_SEED;
  const n = /^0x[0-9a-f]{1,8}$/.test(s) ? parseInt(s.slice(2), 16) : /^\d{1,10}$/.test(s) ? Number(s) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

/** Display form used by logs, the dev overlay and `layout.seed` ("Layout #{seed}"): 8 upper-case hex digits. */
export const formatLayoutSeed = (seed: number): string => `0x${(seed >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

const mm = (v: number): number => Math.round(roundMm(v) * 1000);
const mrad = (v: number): number => Math.round(roundMrad(v) * 1000);

/**
 * Canonical hash of a layout's sim part (variety.md §2.4): FNV-1a 32 over, per prop in order,
 * `kind,x_mm,y_mm,z_mm,rot_mrad,scale_cm;` (island y = 0) and then, per loot spawn in order,
 * `x_mm,y_mm|-,z_mm,tier,guarantee|-;`. Integers only, so every engine produces the same string. `variant`, decor and
 * the look are client-only and not hashed.
 */
export function layoutHash(props: readonly (PropPlacement | IndoorPropPlacement)[], loot: readonly LootSpawn[]): number {
  let h = 0x811c9dc5;
  for (const p of props) {
    const y = 'y' in p ? p.y : 0;
    h = fnv1a32(`${p.kind},${mm(p.x)},${mm(y)},${mm(p.z)},${mrad(p.rotY)},${Math.round(p.scale * 100)};`, h);
  }
  h = fnv1a32('|', h);
  for (const l of loot) {
    h = fnv1a32(`${mm(l.x)},${l.y === undefined ? '-' : mm(l.y)},${mm(l.z)},${l.tier},${l.guarantee ?? '-'};`, h);
  }
  return h >>> 0;
}

/** Repeat avoidance: how many zones picked the same variant in both pick lists (same zone id). */
export function countRepeatedPicks(prev: readonly LayoutPick[], next: readonly LayoutPick[]): number {
  const before = new Map<string, string>();
  for (const p of prev) before.set(p.zone, p.variant);
  let n = 0;
  for (const p of next) if (before.get(p.zone) === p.variant) n++;
  return n;
}
