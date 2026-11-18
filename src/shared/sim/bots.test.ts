import { describe, expect, it, vi } from 'vitest';
import type { Balance } from '../balance';
import { BALANCE, balanceForMap } from '../balance';
import { OFFICE } from '../../game/levels/office';
import { SIM_DT } from '../constants';
import { carrierPosAt } from '../maps';
import { createRng } from '../math';
import type { AnyMapData, BotPersonalityId, DropRoute, IndoorMapData, PlayerInput, Vec3 } from '../types';
import {
  assignBotDrops,
  botDropTuning,
  botTuning,
  createBotBrain,
  createNavFollow,
  dropReach,
  maxDropReach,
  navSteer,
  solveThrow,
  solveThrowPitch,
  ThrowSearch,
  type BotNavEnv,
} from './bots';
import { predictGrenadeArc, throwLaunch } from './grenade';
import { createMovementContext, prepareMap, stepMovement, toMovementInput, type MovementContext } from './movement';
import { isReachableNode, NavBudget, nodePos, navTuning, PathCache, plateauNodes } from './nav';
import { miniOffice, officeLikeBalance, roomsMaze } from './navTestkit';
import type { SimPlayer } from './state';
import { flatMap } from './testkit';
import { createDebugWorld } from './World';

/** maps.md §3 office drop overrides (until balance.json has the maps block), with a window that fits the fixtures. */
function officeDropBalance(patch?: (b: Balance) => void): Balance {
  return officeLikeBalance((b) => {
    Object.assign(b.drop, {
      carrierAltitude: 25,
      carrierSpeed: 12,
      noJumpMs: 1500,
      routeEntryMargin: 0,
      ejectInset: 15,
      minJumpWindowMetres: 40,
      freefallSpeed: 15,
      freefallSteerSpeed: 10,
      chuteDeployHeight: 10,
    });
    patch?.(b);
  });
}

describe('drop reach (drop.md "Reach and time")', () => {
  it('matches the island and office tables', () => {
    expect(dropReach(120, 2, 2, BALANCE)).toBeCloseTo(81.4, 1);
    expect(maxDropReach(120, 2, 2, BALANCE)).toBeCloseTo(122.9, 1);
    const ob = officeDropBalance();
    expect(dropReach(25, 0, 0, ob)).toBeCloseTo(21.25, 2);
    expect(maxDropReach(25, 0, 0, ob)).toBeCloseTo(24.69, 1);
    // Landing on a desk top (6.66): the parachute phase is shorter.
    expect(dropReach(25, 0, 6.66, ob)).toBeCloseTo(10 + (3.34 / 8) * 9, 2);
  });
});

/** A straight route across the play area along +X through z = 0 (office-like numbers). */
function routeAcross(map: IndoorMapData, b: Balance, startsAt = 0): DropRoute {
  const f = map.floor;
  const speed = b.drop.carrierSpeed;
  const entry = { x: f.minX, z: 0 };
  const exit = { x: f.maxX, z: 0 };
  const eject = { x: f.maxX - b.drop.ejectInset, z: 0 };
  const ms = (m: number): number => (m / speed) * 1000;
  return {
    mapId: map.id,
    entry,
    exit,
    eject,
    altitude: b.drop.carrierAltitude,
    speed,
    startsAt,
    noJumpUntil: startsAt + b.drop.noJumpMs,
    ejectAt: startsAt + ms(eject.x - entry.x),
    endsAt: startsAt + ms(exit.x - entry.x),
  };
}

function fakeBots(n: number, personalities: BotPersonalityId[]): SimPlayer[] {
  return Array.from({ length: n }, (_, i) => ({ id: 100 + i, brain: createBotBrain(0, 0, personalities[i % personalities.length]!) }) as unknown as SimPlayer);
}

/** A wide indoor field of loot spawns for distribution tests (fixture walls do not matter for picks). */
function lootField(): IndoorMapData {
  const map = miniOffice();
  map.lootSpawns = [];
  for (let x = -55; x <= 55; x += 10) {
    for (let z = -25; z <= 25; z += 10) map.lootSpawns.push({ x, z, tier: (x + z) % 30 === 0 ? 'epic' : (x + 55) % 20 === 0 ? 'rare' : 'common' });
  }
  return map;
}

