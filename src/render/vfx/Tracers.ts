/**
 * Pooled camera-facing tracer streaks (one draw call). Owner: graphics-engineer.
 * Each tracer is a streak whose head travels muzzle -> impact at `speed`; the tail lags by `streakLength`.
 * When the head arrives, `onArrive(tag, x, y, z)` fires once (impact VFX). No per-frame allocation.
 */
import * as THREE from 'three';

export type TracerArrive = (tag: number, x: number, y: number, z: number, aux: number) => void;

export class TracerSystem {
  readonly mesh: THREE.Mesh;
  private readonly cap: number;
  private count = 0;
  private readonly seg: Float32Array; // sx sy sz ex ey ez
  private readonly age: Float32Array;
  private readonly len: Float32Array;
  private readonly width: Float32Array;
  private readonly rgb: Float32Array;
  private readonly tag: Int32Array;
  private readonly aux: Float32Array;
  private readonly arrived: Uint8Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aCol: THREE.BufferAttribute;

  constructor(
    capacity: number,
    private readonly onArrive: TracerArrive,
    private readonly speed = 220,
    private readonly streakLength = 7,
    private readonly fadeTime = 0.08,
  ) {
    this.cap = capacity;
    this.seg = new Float32Array(capacity * 6);
    this.age = new Float32Array(capacity);
    this.len = new Float32Array(capacity);
    this.width = new Float32Array(capacity);
    this.rgb = new Float32Array(capacity * 3);
    this.tag = new Int32Array(capacity);
    this.aux = new Float32Array(capacity);
    this.arrived = new Uint8Array(capacity);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(new Float32Array(capacity * 4 * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    const idx = new Uint16Array(capacity * 6);
    for (let i = 0; i < capacity; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    mat.name = 'vfx:tracers';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'vfx:tracers';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 21;
  }

  /** rgb = linear colour. tag/aux are passed back in onArrive (e.g. surface code, headshot flag). */
  spawn(
    sx: number, sy: number, sz: number, ex: number, ey: number, ez: number,
    width: number, r: number, g: number, b: number, tag: number, aux: number,
  ): void {
    const L = Math.hypot(ex - sx, ey - sy, ez - sz);
    if (this.count >= this.cap || L < 0.05) {
      this.onArrive(tag, ex, ey, ez, aux);
      return;
    }
    const i = this.count++;
    const s = i * 6;
    this.seg[s] = sx;
    this.seg[s + 1] = sy;
    this.seg[s + 2] = sz;
    this.seg[s + 3] = ex;
    this.seg[s + 4] = ey;
    this.seg[s + 5] = ez;
    this.age[i] = 0;
    this.len[i] = L;
    this.width[i] = width;
    this.rgb[i * 3] = r;
    this.rgb[i * 3 + 1] = g;
    this.rgb[i * 3 + 2] = b;
    this.tag[i] = tag;
    this.aux[i] = aux;
    this.arrived[i] = 0;
  }

  private remove(i: number): void {
    this.count--;
    const j = this.count;
    if (i === j) return;
    for (let k = 0; k < 6; k++) this.seg[i * 6 + k] = this.seg[j * 6 + k];
    for (let k = 0; k < 3; k++) this.rgb[i * 3 + k] = this.rgb[j * 3 + k];
    this.age[i] = this.age[j];
    this.len[i] = this.len[j];
    this.width[i] = this.width[j];
    this.tag[i] = this.tag[j];
    this.aux[i] = this.aux[j];
    this.arrived[i] = this.arrived[j];
  }

  update(dt: number, camX: number, camY: number, camZ: number): void {
    const P = this.aPos.array as Float32Array;
    const C = this.aCol.array as Float32Array;
    let i = 0;
    let q = 0;
    while (i < this.count) {
      this.age[i] += dt;
      const L = this.len[i];
      const travel = this.age[i] * this.speed;
      const s = i * 6;
      if (!this.arrived[i] && travel >= L) {
        this.arrived[i] = 1;
        this.onArrive(this.tag[i], this.seg[s + 3], this.seg[s + 4], this.seg[s + 5], this.aux[i]);
      }
      const travelTime = L / this.speed;
      const tailT = Math.min(1, Math.max(0, (travel - this.streakLength) / L));
      const headT = Math.min(1, travel / L);
      const fade = this.age[i] > travelTime ? 1 - (this.age[i] - travelTime) / this.fadeTime : 1;
      if (fade <= 0 || tailT >= 1) {
        this.remove(i);
        continue;
      }
      const sx = this.seg[s], sy = this.seg[s + 1], sz = this.seg[s + 2];
      const dx = this.seg[s + 3] - sx, dy = this.seg[s + 4] - sy, dz = this.seg[s + 5] - sz;
      const hx = sx + dx * headT, hy = sy + dy * headT, hz = sz + dz * headT;
      const tx = sx + dx * tailT, ty = sy + dy * tailT, tz = sz + dz * tailT;
      // side = normalize(dir x (cam - mid))
      const mx = (hx + tx) * 0.5 - camX, my = (hy + ty) * 0.5 - camY, mz = (hz + tz) * 0.5 - camZ;
      let px = dy * mz - dz * my, py = dz * mx - dx * mz, pz = dx * my - dy * mx;
      const pl = Math.hypot(px, py, pz) || 1;
      const w = this.width[i] * 0.5;
      px = (px / pl) * w;
      py = (py / pl) * w;
      pz = (pz / pl) * w;
      const v = q * 12;
      // tail (thin) then head (full width)
      P[v] = tx - px * 0.3; P[v + 1] = ty - py * 0.3; P[v + 2] = tz - pz * 0.3;
      P[v + 3] = tx + px * 0.3; P[v + 4] = ty + py * 0.3; P[v + 5] = tz + pz * 0.3;
      P[v + 6] = hx - px; P[v + 7] = hy - py; P[v + 8] = hz - pz;
      P[v + 9] = hx + px; P[v + 10] = hy + py; P[v + 11] = hz + pz;
      const c = q * 16;
      const r = this.rgb[i * 3], g = this.rgb[i * 3 + 1], b = this.rgb[i * 3 + 2];
      for (let k = 0; k < 4; k++) {
        C[c + k * 4] = r;
        C[c + k * 4 + 1] = g;
        C[c + k * 4 + 2] = b;
        C[c + k * 4 + 3] = (k < 2 ? 0.0 : 0.95) * fade;
      }
      q++;
      i++;
    }
    this.aPos.clearUpdateRanges();
    this.aCol.clearUpdateRanges();
    if (q > 0) {
      this.aPos.addUpdateRange(0, q * 12);
      this.aCol.addUpdateRange(0, q * 16);
      this.aPos.needsUpdate = true;
      this.aCol.needsUpdate = true;
    }
    this.mesh.geometry.setDrawRange(0, q * 6);
    this.mesh.visible = q > 0;
  }

  clear(): void {
    this.count = 0;
    this.mesh.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
