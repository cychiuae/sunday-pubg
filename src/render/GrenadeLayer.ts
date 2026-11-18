/**
 * M2a grenades (STYLE.md §15): live grenades from FrameView.grenades (instanced pineapple at x1.5, tumbling, fuse
 * blink that speeds up near the explosion, fuse sparks, faint puff trail) and the local throw preview from
 * FrameView.grenadeArc (dotted arc + dashed blast ring draped on the terrain). Reads views only; never touches the
 * sim. Draw calls: 2 for all grenades (colour + hull, instanced), 2 for the ring while previewing; dots and blinks
 * go into the shared Markers batch. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { GrenadeArcView, GrenadeView } from '../shared/contracts';
import type { GrenadeId, Vec3 } from '../shared/types';
import { extractParts, makeInstancedMesh } from './instancing';
import { createGrenadeModel, GRENADE_DIMENSIONS, palette } from './procedural';
import { PARTICLE_SHAPE } from './shaders/particles';
import type { Markers } from './vfx/Markers';
import { linearRgb } from './vfx/Particles';

const CAPACITY = 32;
/** Arc dots (STYLE.md §15): every 0.35 m, r 0.04 m, shrinking toward the end. The first dot skips the hand. */
export const ARC_DOT_SPACING = 0.35;
export const ARC_DOT_START = 0.7;
const ARC_DOT_SIZE = 0.09;
const ARC_DOT_END_SIZE = 0.05;
const MAX_DOTS = 200;
/** Trail puffs every 0.25 m while moving faster than this (m/s). */
const TRAIL_SPACING = 0.25;
const TRAIL_MIN_SPEED = 1.5;
const SPARK_INTERVAL_S = 0.12;
const SPARK_INTERVAL_FAST_S = 0.06;
const RING_SEGMENTS = 64;
const RING_WIDTH = 0.16;
const RING_LIFT = 0.07;

/**
 * Fuse blink frequency (Hz) from the remaining fuse (ms): 2 Hz with 2.5 s or more left, rising linearly to 10 Hz
 * at 0. Pure; exported for tests.
 */
export function fuseBlinkHz(remainingMs: number): number {
  const k = Math.min(1, Math.max(0, remainingMs / 2500));
  return 10 - 8 * k;
}

/**
 * Resample a sampled arc (one point per sim tick) into evenly spaced dots: the first at `start` metres along the
 * path, then every `spacing` metres. Writes xyz triples into `out` and returns the dot count (<= maxDots and
 * <= out.length / 3). Allocation-free. Pure; exported for tests.
 */
export function resampleArc(points: readonly Vec3[], spacing: number, start: number, out: Float32Array, maxDots: number): number {
  const cap = Math.min(maxDots, Math.floor(out.length / 3));
  if (points.length < 2 || spacing <= 0 || cap <= 0) return 0;
  let n = 0;
  let next = Math.max(0, start);
  let walked = 0;
  for (let i = 1; i < points.length && n < cap; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) continue;
    while (next <= walked + len && n < cap) {
      const t = (next - walked) / len;
      out[n * 3] = a.x + dx * t;
      out[n * 3 + 1] = a.y + dy * t;
      out[n * 3 + 2] = a.z + dz * t;
      n++;
      next += spacing;
    }
    walked += len;
  }
  return n;
}

export interface GrenadeFx {
  fuseSpark(x: number, y: number, z: number): void;
  trailPuff(x: number, y: number, z: number): void;
}

interface GState {
  id: GrenadeId;
  seen: number;
  angle: number;
  ax: number;
  az: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  trail: number;
  blink: number;
  spark: number;
}

export class GrenadeLayer {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly locals: THREE.Matrix4[] = [];
  private readonly states = new Map<GrenadeId, GState>();
  private readonly statePool: GState[] = [];
  private readonly removeList: GrenadeId[] = [];
  /** Recently exploded ids: hidden even if a frame still lists them (explosion event and snapshot race). */
  private readonly exploded = new Int32Array(16).fill(-1);
  private explodedIdx = 0;
  private frame = 0;
  // Arc preview
  private readonly dots = new Float32Array(MAX_DOTS * 3);
  private readonly ring: THREE.Mesh;
  private readonly ringPos: THREE.BufferAttribute;
  private readonly inner: THREE.Mesh;
  // scratch
  private readonly m = new THREE.Matrix4();
  private readonly mOut = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly pos = new THREE.Vector3();
  private readonly cream = linearRgb(0xfff3d6);
  private readonly blinkRed = linearRgb(palette.danger);
  private readonly blinkHot = linearRgb(palette.flowerCenter);
  private readonly flightScale = GRENADE_DIMENSIONS.flightScale;

