/**
 * Island map props. Owner: graphics-engineer.
 *
 * M2c (art M2c §11.1): merged per ~56 m chunk at match start (the office's `mergeBuilder` path): one body mesh (the
 * shared vertex-colour toon material) and one hull mesh (per-vertex outline width, so every outline class shares the
 * call) per chunk, whatever the number of kinds and variants. Hulls hide per chunk past the outline distance; chunks
 * past the prop draw distance hide; three.js frustum-culls each chunk in the colour and shadow passes. Tiki flames
 * stay instanced (vertex-shader flicker, 1 call). Per-match layouts change the props every match, so this is rebuilt
 * with the scene. Decor (client-only, `MatchLayout.decor`) and `variant` geometry join the same buckets in Phase 2.
 *
 * `merge: false` keeps the M1 path (one InstancedMesh per kind x part, CPU culled per instance) for measurements.
 */
import * as THREE from 'three';
import { BOAT_MIN_BASE_Y, boundingRadius, collidersForProp, DOCK_DECK_HEIGHT } from '../shared/sim/colliders';
import type { DecorPlacement, IslandMapData, PropKind, PropPlacement } from '../shared/types';
import type { CameraCollider } from './cameraRig';
import { extractParts, StaticInstanceSet, type TemplatePart } from './instancing';
import { createMergedHullMaterial, MergeBucket, outlineWidthOf } from './mergeBuilder';
import { createDecor, createProp, TIKI_FLAME_OFFSET, vertexColorToon } from './procedural';

/** Chunk edge (m): about 4 x 4 chunks over the island (art M2c §11.1). */
export const ISLAND_CHUNK = 56;

export interface PropLayerOptions {
  /** M2c look: tiki flame brightness (unlit colour multiplier, 1 = shipped). */
  flameScale?: number;
  /** Merge static props per chunk (default true). false = the M1 instanced path. */
  merge?: boolean;
  chunkSize?: number;
  /** M2c: client-only decor of this match's layout (MatchLayout.decor), merged into the chunks (y 0 = on the ground). */
  decor?: readonly DecorPlacement[];
}

interface PropChunk {
  body: THREE.Mesh | null;
  hull: THREE.Mesh | null;
  box: THREE.Box3;
}

/** Chunk grid over the placements' bounds: `nx` x `nz` cells of `size` from (minX, minZ). Pure; exported for tests. */
export interface ChunkGrid {
  minX: number;
  minZ: number;
  size: number;
  nx: number;
  nz: number;
}
export function chunkGridFor(points: readonly { x: number; z: number }[], size: number): ChunkGrid {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (!(minX <= maxX)) return { minX: 0, minZ: 0, size, nx: 1, nz: 1 };
  const nx = Math.max(1, Math.ceil((maxX - minX) / size));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / size));
  // Centre the grid on the placements so the edge cells are not slivers.
  return { minX: (minX + maxX) / 2 - (nx * size) / 2, minZ: (minZ + maxZ) / 2 - (nz * size) / 2, size, nx, nz };
}
/** Chunk index of a point (clamped to the grid). Pure; exported for tests. */
export function chunkIndexOf(x: number, z: number, g: ChunkGrid): number {
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.minX) / g.size)));
  const j = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.minZ) / g.size)));
  return j * g.nx + i;
}

/** Dev / measurement knob: the default for `PropLayerOptions.merge` (harness before/after runs). */
export const PROP_LAYER_DEFAULTS = { merge: true, chunkSize: ISLAND_CHUNK };

/**
 * Camera blockers come from the sim's collider shapes (src/shared/sim/colliders.ts, read-only import allowed by ADR
 * 0002 §7), so the camera stops where bullets and feet stop: the stepped hut roof, leaning palm trunk segments, rock
 * cylinders, crate boxes. Small or walkable props (umbrella pole, torch, driftwood, boat, dock) do not block the
 * camera. Bushes are soft in the sim but opaque on screen, so they get a render-only cylinder.
 */
