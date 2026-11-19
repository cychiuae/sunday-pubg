/**
 * Toy-like weapon models: guns and (M2c) melee. Owner: graphics-designer.
 * Spec: docs/art/STYLE.md "Weapons" / "Sights"; docs/art/M2c.md §1.4 (collar), §2 (new weapons), §14 (scopes),
 * §15 (a model per item level).
 *
 * Frame: origin at the grip (where the hand closes), barrel or blade along -Z, top of the weapon +Y.
 * Children of every model returned by createWeaponModel(id, { level, scope }):
 *   'weapon'  vertex-coloured mesh (+ 'outline' hull child)
 *   'lens'    see-through red-dot glass (only when the effective sight is a red dot)
 *   'muzzle'  guns: empty at the barrel tip (muzzle flash / tracer origin). dbshotgun adds 'muzzleL' / 'muzzleR'.
 *   'sight'   guns: empty at the EYE POINT of the effective sight (ADS camera). -Z = line of sight, +Y up.
 *             userData { sightType, rear, apertureRadius }.
 *   'rail'    guns with a rail: empty at the rail anchor (top of the receiver, mount centre). userData.railLength.
 *   'collar'  empty at the level collar centre (VFX anchor for the optional L4 glint), only when a level is given.
 *   extra named anchors per weapon: melee 'tip' + 'swingTrail'; rpg 'exhaust' + 'rocketSeat'; revolver 'cylinder'.
 * root.userData = { weaponId, sightType, level, scope, holdOffset? }.
 *
 * LEVELS (Addendum 2): each level is its own model built from shared parts + a per-level dressing (levelCollar.ts):
 * L1 makeshift (dulled, taped, cord loop), L2 standard (the M2b model), L3 upgraded (muzzle device, ribbed grip),
 * L4 sleek (L3 + swept fin, chrome trims, star badge). The anchors above are identical at every level (unit-tested).
 * With no level given, the model is the L2 look WITHOUT a collar (the M2b model, unchanged).
 *
 * SCOPES: the effective optic is `opts.scope` if it fits the rail, else the weapon's built-in optic (rifle / lmg red
 * dot, dmr 4x, sniper 8x), else its iron sights. Iron sights are dropped while an optic is mounted.
 * Geometry is cached per (id, level, scope) and shared. `getWeaponAnchors(id, { level, scope })` gives every anchor as
 * plain data for batched drawing. Every part except the red-dot lens uses vertexColorToon() + the OUTLINE.small hull
 * (one material pair for all weapons, so they batch).
 */
import * as THREE from 'three';
import type { ItemLevel, ScopeId, WeaponId } from '../../shared/types';
import { buildMerged, xf, type ColorFn, type Merged, type Piece, type V3 } from './builder';
import { clampLevel, collarPieces, levelDressPieces, levelTone, type CollarSpec, type LevelDress } from './levelCollar';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';
import { MELEE_DESIGNS } from './melee';
import { mountedScopePieces, SCOPE_GEOMETRY, scopeFitsRail } from './scopes';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder lying along Z. */
const tube = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(HALF_PI);
/** Cylinder along X. */
const tubeX = (r: number, len: number, seg = 6) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(HALF_PI);

/** Sight type per weapon (render-side names; equal to the shared M2c sight types). */
export type SightType = 'iron' | 'red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x';

export interface WeaponSight {
  type: SightType;
  /** Eye point in the weapon frame (metres). The line of sight runs from here along -Z. */
  eye: V3;
  /** Centre of the sight's rear aperture / rear lens in the weapon frame (the eye looks through this). */
  rear: V3;
  /** Radius of the rear aperture or lens (m); 0 for iron sights. */
  apertureRadius: number;
}

/** Rail anchor: top surface of the receiver at the mount centre, and the usable length along Z. */
export interface WeaponRail { pos: V3; length: number }

/**
 * One weapon's design: shared pieces + the parts that change with level and sight. Melee designs (melee.ts) use the
 * same shape with no sights, rail or muzzle.
 */
export interface WeaponDesign {
  kind: 'gun' | 'melee';
  /** Shared pieces at every level (no sights). Colours listed in `family` are toned per level (levelTone). */
  pieces: Piece[];
  family: readonly number[];
  /** Built-in iron sights (dropped when an optic is mounted). */
  iron?: { pieces: Piece[]; sight: WeaponSight };
  /** Built-in optic, drawn as that scope's model on the rail. */
  defaultScope?: ScopeId;
  muzzle?: V3;
  rail?: WeaponRail;
  collar: CollarSpec;
  dress: LevelDress;
  /** Extra named empties (weapon frame). */
  anchors?: Readonly<Record<string, V3>>;
  /** Third-person socket offset hint (rpg on the shoulder). */
  holdOffset?: V3;
}

// -------------------------------------------------------------------------------------------------
// Iron sights
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

