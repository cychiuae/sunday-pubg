/**
 * Island prop kit. Owner: graphics-designer. Spec: docs/art/STYLE.md + docs/art/ASSET_LIST.md.
 *
 * Every prop = ONE vertex-coloured mesh ('body', shared toon material) + ONE outline hull ('outline'),
 * plus 'flame' for the tiki torch. Origin at ground centre, scale 1 = sizes below, front faces -Z.
 * All kinds are instanceable: use `getPropParts(kind)` and build one InstancedMesh per part, with
 * instanceMatrix = T(x, heightAt(x,z), z) * R_y(rotY) * S(scale) * part.matrix.
 *
 * Scale-1 sizes:
 *   palm      trunk r 0.32 -> 0.20, 6.6 m tall, leans +X by 1.4 m; frond crown ~6 m wide
 *   rock      ~1.5 m radius (x 1.5, z 1.35), 1.4 m above ground (base sunk 0.7 m)
 *   bush      ~0.9 m radius, 1.1 m tall
 *   crate     1 x 1 x 1
 *   hut       4 x 4 footprint (walls 3.6 m, roof eaves 4.7 m), 4.9 m tall, door faces local +Z
 *   dock      3 m wide (x -1.5..1.5), 14 m long along local Z, origin at deck centre (z -7..7), deck top y 0.55
 *   umbrella  canopy r 1.2 at 2.25 m, towel 0.9 x 1.7
 *   boat      1.5 x 4 m rowboat, 0.55 m tall, long axis local Z
 *   tikiTorch 2.4 m tall, flame at y ~2.2
 *   driftwood ~2.4 m log lying along local Z
 */
import * as THREE from 'three';
import type { PropKind } from '../../shared/types';
import { alongY, buildMerged, rng, xf, type Merged, type Piece, type V3 } from './builder';
import { ensureOutlineNormals, OUTLINE, outlineMaterial, palette, vertexColorToon } from './materials';
import { islandVariant, ISLAND_VARIANTS } from '../../shared/kits/island';

export { ISLAND_VARIANTS };

export const PROP_KINDS: readonly PropKind[] = [
  'palm', 'rock', 'bush', 'crate', 'hut', 'dock', 'umbrella', 'boat', 'tikiTorch', 'driftwood',
];

