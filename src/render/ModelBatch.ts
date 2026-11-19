/**
 * M2c (Addendum 2: a distinct 3D model per weapon level). Owner: graphics-engineer.
 *
 * Batching BY MATERIAL, not by kind or level: every model that uses the shared vertex-colour toon body and an ink hull
 * goes into ONE `THREE.BatchedMesh` for bodies and ONE for hulls (per-vertex hull width, so every outline class shares
 * the call). 13 weapons x 4 levels x scopes is then still 2 draw calls (+1 shadow) for any number of on-screen items,
 * where per-(kind, level) InstancedMeshes would cost 2 calls per distinct model in view (up to ~100 in a loot pile).
 *
 * - Geometry is keyed by a string (e.g. `loot:rifle:L3:scope_4x`, `held:rifle:L3:red_dot`) and built LAZILY on the
 *   first `acquire` (the builder runs once; its parts are baked into one body + one hull geometry with `MergeBucket`).
 * - Parts that do not use the batchable materials (see‑through lenses, unlit glows) are returned to the caller as
 *   `extras` so it can instance them (they are rare: the red-dot lens).
 * - Capacity grows by doubling (`setInstanceCount`, `setGeometrySize`); geometry is never freed during a match
 *   (at most a few hundred kilobytes for every level of every weapon); `dispose()` frees it with the scene.
 * - Per instance: a world matrix (set every frame for spinning loot or held weapons on a hand bone), visibility, and an
 *   optional colour multiplier (level tint or hit flash) through `setColorAt`.
 * - WebGL2 path: `WEBGL_multi_draw` (Chrome, Edge, Safari 17+). Without it three.js loops `drawArrays` per visible
 *   instance inside the same program and buffers: correct, still no per-model state changes.
 *
 * Phase 2 wiring (after the graphics-designer's `level`-aware builders land): LootLayer and PlayerViews (held weapons
 * in third person) acquire handles here; the viewmodel keeps its own per-(id, level, sight) cached geometry (1 item).
 */
import * as THREE from 'three';
import { extractParts, type TemplatePart } from './instancing';
import { createMergedHullMaterial, MergeBucket, outlineWidthOf } from './mergeBuilder';
import { vertexColorToon } from './procedural';

export type ModelBuilder = () => THREE.Object3D;

export interface ModelEntry {
  key: string;
  bodyGeo: number;
  hullGeo: number;
  /** Parts with other materials (caller instances them). Matrices are relative to the model root. */
  extras: TemplatePart[];
  bodyTris: number;
  hullTris: number;
}

export interface ModelHandle {
  entry: ModelEntry;
  body: number;
  hull: number;
}

export interface ModelBatchOptions {
  /** Initial instance capacity (grows by doubling). */
  instances?: number;
  /** Initial vertex capacity per batch (grows by doubling). */
  vertices?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

/** True when a part can join the body batch (the shared vertex-colour toon material). */
export function isBatchableBody(p: TemplatePart, toon: THREE.Material): boolean {
  return !p.isOutline && p.material === toon;
}

export class ModelBatch {
  readonly body: THREE.BatchedMesh;
  readonly hull: THREE.BatchedMesh;
  private readonly hullMat: THREE.MeshBasicMaterial;
  private readonly toon: THREE.MeshToonMaterial;
  private readonly builders = new Map<string, { build: ModelBuilder; anchor: string | null }>();
  private readonly entries = new Map<string, ModelEntry>();
  private instanceCap: number;
  private bodyVerts = 0;
  private hullVerts = 0;
  private bodyVertCap: number;
  private hullVertCap: number;
  private live = 0;
  /** Build stats (dev hook / RENDERING.md). */
  readonly stats = { models: 0, bodyTris: 0, hullTris: 0, buildMs: 0, grows: 0 };

  constructor(readonly name: string, opts: ModelBatchOptions = {}) {
    this.instanceCap = opts.instances ?? 64;
    this.bodyVertCap = opts.vertices ?? 65536;
    this.hullVertCap = opts.vertices ?? 65536;
    this.toon = vertexColorToon(); // shared procedural material: not disposed here
    this.hullMat = createMergedHullMaterial(`${name}:hull`);
    this.body = new THREE.BatchedMesh(this.instanceCap, this.bodyVertCap, 0, this.toon);
    this.body.name = `${name}:body`;
    this.body.castShadow = opts.castShadow ?? true;
    this.body.receiveShadow = opts.receiveShadow ?? true;
    this.hull = new THREE.BatchedMesh(this.instanceCap, this.hullVertCap, 0, this.hullMat);
    this.hull.name = `${name}:hull`;
    this.hull.castShadow = false;
    for (const b of [this.body, this.hull]) {
      b.sortObjects = false; // opaque: no depth sort needed
      b.perObjectFrustumCulled = true;
      // The object-level bounding sphere is computed once (three.js caches it; setMatrixAt never invalidates it), so a
      // batch created empty would be culled forever. Instances move every frame: rely on the per-instance cull only.
      b.frustumCulled = false;
    }
  }