describe('assignBotDrops (drop.md "Bots: jump choice")', () => {
  const b = officeDropBalance();
  const map = lootField();
  const route = routeAcross(map, b);

  it('is deterministic for a seed', () => {
    const a = fakeBots(11, ['aggressive', 'balanced', 'cautious']);
    const c = fakeBots(11, ['aggressive', 'balanced', 'cautious']);
    assignBotDrops(a, route, map, b, createRng(7));
    assignBotDrops(c, route, map, b, createRng(7));
    expect(a.map((p) => p.brain!.dropPlan)).toEqual(c.map((p) => p.brain!.dropPlan));
    const d = fakeBots(11, ['aggressive', 'balanced', 'cautious']);
    assignBotDrops(d, route, map, b, createRng(8));
    expect(d.map((p) => p.brain!.dropPlan)).not.toEqual(a.map((p) => p.brain!.dropPlan));
  });

  it('targets in-reach loot, spreads bots (at most maxBotsPerTarget per spread range) and jumps inside the window', () => {
    const dt = botDropTuning(b);
    const spread = botTuning(b).dropSpreadRange;
    for (let seed = 1; seed <= 200; seed++) {
      const bots = fakeBots(11, ['aggressive', 'balanced', 'cautious']);
      assignBotDrops(bots, route, map, b, createRng(seed));
      const plans = bots.map((p) => p.brain!.dropPlan!);
      plans.forEach((pl, i) => {
        expect(pl.jumpAt).toBeGreaterThanOrEqual(route.noJumpUntil);
        expect(pl.jumpAt).toBeLessThanOrEqual(route.ejectAt);
        expect(pl.spawn).toBeGreaterThanOrEqual(0);
        // The target stays reachable from the jump point (early-deploy reach x the safety fraction).
        const jp = carrierPosAt(route, pl.jumpAt);
        const d = Math.hypot(jp.x - pl.target.x, jp.z - pl.target.z);
        expect(d).toBeLessThanOrEqual(maxDropReach(route.altitude, 0, pl.target.y, b) * dt.reachSafetyFraction + 1e-6);
        // Picks never crowd: each earlier cluster within the spread range has fewer than maxBotsPerTarget picks.
        const earlier = plans.slice(0, i).filter((q) => Math.hypot(q.target.x - pl.target.x, q.target.z - pl.target.z) < spread);
        expect(earlier.length).toBeLessThan(dt.maxBotsPerTarget);
      });
    }
  });

  it('cautious bots jump later than aggressive bots on average, and favour epic loot less', () => {
    let agg = 0;
    let cau = 0;
    let aggEpic = 0;
    let cauEpic = 0;
    const N = 400;
    for (let seed = 1; seed <= N; seed++) {
      const a = fakeBots(1, ['aggressive']);
      const c = fakeBots(1, ['cautious']);
      assignBotDrops(a, route, map, b, createRng(seed));
      assignBotDrops(c, route, map, b, createRng(seed));
      agg += a[0]!.brain!.dropPlan!.jumpAt;
      cau += c[0]!.brain!.dropPlan!.jumpAt;
      if (map.lootSpawns[a[0]!.brain!.dropPlan!.spawn]!.tier === 'epic') aggEpic++;
      if (map.lootSpawns[c[0]!.brain!.dropPlan!.spawn]!.tier === 'epic') cauEpic++;
    }
    expect(cau / N - agg / N).toBeGreaterThan(1000);
    expect(aggEpic).toBeGreaterThan(cauEpic);
  });

  it('falls back to a random jump and the nearest spawn when nothing is in reach', () => {
    const far = miniOffice();
    far.lootSpawns = [{ x: 0, z: 29, tier: 'common' }];
    const narrow = officeDropBalance((x) => {
      x.drop.chuteDeployHeight = 0.5;
      x.drop.freefallSteerSpeed = 1;
      x.movement.dropSteerSpeed = 1;
    });
    const bots = fakeBots(3, ['balanced']);
    assignBotDrops(bots, routeAcross(far, narrow), far, narrow, createRng(3));
    for (const p of bots) {
      expect(p.brain!.dropPlan!.spawn).toBe(0);
      expect(p.brain!.dropPlan!.target).toEqual({ x: 0, y: 0, z: 29 });
    }
  });
});

