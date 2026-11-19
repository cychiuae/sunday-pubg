/**
 * Map 2: "office" (IndoorMapData). A 234 x 144 m open-plan office at 9x scale ("tiny heroes"): desks are 6.66 m
 * plateaus, rooms have 27 m walls, the drop comes from a toy delivery drone.
 * Layout doc (authoritative numbers and design intent): docs/design/levels/office.md. Contract: ARCHITECTURE §15.5.
 *
 * Conventions (office.md "Conventions"):
 * - Metres, Y up, floor at y = 0. North = -Z, east = +X, origin = floor centre.
 * - rotY = Three.js rotation.y: local +X -> world (cos, -sin), local +Z -> world (sin, cos). Kit fronts face local -Z.
 * - Every size comes from the kit (src/shared/kits/office.ts, graphics-designer). Positions come from the tables
 *   below; repeated geometry (desk blocks, chairs, monitors, wall runs and doorways, climb-route waypoints, book
 *   towers) is generated from office.md's formulas, not typed out.
 * - Loot and fallback spawns are nudged (<= 3 m, same level) off any prop that crowds them, like the island.
 *
 * Deterministic: a seeded generator (mulberry32) runs once at module load. No real names anywhere (office.md §10).
 */
import type {
  ClimbRoute,
  FloorZone,
  IndoorMapData,
  IndoorPropPlacement,
  KitCollider,
  LootSpawn,
  LootTier,
  MapPoi,
  Rect,
  Vec2,
  Vec3,
  WallMaterial,
  WallSegment,
} from '../../shared/types';
import { OFFICE_KIT, OFFICE_SCALE, OFFICE_WALL_HEIGHT, OFFICE_WALL_THICKNESS, type OfficeKitKind } from '../../shared/kits/office';
import { GLASS_PANE_MAX_WIDTH } from '../../shared/maps';
import { atan2Det, cosRad, hypot2, sinRad } from './detTrig';
import {
  RAMP_STEP_RISE,
  type Solid,
  lootSpotIssue,
  propSolids,
  spawnIssue,
  wallSolid,
} from './indoorGeometry';

type Kind = OfficeKitKind;
type BoxPart = Exclude<KitCollider, { type: 'cylinder' }>;
type CylPart = Extract<KitCollider, { type: 'cylinder' }>;

const PI = Math.PI;
const HALF_PI = PI / 2;
const LAYOUT_SEED = 20261120;

// ---------------------------------------------------------------------------------------------
// Kit-derived dimensions (one source: the kit)
// ---------------------------------------------------------------------------------------------
function kitPart(kind: Kind, name: string): KitCollider {
  const c = OFFICE_KIT[kind].colliders.find((p) => p.name === name);
  if (!c) throw new Error(`office: kit "${kind}" has no collider "${name}"`);
  return c;
}
function boxPart(kind: Kind, name: string): BoxPart {
  const c = kitPart(kind, name);
  if (c.type === 'cylinder') throw new Error(`office: kit "${kind}.${name}" is not a box`);
  return c;
}
function cylPart(kind: Kind, name: string): CylPart {
  const c = kitPart(kind, name);
  if (c.type !== 'cylinder') throw new Error(`office: kit "${kind}.${name}" is not a cylinder`);
  return c;
}

const DESK_TOP_PART = boxPart('desk', 'top');
/** Desk plateau height (6.66). */
export const OFFICE_DESK_TOP = DESK_TOP_PART.max[1];
const DESK_HALF_W = DESK_TOP_PART.max[0]; // 6.3
const DESK_HALF_D = DESK_TOP_PART.max[2]; // 3.375
/** Column pitch = the drawn desk width, so the desks of a block are flush (office.md §1). */
const COL = OFFICE_KIT.desk.size[0]; // 12.64
/** Row offset from the block spine = half the drawn desk depth (facing rows are flush). */
const ROW = OFFICE_KIT.desk.size[2] / 2; // 3.395
/** Ping-pong table top (6.84). */
export const OFFICE_PONG_TOP = boxPart('pingPongTable', 'top').max[1];
/** One bookStack = one jump step (0.945). */
const STACK_H = boxPart('bookStack', 'stack').max[1];
/** Perch platform top: desk + 4 stacks (10.44; office.md rounds it to 10.46). */
export const OFFICE_PERCH_TOP = OFFICE_DESK_TOP + 4 * STACK_H;
const BOX = boxPart('box', 'box');
const SMALL = boxPart('boxSmall', 'box');
const COUNTER_TOP = boxPart('pantryCounter', 'counter').max[1]; // 8.1
const JAMB_L = boxPart('doorFrame', 'jambL');
const JAMB_R = boxPart('doorFrame', 'jambR');
/** Wall gap a doorFrame fills (9.18); its clear opening is 8.1. */
export const OFFICE_DOOR_GAP = JAMB_R.max[0] - JAMB_L.min[0];
/** Clear doorway width between the jambs (8.1). */
export const OFFICE_DOOR_CLEAR = JAMB_R.min[0] - JAMB_L.max[0];
const CHAIR_R = cylPart('chair', 'base').r; // 2.97
/** Book tower cell pitch (office.md §4.3): one bookStack footprint, rounded up. */
const CELL_X = 2.08;
const CELL_Z = 2.7;

const CEILING = OFFICE_WALL_HEIGHT; // 27
const WALL_T = OFFICE_WALL_THICKNESS * OFFICE_SCALE; // 0.9

/**
 * Raised colliders whose bottom sits 0.6-1.35 m above a walkable surface (stance.md level rule: each must be a
 * deliberate gap, listed in office.md §5.3). `${kind}.${part}` labels; the level test finds every such part.
 */
export const DELIBERATE_GAPS: readonly string[] = [
  // Chair backrest over the seat top: 0.99 m (crouch and prone fit). The seat is only reachable by dropping off a desk.
  'chair.back',
];

// ---------------------------------------------------------------------------------------------
// Floor, rooms, floor zones (office.md §1, §2.4)
// ---------------------------------------------------------------------------------------------
export const OFFICE_FLOOR: Rect = { minX: -117, maxX: 117, minZ: -72, maxZ: 72 };

const R = (minX: number, maxX: number, minZ: number, maxZ: number): Rect => ({ minX, maxX, minZ, maxZ });
const ROOMS = {
  fishbowl: R(-88, -41, -72, -46),
  shush: R(-41, -16.7, -72, -46),
  lounge: R(-16.7, 20.48, -72, -46),
  corner: R(20.48, 51, -72, -46),
  blue: R(51, 84.13, -72, -46),
  yellow: R(84.13, 117, -72, -16.87),
  loosN: R(-117, -88, -72, -46),
  pantry: R(-117, -88, -46, -14),
  loosS: R(-117, -88, -14, 14),
  paperJam: R(-117, -88, 14, 46),
  welcome: R(-117, -60, 46, 72),
  gym: R(-60, 20.48, 46, 72),
  den: R(20.48, 117, 46, 72),
} as const;

const FLOOR_ZONES: FloorZone[] = [
  { ...ROOMS.fishbowl, material: 'carpet' },
  { ...ROOMS.corner, material: 'carpet' },
  { ...ROOMS.blue, material: 'carpet' },
  { ...ROOMS.yellow, material: 'carpet' },
  { ...ROOMS.gym, material: 'carpet' },
  { ...ROOMS.den, material: 'carpet' },
  { ...R(-117, -88, -72, 14), material: 'tile' }, // pantry and both loos
  { ...ROOMS.welcome, material: 'tile' },
];

// ---------------------------------------------------------------------------------------------
// Walls and doorways (office.md §2.1-2.3). Runs are split at their doorways; each doorway gets a doorFrame.
// ---------------------------------------------------------------------------------------------
interface WallRun {
  a: [number, number];
  b: [number, number];
  mat: WallMaterial;
  /** Doorway centres along the run (x for an east-west run, z for a north-south run), with their office.md ids. */
  doors?: [string, number][];
}

