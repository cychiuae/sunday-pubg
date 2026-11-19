/**
 * Shared toon materials, the 3-step gradient ramp, inverted-hull outlines and the art palette.
 * Owner: graphics-designer. Values mirror docs/art/STYLE.md; change both together.
 *
 * Every procedural model uses at most these materials:
 *   - `vertexColorToon()`  one MeshToonMaterial (white, vertexColors) shared by ALL characters, props, weapons, loot.
 *   - `outlineMaterial()`  one inverted-hull MeshBasicMaterial per (thickness, colour) pair.
 *   - a few unlit emissive/glow materials (tiki flame, loot glow) created in their own modules.
 * So a whole island batches into very few programs.
 */
import * as THREE from 'three';

// -------------------------------------------------------------------------------------------------
// Palette (sRGB hex). See docs/art/STYLE.md for roles.
// -------------------------------------------------------------------------------------------------
export const palette = {
  // Ink / outlines
  ink: 0x2a1d33,
  inkSoft: 0x4a3a52,

  // Terrain
  sandLight: 0xf7e4b5,
  sandDark: 0xe6c58c,
  wetSand: 0xc9a273,
  grass: 0x7cc84f,
  grassDark: 0x5aa844,
  dirt: 0xb98a5a,

  // Foliage
  palmLeaf: 0x4cbb4a,
  palmLeafDark: 0x34983f,
  palmTrunk: 0xb07f52,
  palmTrunkDark: 0x8a5d3b,
  coconut: 0x6b4428,
  bush: 0x58b549,
  bushDark: 0x3f9840,
  bushLight: 0x82d35a,
  hibiscus: 0xff5c8a,
  flowerCenter: 0xffd23f,

  // Rock
  rock: 0x9a96a0,
  rockDark: 0x726d7c,
  rockLight: 0xc3bfc4,

  // Water / sky / light
  seaShallow: 0x4fd8d0,
  seaDeep: 0x1f7fbf,
  seaAbyss: 0x125a96,
  foam: 0xf4fbff,
  skyTop: 0x4fb2f0,
  skyHorizon: 0xd2f1ff,
  sunLight: 0xfff1d6,
  hemiSky: 0xc4e8ff,
  hemiGround: 0xe9d3a2,
  fog: 0xd2f1ff,

  // Wood / built props
  wood: 0xb57a48,
  woodDark: 0x7e5333,
  plank: 0xd09a62,
  plankDark: 0xb07e4c,
  bamboo: 0xd8b065,
  bambooDark: 0xa98443,
  thatch: 0xe0b85e,
  thatchDark: 0xbb9040,
  hutWall: 0xe3b77a,
  doorDark: 0x5b3a29,
  crate: 0xd39a5a,
  crateBand: 0x86562f,
  driftwood: 0xd2c2a8,
  driftwoodDark: 0xa8957c,
  stripeCoral: 0xff5a5f,
  stripeCream: 0xfff4e2,
  towel: 0x3fb7e8,
  boatHull: 0xf26b3a,
  boatTrim: 0xfff4e2,
  flameOuter: 0xff8a2a,
  flameInner: 0xffe066,

  // Weapons (toy-like, one family colour each; matching ammo uses the same family colour)
  pistol: 0xffc43d,
  smg: 0x2ec4b6,
  shotgun: 0xe94f37,
  rifle: 0x3e9b5a,
  dmr: 0x5b8def, // cornflower
  sniper: 0x34497a, // deep lagoon navy (accents in ammoSniper pink)
  lmg: 0xff8a3d, // tangerine
  gunDark: 0x3d3a4b,
  gunWood: 0xb9783f,
  gunTip: 0xfff3d6,

  // M2c weapons (docs/art/M2c.md §2)
  revolver: 0x4fb4ee, // sky frame
  sandDollar: 0xf2e2c2, // revolver cylinder
  sandDollarDots: 0xc9a273,
  walnut: 0x8a5a34,
  dbBarrel: 0x7fddb8, // mint
  waffle: 0xd9a05b,
  waffleDark: 0xb07a3a,
  scoopPink: 0xff8fb1,
  rpgTube: 0xfff4e2, // cream
  rpgStripe: 0xff5a5f, // coral spiral
  sunburst: 0xffc43d,
  steel: 0xd3dce6,
  steelEdge: 0xf4f8fb,
  steelSpine: 0x9aa6b4,
  knifeHandle: 0xff7a5c,
  macheteHandle: 0x34983f,
  macheteWrap: 0x4cbb4a,
  paddleTip: 0x2ec4b6,
  // Smoke can (M2c §4)
  smokeCan: 0xc9b6f2,
  smokeHoop: 0xffb3d1,
  smokeCap: 0xffd1e6,
  smokeCap2: 0xf2b8f0,
  smokeLight: 0xfbeaf6,
  smokeMid: 0xebcff0,
  smokeShadow: 0xc9aedf,
  smokeVeil: 0xefddf2,
  // Item levels (M2c §1): see levelCollar.ts LEVEL_COLORS
  level1: 0xb8e7ff,
  level2: 0xfff14d,
  level3: 0xf2590d,
  level4: 0xb963e3,

  // Sights (M2a)
  lensGlass: 0x9fe8f0,
  redDot: 0xff3b5c,

  // Ammo families
  ammoLight: 0xffc43d,
  ammoShell: 0xe94f37,
  ammoHeavy: 0x3e9b5a,
  ammoSniper: 0xff6fa8, // bubblegum pink
  brass: 0xe8b84a,

  // Grenade (pineapple frag, M2a)
  grenade: 0xff9f1c,
  grenadeDark: 0xd97a12,
  grenadeLeaf: 0x4cbb4a,
  grenadePin: 0xff3b5c,

  // Armor tiers (M2a). Tier 1 soft cloth, tier 2 padded sporty, tier 3 hard shell + tropical accent.
  armor1: 0x7fa8c8, // faded denim
  armor1Trim: 0xd9b26f, // tan canvas
  armor2: 0x3a6fd8, // cobalt
  armor2Dark: 0x2b55b0,
  armor2Trim: 0xf4f7fb, // sporty white
  armor3: 0x3d4a5c, // slate shell
  armor3Dark: 0x2a3342,
  armor3Accent: 0xff5c8a, // hibiscus pink
  armor3Accent2: 0xffc43d, // mango
  // M2c: each tier's accent becomes its LEVEL colour (docs/art/M2c.md §1.5); the main colours stay.
  armor1Level: 0xb8e7ff, // L1 ice: hat band, vest hem cord and pocket flaps
  armor2Level: 0xfff14d, // L2 lemon: stripe, collar, side stripes
  armor3Level: 0xf2590d, // L3 orange: brow lip, plate rims, crest, emblems
  // L4 (from the wreck): Ship's Bell Helmet + Surfboard Vest
  bellBrass: 0xc98b2e,
  bellHighlight: 0xf2c46a,
  bellLip: 0x8e5f1e,
  armor4Level: 0xb963e3, // L4 UV violet: bell rope band, surfboard deck
  armor4: 0xb963e3, // level 4 armor accent (= armor4Level; Vfx tier colour)
  boardCream: 0xfff4e2,
  tapeGrey: 0xc9ced6,
  waxDot: 0xfff14d,

  // Heals / armor
  bandage: 0xfff8ee,
  bandageStripe: 0xff8fb1,
  medkit: 0xffffff,
  medkitCross: 0x2fb36b,
  vest: 0x4f6f9f, // legacy M1 vest colour (unused since M2a armor tiers; kept for compatibility)
  vestStrap: 0xd9b26f,

  // Loot tiers (paired with shape coding, see loot.ts)
  tierCommon: 0xf2f6fa,
  tierRare: 0x2f9bff,
  tierEpic: 0xb84dff,

  // Gameplay signals
  danger: 0xff3b5c,
  tideWall: 0x46b8ff,
  tideFoam: 0xeafaff,
  muzzleFlash: 0xfff1a8,
  muzzleFlashEdge: 0xff9d2e,
  hitPuff: 0xffffff,
  hitSpark: 0xffd23f,
  hitMarker: 0xffffff,
  hitMarkerKill: 0xff3b5c,

  // UI suggestions (ui-ux-designer owns final choice)
  uiPanel: 0x1d2b4a,
  uiAccent: 0xffc43d,
  uiAccent2: 0x2ec4b6,
  uiText: 0xfffaf0,
  uiHealth: 0x5ee06a,
  uiArmor: 0x4fa8ff,
} as const;