/** Runs a carrier-drop World on `map` until every bot has landed; returns landing errors (m) per bot. */
function dropWorld(map: AnyMapData, b: Balance, seed: number): { errors: number[]; personalities: BotPersonalityId[]; landMs: number[] } {
  const balance = JSON.parse(JSON.stringify(b)) as Balance;
  balance.match.targetPlayers = 12;
  const w = createDebugWorld({
    map,
    balance,
    seed,
    botNames: Array.from({ length: 12 }, (_, i) => `B${i}`),
    matchStart: { countdownMs: 0, fillBots: true, matchId: 1 },
    runtime: prepareMap(map, balance),
    drop: true,
  });
  const landed = new Map<number, { x: number; z: number; at: number }>();
  const ids = new Set<number>();
  for (let t = 0; t < 30 * 90; t++) {
    w.step(SIM_DT);
    for (const s of w.snapshotFor(null).players) {
      const p = w.debugPlayer(s.id);
      if (!p || !p.isBot) continue;
      ids.add(p.id);
      if (!landed.has(p.id) && !p.aboard && !p.move.dropping && p.brain?.dropPlan) landed.set(p.id, { x: p.move.pos.x, z: p.move.pos.z, at: w.timeMs });
    }
    if (ids.size > 0 && landed.size === ids.size) break;
  }
  const errors: number[] = [];
  const personalities: BotPersonalityId[] = [];
  const landMs: number[] = [];
  const start = w.getMatch().route?.startsAt ?? 0;
  for (const id of ids) {
    const p = w.debugPlayer(id)!;
    const l = landed.get(id);
    if (!l) continue;
    const t = p.brain!.dropPlan!.target;
    errors.push(Math.hypot(l.x - t.x, l.z - t.z));
    personalities.push(p.brain!.personality);
    landMs.push(l.at - start);
  }
  return { errors, personalities, landMs };
}

