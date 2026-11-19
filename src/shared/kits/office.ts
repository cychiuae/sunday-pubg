/**
 * Office prop kit (M2b "tiny heroes" office map): pure collision + placement data. Owner: graphics-designer.
 * ARCHITECTURE §15.6, ADR 0005 §3. NO three.js, NO DOM: imported by src/game/levels/ (OFFICE.kit) and src/render/.
 * The sim never imports this module; it reads `map.kit`.
 *
 * Units: world metres at placement scale 1. Props are authored in REAL metres and baked at OFFICE_SCALE (9x), so the
 * helpers below take real metres and multiply (the same numbers as src/render/procedural/office.ts, one source).
 * Colliders are at rotY 0, relative to the entry's origin; the sim applies T(x, y, z) * R_y(rotY) * S(scale).
 * Fronts face -Z.
 *
 * Origins (PropKitEntry.origin):
 *   'floor'    centre of the footprint at floor level (y = 0)
 *   'surface'  centre of the footprint at the bottom; place on a desk top (y = OFFICE_DESK_TOP_Y) or the floor
 *   'wall'     floor level, back face on the local z = 0 plane, the prop extends toward -Z (hang on a wall face)
 *   'ceiling'  top centre (hang from the ceiling height; the prop extends downward). Visual only (no colliders).
 *
 * `size` = the drawn body's bounding box extent (x, y, z), unit-tested against the mesh (render culling, minimap,
 * nav). It is the extent, not the top: for 'wall' / 'ceiling' kinds the box does not start at the origin height.
 *
 * Ramps and the stairs rule (ADR 0005 §3): colliders stay vertical prisms, so the sim compiles each `ramp` part to
 * a stair of flat boxes; the renderer draws the smooth ramp. Every kit ramp is authored so that conversion is valid:
 *   - it starts on its own base (min.y = 0) at z = max.z and ends at z = min.z at exactly max.y (the plateau it
 *     serves: desk top 6.66 for whiteboardRamp, bookStack top 0.945 for keyboardRamp);
 *   - with maxRise = 0.8 x movement.stepHeight (0.28 m today) the conversion is
 *       n = ceil((max.y - min.y) / maxRise), rise = (max.y - min.y) / n, tread = (max.z - min.z) / n,
 *       step i (1..n): box x [min.x, max.x], y [min.y, min.y + i * rise], z [max.z - i * tread, max.z - (i-1) * tread]
 *     (whiteboardRamp: 24 steps of 0.2775 m rise, 0.618 m tread; keyboardRamp: 4 steps of 0.236 m, 0.973 m tread);
 *   - every tread stays >= 0.5 m and every rise <= stepHeight, so walking up never needs a jump (unit-tested in
 *     src/render/procedural/office.test.ts for the current stepHeight).
 * Steps may instead run solid to min.z (one box per height); either form gives the same walkable top.
 */
import type { KitCollider, KitV3, PropKit, PropKitEntry } from '../types';

/** World metres per real metre on the office map (brief M2b, scale choice A). */
export const OFFICE_SCALE = 9;
/** Desk-top height in world metres (0.74 m real). Desk-top items ('surface' origin) go here. */
export const OFFICE_DESK_TOP_Y = 0.74 * OFFICE_SCALE;
/** Room wall height in world metres (3.0 m real). */
export const OFFICE_WALL_HEIGHT = 3.0 * OFFICE_SCALE;
/** Real length of one wall module (wallSolid / wallGlass); world length = this x OFFICE_SCALE = 10.8 m. */
export const OFFICE_WALL_MODULE = 1.2;
/** Wall thickness in REAL metres (world: x OFFICE_SCALE = 0.9 m). */
export const OFFICE_WALL_THICKNESS = 0.1;
/** Ping-pong net collider height above the table top, WORLD metres (a wall: over the 0.95 m jump cap). The drawn net is 1.35 m. */
export const OFFICE_PING_PONG_NET_WALL = 1.6;

export const OFFICE_KIT_KINDS = [
  'desk', 'deskWood', 'chair', 'monitor', 'monitorDual', 'laptop', 'keyboard', 'keyboardRamp',
  'bookStack', 'bookStairs', 'box', 'boxSmall', 'whiteboardRamp',
  'plushSeal', 'plushCrab', 'plushWhale', 'waterBottle', 'mug', 'pottedPlant',
  'filingCabinet', 'printer', 'pinboard', 'fireExtinguisher', 'phoneBooth',
  'wallSolid', 'wallGlass', 'doorFrame', 'pingPongTable', 'foosballTable', 'dumbbellRack', 'guitarStand',
  'pantryCounter', 'lightPanel', 'acCassette',
  // M2c (variety.md §5.4, art M2c.md §9.2): wall-band / room-corner clutter
  'waterCooler',
] as const;
export type OfficeKitKind = (typeof OFFICE_KIT_KINDS)[number];

