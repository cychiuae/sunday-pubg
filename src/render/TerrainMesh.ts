/**
 * Island terrain mesh from the shared sim height function. Owner: graphics-engineer.
 * Vertices sit exactly on heightAt(x, z) (B8 acceptance: within 0.05 m; vertices are exact and the ring spacing
 * keeps the linear-interpolation error between vertices under ~0.035 m on the steepest hill).
 * Vertex colours: dry sand / wet sand / grass (+ toon patches), seabed under water. Shared toon material.
 */
import * as THREE from 'three';
import type { MapData, Surface } from '../shared/types';
import { buildPolarGrid, ringRadii } from './radialMesh';
import { mixHex, palette, vertexColorToon } from './procedural';

export type SurfaceFn = (x: number, z: number) => Surface;

/** Wet-sand band height above sea level (m). Visual only. */
export const WET_SAND_HEIGHT = 0.45;

function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
/** Cheap value noise in [0, 1]. */
export function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Terrain albedo (sRGB hex) at a point. Pure; exported for tests. */
export function terrainColor(h: number, surface: Surface, x: number, z: number, slope: number): number {
  if (surface === 'water' || h < 0) {
    const d = Math.min(1, -h / 2.5);
    return mixHex(palette.wetSand, palette.seaDeep, 0.15 + d * 0.35);
  }
  if (surface === 'grass') {
    // Subtle toon patches: kept well lighter than a cast shadow so they never read as cover/shade.
    const patch = valueNoise(x * 0.11, z * 0.11) > 0.6 ? 1 : 0;
    let c: number = patch ? mixHex(palette.grass, palette.grassDark, 0.35) : palette.grass;
    if (slope > 0.38) c = mixHex(c, palette.grassDark, 0.3);
    return c;
  }
  // sand
  if (h < WET_SAND_HEIGHT) {
    const t = Math.max(0, h / WET_SAND_HEIGHT);
    return mixHex(palette.wetSand, palette.sandDark, t * t);
  }
  const ripple = valueNoise(x * 0.2, z * 0.2) > 0.62 ? 1 : 0;
  return ripple ? palette.sandDark : palette.sandLight;
}

export interface TerrainBuild {
  mesh: THREE.Mesh;
  /** Outer radius covered by the terrain mesh. */
  radius: number;
}

export function buildTerrain(
  map: MapData,
  heightAt: (x: number, z: number) => number,
  surfaceAt: SurfaceFn,
  radius: number,
  segments = 256,
): TerrainBuild {
  const beachInner = map.islandRadius - map.beachWidth - map.shoreNoise.amplitude - 4;
  const beachOuter = map.islandRadius + map.shoreNoise.amplitude + 6;
  const radii = ringRadii(0, [
    { until: beachInner, step: 1.25 },
    { until: beachOuter, step: 0.75 },
    { until: map.worldRadius + 6, step: 1.5 },
    { until: radius, step: 3 },
  ]);
  const geo = buildPolarGrid(radii, segments);
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const n = pos.count;
  for (let i = 0; i < n; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const ny = Math.min(1, Math.max(0, nrm.getY(i)));
    const slope = Math.sqrt(1 - ny * ny) / Math.max(ny, 1e-3);
    c.setHex(terrainColor(y, surfaceAt(x, z), x, z, slope));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  geo.name = 'terrain';

  const mesh = new THREE.Mesh(geo, vertexColorToon());
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return { mesh, radius };
}
