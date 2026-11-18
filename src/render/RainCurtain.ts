/**
 * Office zone visuals, "Sprinkler" theme (STYLE.md §19.5 B; maps.office.zoneTheme 'sprinklers'). Owner:
 * graphics-engineer.
 * - Curtain: a falling-water cylinder on the current circle, floor to ceiling (smoothed between snapshots like the
 *   tide wall), plus the dashed target ring on the floor while the next circle differs.
 * - Rain: ≤ 3k GPU line streaks (medium) in a box around the camera, outside the circle only, stopped by desk tops.
 *   One draw call, no CPU work per streak.
 * - Wet floor: `wet` (cx, cz, r, on) feeds the floor shader (25% toward #8FA6B5 outside the circle).
 * - Splashes: a few pooled particle rings per second on the floor / desk tops near the camera (via `splash`).
 * The theme 'lightsOut' (not designed for M2b) gets the curtain without rain.
 */
import * as THREE from 'three';
import type { ZoneState } from '../shared/types';
import { INDOOR_FX } from './indoorFx';
import { rainCurtainFragment, rainCurtainVertex, rainFragment, rainVertex } from './shaders/rainCurtain';

const RING_SEGMENTS = 256;
const RING_WIDTH = 0.45;
const SMOOTH_TAU = 0.12;
/** Rain box edge (m) around the camera and streak numbers per preset. */
const RAIN_BOX = 70;
export const RAIN_STREAKS = { low: 1200, medium: 2800, high: 4000 } as const;
const RAIN_SPEED = 25;
const RAIN_LEN = 0.6;
/** Splash rate (per second) near the camera while it rains around it. */
const SPLASH_RATE = 14;

export interface RainCurtainOptions {
  ceiling: number;
  rain: boolean;
  streaks: number;
  /** Walkable top height at (x, z) (desk tops), for splashes. */
  topAt: (x: number, z: number) => number;
  splash: (x: number, y: number, z: number) => void;
}

export class RainCurtain {
  readonly group = new THREE.Group();
  /** Floor shader uniform: (centre x, centre z, radius, on). */
  readonly wet = { value: new THREE.Vector4(0, 0, 1e6, 0) };
  private readonly wall: THREE.Mesh;
  private readonly wallMat: THREE.ShaderMaterial;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly ringPos: THREE.BufferAttribute;
  private rain: THREE.LineSegments | null = null;
  private rainMat: THREE.ShaderMaterial | null = null;
  private radius = -1;
  private cx = 0;
  private cz = 0;
  private pulse = 0;
  private ringX = NaN;
  private ringZ = NaN;
  private ringR = NaN;
  private splashT = 0;
  private seed = 1;

