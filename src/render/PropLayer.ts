/**
 * Map props, instanced: one InstancedMesh per (kind x part), i.e. body + outline hull (+ flame for torches).
 * ~350 placements of 10 kinds => ~21 draw calls in the colour pass, plus shadow casters. CPU frustum/distance culling
 * per instance keeps vertex work proportional to what is on screen. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import { BOAT_MIN_BASE_Y, boundingRadius, collidersForProp, DOCK_DECK_HEIGHT } from '../shared/sim/colliders';
import type { MapData, PropKind, PropPlacement } from '../shared/types';
import type { CameraCollider } from './cameraRig';
import { extractParts, StaticInstanceSet } from './instancing';
import { createProp, TIKI_FLAME_OFFSET } from './procedural';

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
export function cameraCollidersFor(p: PropPlacement, index: number, map: MapData, baseY: number): CameraCollider[] {
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
  private flameMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly flameTime = { value: 0 };

  constructor(map: MapData, heightAt: (x: number, z: number) => number) {
    this.group.name = 'props';
    const byKind = new Map<PropKind, PropPlacement[]>();
    for (const p of map.props) {
      let list = byKind.get(p.kind);
      if (!list) byKind.set(p.kind, (list = []));
      list.push(p);
    }
    for (const [kind, list] of byKind) {
      const template = createProp(kind);
      const parts = extractParts(template).map((part) =>
        part.name === 'flame' ? { ...part, material: this.getFlameMaterial(part.material) } : part,
      );
      const body = parts.find((p) => p.name === 'body') ?? parts[0];
      if (!body) continue;
      if (!body.geometry.boundingSphere) body.geometry.computeBoundingSphere();
      const bounds = body.geometry.boundingSphere!.clone();
      const matrices = list.map((p) => propMatrix(p, propBaseY(kind, heightAt(p.x, p.z), p.scale)));
      const set = new StaticInstanceSet(parts, matrices, bounds, `prop:${kind}`);
      this.sets.push(set);
      for (const m of set.meshes) this.group.add(m);

      list.forEach((p, i) => {
        // The sim's prop index is not needed for the camera, so pass 0.
        for (const c of cameraCollidersFor(p, 0, map, matrices[i].elements[13])) this.colliders.push(c);
      });
    }
  }

  /** Flicker the tiki flames in the vertex shader (per-instance phase from the instance position). */
  private getFlameMaterial(src: THREE.Material): THREE.Material {
    if (this.flameMaterial) return this.flameMaterial;
    const mat = (src as THREE.MeshBasicMaterial).clone();
    mat.name = 'tikiFlame:flicker';
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

  update(frustum: THREE.Frustum, cam: THREE.Vector3, time: number, drawDistance: number, outlineDistance: number): void {
    this.flameTime.value = time;
    const farSq = drawDistance * drawDistance;
    const nearSq = outlineDistance * outlineDistance;
    for (const s of this.sets) s.update(frustum, cam, 8, farSq, nearSq);
  }

  dispose(): void {
    for (const s of this.sets) s.dispose();
    this.flameMaterial?.dispose();
    this.group.clear();
  }
}