const INTERIOR_RUNS: WallRun[] = [
  { a: [-117, -46], b: [-88, -46], mat: 'solid', doors: [['D1', -102]] }, // W1-W2 loos N / pantry
  { a: [-88, -46], b: [-41, -46], mat: 'glass', doors: [['D2', -78], ['D3', -50]] }, // W3-W5 fishbowl
  { a: [20.48, -46], b: [51, -46], mat: 'glass', doors: [['D4', 45]] }, // W6-W7 corner office
  { a: [51, -46], b: [84.13, -46], mat: 'glass', doors: [['D5', 76]] }, // W8-W9 blue room
  { a: [-88, -72], b: [-88, -46], mat: 'solid' }, // W10
  { a: [-41, -72], b: [-41, -46], mat: 'glass' }, // W11
  { a: [20.48, -72], b: [20.48, -46], mat: 'glass', doors: [['D6', -52]] }, // W12-W13
  { a: [51, -72], b: [51, -46], mat: 'solid' }, // W14
  { a: [84.13, -72], b: [84.13, -46], mat: 'solid', doors: [['D7', -60]] }, // W15-W16
  { a: [84.13, -46], b: [84.13, -30], mat: 'glass', doors: [['D8', -38]] }, // W17-W18
  { a: [84.13, -30], b: [84.13, -16.87], mat: 'solid' }, // W19
  { a: [84.13, -16.87], b: [117, -16.87], mat: 'glass', doors: [['D9', 104]] }, // W20-W21
  { a: [-88, -46], b: [-88, 14], mat: 'solid', doors: [['D10', -38], ['D11', -22], ['D12', 0]] }, // W22-W25
  { a: [-117, -14], b: [-88, -14], mat: 'solid' }, // W26
  { a: [-117, 14], b: [-88, 14], mat: 'solid' }, // W27
  { a: [-117, 46], b: [-88, 46], mat: 'solid' }, // W28
  { a: [-107, -72], b: [-107, -54], mat: 'solid' }, // W29 loos N cubicle block (closed)
  { a: [-117, -54], b: [-107, -54], mat: 'solid' }, // W30
  { a: [-107, -14], b: [-107, -2], mat: 'solid' }, // W31 loos S cubicle block (closed)
  { a: [-117, -2], b: [-107, -2], mat: 'solid' }, // W32
  { a: [-60, 46], b: [-60, 72], mat: 'solid' }, // W33
  { a: [-60, 46], b: [20.48, 46], mat: 'glass', doors: [['D13', -45], ['D14', 5]] }, // W34-W36
  { a: [20.48, 46], b: [20.48, 72], mat: 'solid' }, // W37
  { a: [20.48, 46], b: [117, 46], mat: 'glass', doors: [['D15', 30], ['D16', 108]] }, // W38-W40
];

/** An interior doorway: a wall gap of OFFICE_DOOR_GAP with a doorFrame centred in it. */
export interface OfficeDoorway {
  id: string;
  x: number;
  z: number;
  /** doorFrame rotY: 0 in an east-west wall, pi/2 in a north-south wall. */
  rotY: number;
}

function outerRuns(f: Rect): WallRun[] {
  const h = WALL_T / 2;
  return [
    { a: [f.minX - WALL_T, f.minZ - h], b: [f.maxX + WALL_T, f.minZ - h], mat: 'solid' }, // O-N
    { a: [f.minX - WALL_T, f.maxZ + h], b: [f.maxX + WALL_T, f.maxZ + h], mat: 'solid' }, // O-S
    { a: [f.minX - h, f.minZ - h], b: [f.minX - h, f.maxZ + h], mat: 'solid' }, // O-W
    { a: [f.maxX + h, f.minZ - h], b: [f.maxX + h, f.maxZ + h], mat: 'solid' }, // O-E
  ];
}

function splitRuns(runs: readonly WallRun[]): { walls: WallSegment[]; doors: OfficeDoorway[] } {
  const walls: WallSegment[] = [];
  const doors: OfficeDoorway[] = [];
  const g = OFFICE_DOOR_GAP / 2;
  for (const run of runs) {
    const alongX = run.a[1] === run.b[1];
    const fixed = alongX ? run.a[1] : run.a[0];
    const lo = alongX ? Math.min(run.a[0], run.b[0]) : Math.min(run.a[1], run.b[1]);
    const hi = alongX ? Math.max(run.a[0], run.b[0]) : Math.max(run.a[1], run.b[1]);
    const seg = (s: number, e: number): void => {
      if (e - s < 1e-6) return;
      // M2c (ADR 0007 §7): glass runs are split into equal panes no wider than GLASS_PANE_MAX_WIDTH, so breaking one
      // opens at most a door-sized gap. Pane ids come from glassPanes(map) (walls order). Solid runs stay whole.
      const n = run.mat === 'glass' ? Math.max(1, Math.ceil((e - s) / GLASS_PANE_MAX_WIDTH - 1e-9)) : 1;
      const cut = (i: number): number => r3(s + ((e - s) * i) / n);
      for (let i = 0; i < n; i++) {
        const a = cut(i);
        const b = cut(i + 1);
        const [x1, z1, x2, z2] = alongX ? [a, fixed, b, fixed] : [fixed, a, fixed, b];
        walls.push({ x1: r3(x1), z1: r3(z1), x2: r3(x2), z2: r3(z2), thickness: WALL_T, bottom: 0, top: CEILING, material: run.mat });
      }
    };
    let s = lo;
    for (const [id, d] of [...(run.doors ?? [])].sort((p, q) => p[1] - q[1])) {
      seg(s, d - g);
      s = d + g;
      doors.push({ id, x: alongX ? d : fixed, z: alongX ? fixed : d, rotY: alongX ? 0 : HALF_PI });
    }
    seg(s, hi);
  }
  return { walls, doors };
}

const SPLIT = splitRuns([...outerRuns(OFFICE_FLOOR), ...INTERIOR_RUNS]);
/** The 16 interior doorways D1-D16 (office.md §2.3). */
export const OFFICE_DOORWAYS: readonly OfficeDoorway[] = SPLIT.doors;

// ---------------------------------------------------------------------------------------------
// Desk blocks (office.md §3)
// ---------------------------------------------------------------------------------------------
interface BlockDef {
  id: 'TL' | 'TR' | 'BL' | 'BR';
  x0: number;
  n: number;
  spine: number;
  /** Per column k: '1' monitor, '2' dual monitor, 'x' none (laptop), 'K' Kettle Corner, 'P' perch desk. */
  north: string;
  south: string;
}
const BLOCKS: BlockDef[] = [
  { id: 'TL', x0: -61.68, n: 5, spine: -23.21, north: 'xx111', south: 'Kx111' },
  { id: 'TR', x0: 26.8, n: 5, spine: -23.21, north: '1111P', south: '11111' },
  { id: 'BL', x0: -61.68, n: 5, spine: 23.21, north: 'P1111', south: '11222' },
  { id: 'BR', x0: 26.8, n: 6, spine: 23.21, north: '221111', south: '211111' },
];
const blockOf = (id: BlockDef['id']): BlockDef => BLOCKS.find((b) => b.id === id)!;
const colX = (id: BlockDef['id'], k: number): number => blockOf(id).x0 + COL * k;
/** North row (rotY 0, chairs north) and south row (rotY pi, chairs south). */
const rowZ = (id: BlockDef['id'], row: 'N' | 'S'): number => blockOf(id).spine + (row === 'N' ? -ROW : ROW);
/** Bridge desks continue the TL / BL columns across the vertical aisle (columns 5 and 6): 1.52 and 14.16. */
const BRIDGE_X = [colX('TL', 5), colX('TL', 6)];
const BRIDGE_N_Z = rowZ('TL', 'S');
const BRIDGE_S_Z = rowZ('BL', 'N');
const SEAM_X = (BRIDGE_X[0]! + BRIDGE_X[1]!) / 2; // 7.84

