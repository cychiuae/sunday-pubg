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
 * LEVELS (Addendum 2 + Addendum 4, docs/art/M2c.md §15 / §17): each level is its own model. A design's `pieces` are
 * the L2 "standard" body; `levels[1 | 3 | 4]` swap tagged parts for that level's own parts (stock, mag, barrel,
 * fore-end, grip...), so the silhouette changes, not just the colour:
 *   L1 salvaged (driftwood, bamboo, pipe, crate and cord parts), L2 standard (the M2b model),
 *   L3 upgraded (dark polymer: rails, long or box mags, shrouds, foregrips, bipods, adjustable stocks),
 *   L4 premium (smooth family-colour shells, chrome, thumbhole / skeleton stocks, jackets, gold accents).
 * The shared level language from levelCollar.ts rides on top (L1 tape + cord loop + dulled tone, L3 ribbed grip and
 * muzzle device, L4 chrome trim + star badge + brighter tone), plus the level collar with N pips.
 * The anchors above are identical at every level (unit-tested); grip, fore-end and receiver surfaces under the hands,
 * collar, iron sights and rail stay put. Parts never rise into the sight line or the rail's scope footprint.
 * SCOPES: the effective optic is `opts.scope` if it fits the rail, else the weapon's built-in optic (rifle / lmg red
 * dot, dmr 4x, sniper 8x), else its iron sights. Iron sights are dropped while an optic is mounted.
 * Geometry is cached per (id, level, scope) and shared. `getWeaponAnchors(id, { level, scope })` gives every anchor as
 * plain data for batched drawing. Every part except the red-dot lens uses vertexColorToon() + the OUTLINE.small hull
 * (one material pair for all weapons, so they batch).
 */
import * as THREE from 'three';
import type { ItemLevel, ScopeId, WeaponId } from '../../shared/types';
import { buildMerged, xf, type ColorFn, type Merged, type Piece, type V3 } from './builder';
import { clampLevel, collarPieces, LEVEL_DRESS_COLORS, levelDressPieces, levelTone, type CollarSpec, type LevelDress } from './levelCollar';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';
import { MELEE_DESIGNS } from './melee';
import { mountedScopePieces, SCOPE_GEOMETRY, scopeFitsRail } from './scopes';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder lying along Z. */
const tube = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(HALF_PI);
/** Cylinder along X. */
const tubeX = (r: number, len: number, seg = 6) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(HALF_PI);
/** Tapered cylinder along Z: radius rBack at +Z, rFront at -Z. `open` drops the end caps. */
const taper = (rBack: number, rFront: number, len: number, seg = 8, open = false) =>
  new THREE.CylinderGeometry(rBack, rFront, len, seg, 1, open).rotateX(HALF_PI);
/** Matrix of a part offset (and rotated) inside a part placed at c with a tilt rx about X (mag under a tilted grip). */
const inTilt = (c: V3, rx: number, local: V3, rot: V3 = [0, 0, 0]) => xf(c, [rx, 0, 0]).multiply(xf(local, rot));

/** Colours of the per-level parts (salvaged wood and cord, polymer rubber, premium chrome and gold). */
export const LEVEL_PART_COLORS = {
  wood: palette.wood,
  woodDark: palette.woodDark,
  drift: palette.driftwood,
  driftDark: palette.driftwoodDark,
  bamboo: palette.bamboo,
  bambooDark: palette.bambooDark,
  crate: palette.crate,
  crateBand: palette.crateBand,
  rust: palette.dirt,
  cord: LEVEL_DRESS_COLORS.cord,
  tape: LEVEL_DRESS_COLORS.tape,
  rubber: LEVEL_DRESS_COLORS.rubber,
  chrome: LEVEL_DRESS_COLORS.chrome,
  gold: LEVEL_DRESS_COLORS.star,
  gem: palette.lensGlass,
} as const;
const LV = LEVEL_PART_COLORS;

/** n thin slots through a part (a decal on both side faces, no hull): vents, serrations, ribs. */
function slots(n: number, w: number, y: number, z0: number, dz: number, h: number, d: number, color: number = palette.ink): Part[] {
  const P: Part[] = [];
  for (let i = 0; i < n; i++) P.push({ geo: box(w, h, d), color, matrix: xf([0, y, z0 + i * dz]), outline: false });
  return P;
}

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

/** A design piece. `tag` names a part that a level body can drop (to swap in its own version). */
export type Part = Piece & { tag?: string };

/** One level's own body: the tagged L2 parts it removes and the parts it adds (same frame, same anchors). */
export interface LevelBody {
  drop?: readonly string[];
  add: Part[];
}
/** Bespoke bodies for the non-standard levels (L2 is `pieces` as authored). */
export type LevelBodies = Readonly<Partial<Record<1 | 3 | 4, LevelBody>>>;

/**
 * One weapon's design: the L2 body + the per-level bodies + the parts that change with sight. Melee designs
 * (melee.ts) use the same shape with no sights, rail or muzzle.
 */
export interface WeaponDesign {
  kind: 'gun' | 'melee';
  /** The L2 (standard) body, no sights. Also the no-level model. Colours in `family` are toned per level (levelTone). */
  pieces: Part[];
  /** Per-level bodies (L1 salvaged, L3 upgraded, L4 premium). */
  levels: LevelBodies;
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
// The seven M2a/M2b guns. `pieces` = the L2 model (geometry unchanged since M2b); `levels` = the L1 / L3 / L4 bodies.
// -------------------------------------------------------------------------------------------------
/**
 * Pistol (0.28 m, mango). L1 pipe pistol: welded box frame, bare hex pipe barrel with a hose clamp, plank grip, spur
 * hammer. L3 tactical: extended mag with a mango base plate, under-slide light, slide serrations. L4 race pistol: slim
 * upper slide over a chrome frame, compensator, gold barrel window, flared chrome magwell, beavertail.
 */
function pistol(): WeaponDesign {
  const c = palette.pistol, d = palette.gunDark;
  const G: V3 = [0, -0.03, 0.02], GRX = -0.25;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.06, -0.205],
    iron: ironSights(0.095, 0.045, 0.095, -0.165, 0.4),
    rail: { pos: [0, 0.095, -0.04], length: 0.1 },
    collar: { shape: 'box', y: 0.055, z: -0.1, w: 0.07, h: 0.08 },
    pieces: [
      { tag: 'grip', geo: box(0.06, 0.12, 0.075), color: d, matrix: xf(G, [GRX, 0, 0]) },
      { tag: 'slide', geo: box(0.07, 0.08, 0.24), color: c, matrix: xf([0, 0.055, -0.06]) },
      { geo: box(0.05, 0.025, 0.06), color: d, matrix: xf([0, 0.005, -0.03]), outline: false }, // trigger block
      { geo: tube(0.028, 0.04), color: palette.gunTip, matrix: xf([0, 0.06, -0.185]) },
    ],
    levels: {
      1: { drop: ['slide', 'grip'], add: [
        { geo: box(0.066, 0.07, 0.185), color: c, matrix: xf([0, 0.06, -0.0325]) }, // welded box frame
        { geo: tube(0.019, 0.05, 6), color: d, matrix: xf([0, 0.06, -0.15]), flat: true }, // pipe barrel
        { geo: box(0.022, 0.03, 0.022), color: d, matrix: xf([0, 0.08, -0.165]) }, // welded front-sight lug
        { geo: tube(0.024, 0.012, 6), color: LV.tape, matrix: xf([0, 0.06, -0.14]), outline: false }, // hose clamp
        { geo: box(0.058, 0.13, 0.07), color: LV.wood, matrix: xf([0, -0.035, 0.025], [-0.12, 0, 0]) }, // plank grip
        { geo: box(0.018, 0.03, 0.025), color: d, matrix: xf([0, 0.088, 0.075], [0.5, 0, 0]) }, // spur hammer
      ] },
      3: { add: [
        { geo: box(0.052, 0.07, 0.068), color: d, matrix: inTilt(G, GRX, [0, -0.09, 0]) }, // extended mag
        { geo: box(0.06, 0.016, 0.08), color: c, matrix: inTilt(G, GRX, [0, -0.128, 0]) }, // mag base plate
        { geo: box(0.05, 0.036, 0.075), color: d, matrix: xf([0, -0.003, -0.125]) }, // under-slide light
        { geo: tube(0.016, 0.006), color: palette.gunTip, matrix: xf([0, -0.003, -0.164]), outline: false },
        ...slots(3, 0.072, 0.06, 0.015, 0.016, 0.05, 0.006), // slide serrations
      ] },
      4: { drop: ['slide', 'grip'], add: [
        { geo: box(0.062, 0.05, 0.25), color: c, matrix: xf([0, 0.07, -0.06]) }, // slim upper slide (top 0.095)
        { geo: box(0.07, 0.034, 0.19), color: LV.chrome, matrix: xf([0, 0.029, -0.065]) }, // chrome lower frame
        { geo: box(0.072, 0.064, 0.034), color: d, matrix: xf([0, 0.063, -0.168]) }, // compensator
        ...slots(2, 0.074, 0.078, -0.176, 0.014, 0.012, 0.006),
        { geo: box(0.064, 0.016, 0.05), color: LV.gold, matrix: xf([0, 0.075, -0.03]), outline: false }, // barrel window
        { geo: box(0.056, 0.12, 0.072), color: LV.rubber, matrix: xf(G, [GRX, 0, 0]) }, // slim rubber grip
        { geo: box(0.072, 0.024, 0.095), color: LV.chrome, matrix: inTilt(G, GRX, [0, -0.066, 0.004]) }, // flared magwell
        { geo: box(0.04, 0.012, 0.035), color: LV.chrome, matrix: xf([0, 0.035, 0.068], [0.35, 0, 0]) }, // beavertail
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.055, z: -0.02, w: 0.07, h: 0.08 }, { shape: 'box', y: -0.035, z: 0.025, w: 0.06, h: 0.06 }],
      loop: [0, -0.085, 0.045],
      grip: { c: G, w: 0.06, h: 0.12, d: 0.075, rx: GRX },
      trim: { y: 0.082, z0: -0.15, z1: 0.05, x: 0.031 },
      star: [-0.036, 0.03, -0.02],
    },
  };
}

