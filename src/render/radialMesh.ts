/**
 * Radial (polar) grid helpers shared by the terrain and the water mesh. Owner: graphics-engineer.
 * A polar grid puts vertices where the island needs them (dense across the beach band, coarse far out at sea) and
 * follows the round coastline with far fewer triangles than a square grid.
 */
import * as THREE from 'three';

export interface RingBand {
  /** Outer radius of this band (m). */
  until: number;
  /** Ring spacing inside the band (m). */
  step: number;
}

/** Monotonic ring radii starting at `start` (0 = a centre vertex is added by the mesh builder). */
export function ringRadii(start: number, bands: readonly RingBand[]): number[] {
  const out: number[] = [start];
  let r = start;
  for (const b of bands) {
    while (r + b.step * 0.5 < b.until) {
      r = Math.min(b.until, r + b.step);
      out.push(r);
    }
    if (r < b.until) {
      r = b.until;
      out.push(r);
    }
  }
  return out;
}

/** Geometric ring radii from r0 to r1 (for the far ocean). Excludes r0. */
export function geometricRadii(r0: number, r1: number, count: number): number[] {
  const out: number[] = [];
  const k = Math.pow(r1 / r0, 1 / count);
  let r = r0;
  for (let i = 0; i < count; i++) {
    r *= k;
    out.push(i === count - 1 ? r1 : r);
  }
  return out;
}

/**
 * Indexed polar grid in the XZ plane (y = 0). If radii[0] === 0 a single centre vertex is used.
 * Vertex order: [centre?] then ring by ring, `segments` vertices per ring (no seam duplicate).
 * Triangles wind counter-clockwise seen from +Y (normals up).
 */
export function buildPolarGrid(radii: readonly number[], segments: number): THREE.BufferGeometry {
  const hasCentre = radii[0] === 0;
  const rings = hasCentre ? radii.slice(1) : radii.slice();
  const vCount = (hasCentre ? 1 : 0) + rings.length * segments;
  const pos = new Float32Array(vCount * 3);
  let v = 0;
  if (hasCentre) v = 1; // centre at origin
  const cosA = new Float32Array(segments);
  const sinA = new Float32Array(segments);
  for (let s = 0; s < segments; s++) {
    const a = (s / segments) * Math.PI * 2;
    cosA[s] = Math.cos(a);
    sinA[s] = Math.sin(a);
  }
  for (const r of rings) {
    for (let s = 0; s < segments; s++) {
      pos[v * 3] = cosA[s] * r;
      pos[v * 3 + 2] = sinA[s] * r;
      v++;
    }
  }
  const triCount = (hasCentre ? segments : 0) + (rings.length - 1) * segments * 2;
  const Index = vCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new Index(triCount * 3);
  let t = 0;
  const ringStart = (k: number) => (hasCentre ? 1 : 0) + k * segments;
  // Angle increases from +X toward +Z, i.e. clockwise seen from +Y. CCW from above: (centre, next, current).
  if (hasCentre) {
    for (let s = 0; s < segments; s++) {
      const a = ringStart(0) + s;
      const b = ringStart(0) + ((s + 1) % segments);
      idx[t++] = 0;
      idx[t++] = b;
      idx[t++] = a;
    }
  }
  for (let k = 0; k < rings.length - 1; k++) {
    const i0 = ringStart(k);
    const i1 = ringStart(k + 1);
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      const a = i0 + s, b = i0 + s1, c = i1 + s, d = i1 + s1;
      idx[t++] = a;
      idx[t++] = b;
      idx[t++] = c;
      idx[t++] = b;
      idx[t++] = d;
      idx[t++] = c;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}
