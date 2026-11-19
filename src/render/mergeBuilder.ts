/**
 * Static geometry merging (M2b office; M2c island chunks and model batches). Owner: graphics-engineer.
 *
 * Collects (non-indexed procedural geometry, world matrix) pairs and bakes them into ONE BufferGeometry: positions by
 * the matrix, `normal` and the outline hull's `outlineNormal` by its normal matrix, `color` copied, and an optional
 * per-vertex `outlineWidth` (so hulls of different outline classes share one draw call). Office props never move, so
 * merging them per spatial chunk replaces ~80 instanced draw calls with ~2 per visible chunk. Two passes (count, then
 * fill), no intermediate arrays.
 */
import * as THREE from 'three';
import { OUTLINE, OUTLINE_NORMAL_ATTR, palette } from './procedural';
import { OUTLINE_WIDTH_ATTR } from './indoorFx';

/** Per-triangle id (e.g. the glass pane id) from the triangle centroid in the geometry's local space; -1 = none. */
export type TriangleTag = number | ((cx: number, cy: number, cz: number) => number);

interface Entry {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  width: number;
  tag: TriangleTag;
}

/** Name of the optional per-vertex tag attribute (M2c: glass pane id for the broken mask). */
export const PANE_ID_ATTR = 'paneId';

const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();

export class MergeBucket {
  private readonly entries: Entry[] = [];
  private vertexCount = 0;

  private tagged = false;

  /** @param hull outline hull bucket: writes `outlineNormal` + `outlineWidth` (no colour). */
  constructor(readonly hull = false) {}

  /** `tag`: M2c per-triangle id written to the `paneId` attribute (any tagged entry adds it to the whole bucket). */
  add(geo: THREE.BufferGeometry, matrix: THREE.Matrix4, width = 0, tag: TriangleTag = -1): void {
    const pos = geo.getAttribute('position');
    if (!pos || pos.count === 0) return;
    if (geo.index) throw new Error('MergeBucket expects non-indexed geometry');
    this.entries.push({ geo, matrix, width, tag });
    if (tag !== -1) this.tagged = true;
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
    const tags = this.tagged ? new Float32Array(n).fill(-1) : null;
    let o = 0;
    for (const e of this.entries) {
      if (tags) {
        const P0 = e.geo.getAttribute('position');
        for (let t = 0; t + 2 < P0.count; t += 3) {
          let id: number;
          if (typeof e.tag === 'number') id = e.tag;
          else {
            const cx = (P0.getX(t) + P0.getX(t + 1) + P0.getX(t + 2)) / 3;
            const cy = (P0.getY(t) + P0.getY(t + 1) + P0.getY(t + 2)) / 3;
            const cz = (P0.getZ(t) + P0.getZ(t + 1) + P0.getZ(t + 2)) / 3;
            id = e.tag(cx, cy, cz);
          }
          tags[o + t] = tags[o + t + 1] = tags[o + t + 2] = id;
        }
      }
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
    if (tags) g.setAttribute(PANE_ID_ATTR, new THREE.BufferAttribute(tags, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Inverted-hull material for merged or batched geometry outside the office: the world-metre width comes from the
 * per-vertex `outlineWidth` attribute (hulls of every outline class share one draw call), clamped to the shared
 * minimum screen fraction like `outlineMaterial()`. Works with plain meshes, InstancedMesh and BatchedMesh.
 * Render-owned: the caller disposes it. The office uses `createMergedOutlineMaterial` (adds the cut-away).
 */
export function createMergedHullMaterial(name: string): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: palette.ink, side: THREE.BackSide });
  mat.name = name;
  const minScreen = { value: OUTLINE.minScreen as number };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineMinScreen = minScreen;
    shader.vertexShader =
      `attribute vec3 ${OUTLINE_NORMAL_ATTR};\nattribute float ${OUTLINE_WIDTH_ATTR};\nuniform float outlineMinScreen;\n` +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec3 olN = ${OUTLINE_NORMAL_ATTR};
          #ifdef USE_INSTANCING
            olN = mat3( instanceMatrix ) * olN;
          #endif
          #ifdef USE_BATCHING
            olN = mat3( batchingMatrix ) * olN;
          #endif
          olN = normalize( normalMatrix * olN );
          float olW = max( ${OUTLINE_WIDTH_ATTR}, -mvPosition.z * outlineMinScreen );
          mvPosition.xyz += olN * olW;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'mergedHull:v1';
  return mat;
}

/** World-metre hull width of a procedural outline material (`outlineMaterial(thickness)`), else the prop default. */
export function outlineWidthOf(mat: THREE.Material): number {
  const u = (mat.userData as { outlineUniforms?: { outlineThickness?: { value: number } } }).outlineUniforms;
  return u?.outlineThickness?.value ?? (OUTLINE.prop as number);
}
