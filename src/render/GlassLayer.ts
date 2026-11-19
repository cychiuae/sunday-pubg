/**
 * M2c breakable office glass (art M2c §5.2, ADR 0007 §7). Owner: graphics-engineer.
 *
 * - The merged glass and frost meshes carry a per-vertex `paneId` (glassPanes(map) ids: glass walls, then glass kit
 *   parts); a 1-row R8 mask texture marks the broken panes and the vertex shader collapses their triangles. The merged
 *   glass stays 1 call (+ frost 1).
 * - One dynamic debris mesh (+1 call while any pane is broken): 8 jagged teeth along the frame edges of every broken
 *   pane and 12 flat glints of floor litter under it, kept for the rest of the match (cap 12 panes x 14 litter).
 * - Which panes are broken comes from `FrameView.brokenPanes` (grows only); the burst is event VFX (`glassBroken`).
 */
import * as THREE from 'three';
import { glassPanes, wallFrame } from '../shared/maps';
import type { IndoorMapData, KitCollider } from '../shared/types';
import { PANE_ID_ATTR } from './mergeBuilder';

/** A pane as a vertical rectangle: centre, unit horizontal axis along it, half length, bottom and top. */
export interface PaneRect {
  id: number;
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  half: number;
  bottom: number;
  top: number;
}

/** Pane tint and glint (art §5.2). */
const PANE_TINT = 0xbfe6f0;
const TEETH_PER_PANE = 8;
const LITTER_PER_PANE = 12;
const MAX_DEBRIS_PANES = 12;

type GlassBox = Extract<KitCollider, { type: 'box' }>;

/** Placement transform T * Ry * S (the sim's and the renderer's convention). */
function place(p: { x: number; y: number; z: number; rotY: number; scale: number }, lx: number, ly: number, lz: number): [number, number, number] {
  const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
  return [p.x + (c * lx + s * lz) * p.scale, p.y + ly * p.scale, p.z + (-s * lx + c * lz) * p.scale];
}

/**
 * Pane rectangles and lookups for a map: `wallPane` (wall index -> pane id) and `propPane(propIndex)` (a function from
 * a prop-local triangle centroid to the pane id of the nearest glass box, or -1). Pure; exported for tests.
 */
