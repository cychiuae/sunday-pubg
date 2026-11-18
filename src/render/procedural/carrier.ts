/**
 * Match-start carriers and the parachute (M2b plane drop). Owner: graphics-designer.
 * Spec: docs/art/STYLE.md §20; sizes, tris and named children: docs/art/ASSET_LIST.md "Carriers and parachute".
 *
 * Frames (world metres, scale 1): carriers fly toward local -Z (nose / front), +Y up, origin at the body centre.
 * Spinning parts are separate named children so the engine can rotate them:
 *   seaplane  'propellerL' / 'propellerR' spin about their local Z;  'jumpPoint' at the open side door (-X side)
 *   drone     'rotor0'..'rotor3' spin about their local Y;           'jumpPoint' under the parcel
 * Each spinner also has a hidden 'blur' disc child (show it when spinning fast). Everything else is ONE vertex-
 * coloured mesh + ONE ink hull, the shared toon material, original toy designs (no real aircraft or brand).
 */
import * as THREE from 'three';
import { buildMerged, xf, type ColorFn, type Merged, type Piece, type V3 } from './builder';
import { CHIBI_DIMENSIONS } from './chibi';
import { addOutline, mixHex, OUTLINE, palette, vertexColorToon } from './materials';

export const carrierPalette = {
  planeBody: 0xffd23f, planeBelly: 0xfff4e2, planeStripe: 0xff5a5f, planeWing: 0xfff4e2, planeTip: 0xff5a5f,
  planeFloat: 0x2ec4b6, planeWindow: 0x2b3a5c, planeGlint: 0x9fe8f0, planeInterior: 0x3d3a4b, prop: 0x3d3a4b,
  droneBody: 0xf5f5f2, droneAccent: 0xffc43d, dronePod: 0xff7a5c, droneEye: 0x4fd8d0, droneRotor: 0x3d3a4b,
  parcel: 0xc89a63, parcelDark: 0xa87c48, parcelTape: 0xe8d3a8, parcelLabel: 0x2ec4b6,
} as const;
const C = carrierPalette;

const HALF_PI = Math.PI / 2;
const bc = (w: number, h: number, d: number, c: V3, color: number, r: V3 = [0, 0, 0], outline?: boolean): Piece =>
  ({ geo: new THREE.BoxGeometry(w, h, d), color, matrix: xf(c, r), outline });
/** Cylinder along Z (rRear at +Z, rFront at -Z). */
const tz = (rRear: number, rFront: number, len: number, c: V3, color: number, seg = 10, outline?: boolean): Piece =>
  ({ geo: new THREE.CylinderGeometry(rRear, rFront, len, seg).rotateX(HALF_PI), color, matrix: xf(c), outline });
/** Flat round decal facing +-X (windows) or any direction via rotation. */
const decalX = (c: V3, r: number, color: number, ry = r): Piece =>
  ({ geo: new THREE.SphereGeometry(1, 8, 2).rotateZ(HALF_PI), color, matrix: xf(c, [0, 0, 0], [0.02, ry, r]), outline: false });

function blurDisc(radius: number, axis: 'y' | 'z'): THREE.Mesh {
  const g = new THREE.CircleGeometry(radius, 20);
  if (axis === 'y') g.rotateX(-HALF_PI);
  const m = new THREE.Mesh(g, blurMaterial());
  m.name = 'blur';
  m.visible = false;
  m.renderOrder = 2;
  m.raycast = () => {};
  return m;
}
let blurMat: THREE.MeshBasicMaterial | null = null;
/** Translucent toon "motion disc" for fast spinners. */
export function carrierBlurMaterial(): THREE.MeshBasicMaterial {
  return (blurMat ??= Object.assign(
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    { name: 'carrier:blur' },
  ));
}
const blurMaterial = carrierBlurMaterial;

function meshOf(m: Merged, name: string, outline: number): THREE.Mesh {
  const mesh = new THREE.Mesh(m.geometry, vertexColorToon());
  mesh.name = name;
  mesh.castShadow = true;
  if (m.outline) addOutline(mesh, outline, palette.ink, m.outline);
  return mesh;
}

const cache = new Map<string, Merged>();
function cached(key: string, make: () => Piece[]): Merged {
  let m = cache.get(key);
  if (!m) cache.set(key, (m = buildMerged(make(), key)));
  return m;
}