// -------------------------------------------------------------------------------------------------
// Authoring helpers (inputs in REAL metres, outputs in world metres)
// -------------------------------------------------------------------------------------------------
const S = OFFICE_SCALE;
const v = (x: number, y: number, z: number): KitV3 => [x * S, y * S, z * S];
const box = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, glass = false): KitCollider =>
  glass ? { type: 'box', name, min: v(x0, y0, z0), max: v(x1, y1, z1), glass: true } : { type: 'box', name, min: v(x0, y0, z0), max: v(x1, y1, z1) };
const cyl = (name: string, x: number, z: number, r: number, y0: number, y1: number): KitCollider =>
  ({ type: 'cylinder', name, x: x * S, z: z * S, r: r * S, y0: y0 * S, y1: y1 * S });
const ramp = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): KitCollider =>
  ({ type: 'ramp', name, min: v(x0, y0, z0), max: v(x1, y1, z1) });
/** Entry with `size` given in WORLD metres (the drawn bounds, 2 decimals). */
const e = (origin: PropKitEntry['origin'], size: KitV3, colliders: KitCollider[]): PropKitEntry => ({ origin, size, colliders });

// Shared dimensions (real metres) -----------------------------------------------------------------
const DESK_H = 0.74, DESK_W = 1.4, DESK_D = 0.75, DESK_T = 0.03;
const BOOK_T = 0.035;
const WALL_T = OFFICE_WALL_THICKNESS, WALL_H = 3.0, WALL_L = OFFICE_WALL_MODULE;

function deskColliders(): KitCollider[] {
  return [
    box('top', -DESK_W / 2, DESK_H - DESK_T, -DESK_D / 2, DESK_W / 2, DESK_H, DESK_D / 2),
    box('legL', -0.68, 0, -0.35, -0.64, DESK_H - DESK_T, 0.35),
    box('legR', 0.64, 0, -0.35, 0.68, DESK_H - DESK_T, 0.35),
    box('beam', -0.64, 0.6, 0.28, 0.64, 0.66, 0.32), // 5.4 m up: head-clear
  ];
}

function monitorColliders(dual: boolean): KitCollider[] {
  const hw = dual ? 0.58 : 0.275;
  return [box('screen', -hw, 0.155, dual ? -0.07 : -0.02, hw, 0.485, dual ? 0.06 : 0.02), cyl('pole', 0, 0.12, 0.025, 0, 0.44)];
}

/** keyboardRamp: a 0.44 real keyboard tipped from the floor (+Z) onto a bookStack (-Z, 3 books). */
function keyboardRampColliders(): KitCollider[] {
  const L = 0.44, T = 0.025, rise = BOOK_T * 3;
  // = L * cos(asin(h / L)), written with sqrt only (IEEE-exact on every engine; feeds sim colliders).
  const run = Math.sqrt(L * L - (rise - T) * (rise - T));
  return [ramp('ramp', -0.07, 0, -run / 2, 0.07, rise, run / 2)];
}

/**
 * bookStairs: 7 book piles along -Z, each 3 books (0.945 m world) higher. The top step is 0.735 real (6.615 m world),
 * so every rise is 0.945 m (<= the 0.95 m jump cap); the desk top (6.66) is then a 0.045 m walk-up step.
 */
export const OFFICE_BOOK_STAIRS_TOP_REAL = 0.735;
function bookStairsColliders(): KitCollider[] {
  const STEPS = 7, TREAD = 0.2, W = 0.25;
  const out: KitCollider[] = [];
  for (let i = 1; i <= STEPS; i++) {
    const h = i === STEPS ? OFFICE_BOOK_STAIRS_TOP_REAL : BOOK_T * 3 * i;
    const z = TREAD * (STEPS / 2 - i + 0.5);
    out.push(box(`step${i}`, -W / 2, 0, z - TREAD / 2, W / 2, h, z + TREAD / 2));
  }
  return out;
}

/** whiteboardRamp: a fallen 1.2 x 1.8 real whiteboard from the floor (+Z) to the desk top (-Z). */
function whiteboardRampColliders(): KitCollider[] {
  const W = 1.2, L = 1.8, T = 0.02;
  // = L * cos(asin(h / L)), written with sqrt only (IEEE-exact on every engine; feeds sim colliders).
  const run = Math.sqrt(L * L - (DESK_H - T) * (DESK_H - T));
  return [ramp('ramp', -W / 2, 0, -run / 2, W / 2, DESK_H, run / 2)];
}

