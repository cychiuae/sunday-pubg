/**
 * Sea: one polar-grid mesh from just inside the beach out to the horizon (single draw call), with the toon water
 * shader. Dense rings near the coast carry the vertex waves; coarse geometric rings form the far ocean.
 * Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { IslandMapData } from '../shared/types';
import type { HeightField } from './heightField';
import { buildPolarGrid, geometricRadii, ringRadii } from './radialMesh';
import { waterFragment, waterVertex } from './shaders/water';
import { palette } from './procedural';
import type { SceneLook } from './Sky';

export interface WaterOptions {
  detail: boolean;
  /** Outer radius of the dense ring band (matches the baked height field). */
  denseRadius: number;
  horizonRadius: number;
  /** M2c look preset: sea bands, glint density and colour, fresnel sky colour. Absent = the shipped noon sea. */
  look?: SceneLook;
}

/** Glint cell threshold for a density multiplier (1 = the shipped 0.965: 3.5 % of cells glint). Pure. */
export function glintCut(density: number): number {
  return density === 1 ? 0.965 : Math.min(1, Math.max(0, 1 - 0.035 * density));
}

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(map: IslandMapData, heightField: HeightField, sunDir: THREE.Vector3, opts: WaterOptions) {
    const start = Math.max(0, map.islandRadius - map.shoreNoise.amplitude - map.beachWidth * 0.5);
    const radii = [
      ...ringRadii(start, [
        { until: map.islandRadius + map.shoreNoise.amplitude + 4, step: 0.9 },
        { until: opts.denseRadius, step: 1.6 },
      ]),
      ...geometricRadii(opts.denseRadius, opts.horizonRadius, 18),
    ];
    const geo = buildPolarGrid(radii, 192);
    geo.computeBoundingSphere();
    geo.name = 'water';

    const sea = opts.look?.sea;
    const shallow = sea?.shallow ?? palette.seaShallow;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      uWaveAmp: { value: 0.07 },
      uShallow: { value: new THREE.Color(shallow).lerp(new THREE.Color(0xffffff), 0.18) },
      uMid: { value: new THREE.Color(shallow) },
      uDeep: { value: new THREE.Color(sea?.deep ?? palette.seaDeep) },
      uAbyss: { value: new THREE.Color(sea?.abyss ?? palette.seaAbyss) },
      uFoam: { value: new THREE.Color(palette.foam) },
      uSky: { value: new THREE.Color(opts.look?.sky?.horizon ?? palette.skyHorizon) },
      uGlintCut: { value: glintCut(sea?.glint ?? 1) },
      uGlintColor: { value: new THREE.Color(sea?.glintColor ?? 0xffffff) },
      uSunDir: { value: sunDir.clone().normalize() },
      uHeightTex: { value: heightField.texture },
      uHeightRect: { value: heightField.rect },
      uWorldRadius: { value: map.worldRadius },
    });
    this.material = new THREE.ShaderMaterial({
      name: 'water',
      uniforms,
      vertexShader: waterVertex,
      fragmentShader: waterFragment,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.setDetail(opts.detail);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'water';
    this.mesh.renderOrder = 1;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  setDetail(detail: boolean): void {
    const has = 'WATER_DETAIL' in this.material.defines;
    if (has === detail) return;
    if (detail) this.material.defines.WATER_DETAIL = '';
    else delete this.material.defines.WATER_DETAIL;
    this.material.needsUpdate = true;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
