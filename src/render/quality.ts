/**
 * Render quality presets. Owner: graphics-engineer. Documented in docs/tech/RENDERING.md ("Quality knobs").
 * These are render-cost knobs only. Gameplay numbers live in balance.json.
 */
export type QualityPreset = 'low' | 'medium' | 'high';

export interface QualitySettings {
  /** Upper bound for devicePixelRatio. */
  maxPixelRatio: number;
  /** MSAA on the default framebuffer. Only read at construction (WebGL limitation). */
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Half-extent (m) of the orthographic sun shadow frustum around the camera target. */
  shadowHalfExtent: number;
  /** Instanced props farther than this from the camera are not drawn (m). */
  propDrawDistance: number;
  /** Prop/loot outline hulls farther than this are not drawn (m). */
  outlineDistance: number;
  /** Character outline hulls farther than this are hidden (m). */
  characterOutlineDistance: number;
  /** Loot farther than this is not drawn (m). */
  lootDrawDistance: number;
  /** Max simultaneously live particles. */
  maxParticles: number;
  /** Water: sparkle + second foam line + vertex waves. */
  waterDetail: boolean;
}

export const QUALITY_PRESETS: Record<QualityPreset, QualitySettings> = {
  low: {
    maxPixelRatio: 1,
    antialias: false,
    shadows: true,
    shadowMapSize: 1024,
    shadowHalfExtent: 28,
    propDrawDistance: 220,
    outlineDistance: 70,
    characterOutlineDistance: 25,
    lootDrawDistance: 50,
    maxParticles: 512,
    waterDetail: false,
  },
  medium: {
    maxPixelRatio: 1.5,
    antialias: true,
    shadows: true,
    shadowMapSize: 2048,
    shadowHalfExtent: 42,
    propDrawDistance: 320,
    outlineDistance: 140,
    characterOutlineDistance: 45,
    lootDrawDistance: 75,
    maxParticles: 1024,
    waterDetail: true,
  },
  high: {
    maxPixelRatio: 2,
    antialias: true,
    shadows: true,
    shadowMapSize: 4096,
    shadowHalfExtent: 60,
    propDrawDistance: 450,
    outlineDistance: 300,
    characterOutlineDistance: 80,
    lootDrawDistance: 110,
    maxParticles: 2048,
    waterDetail: true,
  },
};

export const DEFAULT_QUALITY: QualityPreset = 'medium';