function phoneBoothColliders(): KitCollider[] {
  const W = 1.0, H = 2.2, o = W / 2 + 0.03, DOOR = 0.06; // door slab = the -Z wall thickness band
  return [
    box('pod', -o, 0, -o + DOOR, o, H, o),
    box('door', -o, 0, -o, o, H, -o + DOOR, true), // closed glass door (solid, glass impact)
  ];
}

function pingPongColliders(): KitCollider[] {
  const W = 1.525, L = 2.74, H = 0.76, T = 0.03;
  return [
    box('top', -W / 2, H - T, -L / 2, W / 2, H, L / 2),
    // The net is a WALL (1.6 m world over the top, > 0.95 jump cap; the model is 1.35 m), 0.18 m thick (vs 0.07 drawn)
    // so the push-out never lets a 0.45 m radius player slip through. Each half has its own climb route.
    box('net', -0.915, H, -0.01, 0.915, H + OFFICE_PING_PONG_NET_WALL / S, 0.01),
    ...[-1, 1].map((sz) => box(`legs${sz}`, -0.645, 0, sz * 0.95 - 0.025, 0.645, H - T, sz * 0.95 + 0.025)),
  ];
}

function foosballColliders(): KitCollider[] {
  const W = 0.75, L = 1.2, H = 0.9;
  return [
    box('cabinet', -W / 2, 0.6, -L / 2, W / 2, H, L / 2),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box(`leg${sx}${sz}`, sx * 0.3 - 0.035, 0, sz * 0.52 - 0.035, sx * 0.3 + 0.035, 0.6, sz * 0.52 + 0.035))),
  ];
}

function pantryColliders(): KitCollider[] {
  const W = 1.8, D = 0.6, H = 0.9, mx = 0.45;
  return [
    box('counter', -W / 2 - 0.02, 0, -D / 2 - 0.01, W / 2 + 0.02, H, D / 2 + 0.01),
    box('machine', mx - 0.15, H, -0.24, mx + 0.15, H + 0.54, 0.24),
    box('faucet', -0.53, H, 0.05, -0.47, H + 0.26, 0.22),
  ];
}

function doorFrameColliders(): KitCollider[] {
  const OW = 0.9, OH = 2.1, J = 0.06, D = 0.14, outer = OW / 2 + J;
  return [
    box('jambL', -outer, 0, -D / 2, -OW / 2, OH, D / 2),
    box('jambR', OW / 2, 0, -D / 2, outer, OH, D / 2),
    box('lintel', -outer, OH, -D / 2, outer, WALL_H, D / 2),
  ];
}

const cardboard = (w: number, h: number, d: number): KitCollider[] => [box('box', -w / 2, 0, -d / 2, w / 2, h, d / 2)];

/**
 * The office kit: `IndoorPropPlacement.kind` keys -> origin, drawn size and collider parts. Typed with the exact
 * kind keys; it is assignable to the contract's `PropKit` (`IndoorMapData.kit`).
 */
