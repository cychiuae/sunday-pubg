/**
 * First-person freefall speed lines (M2b drop visuals, ARCHITECTURE §15.7): thin white streaks rushing UP past the eye
 * while the local (or FP-spectated) player is in freefall, so the fall reads fast. One LineSegments draw call, 48
 * streaks placed around the camera on the CPU each frame (96 vertices, no allocation). Owner: graphics-engineer.
 */
import * as THREE from 'three';

const COUNT = 48;
const SPAN = 14;

export class SpeedLines {
  readonly mesh: THREE.LineSegments;
  private readonly pos: THREE.BufferAttribute;
  private readonly mat: THREE.LineBasicMaterial;
  private readonly seeds = new Float32Array(COUNT * 4);
  private alpha = 0;

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(COUNT * 2 * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    let s = 777;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < COUNT; i++) {
      this.seeds[i * 4] = rnd() * Math.PI * 2; // angle
      this.seeds[i * 4 + 1] = 1.2 + rnd() * 3.2; // radius
      this.seeds[i * 4 + 2] = rnd(); // phase
      this.seeds[i * 4 + 3] = 0.8 + rnd() * 1.6; // length
    }
    this.mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false });
    this.mat.name = 'speedLines';
    this.mesh = new THREE.LineSegments(geo, this.mat);
    this.mesh.name = 'speedLines';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.visible = false;
  }

  /**
   * @param on true while the camera's subject is in freefall (FP)
   * @param fallSpeed m/s, scales the scroll speed
   */
  update(on: boolean, cam: THREE.Vector3, time: number, dt: number, fallSpeed: number): void {
    this.alpha += ((on ? 0.45 : 0) - this.alpha) * (1 - Math.exp(-dt * 6));
    this.mesh.visible = this.alpha > 0.01;
    if (!this.mesh.visible) return;
    this.mat.opacity = this.alpha;
    const P = this.pos.array as Float32Array;
    const v = Math.max(8, fallSpeed) * 1.6;
    for (let i = 0; i < COUNT; i++) {
      const a = this.seeds[i * 4], r = this.seeds[i * 4 + 1], ph = this.seeds[i * 4 + 2], len = this.seeds[i * 4 + 3];
      const y = (((ph * SPAN + time * v) % SPAN) + SPAN) % SPAN - SPAN / 2;
      const x = cam.x + Math.cos(a) * r, z = cam.z + Math.sin(a) * r;
      const o = i * 6;
      P[o] = x; P[o + 1] = cam.y + y; P[o + 2] = z;
      P[o + 3] = x; P[o + 4] = cam.y + y - len; P[o + 5] = z;
    }
    this.pos.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