/**
 * SMG (0.59 m, teal). L1: driftwood stick stock lashed on, short straight mag. L3: curved long mag, vented barrel
 * shroud, skeleton folding stock with a rubber pad. L4 PDW: teal integral suppressor with chrome rings, teal mag with
 * a chrome plate, smooth thumbhole stock.
 */
function smg(): WeaponDesign {
  const c = palette.smg, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.07, -0.37],
    iron: ironSights(0.11, 0.07, 0.11, -0.23, 0.32),
    rail: { pos: [0, 0.11, -0.06], length: 0.16 },
    collar: { shape: 'box', y: 0.06, z: -0.21, w: 0.08, h: 0.1 },
    pieces: [
      { geo: box(0.08, 0.1, 0.34), color: c, matrix: xf([0, 0.06, -0.08]) },
      { tag: 'grip', geo: box(0.055, 0.12, 0.065), color: d, matrix: xf([0, -0.03, 0.04], [-0.25, 0, 0]) },
      { tag: 'mag', geo: box(0.05, 0.16, 0.06), color: d, matrix: xf([0, -0.05, -0.15], [0.12, 0, 0]) },
      { tag: 'barrel', geo: tube(0.025, 0.1), color: d, matrix: xf([0, 0.07, -0.29]) },
      { geo: tube(0.032, 0.035), color: palette.gunTip, matrix: xf([0, 0.07, -0.35]) },
      { tag: 'stock', geo: box(0.05, 0.08, 0.14), color: d, matrix: xf([0, 0.025, 0.15]) },
      // yellow band wraps the body sides just below the top, clear of the iron-sight line
      { geo: box(0.085, 0.03, 0.07), color: palette.ammoLight, matrix: xf([0, 0.093, -0.12]), outline: false },
    ],
    levels: {
      1: { drop: ['stock', 'mag'], add: [
        { geo: box(0.05, 0.11, 0.06), color: d, matrix: xf([0, -0.025, -0.15], [0.06, 0, 0]) }, // short mag
        { geo: box(0.054, 0.014, 0.064), color: LV.rust, matrix: xf([0, -0.07, -0.153], [0.06, 0, 0]), outline: false },
        { geo: tube(0.014, 0.15, 6), color: LV.drift, matrix: xf([0, 0.03, 0.15], [0.12, 0, 0]), flat: true }, // stick stock
        { geo: box(0.028, 0.075, 0.026), color: LV.driftDark, matrix: xf([0, 0.021, 0.228]) }, // butt crosspiece
        { geo: box(0.036, 0.036, 0.02), color: LV.cord, matrix: xf([0, 0.037, 0.098]), outline: false }, // lashing
      ] },
      3: { drop: ['stock', 'mag', 'barrel'], add: [
        { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.04, -0.15], [0.12, 0, 0]) },
        { geo: box(0.05, 0.1, 0.058), color: d, matrix: xf([0, -0.138, -0.172], [0.38, 0, 0]) }, // curved extension
        { geo: box(0.058, 0.058, 0.1), color: d, matrix: xf([0, 0.07, -0.283]) }, // barrel shroud
        ...slots(3, 0.06, 0.07, -0.255, -0.026, 0.014, 0.012),
        { geo: box(0.046, 0.012, 0.155), color: d, matrix: xf([0, 0.072, 0.168]) }, // folding stock top bar
        { geo: box(0.012, 0.012, 0.16), color: d, matrix: xf([0, 0.008, 0.168], [0.16, 0, 0]) }, // strut
        { geo: box(0.056, 0.095, 0.022), color: LV.rubber, matrix: xf([0, 0.035, 0.245]) }, // butt pad
      ] },
      4: { drop: ['stock', 'mag', 'barrel'], add: [
        { geo: tube(0.036, 0.1, 10), color: c, matrix: xf([0, 0.07, -0.283]) }, // integral suppressor (top 0.106)
        { geo: tube(0.039, 0.01, 10), color: LV.chrome, matrix: xf([0, 0.07, -0.243]), outline: false },
        { geo: tube(0.039, 0.01, 10), color: LV.chrome, matrix: xf([0, 0.07, -0.323]), outline: false },
        { geo: box(0.05, 0.13, 0.06), color: c, matrix: xf([0, -0.045, -0.15], [0.12, 0, 0]) }, // teal mag
        { geo: box(0.056, 0.014, 0.068), color: LV.chrome, matrix: xf([0, -0.112, -0.158], [0.12, 0, 0]) },
        { geo: box(0.06, 0.09, 0.15), color: c, matrix: xf([0, 0.045, 0.165]) }, // smooth stock shell
        { geo: box(0.062, 0.03, 0.07), color: palette.ink, matrix: xf([0, 0.03, 0.16]), outline: false }, // thumbhole
        { geo: box(0.062, 0.096, 0.016), color: LV.rubber, matrix: xf([0, 0.045, 0.248]) },
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.06, z: 0.0, w: 0.08, h: 0.1 }, { shape: 'box', y: -0.04, z: -0.15, w: 0.05, h: 0.06 }],
      loop: [0, -0.01, 0.2],
      grip: { c: [0, -0.03, 0.04], w: 0.055, h: 0.12, d: 0.065, rx: -0.25 },
      fin: { c: [0, 0.01, -0.215], len: 0.06, h: 0.04 },
      trim: { y: 0.085, z0: -0.24, z1: 0.08, x: 0.04 },
      star: [-0.04, 0.05, -0.05],
    },
  };
}

/**
 * Pump shotgun (1.0 m, red, wood). L1 slam-fire: hex pipe barrel in a dark sleeve, driftwood plank fore-end lashed with
 * cord, branch stock. L3 tactical: long mag tube, ribbed polymer pump, pistol grip, tube stock, a 4-shell side saddle.
 * L4 sporter: chrome vent rib, tapered red fore-end with a chrome cap, red thumbhole stock with a rubber pad.
 */
