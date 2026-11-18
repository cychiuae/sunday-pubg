/**
 * Test helpers for src/shared/sim tests (not used at runtime).
 */
import type { Balance } from '../balance';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { MapData, PlayerInput, PropPlacement, SimEvent, WeaponId } from '../types';
import { createDebugWorld, type DebugWorld } from './World';

/** Flat test island: no hills, no shore noise, flat at baseHeight inside islandRadius - beachWidth. */
export function flatMap(overrides: Partial<MapData> = {}, props: PropPlacement[] = []): MapData {
  return {
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

/** Deep-ish clone of BALANCE with patches applied per section. */
export function balanceWith(patch: (b: Balance) => void): Balance {
  const b = JSON.parse(JSON.stringify(BALANCE)) as Balance;
  patch(b);
  return b;
}

/** Balance with zero spread on every weapon (deterministic hitscan tests). */
export function noSpreadBalance(patch?: (b: Balance) => void): Balance {
  return balanceWith((b) => {
    for (const w of Object.keys(b.weapons) as WeaponId[]) b.weapons[w].spreadDeg = 0;
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
    ...over,
  };
}

/**
 * World with `humans` human players and no bots, already in 'playing'. Players are grounded (not dropping) at their
 * spawn on flat ground. Returns ids in join order.
 */
export function playingWorld(
  humans: number,
  opts: { map?: MapData; balance?: Balance; seed?: number } = {},
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
  const w = createDebugWorld({ map: opts.map ?? flatMap(), balance, seed: opts.seed ?? 1, botNames: ['Bot'] });
  const ids: number[] = [];
  for (let i = 0; i < humans; i++) ids.push(w.addPlayer(`P${i}`)!);
  const events: SimEvent[] = [];
  for (let i = 0; i < 5 && w.getMatch().phase !== 'playing'; i++) events.push(...w.step(SIM_DT));
  for (const id of ids) land(w, id);
  return { w, ids, events };
}

/** Puts a player on the ground at (x, z) (terrain height), not dropping. */
export function land(w: DebugWorld, id: number, x?: number, z?: number): void {
  const p = w.debugPlayer(id)!;
  const px = x ?? p.move.pos.x;
  const pz = z ?? p.move.pos.z;
  const ctx = w.debugContext();
  const y = ctx.map.baseHeight; // flat maps only
  p.move = { pos: { x: px, y, z: pz }, vel: { x: 0, y: 0, z: 0 }, grounded: true, dropping: false };
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