const CAMERA_SIM_KINDS: ReadonlySet<PropKind> = new Set<PropKind>(['palm', 'rock', 'crate', 'hut']);
const CAMERA_VISUAL_ONLY: Partial<Record<PropKind, { r: number; top: number; bottom: number }>> = {
  bush: { r: 0.75, top: 1.0, bottom: -0.2 },
};

/** Camera colliders for one placement (empty if the kind does not block the camera). Exported for tests. */
export function cameraCollidersFor(p: PropPlacement, index: number, map: IslandMapData, baseY: number): CameraCollider[] {
  if (CAMERA_SIM_KINDS.has(p.kind)) {
    return collidersForProp(p, index, map).map((c): CameraCollider =>
      c.shape === 'circle'
        ? { x: c.x, z: c.z, r: c.r, bottom: c.bottom, top: c.top }
        : { x: c.x, z: c.z, r: boundingRadius(c), bottom: c.bottom, top: c.top, box: { hx: c.hx, hz: c.hz, sin: c.sin, cos: c.cos } },
    );
  }
  const v = CAMERA_VISUAL_ONLY[p.kind];
  if (!v) return [];
  return [{ x: p.x, z: p.z, r: v.r * p.scale, bottom: baseY + v.bottom * p.scale, top: baseY + v.top * p.scale }];
}

/**
 * The procedural dock's deck top is DOCK_MODEL_DECK_TOP above its origin. The walkable deck height comes from the sim
 * (DOCK_DECK_HEIGHT in src/shared/sim/colliders.ts, read-only import allowed by ADR 0002 §7), so the visible deck and
 * the walkable deck line up by construction.
 */
export const DOCK_MODEL_DECK_TOP = 0.55;

/**
 * Ground y for a prop origin (scale applied by the caller's matrix). Docks are absolute; boats float at sea level.
 * Same rule as the sim's propBaseY, so model bases and collider bases agree.
 */
export function propBaseY(kind: PropKind, groundY: number, scale = 1): number {
  if (kind === 'dock') return (DOCK_DECK_HEIGHT - DOCK_MODEL_DECK_TOP) * scale;
  if (kind === 'boat') return Math.max(BOAT_MIN_BASE_Y, groundY);
  return groundY;
}

export function propMatrix(p: PropPlacement, y: number, out = new THREE.Matrix4()): THREE.Matrix4 {
  const c = Math.cos(p.rotY) * p.scale;
  const s = Math.sin(p.rotY) * p.scale;
  // T * Ry(rotY) * S(scale), column-major set() takes row-major arguments.
  return out.set(
    c, 0, s, p.x,
    0, p.scale, 0, y,
    -s, 0, c, p.z,
    0, 0, 0, 1,
  );
}

export class PropLayer {
  readonly group = new THREE.Group();
  readonly colliders: CameraCollider[] = [];
  private readonly sets: StaticInstanceSet[] = [];
  private readonly chunks: PropChunk[] = [];
  private readonly ownedGeos: THREE.BufferGeometry[] = [];
  private hullMat: THREE.MeshBasicMaterial | null = null;
  private flameMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly flameTime = { value: 0 };
  private readonly flameScale: number;
  readonly merged: boolean;
  /** Build stats (dev hook / RENDERING.md). */
  readonly stats = { chunks: 0, bodyTris: 0, hullTris: 0, buildMs: 0, placements: 0, decor: 0, decorTris: 0 };