function shotgun(): WeaponDesign {
  const c = palette.shotgun, d = palette.gunDark, w = palette.gunWood;
  const S: V3 = [0, 0.0, 0.22], SRX = 0.15;
  return {
    kind: 'gun', family: [c, w], muzzle: [0, 0.085, -0.64],
    iron: ironSights(0.115, 0.07, 0.121, -0.6, 0.32),
    rail: { pos: [0, 0.115, -0.02], length: 0.16 },
    collar: { shape: 'box', y: 0.06, z: -0.1, w: 0.085, h: 0.11 },
    pieces: [
      { geo: box(0.085, 0.11, 0.22), color: c, matrix: xf([0, 0.06, -0.02]) },
      { tag: 'barrel', geo: tube(0.036, 0.46, 10), color: c, matrix: xf([0, 0.085, -0.36]) },
      { tag: 'pump', geo: tube(0.048, 0.18, 10), color: w, matrix: xf([0, 0.025, -0.3]) },
      { geo: tube(0.043, 0.04, 10), color: palette.gunTip, matrix: xf([0, 0.085, -0.61]) },
      { tag: 'stock', geo: box(0.07, 0.12, 0.3), color: w, matrix: xf(S, [SRX, 0, 0]) },
      { geo: box(0.055, 0.03, 0.05), color: d, matrix: xf([0, 0.0, -0.01]), outline: false },
    ],
    levels: {
      1: { drop: ['barrel', 'pump', 'stock'], add: [
        { geo: tube(0.036, 0.46, 6), color: c, matrix: xf([0, 0.085, -0.36]), flat: true }, // hex pipe barrel
        { geo: tube(0.044, 0.2, 6), color: d, matrix: xf([0, 0.085, -0.23]), flat: true }, // slam-fire sleeve
        { geo: box(0.07, 0.06, 0.2), color: LV.drift, matrix: xf([0, 0.02, -0.33]) }, // plank fore-end
        { geo: box(0.082, 0.135, 0.016), color: LV.cord, matrix: xf([0, 0.055, -0.35]), outline: false },
        { geo: box(0.082, 0.135, 0.016), color: LV.cord, matrix: xf([0, 0.055, -0.415]), outline: false },
        { geo: box(0.05, 0.065, 0.33), color: LV.drift, matrix: xf([0, -0.01, 0.2], [0.2, 0, 0]) }, // branch stock
        { geo: box(0.056, 0.11, 0.03), color: LV.driftDark, matrix: inTilt([0, -0.01, 0.2], 0.2, [0, -0.02, 0.165]) },
      ] },
      3: { drop: ['pump', 'stock'], add: [
        { geo: tube(0.022, 0.42), color: d, matrix: xf([0, 0.034, -0.36]) }, // extended mag tube
        { geo: box(0.08, 0.07, 0.17), color: d, matrix: xf([0, 0.03, -0.3]) }, // polymer pump
        ...slots(3, 0.082, 0.03, -0.25, -0.05, 0.05, 0.012, LV.rubber),
        { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.035, 0.045], [-0.3, 0, 0]) }, // pistol grip
        { geo: tube(0.022, 0.2), color: d, matrix: xf([0, 0.045, 0.18]) }, // buffer tube
        { geo: box(0.06, 0.13, 0.06), color: c, matrix: xf([0, 0.03, 0.31]) }, // stock
        { geo: box(0.064, 0.14, 0.02), color: LV.rubber, matrix: xf([0, 0.03, 0.35]) },
        // side saddle on the left of the receiver: plate + 4 shells
        { geo: box(0.01, 0.06, 0.11), color: d, matrix: xf([-0.047, 0.06, -0.015]), outline: false },
        ...[0, 1, 2, 3].map((i): Part => ({ geo: box(0.014, 0.05, 0.018), color: palette.ammoShell, matrix: xf([-0.057, 0.06, -0.054 + i * 0.026]), outline: false })),
      ] },
      4: { drop: ['pump', 'stock'], add: [
        { geo: box(0.02, 0.006, 0.44), color: LV.chrome, matrix: xf([0, 0.124, -0.37]) }, // vent rib
        { geo: taper(0.05, 0.042, 0.26), color: c, matrix: xf([0, 0.032, -0.31]) }, // tapered fore-end
        { geo: tube(0.046, 0.014), color: LV.chrome, matrix: xf([0, 0.032, -0.447]), outline: false },
        { geo: box(0.065, 0.115, 0.3), color: c, matrix: xf(S, [SRX, 0, 0]) }, // sporter stock, family colour
        { geo: box(0.067, 0.032, 0.07), color: palette.ink, matrix: xf([0, 0.03, 0.13], [SRX, 0, 0]), outline: false }, // thumbhole
        { geo: box(0.07, 0.13, 0.026), color: LV.rubber, matrix: inTilt(S, SRX, [0, 0, 0.162]) },
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: 0.085, z: -0.5, r: 0.036 }, { shape: 'box', y: -0.01, z: 0.2, w: 0.05, h: 0.065 }],
      loop: [0, -0.04, 0.36],
      brake: { c: [0, 0.085, -0.572], r: 0.044, len: 0.028 },
      trim: { y: 0.085, z0: -0.12, z1: 0.08, x: 0.0425 },
      star: [-0.0425, 0.06, -0.03],
    },
  };
}

/**
 * Rifle (1.0 m, green, red dot). L1 hunting carbine: wooden handguard with a band, wooden drop stock, stubby mag.
 * L3 tactical: long slotted rail guard, vertical foregrip, curved long mag, tube stock with a rubber pad.
 * L4 premium: smooth tapered green fairing with a chrome ring, barrel shroud, thumbhole stock, chrome mag plate.
 */