/** World-space offset (scale 1) of the tiki flame centre, for a PointLight or flicker VFX. */
export const TIKI_FLAME_OFFSET: V3 = [0, 2.2, 0];

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// -------------------------------------------------------------------------------------------------
// Piece lists per kind
// -------------------------------------------------------------------------------------------------
function palmPieces(variant = 0): Piece[] {
  const P: Piece[] = [];
  const SEGS = 7, H = 6.6, LEAN = 1.4;
  const pt = (t: number) => v(LEAN * t * t, H * t, 0);
  for (let i = 0; i < SEGS; i++) {
    const t0 = i / SEGS, t1 = (i + 1) / SEGS;
    const a = pt(t0), b = pt(t1);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const rBot = lerp(0.32, 0.2, t0);
    const rTop = lerp(0.32, 0.2, t1) * 0.86; // notch between segments reads as trunk rings
    // Open-ended: segment 0's caps sit inside the root flare / segment 1 (notch); top is in the crown.
    P.push({
      geo: new THREE.CylinderGeometry(rTop, rBot, len * 1.04, 6, 1, true),
      color: i % 2 ? palette.palmTrunkDark : palette.palmTrunk,
      matrix: alongY([mid.x, mid.y, mid.z], dir),
      flat: true,
    });
  }
  // Root flare
  // Open-ended: the bottom is below ground, the top is inside the (wider) first trunk segment.
  P.push({ geo: new THREE.CylinderGeometry(0.3, 0.44, 0.35, 6, 1, true), color: palette.palmTrunkDark, matrix: xf([0, 0.1, 0]), flat: true });

  const top = pt(1);
  P.push({ geo: new THREE.SphereGeometry(0.27, 6, 4), color: palette.palmLeafDark, matrix: xf([top.x, top.y, top.z]) });
  const nuts = variant === 1 ? 2 : 3;
  for (let k = 0; k < nuts; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    P.push({
      geo: new THREE.SphereGeometry(0.15, 5, 3),
      color: palette.coconut,
      matrix: xf([top.x + Math.cos(a) * 0.2, top.y - 0.2, top.z + Math.sin(a) * 0.2]),
    });
  }

  // Fronds: 8 x (rising inner leaf + drooping outer leaf), flattened ellipsoids.
  const r = rng(1337 + variant);
  const FRONDS = 8;
  const leafA = variant === 1 ? palette.bushLight : palette.palmLeaf;
  const leafB = variant === 1 ? palette.palmLeaf : palette.palmLeafDark;
  const leaf = (start: THREE.Vector3, yaw: number, pitch: number, len: number, width: number, color: number) => {
    const d = v(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const c = start.clone().addScaledVector(d, len / 2);
    P.push({
      // Flattened octahedron (8 tris, was a 20-tri ellipsoid): a diamond leaf with tips on local +-Z
      // and +-X. Length matches the old ellipsoid (0.82 of len/2); width is 1.15 of width/2 so the diamond
      // keeps the old leaf area and the crown keeps its size.
      geo: new THREE.SphereGeometry(1, 4, 2),
      color,
      // Euler YXZ: yaw about Y, then pitch (negative x-rotation tilts +Z upward).
      matrix: xf([c.x, c.y, c.z], [-pitch, yaw, 0], [(width / 2) * 1.15, 0.035, (len / 2) * 0.824], 'YXZ'),
    });
    return start.clone().addScaledVector(d, len * 0.92);
  };
  for (let f = 0; f < FRONDS; f++) {
    const yaw = (f / FRONDS) * Math.PI * 2 + (r() - 0.5) * 0.35;
    const col = f % 2 ? leafB : leafA;
    const start = top.clone().add(v(0, 0.08, 0));
    const mid = leaf(start, yaw, 0.28 + r() * 0.15, 1.5, 0.5, col);
    leaf(mid, yaw + (r() - 0.5) * 0.15, -0.6 - r() * 0.25, 1.35, 0.42, col);
  }
  return P;
}

function rockPieces(variant = 0): Piece[] {
  const jitter = (geo: THREE.BufferGeometry, amt: number, seedOff: number) => {
    // Displace by a hash of the ORIGINAL position so shared corners move together (watertight).
    const pos = geo.getAttribute('position');
    const memo = new Map<string, number>();
    const rr = rng(seedOff);
    for (let i = 0; i < pos.count; i++) {
      const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      let s = memo.get(k);
      if (s === undefined) {
        s = 1 + (rr() - 0.5) * 2 * amt;
        memo.set(k, s);
      }
      pos.setXYZ(i, pos.getX(i) * s, pos.getY(i) * s, pos.getZ(i) * s);
    }
    return geo;
  };
  const shade = (n: THREE.Vector3) => (n.y > 0.55 ? palette.rockLight : n.y < -0.1 ? palette.rockDark : palette.rock);
  return [
    { geo: jitter(new THREE.IcosahedronGeometry(1, 1), 0.16, 7 + variant * 13), color: palette.rock, matrix: xf([0, 0.35, 0], [0, 0.3 + variant * 1.3, 0], [1.5, 1.05, 1.35]), flat: true, colorFn: shade },
    { geo: jitter(new THREE.IcosahedronGeometry(1, 0), 0.12, 11 + variant * 17), color: palette.rock, matrix: xf([variant === 2 ? -0.95 : 0.95, 0.12, 0.95], [0.4, 1.1, 0.2], [0.5, 0.42, 0.45]), flat: true, colorFn: shade },
  ];
}

function bushPieces(): Piece[] {
  const P: Piece[] = [];
  const blobs: [V3, number, number, number][] = [
    [[0, 0.55, 0], 0.62, palette.bush, 1],
    [[0.52, 0.42, 0.2], 0.48, palette.bushDark, 0],
    [[-0.5, 0.4, 0.12], 0.48, palette.bushDark, 0],
    [[0.08, 0.38, -0.46], 0.44, palette.bush, 0],
    [[-0.12, 0.82, 0.1], 0.42, palette.bushLight, 0],
  ];
  for (const [p, rad, col, detail] of blobs) {
    P.push({ geo: new THREE.IcosahedronGeometry(rad * 0.9, detail), color: col, matrix: xf([p[0] * 0.9, p[1] * 0.9, p[2] * 0.9], [0.3, p[0] * 2, 0]) });
  }
  const flowers: V3[] = [[0.35, 0.95, -0.3], [-0.55, 0.65, -0.3], [0.75, 0.6, -0.05], [-0.1, 0.55, -0.85]];
  for (const f of flowers) {
    P.push({ geo: new THREE.OctahedronGeometry(0.1, 0), color: palette.hibiscus, matrix: xf([f[0] * 0.9, f[1] * 0.9, f[2] * 0.9], [0.5, 0.3, 0], [1, 0.6, 1]), outline: false });
    P.push({ geo: new THREE.OctahedronGeometry(0.035, 0), color: palette.flowerCenter, matrix: xf([f[0] * 0.9, f[1] * 0.9 + 0.05, f[2] * 0.9 - 0.02]), outline: false });
  }
  return P;
}

function cratePieces(variant = 0): Piece[] {
  const P: Piece[] = [];
  P.push({ geo: new THREE.BoxGeometry(0.92, 0.92, 0.92), color: palette.crate, matrix: xf([0, 0.5, 0]), outline: false });
  // 12 edge beams
  const T = 0.1, O = 0.45;
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      P.push({ geo: new THREE.BoxGeometry(1, T, T), color: palette.crateBand, matrix: xf([0, 0.5 + a * O, b * O]), outline: false });
      P.push({ geo: new THREE.BoxGeometry(T, 1, T), color: palette.crateBand, matrix: xf([a * O, 0.5, b * O]), outline: false });
      P.push({ geo: new THREE.BoxGeometry(T, T, 1), color: palette.crateBand, matrix: xf([a * O, 0.5 + b * O, 0]), outline: false });
    }
  }
  // Diagonal braces on the 4 sides
  const diag = Math.SQRT2 * 0.82;
  for (const s of [-1, 1]) {
    P.push({ geo: new THREE.BoxGeometry(diag, 0.09, 0.04), color: palette.crateBand, matrix: xf([0, 0.5, s * 0.47], [0, 0, s * Math.PI / 4]), outline: false });
    P.push({ geo: new THREE.BoxGeometry(0.04, 0.09, diag), color: palette.crateBand, matrix: xf([s * 0.47, 0.5, 0], [s * Math.PI / 4, 0, 0]), outline: false });
  }
  if (variant === 1) {
    // rope net: two cream ropes over the top and down two sides
    for (const x of [-0.2, 0.2]) {
      P.push({ geo: new THREE.BoxGeometry(0.035, 0.02, 1.04), color: palette.stripeCream, matrix: xf([x, 1.005, 0]), outline: false });
      for (const z of [-0.51, 0.51]) P.push({ geo: new THREE.BoxGeometry(0.035, 0.6, 0.02), color: palette.stripeCream, matrix: xf([x, 0.7, z]), outline: false });
    }
  } else if (variant === 2) {
    // teal tarp draped over the top, one flap hanging down the +X side
    P.push({ geo: new THREE.BoxGeometry(0.98, 0.04, 0.98), color: 0x2ec4b6, matrix: xf([0.01, 1.01, 0], [0, 0.12, 0]), outline: false });
    P.push({ geo: new THREE.BoxGeometry(0.04, 0.4, 0.8), color: 0x229f93, matrix: xf([0.51, 0.82, 0], [0, 0.12, 0.08]), outline: false });
  }
  P.push({ geo: new THREE.BoxGeometry(1, 1, 1), color: 0, matrix: xf([0, 0.5, 0]), outline: 'only' });
  return P;
}