export type PaletteKey = keyof typeof palette;

// -------------------------------------------------------------------------------------------------
// Toon ramp
// -------------------------------------------------------------------------------------------------
/**
 * 3-step ramp, sampled by MeshToonMaterial at u = dot(N, L) * 0.5 + 0.5.
 * [shadow, mid (terminator band), lit]. Hemisphere/ambient light lifts the shadow step.
 */
export const TOON_RAMP: readonly number[] = [0.42, 0.74, 1.0];

let gradientTex: THREE.DataTexture | null = null;

/** Shared gradient map: 3x1 RedFormat DataTexture, NearestFilter, no mipmaps. */
export function getToonGradient(): THREE.DataTexture {
  if (!gradientTex) {
    const data = new Uint8Array(TOON_RAMP.map((v) => Math.round(v * 255)));
    const tex = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    tex.name = 'toonRamp3';
    gradientTex = tex;
  }
  return gradientTex;
}

export interface ToonOptions {
  vertexColors?: boolean;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
}

const toonCache = new Map<string, THREE.MeshToonMaterial>();

/** Cached MeshToonMaterial with the shared gradient map. Same args => same instance. */
export function toonMaterial(color: number, opts: ToonOptions = {}): THREE.MeshToonMaterial {
  const key = [
    color,
    opts.vertexColors ? 1 : 0,
    opts.emissive ?? 0,
    opts.emissiveIntensity ?? 1,
    opts.transparent ? 1 : 0,
    opts.opacity ?? 1,
    opts.side ?? THREE.FrontSide,
  ].join('|');
  let m = toonCache.get(key);
  if (!m) {
    m = new THREE.MeshToonMaterial({
      color,
      gradientMap: getToonGradient(),
      vertexColors: !!opts.vertexColors,
      emissive: opts.emissive ?? 0x000000,
      emissiveIntensity: opts.emissiveIntensity ?? 1,
      transparent: !!opts.transparent,
      opacity: opts.opacity ?? 1,
      side: opts.side ?? THREE.FrontSide,
    });
    m.name = `toon:${key}`;
    toonCache.set(key, m);
  }
  return m;
}

