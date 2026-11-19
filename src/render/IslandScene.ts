/**
 * The island's static world (M1/M2a content, unchanged look): sky dome + clouds, terrain, toon sea, island props
 * (instanced) and the tide wall. Built for `kind !== 'indoor'` maps by Renderer (ADR 0005 §5). Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { heightAt as simHeightAt, surfaceAt as simSurfaceAt } from '../shared/sim/terrain';
import type { DecorPlacement, IslandMapData, Surface } from '../shared/types';
import { CameraObstacles } from './cameraRig';
import { bakeHeightField, type HeightField } from './heightField';
import type { MapScene, MapSceneFrame } from './mapScene';
import { PropLayer } from './PropLayer';
import type { QualitySettings } from './quality';
import { ISLAND_LOOK, Sky, type SceneLook } from './Sky';
import { buildTerrain } from './TerrainMesh';
import { TideWall } from './TideWall';
import { visualHeight } from './visualTerrain';
import { Water } from './Water';

/** Terrain / height-field coverage beyond the world boundary (m). */
export const TERRAIN_MARGIN = 45;
const HORIZON_RADIUS = 2400;
const CAMERA_FAR = 2600;

export class IslandScene implements MapScene {
  readonly kind = 'island' as const;
  readonly mapId: string;
  readonly group = new THREE.Group();
  readonly look: SceneLook;
  readonly obstacles: CameraObstacles;
  readonly orbitShadowExtent: number;
  readonly cameraFar = CAMERA_FAR;
  readonly heightField: HeightField;
  private readonly sky: Sky;
  private readonly terrain: THREE.Mesh;
  private readonly water: Water;
  private readonly props: PropLayer;
  private readonly tide: TideWall;
  readonly heightAt: (x: number, z: number) => number;
  readonly visualHeight: (x: number, z: number) => number;
  readonly surfaceAt: (x: number, z: number) => Surface;

  /** @param look M2c look preset (looks.ts `sceneLookFor`); default = the shipped noon look. */
  constructor(map: IslandMapData, quality: QualitySettings, look: SceneLook = ISLAND_LOOK, decor: readonly DecorPlacement[] = []) {
    this.mapId = map.id;
    this.look = look;
    this.group.name = `island:${map.id}`;
    this.orbitShadowExtent = map.islandRadius + 15;
    const terrainRadius = map.worldRadius + TERRAIN_MARGIN;
    this.visualHeight = (x, z) => visualHeight(x, z, map);
    this.heightAt = (x, z) => simHeightAt(x, z, map);
    this.surfaceAt = (x, z) => simSurfaceAt(x, z, map);

    // Height texture for water depth / foam and the tide wall skirt.
    const dryR = Math.max(0, map.islandRadius - map.shoreNoise.amplitude - map.beachWidth);
    this.heightField = bakeHeightField(this.visualHeight, terrainRadius + 5, 512, dryR);

    this.sky = new Sky(look);
    this.terrain = buildTerrain(map, this.visualHeight, this.surfaceAt, terrainRadius).mesh;
    this.water = new Water(map, this.heightField, look.sunDir, {
      detail: quality.waterDetail,
      denseRadius: terrainRadius,
      horizonRadius: HORIZON_RADIUS,
      look,
    });
    this.props = new PropLayer(map, this.heightAt, { flameScale: look.flameScale ?? 1, decor });
    this.tide = new TideWall(this.heightField, this.heightAt);
    this.group.add(this.sky.group, this.terrain, this.water.mesh, this.props.group, this.tide.group);
    this.obstacles = new CameraObstacles(this.heightAt, this.props.colliders, terrainRadius);
  }

  update(f: MapSceneFrame): void {
    const q = f.quality;
    const cp = f.camera.position;
    this.props.update(f.frustum, cp, f.time, q.propDrawDistance, q.outlineDistance * f.lod);
    this.tide.update(f.zone, f.time, f.dt);
    this.water.update(f.time);
    this.sky.update(f.camera, f.time);
  }

  pulseZone(): void {
    this.tide.pulseNow();
  }

  setQuality(q: QualitySettings): void {
    this.water.setDetail(q.waterDetail);
  }

  dispose(): void {
    this.props.dispose();
    this.tide.dispose();
    this.water.dispose();
    this.sky.dispose();
    this.terrain.geometry.dispose(); // material: the shared procedural vertexColorToon (not ours)
    this.heightField.texture.dispose();
    this.group.clear();
  }
}
