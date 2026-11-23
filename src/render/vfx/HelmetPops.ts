/**
 * Helmet knock-off: when a head hit breaks a helmet (playerDamaged helmet.broken), a copy of the helmet model leaves
 * the head, flies away from the shooter with a tumble, bounces on the ground, rests a moment, then shrinks into a
 * puff. Render-only (no sim state); pooled per tier. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { createHelmetModel } from '../procedural';
import type { Vec3 } from '../../shared/types';

/** Launch speed away from the shooter (m/s, horizontal) and upward. */
const POP_SPEED_H = 3.2;
const POP_SPEED_UP = 4.6;
/** Tumble rate (rad/s) about the axis perpendicular to the flight direction (front edge flips up and back). */
const POP_SPIN = 13;
const GRAVITY = 16;
/** Vertical bounce restitution, horizontal speed kept per bounce, and spin kept per bounce. */
const BOUNCE = 0.38;
const BOUNCE_FRICTION = 0.55;
const BOUNCE_SPIN = 0.5;
/** Lifetime (s): the last SHRINK_S of it the helmet scales to 0, then the onDone puff fires. */
const LIFE_S = 2.2;
const SHRINK_S = 0.3;
/** Helmet half-height above its pivot when resting (m, approx.), so it sits on the ground instead of in it. */
const REST_LIFT = 0.12;
const MAX_POPS = 8;

/** One flying helmet (exported for tests). */
export interface HelmetPop {
  obj: THREE.Object3D;
  tier: number;
  age: number;
  vel: THREE.Vector3;
  /** World-space spin axis (unit) and rate (rad/s). */
  axis: THREE.Vector3;
  spin: number;
  floorY: number;
  baseScale: number;
  done: boolean;
}

const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

/**
 * Initial velocity and spin axis for a pop at `head` hit from `source` (pure; exported for tests). The horizontal
 * direction points from the shooter to the victim; a shot from straight above (or no source) flies off the back of a
 * character with yaw `fallbackYaw` (characters face -Z, so the back is (sin yaw, cos yaw)).
 */
export function popLaunch(head: Vec3, source: Vec3, fallbackYaw: number, vel: THREE.Vector3, axis: THREE.Vector3): void {
  let dx = head.x - source.x, dz = head.z - source.z;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) {
    dx = Math.sin(fallbackYaw);
    dz = Math.cos(fallbackYaw);
  } else {
    dx /= l;
    dz /= l;
  }
  vel.set(dx * POP_SPEED_H, POP_SPEED_UP, dz * POP_SPEED_H);
  // Up x dir: rotating about it tips the helmet's top along the flight direction (a backflip off the head).
  axis.set(dz, 0, -dx);
}

/** Advance one pop by dt (pure apart from the object's transform; exported for tests). Returns false once finished. */
export function stepPop(p: HelmetPop, dt: number): boolean {
  if (p.done) return false;
  p.age += dt;
  const o = p.obj;
  p.vel.y -= GRAVITY * dt;
  o.position.addScaledVector(p.vel, dt);
  const floor = p.floorY + REST_LIFT;
  if (o.position.y < floor) {
    o.position.y = floor;
    if (p.vel.y < 0) {
      p.vel.y = -p.vel.y * BOUNCE;
      if (p.vel.y < 0.6) p.vel.y = 0;
      p.vel.x *= BOUNCE_FRICTION;
      p.vel.z *= BOUNCE_FRICTION;
      p.spin *= BOUNCE_SPIN;
    }
  }
  if (p.spin > 0.05) {
    _q.setFromAxisAngle(p.axis, p.spin * dt);
    o.quaternion.premultiply(_q);
  }
  const left = LIFE_S - p.age;
  if (left <= 0) {
    p.done = true;
    o.visible = false;
    return false;
  }
  const k = left < SHRINK_S ? left / SHRINK_S : 1;
  o.scale.setScalar(p.baseScale * k);
  return true;
}

export class HelmetPops {
  readonly group = new THREE.Group();
  private readonly live: HelmetPop[] = [];
  private readonly free = new Map<number, THREE.Object3D[]>();
  private readonly pos = new THREE.Vector3();

  constructor(private readonly onDone: (x: number, y: number, z: number) => void) {
    this.group.name = 'helmetPops';
  }

  /**
   * Launch a tier-`tier` helmet from the head pivot's world matrix (`headMatrix` = CharacterModel.head.matrixWorld,
   * the helmet's own attach frame), away from `source`. `floorY` is where it lands (the victim's feet).
   */
  spawn(tier: number, headMatrix: THREE.Matrix4, source: Vec3, floorY: number, fallbackYaw: number, showOutline: boolean): void {
    if (this.live.length >= MAX_POPS) this.finish(this.live[0]);
    const obj = this.take(tier);
    headMatrix.decompose(obj.position, obj.quaternion, _s);
    obj.scale.copy(_s);
    obj.visible = true;
    obj.traverse((c) => {
      if (c.name === 'outline') c.visible = showOutline;
    });
    const pop: HelmetPop = {
      obj, tier, age: 0, vel: new THREE.Vector3(), axis: new THREE.Vector3(), spin: POP_SPIN,
      floorY, baseScale: (_s.x + _s.y + _s.z) / 3, done: false,
    };
    // Launch from the top of the head (head centre is 0.25 m above the neck pivot).
    this.pos.set(0, 0.25, 0).applyMatrix4(headMatrix);
    popLaunch(this.pos, source, fallbackYaw, pop.vel, pop.axis);
    this.group.add(obj);
    this.live.push(pop);
  }

  get count(): number {
    return this.live.length;
  }

  update(dt: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!stepPop(p, dt)) {
        const o = p.obj.position;
        this.onDone(o.x, o.y, o.z);
        this.recycle(i);
      }
    }
  }

  clear(): void {
    while (this.live.length) this.recycle(this.live.length - 1);
  }

  dispose(): void {
    this.clear();
    this.free.clear();
    this.group.clear();
  }

  private finish(p: HelmetPop): void {
    const i = this.live.indexOf(p);
    if (i >= 0) this.recycle(i);
  }

  private recycle(i: number): void {
    const p = this.live[i];
    this.live.splice(i, 1);
    p.obj.visible = false;
    this.group.remove(p.obj);
    let list = this.free.get(p.tier);
    if (!list) this.free.set(p.tier, (list = []));
    list.push(p.obj);
  }

  private take(tier: number): THREE.Object3D {
    const o = this.free.get(tier)?.pop();
    return o ?? createHelmetModel(tier);
  }
}
