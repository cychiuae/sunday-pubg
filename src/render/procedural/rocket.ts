/**
 * M2c rocket (Sunburst Launcher round) and the `ammo_rocket` pickup ("Fireworks"). Owner: graphics-designer.
 * Spec: docs/art/M2c.md §3.
 *
 * Rocket frame: origin at the body centre, nose toward -Z, +Y up. 0.5 m long, body r 0.045. Cream body with one coral
 * spiral stripe, coral ogive nose, 4 mango fins at the tail, dark nozzle. Child 'nozzle' at the tail (exhaust flame,
 * smoke-trail emitter). In flight: scale 1, nose along the velocity, roll about Z (~6 rad/s). Loot outline width.
 */
import * as THREE from 'three';
import { buildMerged, xf, type ColorFn, type Merged, type Piece } from './builder';
import { addOutline, OUTLINE, palette, vertexColorToon } from './materials';

const HALF_PI = Math.PI / 2;

export const ROCKET_DIMENSIONS = {
  length: 0.5,
  radius: 0.045,
  /** Tail (exhaust) point in the rocket frame. */
  nozzle: [0, 0, 0.26] as const,
  /** Roll rate in flight (rad/s), visual only. */
  rollRate: 6,
} as const;

function rocketPieces(): Piece[] {
  const R = ROCKET_DIMENSIONS.radius;
  const spiral: ColorFn = (_n, c) => {
    const a = Math.atan2(c.x, c.y) / (Math.PI * 2);
    const f = (((a + c.z * 2.2) % 1) + 1) % 1;
    return f < 0.22 ? palette.rpgStripe : palette.rpgTube;
  };
  const P: Piece[] = [
    { geo: new THREE.CylinderGeometry(R, R, 0.3, 10, 4, true).rotateX(HALF_PI), color: palette.rpgTube, matrix: xf([0, 0, 0.03]), colorFn: spiral },
    // ogive nose: a lathe toward -Z
    {
      geo: new THREE.LatheGeometry([new THREE.Vector2(R, 0), new THREE.Vector2(R * 0.9, 0.05), new THREE.Vector2(R * 0.55, 0.1), new THREE.Vector2(0.001, 0.13)], 10).rotateX(-HALF_PI),
      color: palette.rpgStripe, matrix: xf([0, 0, -0.12]),
    },
    { geo: new THREE.CylinderGeometry(R * 0.7, R, 0.06, 10).rotateX(HALF_PI), color: palette.gunDark, matrix: xf([0, 0, 0.21]) }, // nozzle
    { geo: new THREE.CircleGeometry(R * 0.6, 8), color: palette.ink, matrix: xf([0, 0, 0.241]), outline: false }, // nozzle hole
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    P.push({ geo: new THREE.BoxGeometry(0.006, 0.05, 0.08), color: palette.sunburst, matrix: xf([Math.sin(a) * (R + 0.022), Math.cos(a) * (R + 0.022), 0.15], [0, 0, -a]) });
  }
  return P;
}

let rocketGeo: Merged | null = null;
/** Shared rocket geometry (instance it for every live rocket). */
export function getRocketGeometry(): Merged {
  return (rocketGeo ??= buildMerged(rocketPieces(), 'rocket'));
}

/** A rocket for flight, the reload hand and previews. Group 'rocket' with 'rocketMesh' (+ 'outline') and 'nozzle'. */
export function createRocketModel(): THREE.Object3D {
  const m = getRocketGeometry();
  const root = new THREE.Group();
  root.name = 'rocket';
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = 'rocketMesh';
  mesh.castShadow = true;
  if (m.outline) addOutline(mesh, OUTLINE.small * 1.5, palette.ink, m.outline);
  root.add(mesh);
  const nozzle = new THREE.Object3D();
  nozzle.name = 'nozzle';
  nozzle.position.set(...ROCKET_DIMENSIONS.nozzle);
  root.add(nozzle);
  return root;
}

/**
 * `ammo_rocket` pickup pieces: ONE rocket (the only single-round ammo, so the count reads too) lying diagonally on a
 * low crate with coral/cream stripes and dark corner caps. Frame like other ammo (centred, y about 0).
 */
export function ammoRocketPieces(): Piece[] {
  const P: Piece[] = [
    { geo: new THREE.BoxGeometry(0.36, 0.12, 0.16), color: palette.rpgTube, matrix: xf([0, -0.08, 0]) },
  ];
  for (const x of [-0.12, 0, 0.12]) {
    P.push({ geo: new THREE.BoxGeometry(0.04, 0.122, 0.162), color: palette.rpgStripe, matrix: xf([x, -0.08, 0]), outline: false });
  }
  for (const x of [-0.17, 0.17]) P.push({ geo: new THREE.BoxGeometry(0.024, 0.124, 0.164), color: palette.gunDark, matrix: xf([x, -0.08, 0]), outline: false });
  // the rocket, lying along X on top, tilted a little
  const t = xf([0, 0.035, 0], [0, -HALF_PI, 0.12], 0.8);
  for (const p of rocketPieces()) P.push({ ...p, matrix: t.clone().multiply(p.matrix ?? new THREE.Matrix4()) });
  return P;
}