function hutPieces(variant = 0): Piece[] {
  const roofA = variant === 1 ? palette.palmLeaf : palette.thatch;
  const roofB = variant === 1 ? palette.palmLeafDark : palette.thatchDark;
  const P: Piece[] = [];
  const WALL_H = 2.2, FLOOR_Y = 0.6, TOP = FLOOR_Y + WALL_H;
  // Stilts + floor
  for (const x of [-1.8, 1.8]) for (const z of [-1.8, 1.8]) {
    P.push({ geo: new THREE.CylinderGeometry(0.13, 0.15, 0.6, 6), color: palette.woodDark, matrix: xf([x, 0.25, z]), flat: true });
  }
  P.push({ geo: new THREE.BoxGeometry(4, 0.2, 4), color: palette.plank, matrix: xf([0, 0.5, 0]) });
  // Walls (front = -Z has a closed door)
  const wy = FLOOR_Y + WALL_H / 2;
  P.push({ geo: new THREE.BoxGeometry(3.6, WALL_H, 0.15), color: palette.hutWall, matrix: xf([0, wy, 1.75]) });
  P.push({ geo: new THREE.BoxGeometry(0.15, WALL_H, 3.6), color: palette.hutWall, matrix: xf([-1.75, wy, 0]) });
  P.push({ geo: new THREE.BoxGeometry(0.15, WALL_H, 3.6), color: palette.hutWall, matrix: xf([1.75, wy, 0]) });
  P.push({ geo: new THREE.BoxGeometry(1.3, WALL_H, 0.15), color: palette.hutWall, matrix: xf([-1.15, wy, -1.75]) });
  P.push({ geo: new THREE.BoxGeometry(1.3, WALL_H, 0.15), color: palette.hutWall, matrix: xf([1.15, wy, -1.75]) });
  P.push({ geo: new THREE.BoxGeometry(1.0, 0.5, 0.15), color: palette.hutWall, matrix: xf([0, TOP - 0.25, -1.75]) });
  P.push({ geo: new THREE.BoxGeometry(1.0, 1.7, 0.1), color: palette.doorDark, matrix: xf([0, FLOOR_Y + 0.85, -1.72]), outline: false });
  P.push({ geo: new THREE.BoxGeometry(0.08, 0.08, 0.06), color: palette.thatch, matrix: xf([0.32, FLOOR_Y + 0.9, -1.79]), outline: false });
  // Side windows
  for (const s of [-1, 1]) {
    P.push({ geo: new THREE.BoxGeometry(0.06, 0.6, 0.8), color: palette.doorDark, matrix: xf([s * 1.83, FLOOR_Y + 1.25, 0]), outline: false });
    P.push({ geo: new THREE.BoxGeometry(0.08, 0.08, 1.0), color: palette.woodDark, matrix: xf([s * 1.85, FLOOR_Y + 0.92, 0]), outline: false });
  }
  // Corner posts
  for (const x of [-1.78, 1.78]) for (const z of [-1.78, 1.78]) {
    P.push({ geo: new THREE.CylinderGeometry(0.12, 0.12, WALL_H + 0.2, 6), color: palette.woodDark, matrix: xf([x, FLOOR_Y + WALL_H / 2 + 0.05, z]), flat: true });
  }
  // Two-layer thatched pyramid roof (4-sided cones rotated so faces align with walls)
  P.push({ geo: new THREE.ConeGeometry(3.3, 1.9, 4, 1), color: roofA, matrix: xf([0, TOP + 0.95, 0], [0, Math.PI / 4, 0]), flat: true });
  P.push({ geo: new THREE.CylinderGeometry(2.38, 2.4, 0.14, 4, 1, true), color: roofB, matrix: xf([0, TOP + 0.03, 0], [0, Math.PI / 4, 0], [1.4, 1, 1.4]), flat: true, outline: false });
  P.push({ geo: new THREE.ConeGeometry(2.25, 1.35, 4, 1, true), color: roofB, matrix: xf([0, TOP + 0.6 + 0.675, 0], [0, Math.PI / 4, 0]), flat: true });
  P.push({ geo: new THREE.ConeGeometry(0.25, 0.5, 4), color: palette.woodDark, matrix: xf([0, TOP + 2.05, 0], [0, Math.PI / 4, 0]), flat: true });
  if (variant === 2) {
    // striped awning over the door (authoring frame: door on -Z)
    for (let i = 0; i < 4; i++) {
      P.push({ geo: new THREE.BoxGeometry(0.36, 0.05, 0.6), color: i % 2 ? palette.stripeCream : palette.stripeCoral, matrix: xf([-0.54 + i * 0.36, TOP - 0.15, -2.0], [-0.35, 0, 0]), });
    }
  }
  return P;
}