// -------------------------------------------------------------------------------------------------
// The seven M2a/M2b guns (geometry unchanged; sights moved to iron / rail, plus collar + level dressing anchors)
// -------------------------------------------------------------------------------------------------
function pistol(): WeaponDesign {
  const c = palette.pistol, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.06, -0.205],
    iron: ironSights(0.095, 0.045, 0.095, -0.165, 0.4),
    rail: { pos: [0, 0.095, -0.04], length: 0.1 },
    collar: { shape: 'box', y: 0.055, z: -0.1, w: 0.07, h: 0.08 },
    pieces: [
      { geo: box(0.06, 0.12, 0.075), color: d, matrix: xf([0, -0.03, 0.02], [-0.25, 0, 0]) },
      { geo: box(0.07, 0.08, 0.24), color: c, matrix: xf([0, 0.055, -0.06]) },
      { geo: box(0.05, 0.025, 0.06), color: d, matrix: xf([0, 0.005, -0.03]), outline: false }, // trigger block
      { geo: tube(0.028, 0.04), color: palette.gunTip, matrix: xf([0, 0.06, -0.185]) },
    ],
    dress: {
      wraps: [{ shape: 'box', y: 0.055, z: -0.02, w: 0.07, h: 0.08 }, { shape: 'box', y: -0.035, z: 0.025, w: 0.06, h: 0.06 }],
      loop: [0, -0.085, 0.045],
      brake: { c: [0, 0.06, -0.152], r: 0.037, len: 0.022 },
      grip: { c: [0, -0.03, 0.02], w: 0.06, h: 0.12, d: 0.075, rx: -0.25 },
      fin: { c: [0, 0.015, -0.12], len: 0.08, h: 0.03 },
      trim: { y: 0.078, z0: -0.17, z1: 0.05, x: 0.035 },
      star: [-0.035, 0.05, -0.03],
    },
  };
}

function smg(): WeaponDesign {
  const c = palette.smg, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.07, -0.37],
    iron: ironSights(0.11, 0.07, 0.11, -0.23, 0.32),
    rail: { pos: [0, 0.11, -0.06], length: 0.16 },
    collar: { shape: 'box', y: 0.06, z: -0.21, w: 0.08, h: 0.1 },
    pieces: [
      { geo: box(0.08, 0.1, 0.34), color: c, matrix: xf([0, 0.06, -0.08]) },
      { geo: box(0.055, 0.12, 0.065), color: d, matrix: xf([0, -0.03, 0.04], [-0.25, 0, 0]) },
      { geo: box(0.05, 0.16, 0.06), color: d, matrix: xf([0, -0.05, -0.15], [0.12, 0, 0]) },
      { geo: tube(0.025, 0.1), color: d, matrix: xf([0, 0.07, -0.29]) },
      { geo: tube(0.032, 0.035), color: palette.gunTip, matrix: xf([0, 0.07, -0.35]) },
      { geo: box(0.05, 0.08, 0.14), color: d, matrix: xf([0, 0.025, 0.15]) },
      // yellow band wraps the body sides just below the top, clear of the iron-sight line
      { geo: box(0.085, 0.03, 0.07), color: palette.ammoLight, matrix: xf([0, 0.093, -0.12]), outline: false },
    ],
    dress: {
      wraps: [{ shape: 'box', y: 0.06, z: 0.0, w: 0.08, h: 0.1 }, { shape: 'box', y: -0.06, z: -0.15, w: 0.05, h: 0.06 }],
      loop: [0, 0.0, 0.22],
      brake: { c: [0, 0.07, -0.307], r: 0.031, len: 0.026 },
      grip: { c: [0, -0.03, 0.04], w: 0.055, h: 0.12, d: 0.065, rx: -0.25 },
      fin: { c: [0, 0.01, -0.215], len: 0.06, h: 0.04 },
      trim: { y: 0.085, z0: -0.24, z1: 0.08, x: 0.04 },
      star: [-0.04, 0.05, -0.05],
    },
  };
}