function rifle(): WeaponDesign {
  const c = palette.rifle, d = palette.gunDark;
  const M: V3 = [0, -0.06, -0.12];
  return {
    kind: 'gun', family: [c, palette.sandDark], muzzle: [0, 0.075, -0.62],
    defaultScope: 'scope_red_dot',
    rail: { pos: [0, 0.115, -0.06], length: 0.24 },
    collar: { shape: 'box', y: 0.06, z: -0.18, w: 0.075, h: 0.11 },
    pieces: [
      { geo: box(0.075, 0.11, 0.32), color: c, matrix: xf([0, 0.06, -0.05]) },
      { tag: 'guard', geo: box(0.07, 0.075, 0.2), color: palette.sandDark, matrix: xf([0, 0.06, -0.3]) },
      { tag: 'barrel', geo: tube(0.024, 0.22), color: d, matrix: xf([0, 0.075, -0.49]) },
      { geo: tube(0.032, 0.04), color: palette.gunTip, matrix: xf([0, 0.075, -0.6]) },
      { tag: 'mag', geo: box(0.05, 0.17, 0.08), color: d, matrix: xf(M, [0.25, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { tag: 'stock', geo: box(0.06, 0.12, 0.24), color: c, matrix: xf([0, 0.04, 0.25]) },
    ],
    levels: {
      1: { drop: ['guard', 'stock', 'mag'], add: [
        { geo: box(0.076, 0.07, 0.24), color: LV.wood, matrix: xf([0, 0.052, -0.31]) }, // wooden handguard
        { geo: box(0.08, 0.076, 0.014), color: d, matrix: xf([0, 0.052, -0.4]), outline: false }, // barrel band
        { geo: box(0.058, 0.1, 0.3), color: LV.wood, matrix: xf([0, 0.0, 0.25], [0.2, 0, 0]) }, // drop stock
        { geo: box(0.06, 0.11, 0.02), color: LV.woodDark, matrix: inTilt([0, 0.0, 0.25], 0.2, [0, 0, 0.155]) },
        { geo: box(0.045, 0.1, 0.065), color: d, matrix: xf([0, -0.03, -0.12], [0.12, 0, 0]) }, // stubby mag
      ] },
      3: { drop: ['guard', 'stock', 'mag'], add: [
        { geo: box(0.072, 0.08, 0.3), color: d, matrix: xf([0, 0.07, -0.35]) }, // free-float rail guard
        ...slots(4, 0.074, 0.07, -0.25, -0.065, 0.016, 0.03),
        { geo: box(0.032, 0.085, 0.04), color: d, matrix: xf([0, -0.012, -0.3], [0.1, 0, 0]) }, // vertical foregrip
        { geo: box(0.05, 0.14, 0.08), color: d, matrix: xf([0, -0.05, -0.12], [0.25, 0, 0]) }, // mag
        { geo: box(0.048, 0.09, 0.074), color: d, matrix: xf([0, -0.155, -0.155], [0.5, 0, 0]) }, // curved extension
        { geo: tube(0.022, 0.16), color: d, matrix: xf([0, 0.07, 0.19]) }, // buffer tube
        { geo: box(0.06, 0.11, 0.1), color: c, matrix: xf([0, 0.04, 0.31]) }, // adjustable stock
        { geo: box(0.064, 0.12, 0.02), color: LV.rubber, matrix: xf([0, 0.04, 0.37]) },
      ] },
      4: { drop: ['guard', 'stock', 'barrel'], add: [
        { geo: taper(0.052, 0.042, 0.26), color: c, matrix: xf([0, 0.062, -0.33]) }, // smooth fairing
        { geo: tube(0.046, 0.014), color: LV.chrome, matrix: xf([0, 0.062, -0.463]), outline: false },
        { geo: tube(0.03, 0.12), color: d, matrix: xf([0, 0.075, -0.52]) }, // barrel shroud
        { geo: box(0.06, 0.13, 0.25), color: c, matrix: xf([0, 0.035, 0.245]) }, // sleek stock
        { geo: box(0.062, 0.04, 0.08), color: palette.ink, matrix: xf([0, 0.03, 0.17]), outline: false }, // thumbhole
        { geo: box(0.064, 0.14, 0.02), color: LV.rubber, matrix: xf([0, 0.035, 0.375]) },
        { geo: box(0.056, 0.014, 0.086), color: LV.chrome, matrix: inTilt(M, 0.25, [0, -0.085, 0]) }, // mag plate
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.06, z: -0.0, w: 0.075, h: 0.11 }, { shape: 'box', y: 0.0, z: 0.25, w: 0.058, h: 0.1 }],
      loop: [0, -0.02, 0.37],
      brake: { c: [0, 0.075, -0.565], r: 0.032, len: 0.028 },
      grip: { c: [0, -0.03, 0.05], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      trim: { y: 0.085, z0: -0.2, z1: 0.36, x: 0.0375 },
      star: [-0.0375, 0.06, -0.02],
    },
  };
}

/**
 * Marksman rifle (1.12 m, cornflower, green heavy band, 4x). L1 bamboo rifle: bamboo fore-end and stock with dark nodes,
 * bamboo butt crosspiece. L3 tactical: slotted rail guard, foregrip, tube stock with a cheek riser. L4 precision
 * chassis: smooth tapered fore-end, fluted chrome barrel, open skeleton stock (see-through window).
 */
function dmr(): WeaponDesign {
  const c = palette.dmr, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.715],
    defaultScope: 'scope_4x',
    rail: { pos: [0, 0.115, -0.06], length: 0.26 },
    collar: { shape: 'box', y: 0.06, z: -0.205, w: 0.075, h: 0.11 },
    pieces: [
      { geo: box(0.075, 0.11, 0.34), color: c, matrix: xf([0, 0.06, -0.06]) },
      { tag: 'fore', geo: box(0.068, 0.08, 0.24), color: c, matrix: xf([0, 0.065, -0.35]) },
      { geo: box(0.072, 0.084, 0.03), color: palette.ammoHeavy, matrix: xf([0, 0.065, -0.262]), outline: false },
      { tag: 'barrel', geo: tube(0.022, 0.22), color: d, matrix: xf([0, 0.075, -0.57]) },
      { geo: tube(0.031, 0.045), color: palette.gunTip, matrix: xf([0, 0.075, -0.69]) },
      { geo: box(0.05, 0.14, 0.08), color: d, matrix: xf([0, -0.05, -0.14], [0.12, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { tag: 'stock', geo: box(0.06, 0.13, 0.26), color: c, matrix: xf([0, 0.035, 0.24]) },
      { tag: 'butt', geo: box(0.065, 0.15, 0.03), color: d, matrix: xf([0, 0.035, 0.385]) },
    ],
    levels: {
      1: { drop: ['fore', 'stock', 'butt'], add: [
        { geo: tube(0.038, 0.25, 6), color: LV.bamboo, matrix: xf([0, 0.058, -0.35]), flat: true }, // bamboo fore-end
        { geo: tube(0.041, 0.012, 6), color: LV.bambooDark, matrix: xf([0, 0.058, -0.31]), outline: false, flat: true },
        { geo: tube(0.041, 0.012, 6), color: LV.bambooDark, matrix: xf([0, 0.058, -0.43]), outline: false, flat: true },
        { geo: tube(0.034, 0.28, 6), color: LV.bamboo, matrix: xf([0, 0.03, 0.25], [0.1, 0, 0]), flat: true }, // bamboo stock
        { geo: tube(0.037, 0.012, 6), color: LV.bambooDark, matrix: xf([0, 0.035, 0.2], [0.1, 0, 0]), outline: false, flat: true },
        { geo: box(0.03, 0.13, 0.03), color: LV.bambooDark, matrix: xf([0, 0.02, 0.385]) }, // butt crosspiece
      ] },
      3: { drop: ['fore', 'stock', 'butt'], add: [
        { geo: box(0.066, 0.085, 0.26), color: d, matrix: xf([0, 0.065, -0.355]) }, // rail guard
        ...slots(3, 0.068, 0.065, -0.31, -0.06, 0.016, 0.03),
        { geo: box(0.032, 0.08, 0.04), color: d, matrix: xf([0, -0.012, -0.33], [0.1, 0, 0]) }, // foregrip
        { geo: tube(0.02, 0.14), color: d, matrix: xf([0, 0.07, 0.17]) }, // buffer tube
        { geo: box(0.06, 0.12, 0.15), color: c, matrix: xf([0, 0.03, 0.3]) }, // stock
        { geo: box(0.04, 0.025, 0.11), color: d, matrix: xf([0, 0.1, 0.29]) }, // cheek riser
        { geo: box(0.066, 0.15, 0.022), color: LV.rubber, matrix: xf([0, 0.03, 0.386]) },
      ] },
      4: { drop: ['fore', 'barrel', 'stock', 'butt'], add: [
        { geo: taper(0.044, 0.036, 0.24), color: c, matrix: xf([0, 0.065, -0.35]) }, // smooth fore-end
        { geo: tube(0.026, 0.22, 6), color: LV.chrome, matrix: xf([0, 0.075, -0.57]), flat: true }, // fluted barrel
        { geo: box(0.05, 0.006, 0.18), color: palette.ink, matrix: xf([0, 0.075, -0.57]), outline: false }, // flutes
        { geo: box(0.05, 0.03, 0.25), color: c, matrix: xf([0, 0.075, 0.235]) }, // chassis top bar
        { geo: box(0.04, 0.028, 0.2), color: c, matrix: xf([0, -0.015, 0.25]) }, // lower bar
        { geo: box(0.03, 0.08, 0.03), color: c, matrix: xf([0, 0.02, 0.13]) }, // front upright
        { geo: box(0.065, 0.15, 0.03), color: LV.rubber, matrix: xf([0, 0.035, 0.375]) }, // butt plate
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.065, z: -0.41, w: 0.068, h: 0.08 }, { shape: 'box', y: 0.06, z: 0.0, w: 0.075, h: 0.11 }],
      loop: [0, -0.04, 0.39],
      brake: { c: [0, 0.075, -0.652], r: 0.03, len: 0.028 },
      grip: { c: [0, -0.03, 0.05], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      trim: { y: 0.09, z0: -0.22, z1: 0.1, x: 0.0375 },
      star: [-0.0375, 0.06, -0.1],
    },
  };
}

/**
 * Bolt-action sniper (1.32 m, navy, pink accents, 8x). L1 driftwood bolt gun: driftwood fore-end and drop stock, cord
 * cheek pad, crossed-stick bipod. L3 tactical: adjustable stock and pink cheek piece, rubber pad, rear monopod spike,
 * deployed bipod. L4 premium: swept tapered fore-end, fluted chrome barrel, thumbhole stock with a raked pink butt.
 */
function sniper(): WeaponDesign {
  const c = palette.sniper, d = palette.gunDark, p = palette.ammoSniper;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.92],
    defaultScope: 'scope_8x',
    rail: { pos: [0, 0.11, -0.07], length: 0.3 },
    collar: { shape: 'box', y: 0.05, z: -0.23, w: 0.07, h: 0.075 },
    pieces: [
      { geo: box(0.075, 0.1, 0.32), color: c, matrix: xf([0, 0.06, -0.04]) },
      { tag: 'fore', geo: box(0.07, 0.075, 0.36), color: c, matrix: xf([0, 0.05, -0.38]) },
      { geo: box(0.074, 0.079, 0.03), color: p, matrix: xf([0, 0.05, -0.545]), outline: false },
      { tag: 'barrel', geo: tube(0.02, 0.36), color: d, matrix: xf([0, 0.075, -0.7]) },
      { geo: tube(0.034, 0.07), color: palette.gunTip, matrix: xf([0, 0.075, -0.885]) },
      { geo: box(0.05, 0.07, 0.08), color: d, matrix: xf([0, -0.015, -0.1]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.06], [-0.3, 0, 0]) },
      { tag: 'stock', geo: box(0.065, 0.13, 0.26), color: c, matrix: xf([0, 0.035, 0.25]) },
      { tag: 'riser', geo: box(0.05, 0.035, 0.13), color: p, matrix: xf([0, 0.113, 0.26]) }, // cheek riser
      { tag: 'butt', geo: box(0.07, 0.15, 0.03), color: p, matrix: xf([0, 0.035, 0.395]) }, // butt pad
      { geo: tubeX(0.012, 0.08), color: d, matrix: xf([0.07, 0.085, 0.07]) }, // bolt
      { geo: new THREE.SphereGeometry(0.024, 6, 4), color: p, matrix: xf([0.115, 0.085, 0.07]) },
      { tag: 'bipod', geo: box(0.016, 0.016, 0.22), color: d, matrix: xf([-0.022, 0.005, -0.45]), outline: false }, // folded bipod
      { tag: 'bipod', geo: box(0.016, 0.016, 0.22), color: d, matrix: xf([0.022, 0.005, -0.45]), outline: false },
    ],
    levels: {
      1: { drop: ['fore', 'stock', 'riser', 'butt', 'bipod'], add: [
        { geo: box(0.066, 0.066, 0.36), color: LV.drift, matrix: xf([0, 0.048, -0.38]) }, // driftwood fore-end
        { geo: box(0.06, 0.12, 0.29), color: LV.drift, matrix: xf([0, 0.015, 0.25], [0.14, 0, 0]) }, // drop stock
        { geo: box(0.064, 0.032, 0.09), color: LV.cord, matrix: xf([0, 0.075, 0.22], [0.14, 0, 0]), outline: false }, // cheek pad
        { geo: box(0.014, 0.2, 0.014), color: LV.driftDark, matrix: xf([-0.03, -0.06, -0.5], [0, 0, -0.35]) }, // stick bipod
        { geo: box(0.014, 0.2, 0.014), color: LV.driftDark, matrix: xf([0.03, -0.06, -0.5], [0, 0, 0.35]) },
      ] },
      3: { drop: ['stock', 'riser', 'butt', 'bipod'], add: [
        { geo: box(0.06, 0.11, 0.22), color: c, matrix: xf([0, 0.04, 0.235]) }, // adjustable stock
        { geo: box(0.045, 0.03, 0.13), color: p, matrix: xf([0, 0.105, 0.25]) }, // cheek piece
        { geo: box(0.068, 0.15, 0.03), color: LV.rubber, matrix: xf([0, 0.035, 0.36]) }, // butt pad
        { geo: box(0.016, 0.07, 0.016), color: d, matrix: xf([0, -0.045, 0.31]), outline: false }, // monopod spike
        { geo: box(0.016, 0.2, 0.016), color: d, matrix: xf([-0.03, -0.07, -0.5], [0.35, 0, -0.2]) }, // deployed bipod
        { geo: box(0.016, 0.2, 0.016), color: d, matrix: xf([0.03, -0.07, -0.5], [0.35, 0, 0.2]) },
      ] },
      4: { drop: ['fore', 'barrel', 'stock', 'butt', 'bipod'], add: [
        { geo: taper(0.044, 0.03, 0.36), color: c, matrix: xf([0, 0.052, -0.38]) }, // swept fore-end
        { geo: tube(0.024, 0.36, 6), color: LV.chrome, matrix: xf([0, 0.075, -0.7]), flat: true }, // fluted barrel
        { geo: box(0.046, 0.006, 0.3), color: palette.ink, matrix: xf([0, 0.075, -0.7]), outline: false }, // flutes
        { geo: box(0.065, 0.12, 0.24), color: c, matrix: xf([0, 0.04, 0.24]) }, // thumbhole stock
        { geo: box(0.067, 0.04, 0.09), color: palette.ink, matrix: xf([0, 0.035, 0.17]), outline: false },
        { geo: box(0.07, 0.17, 0.035), color: p, matrix: xf([0, 0.025, 0.375], [0.25, 0, 0]) }, // raked butt
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.05, z: -0.46, w: 0.07, h: 0.075 }, { shape: 'box', y: 0.06, z: 0.0, w: 0.075, h: 0.1 }],
      loop: [0, -0.04, 0.39],
      brake: { c: [0, 0.075, -0.835], r: 0.03, len: 0.026 },
      grip: { c: [0, -0.03, 0.06], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.055, -0.66], len: 0.14, h: 0.035 },
      trim: { y: 0.085, z0: -0.2, z1: 0.11, x: 0.0375 },
      star: [-0.0375, 0.06, -0.04],
    },
  };
}

/**
 * LMG (1.11 m, tangerine, drum, red dot). L1 salvaged: bare barrel on a lashed plank fore-end, wooden ammo crate
 * instead of the drum, driftwood plank stock. L3 heavy: square box mag with a tangerine stripe, carry handle over the
 * shroud, deployed bipod, tube stock. L4 premium: big vented tangerine cooling jacket with a chrome ring, chrome drum
 * hub, open skeleton stock with a raked rubber butt.
 */
function lmg(): WeaponDesign {
  const c = palette.lmg, d = palette.gunDark;
  return {
    kind: 'gun', family: [c], muzzle: [0, 0.075, -0.71],
    defaultScope: 'scope_red_dot',
    rail: { pos: [0, 0.135, -0.07], length: 0.24 },
    collar: { shape: 'box', y: 0.065, z: -0.2, w: 0.1, h: 0.14 },
    pieces: [
      { geo: box(0.1, 0.14, 0.38), color: c, matrix: xf([0, 0.065, -0.05]) },
      { tag: 'shroud', geo: tube(0.045, 0.28), color: d, matrix: xf([0, 0.075, -0.38]) },
      { tag: 'bands', geo: tube(0.048, 0.025), color: c, matrix: xf([0, 0.075, -0.33]), outline: false },
      { tag: 'bands', geo: tube(0.048, 0.025), color: c, matrix: xf([0, 0.075, -0.44]), outline: false },
      { tag: 'barrel', geo: tube(0.022, 0.14), color: d, matrix: xf([0, 0.075, -0.59]) },
      { geo: tube(0.034, 0.05), color: palette.gunTip, matrix: xf([0, 0.075, -0.68]) },
      { tag: 'drum', geo: new THREE.CylinderGeometry(0.085, 0.085, 0.09, 10).rotateZ(HALF_PI), color: d, matrix: xf([0, -0.07, -0.13]) },
      { tag: 'drum', geo: new THREE.CylinderGeometry(0.05, 0.05, 0.096, 8).rotateZ(HALF_PI), color: c, matrix: xf([0, -0.07, -0.13]), outline: false },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.07], [-0.3, 0, 0]) },
      { tag: 'stock', geo: box(0.075, 0.12, 0.24), color: c, matrix: xf([0, 0.045, 0.26]) },
      { tag: 'stock', geo: box(0.08, 0.14, 0.03), color: d, matrix: xf([0, 0.045, 0.395]) },
      { tag: 'bipod', geo: box(0.018, 0.018, 0.24), color: d, matrix: xf([-0.03, 0.02, -0.4]), outline: false }, // folded bipod
      { tag: 'bipod', geo: box(0.018, 0.018, 0.24), color: d, matrix: xf([0.03, 0.02, -0.4]), outline: false },
    ],
    levels: {
      1: { drop: ['shroud', 'bands', 'drum', 'stock', 'bipod'], add: [
        { geo: tube(0.024, 0.28, 6), color: d, matrix: xf([0, 0.075, -0.38]), flat: true }, // bare barrel
        { geo: box(0.075, 0.05, 0.24), color: LV.wood, matrix: xf([0, 0.03, -0.37]) }, // plank fore-end
        { geo: box(0.082, 0.1, 0.014), color: LV.cord, matrix: xf([0, 0.05, -0.3]), outline: false },
        { geo: box(0.082, 0.1, 0.014), color: LV.cord, matrix: xf([0, 0.05, -0.44]), outline: false },
        { geo: box(0.1, 0.1, 0.13), color: LV.crate, matrix: xf([0, -0.055, -0.13]) }, // ammo crate
        { geo: box(0.104, 0.02, 0.134), color: LV.crateBand, matrix: xf([0, -0.055, -0.13]), outline: false },
        { geo: box(0.05, 0.1, 0.27), color: LV.drift, matrix: xf([0, 0.035, 0.27], [0.08, 0, 0]) }, // plank stock
      ] },
      3: { drop: ['drum', 'bipod', 'stock'], add: [
        { geo: tube(0.026, 0.16), color: d, matrix: xf([0, 0.07, 0.21]) }, // buffer tube
        { geo: box(0.07, 0.13, 0.12), color: c, matrix: xf([0, 0.045, 0.34]) }, // adjustable stock
        { geo: box(0.074, 0.14, 0.02), color: LV.rubber, matrix: xf([0, 0.045, 0.405]) },
        { geo: box(0.1, 0.12, 0.15), color: d, matrix: xf([0, -0.07, -0.13]) }, // box mag
        { geo: box(0.102, 0.03, 0.154), color: c, matrix: xf([0, -0.075, -0.13]), outline: false },
        { geo: box(0.014, 0.022, 0.014), color: d, matrix: xf([0, 0.128, -0.3]), outline: false }, // carry handle
        { geo: box(0.014, 0.022, 0.014), color: d, matrix: xf([0, 0.128, -0.44]), outline: false },
        { geo: box(0.02, 0.012, 0.16), color: d, matrix: xf([0, 0.142, -0.37]) },
        { geo: box(0.016, 0.19, 0.016), color: d, matrix: xf([-0.035, -0.05, -0.52], [0.35, 0, -0.2]) }, // deployed bipod
        { geo: box(0.016, 0.19, 0.016), color: d, matrix: xf([0.035, -0.05, -0.52], [0.35, 0, 0.2]) },
      ] },
      4: { drop: ['shroud', 'bands', 'barrel', 'stock'], add: [
        { geo: tube(0.052, 0.38), color: c, matrix: xf([0, 0.075, -0.43]) }, // cooling jacket
        ...slots(4, 0.106, 0.075, -0.3, -0.08, 0.016, 0.034),
        { geo: tube(0.056, 0.016), color: LV.chrome, matrix: xf([0, 0.075, -0.615]), outline: false },
        { geo: tube(0.022, 0.05), color: d, matrix: xf([0, 0.075, -0.64]) }, // barrel stub
        { geo: new THREE.CylinderGeometry(0.03, 0.03, 0.098, 8).rotateZ(HALF_PI), color: LV.chrome, matrix: xf([0, -0.07, -0.13]), outline: false }, // drum hub
        { geo: box(0.072, 0.06, 0.26), color: c, matrix: xf([0, 0.085, 0.27]) }, // skeleton stock: top beam
        { geo: box(0.05, 0.03, 0.25), color: c, matrix: xf([0, -0.005, 0.28], [-0.12, 0, 0]) }, // swept lower strut
        { geo: box(0.078, 0.16, 0.024), color: LV.rubber, matrix: xf([0, 0.045, 0.4], [0.12, 0, 0]) }, // raked butt
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: 0.075, z: -0.5, r: 0.024 }, { shape: 'box', y: 0.065, z: 0.0, w: 0.1, h: 0.14 }],
      loop: [0, -0.02, 0.41],
      brake: { c: [0, 0.075, -0.642], r: 0.03, len: 0.026 },
      grip: { c: [0, -0.03, 0.07], w: 0.05, h: 0.12, d: 0.06, rx: -0.3 },
      fin: { c: [0, 0.03, -0.5], len: 0.14, h: 0.04 },
      trim: { y: 0.1, z0: -0.24, z1: 0.14, x: 0.05 },
      star: [-0.05, 0.065, -0.06],
    },
  };
}