/** Chair distance from the desk centre to the chair centre (base just touches the desk front). */
const CHAIR_OFFSET = 6.4;
const CHAIR_JITTER = 2;
const CHAIR_OMIT = new Set(['TL.S.0', 'TR.S.4', 'BL.N.4', 'BR.N.5']); // ramps land there (and Kettle Corner)
const CHAIR_FIXED_X: Record<string, number> = { 'TL.N.4': -13.5, 'TR.S.0': 30.0, 'BR.N.0': 30.0, 'BL.S.0': -57.5, 'TR.N.4': 80.5 };
const CHAIR_NO_EAST_JITTER = new Set(['TR.S.3', 'BR.N.4']); // never jitter toward the ramp east of them

/** Under-desk low cover offsets per tunnel (office.md §3.4), s = (-1)^k. */
const TUNNEL_COVER = { small: [2, 2.5], books: [-2, -2.5] } as const;
/** Under each bridge: one boxSmall this far east of the tunnel centre (3, not 2: keeps the tunnel loot clear). */
const BRIDGE_COVER_DX = 3;

/** Desk-top dressing, desk-local (office.md §3.3). */
const MONITOR_AT: [number, number] = [0, 1.5];
const KEYBOARD_AT: [number, number] = [0, -0.6];
const LAPTOP_AT: [number, number] = [3.0, -0.8];
const EXTRA_LAPTOP_X = 4.2;
const EXTRA_LAPTOPS = 5;
const DESK_CLUTTER: [Kind, number][] = [
  ['box', 4], ['boxSmall', 6], ['plushSeal', 5], ['plushCrab', 5], ['plushWhale', 5], ['bookStack', 12],
  ['waterBottle', 14], ['mug', 18],
];
const KETTLE_ITEMS: [Kind, number][] = [['plushWhale', 1], ['boxSmall', 2], ['waterBottle', 4], ['mug', 6]];

// ---------------------------------------------------------------------------------------------
// Climb routes (office.md §4)
// ---------------------------------------------------------------------------------------------
interface StairRouteDef {
  id: string;
  kind: 'bookStairs' | 'whiteboardRamp';
  x: number;
  z: number;
  rotY: number;
  plateau: string;
  top?: number;
  /** Override for a side entry (CO-A). */
  start?: Vec3;
}
const STAIR_ROUTES: StairRouteDef[] = [
  { id: 'TL-A', kind: 'whiteboardRamp', x: -61.68, z: -9.0, rotY: 0, plateau: 'upper' },
  { id: 'TL-B', kind: 'bookStairs', x: -6.3, z: -36.3, rotY: PI, plateau: 'upper' },
  { id: 'TL-C', kind: 'bookStairs', x: -74.3, z: -26.6, rotY: -HALF_PI, plateau: 'upper' },
  { id: 'TR-A', kind: 'bookStairs', x: 23.5, z: -10.12, rotY: 0, plateau: 'upper' },
  { id: 'TR-B', kind: 'whiteboardRamp', x: 76.0, z: -9.0, rotY: 0, plateau: 'upper' },
  { id: 'TR-C', kind: 'bookStairs', x: 74.0, z: -36.3, rotY: PI, plateau: 'upper' },
  { id: 'BL-A', kind: 'bookStairs', x: -74.3, z: 26.6, rotY: -HALF_PI, plateau: 'lower' },
  { id: 'BL-B', kind: 'whiteboardRamp', x: -11.12, z: 9.0, rotY: PI, plateau: 'lower' },
  { id: 'BL-C', kind: 'bookStairs', x: -64.0, z: 36.3, rotY: 0, plateau: 'lower' },
  { id: 'BR-A', kind: 'bookStairs', x: 23.5, z: 10.12, rotY: PI, plateau: 'lower' },
  { id: 'BR-B', kind: 'whiteboardRamp', x: 90.0, z: 9.0, rotY: PI, plateau: 'lower' },
  { id: 'BR-C', kind: 'bookStairs', x: 102.62, z: 26.6, rotY: HALF_PI, plateau: 'lower' },
  { id: 'CO-A', kind: 'bookStairs', x: 27.3, z: -60, rotY: -HALF_PI, plateau: 'exec', start: { x: 21.9, y: 0, z: -56.6 } },
  { id: 'DEN-W', kind: 'bookStairs', x: 39.37, z: 59.2, rotY: -HALF_PI, plateau: 'pongW', top: OFFICE_PONG_TOP },
  { id: 'DEN-E', kind: 'bookStairs', x: 76.63, z: 59.2, rotY: HALF_PI, plateau: 'pongE', top: OFFICE_PONG_TOP },
  { id: 'YEL-N', kind: 'bookStairs', x: 101, z: -58.09, rotY: PI, plateau: 'yellow' },
  { id: 'YEL-S', kind: 'whiteboardRamp', x: 101, z: -30.79, rotY: 0, plateau: 'yellow' },
];
/** office.md §4.2: waypoint offsets along the climb direction (local -Z). */
const STAIRS_START = 7.5;
const STAIRS_END = -7.8;
const RAMP_START = 8.5;
const RAMP_END = -8.9;

interface TowerDef {
  id: string;
  plateau: string;
  base: number;
  cells: { x: number; z: number; n: number }[];
  start: Vec3;
  end?: Vec3;
}
const PERCH_STACKS = [1, 2, 3, 4, 4];
const perchCells = (x0: number, dir: 1 | -1, z: number): TowerDef['cells'] =>
  PERCH_STACKS.map((n, j) => ({ x: x0 + dir * CELL_X * j, z, n }));
const TOWERS: TowerDef[] = [
  {
    // CO-B: 28 stacks in two rows against the exec desk (office.md §4.3); cell i1 stays empty.
    id: 'CO-B',
    plateau: 'exec',
    base: 0,
    cells: [
      ...[0, 1, 2, 3].map((j) => ({ x: 35.0 + CELL_X * j, z: -52.56, n: j + 1 })),
      ...[3, 2, 1].map((j) => ({ x: 35.0 + CELL_X * j, z: -52.56 - CELL_Z, n: 8 - j })),
    ],
    start: { x: 35.0, y: 0, z: -49.5 },
    end: { x: 37.08, y: OFFICE_DESK_TOP, z: -58.6 },
  },
  {
    id: 'PERCH-NE',
    plateau: 'perchNE',
    base: OFFICE_DESK_TOP,
    cells: perchCells(72.1, 1, rowZ('TR', 'N')),
    start: { x: 69.5, y: OFFICE_DESK_TOP, z: rowZ('TR', 'N') },
  },
  {
    id: 'PERCH-SW',
    plateau: 'perchSW',
    base: OFFICE_DESK_TOP,
    cells: perchCells(-56.4, -1, rowZ('BL', 'N')),
    start: { x: -54.0, y: OFFICE_DESK_TOP, z: rowZ('BL', 'N') },
  },
];
const towerOf = (id: string): TowerDef => TOWERS.find((t) => t.id === id)!;

// ---------------------------------------------------------------------------------------------
// Loot (office.md §7.2): 8 epic / 20 rare / 50 common. Level: floor, desk (6.66), pong (6.84), perch (10.44).
// ---------------------------------------------------------------------------------------------
type Level = 'floor' | 'desk' | 'pong' | 'perch';
const LEVEL_Y: Record<Level, number> = { floor: 0, desk: OFFICE_DESK_TOP, pong: OFFICE_PONG_TOP, perch: OFFICE_PERCH_TOP };

