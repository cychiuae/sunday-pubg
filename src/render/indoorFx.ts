/**
 * Indoor shader patches (M2b office, STYLE.md §19). Owner: graphics-engineer.
 *
 * Two screen effects shared by every indoor material through ONE uniform object (`INDOOR_FX`), so the scene updates
 * them once per frame and no material is rebuilt:
 *   - cover: the under-desk crawlspace darkening (§19.4 "Under desks": multiply 0.75). A top-down cover texture
 *     (R = covered, G = underside height / 0.1 m) built from the kit's raised collider boxes; a fragment below the
 *     underside is darkened. Used on the floor, kit props and the chibis (so a chibi under a desk reads as "in the
 *     dark"). On the island uCoverOn = 0.
 *   - cut-away: in the 3P camera cases (carrier, chase, death, results) fragments close to the segment camera ->
 *     subject are dithered away (screen-door, no sorting), so walls, desks and ceiling clutter never hide the subject.
 *     Off in first person.
 * Allocation-free per frame. Programs are shared per material kind (customProgramCacheKey).
 */
import * as THREE from 'three';
import { OUTLINE, OUTLINE_NORMAL_ATTR, palette, vertexColorToon } from './procedural';

/** Metres per cover-texture height step (G channel byte). Max 25.5 m. */
export const COVER_HEIGHT_STEP = 0.1;

const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
blank.needsUpdate = true;

/** The shared uniforms. Values are written by IndoorScene (cover) and Renderer (cut-away). */
export const INDOOR_FX = {
  uCoverTex: { value: blank as THREE.Texture },
  /** minX, minZ, 1 / width, 1 / depth of the cover texture's world rectangle. */
  uCoverRect: { value: new THREE.Vector4(0, 0, 1, 1) },
  uCoverOn: { value: 0 },
  uCoverDark: { value: 0.75 },
  uCutOn: { value: 0 },
  /** Camera position (segment start). */
  uCutA: { value: new THREE.Vector3() },
  /** Subject pivot (segment end). */
  uCutB: { value: new THREE.Vector3() },
  /** Cut radius at the camera end and at the subject end (m). */
  uCutR: { value: new THREE.Vector2(3.2, 1.1) },
};
export type IndoorFxUniforms = typeof INDOOR_FX;

const VERT_PARS = /* glsl */ `
varying vec3 vIndoorW;
`;
const VERT_MAIN = /* glsl */ `
{
  vec4 iw = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    iw = instanceMatrix * iw;
  #endif
  vIndoorW = ( modelMatrix * iw ).xyz;
}
`;
const FRAG_PARS = /* glsl */ `
varying vec3 vIndoorW;
uniform sampler2D uCoverTex;
uniform vec4 uCoverRect;
uniform float uCoverOn;
uniform float uCoverDark;
uniform float uCutOn;
uniform vec3 uCutA;
uniform vec3 uCutB;
uniform vec2 uCutR;
float indoorBayer( vec2 p ) {
  vec2 q = mod( floor( p ), 4.0 );
  float b = mod( q.x + q.y * 4.0 + floor( q.y * 0.5 ) * 7.0 + floor( q.x * 0.5 ) * 11.0, 16.0 );
  return ( b + 0.5 ) / 16.0;
}
float indoorCover() {
  if ( uCoverOn < 0.5 ) return 1.0;
  vec2 uv = ( vIndoorW.xz - uCoverRect.xy ) * uCoverRect.zw;
  if ( uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ) return 1.0;
  vec4 c = texture2D( uCoverTex, uv );
  float h = c.g * ${(255 * COVER_HEIGHT_STEP).toFixed(3)};
  float under = c.r * ( 1.0 - smoothstep( h - 0.7, h - 0.05, vIndoorW.y ) );
  return mix( 1.0, uCoverDark, under );
}
void indoorCut() {
  if ( uCutOn < 0.5 ) return;
  vec3 ab = uCutB - uCutA;
  float L2 = max( dot( ab, ab ), 1e-4 );
  float t = dot( vIndoorW - uCutA, ab ) / L2;
  if ( t <= 0.0 || t >= 0.97 ) return;
  float r = mix( uCutR.x, uCutR.y, t );
  float d = length( vIndoorW - ( uCutA + ab * t ) );
  #ifdef INDOOR_HULL
    // Hulls are fully gone wherever a body is even partly dithered (d < r), so no ink shows through the holes.
    float a = 1.0 - smoothstep( r, r * 1.35, d );
  #else
    float a = 1.0 - smoothstep( r * 0.7, r, d );
  #endif
  if ( a > indoorBayer( gl_FragCoord.xy ) ) discard;
}
`;

