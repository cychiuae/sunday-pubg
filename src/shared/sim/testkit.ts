/**
 * Test helpers for src/shared/sim tests (not used at runtime).
 */
import type { Balance } from '../balance';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type {
  AnyMapData,
  IndoorMapData,
  IndoorPropPlacement,
  IslandMapData,
  PlayerInput,
  PropKit,
  PropPlacement,
  SimEvent,
  WallSegment,
} from '../types';
import { WEAPON_IDS } from '../types';
import { initialMovementState } from './movement';
import { heightAt } from './terrain';
import { createDebugWorld, type DebugWorld, type WorldOptions } from './World';

/** Flat test island: no hills, no shore noise, flat at baseHeight inside islandRadius - beachWidth. */
export function flatMap(overrides: Partial<IslandMapData> = {}, props: PropPlacement[] = []): IslandMapData {
  return {
    kind: 'island',
    carrier: 'seaplane',
    id: 'test-flat',
    nameKey: 'map.test',
    islandRadius: 200,
    worldRadius: 230,
    baseHeight: 2,
    beachWidth: 10,
    shoreNoise: { amplitude: 0, frequency: 2.5, seed: 1 },
    hills: [],
    props,
    playerSpawns: [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: -20, z: 0 },
      { x: 0, z: 20 },
    ],
    lootSpawns: [],
    zoneCenters: [{ x: 0, z: 0 }],
    pois: [],
    ...overrides,
  };
}

/**
 * Small synthetic kit for indoor tests (the real office kit is the level-designer's / graphics-designer's): a desk
 * (top 6.66 m, legs), a 0.945 m jump step, a glass pane, a ramp to the desk top and a ping-pong table with its 1.6 m net.
 */
export const TEST_KIT: PropKit = {
  desk: {
    origin: 'floor',
    size: [12, 6.66, 6],
    colliders: [
      { type: 'box', name: 'top', min: [-6, 6.39, -3], max: [6, 6.66, 3] },
      { type: 'box', name: 'legL', min: [-6, 0, -3], max: [-5.6, 6.39, 3] },
      { type: 'box', name: 'legR', min: [5.6, 0, -3], max: [6, 6.39, 3] },
    ],
  },
  step: { origin: 'floor', size: [2, 0.945, 2], colliders: [{ type: 'box', name: 'step', min: [-1, 0, -1], max: [1, 0.945, 1] }] },
  pane: { origin: 'floor', size: [6, 27, 0.4], colliders: [{ type: 'box', name: 'glass', min: [-3, 0, -0.2], max: [3, 27, 0.2], glass: true }] },
  ramp: { origin: 'floor', size: [4, 6.66, 14], colliders: [{ type: 'ramp', name: 'ramp', min: [-2, 0, -7], max: [2, 6.66, 7] }] },
  pingPongTable: {
    origin: 'floor',
    size: [16.47, 8.28, 24.66],
    colliders: [
      { type: 'box', name: 'top', min: [-6.8625, 6.57, -12.33], max: [6.8625, 6.84, 12.33] },
      { type: 'box', name: 'net', min: [-8.235, 6.84, -0.09], max: [8.235, 8.44, 0.09] },
    ],
  },
  lamp: { origin: 'ceiling', size: [2, 1, 2], colliders: [] },
};

/** A floor-standing wall segment (solid unless `glass`), 27 m tall, 0.9 m thick. */
export const wall = (x1: number, z1: number, x2: number, z2: number, glass = false): WallSegment => ({
  x1,
  z1,
  x2,
  z2,
  thickness: 0.9,
  bottom: 0,
  top: 27,
  material: glass ? 'glass' : 'solid',
});

/**
 * Synthetic indoor map: a 120 x 80 m floor (half extents 60 x 40), ceiling 30, outer walls, wood floor with a carpet
 * zone, plus the given props and walls. Kit = TEST_KIT.
 */
