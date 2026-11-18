/**
 * Toy-like weapon models. Owner: graphics-designer. Spec: docs/art/STYLE.md "Weapons" and "Sights".
 *
 * Frame: origin at the grip (where the hand closes), barrel along -Z, top of the gun +Y.
 * Children of every model returned by createWeaponModel():
 *   'weapon'  vertex-coloured mesh (+ 'outline' hull child)
 *   'muzzle'  empty Object3D at the barrel tip (muzzle flash / tracer origin)
 *   'sight'   empty Object3D at the sight's EYE POINT (ADS camera). Its -Z is the line of sight (parallel
 *             to the barrel), +Y is up. userData.sightType is the sight type.
 * Geometry is cached per id and shared. Family colours: pistol mango, smg teal, shotgun red + wood,
 * rifle green, dmr cornflower, sniper navy + pink, lmg tangerine. Every barrel ends in a cream "toy tip".
 */
import * as THREE from 'three';
import type { WeaponId } from '../../shared/types';
import { buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder lying along Z. */
const tube = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(HALF_PI);
/** Open-ended cylinder along Z (sight hoods). */
const hood = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg, 1, true).rotateX(HALF_PI);
/** Frustum along Z: `rRear` at +Z, `rFront` at -Z (scope bells). */
const bell = (rRear: number, rFront: number, len: number, seg = 10) =>
  new THREE.CylinderGeometry(rRear, rFront, len, seg).rotateX(HALF_PI);
/** Cylinder along X (bolt handles, side turrets). */
const tubeX = (r: number, len: number, seg = 6) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(HALF_PI);

/** Sight type per weapon (M2a brief). Mirrors the gameplay sight type; prefer balance/type data if it exists. */
export type SightType = 'iron' | 'red_dot' | 'scope_4x' | 'scope_8x';

export interface WeaponSight {
  type: SightType;
  /** Eye point in the weapon frame (metres). The line of sight runs from here along -Z. */
  eye: V3;
  /** Centre of the sight's rear aperture / rear lens in the weapon frame (the eye looks through this). */
  rear: V3;
  /** Radius of the rear aperture or lens (m); 0 for iron sights. */
  apertureRadius: number;
}

interface WeaponSpec { pieces: Piece[]; muzzle: V3; sight: WeaponSight; lens?: Piece[] }

// -------------------------------------------------------------------------------------------------
// Sight builders
// -------------------------------------------------------------------------------------------------
/**
 * Iron sights: a front post and a two-post rear notch whose tops sit on one line parallel to the barrel.
 * @param yRear top surface under the rear notch, @param yFront top surface under the front post.
 */
function ironSights(yRear: number, zRear: number, yFront: number, zFront: number, eyeBack: number): { pieces: Piece[]; sight: WeaponSight } {
  const d = palette.gunDark;
  const lineY = yRear + 0.02;
  const postH = lineY - yFront + 0.004;
  const pieces: Piece[] = [
    { geo: box(0.014, postH, 0.014), color: d, matrix: xf([0, yFront + postH / 2, zFront]), outline: false },
    { geo: box(0.012, 0.024, 0.014), color: d, matrix: xf([-0.017, yRear + 0.012, zRear]), outline: false },
    { geo: box(0.012, 0.024, 0.014), color: d, matrix: xf([0.017, yRear + 0.012, zRear]), outline: false },
  ];
  // The sight line runs over the post tops (lineY + 0.004): the front post tip sits exactly on the aim point.
  const tipY = lineY + 0.004;
  return { pieces, sight: { type: 'iron', eye: [0, tipY, zRear + eyeBack], rear: [0, tipY, zRear], apertureRadius: 0 } };
}

/**
 * Red dot: a short hooded tube on a base block, pale glass lens with a red dot on its rear face, and a
 * coloured band at the front of the hood. Sits on a flat top at height `y0`, centred at `z`.
 */