export interface OfficeLootDef {
  id: string;
  tier: LootTier;
  x: number;
  z: number;
  level: Level;
}
const L = (id: string, tier: LootTier, x: number, z: number, level: Level = 'floor'): OfficeLootDef => ({ id, tier, x, z, level });
/** The perch platform's outer cell (p2, the route's last waypoint). */
const perchTop = (id: string): TowerDef['cells'][number] => towerOf(id).cells[PERCH_STACKS.length - 1]!;
const tunnel = (b: BlockDef['id'], k: number): [number, number] => [colX(b, k), blockOf(b).spine];

/** Loot sources before nudging, in OFFICE.lootSpawns order. */
export const OFFICE_LOOT_DEFS: readonly OfficeLootDef[] = [
  // Epic: all on plateaus you must climb to.
  L('E1', 'epic', 36.5, -60, 'desk'), // Corner Office exec desk
  L('E2', 'epic', 43.5, -60, 'desk'),
  L('E3', 'epic', 51.5, 59.2, 'pong'), // ping pong W half
  L('E4', 'epic', 64.5, 59.2, 'pong'), // ping pong E half
  L('E5', 'epic', perchTop('PERCH-NE').x, perchTop('PERCH-NE').z, 'perch'), // NE perch platform
  L('E6', 'epic', perchTop('PERCH-SW').x, perchTop('PERCH-SW').z, 'perch'), // SW perch platform
  L('E7', 'epic', SEAM_X - 1, BRIDGE_N_Z, 'desk'), // bridge N, 1 m west of the seam
  L('E8', 'epic', SEAM_X + 1, BRIDGE_S_Z, 'desk'), // bridge S, 1 m east of the seam
  // Rare: rooms and deck tops.
  L('R01', 'rare', -36.4, -28.0, 'desk'),
  L('R02', 'rare', 52.08, -18.3, 'desk'),
  L('R03', 'rare', -23.76, 18.3, 'desk'),
  L('R04', 'rare', 64.72, 28.3, 'desk'),
  L('R05', 'rare', -58.5, -19.5, 'desk'), // Kettle Corner
  L('R06', 'rare', 101, -46.0, 'desk'), // Yellow table, 1 m north of its seam
  L('R07', 'rare', -71, -59.4), // under the Fishbowl table
  L('R08', 'rare', -45, -68),
  L('R09', 'rare', 67.5, -59.4), // under the Blue table
  L('R10', 'rare', 80, -68),
  L('R11', 'rare', 112, -25),
  L('R12', 'rare', -28.6, -67), // Shush slot
  L('R13', 'rare', -96, -30), // under the pantry table
  L('R14', 'rare', -106, 40),
  L('R15', 'rare', -30, 55),
  L('R16', 'rare', 0, 66),
  L('R17', 'rare', 58, 59.2), // under the ping pong table
  L('R18', 'rare', 39.92, -60), // under the exec desk
  L('R19', 'rare', -110, 66),
  L('R20', 'rare', -100, -60),
  // Common: tunnels (11).
  ...([['TL', 1], ['TL', 3], ['TR', 1], ['TR', 3], ['BL', 1], ['BL', 4], ['BR', 0], ['BR', 2], ['BR', 4]] as const).map(
    ([b, k], i) => L(`C${String(i + 1).padStart(2, '0')}`, 'common', ...tunnel(b, k)),
  ),
  L('C10', 'common', BRIDGE_X[0]!, BRIDGE_N_Z), // under bridge N
  L('C11', 'common', BRIDGE_X[1]!, BRIDGE_S_Z), // under bridge S
  // Desk tops (4).
  L('C12', 'common', -11.12, -18.3, 'desk'),
  L('C13', 'common', 26.8, -28.2, 'desk'),
  L('C14', 'common', -49.04, 28.3, 'desk'),
  L('C15', 'common', 94.0, 18.3, 'desk'),
  // N corridor (6).
  L('C16', 'common', -62, -40),
  L('C17', 'common', -33.4, -42.0),
  L('C18', 'common', -2, -40),
  L('C19', 'common', 26, -40),
  L('C20', 'common', 56, -42),
  L('C21', 'common', 79, -42),
  // Main aisle (7).
  L('C22', 'common', -60, 4),
  L('C23', 'common', -28, -4),
  L('C24', 'common', SEAM_X, 0), // crossroads
  L('C25', 'common', 18, -4),
  L('C26', 'common', 46, 4),
  L('C27', 'common', 88, -4),
  L('C28', 'common', 110, -8),
  // W corridor (1), S corridor (6), E corridor (1).
  L('C29', 'common', -78, -28),
  L('C30', 'common', -56, 40),
  L('C31', 'common', -28, 42),
  L('C32', 'common', 2, 40),
  L('C33', 'common', 20, 42),
  L('C34', 'common', 48, 40),
  L('C35', 'common', 76, 42),
  L('C36', 'common', 106, 36),
  // Rooms (11).
  L('C37', 'common', -112, -50), // loos N
  L('C38', 'common', -98, 2), // loos S
  L('C39', 'common', -108, -42), // pantry
  L('C40', 'common', -97, 18), // Paper Jam, under the admin desk
  L('C41', 'common', -80, 56), // Welcome Mat
  L('C42', 'common', -6, -55), // lounge
  L('C43', 'common', 25, -50), // Corner Office
  L('C44', 'common', 96, -66), // Yellow
  L('C45', 'common', -45, 52), // Jam & Gym
  L('C46', 'common', -84, -52), // Fishbowl
  L('C47', 'common', 112, 54), // Den
  // Extinguisher spots (3).
  L('C48', 'common', -85, -18),
  L('C49', 'common', -85, 43),
  L('C50', 'common', 14.5, 42.8),
];

/** office.md §6: fire extinguishers at the plan's marked spots. */
const EXTINGUISHERS: [number, number][] = [[-33.4, -44.0], [-86.6, -15.5], [-86.6, 44.6], [14.5, 44.6]];

// ---------------------------------------------------------------------------------------------
// Fallback player spawns (office.md §7.1). The drone drop replaces them at match start (ADR 0005 §8).
// ---------------------------------------------------------------------------------------------
export const OFFICE_SPAWN_DEFS: readonly Vec2[] = (
  [
    [-76, -39], [-48, -39], [-46.5, -62], [-20, -39], [6, -62], [42, -39], [55.5, -62], [110, -60],
    [104, 0], [112, 22], [90, 40], [64, 39], [34, 39], [-20, 62], [-16, 39], [-40, 39],
    [-100, 60], [-102, 30], [-78, -8], [-104, -36], [-40, 0], [-20, -4], [32, 0], [60, 0],
  ] as const
).map(([x, z]) => ({ x, z }));

// ---------------------------------------------------------------------------------------------
// Zone centres and POIs (office.md §7.3, §8; ids and names from narrative, en.json poi.<id>)
// ---------------------------------------------------------------------------------------------
/**
 * Final-circle candidates. Block centres sit on a tunnel centre (column k = 2): a point between two columns would
 * land in the 0.4 m leg-panel crack, which nothing can stand in.
 */
const blockCentre = (b: BlockDef['id']): Vec2 => {
  const [x, z] = tunnel(b, 2);
  return { x, z };
};
const ZONE_CENTERS: Vec2[] = [
  { x: SEAM_X, z: 0 }, // crossroads
  { x: -40, z: 0 }, // main aisle W
  { x: 56, z: 0 }, // main aisle E
  blockCentre('TL'),
  blockCentre('TR'),
  blockCentre('BL'),
  blockCentre('BR'),
  { x: SEAM_X, z: -40 }, // vertical aisle N
  { x: SEAM_X, z: 40 }, // vertical aisle S
];

