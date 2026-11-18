/**
 * Pooled CPU particles drawn as one THREE.Points (single draw call). Owner: graphics-engineer.
 * Fixed capacity, struct-of-arrays, swap-remove compaction. emit() and update() never allocate.
 */
import * as THREE from 'three';
import { PARTICLE_SHAPE, particleFragment, particleVertex, type ParticleShape } from '../shaders/particles';

/** Reusable emit parameters. Fill the fields, then call `emit(spec)`; the object is copied, not retained. */
export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  /** World metres at birth / death. */
  size0: number;
  size1: number;
  /** Linear RGB (use `linearRgb()` to convert palette hex once). */
  r: number;
  g: number;
  b: number;
  alpha: number;
  shape: ParticleShape;
  /** m/s^2 downward. */
  gravity: number;
  /** Fraction of velocity lost per second (0..~10). */
  drag: number;
  rot: number;
  rotVel: number;
}

export function makeSpec(): ParticleSpec {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size0: 0.2, size1: 0.2, r: 1, g: 1, b: 1, alpha: 1,
    shape: PARTICLE_SHAPE.puff, gravity: 0, drag: 0, rot: 0, rotVel: 0,
  };
}

const _c = new THREE.Color();
/** Palette hex (sRGB) -> linear RGB triple, for ParticleSpec / vertex colours. */
export function linearRgb(hex: number): [number, number, number] {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
}

export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private count = 0;
  // Simulation state
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly rgb: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly shape: Float32Array;
  private readonly rot: Float32Array;
  private readonly rotVel: Float32Array;
  // GPU attributes
  private readonly aPos: THREE.BufferAttribute;
  private readonly aColor: THREE.BufferAttribute;
  private readonly aSize: THREE.BufferAttribute;
  private readonly aShape: THREE.BufferAttribute;
  private readonly aRot: THREE.BufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private readonly attrs: THREE.BufferAttribute[];

  constructor(capacity: number, inkHex: number) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.rgb = new Float32Array(capacity * 3);
    this.alpha0 = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.shape = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.rotVel = new Float32Array(capacity);

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
      name: 'vfx:particles',
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 500 }, uMaxPx: { value: 256 } }]),
      vertexShader: particleVertex,
      fragmentShader: particleFragment,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.material.uniforms.uInk = { value: new THREE.Color(inkHex) };
    this.points = new THREE.Points(geo, this.material);
    this.points.name = 'vfx:particles';
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  get liveCount(): number {
    return this.count;
  }

  /** Pixels per metre at 1 m distance; call on resize / fov change. */
  setProjection(viewportHeightPx: number, fovDeg: number, maxPointPx: number): void {
    this.material.uniforms.uScale.value = viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.material.uniforms.uMaxPx.value = maxPointPx;
  }

  emit(s: ParticleSpec): void {
    if (this.count >= this.capacity) return; // pool full: drop (cosmetic only)
    const i = this.count++;
    const i3 = i * 3;
    this.pos[i3] = s.x;
    this.pos[i3 + 1] = s.y;
    this.pos[i3 + 2] = s.z;
    this.vel[i3] = s.vx;
    this.vel[i3 + 1] = s.vy;
    this.vel[i3 + 2] = s.vz;
    this.age[i] = 0;
    this.life[i] = Math.max(0.01, s.life);
    this.size0[i] = s.size0;
    this.size1[i] = s.size1;
    this.rgb[i3] = s.r;
    this.rgb[i3 + 1] = s.g;
    this.rgb[i3 + 2] = s.b;
    this.alpha0[i] = s.alpha;
    this.gravity[i] = s.gravity;
    this.drag[i] = s.drag;
    this.shape[i] = s.shape;
    this.rot[i] = s.rot;
    this.rotVel[i] = s.rotVel;
  }

  private copy(from: number, to: number): void {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.rgb[t3 + k] = this.rgb[f3 + k];
    }
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.alpha0[to] = this.alpha0[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
    this.shape[to] = this.shape[from];
    this.rot[to] = this.rot[from];
    this.rotVel[to] = this.rotVel[from];
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.count--;
        if (i !== this.count) this.copy(this.count, i);
        continue;
      }
      const i3 = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3] *= damp;
      this.vel[i3 + 1] = this.vel[i3 + 1] * damp - this.gravity[i] * dt;
      this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.rot[i] += this.rotVel[i] * dt;
      i++;
    }

    const P = this.aPos.array as Float32Array;
    const C = this.aColor.array as Float32Array;
    const S = this.aSize.array as Float32Array;
    const H = this.aShape.array as Float32Array;
    const R = this.aRot.array as Float32Array;
    for (let j = 0; j < this.count; j++) {
      const j3 = j * 3, j4 = j * 4;
      const t = this.age[j] / this.life[j];
      const ease = 1 - (1 - t) * (1 - t);
      P[j3] = this.pos[j3];
      P[j3 + 1] = this.pos[j3 + 1];
      P[j3 + 2] = this.pos[j3 + 2];
      C[j4] = this.rgb[j3];
      C[j4 + 1] = this.rgb[j3 + 1];
      C[j4 + 2] = this.rgb[j3 + 2];
      C[j4 + 3] = this.alpha0[j] * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
      S[j] = this.size0[j] + (this.size1[j] - this.size0[j]) * ease;
      H[j] = this.shape[j];
      R[j] = this.rot[j];
    }
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

  clear(): void {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
