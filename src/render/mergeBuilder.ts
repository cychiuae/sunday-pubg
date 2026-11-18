/**
 * Static geometry merging for the indoor scene (M2b). Owner: graphics-engineer.
 *
 * Collects (non-indexed procedural geometry, world matrix) pairs and bakes them into ONE BufferGeometry: positions by
 * the matrix, `normal` and the outline hull's `outlineNormal` by its normal matrix, `color` copied, and an optional
 * per-vertex `outlineWidth` (so hulls of different outline classes share one draw call). Office props never move, so
 * merging them per spatial chunk replaces ~80 instanced draw calls with ~2 per visible chunk. Two passes (count, then
 * fill), no intermediate arrays.
 */
import * as THREE from 'three';
import { OUTLINE_NORMAL_ATTR } from './procedural';
import { OUTLINE_WIDTH_ATTR } from './indoorFx';

interface Entry {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  width: number;
}

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

export class MergeBucket {
  private readonly entries: Entry[] = [];
  private vertexCount = 0;

  /** @param hull outline hull bucket: writes `outlineNormal` + `outlineWidth` (no colour). */
  constructor(readonly hull = false) {}

  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, width = 0): void {
    const pos = geo.getAttribute('position');
    if (!pos || pos.count === 0) return;
    if (geo.index) throw new Error('MergeBucket expects non-indexed geometry');
    this.entries.push({ geo, matrix, width });
    this.vertexCount += pos.count;
  }

  get isEmpty(): boolean {
    return this.vertexCount === 0;
  }

  get triangles(): number {
    return this.vertexCount / 3;
  }

  /** Bake into a new geometry (caller owns and disposes it). Null when empty. */
  build(name: string): THREE.BufferGeometry | null {
    if (this.vertexCount === 0) return null;
    const n = this.vertexCount;
    const pos = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const col = this.hull ? null : new Float32Array(n * 3);
    const oln = this.hull ? new Float32Array(n * 3) : null;
    const olw = this.hull ? new Float32Array(n) : null;
    let o = 0;
    for (const e of this.entries) {
      const P = e.geo.getAttribute('position');
      const N = e.geo.getAttribute('normal') as THREE.BufferAttribute | undefined;
      const C = e.geo.getAttribute('color') as THREE.BufferAttribute | undefined;
      const H = e.geo.getAttribute(OUTLINE_NORMAL_ATTR) as THREE.BufferAttribute | undefined;
      _n.getNormalMatrix(e.matrix);
      for (let i = 0; i < P.count; i++, o++) {
        _v.fromBufferAttribute(P, i).applyMatrix4(e.matrix);
        pos[o * 3] = _v.x; pos[o * 3 + 1] = _v.y; pos[o * 3 + 2] = _v.z;
        if (N) {
          _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize();
          nrm[o * 3] = _v.x; nrm[o * 3 + 1] = _v.y; nrm[o * 3 + 2] = _v.z;
        } else {
          nrm[o * 3 + 1] = 1;
        }
        if (col) {
          if (C) {
            col[o * 3] = C.getX(i); col[o * 3 + 1] = C.getY(i); col[o * 3 + 2] = C.getZ(i);
          } else {
            col[o * 3] = 1; col[o * 3 + 1] = 1; col[o * 3 + 2] = 1;
          }
        }
        if (oln && olw) {
          if (H) _v.fromBufferAttribute(H, i).applyMatrix3(_n).normalize();
          else if (N) _v.fromBufferAttribute(N, i).applyMatrix3(_n).normalize();
          else _v.set(0, 1, 0);
          oln[o * 3] = _v.x; oln[o * 3 + 1] = _v.y; oln[o * 3 + 2] = _v.z;
          olw[o] = e.width;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.name = name;
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (oln && olw) {
      g.setAttribute(OUTLINE_NORMAL_ATTR, new THREE.BufferAttribute(oln, 3));
      g.setAttribute(OUTLINE_WIDTH_ATTR, new THREE.BufferAttribute(olw, 1));
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}