// -------------------------------------------------------------------------------------------------
// Island seaplane
// -------------------------------------------------------------------------------------------------
export const SEAPLANE_DIMENSIONS = {
  length: 15.2,
  wingspan: 22.6,
  /** Floats bottom to fin top. */
  height: 8.2,
  /** Engine / propeller centres (local). */
  propellers: [[-4.6, 1.55, -4.15], [4.6, 1.55, -4.15]] as readonly V3[],
  propellerRadius: 1.25,
  /** Open side door (on -X), centre of the opening, and the jump point just outside it. */
  door: [-1.78, -0.25, 0.6] as V3,
  jumpPoint: [-2.6, -0.6, 0.6] as V3,
  /** Notional cabin (16 chibis): x -1.6..1.6, y -1.4..1.4, z -4..4. */
  bottomY: -4.0,
} as const;

/** Fuselage lathe profile (r, y) along the body axis, nose (-) to tail (+); turned so +Y -> +Z. */
const FUSE: [number, number][] = [
  [0.02, -7.6], [1.0, -7.25], [1.55, -6.4], [1.8, -5.0], [1.82, 1.6], [1.55, 3.6], [1.0, 5.6], [0.5, 7.0], [0.02, 7.3],
];

function seaplanePieces(): Piece[] {
  const fuseColor: ColorFn = (_n, c) => {
    // The lathe seams sit at +-15 deg from horizontal (phiStart below), so the side segment is exactly the band.
    if (Math.abs(c.y) < 0.42 && Math.abs(c.z) < 5.4) return C.planeStripe; // cheat line
    if (c.y < -1.0) return C.planeBelly;
    return C.planeBody;
  };
  const P: Piece[] = [
    {
      geo: new THREE.LatheGeometry(FUSE.map(([r, y]) => new THREE.Vector2(r, y)), 12, Math.PI / 12).rotateX(HALF_PI),
      color: C.planeBody, matrix: xf([0, 0, 0], [0, 0, 0], [0.95, 1, 1]), colorFn: fuseColor,
    },
    // windshield (two dark panes on the nose top) + glints
    bc(2.3, 1.1, 0.12, [0, 1.42, -5.95], C.planeWindow, [-0.62, 0, 0], false),
    bc(0.22, 0.8, 0.14, [-0.55, 1.46, -5.97], C.planeGlint, [-0.62, 0, 0.45], false),
    // high wing + coral tips, struts
    bc(20.6, 0.42, 3.2, [0, 1.95, -3.0], C.planeWing),
    bc(1.0, 0.46, 3.24, [-10.8, 1.95, -3.0], C.planeTip),
    bc(1.0, 0.46, 3.24, [10.8, 1.95, -3.0], C.planeTip),
    // coral bands across the wing: read from above and from far below
    bc(0.8, 0.45, 3.22, [-7.4, 1.95, -3.0], C.planeTip, [0, 0, 0], false),
    bc(0.8, 0.45, 3.22, [7.4, 1.95, -3.0], C.planeTip, [0, 0, 0], false),
    bc(0.22, 3.0, 0.3, [-3.0, 0.4, -3.0], C.planeStripe, [0, 0, -1.0]),
    bc(0.22, 3.0, 0.3, [3.0, 0.4, -3.0], C.planeStripe, [0, 0, 1.0]),
    // engines: coral nacelles + cream spinners
    tz(0.62, 0.72, 3.0, [-4.6, 1.55, -2.6], C.planeStripe),
    tz(0.62, 0.72, 3.0, [4.6, 1.55, -2.6], C.planeStripe),
    { geo: new THREE.ConeGeometry(0.45, 0.8, 8).rotateX(-HALF_PI), color: C.planeBelly, matrix: xf([-4.6, 1.55, -4.45]) },
    { geo: new THREE.ConeGeometry(0.45, 0.8, 8).rotateX(-HALF_PI), color: C.planeBelly, matrix: xf([4.6, 1.55, -4.45]) },
    // tail: coral fin, cream stabiliser
    bc(0.3, 3.0, 2.6, [0, 2.4, 5.6], C.planeStripe, [-0.35, 0, 0]),
    bc(7.2, 0.28, 1.8, [0, 0.9, 6.2], C.planeWing),
    // open side door (-X): dark opening + door leaf swung forward on its front hinge
    bc(0.2, 2.3, 1.7, [-1.66, -0.25, 0.6], C.planeInterior, [0, 0, 0], false),
    bc(1.6, 2.2, 0.14, [-2.55, -0.25, -0.3], C.planeBody, [0, 0.12, 0]),
    bc(1.6, 0.2, 0.16, [-2.55, 0.75, -0.3], C.planeStripe, [0, 0.12, 0], false),
  ];
  // round cabin windows, both sides (skip the door bay)
  for (const side of [-1, 1] as const) {
    for (const z of [-3.6, -2.2, -0.8, 2.0, 3.3]) {
      if (side === -1 && z > 0 && z < 1.5) continue;
      P.push(decalX([side * 1.72, 0.65, z], 0.42, C.planeWindow));
      P.push(decalX([side * 1.74, 0.78, z - 0.12], 0.12, C.planeGlint));
    }
  }
  // floats: teal pontoons with a cream stripe, two struts each
  for (const s of [-1, 1]) {
    P.push({
      geo: new THREE.CapsuleGeometry(0.62, 7.6, 3, 10).rotateX(HALF_PI), color: C.planeFloat,
      matrix: xf([s * 2.7, -3.35, -0.3]),
      colorFn: (_n, c) => (c.y > -3.05 && c.y < -2.85 ? C.planeBelly : C.planeFloat),
    });
    P.push(bc(0.22, 2.2, 0.3, [s * 2.15, -2.15, -2.6], C.planeStripe, [0, 0, s * 0.5]));
    P.push(bc(0.22, 2.2, 0.3, [s * 2.15, -2.15, 1.8], C.planeStripe, [0, 0, s * 0.5]));
  }
  return P;
}