function shotgun(): WeaponDesign {
  const c = palette.shotgun, d = palette.gunDark, w = palette.gunWood;
  return {
    kind: 'gun', family: [c, w], muzzle: [0, 0.085, -0.64],
    iron: ironSights(0.115, 0.07, 0.121, -0.6, 0.32),
    rail: { pos: [0, 0.115, -0.02], length: 0.16 },
    collar: { shape: 'box', y: 0.06, z: -0.1, w: 0.085, h: 0.11 },
    pieces: [
      { geo: box(0.085, 0.11, 0.22), color: c, matrix: xf([0, 0.06, -0.02]) },
      { geo: tube(0.036, 0.46, 10), color: c, matrix: xf([0, 0.085, -0.36]) },
      { geo: tube(0.048, 0.18, 10), color: w, matrix: xf([0, 0.025, -0.3]) },
      { geo: tube(0.043, 0.04, 10), color: palette.gunTip, matrix: xf([0, 0.085, -0.61]) },
      { geo: box(0.07, 0.12, 0.3), color: w, matrix: xf([0, 0.0, 0.22], [0.15, 0, 0]) },
      { geo: box(0.055, 0.03, 0.05), color: d, matrix: xf([0, 0.0, -0.01]), outline: false },
    ],
    dress: {
      wraps: [{ shape: 'round', y: 0.085, z: -0.47, r: 0.036 }, { shape: 'box', y: 0.0, z: 0.2, w: 0.07, h: 0.12 }],
      loop: [0, -0.04, 0.36],
      brake: { c: [0, 0.085, -0.572], r: 0.044, len: 0.028 },
      grip: { c: [0, 0.025, -0.3], w: 0.096, h: 0.096, d: 0.16, rx: 0 },
      fin: { c: [0, 0.04, -0.46], len: 0.12, h: 0.04 },
      trim: { y: 0.085, z0: -0.12, z1: 0.08, x: 0.0425 },
      star: [-0.0425, 0.06, -0.03],
    },
  };
}

function rifle(): WeaponDesign {
  const c = palette.rifle, d = palette.gunDark;
  return {
    kind: 'gun', family: [c, palette.sandDark], muzzle: [0, 0.075, -0.62],
    defaultScope: 'scope_red_dot',
    rail: { pos: [0, 0.115, -0.06], length: 0.24 },
    collar: { shape: 'box', y: 0.06, z: -0.18, w: 0.075, h: 0.11 },
    pieces: [
      { geo: box(0.075, 0.11, 0.32), color: c, matrix: xf([0, 0.06, -0.05]) },
      { geo: box(0.07, 0.075, 0.2), color: palette.sandDark, matrix: xf([0, 0.06, -0.3]) },
      { geo: tube(0.024, 0.22), color: d, matrix: xf([0, 0.075, -0.49]) },
      { geo: tube(0.032, 0.04), color: palette.gunTip, matrix: xf([0, 0.075, -0.6]) },
      { geo: box(0.05, 0.17, 0.08), color: d, matrix: xf([0, -0.06, -0.12], [0.25, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { geo: box(0.06, 0.12, 0.24), color: c, matrix: xf([0, 0.04, 0.25]) },
    ],
    dress: {
      wraps: [{ shape: 'box', y: 0.06, z: -0.33, w: 0.07, h: 0.075 }, { shape: 'box', y: 0.04, z: 0.25, w: 0.06, h: 0.12 }],
      loop: [0, -0.02, 0.37],
      brake: { c: [0, 0.075, -0.565], r: 0.032, len: 0.028 },
      grip: { c: [0, -0.03, 0.05], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.02, -0.33], len: 0.16, h: 0.04 },
      trim: { y: 0.085, z0: -0.2, z1: 0.36, x: 0.0375 },
      star: [-0.0375, 0.06, -0.02],
    },
  };
}

/** Marksman rifle: cornflower, green heavy-ammo band, straight mag, 4x scope. ~1.12 m. */
function dmr(): WeaponDesign {
  const c = palette.dmr, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.715],
    defaultScope: 'scope_4x',
    rail: { pos: [0, 0.115, -0.06], length: 0.26 },
    collar: { shape: 'box', y: 0.06, z: -0.205, w: 0.075, h: 0.11 },
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
    ],
    dress: {
      wraps: [{ shape: 'box', y: 0.065, z: -0.41, w: 0.068, h: 0.08 }, { shape: 'box', y: 0.035, z: 0.22, w: 0.06, h: 0.13 }],
      loop: [0, -0.04, 0.39],
      brake: { c: [0, 0.075, -0.652], r: 0.03, len: 0.028 },
      grip: { c: [0, -0.03, 0.05], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.025, -0.38], len: 0.16, h: 0.04 },
      trim: { y: 0.09, z0: -0.22, z1: 0.36, x: 0.0375 },
      star: [-0.0375, 0.06, -0.1],
    },
  };
}

/** Bolt-action sniper: navy body, pink accents (ammo_sniper family), long barrel, big 8x scope. ~1.32 m. */
function sniper(): WeaponDesign {
  const c = palette.sniper, d = palette.gunDark, p = palette.ammoSniper;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.92],
    defaultScope: 'scope_8x',
    rail: { pos: [0, 0.11, -0.07], length: 0.3 },
    collar: { shape: 'box', y: 0.05, z: -0.23, w: 0.07, h: 0.075 },
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
    ],
    dress: {
      wraps: [{ shape: 'box', y: 0.05, z: -0.46, w: 0.07, h: 0.075 }, { shape: 'box', y: 0.035, z: 0.2, w: 0.065, h: 0.13 }],
      loop: [0, -0.04, 0.39],
      brake: { c: [0, 0.075, -0.835], r: 0.03, len: 0.026 },
      grip: { c: [0, -0.03, 0.06], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.055, -0.66], len: 0.14, h: 0.035 },
      trim: { y: 0.085, z0: -0.2, z1: 0.37, x: 0.0375 },
      star: [-0.0375, 0.06, -0.04],
    },
  };
}

