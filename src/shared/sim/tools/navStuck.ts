/**
 * Office nav stuck rate (maps.md acceptance 20, brief / variety.md LV14). Dev tool and test helper, not shipped.
 *
 * Bots walk between random reachable goals (a third on plateaus) on an indoor map, driven by navSteer and the real
 * movement step. A bot is STUCK in a 1 s sample when it made less than 1 m of 3D progress over the last 3 s while it had
 * a goal. The M2b office work measured 0.06-0.69 % over seeds 1-10 (180 s, 12 bots). The rate is samples stuck /
 * samples, over every bot.
 *
 * `simulateNav` takes the map to walk: for M2c pass the layout-APPLIED map (applyLayout(base, buildMatchLayout(base,
 * seed, { decor: false }))), exactly what the server prepares at the lock. `navStuckForLayoutSeeds` does that per seed.
 */
import type { Balance } from '../../balance';
import { createRng } from '../../math';
import { SIM_DT } from '../../constants';
import type { IndoorMapData, PlayerInput, Vec3 } from '../../types';
import { createNavFollow, navSteer, type BotNavEnv } from '../bots';
import { prepareMap, stepMovement, toMovementInput } from '../movement';
import { isReachableNode, NavBudget, nodePos, navTuning, PathCache, plateauNodes } from '../nav';
import { applyLayout, buildMatchLayout } from '../../../game/levels/layout/index';

/** The layout-applied map of a seed, as the server builds it at the lock (no decor). */
export const layoutOffice = (base: IndoorMapData, seed: number): IndoorMapData => applyLayout(base, buildMatchLayout(base, seed, { decor: false }));

export interface NavSimResult {
  stuckRate: number;
  arrivals: number;
  plateauArrivals: number;
  botSeconds: number;
  /** Bot-second samples and how many of them were stuck. */
  samples: number;
  stuck: number;
}

/**
 * Bots walk between random reachable goals (a third on plateaus) on a fixture, driven by navSteer and the real
 * movement step. Stuck = no 1 m of progress over the last 3 s while it has a goal (maps.md acceptance 20).
 */
export function simulateNav(map: IndoorMapData, b: Balance, nBots: number, seconds: number, seed: number): NavSimResult {
  const rt = prepareMap(map, b);
  const nav = rt.nav!;
  const tun = navTuning(b);
  const n: BotNavEnv = { nav, pathCache: new PathCache(tun.pathCacheSize), navBudget: new NavBudget(tun.maxPathsPerTick) };
  const rng = createRng(seed);
  const main: number[] = [];
  for (let i = 0; i < nav.nodeCount; i++) if (isReachableNode(nav, i)) main.push(i);
  const plats = plateauNodes(nav);
  const pick = (): Vec3 =>
    plats.length > 0 && rng.next() < 0.35 ? nodePos(nav, plats[Math.floor(rng.next() * plats.length)]!) : nodePos(nav, main[Math.floor(rng.next() * main.length)]!);
  const status = { alive: true, healing: false, reloading: false, held: 'fists' as const, swapping: false, fireSlowed: false };
  const bots = Array.from({ length: nBots }, () => {
    let start = pick();
    while (start.y > 0.5) start = pick();
    return { move: { ...createMovementState(start) }, f: createNavFollow(), goal: pick(), hist: [] as { x: number; y: number; z: number }[], yaw: 0 };
  });
  let stuck = 0;
  let samples = 0;
  let arrivals = 0;
  let plateauArrivals = 0;
  const ticks = Math.round(seconds / SIM_DT);
  const perSecond = Math.round(1 / SIM_DT);
  for (let t = 0; t < ticks; t++) {
    const now = t * SIM_DT * 1000;
    for (const bot of bots) {
      const pos = bot.move.pos;
      if (Math.hypot(pos.x - bot.goal.x, pos.z - bot.goal.z) < 1.5 && Math.abs(pos.y - bot.goal.y) < 1) {
        arrivals++;
        if (bot.goal.y > 1) plateauArrivals++;
        bot.goal = pick();
        bot.hist = [];
      }
      const r = navSteer(bot.f, pos, bot.move.grounded, bot.goal, n, now, b, rng);
      if (r.mx !== 0 || r.mz !== 0) bot.yaw = Math.atan2(-r.mx, -r.mz);
      const inp: PlayerInput = {
        seq: 0, dt: SIM_DT, moveForward: Math.hypot(r.mx, r.mz), moveRight: 0, yaw: bot.yaw, pitch: 0, sprint: true, fire: false,
        jump: r.jump, reload: false, interact: false, useHeal: false, selectSlot: -1, ads: false, stanceToggle: null,
      };
      bot.move = stepMovement(bot.move, toMovementInput(inp, status, b), SIM_DT, rt.ctx).state as typeof bot.move;
      if (t % perSecond === 0) {
        bot.hist.push({ ...bot.move.pos });
        if (bot.hist.length > 4) bot.hist.shift();
        if (bot.hist.length === 4) {
          samples++;
          const a = bot.hist[0]!;
          const c = bot.hist[3]!;
          if (Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) < 1) stuck++;
        }
      }
    }
  }
  return { stuckRate: samples > 0 ? stuck / samples : 0, arrivals, plateauArrivals, botSeconds: nBots * seconds, samples, stuck };
}

function createMovementState(p: Vec3): ReturnType<typeof stepMovement>['state'] {
  return {
    pos: { ...p },
    vel: { x: 0, y: 0, z: 0 },
    grounded: true,
    dropping: false,
    stance: 'stand',
    stanceFrom: 'stand',
    stanceMs: 0,
    adsMs: 0,
    dropPhase: null,
    dropMs: 0,
  } as ReturnType<typeof stepMovement>['state'];
}


/** Per-seed result of a nav walk on a layout. */
export interface LayoutNavStuck extends NavSimResult {
  layoutSeed: number;
}

/**
 * LV14: the nav walk on the layout-applied office of each seed (walk RNG seed = `walkSeed`). One call per layout seed;
 * a 30-seed CI version: `navStuckForLayoutSeeds(OFFICE, balanceForMap(BALANCE, 'office'), seeds, 12, 60)` and assert
 * the pooled rate < 2 % and every seed <= 5 %.
 */
export function navStuckForLayoutSeeds(
  base: IndoorMapData,
  b: Balance,
  layoutSeeds: readonly number[],
  nBots = 12,
  seconds = 180,
  walkSeed = 1,
  build: (base: IndoorMapData, seed: number) => IndoorMapData = layoutOffice,
): { pooledRate: number; worst: LayoutNavStuck; perSeed: LayoutNavStuck[] } {
  const perSeed: LayoutNavStuck[] = [];
  let stuck = 0;
  let samples = 0;
  for (const seed of layoutSeeds) {
    const r = simulateNav(build(base, seed), b, nBots, seconds, walkSeed);
    perSeed.push({ ...r, layoutSeed: seed });
    stuck += r.stuck;
    samples += r.samples;
  }
  const worst = perSeed.reduce((w, r) => (r.stuckRate > w.stuckRate ? r : w), perSeed[0]!);
  return { pooledRate: samples > 0 ? stuck / samples : 0, worst, perSeed };
}