function propellerPieces(r: number, blades: number, axis: 'z' | 'y'): Piece[] {
  const P: Piece[] = [];
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2;
    if (axis === 'z') P.push(bc(0.32, r, 0.1, [Math.sin(a) * r * 0.5, Math.cos(a) * r * 0.5, 0], C.prop, [0.25, 0, -a]));
    else P.push(bc(r, 0.06, 0.28, [Math.cos(a) * r * 0.5, 0, Math.sin(a) * r * 0.5], C.droneRotor, [0.2, -a, 0]));
  }
  if (axis === 'z') P.push(tz(0.18, 0.18, 0.3, [0, 0, 0], C.planeBelly, 6));
  else P.push({ geo: new THREE.CylinderGeometry(0.16, 0.16, 0.2, 6), color: C.droneAccent, matrix: xf([0, 0, 0]) });
  return P;
}

/**
 * Island carrier: a chunky toy seaplane (yellow fuselage, coral trim, cream high wing, teal floats), twin wing
 * engines, an open side door on the -X side. Flies toward -Z. Children: 'body' (+ 'outline'), 'propellerL',
 * 'propellerR' (rotate about local Z; each has a hidden 'blur' disc), 'jumpPoint', 'door'.
 */
export function createSeaplane(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'carrier:seaplane';
  root.add(meshOf(cached('carrier:seaplane', seaplanePieces), 'body', OUTLINE.large));
  const prop = cached('carrier:seaplane:prop', () => propellerPieces(SEAPLANE_DIMENSIONS.propellerRadius, 3, 'z'));
  SEAPLANE_DIMENSIONS.propellers.forEach((p, i) => {
    const g = new THREE.Group();
    g.name = i === 0 ? 'propellerL' : 'propellerR';
    g.position.set(p[0], p[1], p[2]);
    g.add(meshOf(prop, 'blades', OUTLINE.prop));
    g.add(blurDisc(SEAPLANE_DIMENSIONS.propellerRadius, 'z'));
    root.add(g);
  });
  for (const [name, p] of [['door', SEAPLANE_DIMENSIONS.door], ['jumpPoint', SEAPLANE_DIMENSIONS.jumpPoint]] as const) {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(p[0], p[1], p[2]);
    root.add(o);
  }
  return root;
}

// -------------------------------------------------------------------------------------------------
// Office delivery drone
// -------------------------------------------------------------------------------------------------
export const DRONE_DIMENSIONS = {
  /** Rotor centres (local), spin about local Y. */
  rotors: [[-2.5, 0.75, -2.5], [2.5, 0.75, -2.5], [-2.5, 0.75, 2.5], [2.5, 0.75, 2.5]] as readonly V3[],
  rotorRadius: 1.35,
  /** Overall: 7.7 m across the rotor tips, 4.9 m tall (rotor top +0.85 to parcel bottom -4.05). */
  width: 7.7,
  topY: 0.85,
  bottomY: -4.05,
  jumpPoint: [0, -4.3, 0] as V3,
} as const;

