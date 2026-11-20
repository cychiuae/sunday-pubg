/**
 * M2c melee weapons: Shucking Knife, Coconut Machete, Lifeboat Paddle. Owner: graphics-designer.
 * Spec: docs/art/M2c.md §2.1 (models), §7.2 (first-person swing arcs), §15 / §17 (a body per item level).
 *
 * Frame (same as guns, so the hand socket works unchanged): origin at the grip, blade / paddle head along -Z, +Y up.
 * The knife and machete blades are flat in the YZ plane (thin along X) with the edge on -Y; the paddle blade is flat
 * in the XZ plane (its broad face leads a sideways sweep). Anchors: 'tip' (far end) and 'swingTrail' (middle of the
 * striking part, where the swing-trail VFX anchors). Built through weapons.ts (createWeaponModel), with levels:
 * `pieces` is the L2 model, `levels[1 | 3 | 4]` swap tagged parts (see weapons.ts "LEVELS").
 */
import * as THREE from 'three';
import { xf, type ColorFn } from './builder';
import { LEVEL_DRESS_COLORS } from './levelCollar';
import { palette } from './materials';
import type { Part, WeaponDesign } from './weapons';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rod = (r0: number, r1: number, len: number, seg = 8) => new THREE.CylinderGeometry(r1, r0, len, seg).rotateX(HALF_PI);
const L = {
  drift: palette.driftwood, driftDark: palette.driftwoodDark, rust: palette.dirt, cord: LEVEL_DRESS_COLORS.cord,
  tape: LEVEL_DRESS_COLORS.tape, rubber: LEVEL_DRESS_COLORS.rubber, chrome: LEVEL_DRESS_COLORS.chrome,
  gold: LEVEL_DRESS_COLORS.star, gem: palette.lensGlass,
} as const;

/** A box whose height (Y) tapers linearly from h0 at +Z to h1 at -Z, top edge kept at y = 0 (blade spine on top). */
function taperBlade(w: number, h0: number, h1: number, len: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, 1, len);
  const pos = g.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const t = 0.5 - pos.getZ(i) / len; // 0 at +Z end, 1 at -Z end
    const h = h0 + (h1 - h0) * t;
    pos.setY(i, pos.getY(i) > 0 ? 0 : -h);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Shucking Knife: bulb handle, round guard disc, stubby leaf blade with a white edge stripe. ~0.27 m.
 * L1 shiv: driftwood stick handle with a cord binding, no guard. L3 tactical: dark crossbar guard, saw teeth on the
 * spine, glass-breaker pommel, ribbed grip. L4: swept gold quillons, gold inlay fuller, chrome bands, a gem pommel.
 */