// -------------------------------------------------------------------------------------------------
// M2c guns (docs/art/M2c.md §2.2)
// -------------------------------------------------------------------------------------------------
/**
 * Sand Dollar Revolver: sky frame, sand-dollar 6-flute cylinder, walnut bird's-head grip, green heavy band. 0.34 m.
 * L1: square driftwood plank grip, bare barrel (no rib) with a brazed front blade and a wire band, big spur hammer.
 * L3: full-length heavy underlug, ribbed rubber grip, ported muzzle. L4 target: long pearl grip with a gold base cap and medallion, raised
 * chrome rib on posts with a front sight hood base, shrouded hammer.
 */
function revolver(): WeaponDesign {
  const c = palette.revolver, d = palette.gunDark, sd = palette.sandDollar, wal = palette.walnut;
  const P: Part[] = [
    { tag: 'grip', geo: box(0.045, 0.11, 0.058), color: wal, matrix: xf([0, -0.035, 0.022], [-0.35, 0, 0]) }, // grip
    { tag: 'grip', geo: new THREE.SphereGeometry(0.03, 6, 3), color: wal, matrix: xf([0, -0.085, 0.045], [0, 0, 0], [0.75, 0.7, 1]) }, // bird's head
    { geo: box(0.05, 0.045, 0.12), color: c, matrix: xf([0, 0.035, -0.045]) }, // lower frame
    { geo: new THREE.CylinderGeometry(0.034, 0.034, 0.055, 6).rotateX(HALF_PI), color: sd, matrix: xf([0, 0.062, -0.05]), flat: true }, // cylinder
    { geo: box(0.03, 0.012, 0.1), color: c, matrix: xf([0, 0.099, -0.06]) }, // top strap
    { geo: new THREE.CylinderGeometry(0.017, 0.017, 0.15, 6).rotateX(HALF_PI), color: c, matrix: xf([0, 0.075, -0.155]), flat: true }, // barrel
    { tag: 'rib', geo: box(0.012, 0.012, 0.15), color: c, matrix: xf([0, 0.095, -0.155]) }, // top rib
    { geo: tube(0.022, 0.025), color: palette.gunTip, matrix: xf([0, 0.075, -0.2375]) },
    { geo: tube(0.0185, 0.02, 6), color: palette.ammoHeavy, matrix: xf([0, 0.075, -0.13]), outline: false },
    { tag: 'hammer', geo: box(0.012, 0.03, 0.02), color: d, matrix: xf([0, 0.098, 0.012], [-0.5, 0, 0]) }, // hammer
    { geo: new THREE.TorusGeometry(0.02, 0.005, 3, 6, Math.PI), color: d, matrix: xf([0, 0.006, -0.03], [0, HALF_PI, Math.PI]) }, // trigger guard
  ];
  // sand-dollar petals: 5 dark dots on the cylinder's rear face (decal)
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    P.push({ geo: new THREE.SphereGeometry(1, 4, 2), color: palette.sandDollarDots, matrix: xf([Math.cos(a) * 0.018, 0.062 + Math.sin(a) * 0.018, -0.022], [HALF_PI, 0, 0], [0.005, 0.002, 0.009]), outline: false });
  }
  const pearl = palette.stripeCream;
  return {
    kind: 'gun', family: [c, sd, wal], muzzle: [0, 0.075, -0.25],
    iron: ironSights(0.105, -0.015, 0.101, -0.215, 0.38),
    rail: { pos: [0, 0.105, -0.06], length: 0.1 },
    collar: { shape: 'round', y: 0.075, z: -0.105, r: 0.019, len: 0.046 },
    anchors: { cylinder: [0, 0.062, -0.05] },
    pieces: P,
    levels: {
      1: { drop: ['grip', 'rib', 'hammer'], add: [
        { geo: box(0.044, 0.12, 0.052), color: LV.drift, matrix: xf([0, -0.04, 0.02], [-0.15, 0, 0]) }, // plank grip
        { geo: box(0.01, 0.016, 0.03), color: d, matrix: xf([0, 0.093, -0.215]) }, // brazed front blade base
        { geo: box(0.014, 0.045, 0.03), color: d, matrix: xf([0, 0.09, 0.024], [0.9, 0, 0]) }, // big spur hammer
        { geo: tube(0.021, 0.01, 6), color: LV.cord, matrix: xf([0, 0.075, -0.18]), outline: false }, // wire band
      ] },
      3: { add: [
        { geo: box(0.03, 0.035, 0.135), color: c, matrix: xf([0, 0.048, -0.165]) }, // heavy underlug
        ...slots(3, 0.032, 0.04, -0.12, -0.03, 0.01, 0.012), // lug flutes
      ] },
      4: { drop: ['grip', 'rib', 'hammer'], add: [
        { geo: box(0.048, 0.15, 0.06), color: pearl, matrix: xf([0, -0.05, 0.028], [-0.3, 0, 0]) }, // long pearl target grip
        { geo: box(0.054, 0.016, 0.072), color: LV.gold, matrix: inTilt([0, -0.05, 0.028], -0.3, [0, -0.078, 0]) }, // base cap
        { geo: new THREE.CylinderGeometry(0.011, 0.011, 0.052, 6).rotateZ(HALF_PI), color: LV.gold, matrix: xf([0, -0.04, 0.026]), outline: false }, // medallion
        { geo: box(0.018, 0.01, 0.2), color: LV.chrome, matrix: xf([0, 0.106, -0.13]) }, // rib raised on posts (top 0.111)
        ...[0, 1, 2, 3].map((i): Part => ({ geo: box(0.008, 0.014, 0.01), color: d, matrix: xf([0, 0.096, -0.06 - i * 0.05]), outline: false })),
        { geo: box(0.026, 0.024, 0.026), color: LV.chrome, matrix: xf([0, 0.105, -0.215]) }, // front sight hood base
        { geo: box(0.022, 0.05, 0.03), color: LV.chrome, matrix: xf([0, 0.075, 0.012]) }, // hammer shroud (bridges the frame)
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: -0.04, z: 0.025, w: 0.045, h: 0.05 }, { shape: 'round', y: 0.075, z: -0.15, r: 0.017 }],
      loop: [0, -0.09, 0.05],
      brake: { c: [0, 0.075, -0.212], r: 0.024, len: 0.024 },
      grip: { c: [0, -0.035, 0.022], w: 0.045, h: 0.11, d: 0.058, rx: -0.35 },
      trim: { y: 0.04, z0: -0.1, z1: 0.01, x: 0.025 },
      star: [-0.025, 0.035, -0.06],
    },
  };
}