function dronePieces(): Piece[] {
  const P: Piece[] = [
    // body: rounded white shell with a mango band, cyan LED eyes on the front
    { geo: new THREE.SphereGeometry(1, 12, 7), color: C.droneBody, matrix: xf([0, 0, 0], [0, 0, 0], [1.6, 0.85, 1.6]), colorFn: (_n, c) => (Math.abs(c.y) < 0.18 ? C.droneAccent : C.droneBody) },
    { geo: new THREE.SphereGeometry(1, 8, 3).rotateX(HALF_PI), color: C.droneEye, matrix: xf([-0.45, 0.25, -1.48], [-0.1, 0, 0], [0.22, 0.28, 0.04]), outline: false },
    { geo: new THREE.SphereGeometry(1, 8, 3).rotateX(HALF_PI), color: C.droneEye, matrix: xf([0.45, 0.25, -1.48], [-0.1, 0, 0], [0.22, 0.28, 0.04]), outline: false },
    { geo: new THREE.CylinderGeometry(0.25, 0.3, 0.35, 8), color: C.droneAccent, matrix: xf([0, 0.85, 0]) }, // top beacon
  ];
  for (const r of DRONE_DIMENSIONS.rotors) {
    const len = Math.hypot(r[0], r[2]);
    const a = Math.atan2(r[0], r[2]);
    P.push(bc(0.35, 0.3, len, [r[0] / 2, 0.25, r[2] / 2], C.droneBody, [0, a, 0]));
    P.push({ geo: new THREE.CylinderGeometry(0.42, 0.48, 0.6, 8), color: C.dronePod, matrix: xf([r[0], r[1] - 0.45, r[2]]) });
  }
  // claw straps + the parcel (cardboard, tape cross, teal label)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    P.push(bc(0.12, 1.4, 0.12, [sx * 0.8, -1.2, sz * 0.8], C.droneRotor, [sz * 0.25, 0, -sx * 0.25]));
  }
  P.push(bc(3.0, 2.2, 2.6, [0, -2.95, 0], C.parcel));
  P.push(bc(3.02, 0.25, 2.62, [0, -2.95, 0], C.parcelDark, [0, 0, 0], false));
  P.push(bc(0.35, 0.02, 2.62, [0, -1.84, 0], C.parcelTape, [0, 0, 0], false));
  P.push(bc(0.35, 1.0, 0.02, [0, -2.35, -1.31], C.parcelTape, [0, 0, 0], false));
  P.push(bc(0.9, 0.6, 0.02, [0.85, -3.3, -1.31], C.parcelLabel, [0, 0, 0], false));
  return P;
}

/**
 * Office carrier: a compact toy quadcopter carrying a big cardboard parcel. Flies toward -Z (LED eyes in front).
 * Children: 'body' (+ 'outline'), 'rotor0'..'rotor3' (rotate about local Y; alternate spin directions; each has a
 * hidden 'blur' disc), 'jumpPoint'. Origin at the body centre: at 25 m altitude the top is at 25.85 m, under the
 * 27 m ceiling.
 */
export function createDeliveryDrone(): THREE.Group {
  const root = new THREE.Group();
  root.name = 'carrier:drone';
  root.add(meshOf(cached('carrier:drone', dronePieces), 'body', OUTLINE.prop));
  const rotor = cached('carrier:drone:rotor', () => propellerPieces(DRONE_DIMENSIONS.rotorRadius, 2, 'y'));
  DRONE_DIMENSIONS.rotors.forEach((p, i) => {
    const g = new THREE.Group();
    g.name = `rotor${i}`;
    g.position.set(p[0], p[1], p[2]);
    g.userData.spin = i === 0 || i === 3 ? 1 : -1;
    g.add(meshOf(rotor, 'blades', OUTLINE.prop));
    g.add(blurDisc(DRONE_DIMENSIONS.rotorRadius, 'y'));
    root.add(g);
  });
  const j = new THREE.Object3D();
  j.name = 'jumpPoint';
  j.position.set(...DRONE_DIMENSIONS.jumpPoint);
  root.add(j);
  return root;
}