function knife(): WeaponDesign {
  const st = palette.steel, h = palette.knifeHandle, d = palette.gunDark;
  const P: Part[] = [
    { tag: 'handle', geo: rod(0.026, 0.021, 0.11, 8), color: h, matrix: xf([0, 0, 0.02]) },
    { tag: 'pommel', geo: new THREE.SphereGeometry(0.026, 8, 4), color: palette.gunTip, matrix: xf([0, 0, 0.08]) },
    { tag: 'guard', geo: rod(0.036, 0.036, 0.008, 10), color: d, matrix: xf([0, 0, -0.04]) },
    { geo: taperBlade(0.009, 0.042, 0.03, 0.11), color: st, matrix: xf([0, 0.018, -0.1]), flat: true },
    // leaf tip: a flat 4-sided cone (point forward)
    { geo: new THREE.ConeGeometry(0.02, 0.045, 4).rotateX(-HALF_PI), color: st, matrix: xf([0, 0.003, -0.177], [0, 0, Math.PI / 4], [0.32, 1.05, 1]), flat: true },
    { geo: box(0.0095, 0.005, 0.1), color: palette.steelEdge, matrix: xf([0, -0.009, -0.1]), outline: false },
    { geo: box(0.0095, 0.004, 0.11), color: palette.steelSpine, matrix: xf([0, 0.017, -0.1]), outline: false },
  ];
  return {
    kind: 'melee', family: [h, st], pieces: P,
    collar: { shape: 'round', y: 0, z: -0.012, r: 0.024, len: 0.046 },
    anchors: { tip: [0, 0, -0.2], swingTrail: [0, 0, -0.12] },
    levels: {
      1: { drop: ['handle', 'pommel', 'guard'], add: [
        { geo: rod(0.02, 0.018, 0.13, 6), color: L.drift, matrix: xf([0, 0, 0.025]), flat: true }, // stick handle
        { geo: new THREE.SphereGeometry(0.021, 5, 3), color: L.driftDark, matrix: xf([0, 0, 0.09], [0, 0, 0], [1, 1, 0.7]), flat: true }, // knot
        { geo: rod(0.0215, 0.0215, 0.016, 6), color: L.cord, matrix: xf([0, 0, -0.038]), outline: false }, // cord binding
      ] },
      3: { drop: ['guard', 'pommel'], add: [
        { geo: box(0.014, 0.085, 0.012), color: d, matrix: xf([0, -0.005, -0.042]) }, // crossbar guard
        ...[0, 1, 2, 3].map((i): Part => ({ geo: new THREE.ConeGeometry(0.007, 0.014, 4), color: palette.steelSpine, matrix: xf([0, 0.025, -0.065 - i * 0.022], [0, Math.PI / 4, 0], [0.6, 1, 1]), outline: false })),
        { geo: new THREE.ConeGeometry(0.02, 0.032, 6).rotateX(HALF_PI), color: d, matrix: xf([0, 0, 0.09]) }, // glass breaker
      ] },
      4: { drop: ['guard', 'pommel'], add: [
        { geo: box(0.014, 0.04, 0.012), color: L.gold, matrix: xf([0, 0.022, -0.044], [0.5, 0, 0]) }, // swept quillons
        { geo: box(0.014, 0.04, 0.012), color: L.gold, matrix: xf([0, -0.022, -0.044], [-0.5, 0, 0]) },
        { geo: rod(0.0255, 0.0255, 0.008, 8), color: L.chrome, matrix: xf([0, 0, -0.03]), outline: false },
        { geo: rod(0.023, 0.023, 0.008, 8), color: L.chrome, matrix: xf([0, 0, 0.07]), outline: false },
        { geo: new THREE.OctahedronGeometry(0.022), color: L.gem, matrix: xf([0, 0, 0.095], [0, 0, 0], [1, 1, 1.3]), flat: true }, // gem pommel
        { geo: box(0.0105, 0.008, 0.075), color: L.gold, matrix: xf([0, 0.0, -0.1]), outline: false }, // inlay fuller
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: 0, z: 0.03, r: 0.024, len: 0.025 }, { shape: 'round', y: 0, z: 0.058, r: 0.022, len: 0.02 }],
      loop: [0, -0.01, 0.1],
      grip: { c: [0, 0, 0.03], w: 0.05, h: 0.05, d: 0.07, rx: 0 },
      fin: { c: [0, 0.018, -0.11], len: 0.08, h: -0.012 }, // L4: a raised spine ridge on the spine (negative h: stands up)
      trim: { y: 0.0, z0: -0.15, z1: -0.055, x: 0.0047 },
      star: [-0.024, 0, 0.05],
    },
  };
}

/**
 * Coconut Machete: cord-wrapped green handle, broad bolo blade with a squared tip and a dark spine stripe. ~0.57 m.
 * L1: flat sheet-metal blade with rust patches, nailed driftwood plank handle. L3: saw-back spine, D knuckle bow,
 * ribbed grip. L4: swept wide-tip blade with a chrome edge and a gold fuller, gold guard, gem pommel.
 */