  constructor(map: IslandMapData, heightAt: (x: number, z: number) => number, opts: PropLayerOptions = {}) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.group.name = 'props';
    this.flameScale = opts.flameScale ?? 1;
    this.merged = opts.merge ?? PROP_LAYER_DEFAULTS.merge;
    // M2c: one template per (kind, variant): variants change geometry or colours, never the collider.
    const byKind = new Map<string, { kind: PropKind; variant: number; list: PropPlacement[] }>();
    for (const p of map.props) {
      const variant = p.variant ?? 0;
      const key = `${p.kind}|${variant}`;
      let g = byKind.get(key);
      if (!g) byKind.set(key, (g = { kind: p.kind, variant, list: [] }));
      g.list.push(p);
    }
    const grid = chunkGridFor(map.props, opts.chunkSize ?? PROP_LAYER_DEFAULTS.chunkSize);
    const cells = grid.nx * grid.nz;
    const bodies = this.merged ? Array.from({ length: cells }, () => new MergeBucket(false)) : [];
    const hulls = this.merged ? Array.from({ length: cells }, () => new MergeBucket(true)) : [];

    for (const { kind, variant, list } of byKind.values()) {
      const template = createProp(kind, variant);
      const parts = extractParts(template).map((part) =>
        part.name === 'flame' ? { ...part, material: this.getFlameMaterial(part.material) } : part,
      );
      const body = parts.find((p) => p.name === 'body') ?? parts[0];
      if (!body) continue;
      const matrices = list.map((p) => propMatrix(p, propBaseY(kind, heightAt(p.x, p.z), p.scale)));
      this.stats.placements += list.length;
      list.forEach((p, i) => {
        // The sim's prop index is not needed for the camera, so pass 0.
        for (const c of cameraCollidersFor(p, 0, map, matrices[i].elements[13])) this.colliders.push(c);
      });

      // Instanced parts: everything on the M1 path; only the flickering flames when merging.
      const instParts = this.merged ? parts.filter((p) => p.name === 'flame') : parts;
      if (instParts.length > 0) {
        const ref = instParts.find((p) => p.name === 'body') ?? instParts[0];
        if (!ref.geometry.boundingSphere) ref.geometry.computeBoundingSphere();
        const set = new StaticInstanceSet(instParts, matrices, ref.geometry.boundingSphere!.clone(), variant ? `prop:${kind}:v${variant}` : `prop:${kind}`);
        this.sets.push(set);
        for (const m of set.meshes) this.group.add(m);
      }
      if (!this.merged) continue;
      const mergeParts = parts.filter((p) => p.name !== 'flame');
      list.forEach((p, i) => this.addToChunk(bodies, hulls, chunkIndexOf(p.x, p.z, grid), mergeParts, matrices[i]));
    }

    // M2c decor (client-only, flat or soft): merged into the same chunk bodies (no hull), on the terrain.
    if (this.merged && opts.decor && opts.decor.length > 0) {
      const templates = new Map<string, TemplatePart[] | null>();
      for (const d of opts.decor) {
        const key = `${d.kind}|${d.variant ?? 0}`;
        let parts = templates.get(key);
        if (parts === undefined) {
          try {
            parts = extractParts(createDecor(d.kind, d.variant ?? 0));
          } catch {
            parts = null; // unknown or office-only kind on the island: skipped (the level test covers the table)
          }
          templates.set(key, parts);
        }
        if (!parts) continue;
        const y = d.y !== 0 ? d.y : heightAt(d.x, d.z);
        const m = propMatrix({ x: d.x, z: d.z, rotY: d.rotY, scale: d.scale } as PropPlacement, y);
        const k = chunkIndexOf(d.x, d.z, grid);
        for (const part of parts) this.stats.decorTris += part.geometry.getAttribute('position').count / 3;
        this.addToChunk(bodies, hulls, k, parts, m);
        this.stats.decor++;
      }
    }

