/**
 * Instancing helpers. Owner: graphics-engineer.
 * - `extractParts` flattens a procedural model (createProp / createLootModel output) into (geometry, material,
 *   local matrix) parts so every part can become ONE InstancedMesh shared by all copies of the model.
 * - `StaticInstanceSet` holds precomputed world matrices for a static set (props) and compacts only the visible
 *   instances into the InstancedMeshes (CPU frustum + distance cull, 1 draw call per part).
 */
import * as THREE from 'three';

export interface TemplatePart {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Transform relative to `anchor` (or to the template root when anchor is null). */
  matrix: THREE.Matrix4;
  /** Name of the nearest ancestor listed in `anchors`, or null. */
  anchor: string | null;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  isOutline: boolean;
}

/**
 * Flattens all meshes under `root`. Meshes below a node whose name is in `anchors` get their matrix relative to
 * that node (so the caller can animate the anchor per instance). Outline hulls are detected by name 'outline'.
 */
export function extractParts(root: THREE.Object3D, anchors: readonly string[] = []): TemplatePart[] {
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const parts: TemplatePart[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    let anchor: THREE.Object3D | null = null;
    for (let p = mesh.parent; p && p !== root.parent; p = p.parent) {
      if (anchors.includes(p.name)) {
        anchor = p;
        break;
      }
    }
    const base = anchor ? new THREE.Matrix4().copy(anchor.matrixWorld).invert() : rootInv;
    parts.push({
      name: mesh.name,
      geometry: mesh.geometry,
      material: mesh.material as THREE.Material,
      matrix: new THREE.Matrix4().multiplyMatrices(base, mesh.matrixWorld),
      anchor: anchor ? anchor.name : null,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      renderOrder: mesh.renderOrder,
      isOutline: mesh.name === 'outline',
    });
  });
  return parts;
}

/** Rest matrix of a named node relative to the template root (identity if missing). */
export function anchorRestMatrix(root: THREE.Object3D, name: string): THREE.Matrix4 {
  root.updateMatrixWorld(true);
  const node = root.getObjectByName(name);
  if (!node) return new THREE.Matrix4();
  return new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(node.matrixWorld);
}

export function makeInstancedMesh(part: TemplatePart, capacity: number, name: string): THREE.InstancedMesh {
  const m = new THREE.InstancedMesh(part.geometry, part.material, Math.max(1, capacity));
  m.name = name;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.count = 0;
  m.castShadow = part.castShadow;
  m.receiveShadow = part.receiveShadow;
  m.renderOrder = part.renderOrder;
  m.frustumCulled = false; // culled per instance on the CPU
  m.matrixAutoUpdate = false;
  m.visible = false;
  return m;
}

const _sphere = new THREE.Sphere();

/**
 * One prop kind (or any static instanced model): N instances x P parts. `update` culls against the frustum and
 * a draw distance, then rewrites instance matrices only when the visible set changes.
 */
export class StaticInstanceSet {
  readonly meshes: THREE.InstancedMesh[];
  private readonly n: number;
  /** Per part: n x 16 world matrices. */
  private readonly worlds: Float32Array[];
  private readonly centers: Float32Array;
  private readonly radii: Float32Array;
  private readonly visAll: Int32Array;
  private readonly visNear: Int32Array;
  private readonly prevAll: Int32Array;
  private readonly prevNear: Int32Array;
  private prevAllCount = -1;
  private prevNearCount = -1;