  /**
   * Register a lazy builder for `key` (no geometry is built until the first acquire). Re-registering is a no-op.
   * `anchor`: bake only the meshes under the node of that name, relative to it (e.g. a loot model's 'spin').
   */
  register(key: string, build: ModelBuilder, anchor: string | null = null): void {
    if (!this.builders.has(key)) this.builders.set(key, { build, anchor });
  }

  has(key: string): boolean {
    return this.builders.has(key);
  }

  /** The baked entry for `key`, building it now if needed. Throws for an unregistered key. */
  entry(key: string): ModelEntry {
    let e = this.entries.get(key);
    if (e) return e;
    const b = this.builders.get(key);
    if (!b) throw new Error(`ModelBatch ${this.name}: no builder for ${key}`);
    const t0 = performance.now();
    const root = b.build();
    const parts = b.anchor ? extractParts(root, [b.anchor]).filter((p) => p.anchor === b.anchor) : extractParts(root);
    const bodyB = new MergeBucket(false);
    const hullB = new MergeBucket(true);
    const extras: TemplatePart[] = [];
    for (const p of parts) {
      if (p.isOutline) hullB.add(p.geometry, p.matrix, outlineWidthOf(p.material));
      else if (isBatchableBody(p, this.toon)) bodyB.add(p.geometry, p.matrix);
      else extras.push(p);
    }
    const bg = bodyB.build(`${key}:body`) ?? emptyGeometry(false);
    const hg = hullB.build(`${key}:hull`) ?? emptyGeometry(true);
    const bv = bg.getAttribute('position').count, hv = hg.getAttribute('position').count;
    this.ensureVertices(bv, hv);
    e = {
      key,
      bodyGeo: this.body.addGeometry(bg),
      hullGeo: this.hull.addGeometry(hg),
      extras,
      bodyTris: bv / 3,
      hullTris: hv / 3,
    };
    this.bodyVerts += bv;
    this.hullVerts += hv;
    // addGeometry copies into the batch buffers; the temporary merged geometries can go.
    bg.dispose();
    hg.dispose();
    this.entries.set(key, e);
    this.stats.models++;
    this.stats.bodyTris += e.bodyTris;
    this.stats.hullTris += e.hullTris;
    this.stats.buildMs += performance.now() - t0;
    return e;
  }

  /** A new instance of model `key` (hidden until `setMatrix` + `setVisible(true)`). */
  acquire(key: string): ModelHandle {
    const e = this.entry(key);
    if (this.live >= this.instanceCap) this.growInstances();
    this.live++;
    const h: ModelHandle = { entry: e, body: this.body.addInstance(e.bodyGeo), hull: this.hull.addInstance(e.hullGeo) };
    this.body.setVisibleAt(h.body, false);
    this.hull.setVisibleAt(h.hull, false);
    return h;
  }

  /** Swap the model of a live handle (weapon swap or level change): no new instance. */
  swap(h: ModelHandle, key: string): void {
    if (h.entry.key === key) return;
    const e = this.entry(key);
    h.entry = e;
    this.body.setGeometryIdAt(h.body, e.bodyGeo);
    this.hull.setGeometryIdAt(h.hull, e.hullGeo);
  }

  setMatrix(h: ModelHandle, m: THREE.Matrix4): void {
    this.body.setMatrixAt(h.body, m);
    this.hull.setMatrixAt(h.hull, m);
  }

  /** `outline` false hides only the hull (outline distance LOD). */
  setVisible(h: ModelHandle, visible: boolean, outline = visible): void {
    this.body.setVisibleAt(h.body, visible);
    this.hull.setVisibleAt(h.hull, visible && outline);
  }

  /** Colour multiplier on the body (level tint, hit flash). */
  setTint(h: ModelHandle, c: THREE.Color): void {
    this.body.setColorAt(h.body, c);
  }

  release(h: ModelHandle): void {
    this.body.deleteInstance(h.body);
    this.hull.deleteInstance(h.hull);
    this.live--;
  }

  get liveInstances(): number {
    return this.live;
  }

  private growInstances(): void {
    this.instanceCap *= 2;
    this.body.setInstanceCount(this.instanceCap);
    this.hull.setInstanceCount(this.instanceCap);
    this.stats.grows++;
  }

  private ensureVertices(bv: number, hv: number): void {
    let grow = false;
    while (this.bodyVerts + bv > this.bodyVertCap) {
      this.bodyVertCap *= 2;
      grow = true;
    }
    while (this.hullVerts + hv > this.hullVertCap) {
      this.hullVertCap *= 2;
      grow = true;
    }
    if (!grow) return;
    this.body.setGeometrySize(this.bodyVertCap, 0);
    this.hull.setGeometrySize(this.hullVertCap, 0);
    this.stats.grows++;
  }

  dispose(): void {
    this.body.dispose();
    this.hull.dispose();
    this.hullMat.dispose();
    this.entries.clear();
    this.builders.clear();
  }
}

/** A degenerate one-triangle geometry with the batch's attribute layout (a model with no body or no hull). */
function emptyGeometry(hull: boolean): THREE.BufferGeometry {
  const b = new MergeBucket(hull);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  b.add(g, new THREE.Matrix4(), 0);
  return b.build('empty')!;
}