function redDot(y0: number, z: number, accent: number): { pieces: Piece[]; lens: Piece[]; sight: WeaponSight } {
  const d = palette.gunDark;
  const ay = y0 + 0.05; // optical axis
  const len = 0.065;
  const pieces: Piece[] = [
    { geo: box(0.05, 0.026, 0.07), color: d, matrix: xf([0, y0 + 0.011, z]) },
    { geo: hood(0.033, len, 8), color: d, matrix: xf([0, ay, z]) },
    { geo: hood(0.0345, 0.018, 8), color: accent, matrix: xf([0, ay, z - len / 2 + 0.009]), outline: false },
    // round red dot, floating on the rear face of the (see-through) lens
    { geo: tube(0.0055, 0.003, 8), color: palette.redDot, matrix: xf([0, ay, z - 0.0075]), outline: false },
  ];
  // The lens is a separate see-through part (createWeaponModel 'lens'), so first-person ADS looks through it.
  const lens: Piece[] = [{ geo: tube(0.029, 0.004, 10), color: palette.lensGlass, matrix: xf([0, ay, z - 0.0115]), outline: false }];
  const rearZ = z + len / 2;
  // Eye 0.3 m behind the hood: in first-person ADS the hood frames the view (about 12 deg wide at 50 deg vfov).
  return { pieces, lens, sight: { type: 'red_dot', eye: [0, ay, rearZ + 0.3], rear: [0, ay, rearZ], apertureRadius: 0.03 } };
}

interface ScopeOpts {
  /** Flat top the mounts stand on. */
  y0: number;
  /** Optical axis height. */
  ay: number;
  /** Main tube front / rear z. */
  zFront: number;
  zRear: number;
  r: number;
  /** Objective bell front radius and length. */
  rObj: number;
  objLen: number;
  /** Eyepiece rear radius and length. */
  rEye: number;
  eyeLen: number;
  accent: number;
  mounts: [number, number];
  type: 'scope_4x' | 'scope_8x';
}

/** Telescopic sight: tube, objective bell + coloured lip, eyepiece, turrets, two mounts, glass both ends. */
function scope(o: ScopeOpts): { pieces: Piece[]; sight: WeaponSight } {
  const d = palette.gunDark;
  const len = o.zRear - o.zFront;
  const zMid = (o.zRear + o.zFront) / 2;
  const objZ = o.zFront - o.objLen / 2;
  const objFront = o.zFront - o.objLen;
  const eyeZ = o.zRear + o.eyeLen / 2;
  const eyeRear = o.zRear + o.eyeLen;
  const mountH = o.ay - o.r - o.y0 + 0.01;
  const pieces: Piece[] = [
    { geo: tube(o.r, len, 10), color: d, matrix: xf([0, o.ay, zMid]) },
    { geo: bell(o.r, o.rObj, o.objLen, 10), color: d, matrix: xf([0, o.ay, objZ]) },
    { geo: tube(o.rObj + 0.003, 0.022, 10), color: o.accent, matrix: xf([0, o.ay, objFront - 0.008]) },
    { geo: tube(o.rObj - 0.006, 0.006, 10), color: palette.lensGlass, matrix: xf([0, o.ay, objFront - 0.017]), outline: false },
    { geo: bell(o.rEye, o.r, o.eyeLen, 10), color: d, matrix: xf([0, o.ay, eyeZ]) },
    { geo: tube(o.rEye + 0.002, 0.014, 10), color: o.accent, matrix: xf([0, o.ay, eyeRear - 0.012]), outline: false },
    { geo: tube(o.rEye - 0.008, 0.006, 10), color: palette.lensGlass, matrix: xf([0, o.ay, eyeRear + 0.001]), outline: false },
    // turrets (top + right side)
    { geo: new THREE.CylinderGeometry(0.019, 0.019, 0.034, 6), color: o.accent, matrix: xf([0, o.ay + o.r + 0.012, zMid]) },
    { geo: tubeX(0.019, 0.034), color: o.accent, matrix: xf([o.r + 0.012, o.ay, zMid]) },
    // mounts
    { geo: box(0.034, mountH, 0.03), color: d, matrix: xf([0, o.y0 + mountH / 2 - 0.005, o.mounts[0]]) },
    { geo: box(0.034, mountH, 0.03), color: d, matrix: xf([0, o.y0 + mountH / 2 - 0.005, o.mounts[1]]) },
  ];
  return {
    pieces,
    sight: { type: o.type, eye: [0, o.ay, eyeRear + 0.08], rear: [0, o.ay, eyeRear], apertureRadius: o.rEye - 0.008 },
  };
}