/** Light machine gun: chunky tangerine body, dark drum mag, barrel shroud, folded bipod, red dot. ~1.11 m. */
function lmg(): WeaponDesign {
  const c = palette.lmg, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.71],
    defaultScope: 'scope_red_dot',
    rail: { pos: [0, 0.135, -0.07], length: 0.24 },
    collar: { shape: 'box', y: 0.065, z: -0.2, w: 0.1, h: 0.14 },
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
    ],
    dress: {
      wraps: [{ shape: 'round', y: 0.075, z: -0.5, r: 0.045 }, { shape: 'box', y: 0.045, z: 0.24, w: 0.075, h: 0.12 }],
      loop: [0, -0.02, 0.41],
      brake: { c: [0, 0.075, -0.642], r: 0.03, len: 0.026 },
      grip: { c: [0, -0.03, 0.07], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.03, -0.5], len: 0.14, h: 0.04 },
      trim: { y: 0.1, z0: -0.24, z1: 0.37, x: 0.05 },
      star: [-0.05, 0.065, -0.06],
    },
  };
}

// -------------------------------------------------------------------------------------------------
// M2c guns (docs/art/M2c.md §2.2)
// -------------------------------------------------------------------------------------------------
/** Sand Dollar Revolver: sky frame, sand-dollar 6-flute cylinder, walnut bird's-head grip, green heavy band. 0.34 m. */
function revolver(): WeaponDesign {
  const c = palette.revolver, d = palette.gunDark, sd = palette.sandDollar, wal = palette.walnut;
  const P: Piece[] = [
    { geo: box(0.045, 0.11, 0.058), color: wal, matrix: xf([0, -0.035, 0.022], [-0.35, 0, 0]) }, // grip
    { geo: new THREE.SphereGeometry(0.03, 6, 3), color: wal, matrix: xf([0, -0.085, 0.045], [0, 0, 0], [0.75, 0.7, 1]) }, // bird's head
    { geo: box(0.05, 0.045, 0.12), color: c, matrix: xf([0, 0.035, -0.045]) }, // lower frame
    { geo: new THREE.CylinderGeometry(0.034, 0.034, 0.055, 6).rotateX(HALF_PI), color: sd, matrix: xf([0, 0.062, -0.05]), flat: true }, // cylinder
    { geo: box(0.03, 0.012, 0.1), color: c, matrix: xf([0, 0.099, -0.06]) }, // top strap
    { geo: new THREE.CylinderGeometry(0.017, 0.017, 0.15, 6).rotateX(HALF_PI), color: c, matrix: xf([0, 0.075, -0.155]), flat: true }, // barrel
    { geo: box(0.012, 0.012, 0.15), color: c, matrix: xf([0, 0.095, -0.155]) }, // top rib
    { geo: tube(0.022, 0.025), color: palette.gunTip, matrix: xf([0, 0.075, -0.2375]) },
    { geo: tube(0.0185, 0.02, 6), color: palette.ammoHeavy, matrix: xf([0, 0.075, -0.13]), outline: false },
    { geo: box(0.012, 0.03, 0.02), color: d, matrix: xf([0, 0.098, 0.012], [-0.5, 0, 0]) }, // hammer
    { geo: new THREE.TorusGeometry(0.02, 0.005, 3, 6, Math.PI), color: d, matrix: xf([0, 0.006, -0.03], [0, HALF_PI, Math.PI]) }, // trigger guard
  ];
  // sand-dollar petals: 5 dark dots on the cylinder's rear face (decal)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    P.push({ geo: new THREE.SphereGeometry(1, 4, 2), color: palette.sandDollarDots, matrix: xf([Math.cos(a) * 0.018, 0.062 + Math.sin(a) * 0.018, -0.022], [HALF_PI, 0, 0], [0.005, 0.002, 0.009]), outline: false });
  }
  return {
    kind: 'gun', family: [c, sd, wal], muzzle: [0, 0.075, -0.25],
    iron: ironSights(0.105, -0.015, 0.101, -0.215, 0.38),
    rail: { pos: [0, 0.105, -0.06], length: 0.1 },
    collar: { shape: 'round', y: 0.075, z: -0.105, r: 0.019, len: 0.046 },
    anchors: { cylinder: [0, 0.062, -0.05] },
    pieces: P,
    dress: {
      wraps: [{ shape: 'box', y: -0.04, z: 0.025, w: 0.045, h: 0.05 }, { shape: 'round', y: 0.075, z: -0.19, r: 0.017 }],
      loop: [0, -0.09, 0.05],
      brake: { c: [0, 0.075, -0.212], r: 0.024, len: 0.024 },
      grip: { c: [0, -0.035, 0.022], w: 0.045, h: 0.11, d: 0.058, rx: -0.35 },
      fin: { c: [0, 0.058, -0.17], len: 0.08, h: 0.025 },
      trim: { y: 0.04, z0: -0.1, z1: 0.01, x: 0.025 },
      star: [-0.025, 0.035, -0.06],
    },
  };
}