export const OFFICE_KIT: Readonly<Record<OfficeKitKind, PropKitEntry>> = {
  desk: e('floor', [12.64, 6.66, 6.79], deskColliders()),
  deskWood: e('floor', [12.64, 6.66, 6.79], deskColliders()),
  chair: e('floor', [5.71, 10, 5.74], [
    cyl('base', 0, 0, 0.33, 0, 0.09),
    cyl('pole', 0, 0, 0.05, 0.09, 0.42),
    box('seat', -0.25, 0.42, -0.24, 0.25, 0.49, 0.24),
    box('back', -0.23, 0.6, 0.18, 0.23, 1.12, 0.33),
    box('armL', -0.295, 0.48, -0.11, -0.245, 0.69, 0.15),
    box('armR', 0.245, 0.48, -0.11, 0.295, 0.69, 0.15),
  ]),
  monitor: e('surface', [4.95, 4.37, 1.8], monitorColliders(false)),
  monitorDual: e('surface', [10.12, 4.37, 2.27], monitorColliders(true)),
  laptop: e('surface', [2.79, 1.97, 2.5], [box('base', -0.155, 0, -0.11, 0.155, 0.015, 0.11), box('lid', -0.155, 0.015, 0.1, 0.155, 0.22, 0.17)]),
  keyboard: e('surface', [3.96, 0.28, 1.26], [box('keyboard', -0.22, 0, -0.07, 0.22, 0.031, 0.07)]),
  keyboardRamp: e('floor', [1.26, 0.97, 3.93], keyboardRampColliders()),
  bookStack: e('surface', [2.23, 0.94, 2.78], [box('stack', -0.115, 0, -0.15, 0.115, BOOK_T * 3, 0.15)]),
  bookStairs: e('floor', [2.36, 6.62, 12.78], bookStairsColliders()),
  box: e('surface', [4.53, 2.73, 3.65], cardboard(0.5, 0.3, 0.4)),
  boxSmall: e('surface', [3, 1.02, 2.02], cardboard(0.33, 0.11, 0.22)),
  whiteboardRamp: e('floor', [11.2, 6.82, 15.16], whiteboardRampColliders()),
  // M2c: 0.32 x 1.1 x 0.32 real water cooler: cabinet (top 8.1 m, unreachable) + bottle to 9.9 m; <= 3.6 m deep
  waterCooler: e('floor', [3.34, 9.9, 3.33], [
    box('cabinet', -0.16, 0, -0.16, 0.16, 0.9, 0.16),
    cyl('bottle', 0, 0, 0.145, 0.9, 1.1),
  ]),
  plushSeal: e('surface', [3.99, 2.34, 3.33], [box('plush', -0.2, 0, -0.16, 0.2, 0.26, 0.21)]),
  plushCrab: e('surface', [4.7, 2.46, 2.42], [box('plush', -0.27, 0, -0.14, 0.27, 0.28, 0.14)]),
  plushWhale: e('surface', [3.17, 2.34, 4.36], [box('plush', -0.2, 0, -0.2, 0.2, 0.27, 0.32)]),
  waterBottle: e('surface', [0.65, 2.25, 0.65], [cyl('bottle', 0, 0, 0.036, 0, 0.25)]),
  mug: e('surface', [1.12, 0.86, 0.81], [cyl('mug', 0, 0, 0.05, 0, 0.095)]),
  pottedPlant: e('floor', [2.7, 7.92, 2.7], [cyl('pot', 0, 0, 0.15, 0, 0.28), cyl('leaves', 0, 0, 0.12, 0.28, 0.88)]),
  filingCabinet: e('floor', [4.05, 9, 5.72], [box('cabinet', -0.225, 0, -0.3, 0.225, 1.0, 0.3)]),
  printer: e('floor', [5.4, 8.75, 5.67], [box('printer', -0.3, 0, -0.33, 0.3, 0.96, 0.3)]),
  pinboard: e('wall', [10.8, 8.1, 0.45], [box('board', -0.6, 0.9, -0.04, 0.6, 1.8, 0)]),
  fireExtinguisher: e('floor', [2.01, 5.03, 1.45], [cyl('extinguisher', 0, 0, 0.08, 0, 0.56)]),
  phoneBooth: e('floor', [9.4, 19.8, 9.59], phoneBoothColliders()),
  wallSolid: e('floor', [10.8, 27, 1.12], [box('wall', -WALL_L / 2, 0, -WALL_T / 2, WALL_L / 2, WALL_H, WALL_T / 2)]),
  wallGlass: e('floor', [10.8, 27, 0.9], [box('wall', -WALL_L / 2, 0, -WALL_T / 2, WALL_L / 2, WALL_H, WALL_T / 2, true)]),
  doorFrame: e('floor', [9.18, 27, 1.35], doorFrameColliders()),
  pingPongTable: e('floor', [16.47, 8.28, 24.66], pingPongColliders()),
  foosballTable: e('floor', [9.36, 8.1, 10.8], foosballColliders()),
  dumbbellRack: e('floor', [10.89, 6.78, 4.05], [box('rack', -0.605, 0, -0.225, 0.605, 0.78, 0.225)]),
  guitarStand: e('floor', [3.6, 10.21, 4.59], [box('stand', -0.2, 0, -0.2, 0.2, 1.1, 0.26)]),
  pantryCounter: e('floor', [16.56, 12.96, 5.63], pantryColliders()),
  lightPanel: e('ceiling', [10.8, 6.16, 2.7], []),
  acCassette: e('ceiling', [5.85, 2.65, 5.85], []),
};

/** Type guard: is `kind` an office kit key? */
export function isOfficeKitKind(kind: string): kind is OfficeKitKind {
  return Object.prototype.hasOwnProperty.call(OFFICE_KIT, kind);
}

// Compile-time check that the table satisfies the shared contract.
const _contract: PropKit = OFFICE_KIT;
void _contract;
