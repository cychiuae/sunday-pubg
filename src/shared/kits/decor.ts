/**
 * M2c decor kinds (client-only, no collider): pure data. Owner: graphics-designer. Spec: docs/art/M2c.md §9,
 * docs/design/levels/variety.md §4.4 / §5.4. NO three.js, NO DOM: shared by the level generator, the renderer and
 * tests.
 *
 * The keys are EXACTLY the level data's `DecorPlacement.kind` names (variety/*.json, `DECOR_KINDS` in the layout
 * grammar). The render table (src/render/procedural/decor.ts) is typed by these keys, and a test asserts the three
 * lists match. Every kind is flat or soft and <= 0.5 m tall (variety.md: decor never reads as cover).
 * `size` = the drawn bounds (x, y, z) of variant 0 or the largest variant, world metres at placement scale 1 (office
 * kinds are already at the 9x office scale); unit-tested against the meshes (+-0.03 m).
 */
export const DECOR_KIND_INFO = {
  shellCluster: { map: 'island', size: [0.49, 0.1, 0.33], variants: 2 },
  starfish: { map: 'island', size: [0.3, 0.03, 0.31], variants: 2 },
  sandcastle: { map: 'island', size: [0.8, 0.44, 0.8], variants: 1 },
  beachTowel: { map: 'island', size: [0.96, 0.11, 1.78], variants: 4 },
  fernTuft: { map: 'island', size: [0.6, 0.29, 0.58], variants: 1 },
  flowerTuft: { map: 'island', size: [0.36, 0.41, 0.36], variants: 2 },
  coconutPile: { map: 'island', size: [0.45, 0.31, 0.38], variants: 1 },
  seaweed: { map: 'island', size: [1.09, 0.03, 0.58], variants: 1 },
  paperSheets: { map: 'office', size: [3.39, 0.08, 3.21], variants: 2 },
} as const satisfies Record<string, { map: 'island' | 'office'; size: readonly [number, number, number]; variants: number }>;

export type DecorKindId = keyof typeof DECOR_KIND_INFO;
export const DECOR_KIND_IDS = Object.keys(DECOR_KIND_INFO) as DecorKindId[];
export const isDecorKind = (k: string): k is DecorKindId => Object.prototype.hasOwnProperty.call(DECOR_KIND_INFO, k);
/** Number of render variants per decor kind (DecorPlacement.variant is taken modulo this). */
export const DECOR_VARIANTS: Readonly<Record<DecorKindId, number>> = Object.fromEntries(
  DECOR_KIND_IDS.map((k) => [k, DECOR_KIND_INFO[k].variants]),
) as Record<DecorKindId, number>;
/** Max decor height (variety.md §4.4). */
export const DECOR_MAX_HEIGHT = 0.5;
