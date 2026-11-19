/**
 * M2c scope attachments (Addendum 1): red dot, 2x, 4x, 8x. Owner: graphics-designer. Spec: docs/art/M2c.md §14.
 *
 * SCOPE FRAME (every scope): origin = centre of the mount footprint on the rail's TOP surface, optics toward -Z,
 * +Y up. Mounting: put the scope at the gun's `rail` anchor with no rotation and scale 1. Then the gun's sight is
 *   eye  = rail + SCOPE_GEOMETRY[id].eye        rear = rail + SCOPE_GEOMETRY[id].rear
 * so the first-person ADS rule (socket = -eye, rot 0) lines up for every gun/scope pair with no hand-tuned numbers.
 * The default optics of the rifle / lmg (red dot), dmr (4x) and sniper (8x) are these same models on the rail and
 * reproduce the M2a/M2b eye points exactly (unit-tested).
 *
 * Each scope has its own accent colour (the same on any gun, on the ground, on the icon and on the overlay rim):
 * red dot cream, 2x coral, 4x cornflower, 8x bubblegum. Silhouettes: open ring hood / boxy prism / medium tube /
 * long tube with a big bell.
 */
import * as THREE from 'three';
import type { ScopeId } from '../../shared/types';
import { buildMerged, xf, type Merged, type Piece, type V3 } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

const HALF_PI = Math.PI / 2;
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const tube = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(HALF_PI);
const hood = (r: number, len: number, seg = 8) => new THREE.CylinderGeometry(r, r, len, seg, 1, true).rotateX(HALF_PI);
const bell = (rRear: number, rFront: number, len: number, seg = 10) => new THREE.CylinderGeometry(rRear, rFront, len, seg).rotateX(HALF_PI);
const tubeX = (r: number, len: number, seg = 6) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(HALF_PI);

/** Optical sight types a scope gives (render-side names = the shared M2c sight types). */
export type ScopeSightType = 'red_dot' | 'scope_2x' | 'scope_4x' | 'scope_8x';

export interface ScopeGeometryInfo {
  sight: ScopeSightType;
  /** Optical axis height above the rail top. */
  axisY: number;
  /** Eye point (eye relief included), scope frame. */
  eye: V3;
  /** Rear aperture / rear lens centre, scope frame. */
  rear: V3;
  /** Rear aperture radius (m). */
  apertureRadius: number;
  /** Span of the mount bases along Z (must fit inside the gun's railLength). */
  footprint: number;
  /** Accent colour (lips, turrets, band). */
  accent: number;
  /** Ground loot scale (all four read at a similar size). */
  lootScale: number;
}

/** docs/art/M2c.md §14.3. */
export const SCOPE_GEOMETRY: Readonly<Record<ScopeId, ScopeGeometryInfo>> = {
  scope_red_dot: {
    sight: 'red_dot', axisY: 0.05, eye: [0, 0.05, 0.0325 + 0.3], rear: [0, 0.05, 0.0325], apertureRadius: 0.03,
    footprint: 0.07, accent: 0xfff3d6, lootScale: 2.2,
  },
  scope_2x: {
    sight: 'scope_2x', axisY: 0.052, eye: [0, 0.052, 0.06 + 0.12], rear: [0, 0.052, 0.06], apertureRadius: 0.022,
    footprint: 0.09, accent: 0xff7a5c, lootScale: 2.0,
  },
  scope_4x: {
    sight: 'scope_4x', axisY: 0.057, eye: [0, 0.057, 0.16 + 0.08], rear: [0, 0.057, 0.16], apertureRadius: 0.038 - 0.008,
    footprint: 0.17, accent: palette.dmr, lootScale: 1.6,
  },
  scope_8x: {
    sight: 'scope_8x', axisY: 0.068, eye: [0, 0.068, 0.25 + 0.08], rear: [0, 0.068, 0.25], apertureRadius: 0.044 - 0.008,
    footprint: 0.23, accent: palette.ammoSniper, lootScale: 1.3,
  },
};

export const SCOPE_MODEL_IDS: readonly ScopeId[] = ['scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x'];