const POI_DEFS: [string, number, number, number][] = [
  ['office_meeting', -64.5, -59.2, 22],
  ['office_phone', -28.6, -62, 14],
  ['office_corner', 35.7, -59.2, 16],
  ['office_blue', 67.6, -59.2, 17],
  ['office_yellow', 100.6, -44.4, 27],
  ['office_pantry', -102.5, -29, 32],
  ['office_admin', -102.5, 30, 16],
  ['office_entrance', -88.5, 59.2, 28],
  ['office_gym', -19.8, 59.2, 40],
  ['office_games', 68.7, 59.2, 48],
  ['office_tea', colX('TL', 0), rowZ('TL', 'S'), 10],
  ['office_sales', 52.08, -23.2, 34],
  ['office_design', -23.76, 23.2, 22],
  ['office_project', -55.4, 23.2, 14],
  ['office_eng', 58.4, 23.2, 40],
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
/** Round to mm. `+ 0` turns -0 into 0. */
function r3(v: number): number {
  return Math.round(v * 1000) / 1000 + 0;
}
// Review MF2: trig and hypot go through ./detTrig (identical bits on every engine; within about 1 ulp of Math, so
// the mm-rounded data is today's).
const wrap = (a: number): number => atan2Det(sinRad(a), cosRad(a)) + 0;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Frame {
  x: number;
  z: number;
  rotY: number;
}
/** A frame's local (lx, lz) in world XZ. */
function toWorld(f: Frame, lx: number, lz: number): Vec2 {
  const c = cosRad(f.rotY);
  const s = sinRad(f.rotY);
  return { x: f.x + lx * c + lz * s, z: f.z - lx * s + lz * c };
}
/** World (x, z) in a frame's local coordinates. */
function toFrame(f: Frame, x: number, z: number): [number, number] {
  const dx = x - f.x;
  const dz = z - f.z;
  const c = cosRad(f.rotY);
  const s = sinRad(f.rotY);
  return [dx * c - dz * s, dx * s + dz * c];
}

interface Box2 {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
/** Footprint AABB of a kit kind turned by `rel` inside a parent frame, centred at (cx, cz) of that frame. */
function kindBox(kind: Kind, rel: number, cx: number, cz: number): Box2 {
  const c = cosRad(rel);
  const s = sinRad(rel);
  const b: Box2 = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  const add = (ix: number, iz: number): void => {
    const x = cx + ix * c + iz * s;
    const z = cz - ix * s + iz * c;
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.z0 = Math.min(b.z0, z);
    b.z1 = Math.max(b.z1, z);
  };
  for (const p of OFFICE_KIT[kind].colliders) {
    const [x0, z0, x1, z1] = p.type === 'cylinder' ? [p.x - p.r, p.z - p.r, p.x + p.r, p.z + p.r] : [p.min[0], p.min[2], p.max[0], p.max[2]];
    add(x0, z0);
    add(x1, z0);
    add(x0, z1);
    add(x1, z1);
  }
  return b;
}
const boxGap = (a: Box2, b: Box2): number =>
  hypot2(Math.max(a.x0 - b.x1, b.x0 - a.x1, 0), Math.max(a.z0 - b.z1, b.z0 - a.z1, 0));
const boxPointDist = (b: Box2, x: number, z: number): number =>
  hypot2(Math.max(b.x0 - x, x - b.x1, 0), Math.max(b.z0 - z, z - b.z1, 0));

interface Desk extends Frame {
  key: string;
  occ: Box2[];
  items: number;
}

/** Search outward (rings of 0.25 m, 16 directions, up to `maxR`) for the first point that passes `ok`. */
function nudge(x: number, z: number, maxR: number, ok: (x: number, z: number) => boolean): Vec2 | null {
  if (ok(x, z)) return { x, z };
  for (let r = 0.25; r <= maxR + 1e-9; r += 0.25) {
    for (let a = 0; a < 16; a++) {
      const t = (a / 16) * 2 * PI;
      const px = r3(x + r * cosRad(t));
      const pz = r3(z + r * sinRad(t));
      if (ok(px, pz)) return { x: px, z: pz };
    }
  }
  return null;
}

/** Max nudge distance for loot and spawns (office.md §6). */
export const OFFICE_NUDGE_MAX = 3;
const LOOT_SPACING = 2.0;
const CLUTTER_GAP = 0.15;
const CLUTTER_LOOT_CLEAR = 1.0;
const CLUTTER_ROUTE_CLEAR = 1.5;
const DESK_EDGE_MARGIN = 0.1;

// ---------------------------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------------------------
/**
 * M2c: who owns each placement of the M2b build (parallel to OFFICE.props). 'fixed' placements are kept by every
 * per-match layout (src/game/levels/layout/office.ts); everything else is regenerated per match:
 * 'block:<TL|TR|BL|BR>' (desks, chairs, monitors, keyboards, laptops, tunnel cover), 'aisle' (K1-K4),
 * 'room:<fishbowl|blue|pantry|lounge>' (the room arrangements) and 'clutter' (desk-top clutter on block desks).
 */
export type OfficePropTag = 'fixed' | 'aisle' | 'clutter' | `block:${'TL' | 'TR' | 'BL' | 'BR'}` | `room:${'fishbowl' | 'blue' | 'pantry' | 'lounge'}`;

export function buildOffice(): IndoorMapData {
  return buildOfficeTagged().map;
}

/** The M2b build plus one OfficePropTag per placement. */
export function buildOfficeTagged(): { map: IndoorMapData; tags: OfficePropTag[] } {
  const rng = mulberry32(LAYOUT_SEED);
  const range = (a: number, b: number): number => a + (b - a) * rng();
  const props: IndoorPropPlacement[] = [];
  const tags: OfficePropTag[] = [];
  let tag: OfficePropTag = 'fixed';
  const add = (kind: Kind, x: number, z: number, rotY = 0, y = 0): IndoorPropPlacement => {
    const p: IndoorPropPlacement = { kind, x: r3(x), y: r3(y), z: r3(z), rotY: wrap(rotY), scale: 1 };
    props.push(p);
    tags.push(tag);
    return p;
  };
  const desks = new Map<string, Desk>();
  const addDesk = (key: string, kind: 'desk' | 'deskWood', x: number, z: number, rotY: number): Desk => {
    add(kind, x, z, rotY);
    const d: Desk = { key, x, z, rotY, occ: [], items: 0 };
    desks.set(key, d);
    return d;
  };
  /** A surface prop on a desk at desk-local (lx, lz), turned `rel` relative to the desk. */
  const onDesk = (d: Desk, kind: Kind, lx: number, lz: number, rel = 0, y = OFFICE_DESK_TOP): void => {
    const w = toWorld(d, lx, lz);
    add(kind, w.x, w.z, d.rotY + rel, y);
    d.occ.push(kindBox(kind, rel, lx, lz));
  };
  const chair = (x: number, z: number, rotY: number): void => {
    add('chair', x, z, rotY);
  };

  // 1. Desk blocks, chairs, monitors, keyboards, laptops, under-desk cover (office.md §3).
  const monitored: Desk[] = [];
  for (const b of BLOCKS) {
    tag = `block:${b.id}`;
    for (let k = 0; k < b.n; k++) {
      const x = colX(b.id, k);
      for (const row of ['N', 'S'] as const) {
        const key = `${b.id}.${row}.${k}`;
        const rotY = row === 'N' ? 0 : PI;
        const d = addDesk(key, 'desk', x, rowZ(b.id, row), rotY);
        const code = (row === 'N' ? b.north : b.south)[k] ?? 'x';
        if (code === '1' || code === '2') {
          onDesk(d, code === '2' ? 'monitorDual' : 'monitor', MONITOR_AT[0], MONITOR_AT[1]);
          onDesk(d, 'keyboard', KEYBOARD_AT[0], KEYBOARD_AT[1]);
          monitored.push(d);
        } else if (code === 'x') {
          onDesk(d, 'laptop', LAPTOP_AT[0], LAPTOP_AT[1]);
        }
        if (!CHAIR_OMIT.has(key)) {
          let cx = CHAIR_FIXED_X[key] ?? x + range(-CHAIR_JITTER, CHAIR_JITTER);
          if (CHAIR_NO_EAST_JITTER.has(key)) cx = Math.min(cx, x);
          chair(cx, d.z + (row === 'N' ? -CHAIR_OFFSET : CHAIR_OFFSET), rotY + PI);
        }
      }
      const s = k % 2 === 0 ? 1 : -1;
      add('boxSmall', x + TUNNEL_COVER.small[0] * s, b.spine + TUNNEL_COVER.small[1] * s);
      add('bookStack', x + TUNNEL_COVER.books[0] * s, b.spine + TUNNEL_COVER.books[1] * s);
    }
  }
  tag = 'fixed';
  for (const bx of BRIDGE_X) {
    addDesk(`bridgeN.${bx}`, 'deskWood', bx, BRIDGE_N_Z, PI);
    addDesk(`bridgeS.${bx}`, 'deskWood', bx, BRIDGE_S_Z, 0);
    add('boxSmall', bx + BRIDGE_COVER_DX, BRIDGE_N_Z);
    add('boxSmall', bx + BRIDGE_COVER_DX, BRIDGE_S_Z);
  }
  // Extra laptops on random monitored desks, beside the keyboard.
  const pool = [...monitored];
  for (let i = 0; i < EXTRA_LAPTOPS && pool.length > 0; i++) {
    const d = pool.splice(Math.floor(rng() * pool.length), 1)[0]!;
    tag = `block:${d.key.slice(0, 2) as 'TL' | 'TR' | 'BL' | 'BR'}`;
    onDesk(d, 'laptop', rng() < 0.5 ? -EXTRA_LAPTOP_X : EXTRA_LAPTOP_X, LAPTOP_AT[1]);
  }
  tag = 'fixed';

  // 2. Climb routes (office.md §4).
  const routes: ClimbRoute[] = [];
  const steps = OFFICE_KIT.bookStairs.colliders
    .filter((c): c is BoxPart => c.type !== 'cylinder' && c.name.startsWith('step'))
    .sort((p, q) => Number(p.name.slice(4)) - Number(q.name.slice(4)));
  const ramp = boxPart('whiteboardRamp', 'ramp');
  for (const r of STAIR_ROUTES) {
    add(r.kind, r.x, r.z, r.rotY);
    const top = r.top ?? OFFICE_DESK_TOP;
    const at = (lz: number, y: number): Vec3 => {
      const w = toWorld(r, 0, lz);
      return { x: r3(w.x), y: r3(y), z: r3(w.z) };
    };
    const points: Vec3[] = [];
    if (r.kind === 'bookStairs') {
      points.push(r.start ?? at(STAIRS_START, 0));
      // Waypoint k sits on step k, k stacks high (0.945 k); the top step (6.615) is 0.045 below the plateau.
      steps.forEach((c, i) => points.push(at((c.min[2] + c.max[2]) / 2, Math.min(c.max[1], (i + 1) * STACK_H))));
      points.push(at(STAIRS_END, top));
    } else {
      const h = ramp.max[1] - ramp.min[1];
      const n = Math.ceil(h / RAMP_STEP_RISE - 1e-9);
      const tread = (ramp.max[2] - ramp.min[2]) / n;
      points.push(at(RAMP_START, 0));
      for (let i = 1; i <= n; i++) points.push(at(ramp.max[2] - (i - 0.5) * tread, ramp.min[1] + (i * h) / n));
      points.push(at(RAMP_END, top));
    }
    routes.push({ id: r.id, points, mode: r.kind === 'whiteboardRamp' ? 'walk' : 'jump', plateau: r.plateau });
  }
  for (const t of TOWERS) {
    for (const c of t.cells) for (let i = 0; i < c.n; i++) add('bookStack', c.x, c.z, 0, t.base + i * STACK_H);
    const points: Vec3[] = [
      { ...t.start },
      ...t.cells.map((c) => ({ x: r3(c.x), y: r3(t.base + c.n * STACK_H), z: r3(c.z) })),
      ...(t.end ? [{ ...t.end }] : []),
    ];
    routes.push({ id: t.id, points, mode: 'jump', plateau: t.plateau });
  }

  // 3. Walls' door frames and the closed front door (office.md §2).
  for (const d of OFFICE_DOORWAYS) add('doorFrame', d.x, d.z, d.rotY);
  add('doorFrame', -74, OFFICE_FLOOR.maxZ - JAMB_L.max[2] - 0.04, 0); // closed front door against O-S

  // 4. Main aisle cover clusters K1-K4 (office.md §5.1): a box, two flush boxSmalls, one stray chair.
  const bhx = BOX.max[0];
  const bhz = BOX.max[2];
  const shx = SMALL.max[0];
  const shz = SMALL.max[2];
  const clusters: { c: [number, number]; smalls: 'ew' | 'ns'; chair: [number, number] }[] = [
    { c: [-52, 4], smalls: 'ew', chair: [7, -7] },
    { c: [2, -5], smalls: 'ew', chair: [0, 7.5] },
    { c: [46, -5], smalls: 'ew', chair: [-7, 7] }, // keeps zone centre (56, 0) and spawn 24 clear
    { c: [100, 6], smalls: 'ns', chair: [8, 3] },
  ];
  tag = 'aisle';
  for (const k of clusters) {
    const [x, z] = k.c;
    add('box', x, z);
    if (k.smalls === 'ew') {
      add('boxSmall', x - bhx - shx, z + 0.8);
      add('boxSmall', x + bhx + shx, z - 0.8);
    } else {
      add('boxSmall', x - 0.6, z - bhz - shz);
      add('boxSmall', x + 0.6, z + bhz + shz);
    }
    chair(x + k.chair[0], z + k.chair[1], range(-PI, PI));
  }

  // 5. Rooms (office.md §2.4).
  const wallFaceN = OFFICE_FLOOR.minZ; // -72
  const glassFaceS = -46 - WALL_T / 2; // the north rooms' corridor wall face
  const chairWallClear = CHAIR_R + 0.48;
  /** A room table of `cols` facing deskWood pairs centred on z = zc, with one chair per desk on its long side. */
  const roomTable = (key: string, x0: number, cols: number, zc: number, faceN: number, faceS: number): void => {
    for (let k = 0; k < cols; k++) {
      const x = x0 + COL * k;
      addDesk(`${key}.N.${k}`, 'deskWood', x, zc - ROW, 0);
      addDesk(`${key}.S.${k}`, 'deskWood', x, zc + ROW, PI);
      chair(x, Math.max(zc - ROW - CHAIR_OFFSET, faceN + chairWallClear), PI);
      chair(x, Math.min(zc + ROW + CHAIR_OFFSET, faceS - chairWallClear), 0);
    }
  };
  const endChairGap = DESK_HALF_W + CHAIR_R + 0.03;

  // Fishbowl: long table of 4 deskWood, 4 side chairs + 2 at the west end, a plant.
  tag = 'room:fishbowl';
  roomTable('fishbowl', -71.0, 2, -59.4, wallFaceN, glassFaceS);
  for (const dz of [-ROW, ROW]) chair(-71.0 - endChairGap, -59.4 + dz, -HALF_PI);
  add('pottedPlant', -44.5, -49.5);
  tag = 'fixed';
  // Shush Booth: two closed pods, doors to the corridor, a 4.7 m slot between them.
  const podHalf = boxPart('phoneBooth', 'pod').max[0];
  for (const x of [-35.75, -21.5]) add('phoneBooth', x, wallFaceN + podHalf, PI);
  // Lounge: pinboard, plants, boxes.
  add('pinboard', 2, wallFaceN, PI);
  tag = 'room:lounge';
  add('pottedPlant', -14, -69.5);
  add('pottedPlant', 18.5, -69.5);
  add('box', -11, -64);
  add('boxSmall', -11 + bhx + shx, -64.5);
  add('box', 14, -66);
  add('boxSmall', 14, -66 + bhz + shz);
  tag = 'fixed';
  // Corner Office: exec desk plateau (2 epic), exec chair, routes CO-A / CO-B (above), plants.
  const exec = addDesk('exec', 'deskWood', 39.92, -60, 0);
  onDesk(exec, 'monitor', MONITOR_AT[0], MONITOR_AT[1]);
  onDesk(exec, 'keyboard', KEYBOARD_AT[0], KEYBOARD_AT[1]);
  chair(39.92, -66.5, PI);
  add('pottedPlant', 22.5, -69.5);
  add('pottedPlant', 49, -70);
  // Blue Room: one facing pair, 2 side chairs + 2 at the east end, a plant.
  tag = 'room:blue';
  roomTable('blue', 67.5, 1, -59.4, wallFaceN, glassFaceS);
  for (const dz of [-ROW, ROW]) chair(67.5 + endChairGap, -59.4 + dz, HALF_PI);
  add('pottedPlant', 53.5, -69.5);
  tag = 'fixed';
  // Yellow Room: a climbable table (routes YEL-N / YEL-S), 4 chairs, a laptop, a plant.
  const yellowN = addDesk('yellow.N', 'deskWood', 101, -45.0 - ROW, 0);
  addDesk('yellow.S', 'deskWood', 101, -45.0 + ROW, PI);
  onDesk(yellowN, 'laptop', LAPTOP_AT[0], LAPTOP_AT[1]);
  chair(94.5, -57.2, PI);
  chair(107.5, -57.2, PI);
  chair(91, -45, -HALF_PI);
  chair(111, -45, HALF_PI);
  add('pottedPlant', 88, -69.5);
  // Pantry & Loos: kitchen counter (bottles and mugs on top), table with 2 chairs, boxes; two vanities.
  const counter = add('pantryCounter', -114.21, -30, -HALF_PI);
  const counterItems: [Kind, number, number][] = [
    ['waterBottle', -2.6, -1.2], ['waterBottle', -1.8, -1.2], ['waterBottle', -1.0, -1.2],
    ['waterBottle', 6.3, -1.2], ['waterBottle', 7.1, -1.2], ['waterBottle', 7.9, -1.2],
    ['mug', -2.2, 0.9], ['mug', -1.2, 0.9], ['mug', 0.0, 0.9], ['mug', 0.9, 0.9],
  ];
  for (const [kind, lx, lz] of counterItems) {
    const w = toWorld(counter, lx, lz);
    add(kind, w.x, w.z, counter.rotY, COUNTER_TOP);
  }
  tag = 'room:pantry';
  addDesk('pantry', 'deskWood', -96, -30, HALF_PI);
  chair(-96, -30 - DESK_HALF_W - CHAIR_R - 0.06, PI);
  chair(-96, -30 + DESK_HALF_W + CHAIR_R + 0.06, 0);
  add('box', -113, -17);
  add('boxSmall', -113 + bhx + shx, -17.8);
  add('box', -112, -43);
  add('boxSmall', -112, -43 + bhz + shz);
  tag = 'fixed';
  add('pantryCounter', -91.24, -62, HALF_PI); // loos N vanity
  add('pantryCounter', -100, 10.76, 0); // loos S vanity
  // Paper Jam Corner: filing cabinets, printer, admin desk + chair, boxes with books on top.
  for (const z of [18.5, 22.55, 26.6]) add('filingCabinet', -114.3, z, -HALF_PI);
  add('printer', -113.5, 40, -HALF_PI);
  addDesk('admin', 'desk', -99.28, 18.0, PI);
  chair(-99.28, 18.0 + CHAIR_OFFSET, 0);
  add('box', -113, 33);
  add('boxSmall', -113 + bhx + shx, 33.8);
  add('bookStack', -113, 33, 0.3, BOX.max[1]);
  add('box', -93, 42);
  add('boxSmall', -93, 42 - bhz - shz);
  add('bookStack', -93, 42, -0.2, BOX.max[1]);
  add('boxSmall', -104, 44);
  // Welcome Mat: reception desk + chair, plants, the delivery pile.
  addDesk('reception', 'desk', -106, 52, PI);
  chair(-106, 52 + CHAIR_OFFSET, 0);
  for (const x of [-114.5, -90, -63]) add('pottedPlant', x, 69.5);
  const pile = { x: -72, z: 53 };
  add('box', pile.x - bhx, pile.z);
  add('box', pile.x + bhx, pile.z);
  add('box', pile.x, pile.z, 0.15, BOX.max[1]);
  add('boxSmall', pile.x + 2 * bhx + shx, pile.z + 0.5);
  add('boxSmall', pile.x - 1.5, pile.z - bhz - shz);
  add('boxSmall', pile.x + 1.5, pile.z + bhz + shz);
  // Jam & Gym Room: keyboard stand, dumbbell racks, guitar stands, amps, plants.
  const stand = addDesk('gym', 'deskWood', -30, 67.5, 0);
  onDesk(stand, 'keyboard', 0, 0);
  add('dumbbellRack', 18.0, 64, HALF_PI);
  add('dumbbellRack', 5, 69.9, 0);
  add('guitarStand', -54, 68);
  add('guitarStand', -48, 68);
  add('box', -12, 68.7);
  add('boxSmall', -12 + bhx + shx, 69.5);
  add('box', -57, 52);
  add('boxSmall', -57, 52 + bhz + shz);
  add('box', 10.5, 52);
  add('boxSmall', 10.5, 52 + bhz + shz);
  add('pottedPlant', -58, 69.5);
  add('pottedPlant', 13.5, 69.6);
  // Ping Pong Den: table (2 epic, the net is a wall), foosball, boxes, plants.
  add('pingPongTable', 58, 59.2, HALF_PI);
  add('foosballTable', 98, 59.2, HALF_PI);
  add('box', 26, 68.5);
  add('boxSmall', 26 + bhx + shx, 69.3);
  add('box', 88, 68.5);
  add('box', 113.5, 68.5);
  add('boxSmall', 113.5, 68.5 - bhz - shz);
  add('pottedPlant', 22.5, 49.5);
  add('pottedPlant', 115, 50);
  // Fire extinguishers.
  for (const [x, z] of EXTINGUISHERS) add('fireExtinguisher', x, z);

  // 6. Loot: nudge every source off crowding props (same level, <= 3 m).
  const walls = SPLIT.walls;
  const wallSolids = walls.map((w, i) => wallSolid(w, i));
  let solids: Solid[] = [...wallSolids, ...propSolids(OFFICE_KIT, props)];
  const lootSpawns: LootSpawn[] = [];
  for (const def of OFFICE_LOOT_DEFS) {
    const y = LEVEL_Y[def.level];
    const spaced = (x: number, z: number): boolean =>
      lootSpawns.every((o) => Math.abs((o.y ?? 0) - y) > 0.5 || hypot2(o.x - x, o.z - z) >= LOOT_SPACING);
    const p = nudge(def.x, def.z, OFFICE_NUDGE_MAX, (x, z) => spaced(x, z) && lootSpotIssue(solids, OFFICE_FLOOR, x, y, z) === null);
    const at = p ?? { x: def.x, z: def.z };
    lootSpawns.push(def.level === 'floor' ? { x: r3(at.x), z: r3(at.z), tier: def.tier } : { x: r3(at.x), z: r3(at.z), tier: def.tier, y: r3(y) });
  }

  // 7. Desk-top clutter (office.md §3.3), clear of loot and of climb-route landings.
  const avoidLoot = lootSpawns.filter((l) => Math.abs((l.y ?? 0) - OFFICE_DESK_TOP) < 0.1);
  const avoidRoute = routes.flatMap((r) => r.points).filter((p) => Math.abs(p.y - OFFICE_DESK_TOP) < 0.5);
  const xLim = DESK_HALF_W - DESK_EDGE_MARGIN;
  const zLim = DESK_HALF_D - DESK_EDGE_MARGIN;
  const tryClutter = (d: Desk, kind: Kind): boolean => {
    for (let t = 0; t < 80; t++) {
      const quarter = Math.floor(rng() * 4) * HALF_PI;
      const rel = quarter + (kind.startsWith('plush') || kind === 'mug' || kind === 'waterBottle' ? range(-0.35, 0.35) : 0);
      const lx = range(-xLim, xLim);
      const lz = range(-zLim, zLim);
      const b = kindBox(kind, rel, lx, lz);
      if (b.x0 < -xLim || b.x1 > xLim || b.z0 < -zLim || b.z1 > zLim) continue;
      if (d.occ.some((o) => boxGap(o, b) < CLUTTER_GAP)) continue;
      const clear = (pts: readonly { x: number; z: number }[], r: number): boolean =>
        pts.every((p) => {
          const [px, pz] = toFrame(d, p.x, p.z);
          return boxPointDist(b, px, pz) >= r;
        });
      if (!clear(avoidLoot, CLUTTER_LOOT_CLEAR) || !clear(avoidRoute, CLUTTER_ROUTE_CLEAR)) continue;
      onDesk(d, kind, lx, lz, rel);
      d.items++;
      return true;
    }
    return false;
  };
  const kettle = desks.get('TL.S.0')!;
  tag = 'clutter';
  for (const [kind, n] of KETTLE_ITEMS) for (let i = 0; i < n; i++) tryClutter(kettle, kind);
  tag = 'fixed';
  tryClutter(exec, 'plushWhale');
  tryClutter(exec, 'mug');
  tag = 'clutter';
  const eligible = BLOCKS.flatMap((b) =>
    (['N', 'S'] as const).flatMap((row) =>
      [...Array(b.n).keys()]
        .filter((k) => !'KP'.includes((row === 'N' ? b.north : b.south)[k] ?? ''))
        .map((k) => desks.get(`${b.id}.${row}.${k}`)!),
    ),
  );
  for (const [kind, n] of DESK_CLUTTER) {
    for (let i = 0; i < n; i++) {
      // Fewest items first, random among ties; up to 3 per desk.
      const order = eligible
        .filter((d) => d.items < 3)
        .map((d) => ({ d, key: d.items + rng() * 0.5 }))
        .sort((p, q) => p.key - q.key);
      for (const { d } of order) if (tryClutter(d, kind)) break;
    }
  }
  tag = 'fixed';

  // 8. Ceiling visuals (no colliders): light panel rows over the open plan, room panels, AC cassettes.
  // Visual-only kinds have no colliders: use the drawn size for the footprint.
  const [lw, , ld] = OFFICE_KIT.lightPanel.size;
  const lightBox = (x: number, z: number): Box2 => ({ x0: x - lw / 2, x1: x + lw / 2, z0: z - ld / 2, z1: z + ld / 2 });
  const wallBoxes = wallSolids.map((s) => {
    const ex = Math.abs(s.hx * s.cos) + Math.abs(s.hz * s.sin);
    const ez = Math.abs(s.hx * s.sin) + Math.abs(s.hz * s.cos);
    return { x0: s.cx - ex, x1: s.cx + ex, z0: s.cz - ez, z1: s.cz + ez };
  });
  const lights: Box2[] = [];
  const LIGHT_Y = CEILING - 5.4;
  const light = (x: number, z: number): void => {
    const b = lightBox(x, z);
    if (b.x0 < OFFICE_FLOOR.minX || b.x1 > OFFICE_FLOOR.maxX || b.z0 < OFFICE_FLOOR.minZ || b.z1 > OFFICE_FLOOR.maxZ) return;
    if (wallBoxes.some((w) => boxGap(w, b) <= 0) || lights.some((o) => boxGap(o, b) < 1)) return;
    lights.push(b);
    add('lightPanel', x, z, 0, LIGHT_Y);
  };
  for (const z of [-38, -23.2, -8, 8, 23.2, 38]) for (let i = 0; i < 12; i++) light(-78 + 16.2 * i, z);
  for (const room of Object.values(ROOMS)) {
    const w = room.maxX - room.minX;
    const dpt = room.maxZ - room.minZ;
    const nx = Math.max(1, Math.floor((w - 4) / 16.2));
    const nz = dpt > 30 ? 2 : 1;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) light(room.minX + (w * (i + 0.5)) / nx, room.minZ + (dpt * (j + 0.5)) / nz);
    }
  }
  for (const x of [-60, -20, 20, 60, 100]) for (const z of [-23.2, 23.2]) add('acCassette', x, z, 0, CEILING);
  for (const room of [ROOMS.fishbowl, ROOMS.gym, ROOMS.den, ROOMS.pantry]) {
    add('acCassette', (room.minX + room.maxX) / 2, (room.minZ + room.maxZ) / 2 + 4, 0, CEILING);
  }

  // 9. Fallback spawns: nudge off any collider (2.5 m clearance).
  solids = [...wallSolids, ...propSolids(OFFICE_KIT, props)];
  const playerSpawns = OFFICE_SPAWN_DEFS.map((s) => {
    const p = nudge(s.x, s.z, OFFICE_NUDGE_MAX, (x, z) => spawnIssue(solids, OFFICE_FLOOR, x, z) === null);
    return p ? { x: r3(p.x), z: r3(p.z) } : { x: s.x, z: s.z };
  });

  const pois: MapPoi[] = POI_DEFS.map(([id, x, z, radius]) => ({ id, nameKey: `poi.${id}`, x: r3(x), z: r3(z), radius }));

  const map: IndoorMapData = {
    kind: 'indoor',
    id: 'office',
    nameKey: 'map.office.name',
    carrier: 'drone',
    floor: { ...OFFICE_FLOOR },
    floorMaterial: 'wood',
    floorZones: FLOOR_ZONES.map((z) => ({ ...z })),
    ceilingHeight: CEILING,
    walls,
    props,
    kit: OFFICE_KIT,
    climbRoutes: routes,
    playerSpawns,
    lootSpawns,
    zoneCenters: ZONE_CENTERS.map((c) => ({ x: r3(c.x), z: r3(c.z) })),
    pois,
  };
  return { map, tags };
}