function dockPieces(): Piece[] {
  const P: Piece[] = [];
  const r = rng(99);
  const LEN = 14, W = 3, PLANK = 0.5, DECK_Y = 0.5;
  for (let i = 0; i < LEN / PLANK; i++) {
    const z = -(i + 0.5) * PLANK;
    P.push({
      geo: new THREE.BoxGeometry(W - r() * 0.15, 0.1, PLANK - 0.05),
      color: i % 2 ? palette.plankDark : palette.plank,
      matrix: xf([(r() - 0.5) * 0.08, DECK_Y, z], [0, (r() - 0.5) * 0.03, 0]),
      outline: false,
    });
  }
  for (const x of [-1.2, 1.2]) {
    P.push({ geo: new THREE.BoxGeometry(0.16, 0.2, LEN), color: palette.woodDark, matrix: xf([x, DECK_Y - 0.15, -LEN / 2]), outline: false });
  }
  for (const z of [-0.25, -3.6, -7, -10.4, -13.75]) {
    for (const x of [-1.42, 1.42]) {
      P.push({ geo: new THREE.CylinderGeometry(0.13, 0.13, 2.6, 6), color: palette.woodDark, matrix: xf([x, -0.6, z]), flat: true });
    }
  }
  // Rope-wrapped end bollards
  for (const x of [-1.2, 1.2]) {
    P.push({ geo: new THREE.CylinderGeometry(0.16, 0.16, 0.06, 6, 1, true), color: palette.thatch, matrix: xf([x > 0 ? 1.42 : -1.42, 0.62, -13.75]), outline: false });
  }
  P.push({ geo: new THREE.BoxGeometry(W, 0.12, LEN), color: 0, matrix: xf([0, DECK_Y, -LEN / 2]), outline: 'only' });
  return P;
}

