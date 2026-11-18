/**
 * Synthetic indoor maps for nav and bot tests (not used at runtime). Owner: game-developer (bots/nav).
 *
 * The kit below copies the office kit's walkable shapes in world metres (desk 12.6 x 6.75 with a 6.66 top and full-depth
 * leg panels, 7-step bookStairs of 0.945 m rises, a whiteboard ramp compiled to stairs, bookStack towers, low cover and
 * chairs), so nav behaviour on these fixtures carries over to the real office without importing a kit into the sim.
 */
import type { Balance } from '../balance';
import { BALANCE } from '../balance';
import type { ClimbRoute, IndoorMapData, IndoorPropPlacement, KitCollider, LootSpawn, PropKit, Vec3, WallSegment } from '../types';

const DESK_TOP = 6.66;
const box = (name: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): KitCollider =>
  ({ type: 'box', name, min: [x0, y0, z0], max: [x1, y1, z1] });
const cyl = (name: string, r: number, y0: number, y1: number): KitCollider => ({ type: 'cylinder', name, x: 0, z: 0, r, y0, y1 });

const STAIR_STEPS = 7;
const STAIR_TREAD = 1.8;
const STAIR_RISE = 0.945;

export const FIXTURE_KIT: PropKit = {
  desk: {
    origin: 'floor',
    size: [12.6, DESK_TOP, 6.75],
    colliders: [
      box('top', -6.3, 6.39, -3.375, 6.3, DESK_TOP, 3.375),
      box('legL', -6.12, 0, -3.15, -5.76, 6.39, 3.15),
      box('legR', 5.76, 0, -3.15, 6.12, 6.39, 3.15),
      box('beam', -5.76, 5.4, 2.52, 5.76, 5.94, 2.88),
    ],
  },
  bookStairs: {
    origin: 'floor',
    size: [2.25, DESK_TOP, STAIR_STEPS * STAIR_TREAD],
    colliders: Array.from({ length: STAIR_STEPS }, (_, i) => {
      const k = i + 1;
      const z = STAIR_TREAD * (STAIR_STEPS / 2 - k + 0.5);
      return box(`step${k}`, -1.125, 0, z - STAIR_TREAD / 2, 1.125, k === STAIR_STEPS ? DESK_TOP : STAIR_RISE * k, z + STAIR_TREAD / 2);
    }),
  },
  whiteboardRamp: { origin: 'floor', size: [10.8, DESK_TOP, 14.84], colliders: [{ type: 'ramp', name: 'ramp', min: [-5.4, 0, -7.42], max: [5.4, DESK_TOP, 7.42] }] },
  bookStack: { origin: 'surface', size: [2.08, 0.95, 2.7], colliders: [box('stack', -1.04, 0, -1.35, 1.04, 0.95, 1.35)] },
  boxSmall: { origin: 'surface', size: [1.6, 0.99, 1.6], colliders: [box('box', -0.8, 0, -0.8, 0.8, 0.99, 0.8)] },
  chair: { origin: 'floor', size: [5.94, 8.1, 5.94], colliders: [cyl('base', 2.97, 0, 0.81), cyl('pole', 0.3, 0.81, 3.6), cyl('seat', 2.2, 3.6, 4.41)] },
  monitor: { origin: 'surface', size: [4.95, 4.37, 0.4], colliders: [box('screen', -2.475, 1.4, -0.18, 2.475, 4.37, 0.18), { type: 'cylinder', name: 'pole', x: 0, z: 1.08, r: 0.225, y0: 0, y1: 3.96 }] },
};

const wall = (x1: number, z1: number, x2: number, z2: number, material: 'solid' | 'glass' = 'solid'): WallSegment =>
  ({ x1, z1, x2, z2, thickness: 0.9, bottom: 0, top: 27, material });

/** Outer walls with their inner faces on the floor edge. */
function outerWalls(minX: number, minZ: number, maxX: number, maxZ: number): WallSegment[] {
  const t = 0.45;
  return [
    wall(minX - 0.9, minZ - t, maxX + 0.9, minZ - t),
    wall(minX - 0.9, maxZ + t, maxX + 0.9, maxZ + t),
    wall(minX - t, minZ, minX - t, maxZ),
    wall(maxX + t, minZ, maxX + t, maxZ),
  ];
}

const p = (kind: string, x: number, z: number, rotY = 0, y = 0): IndoorPropPlacement => ({ kind, x, y, z, rotY, scale: 1 });
const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Climb direction of a placement: dir = -(sin rotY, cos rotY) (office.md 4.2). */
const dirOf = (rotY: number): { x: number; z: number } => ({ x: -Math.sin(rotY), z: -Math.cos(rotY) });