const BUILT = buildOfficeTagged();
/** Map 2 (ARCHITECTURE §15.5). */
export const OFFICE: IndoorMapData = BUILT.map;
/** M2c: one OfficePropTag per OFFICE.props entry (same order). */
export const OFFICE_PROP_TAGS: readonly OfficePropTag[] = BUILT.tags;

/**
 * M2c: the M2b building blocks the per-match generator (layout/office.ts) re-uses, so both builds follow one rule set
 * (office.md §3). Read-only data.
 */
export const OFFICE_LAYOUT_SPEC = {
  blocks: BLOCKS,
  col: COL,
  row: ROW,
  deskHalfW: DESK_HALF_W,
  deskHalfD: DESK_HALF_D,
  chairOffset: CHAIR_OFFSET,
  chairJitter: CHAIR_JITTER,
  chairOmit: CHAIR_OMIT,
  chairFixedX: CHAIR_FIXED_X,
  chairNoEastJitter: CHAIR_NO_EAST_JITTER,
  tunnelCover: TUNNEL_COVER,
  monitorAt: MONITOR_AT,
  keyboardAt: KEYBOARD_AT,
  laptopAt: LAPTOP_AT,
  extraLaptopX: EXTRA_LAPTOP_X,
  extraLaptops: EXTRA_LAPTOPS,
  kettleItems: KETTLE_ITEMS,
  clutterGap: CLUTTER_GAP,
  clutterLootClear: CLUTTER_LOOT_CLEAR,
  clutterRouteClear: CLUTTER_ROUTE_CLEAR,
  deskEdgeMargin: DESK_EDGE_MARGIN,
  rooms: ROOMS,
  levelY: LEVEL_Y,
  lootSpacing: LOOT_SPACING,
} as const;