const UMBRELLA_COLOURS: readonly [number, number, number][] = [
  [palette.stripeCoral, palette.stripeCream, palette.towel],
  [palette.towel, 0xffffff, palette.stripeCoral],
  [0xffc43d, 0x2ec4b6, 0xc9b6f2],
  [0xc9b6f2, 0xffffff, 0xffc43d],
];
function umbrellaPieces(variant = 0): Piece[] {
  const [ua, ub, towelCol] = UMBRELLA_COLOURS[variant % UMBRELLA_COLOURS.length];
  const P: Piece[] = [];
  const tilt = new THREE.Matrix4().makeRotationZ(0.12);
  const T = (m: THREE.Matrix4) => tilt.clone().multiply(m);
  P.push({ geo: new THREE.CylinderGeometry(0.035, 0.04, 2.35, 6), color: palette.stripeCream, matrix: T(xf([0, 1.1, 0])), outline: false });
  const WEDGES = 8;
  for (let i = 0; i < WEDGES; i++) {
    P.push({
      geo: new THREE.ConeGeometry(1.2, 0.42, 2, 1, false, (i / WEDGES) * Math.PI * 2, (Math.PI * 2) / WEDGES),
      color: i % 2 ? ub : ua,
      matrix: T(xf([0, 2.25, 0])),
      flat: true,
    });
  }
  P.push({ geo: new THREE.SphereGeometry(0.06, 6, 4), color: ua, matrix: T(xf([0, 2.5, 0])), outline: false });
  // Towel with stripes
  const towel = xf([0.75, 0.015, 0.35], [0, 0.35, 0]);
  P.push({ geo: new THREE.BoxGeometry(0.9, 0.03, 1.7), color: towelCol, matrix: towel, outline: false });
  for (const z of [-0.55, 0.55]) {
    P.push({ geo: new THREE.BoxGeometry(0.91, 0.032, 0.14), color: palette.stripeCream, matrix: towel.clone().multiply(xf([0, 0.002, z])), outline: false });
  }
  return P;
}

function boatPieces(): Piece[] {
  const P: Piece[] = [];
  const SX = 0.75, SY = 0.5, SZ = 2.0, RIM_Y = 0.5;
  P.push({
    geo: new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    color: palette.boatHull,
    matrix: xf([0, RIM_Y, 0], [0, 0, 0], [SX, SY, SZ]),
    colorFn: (_n, c) => (c.y > RIM_Y - 0.12 ? palette.boatTrim : palette.boatHull),
  });
  P.push({ geo: new THREE.TorusGeometry(1, 0.05, 4, 16), color: palette.boatTrim, matrix: xf([0, RIM_Y, 0], [Math.PI / 2, 0, 0], [SX, SZ, 1]) });
  P.push({ geo: new THREE.CylinderGeometry(1, 1, 0.04, 14), color: palette.plank, matrix: xf([0, RIM_Y - 0.06, 0], [0, 0, 0], [SX - 0.02, 1, SZ - 0.05]), outline: false });
  for (const z of [-0.6, 0.55]) {
    P.push({ geo: new THREE.BoxGeometry(1.3, 0.06, 0.26), color: palette.wood, matrix: xf([0, RIM_Y + 0.0, z]), outline: false });
  }
  // Oars resting inside
  for (const s of [-1, 1]) {
    const m = xf([s * 0.18, RIM_Y + 0.06, 0], [Math.PI / 2, s * 0.12, 0]);
    P.push({ geo: new THREE.CylinderGeometry(0.03, 0.03, 1.9, 5), color: palette.woodDark, matrix: m, outline: false });
    P.push({ geo: new THREE.BoxGeometry(0.16, 0.45, 0.025), color: palette.wood, matrix: m.clone().multiply(xf([0, -0.9, 0], [Math.PI / 2, 0, 0])), outline: false });
  }
  return P;
}