/** The single material used by every vertex-coloured procedural model. */
export function vertexColorToon(): THREE.MeshToonMaterial {
  return toonMaterial(0xffffff, { vertexColors: true });
}

// -------------------------------------------------------------------------------------------------
// Inverted-hull outlines
// -------------------------------------------------------------------------------------------------
/** World-space outline thickness in metres, per asset class. */
export const OUTLINE = {
  character: 0.022,
  prop: 0.035,
  large: 0.045,
  small: 0.012,
  /**
   * Minimum thickness as a fraction of view depth (metres per metre of distance). 0.0012 ~ 1 px at 1080p,
   * 60 deg vertical FOV, so silhouettes keep an ink line at 30 m+ without bloating up close.
   */
  minScreen: 0.0012,
} as const;

/** Attribute name holding the welded (smooth) normals the hull is extruded along. */
export const OUTLINE_NORMAL_ATTR = 'outlineNormal';

const outlineCache = new Map<string, THREE.MeshBasicMaterial>();

/**
 * Inverted-hull material: BackSide MeshBasicMaterial whose vertices are pushed out along the welded
 * `outlineNormal` attribute in view space. Thickness is in world metres (independent of mesh scale),
 * clamped to a minimum screen fraction. Works with InstancedMesh. Supports fog. Shares one program
 * across all thicknesses/colours (thickness is a uniform).
 */
