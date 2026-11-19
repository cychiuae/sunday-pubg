/**
 * M2c rockets in flight (art M2c §3, ADR 0007 §4). Owner: graphics-engineer.
 *
 * Input: `FrameView.rockets` (RocketView: position from `rocketPosAt` at the frame's server time; ClientGame computes it,
 * there is no per-tick rocket sync). Every live rocket is one instance in the shared item `ModelBatch` (0 extra draw
 * calls), nose along the velocity, rolling about its axis at ROCKET_DIMENSIONS.rollRate. The exhaust flame, the cream
 * trail puffs (every 0.35 m) and the spark stars (every 0.7 m) go through the pooled particles (0 extra calls).
 * Launch flash, back-blast and the explosion variants are event VFX (Vfx.ts).
 */
import * as THREE from 'three';
import type { RocketView } from '../shared/contracts';
import type { ModelBatch, ModelHandle } from './ModelBatch';
import { createRocketModel, ROCKET_DIMENSIONS } from './procedural';

/** Trail emission spacing (m), art M2c §3. */
export const ROCKET_PUFF_EVERY = 0.35;
export const ROCKET_SPARK_EVERY = 0.7;
/** Cap per rocket (puffs alive at once ~ 0.7 s of flight). */
const MAX_PUFFS_PER_FRAME = 8;
const KEY = 'rocket';

export interface RocketFx {
  rocketFlame(x: number, y: number, z: number, flicker: number): void;
  rocketPuff(x: number, y: number, z: number): void;
  rocketSpark(x: number, y: number, z: number): void;
}

interface Slot {
  handle: ModelHandle;
  seen: number;
  /** Nozzle position at the last emission check, and the distance since the last puff / spark. */
  lx: number;
  ly: number;
  lz: number;
  puffD: number;
  sparkD: number;
  init: boolean;
}

/** Rocket orientation: the model's nose (-Z) along `vel`, rolled by `roll` about it. Pure; exported for tests. */
export function rocketQuaternion(vel: { x: number; y: number; z: number }, roll: number, out = new THREE.Quaternion()): THREE.Quaternion {
  const l = Math.hypot(vel.x, vel.y, vel.z);
  if (l < 1e-6) return out.identity();
  _dir.set(-vel.x / l, -vel.y / l, -vel.z / l); // model +Z points backwards
  out.setFromUnitVectors(_z, _dir);
  _qr.setFromAxisAngle(_z, roll);
  return out.multiply(_qr);
}

const _z = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _qr = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _noz = new THREE.Vector3();

export class RocketLayer {
  private readonly slots = new Map<number, Slot>();
  private frame = 0;

  constructor(
    private readonly items: ModelBatch,
    private readonly fx: RocketFx,
  ) {
    items.register(KEY, () => createRocketModel());
  }

  get liveCount(): number {
    return this.slots.size;
  }

  update(rockets: readonly RocketView[], time: number, reducedMotion: boolean): void {
    const frame = ++this.frame;
    for (let i = 0; i < rockets.length; i++) {
      const r = rockets[i];
      let s = this.slots.get(r.id);
      if (!s) {
        s = { handle: this.items.acquire(KEY), seen: 0, lx: 0, ly: 0, lz: 0, puffD: 0, sparkD: 0, init: false };
        this.slots.set(r.id, s);
      }
      s.seen = frame;
      const roll = reducedMotion ? 0 : (time * ROCKET_DIMENSIONS.rollRate + r.id) % (Math.PI * 2);
      rocketQuaternion(r.vel, roll, _q);
      _m.compose(_p.set(r.pos.x, r.pos.y, r.pos.z), _q, _one);
      this.items.setMatrix(s.handle, _m);
      this.items.setVisible(s.handle, true);

      // Nozzle in world space; flame every frame, puffs / sparks by distance travelled.
      _noz.set(ROCKET_DIMENSIONS.nozzle[0], ROCKET_DIMENSIONS.nozzle[1], ROCKET_DIMENSIONS.nozzle[2]).applyQuaternion(_q);
      const nx = r.pos.x + _noz.x, ny = r.pos.y + _noz.y, nz = r.pos.z + _noz.z;
      const flicker = reducedMotion ? 1 : 1 + 0.15 * Math.sin(time * 188 + r.id);
      this.fx.rocketFlame(nx, ny, nz, flicker);
      if (!s.init) {
        s.lx = nx; s.ly = ny; s.lz = nz;
        s.init = true;
        continue;
      }
      const dx = nx - s.lx, dy = ny - s.ly, dz = nz - s.lz;
      const d = Math.hypot(dx, dy, dz);
      if (d > 0 && d < 50) {
        // Emit along the segment travelled this frame so the spacing is even at any frame rate.
        let emitted = 0;
        let t = ROCKET_PUFF_EVERY - s.puffD;
        while (t <= d && emitted < MAX_PUFFS_PER_FRAME) {
          const k = t / d;
          this.fx.rocketPuff(s.lx + dx * k, s.ly + dy * k, s.lz + dz * k);
          t += ROCKET_PUFF_EVERY;
          emitted++;
        }
        s.puffD = (s.puffD + d) % ROCKET_PUFF_EVERY;
        s.sparkD += d;
        if (s.sparkD >= ROCKET_SPARK_EVERY - 1e-6) {
          s.sparkD = Math.max(0, s.sparkD - ROCKET_SPARK_EVERY) % ROCKET_SPARK_EVERY;
          this.fx.rocketSpark(nx, ny, nz);
        }
      }
      s.lx = nx; s.ly = ny; s.lz = nz;
    }
    if (this.slots.size > 0) {
      for (const [id, s] of this.slots) {
        if (s.seen === frame) continue;
        this.items.release(s.handle);
        this.slots.delete(id);
      }
    }
  }

  clear(): void {
    for (const s of this.slots.values()) this.items.release(s.handle);
    this.slots.clear();
  }

  dispose(): void {
    this.clear();
  }
}