/** Double Scoop Shotgun: mint side-by-side barrels, waffle-cone stock, strawberry + vanilla toy tips. 0.92 m. */
function dbshotgun(): WeaponDesign {
  const m = palette.dbBarrel, d = palette.gunDark, waf = palette.waffle, wood = palette.gunWood;
  const waffleCheck: ColorFn = (_n, cen) => {
    const i = Math.floor((cen.z + 1) * 40) + Math.floor((cen.y + 1) * 40);
    return i % 2 ? palette.waffleDark : waf;
  };
  const P: Piece[] = [
    // waffle-cone stock: a 4-sided tapered block, wide at the butt, diamond checker
    { geo: new THREE.CylinderGeometry(0.045, 0.075, 0.3, 4, 3).rotateX(HALF_PI).rotateZ(Math.PI / 4), color: waf, matrix: xf([0, 0.02, 0.2], [0.12, 0, 0], [0.8, 1.15, 1]), flat: true, colorFn: waffleCheck },
    { geo: box(0.045, 0.06, 0.09), color: wood, matrix: xf([0, 0.005, 0.03], [-0.2, 0, 0]) }, // wrist
    { geo: box(0.09, 0.085, 0.12), color: d, matrix: xf([0, 0.075, -0.02]) }, // breech
    { geo: tubeX(0.012, 0.1), color: d, matrix: xf([0, 0.045, -0.075]) }, // hinge pin
    { geo: box(0.1, 0.05, 0.2), color: wood, matrix: xf([0, 0.045, -0.2]) }, // fore-end
    { geo: box(0.016, 0.012, 0.5), color: d, matrix: xf([0, 0.12, -0.33]) }, // rib
    { geo: new THREE.TorusGeometry(0.022, 0.005, 3, 6, Math.PI), color: d, matrix: xf([0, 0.01, -0.035], [0, HALF_PI, Math.PI]) },
  ];
  for (const s of [-1, 1]) {
    P.push({ geo: tube(0.03, 0.5, 8), color: m, matrix: xf([s * 0.031, 0.09, -0.33]) });
    P.push({ geo: tube(0.0315, 0.02, 8), color: palette.ammoShell, matrix: xf([s * 0.031, 0.09, -0.105]), outline: false });
    P.push({ geo: tube(0.034, 0.04, 8), color: s < 0 ? palette.scoopPink : palette.gunTip, matrix: xf([s * 0.031, 0.09, -0.6]) });
  }
  return {
    kind: 'gun', family: [m, waf, wood], muzzle: [0, 0.09, -0.62],
    iron: ironSights(0.1175, -0.05, 0.126, -0.57, 0.35),
    rail: { pos: [0, 0.1175, 0.0], length: 0.1 },
    collar: { shape: 'box', y: 0.075, z: -0.045, w: 0.09, h: 0.085 },
    anchors: { muzzleL: [-0.031, 0.09, -0.62], muzzleR: [0.031, 0.09, -0.62] },
    pieces: P,
    dress: {
      wraps: [{ shape: 'box', y: 0.09, z: -0.42, w: 0.124, h: 0.062 }, { shape: 'box', y: 0.005, z: 0.03, w: 0.045, h: 0.06 }],
      loop: [0, -0.04, 0.35],
      brake: { c: [0, 0.09, -0.55], r: 0.07, len: 0.022 },
      grip: { c: [0, 0.045, -0.2], w: 0.1, h: 0.05, d: 0.2, rx: 0 },
      fin: { c: [0, 0.02, -0.38], len: 0.14, h: 0.04 },
      trim: { y: 0.075, z0: -0.07, z1: 0.04, x: 0.045 },
      star: [-0.045, 0.075, 0.0],
    },
  };
}