  constructor(
    private readonly markers: Markers,
    private readonly fx: GrenadeFx,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    this.group.name = 'grenades';
    const template = createGrenadeModel({ pin: false });
    for (const part of extractParts(template)) {
      const mesh = makeInstancedMesh(part, CAPACITY, `grenade:${part.name}`);
      mesh.count = 0;
      mesh.visible = false;
      this.meshes.push(mesh);
      this.locals.push(part.matrix);
      this.group.add(mesh);
    }
    this.scale.setScalar(this.flightScale);

    // Dashed blast ring, draped on the terrain each frame (inner/outer vertex per sample).
    const geo = new THREE.BufferGeometry();
    this.ringPos = new THREE.BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.ringPos);
    const idx: number[] = [];
    for (let j = 0; j < RING_SEGMENTS; j++) {
      if (((j >> 1) & 1) === 1) continue; // dash 2 segments, gap 2
      const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const ringMat = new THREE.MeshBasicMaterial({
      color: palette.danger, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    ringMat.name = 'grenade:arcRing';
    this.ring = new THREE.Mesh(geo, ringMat);
    this.ring.name = 'grenade:arcRing';
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 5;
    this.ring.visible = false;
    const innerMat = new THREE.MeshBasicMaterial({
      color: palette.danger, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    innerMat.name = 'grenade:arcInner';
    this.inner = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.4, 20).rotateX(-Math.PI / 2), innerMat);
    this.inner.name = 'grenade:arcInner';
    this.inner.renderOrder = 5;
    this.inner.visible = false;
    this.group.add(this.ring, this.inner);
  }

  /** explosion event: stop drawing this grenade immediately. */
  onExploded(id: GrenadeId): void {
    this.exploded[this.explodedIdx] = id;
    this.explodedIdx = (this.explodedIdx + 1) % this.exploded.length;
  }

  private isExploded(id: GrenadeId): boolean {
    for (let i = 0; i < this.exploded.length; i++) if (this.exploded[i] === id) return true;
    return false;
  }

  private stateFor(g: GrenadeView): GState {
    let s = this.states.get(g.id);
    if (!s) {
      s = this.statePool.pop() ?? { id: 0, seen: 0, angle: 0, ax: 1, az: 0, lastX: 0, lastY: 0, lastZ: 0, trail: 0, blink: 0, spark: 0 };
      s.id = g.id;
      s.angle = (g.id * 1.37) % 6.28;
      s.ax = 1;
      s.az = 0;
      s.lastX = g.pos.x;
      s.lastY = g.pos.y;
      s.lastZ = g.pos.z;
      s.trail = 0;
      s.blink = 0;
      s.spark = 0;
      this.states.set(g.id, s);
    }
    return s;
  }

  update(grenades: readonly GrenadeView[] | undefined, arc: GrenadeArcView | null | undefined, serverTime: number, dt: number, time: number): void {
    this.frame++;
    let n = 0;
    const list = grenades ?? EMPTY;
    for (let i = 0; i < list.length && n < CAPACITY; i++) {
      const g = list[i];
      if (this.isExploded(g.id)) continue;
      const s = this.stateFor(g);
      s.seen = this.frame;
      const vx = g.vel.x, vy = g.vel.y, vz = g.vel.z;
      const speed = Math.hypot(vx, vy, vz);
      const hs = Math.hypot(vx, vz);
      if (!g.resting && speed > 0.05) {
        // Tumble about the horizontal axis perpendicular to the motion (forward roll), rate ~ speed.
        if (hs > 0.05) {
          s.ax = vz / hs;
          s.az = -vx / hs;
        }
        s.angle -= (speed / 0.12) * dt * 0.35;
      }
      this.axis.set(s.ax, 0, s.az);
      this.q.setFromAxisAngle(this.axis, s.angle);
      this.pos.set(g.pos.x, g.pos.y, g.pos.z);
      this.m.compose(this.pos, this.q, this.scale);
      for (let k = 0; k < this.meshes.length; k++) {
        this.mOut.multiplyMatrices(this.m, this.locals[k]);
        this.mOut.toArray(this.meshes[k].instanceMatrix.array as Float32Array, n * 16);
      }
      n++;

      // Fuse point (top of the cap) in world space.
      this.v.set(0, GRENADE_DIMENSIONS.fuseY * this.flightScale, 0).applyQuaternion(this.q);
      const fx = g.pos.x + this.v.x, fy = g.pos.y + this.v.y, fz = g.pos.z + this.v.z;
      const remaining = g.explodesAt - serverTime;
      s.blink += fuseBlinkHz(remaining) * dt;
      if (s.blink - Math.floor(s.blink) < 0.5) {
        const hot = remaining < 1000;
        const c = hot ? this.blinkRed : this.blinkHot;
        this.markers.add(fx, fy, fz, hot ? 0.3 : 0.22, c[0], c[1], c[2], 1, PARTICLE_SHAPE.flash, time * 3);
      }
      s.spark -= dt;
      if (s.spark <= 0) {
        s.spark = remaining <= 1000 ? SPARK_INTERVAL_FAST_S : SPARK_INTERVAL_S;
        this.fx.fuseSpark(fx, fy, fz);
      }
      // Faint puff trail while flying.
      if (speed > TRAIL_MIN_SPEED) {
        s.trail += Math.hypot(g.pos.x - s.lastX, g.pos.y - s.lastY, g.pos.z - s.lastZ);
        if (s.trail > 4) s.trail = TRAIL_SPACING; // snapshot jump: do not spray a burst
        while (s.trail >= TRAIL_SPACING) {
          s.trail -= TRAIL_SPACING;
          this.fx.trailPuff(g.pos.x, g.pos.y, g.pos.z);
        }
      } else {
        s.trail = 0;
      }
      s.lastX = g.pos.x;
      s.lastY = g.pos.y;
      s.lastZ = g.pos.z;
    }
    for (let k = 0; k < this.meshes.length; k++) {
      const mesh = this.meshes[k];
      mesh.count = n;
      mesh.visible = n > 0;
      if (n > 0) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.removeList.length = 0;
    for (const s of this.states.values()) if (s.seen !== this.frame) this.removeList.push(s.id);
    for (const id of this.removeList) {
      const s = this.states.get(id)!;
      this.states.delete(id);
      this.statePool.push(s);
    }

    this.updateArc(arc ?? null);
  }

  private updateArc(arc: GrenadeArcView | null): void {
    if (!arc || arc.points.length < 2) {
      this.ring.visible = false;
      this.inner.visible = false;
      return;
    }
    const n = resampleArc(arc.points, ARC_DOT_SPACING, ARC_DOT_START, this.dots, MAX_DOTS);
    const c = this.cream;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const size = ARC_DOT_SIZE + (ARC_DOT_END_SIZE - ARC_DOT_SIZE) * t;
      this.markers.add(this.dots[i * 3], this.dots[i * 3 + 1], this.dots[i * 3 + 2], size, c[0], c[1], c[2], 1, PARTICLE_SHAPE.puff);
    }
    // Blast ring at the end, draped over max(terrain, sea).
    const e = arc.end;
    const R = Math.max(0.5, arc.radius);
    const P = this.ringPos.array as Float32Array;
    for (let j = 0; j <= RING_SEGMENTS; j++) {
      const a = (j / RING_SEGMENTS) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let side = 0; side < 2; side++) {
        const r = side === 0 ? R - RING_WIDTH : R;
        const x = e.x + ca * r, z = e.z + sa * r;
        const h = Math.max(this.heightAt(x, z), 0) + RING_LIFT;
        const o = (j * 2 + side) * 3;
        P[o] = x;
        P[o + 1] = h;
        P[o + 2] = z;
      }
    }
    this.ringPos.needsUpdate = true;
    this.ring.visible = true;
    this.inner.position.set(e.x, Math.max(this.heightAt(e.x, e.z), 0, e.y - 0.1) + RING_LIFT, e.z);
    this.inner.visible = true;
  }

  clear(): void {
    for (const s of this.states.values()) this.statePool.push(s);
    this.states.clear();
    for (const m of this.meshes) {
      m.count = 0;
      m.visible = false;
    }
    this.ring.visible = false;
    this.inner.visible = false;
  }

  dispose(): void {
    for (const m of this.meshes) m.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    this.inner.geometry.dispose();
    (this.inner.material as THREE.Material).dispose();
    this.group.clear();
  }
}

const EMPTY: readonly GrenadeView[] = [];