/** bookStairs waypoints (office.md 4.2): start = C - 7.5 dir, steps at C + (-5.4 + 1.8 (k - 1)) dir, end = C + 7.8 dir. */
function stairsRoute(id: string, cx: number, cz: number, rotY: number, baseY = 0): ClimbRoute {
  const d = dirOf(rotY);
  const pts: Vec3[] = [v3(cx - 7.5 * d.x, baseY, cz - 7.5 * d.z)];
  for (let k = 1; k <= STAIR_STEPS; k++) {
    const s = -5.4 + STAIR_TREAD * (k - 1);
    pts.push(v3(cx + s * d.x, baseY + STAIR_RISE * k, cz + s * d.z));
  }
  pts.push(v3(cx + 7.8 * d.x, baseY + DESK_TOP, cz + 7.8 * d.z));
  return { id, points: pts, mode: 'jump' };
}

/** whiteboardRamp waypoints: start = C - 8.5 dir, then every ~0.9 m of rise along the ramp, end = C + 8.9 dir. */
function rampRoute(id: string, cx: number, cz: number, rotY: number): ClimbRoute {
  const d = dirOf(rotY);
  const pts: Vec3[] = [v3(cx - 8.5 * d.x, 0, cz - 8.5 * d.z)];
  const n = 8;
  for (let i = 1; i < n; i++) {
    const s = -7.42 + (14.84 * i) / n;
    pts.push(v3(cx + s * d.x, (DESK_TOP * i) / n, cz + s * d.z));
  }
  pts.push(v3(cx + 8.9 * d.x, DESK_TOP, cz + 8.9 * d.z));
  return { id, points: pts, mode: 'walk' };
}

/**
 * Fixture A, "mini office" (120 x 60 m): a 4 x 2 desk block (one plateau) with a jump route (bookStairs) at its west
 * end and a walk route (whiteboard ramp) at its east end, a perch tower on the plateau, low cover and chairs, a wall
 * with a doorway and a glass section, and a side room with a table reached by a bookStack tower.
 */
export function miniOffice(): IndoorMapData {
  const props: IndoorPropPlacement[] = [];
  const xs = [0, 1, 2, 3].map((k) => -36 + 12.6 * k);
  for (const x of xs) {
    props.push(p('desk', x, -3.375, 0), p('desk', x, 3.375, Math.PI));
    props.push(p('boxSmall', x + 2.2, 1.8), p('bookStack', x - 2.2, -1.8));
    props.push(p('chair', x, -10.2), p('chair', x, 10.2));
  }
  props.push(p('monitor', xs[3]!, -3.375 + 1.5, 0, DESK_TOP), p('monitor', xs[2]!, 3.375 - 1.5, Math.PI, DESK_TOP));
  // West jump route into the north row (climbs +X): rotY -pi/2.
  props.push(p('bookStairs', -42.3 - 6.3, -3.375, -Math.PI / 2));
  // East walk route into the south row (climbs -X): rotY pi/2. High end meets the plateau edge at x = 8.1.
  props.push(p('whiteboardRamp', 8.1 + 7.42, 3.375, Math.PI / 2));
  // Perch tower on the plateau (north row, desk k = 1): stacks 1, 2, 3, 4, 4 along +X.
  const perchX = [-28.6, -26.52, -24.44, -22.36, -20.28];
  const perchN = [1, 2, 3, 4, 4];
  perchX.forEach((x, i) => {
    for (let j = 0; j < perchN[i]!; j++) props.push(p('bookStack', x, -3.375, 0, DESK_TOP + 0.95 * j));
  });
  // Side room table (x 38.7..51.3, z -18.375..-11.625) and a bookStack tower climbing -Z into its south edge.
  props.push(p('desk', 45, -15));
  const towerZ: number[] = [];
  for (let i = 1; i <= 7; i++) {
    const z = -11.625 + 1.35 + 2.7 * (7 - i);
    towerZ.push(z);
    for (let j = 0; j < i; j++) props.push(p('bookStack', 45, z, 0, 0.95 * j));
  }
  const walls = [
    ...outerWalls(-60, -30, 60, 30),
    wall(30, -30, 30, -5),
    wall(30, 5, 30, 18),
    wall(30, 18, 30, 30, 'glass'),
  ];
  const towerRoute: ClimbRoute = {
    id: 'ROOM-T',
    points: [v3(45, 0, towerZ[0]! + 2.6), ...towerZ.map((z, i) => v3(45, 0.95 * (i + 1), z)), v3(45, DESK_TOP, -14.5)],
    mode: 'jump',
  };
  const perchRoute: ClimbRoute = {
    id: 'PERCH',
    points: [v3(-31.2, DESK_TOP, -3.375), ...perchX.map((x, i) => v3(x, DESK_TOP + 0.95 * perchN[i]!, -3.375))],
    mode: 'jump',
  };
  const loot: LootSpawn[] = [
    { x: -50, z: -20, tier: 'common' },
    { x: -10, z: 20, tier: 'common' },
    { x: 20, z: -20, tier: 'rare' },
    { x: 50, z: 20, tier: 'common' },
    { x: 55, z: -25, tier: 'rare' },
    { x: -23.4, z: 0, tier: 'common' }, // under the desks (tunnel centre)
    { x: -10.8, z: -3.4, tier: 'rare', y: DESK_TOP }, // plateau
    { x: -36, z: 3.4, tier: 'epic', y: DESK_TOP }, // plateau
    { x: 45, z: -15, tier: 'epic', y: DESK_TOP }, // room table
    { x: -20.28, z: -3.375, tier: 'rare', y: DESK_TOP + 3.8 }, // perch
  ];
  return {
    id: 'fixture-office',
    nameKey: 'map.fixture',
    kind: 'indoor',
    carrier: 'drone',
    floor: { minX: -60, minZ: -30, maxX: 60, maxZ: 30 },
    floorMaterial: 'wood',
    floorZones: [],
    ceilingHeight: 27,
    walls,
    props,
    kit: FIXTURE_KIT,
    climbRoutes: [stairsRoute('W-STAIRS', -48.6, -3.375, -Math.PI / 2), rampRoute('E-RAMP', 15.52, 3.375, Math.PI / 2), perchRoute, towerRoute],
    playerSpawns: [
      { x: -50, z: 20 },
      { x: 0, z: 20 },
      { x: 45, z: 20 },
      { x: 20, z: -25 },
    ],
    lootSpawns: loot,
    zoneCenters: [{ x: 0, z: 0 }, { x: -20, z: 15 }],
    pois: [],
  };
}

