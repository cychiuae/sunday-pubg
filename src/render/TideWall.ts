/**
 * The tide (zone) visuals: a translucent animated water wall on the current circle (tracked every frame, smoothed
 * between 20 Hz snapshots) and a dashed ribbon draped over the terrain on the target circle while it differs from
 * the current one. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { ZoneState } from '../shared/types';
import type { HeightField } from './heightField';
import { tideWallFragment, tideWallVertex } from './shaders/tideWall';
import { palette } from './procedural';

const WALL_BOTTOM = -3;
const WALL_HEIGHT = 42;
const RING_SEGMENTS = 256;
const RING_WIDTH = 0.45;
/** Smoothing time constant for radius/centre between snapshots (s). */
const SMOOTH_TAU = 0.12;

export class TideWall {
  readonly group = new THREE.Group();
  private readonly wall: THREE.Mesh;
  private readonly wallMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly ringPos: THREE.BufferAttribute;
  private radius = -1;
  private cx = 0;
  private cz = 0;
  private pulse = 0;
  private ringX = NaN;
  private ringZ = NaN;
  private ringR = NaN;

  constructor(
    heightField: HeightField,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.group.name = 'tide';
    const geo = new THREE.CylinderGeometry(1, 1, WALL_HEIGHT, 160, 1, true).translate(0, WALL_HEIGHT / 2, 0);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uRadius: { value: 100 },
      uColor: { value: new THREE.Color(palette.tideWall) },
      uFoam: { value: new THREE.Color(palette.tideFoam) },
      uHeightTex: { value: heightField.texture },
      uHeightRect: { value: heightField.rect },
    });
    this.wallMat = new THREE.ShaderMaterial({
      name: 'tideWall',
      uniforms,
      vertexShader: tideWallVertex,
      fragmentShader: tideWallFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.wall = new THREE.Mesh(geo, this.wallMat);
    this.wall.name = 'tideWall';
    this.wall.position.y = WALL_BOTTOM;
    this.wall.renderOrder = 10;
    this.wall.frustumCulled = false;
    this.wall.visible = false;
    this.group.add(this.wall);

    // Target ring: triangle strip as indexed quads, y draped on terrain/sea.
    const ringGeo = new THREE.BufferGeometry();
    this.ringPos = new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 2 * 3), 3);
    const uv = new Float32Array((RING_SEGMENTS + 1) * 2 * 2);
    const idx: number[] = [];
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      uv[i * 4] = i / RING_SEGMENTS;
      uv[i * 4 + 1] = 0;
      uv[i * 4 + 2] = i / RING_SEGMENTS;
      uv[i * 4 + 3] = 1;
      if (i < RING_SEGMENTS && i % 2 === 0) {
        // dashed: every other segment
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    ringGeo.setAttribute('position', this.ringPos);
    ringGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    ringGeo.setIndex(idx);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: palette.foam, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide,
      toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.ringMat.name = 'tideTargetRing';
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.name = 'tideTargetRing';
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.group.add(this.ring);
  }

  /** Brief brightening (shrink start / phase change). */
  pulseNow(): void {
    this.pulse = 1;
  }

  private rebuildRing(cx: number, cz: number, r: number): void {
    const P = this.ringPos.array as Float32Array;
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const a = (i / RING_SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      for (let k = 0; k < 2; k++) {
        const rr = r + (k === 0 ? -RING_WIDTH : RING_WIDTH);
        const x = cx + c * rr, z = cz + s * rr;
        const y = Math.max(this.heightAt(x, z), 0.05) + 0.12;
        const o = (i * 2 + k) * 3;
        P[o] = x;
        P[o + 1] = y;
        P[o + 2] = z;
      }
    }
    this.ringPos.needsUpdate = true;
  }

  update(zone: ZoneState | null, time: number, dt: number): void {
    if (!zone || zone.radius <= 0) {
      this.wall.visible = false;
      this.ring.visible = false;
      this.radius = -1;
      return;
    }
    const k = this.radius < 0 ? 1 : 1 - Math.exp(-dt / SMOOTH_TAU);
    this.radius += (zone.radius - this.radius) * k;
    this.cx += (zone.center.x - this.cx) * k;
    this.cz += (zone.center.z - this.cz) * k;

    this.wall.visible = true;
    this.wall.position.set(this.cx, WALL_BOTTOM, this.cz);
    this.wall.scale.set(this.radius, 1, this.radius);
    this.pulse = Math.max(0, this.pulse - dt * 1.5);
    const u = this.wallMat.uniforms;
    u.uTime.value = time;
    u.uRadius.value = this.radius;
    u.uPulse.value = this.pulse;

    const showRing = Math.abs(zone.targetRadius - zone.radius) > 0.5 || zone.targetCenter.x !== zone.center.x || zone.targetCenter.z !== zone.center.z;
    this.ring.visible = showRing && zone.targetRadius > 0;
    if (this.ring.visible) {
      const tc = zone.targetCenter;
      if (tc.x !== this.ringX || tc.z !== this.ringZ || zone.targetRadius !== this.ringR) {
        this.ringX = tc.x;
        this.ringZ = tc.z;
        this.ringR = zone.targetRadius;
        this.rebuildRing(tc.x, tc.z, zone.targetRadius);
      }
      this.ringMat.opacity = 0.65 + 0.25 * Math.sin(time * 3);
    }
  }

  dispose(): void {
    this.wall.geometry.dispose();
    this.wallMat.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}