function tikiTorchPieces(): Piece[] {
  const P: Piece[] = [];
  P.push({ geo: new THREE.CylinderGeometry(0.05, 0.065, 1.85, 6), color: palette.bamboo, matrix: xf([0, 0.92, 0]), flat: true });
  for (const y of [0.45, 1.0, 1.5]) {
    P.push({ geo: new THREE.CylinderGeometry(0.072, 0.072, 0.05, 6), color: palette.bambooDark, matrix: xf([0, y, 0]), flat: true, outline: false });
  }
  P.push({ geo: new THREE.CylinderGeometry(0.14, 0.085, 0.24, 8), color: palette.woodDark, matrix: xf([0, 1.95, 0]), flat: true });
  P.push({ geo: new THREE.CylinderGeometry(0.145, 0.13, 0.05, 8, 1, true), color: palette.thatch, matrix: xf([0, 1.92, 0]), outline: false });
  return P;
}

function flamePieces(): Piece[] {
  const [fx, fy, fz] = TIKI_FLAME_OFFSET;
  return [
    { geo: new THREE.ConeGeometry(0.13, 0.42, 6), color: palette.flameOuter, matrix: xf([fx, fy + 0.04, fz]), outline: false },
    { geo: new THREE.ConeGeometry(0.075, 0.26, 5), color: palette.flameInner, matrix: xf([fx, fy - 0.01, fz - 0.03]), outline: false },
  ];
}

function driftwoodPieces(): Piece[] {
  const P: Piece[] = [];
  const endShade = (n: THREE.Vector3) => (Math.abs(n.y) < 0.35 && Math.abs(n.x) > 0.85 ? palette.driftwoodDark : palette.driftwood);
  const a = v(-1.2, 0.13, 0.05), b = v(0.12, 0.15, -0.05), c = v(1.12, 0.12, 0.3);
  const seg = (p: THREE.Vector3, q: THREE.Vector3, r0: number, r1: number) => {
    const mid = p.clone().add(q).multiplyScalar(0.5);
    P.push({ geo: new THREE.CylinderGeometry(r1, r0, p.distanceTo(q) + 0.05, 7), color: palette.driftwood, matrix: alongY([mid.x, mid.y, mid.z], q.clone().sub(p)), flat: true, colorFn: endShade });
  };
  seg(a, b, 0.19, 0.16);
  seg(b, c, 0.16, 0.12);
  // Branch stub
  const s0 = v(-0.4, 0.2, 0.05), s1 = v(-0.15, 0.62, -0.25);
  const sm = s0.clone().add(s1).multiplyScalar(0.5);
  P.push({ geo: new THREE.CylinderGeometry(0.035, 0.07, s0.distanceTo(s1), 5), color: palette.driftwoodDark, matrix: alongY([sm.x, sm.y, sm.z], s1.clone().sub(s0)), flat: true });
  return P;
}

const PIECES: Record<PropKind, (variant: number) => Piece[]> = {
  palm: palmPieces,
  rock: rockPieces,
  bush: bushPieces,
  crate: cratePieces,
  hut: hutPieces,
  dock: dockPieces,
  umbrella: umbrellaPieces,
  boat: boatPieces,
  tikiTorch: tikiTorchPieces,
  driftwood: driftwoodPieces,
};

/**
 * Root transform applied to every piece of a kind, so the authoring frame can differ from the agreed
 * map frame (docs/design/levels/island.md): hut door on local +Z, dock centred, driftwood along Z.
 */
const ROOT: Partial<Record<PropKind, THREE.Matrix4>> = {
  hut: new THREE.Matrix4().makeRotationY(Math.PI), // authored with door on -Z
  dock: new THREE.Matrix4().makeTranslation(0, 0, 7), // authored from z = 0 to -14
  driftwood: new THREE.Matrix4().makeRotationY(-Math.PI / 2), // authored along X
};