/**
 * Fixture B, "rooms" (80 x 80 m, floor only): a 3 x 3 grid of rooms with doorways (some glass walls), scattered low
 * boxes and chairs. Stresses doorways and corners.
 */
export function roomsMaze(): IndoorMapData {
  const walls: WallSegment[] = [...outerWalls(-40, -40, 40, 40)];
  const lines = [-13.33, 13.33];
  const door = 4.5; // half width of each doorway
  for (const [li, c] of lines.entries()) {
    // Vertical walls at x = c with doorways centred at z = -26.7, 0, 26.7 (one of them closed per line).
    const centres = [-26.67, 0, 26.67];
    const closed = li === 0 ? 2 : 0;
    let z0 = -40;
    centres.forEach((zc, i) => {
      if (i === closed) return;
      walls.push(wall(c, z0, c, zc - door, i === 1 ? 'glass' : 'solid'));
      z0 = zc + door;
    });
    walls.push(wall(c, z0, c, 40));
    // Horizontal walls at z = c.
    let x0 = -40;
    centres.forEach((xc, i) => {
      if (i === (li === 0 ? 0 : 1)) return;
      walls.push(wall(x0, c, xc - door, c));
      x0 = xc + door;
    });
    walls.push(wall(x0, c, 40, c));
  }
  const props: IndoorPropPlacement[] = [];
  const spots: [number, number][] = [[-30, -30], [-20, 5], [5, -22], [25, 30], [30, -5], [-5, 25], [8, 8], [-28, 28]];
  spots.forEach(([x, z], i) => props.push(p(i % 2 === 0 ? 'boxSmall' : 'chair', x, z, i * 0.7)));
  return {
    id: 'fixture-rooms',
    nameKey: 'map.fixture',
    kind: 'indoor',
    carrier: 'drone',
    floor: { minX: -40, minZ: -40, maxX: 40, maxZ: 40 },
    floorMaterial: 'carpet',
    floorZones: [],
    ceilingHeight: 27,
    walls,
    props,
    kit: FIXTURE_KIT,
    climbRoutes: [],
    playerSpawns: [{ x: -30, z: -20 }, { x: 30, z: 30 }],
    lootSpawns: [
      { x: -30, z: -20, tier: 'common' },
      { x: 30, z: 30, tier: 'rare' },
      { x: 0, z: 0, tier: 'epic' },
      { x: -27, z: 27, tier: 'common' },
    ],
    zoneCenters: [{ x: 0, z: 0 }],
    pois: [],
  };
}

/** The base balance with the office movement override (maps.md §3: fallDamageMinSpeed 18, desk walk-off is safe). */
export function officeLikeBalance(patch?: (b: Balance) => void): Balance {
  const b = JSON.parse(JSON.stringify(BALANCE)) as Balance;
  b.movement.fallDamageMinSpeed = 18;
  patch?.(b);
  return b;
}