// -------------------------------------------------------------------------------------------------
// Weapons
// -------------------------------------------------------------------------------------------------
function pistol(): WeaponSpec {
  const c = palette.pistol, d = palette.gunDark;
  const s = ironSights(0.095, 0.045, 0.095, -0.165, 0.4);
  return {
    muzzle: [0, 0.06, -0.205],
    sight: s.sight,
    pieces: [
      { geo: box(0.06, 0.12, 0.075), color: d, matrix: xf([0, -0.03, 0.02], [-0.25, 0, 0]) },
      { geo: box(0.07, 0.08, 0.24), color: c, matrix: xf([0, 0.055, -0.06]) },
      { geo: box(0.05, 0.025, 0.06), color: d, matrix: xf([0, 0.005, -0.03]), outline: false }, // trigger block
      { geo: tube(0.028, 0.04), color: palette.gunTip, matrix: xf([0, 0.06, -0.185]) },
      ...s.pieces,
    ],
  };
}

function smg(): WeaponSpec {
  const c = palette.smg, d = palette.gunDark;
  const s = ironSights(0.11, 0.07, 0.11, -0.23, 0.32);
  return {
    muzzle: [0, 0.07, -0.37],
    sight: s.sight,
    pieces: [
      { geo: box(0.08, 0.1, 0.34), color: c, matrix: xf([0, 0.06, -0.08]) },
      { geo: box(0.055, 0.12, 0.065), color: d, matrix: xf([0, -0.03, 0.04], [-0.25, 0, 0]) },
      { geo: box(0.05, 0.16, 0.06), color: d, matrix: xf([0, -0.05, -0.15], [0.12, 0, 0]) },
      { geo: tube(0.025, 0.1), color: d, matrix: xf([0, 0.07, -0.29]) },
      { geo: tube(0.032, 0.035), color: palette.gunTip, matrix: xf([0, 0.07, -0.35]) },
      { geo: box(0.05, 0.08, 0.14), color: d, matrix: xf([0, 0.025, 0.15]) },
      // yellow band wraps the body sides just below the top, clear of the iron-sight line
      { geo: box(0.085, 0.03, 0.07), color: palette.ammoLight, matrix: xf([0, 0.093, -0.12]), outline: false },
      ...s.pieces,
    ],
  };
}

function shotgun(): WeaponSpec {
  const c = palette.shotgun, d = palette.gunDark, w = palette.gunWood;
  const s = ironSights(0.115, 0.07, 0.121, -0.6, 0.32);
  return {
    muzzle: [0, 0.085, -0.64],
    sight: s.sight,
    pieces: [
      { geo: box(0.085, 0.11, 0.22), color: c, matrix: xf([0, 0.06, -0.02]) },
      { geo: tube(0.036, 0.46, 10), color: c, matrix: xf([0, 0.085, -0.36]) },
      { geo: tube(0.048, 0.18, 10), color: w, matrix: xf([0, 0.025, -0.3]) },
      { geo: tube(0.043, 0.04, 10), color: palette.gunTip, matrix: xf([0, 0.085, -0.61]) },
      { geo: box(0.07, 0.12, 0.3), color: w, matrix: xf([0, 0.0, 0.22], [0.15, 0, 0]) },
      { geo: box(0.055, 0.03, 0.05), color: d, matrix: xf([0, 0.0, -0.01]), outline: false },
      ...s.pieces,
    ],
  };
}