/** Outline thickness per kind (world metres). */
const OUTLINE_BY_KIND: Record<PropKind, number> = {
  palm: OUTLINE.large,
  rock: OUTLINE.large,
  bush: OUTLINE.prop,
  crate: OUTLINE.prop,
  hut: OUTLINE.large,
  dock: OUTLINE.prop,
  umbrella: OUTLINE.prop,
  boat: OUTLINE.prop,
  tikiTorch: 0.025,
  driftwood: OUTLINE.prop,
};

// -------------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------------
export interface PropPart {
  /** 'body' | 'outline' | 'flame' */
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Part transform relative to the prop origin (identity for all M1 props). */
  matrix: THREE.Matrix4;
  castShadow: boolean;
  receiveShadow: boolean;
}

const partsCache = new Map<string, PropPart[]>();
let flameMat: THREE.MeshBasicMaterial | null = null;

/** Unlit vertex-coloured material for the tiki flame (animate scale / add a PointLight on top). */
export function flameMaterial(): THREE.MeshBasicMaterial {
  if (!flameMat) {
    flameMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    flameMat.name = 'tikiFlame';
  }
  return flameMat;
}

/**
 * Instanceable parts of a prop kind. Geometries and materials are cached and shared: do NOT dispose
 * them per instance. Every kind is instanceable (all part matrices are identity).
 * M2c: `variant` (PropPlacement.variant; counts in src/shared/kits/island.ts ISLAND_VARIANTS) picks a look with the
 * same collider; it is taken modulo the kind's count, so any number is safe. Variant 0 = the M2b look.
 */
export function getPropParts(kind: PropKind, variant = 0): PropPart[] {
  const v = islandVariant(kind, variant);
  const cacheKey = v === 0 ? kind : `${kind}|${v}`;
  let parts = partsCache.get(cacheKey);
  if (parts) return parts;
  const make = PIECES[kind];
  if (!make) throw new Error(`Unknown prop kind: ${kind}`);
  const root = ROOT[kind];
  const pieces = root ? make(v).map((p) => ({ ...p, matrix: root.clone().multiply(p.matrix ?? new THREE.Matrix4()) })) : make(v);
  const merged: Merged = buildMerged(pieces, v === 0 ? `prop:${kind}` : `prop:${kind}:${v}`);
  const big = kind !== 'tikiTorch' && kind !== 'driftwood';
  parts = [
    {
      name: 'body',
      geometry: merged.geometry,
      material: vertexColorToon(),
      matrix: new THREE.Matrix4(),
      castShadow: true,
      receiveShadow: big,
    },
  ];
  if (merged.outline) {
    parts.push({
      name: 'outline',
      geometry: ensureOutlineNormals(merged.outline),
      material: outlineMaterial(OUTLINE_BY_KIND[kind]),
      matrix: new THREE.Matrix4(),
      castShadow: false,
      receiveShadow: false,
    });
  }
  if (kind === 'tikiTorch') {
    const flame = buildMerged(flamePieces(), 'prop:tikiTorch:flame');
    parts.push({ name: 'flame', geometry: flame.geometry, material: flameMaterial(), matrix: new THREE.Matrix4(), castShadow: false, receiveShadow: false });
  }
  partsCache.set(cacheKey, parts);
  return parts;
}

/** A ready-to-add prop (Group of shared meshes). Origin at ground centre; apply rotY/scale on the group. */
export function createProp(kind: PropKind, variant = 0): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `prop:${kind}`;
  g.userData.kind = kind;
  g.userData.variant = islandVariant(kind, variant);
  for (const p of getPropParts(kind, variant)) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.name = p.name;
    m.matrixAutoUpdate = false;
    m.matrix.copy(p.matrix);
    m.castShadow = p.castShadow;
    m.receiveShadow = p.receiveShadow;
    if (p.name === 'outline') m.raycast = () => {};
    g.add(m);
  }
  return g;
}

/** Local-space bounds (scale 1) of a prop's body mesh. Handy for culling / debug colliders. */
export function getPropBounds(kind: PropKind): THREE.Box3 {
  const body = getPropParts(kind)[0].geometry;
  if (!body.boundingBox) body.computeBoundingBox();
  return body.boundingBox!.clone();
}