// -------------------------------------------------------------------------------------------------
// Parachute
// -------------------------------------------------------------------------------------------------
/** Stripe pairs (beach towel / umbrella). Index with any integer (wraps). */
export const PARACHUTE_STRIPES: readonly (readonly [number, number])[] = [
  [0xff5a5f, 0xfff4e2], // coral umbrella
  [0x3fb7e8, 0xffffff], // towel blue
  [0xffc43d, 0x2ec4b6], // mango / teal
  [0xff8fb1, 0xffffff], // bubblegum
  [0x8ac926, 0xfff4e2], // lime
  [0xb8a4f0, 0xffffff], // lilac
];

export const PARACHUTE_DIMENSIONS = {
  /** Canopy dome: sphere radius, flattened to `squash` in Y, cut at `theta`. */
  radius: 2.8,
  squash: 0.55,
  theta: Math.PI * 0.42,
  /** Canopy sphere centre above the chibi's feet (root frame). Canopy top ~5.45 m, rim ~4.3 m, rim radius 2.73. */
  centerY: 3.9,
  gores: 8,
  /** Riser points at the shoulders (root frame). */
  risers: [[-CHIBI_DIMENSIONS.shoulderX, CHIBI_DIMENSIONS.shoulderY + 0.06, 0], [CHIBI_DIMENSIONS.shoulderX, CHIBI_DIMENSIONS.shoulderY + 0.06, 0]] as readonly V3[],
  /** Packed backpack on the chibi's back (root frame). */
  pack: [0, 0.64, 0.2] as V3,
} as const;

function canopyPieces(stripe: number): Piece[] {
  const D = PARACHUTE_DIMENSIONS;
  const [a, b] = PARACHUTE_STRIPES[((stripe % PARACHUTE_STRIPES.length) + PARACHUTE_STRIPES.length) % PARACHUTE_STRIPES.length];
  const gore = (dim: number): ColorFn => (_n, c) => {
    const az = Math.atan2(c.x, c.z) + Math.PI;
    const k = Math.floor(az / ((Math.PI * 2) / D.gores));
    const col = k % 2 ? b : a;
    return dim ? mixHex(col, palette.ink, dim) : col;
  };
  // phiStart 0: the sphere's columns line up with the gore boundaries, so each gore is exactly 2 clean columns.
  const dome = () => new THREE.SphereGeometry(D.radius, D.gores * 2, 4, 0, Math.PI * 2, 0, D.theta);
  const m = xf([0, D.centerY, 0], [0, 0, 0], [1, D.squash, 1]);
  const inner = xf([0, D.centerY - 0.02, 0], [0, 0, 0], [0.985, D.squash * 0.985, -0.985]); // mirrored: flipped winding
  return [
    { geo: dome(), color: a, matrix: m, colorFn: gore(0) },
    { geo: dome(), color: a, matrix: inner, colorFn: gore(0.28), outline: false, flat: true },
    // small vent cap on top
    { geo: new THREE.CylinderGeometry(0.35, 0.45, 0.12, 8), color: b, matrix: xf([0, D.centerY + D.radius * D.squash - 0.02, 0]), outline: false },
  ];
}

function linePieces(): Piece[] {
  const D = PARACHUTE_DIMENSIONS;
  const rimR = D.radius * Math.sin(D.theta) * 0.98;
  const rimY = D.centerY + D.radius * Math.cos(D.theta) * D.squash;
  const P: Piece[] = [];
  for (let i = 0; i < D.gores; i++) {
    const az = (i / D.gores) * Math.PI * 2;
    const top = new THREE.Vector3(Math.sin(az) * rimR, rimY, Math.cos(az) * rimR);
    const r = D.risers[top.x < 0 ? 0 : 1];
    const bot = new THREE.Vector3(r[0], r[1] + 0.25, r[2]);
    const dir = top.clone().sub(bot);
    const len = dir.length();
    const mid = top.clone().add(bot).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    P.push({ geo: new THREE.CylinderGeometry(0.018, 0.018, len, 3, 1, true), color: palette.inkSoft, matrix: new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1)), outline: false });
  }
  for (const r of D.risers) P.push({ geo: new THREE.CylinderGeometry(0.035, 0.035, 0.3, 4, 1, true), color: palette.inkSoft, matrix: xf([r[0], r[1] + 0.12, r[2]]), outline: false });
  return P;
}

