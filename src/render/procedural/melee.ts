/**
 * M2c melee weapons: Shucking Knife, Coconut Machete, Lifeboat Paddle. Owner: graphics-designer.
 * Spec: docs/art/M2c.md §2.1 (models), §7.2 (first-person swing arcs), §15 (per-level models).
 *
 * Frame (same as guns, so the hand socket works unchanged): origin at the grip, blade / paddle head along -Z, +Y up.
 * The knife and machete blades are flat in the YZ plane (thin along X) with the edge on -Y; the paddle blade is flat
 * in the XZ plane (its broad face leads a sideways sweep). Anchors: 'tip' (far end) and 'swingTrail' (middle of the
 * striking part, where the swing-trail VFX anchors). Built through weapons.ts (createWeaponModel), with levels.
 */
import * as THREE from 'three';
import { xf, type ColorFn, type Piece } from './builder';
import { palette } from './materials';
import type { WeaponDesign } from './weapons';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const rod = (r0: number, r1: number, len: number, seg = 8) => new THREE.CylinderGeometry(r1, r0, len, seg).rotateX(HALF_PI);

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

/** Shucking Knife: bulb handle, round guard disc, stubby leaf blade with a white edge stripe. ~0.27 m. */
function knife(): WeaponDesign {
  const st = palette.steel, h = palette.knifeHandle;
  const P: Piece[] = [
    { geo: rod(0.026, 0.021, 0.11, 8), color: h, matrix: xf([0, 0, 0.02]) },
    { geo: new THREE.SphereGeometry(0.026, 8, 4), color: palette.gunTip, matrix: xf([0, 0, 0.08]) },
    { geo: rod(0.036, 0.036, 0.008, 10), color: palette.gunDark, matrix: xf([0, 0, -0.04]) },
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
    dress: {
      wraps: [{ shape: 'round', y: 0, z: 0.03, r: 0.024, len: 0.025 }, { shape: 'round', y: 0, z: 0.058, r: 0.022, len: 0.02 }],
      loop: [0, -0.01, 0.1],
      brake: { c: [0, 0, -0.046], r: 0.045, len: 0.006 }, // L3+: a bigger guard disc
      grip: { c: [0, 0, 0.03], w: 0.05, h: 0.05, d: 0.07, rx: 0 },
      fin: { c: [0, 0.035, -0.11], len: 0.08, h: -0.012 }, // L4: a raised spine ridge (negative h: sits above)
      trim: { y: 0.0, z0: -0.15, z1: -0.055, x: 0.0047 },
      star: [-0.024, 0, 0.05],
    },
  };
}

/** Coconut Machete: cord-wrapped green handle, broad bolo blade with a squared tip and a dark spine stripe. ~0.57 m. */
function machete(): WeaponDesign {
  const st = palette.steel, gh = palette.macheteHandle, gw = palette.macheteWrap;
  const P: Piece[] = [
    { geo: rod(0.022, 0.02, 0.14, 8), color: gh, matrix: xf([0, 0, 0.035]) },
    { geo: box(0.03, 0.04, 0.012), color: palette.gunDark, matrix: xf([0, 0.0, -0.038]) }, // guard
    { geo: taperBlade(0.009, 0.05, 0.085, 0.42), color: st, matrix: xf([0, 0.022, -0.25]), flat: true },
    { geo: box(0.0095, 0.008, 0.42), color: palette.steelSpine, matrix: xf([0, 0.018, -0.25]), outline: false },
    { geo: box(0.0095, 0.006, 0.4), color: palette.steelEdge, matrix: xf([0, -0.04, -0.27], [-0.083, 0, 0]), outline: false },
    { geo: new THREE.TorusGeometry(0.018, 0.004, 3, 8), color: palette.gunTip, matrix: xf([0, 0, 0.12], [0, HALF_PI, 0]), outline: false },
  ];
  for (const z of [0.0, 0.035, 0.07]) {
    P.push({ geo: rod(0.0225, 0.0225, 0.01, 8), color: gw, matrix: xf([0, 0, z]), outline: false });
  }
  for (const z of [0.01, 0.06]) P.push({ geo: box(0.046, 0.008, 0.008), color: palette.wood, matrix: xf([0, 0, z]), outline: false });
  return {
    kind: 'melee', family: [gh, st], pieces: P,
    collar: { shape: 'round', y: 0, z: -0.012, r: 0.022, len: 0.046 },
    anchors: { tip: [0, -0.02, -0.46], swingTrail: [0, -0.02, -0.28] },
    dress: {
      wraps: [{ shape: 'round', y: 0, z: 0.05, r: 0.022, len: 0.03 }, { shape: 'box', y: -0.01, z: -0.12, w: 0.009, h: 0.06, len: 0.025 }],
      loop: [0, -0.01, 0.13],
      brake: { c: [0, 0, -0.042], r: 0.034, len: 0.008 }, // L3+: a round knuckle guard
      grip: { c: [0, 0, 0.035], w: 0.046, h: 0.046, d: 0.12, rx: 0 },
      fin: { c: [0, 0.045, -0.3], len: 0.14, h: -0.015 }, // L4: a raised spine ridge
      trim: { y: -0.015, z0: -0.44, z1: -0.06, x: 0.0047 },
      star: [-0.022, 0, 0.06],
    },
  };
}

