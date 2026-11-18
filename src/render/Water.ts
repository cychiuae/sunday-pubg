/**
 * Sea: one polar-grid mesh from just inside the beach out to the horizon (single draw call), with the toon water
 * shader. Dense rings near the coast carry the vertex waves; coarse geometric rings form the far ocean.
 * Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { MapData } from '../shared/types';
import type { HeightField } from './heightField';
import { buildPolarGrid, geometricRadii, ringRadii } from './radialMesh';
import { waterFragment, waterVertex } from './shaders/water';
import { palette } from './procedural';

export interface WaterOptions {
  detail: boolean;
  /** Outer radius of the dense ring band (matches the baked height field). */
  denseRadius: number;
  horizonRadius: number;
}

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(map: MapData, heightField: HeightField, sunDir: THREE.Vector3, opts: WaterOptions) {
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

    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      uWaveAmp: { value: 0.07 },
      uShallow: { value: new THREE.Color(palette.seaShallow).lerp(new THREE.Color(0xffffff), 0.18) },
      uMid: { value: new THREE.Color(palette.seaShallow) },
      uDeep: { value: new THREE.Color(palette.seaDeep) },
      uAbyss: { value: new THREE.Color(palette.seaAbyss) },
      uFoam: { value: new THREE.Color(palette.foam) },
      uSky: { value: new THREE.Color(palette.skyHorizon) },
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
