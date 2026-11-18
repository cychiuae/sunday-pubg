/**
 * Geometry baking helpers: turn a list of coloured, transformed primitives into ONE vertex-coloured
 * BufferGeometry (+ an optional outline hull geometry). Owner: graphics-designer.
 *
 * Output geometry is non-indexed with attributes `position`, `normal`, `color` (linear RGB, as Three
 * expects). Outline geometry has `position` + `outlineNormal`.
 */
import * as THREE from 'three';
import { ensureOutlineNormals } from './materials';

export type V3 = readonly [number, number, number];

/** Per-triangle colour override. `n` = face normal, `c` = face centroid (both after transform). */
export type ColorFn = (n: THREE.Vector3, c: THREE.Vector3, tri: number) => number;

export interface Piece {
  geo: THREE.BufferGeometry;
  color: number;
  matrix?: THREE.Matrix4;
  /** true (default): part of colour mesh AND hull. false: colour only. 'only': hull only (invisible proxy). */
  outline?: boolean | 'only';
  /** Recompute flat (faceted) normals after transform. */
  flat?: boolean;
  colorFn?: ColorFn;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/** Compose a TRS matrix. Rotation is Euler (radians, order default 'XYZ'). Scale applies in local axes. */
export function xf(
  p: V3 = [0, 0, 0],
  r: V3 = [0, 0, 0],
  s: number | V3 = 1,
  order: THREE.EulerOrder = 'XYZ',
): THREE.Matrix4 {
  _p.set(p[0], p[1], p[2]);
  _q.setFromEuler(_e.set(r[0], r[1], r[2], order));
  if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** TRS where the rotation maps local +Y onto `dir` (for cylinders/capsules/cones placed along a segment). */
export function alongY(p: V3, dir: THREE.Vector3, s: number | V3 = 1): THREE.Matrix4 {
  _p.set(p[0], p[1], p[2]);
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** TRS where the rotation maps local +Z onto `dir`, then spins `roll` radians about it. */
export function alongZ(p: V3, dir: THREE.Vector3, s: number | V3 = 1, roll = 0): THREE.Matrix4 {
  _p.set(p[0], p[1], p[2]);
  _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
  if (roll) _q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

const _col = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cen = new THREE.Vector3();

/** Bake one piece into a standalone non-indexed geometry with position/normal/color. */
export function bake(piece: Piece): THREE.BufferGeometry {
  const src = piece.geo.index ? piece.geo.toNonIndexed() : piece.geo;
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', (src.getAttribute('position') as THREE.BufferAttribute).clone());
  const srcN = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
  if (srcN && !piece.flat) out.setAttribute('normal', srcN.clone());
  if (piece.matrix) out.applyMatrix4(piece.matrix);
  if (piece.flat || !srcN) out.computeVertexNormals(); // non-indexed => faceted normals
  if (src !== piece.geo) src.dispose();

  const pos = out.getAttribute('position');
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  _col.setHex(piece.color);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = _col.r;
    colors[i * 3 + 1] = _col.g;
    colors[i * 3 + 2] = _col.b;
  }
  if (piece.colorFn) {
    for (let t = 0; t * 3 + 2 < count; t++) {
      const i = t * 3;
      _a.fromBufferAttribute(pos, i);
      _b.fromBufferAttribute(pos, i + 1);
      _c.fromBufferAttribute(pos, i + 2);
      _cen.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3);
      _n.subVectors(_c, _b).cross(_a.sub(_b)).normalize();
      _col.setHex(piece.colorFn(_n, _cen, t));
      for (let k = 0; k < 3; k++) {
        colors[(i + k) * 3] = _col.r;
        colors[(i + k) * 3 + 1] = _col.g;
        colors[(i + k) * 3 + 2] = _col.b;
      }
    }
  }
  out.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return out;
}

/** Concatenate non-indexed geometries. Attributes missing from any input are dropped. */
export function mergeGeos(geos: THREE.BufferGeometry[], attrs: readonly string[] = ['position', 'normal', 'color']): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of attrs) {
    const parts = geos.map((g) => g.getAttribute(name) as THREE.BufferAttribute | undefined);
    if (parts.length === 0 || parts.some((p) => !p)) continue;
    const itemSize = parts[0]!.itemSize;
    let total = 0;
    for (const p of parts) total += p!.count * itemSize;
    const arr = new Float32Array(total);
    let off = 0;
    for (const p of parts) {
      arr.set(p!.array as ArrayLike<number>, off);
      off += p!.count * itemSize;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, itemSize));
  }
  return out;
}

export interface Merged {
  /** Vertex-coloured colour mesh geometry (render with `vertexColorToon()`). */
  geometry: THREE.BufferGeometry;
  /** Hull geometry for `outlineMaterial()`, or null if no piece is outlined. */
  outline: THREE.BufferGeometry | null;
}

/** Bake and merge pieces into one colour geometry and one outline geometry. */
export function buildMerged(pieces: Piece[], name = 'procedural'): Merged {
  const baked = pieces.map(bake);
  const colour = baked.filter((_, i) => pieces[i].outline !== 'only');
  const hull = baked.filter((_, i) => pieces[i].outline !== false);
  const geometry = mergeGeos(colour);
  geometry.name = name;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  let outline: THREE.BufferGeometry | null = null;
  if (hull.length) {
    outline = mergeGeos(hull, ['position', 'normal']);
    ensureOutlineNormals(outline);
    outline.deleteAttribute('normal');
    outline.name = `${name}:outline`;
    outline.computeBoundingBox();
    outline.computeBoundingSphere();
    // Hull is extruded in the shader; pad bounds so frustum culling does not clip it early.
    if (outline.boundingSphere) outline.boundingSphere.radius += 0.1;
  }
  for (const g of baked) g.dispose();
  return { geometry, outline };
}

/** Deterministic PRNG (mulberry32). Same seed => same props on every client. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Number of triangles drawn by an object tree (instanced meshes count once). For budgets/tests. */
export function countTris(obj: THREE.Object3D, includeOutlines = true): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!includeOutlines && m.name === 'outline') return;
    const g = m.geometry;
    n += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  });
  return Math.round(n);
}