/** Lifeboat Paddle: wooden shaft and T-grip, leaf blade painted with a teal tip band and a cream stripe. ~1.3 m. */
function paddle(): WeaponDesign {
  const pl = palette.plank, pd = palette.plankDark, tip = palette.paddleTip;
  const paint: ColorFn = (_n, cen) => (cen.z < -1.04 ? tip : cen.z > -0.86 && cen.z < -0.8 ? palette.stripeCream : pl);
  const P: Piece[] = [
    { geo: rod(0.022, 0.022, 0.86, 8), color: pl, matrix: xf([0, 0, -0.27]) },
    { geo: box(0.13, 0.03, 0.035), color: pd, matrix: xf([0, 0, 0.165]) }, // T-grip
    { geo: rod(0.026, 0.026, 0.03, 8), color: pd, matrix: xf([0, 0, -0.68]) }, // throat ferrule
    // leaf blade: flattened ellipsoid in the XZ plane, segments aligned so the paint bands are clean
    { geo: new THREE.SphereGeometry(1, 10, 8).rotateX(HALF_PI), color: pl, matrix: xf([0, 0, -0.92], [0, 0, 0], [0.095, 0.014, 0.25]), colorFn: paint },
  ];
  return {
    kind: 'melee', family: [pl, pd, tip], pieces: P,
    collar: { shape: 'round', y: 0, z: -0.63, r: 0.022, len: 0.048 },
    anchors: { tip: [0, 0, -1.17], swingTrail: [0, 0, -0.92], handL: [0, 0, -0.38] },
    dress: {
      wraps: [{ shape: 'round', y: 0, z: -0.15, r: 0.022, len: 0.03 }, { shape: 'round', y: 0, z: -0.45, r: 0.022, len: 0.03 }],
      loop: [0, -0.012, 0.17],
      brake: { c: [0, 0, -1.12], r: 0.07, len: 0.06, flatY: 0.3 }, // L3+: a metal tip guard on the blade end
      grip: { c: [0, 0, -0.38], w: 0.05, h: 0.05, d: 0.14, rx: 0 },
      fin: { c: [0, 0.014, -0.92], len: 0.3, h: -0.018 }, // L4: a raised centre rib on the blade
      trim: { y: 0, z0: -0.66, z1: 0.1, x: 0.022 },
      star: [-0.022, 0, -0.05],
    },
  };
}

/** Melee designs keyed by MeleeId (merged into the weapons.ts registry). */
export const MELEE_DESIGNS: Readonly<Record<'knife' | 'machete' | 'paddle', () => WeaponDesign>> = { knife, machete, paddle };