describe('bot drops in a World (drop.md acceptance 12)', () => {
  it('> 80% of bots land within 10 m of their target (office-like)', () => {
    const b = officeDropBalance();
    const all: number[] = [];
    for (let seed = 1; seed <= 6; seed++) all.push(...dropWorld(lootField(), b, seed).errors);
    expect(all.length).toBeGreaterThan(50);
    const ok = all.filter((e) => e <= 10).length / all.length;
    expect(ok).toBeGreaterThan(0.8);
  }, 120_000);

  it('> 80% of bots land within 10 m of their target (island)', () => {
    const map = flatMap();
    map.lootSpawns = [];
    for (let x = -100; x <= 100; x += 20) for (let z = -100; z <= 100; z += 20) if (Math.hypot(x, z) < 150) map.lootSpawns.push({ x, z, tier: 'common' });
    const all: number[] = [];
    for (let seed = 1; seed <= 3; seed++) all.push(...dropWorld(map, BALANCE, seed).errors);
    expect(all.length).toBeGreaterThan(25);
    expect(all.filter((e) => e <= 10).length / all.length).toBeGreaterThan(0.8);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Path following (synthetic fixtures)
// ---------------------------------------------------------------------------------------------------------------

interface NavSimResult {
  stuckRate: number;
  arrivals: number;
  plateauArrivals: number;
  botSeconds: number;
}

/**
 * Bots walk between random reachable goals (a third on plateaus) on a fixture, driven by navSteer and the real
 * movement step. Stuck = no 1 m of progress over the last 3 s while it has a goal (maps.md acceptance 20).
 */
function simulateNav(map: IndoorMapData, b: Balance, nBots: number, seconds: number, seed: number): NavSimResult {
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
  return { stuckRate: samples > 0 ? stuck / samples : 0, arrivals, plateauArrivals, botSeconds: nBots * seconds };
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

describe('per-tick search budget (REVIEW-M2b M2)', () => {
  it('16 bots with fresh goals on one tick, and every tick of a match, run at most bots.nav.maxPathsPerTick searches', () => {
    const b = officeDropBalance();
    b.match.targetPlayers = 16;
    const map = miniOffice();
    const rt = prepareMap(map, b);
    const w = createDebugWorld({
      map,
      balance: b,
      seed: 4,
      botNames: Array.from({ length: 16 }, (_, i) => `B${i}`),
      matchStart: { countdownMs: 0, fillBots: true, matchId: 1 },
      runtime: rt,
      drop: true,
    });
    const searches = vi.spyOn(PathCache.prototype, 'set'); // one call per new A* search
    const limit = b.bots.nav.maxPathsPerTick;
    try {
      let maxPerTick = 0;
      let total = 0;
      const bots = (): SimPlayer[] =>
        w.snapshotFor(null).players.map((s) => w.debugPlayer(s.id)!).filter((p) => p.isBot && p.alive && !p.aboard && !p.move.dropping);
      let injectAt = -1;
      for (let t = 0; t < 30 * 90; t++) {
        const all = w.snapshotFor(null).players.map((s) => w.debugPlayer(s.id)!).filter((p) => p.isBot);
        if (injectAt < 0 && all.length > 0 && all.every((p) => !p.aboard && !p.move.dropping)) {
          injectAt = t;
          // Fresh, far goals for every landed bot on the same tick.
          const plats = plateauNodes(rt.nav!);
          bots().forEach((p, i) => {
            const q = nodePos(rt.nav!, plats[(i * 97) % plats.length]!);
            p.brain!.goal = { x: q.x, z: q.z };
            p.brain!.goalY = q.y;
            p.brain!.nextDecisionAt = Infinity;
            p.brain!.nav.replan = true;
            p.brain!.nav.path = null;
            Object.assign(p.brain!, { targetId: null, targetVisible: false, lootId: null, throwPlan: null, retreatUntil: 0, fleeUntil: 0, holdUntil: 0 });
          });
          expect(bots().length).toBeGreaterThanOrEqual(12);
        }
        const before = searches.mock.calls.length;
        w.step(SIM_DT);
        const n = searches.mock.calls.length - before;
        total += n;
        maxPerTick = Math.max(maxPerTick, n);
        if (t === injectAt) expect(n).toBeGreaterThan(0); // the budget is used, and only the budget (below)
        if (injectAt > 0 && t === injectAt + 30 * 4) {
          // Long searches spread over ticks (NAV_AI.maxExpansionsPerTick), but every fresh goal is planned within 4 s.
          for (const p of bots()) {
            if (p.brain!.nextDecisionAt !== Infinity) continue;
            expect(p.brain!.nav.path, `bot ${p.id} at ${JSON.stringify(p.move.pos)} unreachable=${p.brain!.nav.unreachable}`).not.toBeNull();
          }
        }
      }
      expect(injectAt).toBeGreaterThan(0);
      expect(maxPerTick).toBeLessThanOrEqual(limit);
      expect(total).toBeGreaterThan(100);
    } finally {
      searches.mockRestore();
    }
  }, 120_000);
});

describe('navSteer on synthetic indoor fixtures', () => {
  it('bots climb routes, reach plateaus and are stuck < 2% of the time (mini office)', () => {
    const r = simulateNav(miniOffice(), officeLikeBalance(), 12, 240, 11);
    expect(r.arrivals).toBeGreaterThan(60);
    expect(r.plateauArrivals).toBeGreaterThan(10);
    expect(r.stuckRate).toBeLessThan(0.02);
  }, 120_000);

  it('bots climb, reach plateaus and are stuck < 2% of the time on the real office', () => {
    // Deterministic (sim time only). Seeds 4 and 6 were the worst before the route-commit fix; seeds 1-10 now measure
    // 0.06-0.69%.
    for (const seed of [3, 4, 6]) {
      const r = simulateNav(OFFICE, balanceForMap(BALANCE, 'office'), 12, 180, seed);
      expect(r.arrivals).toBeGreaterThan(80);
      expect(r.plateauArrivals).toBeGreaterThan(30);
      expect(r.stuckRate).toBeLessThan(0.02);
    }
  }, 120_000);

  it('bots are stuck < 2% of the time in the rooms maze', () => {
    const r = simulateNav(roomsMaze(), officeLikeBalance(), 12, 180, 5);
    expect(r.arrivals).toBeGreaterThan(60);
    expect(r.stuckRate).toBeLessThan(0.02);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// REVIEW-M2a M3: grenade pitch solve timing
// ---------------------------------------------------------------------------------------------------------------

function solveTimes(ctx: MovementContext, eyeY: number, n: number): number[] {
  const rng = createRng(3);
  const times: number[] = [];
  for (let i = 0; i < n + 10; i++) {
    const yaw = rng.next() * Math.PI * 2;
    const d = 8 + rng.next() * 22;
    const eye = { x: 0, y: eyeY, z: 0 };
    const aim = { x: -Math.sin(yaw) * d, y: 0, z: -Math.cos(yaw) * d };
    const t0 = performance.now();
    solveThrowPitch(eye, yaw, aim, false, 1200, ctx);
    const dt = performance.now() - t0;
    if (i >= 10) times.push(dt); // warm-up
  }
  return times.sort((a, b) => a - b);
}

/** The M2a exhaustive search (39 full predicted arcs), as the accuracy reference. */
function referencePitch(eye: Vec3, yaw: number, aim: Vec3, cookMs: number, ctx: MovementContext): number {
  const g = ctx.balance.items.grenade;
  const fuse = Math.max(0, g.fuseMs - cookMs);
  const seconds = fuse / 1000 + 1 / ctx.balance.net.simHz;
  const miss = (deg: number): number => {
    const arc = predictGrenadeArc(throwLaunch(eye, yaw, (deg * Math.PI) / 180, false, ctx), fuse, ctx, seconds);
    return Math.hypot(arc.end.x - aim.x, arc.end.z - aim.z);
  };
  let best = g.throwPitchMinDeg;
  let bestMiss = Infinity;
  for (let deg = g.throwPitchMinDeg; deg <= g.throwPitchMaxDeg + 1e-9; deg += 2.5) {
    const m = miss(deg);
    if (m < bestMiss) [best, bestMiss] = [deg, m];
  }
  const c = best;
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const m = miss(c + k * 0.5);
    if (m < bestMiss) [best, bestMiss] = [c + k * 0.5, m];
  }
  return bestMiss;
}

function realMiss(eye: Vec3, yaw: number, aim: Vec3, pitch: number, cookMs: number, ctx: MovementContext): number {
  const g = ctx.balance.items.grenade;
  const fuse = Math.max(0, g.fuseMs - cookMs);
  const arc = predictGrenadeArc(throwLaunch(eye, yaw, pitch, false, ctx), fuse, ctx, fuse / 1000 + 1 / ctx.balance.net.simHz);
  return Math.hypot(arc.end.x - aim.x, arc.end.z - aim.z);
}

describe('solveThrowPitch (REVIEW-M2a M3)', () => {
  // Deterministic cost bounds (CI). One real arc is about 0.2-0.4 ms on the office, so these keep a solve and a
  // cook-time step under the 1 ms REVIEW-M2a M3 target without reading the clock.
  it('the first solve runs 1-3 real arcs (1-2 indoors, where the slope retry is skipped)', () => {
    const island = createMovementContext(flatMap(), BALANCE);
    const indoor = createMovementContext(miniOffice(), officeLikeBalance());
    const office = createMovementContext(OFFICE, balanceForMap(BALANCE, 'office'));
    for (const [ctx, eye, cap] of [
      [island, { x: 0, y: 3.05, z: 0 }, 3],
      [indoor, { x: 0, y: 1.05, z: 0 }, 2], // eye under a desk: the cover-heavy case
      [office, { x: 0, y: 1.05, z: 0 }, 2],
    ] as const) {
      const rng = createRng(3);
      for (let i = 0; i < 60; i++) {
        const yaw = rng.next() * Math.PI * 2;
        const d = 8 + rng.next() * 22;
        const aim = { x: eye.x - Math.sin(yaw) * d, y: 0, z: eye.z - Math.cos(yaw) * d };
        const r = solveThrow(eye, yaw, aim, false, 1200, ctx);
        expect(r.arcs).toBeGreaterThanOrEqual(1);
        expect(r.arcs).toBeLessThanOrEqual(cap);
      }
    }
  }, 120_000);

  it('a cook-time search step runs at most throwRefineArcsPerTick real arcs and completes the M2a grid', () => {
    const ctx = createMovementContext(miniOffice(), officeLikeBalance());
    const eye = { x: -20, y: 1.05, z: 18 };
    const aim = { x: -20, y: 0, z: -2 };
    const search = new ThrowSearch(eye, 0, aim, false, 1200, ctx, 0, Infinity);
    let steps = 0;
    while (!search.done) {
      const before = search.arcs;
      search.step(2);
      expect(search.arcs - before).toBeLessThanOrEqual(2);
      steps++;
    }
    const g = ctx.balance.items.grenade;
    expect(search.arcs).toBeGreaterThanOrEqual((g.throwPitchMaxDeg - g.throwPitchMinDeg) / 2.5);
    expect(steps).toBeLessThanOrEqual(25); // done well inside the 36-tick cook
  }, 120_000);

  // Wall-clock check of the same budgets (REVIEW-M2a M3 p95 < 1 ms); opt-in, since a loaded CI machine makes it noisy.
  it.runIf(process.env['PERF_TESTS'] === '1')('p95 < 1 ms for a first solve on the island and the office-like map (PERF_TESTS=1)', () => {
    const island = createMovementContext(flatMap(), BALANCE);
    const indoor = createMovementContext(miniOffice(), officeLikeBalance());
    for (const [ctx, y] of [[island, 3.05], [indoor, 1.05]] as const) {
      const t = solveTimes(ctx, y, 200);
      expect(t[Math.floor(t.length * 0.95)]!).toBeLessThan(1);
    }
  });

  it('lands about as close as the M2a exhaustive search (fast pick, then the cook-time search when it misses)', () => {
    const cases: [MovementContext, Vec3][] = [
      [createMovementContext(flatMap(), BALANCE), { x: 0, y: 3.05, z: 0 }],
      [createMovementContext(miniOffice(), officeLikeBalance()), { x: -20, y: 1.05, z: 18 }], // aisle, desks north
      [createMovementContext(OFFICE, balanceForMap(BALANCE, 'office')), { x: 0, y: 1.05, z: 0 }], // the real office
    ];
    for (const [ctx, eye] of cases) {
      const rng = createRng(9);
      let ok = 0;
      const N = 60;
      for (let i = 0; i < N; i++) {
        const yaw = rng.next() * Math.PI * 2;
        const d = 8 + rng.next() * 22;
        const aim = { x: eye.x - Math.sin(yaw) * d, y: ctx.map.kind === 'indoor' ? 0 : 2, z: eye.z - Math.cos(yaw) * d };
        const fast = solveThrowPitch(eye, yaw, aim, false, 1200, ctx);
        let mine = realMiss(eye, yaw, aim, fast, 1200, ctx);
        if (mine > 2) {
          const search = new ThrowSearch(eye, yaw, aim, false, 1200, ctx, (fast * 180) / Math.PI, mine);
          while (!search.step(2));
          mine = realMiss(eye, yaw, aim, (search.bestDeg * Math.PI) / 180, 1200, ctx);
        }
        if (mine <= referencePitch(eye, yaw, aim, 1200, ctx) + 1.5) ok++;
      }
      expect(ok / N).toBeGreaterThanOrEqual(0.95);
    }
  }, 120_000);
});