function machete(): WeaponDesign {
  const st = palette.steel, gh = palette.macheteHandle, gw = palette.macheteWrap, d = palette.gunDark;
  const P: Part[] = [
    { tag: 'handle', geo: rod(0.022, 0.02, 0.14, 8), color: gh, matrix: xf([0, 0, 0.035]) },
    { tag: 'guard', geo: box(0.03, 0.04, 0.012), color: d, matrix: xf([0, 0.0, -0.038]) }, // guard
    { tag: 'blade', geo: taperBlade(0.009, 0.05, 0.085, 0.42), color: st, matrix: xf([0, 0.022, -0.25]), flat: true },
    { tag: 'blade', geo: box(0.0095, 0.008, 0.42), color: palette.steelSpine, matrix: xf([0, 0.018, -0.25]), outline: false },
    { tag: 'blade', geo: box(0.0095, 0.006, 0.4), color: palette.steelEdge, matrix: xf([0, -0.04, -0.27], [-0.083, 0, 0]), outline: false },
    { tag: 'lanyard', geo: new THREE.TorusGeometry(0.018, 0.004, 3, 8), color: palette.gunTip, matrix: xf([0, 0, 0.12], [0, HALF_PI, 0]), outline: false },
  ];
  for (const z of [0.0, 0.035, 0.07]) {
    P.push({ tag: 'handle', geo: rod(0.0225, 0.0225, 0.01, 8), color: gw, matrix: xf([0, 0, z]), outline: false });
  }
  for (const z of [0.01, 0.06]) P.push({ tag: 'handle', geo: box(0.046, 0.008, 0.008), color: palette.wood, matrix: xf([0, 0, z]), outline: false });
  return {
    kind: 'melee', family: [gh, st], pieces: P,
    collar: { shape: 'round', y: 0, z: -0.012, r: 0.022, len: 0.046 },
    anchors: { tip: [0, -0.02, -0.46], swingTrail: [0, -0.02, -0.28] },
    levels: {
      1: { drop: ['handle', 'blade'], add: [
        { geo: box(0.034, 0.042, 0.15), color: L.drift, matrix: xf([0, 0, 0.035]) }, // plank handle
        { geo: box(0.038, 0.008, 0.008), color: d, matrix: xf([0, 0, 0.0]), outline: false }, // nails
        { geo: box(0.038, 0.008, 0.008), color: d, matrix: xf([0, 0, 0.07]), outline: false },
        { geo: taperBlade(0.009, 0.062, 0.062, 0.42), color: st, matrix: xf([0, 0.022, -0.25]), flat: true }, // sheet blade
        { geo: box(0.0105, 0.02, 0.05), color: L.rust, matrix: xf([0, -0.005, -0.15]), outline: false }, // rust
        { geo: box(0.0105, 0.016, 0.035), color: L.rust, matrix: xf([0, -0.022, -0.33]), outline: false },
        { geo: box(0.0105, 0.012, 0.03), color: L.rust, matrix: xf([0, 0.008, -0.41]), outline: false },
      ] },
      3: { drop: ['guard'], add: [
        ...[0, 1, 2, 3, 4, 5].map((i): Part => ({ geo: box(0.008, 0.014, 0.014), color: palette.steelSpine, matrix: xf([0, 0.024, -0.1 - i * 0.045], [Math.PI / 4, 0, 0]), outline: false })), // saw back
        { geo: box(0.03, 0.07, 0.012), color: d, matrix: xf([0, -0.015, -0.038]) }, // guard, extended down
        { geo: box(0.012, 0.012, 0.16), color: d, matrix: xf([0, -0.046, 0.04]) }, // knuckle bow
        { geo: box(0.012, 0.04, 0.012), color: d, matrix: xf([0, -0.03, 0.115]) },
      ] },
      4: { drop: ['blade', 'guard', 'lanyard'], add: [
        { geo: taperBlade(0.009, 0.045, 0.11, 0.42), color: st, matrix: xf([0, 0.022, -0.25]), flat: true }, // swept blade
        { geo: box(0.0095, 0.008, 0.42), color: palette.steelSpine, matrix: xf([0, 0.018, -0.25]), outline: false },
        { geo: box(0.0095, 0.007, 0.41), color: L.chrome, matrix: xf([0, -0.0535, -0.255], [-0.153, 0, 0]), outline: false }, // chrome edge
        { geo: box(0.0105, 0.01, 0.25), color: L.gold, matrix: xf([0, 0.0, -0.22]), outline: false }, // gold fuller
        { geo: box(0.03, 0.05, 0.014), color: L.gold, matrix: xf([0, 0.0, -0.038], [0.25, 0, 0]) }, // gold guard
        { geo: new THREE.OctahedronGeometry(0.019), color: L.gem, matrix: xf([0, 0, 0.12], [0, 0, 0], [1, 1, 1.3]), flat: true }, // gem pommel
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: 0, z: 0.05, r: 0.022, len: 0.03 }, { shape: 'box', y: -0.01, z: -0.12, w: 0.009, h: 0.06, len: 0.025 }],
      loop: [0, -0.01, 0.13],
      grip: { c: [0, 0, 0.035], w: 0.046, h: 0.046, d: 0.12, rx: 0 },
      fin: { c: [0, 0.022, -0.3], len: 0.14, h: -0.015 }, // L4: a raised spine ridge on the spine
      trim: { y: -0.015, z0: -0.44, z1: -0.06, x: 0.0047 },
      star: [-0.022, 0, 0.06],
    },
  };
}

/**
 * Lifeboat Paddle: wooden shaft and T-grip, leaf blade painted with a teal tip band and a cream stripe. ~1.3 m.
 * L1: driftwood plank blade with a batten and a crack, knob grip. L3: dark rubber edge rim on the blade, D-grip, metal
 * tip cap, ribbed shaft grip. L4: dark carbon shaft with chrome ferrules, a wider teal blade with a chrome tip and a
 * centre rib, a teal palm grip.
 */
