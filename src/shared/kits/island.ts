/**
 * Island prop kit additions for M2c: render variants per prop kind. Pure data (no three.js). Owner: graphics-designer.
 * Spec: docs/art/M2c.md §9.1.
 *
 * `PropPlacement.variant` (render-only, seed-derived; ADR 0007 §1.1) picks one of ISLAND_VARIANTS[kind] looks with the
 * SAME collider and footprint (colourways, crate dressings, rock facet sets, hut roofs). The layout generator draws it
 * as `variant = floor(rng * ISLAND_VARIANTS[kind])`; the renderer takes it modulo this count (out-of-range is safe).
 * Variant 0 is always the M2b look.
 */
import type { PropKind } from '../types';

export const ISLAND_VARIANTS: Readonly<Record<PropKind, number>> = {
  palm: 2, // v1 lighter fronds, 2 coconuts
  rock: 3, // three facet sets, same size
  bush: 1,
  crate: 3, // v1 rope net, v2 teal tarp
  hut: 3, // v1 palm-leaf (green) roof, v2 coral-and-cream striped door awning
  dock: 1,
  umbrella: 4, // v0 coral/cream, v1 towel blue/white, v2 mango/teal, v3 lilac/white
  boat: 1,
  tikiTorch: 1,
  driftwood: 1,
  grass: 2, // v1 sun-dried tips (straw-gold) for the beach edge look
};

/** Clamp any variant index into range for a kind (0 for absent / invalid). */
export function islandVariant(kind: PropKind, variant: number | undefined): number {
  const n = ISLAND_VARIANTS[kind] ?? 1;
  if (variant === undefined || !Number.isFinite(variant)) return 0;
  return ((Math.floor(variant) % n) + n) % n;
}