  constructor(private readonly opts: RainCurtainOptions) {
    this.group.name = 'rainCurtain';
    const H = opts.ceiling;
    const geo = new THREE.CylinderGeometry(1, 1, H, 160, 1, true).translate(0, H / 2, 0);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog]);
    Object.assign(uniforms, {
      uTime: { value: 0 },
      uPulse: { value: 0 },
      uRadius: { value: 100 },
      uHeight: { value: H },
      uColor: { value: new THREE.Color(0x9fd3ff) },
      uStreak: { value: new THREE.Color(0xf4fbff) },
    });
    this.wallMat = new THREE.ShaderMaterial({
      name: 'rainCurtain',
      uniforms,
      vertexShader: rainCurtainVertex,
      fragmentShader: rainCurtainFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.wall = new THREE.Mesh(geo, this.wallMat);
    this.wall.name = 'rainCurtain';
    this.wall.renderOrder = 10;
    this.wall.frustumCulled = false;
    this.wall.visible = false;
    this.group.add(this.wall);

    const ringGeo = new THREE.BufferGeometry();
    this.ringPos = new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 2 * 3), 3);
    const idx: number[] = [];
    for (let i = 0; i < RING_SEGMENTS; i += 2) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    ringGeo.setAttribute('position', this.ringPos);
    ringGeo.setIndex(idx);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xf4fbff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.ringMat.name = 'rainTargetRing';
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.name = 'rainTargetRing';
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 5;
    this.group.add(this.ring);

    if (opts.rain) this.buildRain(opts.streaks);
  }

  private buildRain(count: number): void {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return;
    const seeds = new Float32Array(n * 2 * 4);
    const pos = new Float32Array(n * 2 * 3);
    let s = 12345;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const x = rnd(), z = rnd(), ph = rnd();
      for (let k = 0; k < 2; k++) {
        const o = (i * 2 + k) * 4;
        seeds[o] = x;
        seeds[o + 1] = z;
        seeds[o + 2] = ph;
        seeds[o + 3] = k;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.rainMat = new THREE.ShaderMaterial({
      name: 'sprinklerRain',
      uniforms: {
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uBox: { value: RAIN_BOX },
        uTopY: { value: this.opts.ceiling - 1.2 },
        uSpeed: { value: RAIN_SPEED },
        uLen: { value: RAIN_LEN },
        uZone: { value: new THREE.Vector4(0, 0, 1e6, 0) },
        uCoverTex: INDOOR_FX.uCoverTex,
        uCoverRect: INDOOR_FX.uCoverRect,
        uCoverOn: INDOOR_FX.uCoverOn,
        uColor: { value: new THREE.Color(0xcfefff) },
        uOpacity: { value: 0.5 },
      },
      vertexShader: rainVertex,
      fragmentShader: rainFragment,
      transparent: true,
      depthWrite: false,
    });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.name = 'sprinklerRain';
    this.rain.frustumCulled = false;
    this.rain.renderOrder = 6;
    this.rain.visible = false;
    this.group.add(this.rain);
  }

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
        const o = (i * 2 + k) * 3;
        P[o] = cx + c * rr;
        P[o + 1] = 0.06;
        P[o + 2] = cz + s * rr;
      }
    }
    this.ringPos.needsUpdate = true;
  }

  update(zone: ZoneState | null, cam: THREE.Vector3, time: number, dt: number): void {
    const rm = this.rainMat;
    if (!zone || zone.radius <= 0) {
      this.wall.visible = false;
      this.ring.visible = false;
      this.radius = -1;
      this.wet.value.w = 0;
      if (this.rain) this.rain.visible = false;
      return;
    }
    const k = this.radius < 0 ? 1 : 1 - Math.exp(-dt / SMOOTH_TAU);
    this.radius += (zone.radius - this.radius) * k;
    this.cx += (zone.center.x - this.cx) * k;
    this.cz += (zone.center.z - this.cz) * k;

    this.wall.visible = true;
    this.wall.position.set(this.cx, 0, this.cz);
    this.wall.scale.set(this.radius, 1, this.radius);
    this.pulse = Math.max(0, this.pulse - dt * 1.5);
    const u = this.wallMat.uniforms;
    u.uTime.value = time;
    u.uRadius.value = this.radius;
    u.uPulse.value = this.pulse;
    this.wet.value.set(this.cx, this.cz, this.radius, 1);

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

    if (this.rain && rm) {
      // Only draw when part of the camera's rain box is outside the circle.
      const dCam = Math.hypot(cam.x - this.cx, cam.z - this.cz);
      const anyOutside = dCam + RAIN_BOX * 0.71 > this.radius;
      this.rain.visible = anyOutside;
      if (anyOutside) {
        rm.uniforms.uCam.value.copy(cam);
        rm.uniforms.uTime.value = time;
        rm.uniforms.uZone.value.set(this.cx, this.cz, this.radius, 1);
        this.splashes(cam, dt);
      }
    }
  }

  /** Pooled splash pops on the floor or desk tops around the camera, outside the circle. */
  private splashes(cam: THREE.Vector3, dt: number): void {
    this.splashT += dt * SPLASH_RATE;
    let n = Math.min(4, Math.floor(this.splashT));
    this.splashT -= n;
    while (n-- > 0) {
      const a = this.rnd() * Math.PI * 2;
      const d = 3 + this.rnd() * 22;
      const x = cam.x + Math.cos(a) * d, z = cam.z + Math.sin(a) * d;
      if (Math.hypot(x - this.cx, z - this.cz) < this.radius + 1) continue;
      this.opts.splash(x, this.opts.topAt(x, z) + 0.03, z);
    }
  }

  private rnd(): number {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed / 2147483647;
  }

  dispose(): void {
    this.wall.geometry.dispose();
    this.wallMat.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.rain?.geometry.dispose();
    this.rainMat?.dispose();
    this.group.clear();
  }
}