function paddle(): WeaponDesign {
  const pl = palette.plank, pd = palette.plankDark, tip = palette.paddleTip, d = palette.gunDark;
  const paint: ColorFn = (_n, cen) => (cen.z < -1.04 ? tip : cen.z > -0.86 && cen.z < -0.8 ? palette.stripeCream : pl);
  const paint4: ColorFn = (_n, cen) => (cen.z < -1.08 ? L.chrome : Math.abs(cen.x) < 0.02 ? pl : tip);
  const P: Part[] = [
    { tag: 'shaft', geo: rod(0.022, 0.022, 0.86, 8), color: pl, matrix: xf([0, 0, -0.27]) },
    { tag: 'tgrip', geo: box(0.13, 0.03, 0.035), color: pd, matrix: xf([0, 0, 0.165]) }, // T-grip
    { tag: 'shaft', geo: rod(0.026, 0.026, 0.03, 8), color: pd, matrix: xf([0, 0, -0.68]) }, // throat ferrule
    // leaf blade: flattened ellipsoid in the XZ plane, segments aligned so the paint bands are clean
    { tag: 'blade', geo: new THREE.SphereGeometry(1, 10, 8).rotateX(HALF_PI), color: pl, matrix: xf([0, 0, -0.92], [0, 0, 0], [0.095, 0.014, 0.25]), colorFn: paint },
  ];
  return {
    kind: 'melee', family: [pl, pd, tip], pieces: P,
    collar: { shape: 'round', y: 0, z: -0.63, r: 0.022, len: 0.048 },
    anchors: { tip: [0, 0, -1.17], swingTrail: [0, 0, -0.92], handL: [0, 0, -0.38] },
    levels: {
      1: { drop: ['blade', 'tgrip'], add: [
        { geo: box(0.16, 0.022, 0.46), color: L.drift, matrix: xf([0, 0, -0.94]) }, // plank blade
        { geo: box(0.17, 0.028, 0.022), color: L.driftDark, matrix: xf([0, 0, -0.76]), outline: false }, // batten
        { geo: box(0.004, 0.024, 0.14), color: palette.ink, matrix: xf([0.03, 0, -1.03], [0, 0.3, 0]), outline: false }, // crack
        { geo: new THREE.SphereGeometry(0.032, 6, 4), color: L.driftDark, matrix: xf([0, 0, 0.17]), flat: true }, // knob grip
      ] },
      3: { drop: ['tgrip'], add: [
        { geo: new THREE.SphereGeometry(1, 10, 6).rotateX(HALF_PI), color: L.rubber, matrix: xf([0, 0, -0.925], [0, 0, 0], [0.104, 0.01, 0.258]) }, // edge rim
        { geo: box(0.1, 0.024, 0.024), color: pd, matrix: xf([0, 0, 0.15]) }, // D-grip
        { geo: box(0.014, 0.018, 0.1), color: pd, matrix: xf([-0.045, 0, 0.19]) },
        { geo: box(0.014, 0.018, 0.1), color: pd, matrix: xf([0.045, 0, 0.19]) },
        { geo: box(0.104, 0.02, 0.02), color: pd, matrix: xf([0, 0, 0.24]) },
      ] },
      4: { drop: ['shaft', 'blade', 'tgrip'], add: [
        { geo: rod(0.02, 0.02, 0.86, 8), color: d, matrix: xf([0, 0, -0.27]) }, // carbon shaft
        { geo: rod(0.025, 0.025, 0.03, 8), color: L.chrome, matrix: xf([0, 0, -0.68]) },
        { geo: rod(0.024, 0.024, 0.02, 8), color: L.chrome, matrix: xf([0, 0, 0.13]), outline: false },
        { geo: new THREE.SphereGeometry(1, 8, 4), color: tip, matrix: xf([0, 0, 0.165], [0, 0, 0], [0.075, 0.026, 0.032]) }, // palm grip
        { geo: new THREE.SphereGeometry(1, 10, 8).rotateX(HALF_PI), color: tip, matrix: xf([0, 0, -0.92], [0, 0, 0], [0.122, 0.015, 0.25]), colorFn: paint4 }, // wide blade
      ] },
    },
    dress: {
      wraps: [{ shape: 'round', y: 0, z: -0.15, r: 0.022, len: 0.03 }, { shape: 'round', y: 0, z: -0.45, r: 0.022, len: 0.03 }],
      loop: [0, -0.012, 0.2],
      brake: { c: [0, 0, -1.12], r: 0.07, len: 0.06, flatY: 0.3 }, // L3: a metal tip cap on the blade end
      grip: { c: [0, 0, -0.38], w: 0.05, h: 0.05, d: 0.14, rx: 0 },
      fin: { c: [0, 0.015, -0.92], len: 0.3, h: -0.018 }, // L4: a raised centre rib on the blade
      trim: { y: 0, z0: -0.66, z1: 0.1, x: 0.02 },
      star: [-0.022, 0, -0.05],
    },
  };
}

/** Melee designs keyed by MeleeId (merged into the weapons.ts registry). */
export const MELEE_DESIGNS: Readonly<Record<'knife' | 'machete' | 'paddle', () => WeaponDesign>> = { knife, machete, paddle };