export function paneLayout(map: IndoorMapData): {
  rects: PaneRect[];
  wallPane: Map<number, number>;
  propPane: Map<number, (cx: number, cy: number, cz: number) => number>;
} {
  const rects: PaneRect[] = [];
  const wallPane = new Map<number, number>();
  const boxes = new Map<number, { id: number; box: GlassBox }[]>();
  for (const pane of glassPanes(map)) {
    if ('wall' in pane) {
      const w = map.walls[pane.wall];
      const f = wallFrame(w);
      const L = Math.max(1e-6, f.halfLength * 2);
      rects.push({ id: pane.id, cx: f.cx, cz: f.cz, ux: (w.x2 - w.x1) / L, uz: (w.z2 - w.z1) / L, half: f.halfLength, bottom: w.bottom, top: w.top });
      wallPane.set(pane.wall, pane.id);
    } else {
      const p = map.props[pane.prop];
      const box = map.kit[p.kind].colliders[pane.part] as GlassBox;
      let list = boxes.get(pane.prop);
      if (!list) boxes.set(pane.prop, (list = []));
      list.push({ id: pane.id, box });
      const wideX = box.max[0] - box.min[0] >= box.max[2] - box.min[2];
      const mx = (box.min[0] + box.max[0]) / 2, mz = (box.min[2] + box.max[2]) / 2;
      const a = place(p, wideX ? box.min[0] : mx, box.min[1], wideX ? mz : box.min[2]);
      const b = place(p, wideX ? box.max[0] : mx, box.max[1], wideX ? mz : box.max[2]);
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const L = Math.max(1e-6, Math.hypot(dx, dz));
      rects.push({ id: pane.id, cx: (a[0] + b[0]) / 2, cz: (a[2] + b[2]) / 2, ux: dx / L, uz: dz / L, half: L / 2, bottom: Math.min(a[1], b[1]), top: Math.max(a[1], b[1]) });
    }
  }
  const propPane = new Map<number, (cx: number, cy: number, cz: number) => number>();
  for (const [prop, list] of boxes) {
    propPane.set(prop, (cx, cy, cz) => {
      let best = -1, bestD = Infinity;
      for (const { id, box } of list) {
        const dx = Math.max(box.min[0] - cx, 0, cx - box.max[0]);
        const dy = Math.max(box.min[1] - cy, 0, cy - box.max[1]);
        const dz = Math.max(box.min[2] - cz, 0, cz - box.max[2]);
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
      return best;
    });
  }
  rects.sort((a, b) => a.id - b.id);
  return { rects, wallPane, propPane };
}

/** 1-row R8 texture: 255 = broken. */
export class PaneMask {
  readonly texture: THREE.DataTexture;
  private readonly data: Uint8Array;
  readonly uniform: { value: THREE.Texture };
  private count = 0;

  constructor(paneCount: number) {
    const w = Math.max(1, paneCount);
    this.data = new Uint8Array(w);
    this.texture = new THREE.DataTexture(this.data, w, 1, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.name = 'office:paneMask';
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.uniform = { value: this.texture };
  }

  /** Apply the broken list (ascending, grows only). Returns the ids newly broken since the last call. */
  set(broken: readonly number[], out: number[] = []): number[] {
    out.length = 0;
    if (broken.length === this.count) return out;
    for (const id of broken) {
      if (id >= 0 && id < this.data.length && this.data[id] === 0) {
        this.data[id] = 255;
        out.push(id);
      }
    }
    // A shorter list = a new match on the same scene: clear and re-apply.
    if (broken.length < this.count) {
      this.data.fill(0);
      for (const id of broken) if (id >= 0 && id < this.data.length) this.data[id] = 255;
    }
    this.count = broken.length;
    this.texture.needsUpdate = true;
    return out;
  }

  isBroken(id: number): boolean {
    return this.data[id] === 255;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Patch a material in place (chained with its existing onBeforeCompile) so triangles of broken panes collapse.
 * The geometry must carry `paneId` (MergeBucket tag); untagged triangles (-1) are never hidden.
 */
export function patchPaneMask<M extends THREE.Material>(mat: M, mask: { value: THREE.Texture }, key: string): M {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, r) => {
    prev.call(mat, shader, r);
    shader.uniforms.uPaneMask = mask;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float ${PANE_ID_ATTR};\nuniform sampler2D uPaneMask;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        if ( ${PANE_ID_ATTR} >= 0.0 && texelFetch( uPaneMask, ivec2( int( ${PANE_ID_ATTR} ), 0 ), 0 ).r > 0.5 ) transformed = vec3( 0.0 );`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey}|paneMask:${key}`;
  return mat;
}

/** Deterministic 0..1 noise per (pane, k). */
const hash = (a: number, b: number): number => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Debris triangles for broken panes: teeth on the frame edges (pointing inward) and flat floor litter on both sides.
 * Writes positions into `out` (non-indexed, xyz per vertex); returns the vertex count. Pure; exported for tests.
 */
export function buildDebris(rects: readonly PaneRect[], broken: readonly number[], floorY: number, out: Float32Array): number {
  let v = 0;
  const push = (x: number, y: number, z: number) => {
    if (v * 3 + 2 >= out.length) return;
    out[v * 3] = x; out[v * 3 + 1] = y; out[v * 3 + 2] = z;
    v++;
  };
  let n = 0;
  for (const id of broken) {
    if (n++ >= MAX_DEBRIS_PANES) break;
    const r = rects.find((q) => q.id === id);
    if (!r) continue;
    const h = r.top - r.bottom;
    // Teeth: half on the bottom edge pointing up, half on the top edge pointing down.
    for (let k = 0; k < TEETH_PER_PANE; k++) {
      const bottom = k < TEETH_PER_PANE / 2;
      const s = ((k % (TEETH_PER_PANE / 2)) + 0.5) / (TEETH_PER_PANE / 2) * 2 - 1;
      const along = s * r.half * 0.9 + (hash(id, k) - 0.5) * r.half * 0.2;
      const w = r.half * (0.12 + 0.1 * hash(id, k + 9));
      const len = h * (0.08 + 0.12 * hash(id, k + 17));
      const y0 = bottom ? r.bottom : r.top;
      const tipY = bottom ? y0 + len : y0 - len;
      const ax = r.cx + r.ux * (along - w), az = r.cz + r.uz * (along - w);
      const bx = r.cx + r.ux * (along + w), bz = r.cz + r.uz * (along + w);
      const tx = r.cx + r.ux * (along + (hash(id, k + 3) - 0.5) * w), tz = r.cz + r.uz * (along + (hash(id, k + 3) - 0.5) * w);
      push(ax, y0, az); push(bx, y0, bz); push(tx, tipY, tz);
    }
    // Litter: flat glints on the floor on both sides of the opening.
    const nx = -r.uz, nz = r.ux;
    for (let k = 0; k < LITTER_PER_PANE; k++) {
      const side = k % 2 ? 1 : -1;
      const along = (hash(id, k + 31) * 2 - 1) * r.half * 0.9;
      const off = side * (0.4 + 2.6 * hash(id, k + 47));
      const cx = r.cx + r.ux * along + nx * off, cz = r.cz + r.uz * along + nz * off;
      const sz = 0.4 + 0.5 * hash(id, k + 53);
      const a = hash(id, k + 61) * Math.PI * 2;
      const y = floorY + 0.03;
      for (let t = 0; t < 3; t++) {
        const aa = a + (t * Math.PI * 2) / 3 + (hash(id, k * 3 + t) - 0.5) * 0.8;
        push(cx + Math.cos(aa) * sz * 0.5, y, cz + Math.sin(aa) * sz * 0.5);
      }
    }
  }
  return v;
}

/** The dynamic debris mesh (teeth + litter), rebuilt when the broken set grows. */
export class GlassDebris {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshBasicMaterial;

  constructor() {
    const cap = MAX_DEBRIS_PANES * (TEETH_PER_PANE + LITTER_PER_PANE) * 3;
    this.pos = new Float32Array(cap * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    this.geo.name = 'office:glassDebris';
    this.mat = new THREE.MeshBasicMaterial({ color: PANE_TINT, side: THREE.DoubleSide, transparent: true, opacity: 0.8, depthWrite: false });
    this.mat.name = 'office:glassDebris';
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'office:glassDebris';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
  }

  rebuild(rects: readonly PaneRect[], broken: readonly number[], floorY: number): void {
    const n = buildDebris(rects, broken, floorY, this.pos);
    this.geo.setDrawRange(0, n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}