export interface IndoorPatchOptions {
  /** Under-desk darkening (lit materials only; needs `outgoingLight`). */
  cover?: boolean;
  /** 3P cut-away. */
  cut?: boolean;
}

/**
 * Patches `mat` in place (onBeforeCompile + program key) with the indoor effects and returns it. `key` must be unique
 * per base program (e.g. 'toon', 'basic'). Do not call twice on one material.
 */
export function patchIndoor<M extends THREE.Material>(mat: M, key: string, opts: IndoorPatchOptions): M {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    applyIndoorChunks(shader, opts);
  };
  const cacheKey = `indoor:${key}:${opts.cover ? 1 : 0}${opts.cut ? 1 : 0}`;
  mat.customProgramCacheKey = () => cacheKey;
  return mat;
}

/** Inject the indoor chunks into a compiled shader (exported for materials with their own onBeforeCompile). */
export function applyIndoorChunks(shader: THREE.WebGLProgramParametersWithUniforms, opts: IndoorPatchOptions): void {
  for (const k of Object.keys(INDOOR_FX) as (keyof IndoorFxUniforms)[]) shader.uniforms[k] = INDOOR_FX[k];
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
  let f = shader.fragmentShader.replace('#include <common>', `#include <common>\n${FRAG_PARS}`);
  if (opts.cut) f = f.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nindoorCut();');
  if (opts.cover) f = f.replace('#include <opaque_fragment>', 'outgoingLight *= indoorCover();\n#include <opaque_fragment>');
  shader.fragmentShader = f;
}

let chibiMat: THREE.MeshToonMaterial | null = null;
/**
 * The chibi colour material: the shared vertex-colour toon look plus the under-desk cover darkening (no cut-away:
 * the subject must never be cut). One instance for every chibi; inert on the island (uCoverOn = 0).
 */
export function chibiCoverMaterial(): THREE.MeshToonMaterial {
  if (chibiMat) return chibiMat;
  const m = vertexColorToon().clone();
  m.name = 'chibi:toonCover';
  chibiMat = patchIndoor(m, 'chibiToon', { cover: true });
  return chibiMat;
}

/** Name of the per-vertex hull width attribute (metres) on merged indoor outline geometry. */
export const OUTLINE_WIDTH_ATTR = 'outlineWidth';

/**
 * Inverted-hull material for MERGED indoor geometry: like procedural outlineMaterial, but the world-metre width comes
 * from the per-vertex `outlineWidth` attribute (so props of every outline class merge into one draw call), plus the
 * cut-away. Render-owned: the caller disposes it.
 */
export function createMergedOutlineMaterial(name: string): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: palette.ink, side: THREE.BackSide });
  mat.name = name;
  mat.defines = { INDOOR_HULL: '' };
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
          olN = normalize( normalMatrix * olN );
          float olW = max( ${OUTLINE_WIDTH_ATTR}, -mvPosition.z * outlineMinScreen );
          mvPosition.xyz += olN * olW;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
    applyIndoorChunks(shader, { cut: true });
  };
  mat.customProgramCacheKey = () => 'indoor:mergedOutline:v1';
  return mat;
}

/** Reset the shared state (map change to the island, renderer dispose). */
export function resetIndoorFx(): void {
  INDOOR_FX.uCoverOn.value = 0;
  INDOOR_FX.uCoverTex.value = blank;
  INDOOR_FX.uCutOn.value = 0;
}