/** The ScopeId that draws a sight type (for default optics). */
export const SCOPE_FOR_SIGHT: Readonly<Record<ScopeSightType, ScopeId>> = {
  red_dot: 'scope_red_dot', scope_2x: 'scope_2x', scope_4x: 'scope_4x', scope_8x: 'scope_8x',
};

interface TubeOpts {
  ay: number; zFront: number; zRear: number; r: number; rObj: number; objLen: number; rEye: number; eyeLen: number;
  accent: number; mounts: [number, number];
}

/** Telescopic sight (scope frame, rail top at y 0). The M2a geometry, re-based on the mount centre. */
function tubePieces(o: TubeOpts): Piece[] {
  const d = palette.gunDark;
  const len = o.zRear - o.zFront;
  const zMid = (o.zRear + o.zFront) / 2;
  const objZ = o.zFront - o.objLen / 2;
  const objFront = o.zFront - o.objLen;
  const eyeZ = o.zRear + o.eyeLen / 2;
  const eyeRear = o.zRear + o.eyeLen;
  const mountH = o.ay - o.r + 0.01;
  return [
    { geo: tube(o.r, len, 10), color: d, matrix: xf([0, o.ay, zMid]) },
    { geo: bell(o.r, o.rObj, o.objLen, 10), color: d, matrix: xf([0, o.ay, objZ]) },
    { geo: tube(o.rObj + 0.003, 0.022, 10), color: o.accent, matrix: xf([0, o.ay, objFront - 0.008]) },
    { geo: tube(o.rObj - 0.006, 0.006, 10), color: palette.lensGlass, matrix: xf([0, o.ay, objFront - 0.017]), outline: false },
    { geo: bell(o.rEye, o.r, o.eyeLen, 10), color: d, matrix: xf([0, o.ay, eyeZ]) },
    { geo: tube(o.rEye + 0.002, 0.014, 10), color: o.accent, matrix: xf([0, o.ay, eyeRear - 0.012]), outline: false },
    { geo: tube(o.rEye - 0.008, 0.006, 10), color: palette.lensGlass, matrix: xf([0, o.ay, eyeRear + 0.001]), outline: false },
    { geo: new THREE.CylinderGeometry(0.019, 0.019, 0.034, 6), color: o.accent, matrix: xf([0, o.ay + o.r + 0.012, zMid]) },
    { geo: tubeX(0.019, 0.034), color: o.accent, matrix: xf([o.r + 0.012, o.ay, zMid]) },
    { geo: box(0.034, mountH, 0.03), color: d, matrix: xf([0, mountH / 2 - 0.005, o.mounts[0]]) },
    { geo: box(0.034, mountH, 0.03), color: d, matrix: xf([0, mountH / 2 - 0.005, o.mounts[1]]) },
  ];
}

/** Red dot (the M2a sight, re-based): low block, open hood, cream front band, red dot; the lens is separate. */
function redDotPieces(): { body: Piece[]; lens: Piece[] } {
  const d = palette.gunDark;
  const ay = 0.05, len = 0.065;
  return {
    body: [
      { geo: box(0.05, 0.026, 0.07), color: d, matrix: xf([0, 0.011, 0]) },
      { geo: hood(0.033, len, 8), color: d, matrix: xf([0, ay, 0]) },
      { geo: hood(0.0345, 0.018, 8), color: SCOPE_GEOMETRY.scope_red_dot.accent, matrix: xf([0, ay, -len / 2 + 0.009]), outline: false },
      { geo: tube(0.0055, 0.003, 8), color: palette.redDot, matrix: xf([0, ay, -0.0075]), outline: false },
    ],
    lens: [{ geo: tube(0.029, 0.004, 10), color: palette.lensGlass, matrix: xf([0, ay, -0.0115]), outline: false }],
  };
}