/** Sunburst Launcher: cream tube with a coral spiral, mango sunburst decals, sunburst-ring sight. 1.0 m. */
function rpg(): WeaponDesign {
  const cr = palette.rpgTube, co = palette.rpgStripe, d = palette.gunDark;
  const AY = 0.1, R = 0.06;
  const spiral: ColorFn = (_n, cen) => {
    const a = Math.atan2(cen.x, cen.y - AY) / (Math.PI * 2);
    const f = (((a + cen.z * 1.6) % 1) + 1) % 1;
    return f < 0.3 ? co : cr;
  };
  const sun = (s: number): Piece => {
    const shape = new THREE.Shape();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const rr = i % 2 ? 0.02 : 0.036;
      if (i === 0) shape.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else shape.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    return { geo: new THREE.ShapeGeometry(shape).rotateY(s * HALF_PI), color: palette.sunburst, matrix: xf([s * (R + 0.002), AY, -0.12]), outline: false };
  };
  const lineY = 0.26;
  const P: Piece[] = [
    { geo: new THREE.CylinderGeometry(R, R, 1.0, 10, 8, true).rotateX(HALF_PI), color: cr, matrix: xf([0, AY, -0.08]), colorFn: spiral },
    { geo: tube(R + 0.006, 0.04, 10), color: co, matrix: xf([0, AY, 0.4]) },
    { geo: tube(R + 0.006, 0.04, 10), color: co, matrix: xf([0, AY, -0.56]) },
    { geo: tube(R - 0.004, 0.004, 10), color: d, matrix: xf([0, AY, 0.418]), outline: false }, // dark exhaust inside
    { geo: new THREE.ConeGeometry(0.045, 0.08, 8).rotateX(-HALF_PI), color: co, matrix: xf([0, AY, -0.53]), outline: false }, // loaded rocket nose
    { geo: box(0.045, 0.11, 0.06), color: d, matrix: xf([0, -0.02, 0.0], [-0.25, 0, 0]) }, // grip
    { geo: box(0.04, 0.035, 0.08), color: d, matrix: xf([0, 0.035, -0.01]) }, // grip block under the tube
    { geo: box(0.04, 0.09, 0.05), color: d, matrix: xf([0, -0.0, -0.25], [0.15, 0, 0]) }, // front grip
    { geo: box(0.008, lineY - (AY + R) - 0.02, 0.01), color: d, matrix: xf([0, (AY + R + lineY - 0.02) / 2, -0.02]) }, // rear post
    { geo: new THREE.TorusGeometry(0.02, 0.005, 4, 10), color: d, matrix: xf([0, lineY, -0.02]), outline: false }, // ring aperture
    { geo: box(0.008, lineY - (AY + R), 0.012), color: d, matrix: xf([0, (AY + R + lineY) / 2, -0.44]) }, // front post (tip = aim)
    sun(-1), sun(1),
  ];
  // 4 short sun rays round the ring (decal, no hull)
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    P.push({ geo: box(0.004, 0.012, 0.004), color: palette.sunburst, matrix: xf([Math.cos(a) * 0.031, lineY + Math.sin(a) * 0.031, -0.02], [0, 0, a - HALF_PI]), outline: false });
  }
  return {
    kind: 'gun', family: [cr, co], muzzle: [0, AY, -0.6],
    iron: { pieces: [], sight: { type: 'iron', eye: [0, lineY, 0.28], rear: [0, lineY, -0.02], apertureRadius: 0.02 } },
    collar: { shape: 'round', y: AY, z: 0.02, r: R, len: 0.05 },
    anchors: { exhaust: [0, AY, 0.42], rocketSeat: [0, AY, -0.52] },
    holdOffset: [0, 0.1, 0.05],
    pieces: P,
    dress: {
      wraps: [{ shape: 'round', y: AY, z: -0.3, r: R }, { shape: 'round', y: AY, z: 0.25, r: R }],
      loop: [0, AY - R, 0.3],
      brake: { c: [0, AY, -0.5], r: R + 0.016, len: 0.03 },
      grip: { c: [0, -0.0, -0.25], w: 0.04, h: 0.09, d: 0.05, rx: 0.15 },
      fin: { c: [0, AY - R + 0.005, 0.3], len: 0.14, h: 0.05 },
      trim: { y: AY, z0: -0.5, z1: 0.36, x: R },
      star: [-(R + 0.002), AY + 0.035, 0.2],
    },
  };
}

/**
 * Weapon designs per id. Typed as a string record so ids compile before and after `WeaponId` grows (M2c adds melee,
 * dbshotgun, revolver and rpg at the C-gate).
 */
const DESIGNS: Readonly<Record<string, () => WeaponDesign>> = {
  pistol, smg, shotgun, rifle, dmr, sniper, lmg, revolver, dbshotgun, rpg, ...MELEE_DESIGNS,
};

/** Weapon ids this module can build (fists has no model). Guns and melee. */
export const WEAPON_MODEL_IDS: readonly string[] = Object.keys(DESIGNS);
/** The 13 levelled weapons (Addendum 2), the 7 M2b guns first. */
export const LEVELLED_WEAPON_IDS: readonly string[] = [
  'pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'revolver', 'dbshotgun', 'rpg', 'knife', 'machete', 'paddle',
];

/** Render-side default sight per gun (the balance `weapons.<id>.sight`); melee has none. */
export const WEAPON_SIGHT_TYPES: Readonly<Record<string, SightType>> = {
  pistol: 'iron', smg: 'iron', shotgun: 'iron', rifle: 'red_dot', lmg: 'red_dot', dmr: 'scope_4x', sniper: 'scope_8x',
  revolver: 'iron', dbshotgun: 'iron', rpg: 'iron',
};

