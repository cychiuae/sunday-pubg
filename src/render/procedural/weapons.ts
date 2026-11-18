/**
 * Toy-like weapon models. Owner: graphics-designer. Spec: docs/art/STYLE.md "Weapons".
 *
 * Frame: origin at the grip (where the hand closes), barrel along -Z, top of the gun +Y.
 * A child Object3D named 'muzzle' marks the barrel tip (muzzle flash / tracer origin).
 * Each model = 1 vertex-coloured mesh + 1 outline hull. Geometry cached per id and shared.
 * Family colours: pistol mango, smg teal, shotgun red + wood, rifle green. Every barrel ends in a
 * cream "toy tip". Length (scale 1): pistol 0.26 m, smg 0.52 m, shotgun 0.86 m, rifle 0.88 m.
 */
import * as THREE from 'three';
import type { WeaponId } from '../../shared/types';
import { buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Cylinder lying along Z. */
const tube = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(HALF_PI);

interface WeaponSpec { pieces: Piece[]; muzzle: V3 }

function pistol(): WeaponSpec {
  const c = palette.pistol, d = palette.gunDark;
  return {
    muzzle: [0, 0.06, -0.205],
    pieces: [
      { geo: box(0.06, 0.12, 0.075), color: d, matrix: xf([0, -0.03, 0.02], [-0.25, 0, 0]) },
      { geo: box(0.07, 0.08, 0.24), color: c, matrix: xf([0, 0.055, -0.06]) },
      { geo: box(0.05, 0.025, 0.06), color: d, matrix: xf([0, 0.005, -0.03]), outline: false }, // trigger block
      { geo: tube(0.028, 0.04), color: palette.gunTip, matrix: xf([0, 0.06, -0.185]) },
    ],
  };
}

function smg(): WeaponSpec {
  const c = palette.smg, d = palette.gunDark;
  return {
    muzzle: [0, 0.07, -0.37],
    pieces: [
      { geo: box(0.08, 0.1, 0.34), color: c, matrix: xf([0, 0.06, -0.08]) },
      { geo: box(0.055, 0.12, 0.065), color: d, matrix: xf([0, -0.03, 0.04], [-0.25, 0, 0]) },
      { geo: box(0.05, 0.16, 0.06), color: d, matrix: xf([0, -0.05, -0.15], [0.12, 0, 0]) },
      { geo: tube(0.025, 0.1), color: d, matrix: xf([0, 0.07, -0.29]) },
      { geo: tube(0.032, 0.035), color: palette.gunTip, matrix: xf([0, 0.07, -0.35]) },
      { geo: box(0.05, 0.08, 0.14), color: d, matrix: xf([0, 0.045, 0.15]) },
      { geo: box(0.085, 0.03, 0.07), color: palette.ammoLight, matrix: xf([0, 0.115, -0.12]), outline: false },
    ],
  };
}

function shotgun(): WeaponSpec {
  const c = palette.shotgun, d = palette.gunDark, w = palette.gunWood;
  return {
    muzzle: [0, 0.085, -0.64],
    pieces: [
      { geo: box(0.085, 0.11, 0.22), color: c, matrix: xf([0, 0.06, -0.02]) },
      { geo: tube(0.036, 0.46, 10), color: c, matrix: xf([0, 0.085, -0.36]) },
      { geo: tube(0.048, 0.18, 10), color: w, matrix: xf([0, 0.025, -0.3]) },
      { geo: tube(0.043, 0.04, 10), color: palette.gunTip, matrix: xf([0, 0.085, -0.61]) },
      { geo: box(0.07, 0.12, 0.3), color: w, matrix: xf([0, 0.0, 0.22], [0.15, 0, 0]) },
      { geo: box(0.055, 0.03, 0.05), color: d, matrix: xf([0, 0.0, -0.01]), outline: false },
    ],
  };
}

function rifle(): WeaponSpec {
  const c = palette.rifle, d = palette.gunDark;
  return {
    muzzle: [0, 0.075, -0.62],
    pieces: [
      { geo: box(0.075, 0.11, 0.32), color: c, matrix: xf([0, 0.06, -0.05]) },
      { geo: box(0.07, 0.075, 0.2), color: palette.sandDark, matrix: xf([0, 0.06, -0.3]) },
      { geo: tube(0.024, 0.22), color: d, matrix: xf([0, 0.075, -0.49]) },
      { geo: tube(0.032, 0.04), color: palette.gunTip, matrix: xf([0, 0.075, -0.6]) },
      { geo: box(0.05, 0.17, 0.08), color: d, matrix: xf([0, -0.06, -0.12], [0.25, 0, 0]) },
      { geo: box(0.05, 0.12, 0.06), color: d, matrix: xf([0, -0.03, 0.05], [-0.3, 0, 0]) },
      { geo: box(0.06, 0.12, 0.24), color: c, matrix: xf([0, 0.04, 0.25]) },
      { geo: box(0.03, 0.045, 0.09), color: d, matrix: xf([0, 0.135, -0.05]) },
    ],
  };
}

const SPECS: Record<Exclude<WeaponId, 'fists'>, () => WeaponSpec> = { pistol, smg, shotgun, rifle };

interface CachedWeapon { merged: Merged; muzzle: V3 }
const cache = new Map<string, CachedWeapon>();

/** Shared geometry for a gun (used by loot too). Null for fists / unknown ids. */
export function getWeaponGeometry(id: WeaponId | string): CachedWeapon | null {
  if (id === 'fists') return null;
  const make = SPECS[id as Exclude<WeaponId, 'fists'>];
  if (!make) return null;
  let c = cache.get(id);
  if (!c) {
    const spec = make();
    c = { merged: buildMerged(spec.pieces, `weapon:${id}`), muzzle: spec.muzzle };
    cache.set(id, c);
  }
  return c;
}

/**
 * Held weapon model, or null for fists. Add to `hand_R_socket` / `handR`. Contains a mesh named
 * 'weapon' (with an 'outline' child) and an empty Object3D named 'muzzle' at the barrel tip.
 */
export function createWeaponModel(id: WeaponId): THREE.Object3D | null {
  const c = getWeaponGeometry(id);
  if (!c) return null;
  const root = new THREE.Group();
  root.name = `weapon:${id}`;
  const mesh = new THREE.Mesh(c.merged.geometry, vertexColorToon());
  mesh.name = 'weapon';
  mesh.castShadow = true;
  if (c.merged.outline) addOutline(mesh, OUTLINE.small, palette.ink, c.merged.outline);
  root.add(mesh);
  const muzzle = new THREE.Object3D();
  muzzle.name = 'muzzle';
  muzzle.position.set(c.muzzle[0], c.muzzle[1], c.muzzle[2]);
  root.add(muzzle);
  return root;
}