export function outlineMaterial(thickness: number = OUTLINE.prop, color: number = palette.ink): THREE.MeshBasicMaterial {
  const key = `${thickness}|${color}`;
  let m = outlineCache.get(key);
  if (m) return m;
  const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  mat.name = `outline:${key}`;
  const uniforms = {
    outlineThickness: { value: thickness },
    outlineMinScreen: { value: OUTLINE.minScreen as number },
  };
  mat.userData.outlineUniforms = uniforms;
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
          #ifdef USE_INSTANCING
            olN = mat3( instanceMatrix ) * olN;
          #endif
          olN = normalize( normalMatrix * olN );
          float olW = max( outlineThickness, -mvPosition.z * outlineMinScreen );
          mvPosition.xyz += olN * olW;
          gl_Position = projectionMatrix * mvPosition;
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'toon-outline-v1';
  outlineCache.set(key, mat);
  return mat;
}

/**
 * Adds a welded smooth-normal attribute (`outlineNormal`) so hard-edged geometry (boxes, flat-shaded
 * rocks) gets a gap-free hull. Idempotent; mutates and returns `geo`.
 */
export function ensureOutlineNormals(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  if (geo.getAttribute(OUTLINE_NORMAL_ATTR)) return geo;
  const pos = geo.getAttribute('position');
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const nrm = geo.getAttribute('normal');
  const n = pos.count;
  const keyOf = (i: number) =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const sums = new Map<string, [number, number, number]>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    keys[i] = k;
    let s = sums.get(k);
    if (!s) {
      s = [0, 0, 0];
      sums.set(k, s);
    }
    s[0] += nrm.getX(i);
    s[1] += nrm.getY(i);
    s[2] += nrm.getZ(i);
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const s = sums.get(keys[i])!;
    let len = Math.hypot(s[0], s[1], s[2]);
    if (len < 1e-6) {
      // Degenerate (opposing normals cancelled): fall back to the vertex's own normal.
      s[0] = nrm.getX(i);
      s[1] = nrm.getY(i);
      s[2] = nrm.getZ(i);
      len = Math.hypot(s[0], s[1], s[2]) || 1;
    }
    out[i * 3] = s[0] / len;
    out[i * 3 + 1] = s[1] / len;
    out[i * 3 + 2] = s[2] / len;
  }
  geo.setAttribute(OUTLINE_NORMAL_ATTR, new THREE.BufferAttribute(out, 3));
  return geo;
}

/**
 * Attach an inverted-hull outline as a child of `mesh`. Shares `mesh.geometry` (adds `outlineNormal`
 * to it) unless a dedicated, usually simpler `outlineGeometry` is given. The outline never casts or
 * receives shadows and is ignored by raycasts.
 */
export function addOutline(
  mesh: THREE.Mesh,
  thickness: number = OUTLINE.prop,
  color: number = palette.ink,
  outlineGeometry?: THREE.BufferGeometry,
): THREE.Mesh {
  const geo = ensureOutlineNormals(outlineGeometry ?? mesh.geometry);
  const o = new THREE.Mesh(geo, outlineMaterial(thickness, color));
  o.name = 'outline';
  o.castShadow = false;
  o.receiveShadow = false;
  o.raycast = () => {};
  mesh.add(o);
  return o;
}

// -------------------------------------------------------------------------------------------------
// Small colour helpers
// -------------------------------------------------------------------------------------------------
/** Mix two sRGB hex colours in sRGB space (t = 0 -> a, 1 -> b). */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}