export function roomMap(props: IndoorPropPlacement[] = [], walls: WallSegment[] = [], overrides: Partial<IndoorMapData> = {}): IndoorMapData {
  return {
    kind: 'indoor',
    carrier: 'drone',
    id: 'test-room',
    nameKey: 'map.test',
    floor: { minX: -60, minZ: -40, maxX: 60, maxZ: 40 },
    floorMaterial: 'wood',
    floorZones: [{ minX: 20, minZ: -10, maxX: 40, maxZ: 10, material: 'carpet' }],
    ceilingHeight: 30,
    walls: [wall(-60, -40, 60, -40), wall(60, -40, 60, 40), wall(60, 40, -60, 40), wall(-60, 40, -60, -40), ...walls],
    props,
    kit: TEST_KIT,
    climbRoutes: [],
    playerSpawns: [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: -20, z: 0 },
      { x: 0, z: 20 },
    ],
    lootSpawns: [],
    zoneCenters: [{ x: 0, z: 0 }],
    pois: [],
    ...overrides,
  };
}

/** Deep-ish clone of BALANCE with patches applied per section. */
export function balanceWith(patch: (b: Balance) => void): Balance {
  const b = JSON.parse(JSON.stringify(BALANCE)) as Balance;
  patch(b);
  return b;
}

/** Balance with zero spread on every weapon (deterministic hitscan tests). */
export function noSpreadBalance(patch?: (b: Balance) => void): Balance {
  return balanceWith((b) => {
    for (const w of WEAPON_IDS) b.weapons[w].spreadDeg = 0;
    patch?.(b);
  });
}

export function input(over: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq: 0,
    dt: SIM_DT,
    moveForward: 0,
    moveRight: 0,
    yaw: 0,
    pitch: 0,
    sprint: false,
    fire: false,
    jump: false,
    reload: false,
    interact: false,
    useHeal: false,
    selectSlot: -1,
    ads: false,
    stanceToggle: null,
    ...over,
  };
}

/**
 * World with `humans` human players and no bots, already in 'playing'. Players are grounded (not dropping) at their
 * spawn on flat ground. Returns ids in join order.
 */
export function playingWorld(
  humans: number,
  opts: { map?: AnyMapData; balance?: Balance; seed?: number; drop?: boolean; extra?: Partial<WorldOptions> } = {},
): { w: DebugWorld; ids: number[]; events: SimEvent[] } {
  const balance =
    opts.balance ??
    balanceWith(() => {
      /* defaults */
    });
  balance.match.minHumansToStart = humans;
  balance.match.targetPlayers = humans;
  balance.match.countdownSeconds = 0;
  balance.match.spawnJitter = 0;
  // drop: false = the M1 spawn (these tests place players with land()); pass drop: true for carrier tests.
  const w = createDebugWorld({ map: opts.map ?? flatMap(), balance, seed: opts.seed ?? 1, botNames: ['Bot'], drop: opts.drop ?? false, ...opts.extra });
  const ids: number[] = [];
  for (let i = 0; i < humans; i++) ids.push(w.addPlayer(`P${i}`)!);
  const events: SimEvent[] = [];
  for (let i = 0; i < 5 && w.getMatch().phase !== 'playing'; i++) events.push(...w.step(SIM_DT));
  for (const id of ids) land(w, id);
  return { w, ids, events };
}

/** Puts a player on the ground at (x, z) (terrain / floor height), not dropping, not aboard. */
export function land(w: DebugWorld, id: number, x?: number, z?: number): void {
  const p = w.debugPlayer(id)!;
  const px = x ?? p.move.pos.x;
  const pz = z ?? p.move.pos.z;
  const ctx = w.debugContext();
  const y = heightAt(px, pz, ctx.map);
  p.aboard = false;
  p.move = initialMovementState({ x: px, y, z: pz }, false);
}

/** Runs n steps, feeding `inputs(i)` to the given players (seq auto-incremented). Returns all events. */
export function run(
  w: DebugWorld,
  n: number,
  feed: Record<number, (i: number) => Partial<PlayerInput>> = {},
): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const [idStr, f] of Object.entries(feed)) {
      const id = Number(idStr);
      const p = w.debugPlayer(id);
      if (!p) continue;
      w.applyInput(id, input({ seq: p.lastProcessedInputSeq + 1 + p.queue.length, ...f(i) }));
    }
    events.push(...w.step(SIM_DT));
  }
  return events;
}
