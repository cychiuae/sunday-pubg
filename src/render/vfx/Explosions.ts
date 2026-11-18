/**
 * Explosion ground effects (STYLE.md §15): a flat white shock ring that grows to the blast radius in 0.25 s and an
 * optional darker-sand disc that fades over 2 s (land only; no permanent scorch). Fixed pools of meshes, one draw
 * call per live effect, nothing allocated per blast. The particle part of the boom lives in Vfx. Owner:
 * graphics-engineer.
 */
import * as THREE from 'three';
import { palette } from '../procedural';

const POOL = 4;
export const SHOCK_RING_S = 0.25;
export const SAND_DISC_S = 2;

/**
 * Camera shake amount 0..1 for an explosion `localDistance` metres from the local eye: none when null or beyond
 * 2 x radius, quadratic falloff inside. Pure; exported for tests.
 */
export function explosionShake(localDistance: number | null, radius: number): number {
  if (localDistance === null || !Number.isFinite(localDistance) || radius <= 0) return 0;
  const k = 1 - localDistance / (2 * radius);
  return k <= 0 ? 0 : k >= 1 ? 1 : k * k;
}

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  life: number;
  radius: number;
}

export class ExplosionDecals {
  readonly group = new THREE.Group();
  private readonly rings: Slot[] = [];
  private readonly discs: Slot[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.86, 1, 48).rotateX(-Math.PI / 2);
  private readonly discGeo = new THREE.CircleGeometry(1, 28).rotateX(-Math.PI / 2);

  constructor() {
    this.group.name = 'vfx:explosionDecals';
    const mk = (geo: THREE.BufferGeometry, color: number, name: string, order: number): Slot => {
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, depthWrite: false, toneMapped: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      mat.name = name;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.visible = false;
      mesh.renderOrder = order;
      this.group.add(mesh);
      return { mesh, mat, age: 0, life: 0, radius: 1 };
    };
    for (let i = 0; i < POOL; i++) {
      this.rings.push(mk(this.ringGeo, 0xffffff, 'vfx:shockRing', 6));
      this.discs.push(mk(this.discGeo, palette.wetSand, 'vfx:sandDisc', 3));
    }
  }

  private take(pool: Slot[]): Slot {
    let best = pool[0];
    for (const s of pool) {
      if (!s.mesh.visible) return s;
      if (s.age / s.life > best.age / best.life) best = s;
    }
    return best;
  }

  spawn(x: number, groundY: number, z: number, radius: number, land: boolean): void {
    const r = this.take(this.rings);
    r.age = 0;
    r.life = SHOCK_RING_S;
    r.radius = radius;
    r.mesh.position.set(x, groundY + 0.08, z);
    r.mesh.scale.setScalar(radius * 0.15);
    r.mat.opacity = 0.9;
    r.mesh.visible = true;
    if (!land) return;
    const d = this.take(this.discs);
    d.age = 0;
    d.life = SAND_DISC_S;
    d.radius = radius * 0.32;
    d.mesh.position.set(x, groundY + 0.04, z);
    d.mesh.scale.setScalar(d.radius);
    d.mat.opacity = 0.55;
    d.mesh.visible = true;
  }

  update(dt: number): void {
    for (const r of this.rings) {
      if (!r.mesh.visible) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - t) * (1 - t);
      r.mesh.scale.setScalar(r.radius * (0.15 + 0.85 * e));
      r.mat.opacity = 0.9 * (1 - t);
    }
    for (const d of this.discs) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      const t = d.age / d.life;
      if (t >= 1) {
        d.mesh.visible = false;
        continue;
      }
      d.mat.opacity = 0.55 * (t < 0.5 ? 1 : 1 - (t - 0.5) / 0.5);
    }
  }

  clear(): void {
    for (const s of this.rings) s.mesh.visible = false;
    for (const s of this.discs) s.mesh.visible = false;
  }

  dispose(): void {
    this.ringGeo.dispose();
    this.discGeo.dispose();
    for (const s of [...this.rings, ...this.discs]) s.mat.dispose();
    this.group.clear();
  }
}
