/**
 * Per-frame point markers (one THREE.Points, one draw call): grenade arc dots, grenade fuse blinks and remote scope
 * glints. Unlike ParticleSystem nothing is simulated: callers `begin()`, `add(...)` every frame, then `end()`.
 * Same shader and shapes as the particles (shaders/particles.ts), but without fog so a scope glint reads at any
 * range. Fixed capacity, allocation-free. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { particleFragment, particleVertex, type ParticleShape } from '../shaders/particles';

export class Markers {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private count = 0;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;
  private readonly aShape: THREE.BufferAttribute;
  private readonly aRot: THREE.BufferAttribute;
  private readonly attrs: THREE.BufferAttribute[];
  private readonly material: THREE.ShaderMaterial;
  /** Pixels per metre at 1 m (same as the particles' uScale). */
  private pxPerMetre = 500;

  constructor(capacity: number, inkHex: number) {
    this.capacity = capacity;
    const geo = new THREE.BufferGeometry();
    const mk = (n: number) => new THREE.BufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(3);
    this.aColor = mk(4);
    this.aSize = mk(1);
    this.aShape = mk(1);
    this.aRot = mk(1);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aColor);
    geo.setAttribute('aSize', this.aSize);
    geo.setAttribute('aShape', this.aShape);
    geo.setAttribute('aRot', this.aRot);
    geo.setDrawRange(0, 0);
    this.attrs = [this.aPos, this.aColor, this.aSize, this.aShape, this.aRot];
    this.material = new THREE.ShaderMaterial({
      name: 'vfx:markers',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 }, uMaxPx: { value: 256 } }]),
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.material.uniforms.uInk = { value: new THREE.Color(inkHex) };
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'vfx:markers';
    this.points.frustumCulled = false;
    this.points.renderOrder = 21;
    this.points.visible = false;
  }

  get size(): number {
    return this.count;
  }

  setProjection(viewportHeightPx: number, fovDeg: number, maxPointPx: number): void {
    this.pxPerMetre = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.material.uniforms.uScale.value = this.pxPerMetre;
    this.material.uniforms.uMaxPx.value = maxPointPx;
  }

  /** World size (m) that is `px` pixels tall at distance `dist`. */
  worldSizeForPixels(px: number, dist: number): number {
    return (px * Math.max(dist, 0.05)) / this.pxPerMetre;
  }

  begin(): void {
    this.count = 0;
  }

  /** Colour is linear RGB. Returns false when full. */
  add(x: number, y: number, z: number, size: number, r: number, g: number, b: number, a: number, shape: ParticleShape, rot = 0): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    const P = this.aPos.array as Float32Array;
    const C = this.aColor.array as Float32Array;
    P[i * 3] = x;
    P[i * 3 + 1] = y;
    P[i * 3 + 2] = z;
    C[i * 4] = r;
    C[i * 4 + 1] = g;
    C[i * 4 + 2] = b;
    C[i * 4 + 3] = a;
    (this.aSize.array as Float32Array)[i] = size;
    (this.aShape.array as Float32Array)[i] = shape;
    (this.aRot.array as Float32Array)[i] = rot;
    return true;
  }

  end(): void {
    const n = this.count;
    for (let k = 0; k < this.attrs.length; k++) {
      const attr = this.attrs[k];
      attr.clearUpdateRanges();
      if (n > 0) {
        attr.addUpdateRange(0, n * attr.itemSize);
        attr.needsUpdate = true;
      }
    }
    this.points.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