/**
 * Double Scoop Shotgun: mint side-by-side barrels, waffle-cone stock, strawberry + vanilla toy tips. 0.92 m.
 * L1: two hex pipes lashed with cord, driftwood branch stock. L3: ribbed polymer beavertail fore-end, rubber pistol grip,
 * tube stock with a shell cuff and a short waffle-cone butt, choke band. L4: raised chrome vent rib, long mint cone
 * fore-end with a chrome ring, candy sprinkles on the waffle stock, chrome butt cap.
 */
function dbshotgun(): WeaponDesign {
  const m = palette.dbBarrel, d = palette.gunDark, waf = palette.waffle, wood = palette.gunWood;
  const waffleCheck: ColorFn = (_n, cen) => {
    const i = Math.floor((cen.z + 1) * 40) + Math.floor((cen.y + 1) * 40);
    return i % 2 ? palette.waffleDark : waf;
  };
  const P: Part[] = [
    // waffle-cone stock: a 4-sided tapered block, wide at the butt, diamond checker
    { tag: 'stock', geo: new THREE.CylinderGeometry(0.045, 0.075, 0.3, 4, 3).rotateX(HALF_PI).rotateZ(Math.PI / 4), color: waf, matrix: xf([0, 0.02, 0.2], [0.12, 0, 0], [0.8, 1.15, 1]), flat: true, colorFn: waffleCheck },
    { tag: 'wrist', geo: box(0.045, 0.06, 0.09), color: wood, matrix: xf([0, 0.005, 0.03], [-0.2, 0, 0]) }, // wrist
    { geo: box(0.09, 0.085, 0.12), color: d, matrix: xf([0, 0.075, -0.02]) }, // breech
    { geo: tubeX(0.012, 0.1), color: d, matrix: xf([0, 0.045, -0.075]) }, // hinge pin
    { tag: 'fore', geo: box(0.1, 0.05, 0.2), color: wood, matrix: xf([0, 0.045, -0.2]) }, // fore-end
    { tag: 'rib', geo: box(0.016, 0.012, 0.5), color: d, matrix: xf([0, 0.12, -0.33]) }, // rib
    { geo: new THREE.TorusGeometry(0.022, 0.005, 3, 6, Math.PI), color: d, matrix: xf([0, 0.01, -0.035], [0, HALF_PI, Math.PI]) },
  ];
  for (const s of [-1, 1]) {
    P.push({ tag: 'barrels', geo: tube(0.03, 0.5, 8), color: m, matrix: xf([s * 0.031, 0.09, -0.33]) });
    P.push({ geo: tube(0.0315, 0.02, 8), color: palette.ammoShell, matrix: xf([s * 0.031, 0.09, -0.105]), outline: false });
    P.push({ geo: tube(0.034, 0.04, 8), color: s < 0 ? palette.scoopPink : palette.gunTip, matrix: xf([s * 0.031, 0.09, -0.6]) });
  }
  // L4 candy sprinkles on both sides of the waffle stock (decals)
  const SPR = [palette.scoopPink, 0xfff14d, palette.dbBarrel, 0xb8e7ff, palette.gunTip, 0xff7a5c];
  const sprinkles: Part[] = [];
  for (let i = 0; i < 6; i++) {
    const z = 0.1 + (i % 3) * 0.075, side = i < 3 ? -1 : 1;
    const r = 0.075 - ((z - 0.05) / 0.3) * 0.03; // stock radius at z (wide at the receiver end)
    const y = 0.02 - (z - 0.2) * 0.12 + ((i * 7) % 3 - 1) * 0.012;
    sprinkles.push({ geo: box(0.004, 0.006, 0.016), color: SPR[i], matrix: xf([side * (r * 0.707 * 0.8 + 0.001), y, z], [0.9 * (i % 2 ? 1 : -1), 0, 0]), outline: false });
  }
  return {
    kind: 'gun', family: [m, waf, wood], muzzle: [0, 0.09, -0.62],
    iron: ironSights(0.1175, -0.05, 0.126, -0.57, 0.35),
    rail: { pos: [0, 0.1175, 0.0], length: 0.1 },
    collar: { shape: 'box', y: 0.075, z: -0.045, w: 0.09, h: 0.085 },
    anchors: { muzzleL: [-0.031, 0.09, -0.62], muzzleR: [0.031, 0.09, -0.62] },
    pieces: P,
    levels: {
      1: { drop: ['stock', 'barrels'], add: [
        ...[-1, 1].map((s): Part => ({ geo: tube(0.03, 0.5, 6), color: m, matrix: xf([s * 0.031, 0.09, -0.33]), flat: true })), // pipes
        { geo: box(0.134, 0.075, 0.016), color: LV.cord, matrix: xf([0, 0.09, -0.36]), outline: false },
        { geo: box(0.134, 0.075, 0.016), color: LV.cord, matrix: xf([0, 0.09, -0.48]), outline: false },
        { geo: box(0.045, 0.07, 0.3), color: LV.drift, matrix: xf([0, 0.0, 0.2], [0.15, 0, 0]) }, // branch stock
        { geo: box(0.06, 0.1, 0.03), color: LV.driftDark, matrix: inTilt([0, 0.0, 0.2], 0.15, [0, -0.015, 0.15]) },
      ] },
      3: { drop: ['fore', 'stock', 'wrist'], add: [
        { geo: box(0.11, 0.06, 0.24), color: d, matrix: xf([0, 0.042, -0.21]) }, // beavertail fore-end
        ...slots(3, 0.112, 0.042, -0.15, -0.06, 0.03, 0.012, LV.rubber),
        { geo: box(0.045, 0.12, 0.06), color: LV.rubber, matrix: xf([0, -0.03, 0.04], [-0.3, 0, 0]) }, // pistol grip
        { geo: tube(0.02, 0.22), color: d, matrix: xf([0, 0.06, 0.15]) }, // tube stock
        { geo: new THREE.CylinderGeometry(0.04, 0.07, 0.11, 4, 1).rotateX(HALF_PI).rotateZ(Math.PI / 4), color: waf, matrix: xf([0, 0.045, 0.3], [0, 0, 0], [0.8, 1.15, 1]), flat: true, colorFn: waffleCheck }, // waffle butt
        { geo: box(0.06, 0.045, 0.07), color: LV.rubber, matrix: xf([0, 0.06, 0.15]) }, // shell cuff on the tube
        ...[-1, 0, 1].map((i): Part => ({ geo: box(0.016, 0.016, 0.05), color: palette.ammoShell, matrix: xf([i * 0.019, 0.088, 0.15]), outline: false })),
      ] },
      4: { drop: ['fore', 'rib'], add: [
        { geo: box(0.016, 0.008, 0.5), color: LV.chrome, matrix: xf([0, 0.13, -0.33]) }, // raised vent rib
        ...[0, 1, 2, 3].map((i): Part => ({ geo: box(0.008, 0.012, 0.008), color: d, matrix: xf([0, 0.121, -0.15 - i * 0.12]), outline: false })),
        { geo: taper(0.05, 0.022, 0.36, 8), color: m, matrix: xf([0, 0.045, -0.27], [0, 0, 0], [1.1, 0.75, 1]) }, // long cone fore-end
        { geo: tube(0.046, 0.012, 8), color: LV.chrome, matrix: xf([0, 0.045, -0.15], [0, 0, 0], [1.1, 0.75, 1]), outline: false },
        { geo: box(0.07, 0.11, 0.02), color: LV.chrome, matrix: xf([0, 0.002, 0.355], [0.12, 0, 0]) }, // chrome butt cap
        ...sprinkles,
      ] },
    },
    dress: {
      wraps: [{ shape: 'box', y: 0.09, z: -0.42, w: 0.124, h: 0.062 }, { shape: 'box', y: 0.005, z: 0.03, w: 0.045, h: 0.06 }],
      loop: [0, -0.04, 0.35],
      brake: { c: [0, 0.09, -0.55], r: 0.07, len: 0.022, flatY: 0.6 }, // squashed: stays under the bead line
      grip: { c: [0, 0.042, -0.21], w: 0.11, h: 0.06, d: 0.24, rx: 0 },
      trim: { y: 0.075, z0: -0.07, z1: 0.04, x: 0.045 },
      star: [-0.045, 0.075, 0.0],
    },
  };
}