function packPieces(stripe: number): Piece[] {
  const D = PARACHUTE_DIMENSIONS;
  const [a, b] = PARACHUTE_STRIPES[((stripe % PARACHUTE_STRIPES.length) + PARACHUTE_STRIPES.length) % PARACHUTE_STRIPES.length];
  return [
    bc(0.3, 0.34, 0.14, D.pack, a),
    bc(0.31, 0.06, 0.15, [D.pack[0], D.pack[1] + 0.06, D.pack[2]], b, [0, 0, 0], false),
    bc(0.05, 0.05, 0.03, [0.1, D.pack[1] - 0.12, D.pack[2] + 0.075], palette.gunDark, [0, 0, 0], false), // ripcord handle
  ];
}

export interface ParachuteOptions {
  /** Stripe pair index into PARACHUTE_STRIPES (wraps), e.g. player id or team. Default 0 (coral umbrella). */
  stripe?: number;
  /** Initial deploy amount 0 (packed) .. 1 (open). Default 1. */
  deploy?: number;
}

/**
 * Parachute for one chibi. Parent it to the chibi STANCE pivot (CharacterModel.chibi.parts.stance) with an identity
 * transform: the geometry is authored in the stance / root frame (feet at origin, facing -Z), lines end at the
 * shoulders. On the stance pivot the backpack follows the freefall pose (which rotates the stance pivot, see
 * CHIBI_FREEFALL); at rest the stance frame equals the root frame.
 * Children: 'canopy' (+ 'outline'; pivot at the risers, scale it to deploy), 'lines' (pivot at the risers),
 * 'pack' (backpack, shown while packed). Use setParachuteDeploy(obj, k) to animate.
 */
export function createParachute(opts: ParachuteOptions = {}): THREE.Group {
  const stripe = opts.stripe ?? 0;
  const key = ((stripe % PARACHUTE_STRIPES.length) + PARACHUTE_STRIPES.length) % PARACHUTE_STRIPES.length;
  const root = new THREE.Group();
  root.name = 'parachute';
  root.userData.stripe = key;
  const pivotY = PARACHUTE_DIMENSIONS.risers[0][1];
  const pivot = (name: string, m: Merged, outline: number) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.y = pivotY;
    const mesh = meshOf(m, `${name}Mesh`, outline);
    mesh.position.y = -pivotY;
    mesh.castShadow = name === 'canopy';
    g.add(mesh);
    root.add(g);
    return g;
  };
  pivot('canopy', cached(`parachute:canopy:${key}`, () => canopyPieces(key)), OUTLINE.prop);
  pivot('lines', cached('parachute:lines', linePieces), OUTLINE.small);
  const pack = meshOf(cached(`parachute:pack:${key}`, () => packPieces(key)), 'pack', OUTLINE.character);
  root.add(pack);
  setParachuteDeploy(root, opts.deploy ?? 1);
  return root;
}

const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};

/**
 * Deploy state: k = 0 packed (only the backpack), 0..1 deploying (a tall narrow bundle that pops wide with a little
 * overshoot), 1 fully open. Values > 1 up to 2 collapse it after landing (canopy sinks and flattens behind).
 */
export function setParachuteDeploy(parachute: THREE.Object3D, k: number): void {
  const canopy = parachute.getObjectByName('canopy');
  const lines = parachute.getObjectByName('lines');
  const pack = parachute.getObjectByName('pack');
  if (!canopy || !lines || !pack) return;
  pack.visible = k <= 0.02;
  canopy.visible = lines.visible = k > 0.02 && k < 1.98;
  canopy.position.z = 0;
  canopy.rotation.x = 0;
  if (k <= 1) {
    const t = Math.max(0, k);
    const wide = 0.12 + 0.88 * easeOutBack(t);
    const tall = Math.min(1, 0.25 + t * 1.5);
    canopy.scale.set(wide, tall * (1.6 - 0.6 * t), wide);
    lines.scale.set(Math.max(0.05, wide), tall, Math.max(0.05, wide));
  } else {
    // Collapse after touchdown: tip backward (+Z) and flatten.
    const c = Math.min(1, k - 1);
    canopy.scale.set(1, 1 - 0.8 * c, 1);
    canopy.rotation.x = 1.3 * c;
    canopy.position.z = 1.5 * c;
    lines.scale.set(1, 1 - 0.9 * c, 1);
  }
}
