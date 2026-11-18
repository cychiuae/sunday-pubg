/**
 * Terrain height baked into a half-float texture for the water depth colour, shoreline foam and the tide wall's
 * foam skirt. Owner: graphics-engineer. Values are metres (not normalised), linear filtered.
 */
import * as THREE from 'three';
import type { HeightFn } from './cameraRig';

export interface HeightField {
  texture: THREE.DataTexture;
  /** (minX, minZ, size, 1/size): uv = (xz - min) / size. */
  rect: THREE.Vector4;
}

/**
 * @param extent half-size of the square region (m)
 * @param resolution texels per side
 * @param dryInsideRadius texels closer than this to the origin are written as `dryHeight` without sampling
 *        (deep inland: never seen through water). Saves most of the bake time.
 */
export function bakeHeightField(
  heightAt: HeightFn,
  extent: number,
  resolution: number,
  dryInsideRadius: number,
  dryHeight = 3,
): HeightField {
  const size = extent * 2;
  const data = new Uint16Array(resolution * resolution);
  const dry = THREE.DataUtils.toHalfFloat(dryHeight);
  const dry2 = dryInsideRadius * dryInsideRadius;
  for (let j = 0; j < resolution; j++) {
    const z = -extent + ((j + 0.5) / resolution) * size;
    for (let i = 0; i < resolution; i++) {
      const x = -extent + ((i + 0.5) / resolution) * size;
      data[j * resolution + i] = x * x + z * z < dry2 ? dry : THREE.DataUtils.toHalfFloat(heightAt(x, z));
    }
  }
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  texture.name = 'terrainHeight';
  // DataTexture rows: j indexes +Z; with flipY false, v = (z - minZ) / size.
  return { texture, rect: new THREE.Vector4(-extent, -extent, size, 1 / size) };
}