/**
 * Sunburst Launcher: cream tube with a coral spiral, mango sunburst decals, sunburst-ring sight. 1.0 m.
 * L1 drainpipe: no coral end rings, a tin-can exhaust, a driftwood shoulder block lashed under the tube. L3: dark blast
 * flare at the back, front heat collar, carry handle, side-mounted box sight on the left, rubber shoulder pad. L4: chrome venturi
 * bells at both ends, a coral dorsal fin along the top.
 */
function rpg(): WeaponDesign {
  const cr = palette.rpgTube, co = palette.rpgStripe, d = palette.gunDark;
  const AY = 0.1, R = 0.06;
  const spiral: ColorFn = (_n, cen) => {
    const a = Math.atan2(cen.x, cen.y - AY) / (Math.PI * 2);
    const f = (((a + cen.z * 1.6) % 1) + 1) % 1;
    return f < 0.3 ? co : cr;
  };
  const sun = (s: number): Part => {
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
  const P: Part[] = [
    { geo: new THREE.CylinderGeometry(R, R, 1.0, 10, 8, true).rotateX(HALF_PI), color: cr, matrix: xf([0, AY, -0.08]), colorFn: spiral },
    { tag: 'rings', geo: tube(R + 0.006, 0.04, 10), color: co, matrix: xf([0, AY, 0.4]) },
    { tag: 'rings', geo: tube(R + 0.006, 0.04, 10), color: co, matrix: xf([0, AY, -0.56]) },
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
    levels: {
      1: { drop: ['rings'], add: [
        { geo: tube(R + 0.018, 0.07, 6), color: palette.rock, matrix: xf([0, AY, 0.385]), flat: true }, // tin-can exhaust
        { geo: box(0.04, 0.09, 0.3), color: LV.drift, matrix: xf([0, AY - R - 0.04, 0.23]) }, // driftwood shoulder block
        { geo: tube(R + 0.004, 0.014, 8), color: LV.cord, matrix: xf([0, AY - 0.006, 0.12], [0, 0, 0], [1, 1.12, 1]), outline: false },
        { geo: tube(R + 0.004, 0.014, 8), color: LV.cord, matrix: xf([0, AY - 0.006, 0.33], [0, 0, 0], [1, 1.12, 1]), outline: false },
      ] },
      3: { drop: ['rings'], add: [
        { geo: taper(R + 0.045, R + 0.006, 0.1, 10, true), color: d, matrix: xf([0, AY, 0.37]) }, // blast flare
        { geo: box(0.014, 0.04, 0.014), color: d, matrix: xf([0, AY + R + 0.02, -0.1]) }, // carry handle (under the sight line)
        { geo: box(0.014, 0.04, 0.014), color: d, matrix: xf([0, AY + R + 0.02, -0.32]) },
        { geo: box(0.02, 0.014, 0.24), color: d, matrix: xf([0, AY + R + 0.045, -0.21]) },
        { geo: new THREE.CylinderGeometry(R + 0.01, R + 0.01, 0.06, 10, 1, true).rotateX(HALF_PI), color: d, matrix: xf([0, AY, -0.55]) }, // heat collar
        { geo: box(0.032, 0.05, 0.09), color: d, matrix: xf([-0.088, AY + 0.07, -0.06]) }, // side box sight
        { geo: box(0.04, 0.012, 0.03), color: d, matrix: xf([-0.06, AY + 0.052, -0.06]) }, // mount arm
        { geo: tube(0.014, 0.006), color: palette.lensGlass, matrix: xf([-0.088, AY + 0.07, -0.106]), outline: false },
        { geo: box(0.06, 0.025, 0.2), color: LV.rubber, matrix: xf([0, AY - R - 0.008, 0.24]) }, // shoulder pad
      ] },
      4: { drop: ['rings'], add: [
        { geo: taper(R + 0.006, R + 0.026, 0.1, 10, true), color: LV.chrome, matrix: xf([0, AY, -0.53]) }, // front venturi bell
        { geo: taper(R + 0.028, R + 0.006, 0.1, 10, true), color: LV.chrome, matrix: xf([0, AY, 0.37]) }, // rear venturi bell
        { geo: box(0.012, 0.03, 0.3), color: co, matrix: xf([0, AY + R + 0.012, -0.23]) }, // dorsal fin
        { geo: box(0.012, 0.022, 0.12), color: co, matrix: xf([0, AY + R + 0.008, 0.2]) }, // rear fin
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: AY, z: -0.3, r: R }, { shape: 'round', y: AY, z: 0.25, r: R }],
      loop: [0, AY - R - 0.035, 0.3],
      grip: { c: [0, -0.0, -0.25], w: 0.04, h: 0.09, d: 0.05, rx: 0.15 },
      fin: { c: [0, AY - R + 0.005, -0.1], len: 0.14, h: 0.05 },
      trim: { y: AY, z0: -0.5, z1: 0.3, x: R },
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

/**
 * The bespoke body of a weapon at a level: how many tagged L2 parts it drops and how many parts it adds (L2: 0 / 0).
 * Null for unknown ids. Used by tests and docs; the geometry comes from getWeaponGeometry.
 */
export function weaponLevelBody(id: string, level: ItemLevel): { dropped: number; added: number } | null {
  const d = designOf(id);
  if (!d) return null;
  const b = level === 2 ? undefined : d.levels[level];
  if (!b) return { dropped: 0, added: 0 };
  const drop = new Set(b.drop ?? []);
  return { dropped: d.pieces.filter((p) => p.tag && drop.has(p.tag)).length, added: b.add.length };
}

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
  const body = lv === 1 || lv === 3 || lv === 4 ? d.levels[lv] : undefined;
  const drop = new Set(body?.drop ?? []);
  const own = [...d.pieces.filter((p) => !p.tag || !drop.has(p.tag)), ...(body?.add ?? [])];
  const toned = own.map((p) => (fam.has(p.color) && lv !== undefined ? { ...p, color: levelTone(p.color, lv) } : p));
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
