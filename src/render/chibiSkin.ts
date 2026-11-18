/**
 * Collapses a procedural chibi (6 rigid part meshes + 6 outline hulls = 12 draw calls, 6 shadow casts) into ONE
 * rigid-skinned colour mesh + ONE rigid-skinned outline mesh (2 draw calls, 1 shadow cast). The procedural pivots
 * (body, head, arms, legs) stay the animation joints: they are used directly as the skeleton bones, so all pose code
 * and the hand socket keep working. Geometry is cached per appearance. Owner: graphics-engineer.
 */
import * as THREE from 'three';
import type { CharacterModel } from './procedural';
import { OUTLINE, OUTLINE_NORMAL_ATTR, palette, vertexColorToon } from './procedural';

const PART_KEYS = ['torso', 'head', 'armL', 'armR', 'legL', 'legR'] as const;

interface SkinGeos {
  colour: THREE.BufferGeometry;
  outline: THREE.BufferGeometry;
}

const geoCache = new Map<string, SkinGeos>();
let outlineMat: THREE.MeshBasicMaterial | null = null;

/** Skinning-aware inverted-hull outline (same look as procedural outlineMaterial: world-metre width, min screen width). */
export function skinnedOutlineMaterial(): THREE.MeshBasicMaterial {
  if (outlineMat) return outlineMat;
  const mat = new THREE.MeshBasicMaterial({ color: palette.ink, side: THREE.BackSide });
  mat.name = 'outline:skinned';
  const uniforms = {
    outlineThickness: { value: OUTLINE.character as number },
    outlineMinScreen: { value: OUTLINE.minScreen as number },
  };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineThickness = uniforms.outlineThickness;
    shader.uniforms.outlineMinScreen = uniforms.outlineMinScreen;
    shader.vertexShader =
      `attribute vec3 ${OUTLINE_NORMAL_ATTR};\nuniform float outlineThickness;\nuniform float outlineMinScreen;\n` +
      shader.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        {
          vec3 olN = ${OUTLINE_NORMAL_ATTR};
          #ifdef USE_SKINNING
            mat4 olSkin = skinWeight.x * boneMatX + skinWeight.y * boneMatY + skinWeight.z * boneMatZ + skinWeight.w * boneMatW;
            olN = ( bindMatrixInverse * olSkin * bindMatrix * vec4( olN, 0.0 ) ).xyz;
          #endif
          olN = normalize( normalMatrix * olN );
          float olW = max( outlineThickness, -mvPosition.z * outlineMinScreen );
          mvPosition.xyz += olN * olW;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'toon-outline-skinned-v1';
  outlineMat = mat;
  return mat;
}

function partMeshes(model: CharacterModel): THREE.Mesh[] {
  const m = model.chibi.meshes;
  return PART_KEYS.map((k) => m[k]);
}

function outlineOf(mesh: THREE.Mesh): THREE.Mesh | null {
  return (mesh.children.find((c) => c.name === 'outline') as THREE.Mesh | undefined) ?? null;
}

/** Rest-pose matrices relative to the model root. Pose is reset first. */
function restMatrices(model: CharacterModel): { meshRel: THREE.Matrix4[]; boneRel: THREE.Matrix4[] } {
  model.chibi.resetPose();
  const root = model.root;
  const savedPos = root.position.clone();
  const savedQuat = root.quaternion.clone();
  const savedScale = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);
  const meshes = partMeshes(model);
  const meshRel = meshes.map((m) => m.matrixWorld.clone());
  const boneRel = meshes.map((m) => (m.parent ?? root).matrixWorld.clone());
  root.position.copy(savedPos);
  root.quaternion.copy(savedQuat);
  root.scale.copy(savedScale);
  root.updateMatrixWorld(true);
  return { meshRel, boneRel };
}

