/**
 * M2b: one map's static world (ADR 0005 §5, ARCHITECTURE §15.7). Renderer keeps exactly one MapScene and swaps it on
 * `mapChanged`: IslandScene (terrain, sea, sky, tide wall, island props) or IndoorScene (floor, walls, glass, kit
 * props, ceiling, rain curtain). Everything map-independent (players, loot, grenades, VFX, carrier) stays in Renderer.
 * Owner: graphics-engineer.
 */
import type * as THREE from 'three';
import type { CameraView } from '../shared/contracts';
import type { IndoorSurface, Surface, ZoneState } from '../shared/types';
import type { CameraObstacles } from './cameraRig';
import type { QualitySettings } from './quality';
import type { SceneLook } from './Sky';

export interface MapSceneFrame {
  time: number;
  dt: number;
  serverTime: number;
  camera: THREE.PerspectiveCamera;
  view: CameraView;
  frustum: THREE.Frustum;
  quality: QualitySettings;
  /** Draw/outline distance multiplier for zoomed views (lodZoom). */
  lod: number;
  zone: ZoneState | null;
  /** True in the first-person camera cases. */
  firstPerson: boolean;
  /** World position of the carrier while it is drawn, else null (indoor light panels retract around it). */
  carrier: THREE.Vector3 | null;
}

export interface MapScene {
  readonly kind: 'island' | 'indoor';
  readonly mapId: string;
  /** Everything the scene draws (added to the Renderer's scene by the caller). */
  readonly group: THREE.Group;
  readonly look: SceneLook;
  /** Camera floor, prisms and (indoors) ceiling and bounds for the 3P rig. */
  readonly obstacles: CameraObstacles;
  /** Shadow frustum half-extent for the orbit cases (title / death / results). */
  readonly orbitShadowExtent: number;
  /** Far plane for this map. */
  readonly cameraFar: number;
  /** Sim ground height (0 indoors). */
  heightAt(x: number, z: number): number;
  /** Drawn ground height (island: the reef drop-off beyond the playable area). */
  visualHeight(x: number, z: number): number;
  surfaceAt(x: number, z: number): Surface | IndoorSurface;
  update(f: MapSceneFrame): void;
  /** Zone phase change pulse (tide wall / rain curtain). */
  pulseZone(): void;
  setQuality(q: QualitySettings): void;
  /** M2c: FrameView.brokenPanes (indoor only; the island has no glass). */
  setBrokenPanes?(ids: readonly number[]): void;
  /** Frees every GPU resource this scene created (shared procedural caches are left alone). */
  dispose(): void;
}