const designCache = new Map<string, WeaponDesign>();
function designOf(id: string): WeaponDesign | null {
  if (id === 'fists' || !Object.prototype.hasOwnProperty.call(DESIGNS, id)) return null;
  let d = designCache.get(id);
  if (!d) designCache.set(id, (d = DESIGNS[id]()));
  return d;
}

export interface WeaponModelOptions {
  /** Item level 1..4 (other numbers are clamped). Absent = the M2b look (L2 parts) with no collar. */
  level?: ItemLevel | number | null;
  /** Mounted scope. Ignored if it does not fit the rail (then the built-in sight shows). */
  scope?: ScopeId | null;
}

export interface CachedWeapon {
  merged: Merged;
  /** Barrel tip; null for melee. */
  muzzle: V3 | null;
  /** Effective sight; null for melee. */
  sight: WeaponSight | null;
  lens: THREE.BufferGeometry | null;
  rail: WeaponRail | null;
  level: ItemLevel | null;
  scope: ScopeId | null;
  collar: V3 | null;
  anchors: Readonly<Record<string, V3>>;
  holdOffset: V3 | null;
}
const cache = new Map<string, CachedWeapon>();

/** The scope that is actually drawn for (design, requested scope): requested if it fits, else the built-in optic. */
function effectiveScope(d: WeaponDesign, scope: ScopeId | null | undefined): ScopeId | null {
  if (scope && d.rail && scopeFitsRail(scope, d.rail.length)) return scope;
  return d.defaultScope ?? null;
}

/** Shared geometry for a weapon at a level with a scope (used by loot and the viewmodel too). Null for fists / unknown. */
export function getWeaponGeometry(id: WeaponId | string, opts: WeaponModelOptions = {}): CachedWeapon | null {
  const d = designOf(id);
  if (!d) return null;
  const level = opts.level === undefined || opts.level === null ? null : clampLevel(opts.level);
  const optic = d.kind === 'gun' ? effectiveScope(d, opts.scope) : null;
  const key = `${id}|${level ?? '-'}|${optic ?? '-'}`;
  let c = cache.get(key);
  if (c) return c;

  const lv = level ?? undefined;
  const fam = new Set(d.family);
  const toned = d.pieces.map((p) => (fam.has(p.color) && lv !== undefined ? { ...p, color: levelTone(p.color, lv) } : p));
  const pieces: Piece[] = [...toned, ...levelDressPieces(d.dress, lv)];
  if (level !== null) pieces.push(...collarPieces(d.collar, level));
  let sight: WeaponSight | null = null;
  let lens: Piece[] = [];
  if (d.kind === 'gun') {
    if (optic && d.rail) {
      const m = mountedScopePieces(optic, d.rail.pos);
      pieces.push(...m.body);
      lens = m.lens;
      const g = SCOPE_GEOMETRY[optic];
      const r = d.rail.pos;
      sight = {
        type: g.sight,
        eye: [r[0] + g.eye[0], r[1] + g.eye[1], r[2] + g.eye[2]],
        rear: [r[0] + g.rear[0], r[1] + g.rear[1], r[2] + g.rear[2]],
        apertureRadius: g.apertureRadius,
      };
    } else if (d.iron) {
      pieces.push(...d.iron.pieces);
      sight = d.iron.sight;
    }
  }
  c = {
    merged: buildMerged(pieces, `weapon:${id}:${level ?? 'base'}:${optic ?? 'built-in'}`),
    muzzle: d.muzzle ?? null,
    sight,
    lens: lens.length ? buildMerged(lens, `weapon:${id}:lens`).geometry : null,
    rail: d.rail ?? null,
    level,
    scope: optic,
    collar: [0, d.collar.y, d.collar.z],
    anchors: d.anchors ?? {},
    holdOffset: d.holdOffset ?? null,
  };
  cache.set(key, c);
  return c;
}

/**
 * Sight data for a weapon (weapon frame), or null for fists / melee / unknown ids. `eye` is where the ADS camera (or the
 * scope overlay's virtual eye) sits; the line of sight runs from `eye` along -Z, parallel to the barrel.
 * With `opts.scope`, the mounted scope's sight (eye = rail + SCOPE_GEOMETRY[scope].eye).
 */
export function getWeaponSight(id: WeaponId | string, opts: WeaponModelOptions = {}): WeaponSight | null {
  return getWeaponGeometry(id, { scope: opts.scope ?? null })?.sight ?? null;
}

/** Rail anchor of a gun (null for melee, the rpg and unknown ids). */
export function getWeaponRail(id: string): WeaponRail | null {
  return designOf(id)?.rail ?? null;
}

/** True if this scope can be drawn on this gun (it has a rail and the scope's mount footprint fits). */
export function weaponAcceptsScope(id: string, scope: ScopeId): boolean {
  const r = getWeaponRail(id);
  return !!r && scopeFitsRail(scope, r.length);
}