  constructor(
    readonly parts: TemplatePart[],
    instanceMatrices: readonly THREE.Matrix4[],
    localBounds: THREE.Sphere,
    name: string,
  ) {
    this.n = instanceMatrices.length;
    this.meshes = parts.map((p, i) => makeInstancedMesh(p, this.n, `${name}:${p.name || i}`));
    this.worlds = parts.map(() => new Float32Array(this.n * 16));
    this.centers = new Float32Array(this.n * 3);
    this.radii = new Float32Array(this.n);
    const tmp = new THREE.Matrix4();
    const c = new THREE.Vector3();
    instanceMatrices.forEach((m, i) => {
      parts.forEach((p, k) => {
        tmp.multiplyMatrices(m, p.matrix);
        tmp.toArray(this.worlds[k], i * 16);
      });
      c.copy(localBounds.center).applyMatrix4(m);
      this.centers[i * 3] = c.x;
      this.centers[i * 3 + 1] = c.y;
      this.centers[i * 3 + 2] = c.z;
      this.radii[i] = localBounds.radius * m.getMaxScaleOnAxis();
    });
    this.visAll = new Int32Array(this.n);
    this.visNear = new Int32Array(this.n);
    this.prevAll = new Int32Array(this.n);
    this.prevNear = new Int32Array(this.n);
  }

  get instanceCount(): number {
    return this.n;
  }

  /** Bounding sphere centre/radius of instance i (world). */
  instanceSphere(i: number, out: THREE.Sphere): THREE.Sphere {
    out.center.set(this.centers[i * 3], this.centers[i * 3 + 1], this.centers[i * 3 + 2]);
    out.radius = this.radii[i];
    return out;
  }

  /**
   * @param pad extra radius for the frustum test (keeps shadow casters just outside the view)
   * @param farSq squared draw distance for all parts; nearSq for outline parts
   */
  update(frustum: THREE.Frustum, cam: THREE.Vector3, pad: number, farSq: number, nearSq: number): void {
    let na = 0, nn = 0;
    for (let i = 0; i < this.n; i++) {
      const x = this.centers[i * 3], y = this.centers[i * 3 + 1], z = this.centers[i * 3 + 2];
      const d2 = (x - cam.x) ** 2 + (y - cam.y) ** 2 + (z - cam.z) ** 2;
      const r = this.radii[i];
      if (d2 > farSq + r * r * 4) continue;
      _sphere.center.set(x, y, z);
      _sphere.radius = r + pad;
      if (!frustum.intersectsSphere(_sphere)) continue;
      this.visAll[na++] = i;
      if (d2 < nearSq) {
        // Outline only if the body itself (not the padded shadow sphere) is on screen.
        _sphere.radius = r;
        if (frustum.intersectsSphere(_sphere)) this.visNear[nn++] = i;
      }
    }
    const allChanged = !sameList(this.visAll, na, this.prevAll, this.prevAllCount);
    const nearChanged = !sameList(this.visNear, nn, this.prevNear, this.prevNearCount);
    if (!allChanged && !nearChanged) return;
    for (let k = 0; k < this.parts.length; k++) {
      const outline = this.parts[k].isOutline;
      if (outline ? !nearChanged : !allChanged) continue;
      const list = outline ? this.visNear : this.visAll;
      const count = outline ? nn : na;
      const mesh = this.meshes[k];
      const dst = mesh.instanceMatrix.array as Float32Array;
      const src = this.worlds[k];
      for (let j = 0; j < count; j++) {
        const s = list[j] * 16;
        const d = j * 16;
        for (let e = 0; e < 16; e++) dst[d + e] = src[s + e];
      }
      mesh.count = count;
      mesh.visible = count > 0;
      mesh.instanceMatrix.clearUpdateRanges();
      if (count > 0) {
        mesh.instanceMatrix.addUpdateRange(0, count * 16);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (allChanged) {
      for (let i = 0; i < na; i++) this.prevAll[i] = this.visAll[i];
      this.prevAllCount = na;
    }
    if (nearChanged) {
      for (let i = 0; i < nn; i++) this.prevNear[i] = this.visNear[i];
      this.prevNearCount = nn;
    }
  }

  dispose(): void {
    // Geometries/materials are shared procedural caches: only release the instance buffers.
    for (const m of this.meshes) m.dispose();
  }
}

function sameList(a: Int32Array, na: number, b: Int32Array, nb: number): boolean {
  if (na !== nb) return false;
  for (let i = 0; i < na; i++) if (a[i] !== b[i]) return false;
  return true;
}