    if (this.merged) {
      this.hullMat = createMergedHullMaterial('props:hull');
      const bodyMat = vertexColorToon(); // shared procedural material (not ours to dispose)
      for (let k = 0; k < bodies.length; k++) {
        const bg = bodies[k].build(`props:chunk${k}:body`);
        const hg = hulls[k].build(`props:chunk${k}:hull`);
        if (!bg && !hg) continue;
        this.stats.bodyTris += bodies[k].triangles;
        this.stats.hullTris += hulls[k].triangles;
        const box = new THREE.Box3();
        let bodyMesh: THREE.Mesh | null = null, hullMesh: THREE.Mesh | null = null;
        if (bg) {
          box.union(bg.boundingBox!);
          this.ownedGeos.push(bg);
          bodyMesh = new THREE.Mesh(bg, bodyMat);
          bodyMesh.name = bg.name;
          bodyMesh.castShadow = true;
          bodyMesh.receiveShadow = true;
        }
        if (hg) {
          box.union(hg.boundingBox!);
          this.ownedGeos.push(hg);
          hullMesh = new THREE.Mesh(hg, this.hullMat);
          hullMesh.name = hg.name;
          hullMesh.raycast = () => {};
        }
        for (const m of [bodyMesh, hullMesh]) {
          if (!m) continue;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          this.group.add(m);
        }
        this.chunks.push({ body: bodyMesh, hull: hullMesh, box });
      }
      this.stats.chunks = this.chunks.length;
    }
    this.stats.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  /**
   * Bake one placement's parts into its chunk. Phase 2 seam: `variant` geometry and decor placements
   * (MatchLayout.decor, through the graphics-designer's decor table) call this with their own parts.
   */
  private addToChunk(bodies: MergeBucket[], hulls: MergeBucket[], k: number, parts: readonly TemplatePart[], world: THREE.Matrix4): void {
    for (const part of parts) {
      const m = new THREE.Matrix4().multiplyMatrices(world, part.matrix);
      if (part.isOutline) hulls[k].add(part.geometry, m, outlineWidthOf(part.material));
      else bodies[k].add(part.geometry, m);
    }
  }

  /** Flicker the tiki flames in the vertex shader (per-instance phase from the instance position). */
  private getFlameMaterial(src: THREE.Material): THREE.Material {
    if (this.flameMaterial) return this.flameMaterial;
    const mat = (src as THREE.MeshBasicMaterial).clone();
    mat.name = 'tikiFlame:flicker';
    // M2c look: brighter flames at golden hour / overcast (unlit colour multiplier; 1 keeps the shipped white).
    if (this.flameScale !== 1) mat.color.setScalar(this.flameScale);
    const baseY = (TIKI_FLAME_OFFSET[1] - 0.18).toFixed(3);
    const time = this.flameTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFlameTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uFlameTime;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            float seed = 0.0;
            #ifdef USE_INSTANCING
              seed = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.61;
            #endif
            float f = 1.0 + 0.2 * sin(uFlameTime * 13.0 + seed * 7.0) + 0.1 * sin(uFlameTime * 23.0 + seed * 3.0);
            transformed.y = ${baseY} + (transformed.y - ${baseY}) * f;
            transformed.xz *= 1.0 + 0.08 * sin(uFlameTime * 17.0 + seed);
          }`,
        );
    };
    mat.customProgramCacheKey = () => 'tiki-flame-flicker-v1';
    this.flameMaterial = mat;
    return mat;
  }

  get instanceTotal(): number {
    return this.sets.reduce((n, s) => n + s.instanceCount, 0);
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  update(frustum: THREE.Frustum, cam: THREE.Vector3, time: number, drawDistance: number, outlineDistance: number): void {
    this.flameTime.value = time;
    const farSq = drawDistance * drawDistance;
    const nearSq = outlineDistance * outlineDistance;
    for (const s of this.sets) s.update(frustum, cam, 8, farSq, nearSq);
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      const d2 = c.box.distanceToPoint(cam) ** 2;
      const shown = d2 <= farSq;
      if (c.body) c.body.visible = shown;
      if (c.hull) c.hull.visible = shown && d2 < nearSq;
    }
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    for (const g of this.ownedGeos) g.dispose();
    this.ownedGeos.length = 0;
    this.hullMat?.dispose();
    this.flameMaterial?.dispose();
    this.group.clear();
  }
}