/** 2x prism sight: square housing, round objective with a coral lip, squared eyepiece hood, one top turret. */
function prism2xPieces(): Piece[] {
  const d = palette.gunDark, a = SCOPE_GEOMETRY.scope_2x.accent, ay = SCOPE_GEOMETRY.scope_2x.axisY;
  return [
    { geo: box(0.04, 0.022, 0.09), color: d, matrix: xf([0, 0.011, 0]) },
    { geo: box(0.05, 0.05, 0.09), color: d, matrix: xf([0, ay, 0]) },
    { geo: tube(0.026, 0.025, 8), color: d, matrix: xf([0, ay, -0.0575]) },
    { geo: tube(0.029, 0.009, 8), color: a, matrix: xf([0, ay, -0.0735]) },
    { geo: tube(0.021, 0.004, 8), color: palette.lensGlass, matrix: xf([0, ay, -0.0785]), outline: false },
    { geo: box(0.046, 0.044, 0.015), color: d, matrix: xf([0, ay, 0.0525]) },
    { geo: box(0.036, 0.034, 0.003), color: palette.lensGlass, matrix: xf([0, ay, 0.0605]), outline: false },
    { geo: new THREE.CylinderGeometry(0.014, 0.014, 0.018, 6), color: a, matrix: xf([0, ay + 0.034, -0.005]) },
  ];
}

function scopePieces(id: ScopeId): { body: Piece[]; lens: Piece[] } {
  switch (id) {
    case 'scope_red_dot': return redDotPieces();
    case 'scope_2x': return { body: prism2xPieces(), lens: [] };
    case 'scope_4x':
      return { body: tubePieces({ ay: 0.057, zFront: -0.11, zRear: 0.11, r: 0.03, rObj: 0.044, objLen: 0.06, rEye: 0.038, eyeLen: 0.05, accent: SCOPE_GEOMETRY.scope_4x.accent, mounts: [-0.07, 0.07] }), lens: [] };
    case 'scope_8x':
      return { body: tubePieces({ ay: 0.068, zFront: -0.2, zRear: 0.18, r: 0.033, rObj: 0.056, objLen: 0.1, rEye: 0.044, eyeLen: 0.07, accent: SCOPE_GEOMETRY.scope_8x.accent, mounts: [-0.1, 0.1] }), lens: [] };
  }
}

/** Scope pieces moved to a rail anchor (weapon frame); used by weapons.ts to merge a mounted scope. */
export function mountedScopePieces(id: ScopeId, rail: V3): { body: Piece[]; lens: Piece[] } {
  const t = new THREE.Matrix4().makeTranslation(rail[0], rail[1], rail[2]);
  const move = (ps: Piece[]) => ps.map((p) => ({ ...p, matrix: t.clone().multiply(p.matrix ?? new THREE.Matrix4()) }));
  const s = scopePieces(id);
  return { body: move(s.body), lens: move(s.lens) };
}

/** True if a scope's mount footprint fits a rail of this usable length. */
export function scopeFitsRail(id: ScopeId, railLength: number): boolean {
  return SCOPE_GEOMETRY[id].footprint <= railLength + 1e-9;
}

const cache = new Map<ScopeId, { merged: Merged; lens: THREE.BufferGeometry | null }>();
/** Shared geometry of a scope on its own (scope frame): loot and previews. */
export function getScopeGeometry(id: ScopeId): { merged: Merged; lens: THREE.BufferGeometry | null } {
  let c = cache.get(id);
  if (!c) {
    const s = scopePieces(id);
    c = { merged: buildMerged(s.body, `scope:${id}`), lens: s.lens.length ? buildMerged(s.lens, `scope:${id}:lens`).geometry : null };
    cache.set(id, c);
  }
  return c;
}

/**
 * A standalone scope (scope frame), e.g. for a preview. Children: 'scope' mesh (+ 'outline'), optional 'lens', and an
 * empty 'eye' at SCOPE_GEOMETRY[id].eye. For a gun with a mounted scope use createWeaponModel(id, { scope }).
 */
export function createScopeModel(id: ScopeId): THREE.Object3D {
  const g = getScopeGeometry(id);
  const root = new THREE.Group();
  root.name = `scope:${id}`;
  root.userData.scopeId = id;
  root.userData.sightType = SCOPE_GEOMETRY[id].sight;
  const mesh = new THREE.Mesh(g.merged.geometry, vertexColorToon());
  mesh.name = 'scope';
  mesh.castShadow = true;
  if (g.merged.outline) addOutline(mesh, OUTLINE.small, palette.ink, g.merged.outline);
  root.add(mesh);
  const eye = new THREE.Object3D();
  eye.name = 'eye';
  eye.position.set(...SCOPE_GEOMETRY[id].eye);
  root.add(eye);
  return root;
}