function rifle(): WeaponSpec {
  const c = palette.rifle, d = palette.gunDark;
  const s = redDot(0.115, -0.06, c);
  return {
    muzzle: [0, 0.075, -0.62],
    sight: s.sight,
    lens: s.lens,
    pieces: [
      { geo: box(0.075, 0.11, 0.32), color: c, matrix: xf([0, 0.06, -0.05]) },
      { geo: box(0.07, 0.075, 0.2), color: palette.sandDark, matrix: xf([0, 0.06, -0.3]) },
      { geo: tube(0.024, 0.22), color: d, matrix: xf([0, 0.075, -0.49]) },
      { geo: tube(0.032, 0.04), color: palette.gunTip, matrix: xf([0, 0.075, -0.6]) },
      { geo: box(0.05, 0.17, 0.08), color: d, matrix: xf([0, -0.06, -0.12], [0.25, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { geo: box(0.06, 0.12, 0.24), color: c, matrix: xf([0, 0.04, 0.25]) },
      ...s.pieces,
    ],
  };
}

/** Marksman rifle: cornflower, green heavy-ammo band, straight mag, 4x scope. ~1.12 m. */
function dmr(): WeaponSpec {
  const c = palette.dmr, d = palette.gunDark;
  const s = scope({
    y0: 0.115, ay: 0.172, zFront: -0.17, zRear: 0.05, r: 0.03, rObj: 0.044, objLen: 0.06,
    rEye: 0.038, eyeLen: 0.05, accent: c, mounts: [-0.13, 0.01], type: 'scope_4x',
  });
  return {
    muzzle: [0, 0.075, -0.715],
    sight: s.sight,
    pieces: [
      { geo: box(0.075, 0.11, 0.34), color: c, matrix: xf([0, 0.06, -0.06]) },
      { geo: box(0.068, 0.08, 0.24), color: c, matrix: xf([0, 0.065, -0.35]) },
      { geo: box(0.072, 0.084, 0.03), color: palette.ammoHeavy, matrix: xf([0, 0.065, -0.262]), outline: false },
      { geo: tube(0.022, 0.22), color: d, matrix: xf([0, 0.075, -0.57]) },
      { geo: tube(0.031, 0.045), color: palette.gunTip, matrix: xf([0, 0.075, -0.69]) },
      { geo: box(0.05, 0.14, 0.08), color: d, matrix: xf([0, -0.05, -0.14], [0.12, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { geo: box(0.06, 0.13, 0.26), color: c, matrix: xf([0, 0.035, 0.24]) },
      { geo: box(0.065, 0.15, 0.03), color: d, matrix: xf([0, 0.035, 0.385]) },
      ...s.pieces,
    ],
  };
}

/** Bolt-action sniper: navy body, pink accents (ammo_sniper family), long barrel, big 8x scope. ~1.32 m. */
function sniper(): WeaponSpec {
  const c = palette.sniper, d = palette.gunDark, p = palette.ammoSniper;
  const s = scope({
    y0: 0.11, ay: 0.178, zFront: -0.27, zRear: 0.11, r: 0.033, rObj: 0.056, objLen: 0.1,
    rEye: 0.044, eyeLen: 0.07, accent: p, mounts: [-0.17, 0.03], type: 'scope_8x',
  });
  return {
    muzzle: [0, 0.075, -0.92],
    sight: s.sight,
    pieces: [
      { geo: box(0.075, 0.1, 0.32), color: c, matrix: xf([0, 0.06, -0.04]) },
      { geo: box(0.07, 0.075, 0.36), color: c, matrix: xf([0, 0.05, -0.38]) },
      { geo: box(0.074, 0.079, 0.03), color: p, matrix: xf([0, 0.05, -0.545]), outline: false },
      { geo: tube(0.02, 0.36), color: d, matrix: xf([0, 0.075, -0.7]) },
      { geo: tube(0.034, 0.07), color: palette.gunTip, matrix: xf([0, 0.075, -0.885]) },
      { geo: box(0.05, 0.07, 0.08), color: d, matrix: xf([0, -0.015, -0.1]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.06], [-0.3, 0, 0]) },
      { geo: box(0.065, 0.13, 0.26), color: c, matrix: xf([0, 0.035, 0.25]) },
      { geo: box(0.05, 0.035, 0.13), color: p, matrix: xf([0, 0.113, 0.26]) }, // cheek riser
      { geo: box(0.07, 0.15, 0.03), color: p, matrix: xf([0, 0.035, 0.395]) }, // butt pad
      { geo: tubeX(0.012, 0.08), color: d, matrix: xf([0.07, 0.085, 0.07]) }, // bolt
      { geo: new THREE.SphereGeometry(0.024, 6, 4), color: p, matrix: xf([0.115, 0.085, 0.07]) },
      { geo: box(0.016, 0.016, 0.22), color: d, matrix: xf([-0.022, 0.005, -0.45]), outline: false }, // folded bipod
      { geo: box(0.016, 0.016, 0.22), color: d, matrix: xf([0.022, 0.005, -0.45]), outline: false },
      ...s.pieces,
    ],
  };
}

/** Light machine gun: chunky tangerine body, dark drum mag, barrel shroud, folded bipod, red dot. ~1.11 m. */
function lmg(): WeaponSpec {
  const c = palette.lmg, d = palette.gunDark;
  const s = redDot(0.135, -0.07, c);
  return {
    muzzle: [0, 0.075, -0.71],
    sight: s.sight,
    lens: s.lens,
    pieces: [
      { geo: box(0.1, 0.14, 0.38), color: c, matrix: xf([0, 0.065, -0.05]) },
      { geo: tube(0.045, 0.28), color: d, matrix: xf([0, 0.075, -0.38]) },
      { geo: tube(0.048, 0.025), color: c, matrix: xf([0, 0.075, -0.33]), outline: false },
      { geo: tube(0.048, 0.025), color: c, matrix: xf([0, 0.075, -0.44]), outline: false },
      { geo: tube(0.022, 0.14), color: d, matrix: xf([0, 0.075, -0.59]) },
      { geo: tube(0.034, 0.05), color: palette.gunTip, matrix: xf([0, 0.075, -0.68]) },
      { geo: new THREE.CylinderGeometry(0.085, 0.085, 0.09, 10).rotateZ(HALF_PI), color: d, matrix: xf([0, -0.07, -0.13]) }, // drum
      { geo: new THREE.CylinderGeometry(0.05, 0.05, 0.096, 8).rotateZ(HALF_PI), color: c, matrix: xf([0, -0.07, -0.13]), outline: false },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.07], [-0.3, 0, 0]) },
      { geo: box(0.075, 0.12, 0.24), color: c, matrix: xf([0, 0.045, 0.26]) },
      { geo: box(0.08, 0.14, 0.03), color: d, matrix: xf([0, 0.045, 0.395]) },
      { geo: box(0.018, 0.018, 0.24), color: d, matrix: xf([-0.03, 0.02, -0.4]), outline: false }, // folded bipod
      { geo: box(0.018, 0.018, 0.24), color: d, matrix: xf([0.03, 0.02, -0.4]), outline: false },
      ...s.pieces,
    ],
  };
}

/**
 * Factories per gun id. Typed as a string record so new ids compile before and after `WeaponId` grows
 * (M2a adds dmr / sniper / lmg).
 */
const SPECS: Readonly<Record<string, () => WeaponSpec>> = { pistol, smg, shotgun, rifle, dmr, sniper, lmg };

/** Gun ids this module can build (fists has no model). */
export const WEAPON_MODEL_IDS: readonly string[] = Object.keys(SPECS);

/** Render-side default sight per weapon, matching the M2a brief. */
export const WEAPON_SIGHT_TYPES: Readonly<Record<string, SightType>> = {
  pistol: 'iron', smg: 'iron', shotgun: 'iron', rifle: 'red_dot', lmg: 'red_dot', dmr: 'scope_4x', sniper: 'scope_8x',
};

interface CachedWeapon { merged: Merged; muzzle: V3; sight: WeaponSight; lens: THREE.BufferGeometry | null }
const cache = new Map<string, CachedWeapon>();

/** Shared geometry for a gun (used by loot too). Null for fists / unknown ids. */
export function getWeaponGeometry(id: WeaponId | string): CachedWeapon | null {
  if (id === 'fists') return null;
  const make = Object.prototype.hasOwnProperty.call(SPECS, id) ? SPECS[id] : undefined;
  if (!make) return null;
  let c = cache.get(id);
  if (!c) {
    const spec = make();
    const lens = spec.lens?.length ? buildMerged(spec.lens, `weapon:${id}:lens`).geometry : null;
    c = { merged: buildMerged(spec.pieces, `weapon:${id}`), muzzle: spec.muzzle, sight: spec.sight, lens };
    cache.set(id, c);
  }
  return c;
}

/**
 * Sight data for a weapon in the weapon frame (origin at the grip, barrel -Z, +Y up), or null for fists /
 * unknown ids. `eye` is where the ADS camera (or the scope overlay's virtual eye) sits; the line of sight
 * runs from `eye` along -Z, parallel to the barrel.
 */
export function getWeaponSight(id: WeaponId | string): WeaponSight | null {
  return getWeaponGeometry(id)?.sight ?? null;
}

let lensMat: THREE.MeshBasicMaterial | null = null;
/** See-through red-dot glass: pale aqua tint, unlit, no depth write (first-person ADS looks through it). */
export function sightLensMaterial(): THREE.MeshBasicMaterial {
  return (lensMat ??= Object.assign(
    new THREE.MeshBasicMaterial({ color: palette.lensGlass, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }),
    { name: 'weapon:lens' },
  ));
}

/**
 * Held weapon model, or null for fists / unknown ids. Add to `hand_R_socket` / `handR`. Contains a mesh named
 * 'weapon' (with an 'outline' child), an empty 'muzzle' at the barrel tip and an empty 'sight' at the eye point.
 * Red-dot guns also have a 'lens' mesh (see-through glass, sightLensMaterial).
 * root.userData = { weaponId, sightType }.
 */
export function createWeaponModel(id: WeaponId | string): THREE.Object3D | null {
  const c = getWeaponGeometry(id);
  if (!c) return null;
  const root = new THREE.Group();
  root.name = `weapon:${id}`;
  root.userData.weaponId = id;
  root.userData.sightType = c.sight.type;
  const mesh = new THREE.Mesh(c.merged.geometry, vertexColorToon());
  mesh.name = 'weapon';
  mesh.castShadow = true;
  if (c.merged.outline) addOutline(mesh, OUTLINE.small, palette.ink, c.merged.outline);
  root.add(mesh);
  if (c.lens) {
    const lens = new THREE.Mesh(c.lens, sightLensMaterial());
    lens.name = 'lens';
    lens.renderOrder = 1;
    lens.raycast = () => {};
    root.add(lens);
  }
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(c.muzzle[0], c.muzzle[1], c.muzzle[2]);
  root.add(muzzle);
  const sight = new THREE.Object3D();
  sight.name = 'sight';
  sight.position.set(c.sight.eye[0], c.sight.eye[1], c.sight.eye[2]);
  sight.userData.sightType = c.sight.type;
  sight.userData.rear = c.sight.rear;
  sight.userData.apertureRadius = c.sight.apertureRadius;
  root.add(sight);
  return root;
}