/**
 * Left-hand (support) point per weapon in the weapon frame: where the off hand holds the fore-end / front grip / shaft.
 * Matches the viewmodel hand targets (VIEWMODEL_POSES[id].handL). null = one-handed (knife, machete).
 */
const SUPPORT_HAND: Readonly<Record<string, V3 | null>> = {
  pistol: [-0.035, -0.07, 0], revolver: [-0.035, -0.07, 0], smg: [0, -0.045, -0.15], shotgun: [0, -0.03, -0.3],
  rifle: [0, -0.025, -0.3], lmg: [0, -0.03, -0.36], dmr: [0, -0.025, -0.33], sniper: [0, -0.04, -0.36],
  dbshotgun: [0, 0, -0.22], rpg: [-0.004, -0.045, -0.25], paddle: [0, -0.01, -0.38], knife: null, machete: null,
};

/** All anchors of one weapon model as plain data (weapon frame, metres). Identical at every level by construction. */
export interface WeaponAnchors {
  weaponId: string;
  level: ItemLevel | null;
  /** Effective scope drawn (requested if it fits, else the built-in optic), null = iron / none. */
  scope: ScopeId | null;
  /** Grip (right hand) = the weapon origin. */
  grip: V3;
  /** Support (left) hand, or null for one-handed melee. */
  support: V3 | null;
  muzzle: V3 | null;
  sight: WeaponSight | null;
  rail: WeaponRail | null;
  /** Level collar centre (L4 glint), null when no level. */
  collar: V3 | null;
  /** Extra named anchors: muzzleL / muzzleR, tip / swingTrail, exhaust / rocketSeat, cylinder, handL (paddle). */
  extra: Readonly<Record<string, V3>>;
  /** Third-person socket offset hint (rpg on the shoulder), null = none. */
  holdOffset: V3 | null;
}

/**
 * Pure-data anchors for (id, level, scope), so held weapons can be drawn batched (one geometry per key from
 * getWeaponGeometry) without per-player model objects. Null for fists / unknown ids. Same values as the empties that
 * createWeaponModel adds ('muzzle', 'sight', 'rail', 'collar', extras).
 */
export function getWeaponAnchors(id: WeaponId | string, opts: WeaponModelOptions = {}): WeaponAnchors | null {
  const c = getWeaponGeometry(id, opts);
  if (!c) return null;
  return {
    weaponId: id,
    level: c.level,
    scope: c.scope,
    grip: [0, 0, 0],
    support: SUPPORT_HAND[id] ?? null,
    muzzle: c.muzzle,
    sight: c.sight,
    rail: c.rail,
    collar: c.level !== null ? c.collar : null,
    extra: c.anchors,
    holdOffset: c.holdOffset,
  };
}

let lensMat: THREE.MeshBasicMaterial | null = null;
/** See-through red-dot glass: pale aqua tint, unlit, no depth write (first-person ADS looks through it). */
export function sightLensMaterial(): THREE.MeshBasicMaterial {
  return (lensMat ??= Object.assign(
    new THREE.MeshBasicMaterial({ color: palette.lensGlass, transparent: true, opacity: 0.25, depthWrite: false, side: THREE.DoubleSide }),
    { name: 'weapon:lens' },
  ));
}

const empty = (name: string, p: V3): THREE.Object3D => {
  const o = new THREE.Object3D();
  o.name = name;
  o.position.set(p[0], p[1], p[2]);
  return o;
};

/**
 * Held weapon model, or null for fists / unknown ids. Add to `hand_R_socket` / `handR`. See the module comment for
 * the children. `opts.level` picks the per-level model and the collar; `opts.scope` mounts a scope.
 */
export function createWeaponModel(id: WeaponId | string, opts: WeaponModelOptions = {}): THREE.Object3D | null {
  const c = getWeaponGeometry(id, opts);
  if (!c) return null;
  const root = new THREE.Group();
  root.name = `weapon:${id}`;
  root.userData.weaponId = id;
  root.userData.sightType = c.sight?.type ?? null;
  root.userData.level = c.level;
  root.userData.scope = c.scope;
  if (c.holdOffset) root.userData.holdOffset = c.holdOffset;
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
  if (c.muzzle) root.add(empty('muzzle', c.muzzle));
  if (c.sight) {
    const sight = empty('sight', c.sight.eye);
    sight.userData.sightType = c.sight.type;
    sight.userData.rear = c.sight.rear;
    sight.userData.apertureRadius = c.sight.apertureRadius;
    root.add(sight);
  }
  if (c.rail) {
    const rail = empty('rail', c.rail.pos);
    rail.userData.railLength = c.rail.length;
    root.add(rail);
  }
  if (c.level !== null && c.collar) root.add(empty('collar', c.collar));
  for (const [name, p] of Object.entries(c.anchors)) root.add(empty(name, p));
  return root;
}