function mergeSkinned(sources: (THREE.BufferGeometry | null)[], matrices: THREE.Matrix4[], dirAttr: string | null, keep: readonly string[]): THREE.BufferGeometry {
  let total = 0;
  for (const g of sources) if (g) total += g.getAttribute('position').count;
  const out = new THREE.BufferGeometry();
  const pos = new Float32Array(total * 3);
  const dir = dirAttr ? new Float32Array(total * 3) : null;
  const extras = keep.map((name) => {
    const a = sources.find((g) => g?.getAttribute(name))?.getAttribute(name);
    return { name, itemSize: a ? a.itemSize : 3, data: a ? new Float32Array(total * a.itemSize) : null };
  });
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3();
  let o = 0;
  sources.forEach((g, bone) => {
    if (!g) return;
    const p = g.getAttribute('position');
    const d = dirAttr ? g.getAttribute(dirAttr) : null;
    const m = matrices[bone];
    nm.getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m);
      pos[(o + i) * 3] = v.x;
      pos[(o + i) * 3 + 1] = v.y;
      pos[(o + i) * 3 + 2] = v.z;
      if (d && dir) {
        v.fromBufferAttribute(d, i).applyMatrix3(nm).normalize();
        dir[(o + i) * 3] = v.x;
        dir[(o + i) * 3 + 1] = v.y;
        dir[(o + i) * 3 + 2] = v.z;
      }
      skinIndex[(o + i) * 4] = bone;
      skinWeight[(o + i) * 4] = 1;
    }
    for (const e of extras) {
      const a = g.getAttribute(e.name);
      if (!a || !e.data) continue;
      for (let i = 0; i < a.count; i++) for (let k = 0; k < e.itemSize; k++) e.data[(o + i) * e.itemSize + k] = a.getComponent(i, k);
    }
    o += p.count;
  });
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (dir && dirAttr) out.setAttribute(dirAttr, new THREE.BufferAttribute(dir, 3));
  for (const e of extras) if (e.data) out.setAttribute(e.name, new THREE.BufferAttribute(e.data, e.itemSize));
  out.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  return out;
}

function buildGeos(model: CharacterModel, meshRel: THREE.Matrix4[]): SkinGeos {
  const meshes = partMeshes(model);
  const colour = mergeSkinned(meshes.map((m) => m.geometry), meshRel, 'normal', ['color']);
  const outline = mergeSkinned(meshes.map((m) => outlineOf(m)?.geometry ?? null), meshRel, OUTLINE_NORMAL_ATTR, []);
  colour.name = 'chibi:skinned';
  outline.name = 'chibi:skinned:outline';
  return { colour, outline };
}

export interface SkinnedChibi {
  colour: THREE.SkinnedMesh;
  outline: THREE.SkinnedMesh;
  /** Swap geometry after `model.chibi.setVariant(...)`. */
  setAppearanceKey(key: string): void;
}

const BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0.65, 0), 1.25);

/**
 * Hides the 12 per-part meshes of `model` and adds the two skinned meshes under `model.root`. `key` identifies the
 * appearance (geometry cache key).
 */
export function skinChibi(model: CharacterModel, key: string): SkinnedChibi {
  const { meshRel, boneRel } = restMatrices(model);
  const meshes = partMeshes(model);
  for (const m of meshes) m.visible = false; // hides the outline child too
  // The procedural pivots are the bones (Skeleton only reads matrixWorld).
  const bones = meshes.map((m) => (m.parent ?? model.root) as unknown as THREE.Bone);
  const inverses = boneRel.map((b) => b.clone().invert());
  const skeleton = new THREE.Skeleton(bones, inverses);

  const geos = (k: string): SkinGeos => {
    let g = geoCache.get(k);
    if (!g) geoCache.set(k, (g = buildGeos(model, meshRel)));
    return g;
  };
  const g0 = geos(key);
  const make = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string): THREE.SkinnedMesh => {
    const s = new THREE.SkinnedMesh(geo, mat);
    s.name = name;
    s.bind(skeleton, new THREE.Matrix4());
    s.boundingSphere = BOUNDS.clone();
    model.root.add(s);
    return s;
  };
  const colour = make(g0.colour, vertexColorToon(), 'chibiSkin');
  colour.castShadow = true;
  colour.receiveShadow = false;
  const outline = make(g0.outline, skinnedOutlineMaterial(), 'outline');
  outline.castShadow = false;
  outline.receiveShadow = false;

  return {
    colour,
    outline,
    setAppearanceKey(k: string) {
      // setVariant swapped the part geometries; rebuild from them (cached per key).
      const g = geos(k);
      colour.geometry = g.colour;
      outline.geometry = g.outline;
    },
  };
}

/** Free cached skinned geometries (renderer dispose / map change). */
export function disposeSkinCache(): void {
  for (const g of geoCache.values()) {
    g.colour.dispose();
    g.outline.dispose();
  }
  geoCache.clear();
}
