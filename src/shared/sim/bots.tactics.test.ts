/**
 * Bot tactics (GDD 10 "Tactics", balance bots.tactics): cover, range plan, smart reloads, push, pre-aim, investigate,
 * hit juke. Seeded World tests on a flat island plus pure checks of findCover / planFightRange.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../balance';
import { BALANCE, validateBalance } from '../balance';
import { SIM_DT } from '../constants';
import { wrapAngle } from '../math';
import type { PropPlacement, SimEvent } from '../types';
import { MAPS } from '../../game/levels/index';
import { BOT_TACTICS_AI, type BotEnv, botFireRange, createBotBrain, findCover, planFightRange } from './bots';
import { lineOfSight } from './colliders';
import { prepareMap } from './movement';
import { eyePoint } from './stance';
import type { SimPlayer } from './state';
import { flatMap, land, noSpreadBalance, run } from './testkit';
import { createDebugWorld, type DebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const ticks = (ms: number): number => Math.ceil(ms / (SIM_DT * 1000));
const rock = (x: number, z: number): PropPlacement => ({ kind: 'rock', x, z, rotY: 0, scale: 1 });
const crate = (x: number, z: number): PropPlacement => ({ kind: 'crate', x, z, rotY: 0, scale: 1 });
const palm = (x: number, z: number): PropPlacement => ({ kind: 'palm', x, z, rotY: 0, scale: 1 });
const hut = (x: number, z: number, rotY = 0): PropPlacement => ({ kind: 'hut', x, z, rotY, scale: 1 });

/** One human, the bot under test (balanced, past its loot phase) and a second bot parked far away. */
function botWorld(props: PropPlacement[] = [], patch?: (b: Balance) => void) {
  const balance = noSpreadBalance((x) => {
    x.match.minHumansToStart = 1;
    x.match.targetPlayers = 3;
    x.match.countdownSeconds = 0;
    x.match.spawnJitter = 0;
    x.match.endWhenNoHumansAlive = false;
    x.loot.spawnChance = 0;
    x.bots.lootPhaseSeconds = 0;
    x.bots.eagernessRampSeconds = 0;
    patch?.(x);
  });
  const w = createDebugWorld({ map: flatMap({ islandRadius: 300, worldRadius: 330 }, props), balance, seed: 5, botNames: ['B'], drop: false });
  const human = w.addPlayer('H')!;
  for (let i = 0; i < 5 && w.getMatch().phase !== 'playing'; i++) w.step(SIM_DT);
  const others = [human + 1, human + 2].map((id) => w.debugPlayer(id)!);
  land(w, human, 100, 100);
  land(w, others[1]!.id, -150, -150);
  const bot = others[0]!;
  bot.brain = createBotBrain(w.timeMs, 0, 'balanced');
  bot.brain.landedAt = 0;
  const hp = w.debugPlayer(human)!;
  hp.hp = 1e6;
  return { w, human, hp, bot, b: balance };
}

function arm(p: SimPlayer, slot: 0 | 1, weapon: 'rifle' | 'smg' | 'pistol' | 'shotgun' | 'sniper', mag: number, active = true): void {
  p.inv.slots[slot] = { weapon, mag, level: 1, scope: null };
  const ammo = weapon === 'rifle' ? 'ammo_heavy' : weapon === 'shotgun' ? 'ammo_shell' : weapon === 'sniper' ? 'ammo_sniper' : 'ammo_light';
  p.inv.ammo[ammo] = 100;
  if (active) {
    p.inv.activeSlot = slot;
    p.swapRemainingMs = 0;
  }
}

/** Can `from` see the top of `to`'s head (static colliders)? */
function sees(w: DebugWorld, from: SimPlayer, to: SimPlayer, b: Balance): boolean {
  const ctx = w.debugContext();
  const head = { x: to.move.pos.x, y: to.move.pos.y + b.player.height * 0.9, z: to.move.pos.z };
  return lineOfSight(ctx.colliders, ctx.map, eyePoint(from.move.pos, from.move, b), head);
}

const flat = (p: SimPlayer, q: SimPlayer): number => Math.hypot(p.move.pos.x - q.move.pos.x, p.move.pos.z - q.move.pos.z);

function envOf(w: DebugWorld, players: SimPlayer[]): BotEnv {
  const ctx = w.debugContext();
  return { now: w.timeMs, balance: ctx.balance, map: ctx.map, ctx, players, loot: [], zone: null, recentShots: [] };
}

describe('findCover (GDD 10 "Cover")', () => {
  it('picks the spot behind a rock on the far side from the threat; hidden standing', () => {
    const { w, bot, hp, b } = botWorld([rock(0, -5)]);
    land(w, bot.id, 3, 0);
    land(w, hp.id, 0, -25);
    const spot = findCover(bot, eyePoint(hp.move.pos, hp.move, b), envOf(w, [bot, hp]), 99)!;
    expect(spot).not.toBeNull();
    expect(spot.crouch).toBe(false);
    // Directly behind the rock as seen from the threat: rock radius + player radius + clearance past its centre.
    expect(spot.pos.x).toBeCloseTo(0, 6);
    expect(spot.pos.z).toBeCloseTo(-5 + 1.4 + b.player.radius + BOT_TACTICS_AI.coverClearance, 6);
  });

  it('a crate only hides a crouched player; a palm trunk is too thin; open ground has no cover', () => {
    const c = botWorld([crate(0, -5)]);
    land(c.w, c.bot.id, 2, 0);
    land(c.w, c.hp.id, 0, -25);
    const eye = eyePoint(c.hp.move.pos, c.hp.move, c.b);
    expect(findCover(c.bot, eye, envOf(c.w, [c.bot, c.hp]), 99)?.crouch).toBe(true);
    const p = botWorld([palm(0, -5)]);
    land(p.w, p.bot.id, 2, 0);
    land(p.w, p.hp.id, 0, -25);
    expect(findCover(p.bot, eyePoint(p.hp.move.pos, p.hp.move, p.b), envOf(p.w, [p.bot, p.hp]), 99)).toBeNull();
    const o = botWorld();
    land(o.w, o.bot.id, 2, 0);
    land(o.w, o.hp.id, 0, -25);
    expect(findCover(o.bot, eyePoint(o.hp.move.pos, o.hp.move, o.b), envOf(o.w, [o.bot, o.hp]), 99)).toBeNull();
  });

  it('around a rotated hut, every spot found is hidden from the threat and clear of the walls (seeded sweep)', () => {
    const { w, bot, hp, b } = botWorld([hut(0, 0, 0.6)]);
    let found = 0;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      land(w, hp.id, Math.cos(a) * 30, Math.sin(a) * 30);
      land(w, bot.id, Math.cos(a + 0.5) * 6, Math.sin(a + 0.5) * 6);
      const eye = eyePoint(hp.move.pos, hp.move, b);
      const spot = findCover(bot, eye, envOf(w, [bot, hp]), 99);
      if (!spot) continue;
      found++;
      const ctx = w.debugContext();
      const top = (spot.crouch ? b.movement.stances.crouch.height : b.player.height) * BOT_TACTICS_AI.coverHideFraction;
      expect(lineOfSight(ctx.colliders, ctx.map, eye, { x: spot.pos.x, y: spot.y + top, z: spot.pos.z })).toBe(false);
      // Outside the wall box (half 2.05 m) by at least the player radius.
      const lx = spot.pos.x * Math.cos(0.6) - spot.pos.z * Math.sin(0.6);
      const lz = spot.pos.x * Math.sin(0.6) + spot.pos.z * Math.cos(0.6);
      expect(Math.max(Math.abs(lx), Math.abs(lz))).toBeGreaterThanOrEqual(2.05 + b.player.radius - 1e-6);
    }
    expect(found).toBeGreaterThanOrEqual(20);
  });

  it('respects the search radius and coverMaxCandidates = 0 disables cover', () => {
    const { w, bot, hp, b } = botWorld([rock(0, -10)]);
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -40);
    const eye = eyePoint(hp.move.pos, hp.move, b);
    expect(findCover(bot, eye, envOf(w, [bot, hp]), 99)).not.toBeNull();
    expect(findCover(bot, eye, envOf(w, [bot, hp]), 6)).toBeNull();
    // Beyond bots.tactics.coverSearchRadius whatever the caller allows.
    land(w, bot.id, 0, 10 + b.bots.tactics.coverSearchRadius);
    expect(findCover(bot, eye, envOf(w, [bot, hp]), 99)).toBeNull();
    const off = { ...envOf(w, [bot, hp]), balance: { ...b, bots: { ...b.bots, tactics: { ...b.bots.tactics, coverMaxCandidates: 0 } } } };
    expect(findCover(bot, eye, off, 99)).toBeNull();
  });
});

describe('planFightRange (GDD 10 "Range plan")', () => {
  it('backs a rifle off a shotgun, closes a shotgun in on a rifle, keeps mirror matches, ignores an rpg', () => {
    const { bot, hp, b } = botWorld();
    arm(bot, 0, 'rifle', 25);
    arm(hp, 0, 'shotgun', 5);
    expect(planFightRange(bot, hp, 5, b)!).toBeGreaterThan(9);
    arm(bot, 0, 'shotgun', 5);
    arm(hp, 0, 'rifle', 25);
    expect(planFightRange(bot, hp, 25, b)!).toBeLessThan(10);
    arm(bot, 0, 'rifle', 25);
    expect(planFightRange(bot, hp, 5, b)).toBeNull();
    expect(planFightRange(bot, hp, 25, b)).toBeNull();
    hp.inv.slots[0] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
    expect(planFightRange(bot, hp, 25, b)).toBeNull();
  });

  it('never plans beyond the bot fire range or 3/4 of its sight', () => {
    const { bot, hp, b } = botWorld();
    arm(bot, 0, 'sniper', 5);
    arm(hp, 0, 'smg', 30);
    const r = planFightRange(bot, hp, 10, b)!;
    expect(r).toBeGreaterThan(10);
    expect(r).toBeLessThanOrEqual(b.bots.ads.scopedVisionRange! * BOT_TACTICS_AI.rangeVisionFraction);
    arm(bot, 0, 'pistol', 12);
    arm(hp, 0, 'rifle', 25);
    expect(planFightRange(bot, hp, 40, b)!).toBeLessThanOrEqual(botFireRange('pistol', b));
  });

  it('an SMG bot backs away from a shotgun at 4 m in the World (the M1 rule only strafed there)', () => {
    const { w, bot, hp } = botWorld();
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -4);
    bot.yaw = 0;
    arm(bot, 0, 'smg', 30);
    arm(hp, 0, 'shotgun', 5);
    run(w, ticks(2500));
    expect(flat(bot, hp)).toBeGreaterThan(6.5);
  });
});

describe('cover in the World', () => {
  it('a hurt bot breaks off to the far side of a rock, pre-aims the threat there and heals hidden', () => {
    const { w, bot, hp, b } = botWorld([rock(0, 4)]);
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -20);
    bot.yaw = 0;
    arm(bot, 0, 'rifle', 25);
    arm(hp, 0, 'rifle', 25);
    bot.hp = BALANCE.bots.personalities!.balanced!.retreatBelowHp! - 10; // below the Retreat threshold
    bot.inv.heals.bandage = 3;
    let healedHidden = false;
    for (let i = 0; i < ticks(8000) && !healedHidden; i++) {
      w.step(SIM_DT);
      healedHidden = !!bot.heal && !sees(w, hp, bot, b);
    }
    expect(healedHidden).toBe(true);
    // Still hidden and healing half a second later, turned toward where the threat was (ready to peek).
    run(w, ticks(500));
    expect(!!bot.heal && !sees(w, hp, bot, b)).toBe(true);
    const want = Math.atan2(-(hp.move.pos.x - bot.move.pos.x), -(hp.move.pos.z - bot.move.pos.z));
    expect(Math.abs(wrapAngle(bot.yaw - want))).toBeLessThan(0.45);
    expect(bot.brain!.cover?.reason).toBe('heal');
    expect(Math.hypot(bot.move.pos.x, bot.move.pos.z - (4 + 1.4 + b.player.radius))).toBeLessThan(1.5);
  });

  it('a reloading bot walks to cover it can reach before the reload ends', () => {
    const { w, bot, hp, b } = botWorld([rock(0, 4)]);
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -15);
    bot.yaw = 0;
    arm(bot, 0, 'rifle', 0);
    arm(hp, 0, 'rifle', 25);
    const ms = b.weapons.rifle.reloadMs;
    bot.reload = { slot: 0, weapon: 'rifle', remainingMs: ms, totalMs: ms };
    let hiddenWhileReloading = false;
    for (let i = 0; i < ticks(ms); i++) {
      w.step(SIM_DT);
      if (bot.reload && !sees(w, hp, bot, b)) hiddenWhileReloading = true;
    }
    expect(bot.brain!.cover === null || bot.brain!.cover.reason === 'reload').toBe(true);
    expect(hiddenWhileReloading).toBe(true);
  });

  it('shot from beyond its fire range, a pistol bot breaks line of sight instead of charging across the open', () => {
    const { w, bot, hp, b } = botWorld([rock(-3, 3)]);
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -40);
    bot.yaw = 0;
    arm(bot, 0, 'pistol', 12);
    arm(hp, 0, 'sniper', 5);
    expect(botFireRange('pistol', b)).toBeLessThan(40);
    const aim = () => {
      const dx = bot.move.pos.x - hp.move.pos.x;
      const dz = bot.move.pos.z - hp.move.pos.z;
      return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(b.player.height * 0.5 - b.player.eyeHeight, Math.hypot(dx, dz)) };
    };
    run(w, 1, { [hp.id]: () => ({ fire: true, ...aim() }) });
    expect(bot.lastDamagedBy?.id).toBe(hp.id);
    let hidden = false;
    for (let i = 0; i < ticks(3000) && !hidden; i++) {
      w.step(SIM_DT);
      hidden = !sees(w, hp, bot, b);
    }
    expect(hidden).toBe(true);
    expect(bot.brain!.cover?.reason).toBe('underFire');
  });

  it('at most coverSearchesPerTick cover searches run per tick in a full island match', () => {
    const map = MAPS['island01']!;
    const b = JSON.parse(JSON.stringify(BALANCE)) as Balance;
    b.match.endWhenNoHumansAlive = false;
    const w = createDebugWorld({ map, balance: b, seed: 11, botNames: Array.from({ length: 24 }, (_, i) => `B${i}`), runtime: prepareMap(map, b) });
    w.addPlayer('H');
    let searches = 0;
    for (let i = 0; i < ticks(420_000); i++) {
      w.step(SIM_DT);
      let n = 0;
      for (let id = 0; id < 40; id++) if (w.debugPlayer(id)?.brain?.coverSearchAt === w.timeMs) n++;
      expect(n).toBeLessThanOrEqual(BOT_TACTICS_AI.coverSearchesPerTick);
      searches += n;
      if (w.getMatch().phase !== 'playing' && i > ticks(60_000)) break;
    }
    expect(searches).toBeGreaterThan(0);
  });
});

describe('smart reloads (GDD 10 "Reloads")', () => {
  it('an empty SMG with a loaded pistol and an enemy at 8 m: swaps instead of finishing the reload; at 30 m it reloads', () => {
    for (const [dist, swaps] of [[8, true], [30, false]] as const) {
      const { w, bot, hp } = botWorld();
      land(w, bot.id, 0, 0);
      land(w, hp.id, 0, -dist);
      bot.yaw = 0;
      arm(bot, 1, 'pistol', 12, false);
      arm(bot, 0, 'smg', 0);
      const ms = w.debugContext().balance.weapons.smg.reloadMs;
      bot.reload = { slot: 0, weapon: 'smg', remainingMs: ms, totalMs: ms };
      const ev = run(w, ticks(600));
      expect(ofType(ev, 'weaponSwitch').some((e) => e.playerId === bot.id && e.slot === 1)).toBe(swaps);
    }
  });

  it('with the target out of sight behind a hut, a bot reloads a part-empty mag (not above hiddenReloadFraction)', () => {
    for (const [mag, reloads] of [[8, true], [24, false]] as const) {
      const { w, bot, hp, b } = botWorld([hut(0, -12)]);
      land(w, bot.id, 0, 0);
      land(w, hp.id, 0, -20);
      bot.yaw = 0;
      arm(bot, 0, 'rifle', mag);
      expect(mag < b.weapons.rifle.magSize * b.bots.tactics.hiddenReloadFraction).toBe(reloads);
      const br = bot.brain!;
      br.targetId = hp.id;
      br.lastSeenPos = { x: -4, z: -12 };
      br.lastSeenY = hp.move.pos.y;
      br.lastSeenAt = w.timeMs;
      expect(sees(w, bot, hp, b)).toBe(false);
      const ev = run(w, ticks(600));
      expect(ofType(ev, 'reloadStart').length > 0).toBe(reloads);
      // Out of sight it pre-aims the last known chest.
      if (reloads) expect(br.preAim).not.toBeNull();
    }
  });

  it('between fights a bot tops up its second gun', () => {
    const { w, bot } = botWorld();
    land(w, bot.id, 0, 0);
    arm(bot, 1, 'pistol', 2, false);
    arm(bot, 0, 'rifle', 25);
    const ev = run(w, ticks(2000));
    expect(ofType(ev, 'weaponSwitch').some((e) => e.playerId === bot.id && e.slot === 1)).toBe(true);
    expect(ofType(ev, 'reloadStart').some((e) => e.weapon === 'pistol')).toBe(true);
  });
});

describe('pressure and evasion', () => {
  it('pushes a visible enemy who is healing into full-damage range; holds range against one who is not', () => {
    const moved: number[] = [];
    for (const healing of [true, false]) {
      const { w, bot, hp } = botWorld();
      land(w, bot.id, 0, 0);
      land(w, hp.id, 0, -30);
      bot.yaw = 0;
      arm(bot, 0, 'rifle', 25);
      arm(hp, 0, 'rifle', 25);
      if (healing) hp.heal = { item: 'medkit', remainingMs: 1e6, totalMs: 1e6 };
      run(w, ticks(2000));
      moved.push(30 - flat(bot, hp));
    }
    expect(moved[0]!).toBeGreaterThan(4);
    expect(moved[1]!).toBeLessThan(2);
  });

  it('chases at a sprint a target that broke sight right after the bot hit it', () => {
    const { w, bot, hp, b } = botWorld([hut(0, -12)]);
    land(w, bot.id, 0, 0);
    land(w, hp.id, 0, -20);
    arm(bot, 0, 'rifle', 25);
    const br = bot.brain!;
    br.targetId = hp.id;
    br.lastSeenPos = { x: -4, z: -12 };
    br.lastSeenY = hp.move.pos.y;
    br.lastSeenAt = w.timeMs;
    hp.lastDamagedBy = { id: bot.id, at: w.timeMs };
    w.step(SIM_DT);
    expect(br.sprint).toBe(true);
    hp.lastDamagedBy = { id: bot.id, at: w.timeMs - b.bots.tactics.pushWindowMs - 1 };
    br.nextDecisionAt = w.timeMs;
    w.step(SIM_DT);
    expect(br.sprint).toBe(false);
  });

  it('flips its strafe when hit while fighting (hitJukeChance 1; 0 = never)', () => {
    for (const chance of [1, 0]) {
      const { w, bot, hp } = botWorld([], (x) => (x.bots.tactics.hitJukeChance = chance));
      land(w, bot.id, 0, 0);
      land(w, hp.id, 0, -15);
      bot.yaw = 0;
      arm(bot, 0, 'rifle', 25);
      run(w, ticks(300));
      expect(bot.brain!.targetVisible).toBe(true);
      const br = bot.brain!;
      br.nextStrafeAt = w.timeMs + 1e6;
      const dir = br.strafeDir;
      bot.lastHurtAt = w.timeMs;
      run(w, ticks(300));
      expect(br.strafeDir === -dir).toBe(chance === 1);
    }
  });
});

describe('investigating gunfire', () => {
  it('an eager bot with nothing to loot walks toward a heard fight and stops at its standoff; investigateChance 0 stays', () => {
    const end: number[] = [];
    for (const chance of [1, 0]) {
      const { w, bot, hp } = botWorld([], (x) => {
        x.bots.personalities = { ...x.bots.personalities, balanced: { ...x.bots.personalities!.balanced, investigateChance: chance } };
      });
      land(w, bot.id, 0, 0);
      land(w, hp.id, 0, -43);
      bot.yaw = Math.PI; // facing away (+Z): the human is heard, not seen
      arm(bot, 0, 'pistol', 12);
      arm(hp, 0, 'pistol', 12);
      // Every 9 ticks: World keeps recentShots for one decision interval (250 ms) but bots decide every 8 ticks, so a
      // shot in a bot's decision tick is never heard; a cadence of exactly 8 ticks would alias with that forever.
      run(w, ticks(6000), { [hp.id]: (i) => ({ fire: i % 9 === 0, pitch: 1.2, yaw: Math.PI / 2 }) });
      end.push(flat(bot, hp));
    }
    expect(end[0]!).toBeLessThan(30);
    expect(end[1]!).toBeGreaterThan(30);
  });
});

describe('balance.bots.tactics validation', () => {
  it('is required, and fractions must be in [0, 1]', () => {
    const clone = (): Record<string, any> => JSON.parse(JSON.stringify(BALANCE));
    expect(() => validateBalance(clone())).not.toThrow();
    const missing = clone();
    delete missing['bots'].tactics;
    expect(() => validateBalance(missing)).toThrow(/bots\.tactics/);
    const bad = clone();
    bad['bots'].tactics.hiddenReloadFraction = 1.5;
    expect(() => validateBalance(bad)).toThrow(/hiddenReloadFraction/);
    const bad2 = clone();
    bad2['bots'].personalities.balanced.investigateChance = 'x';
    expect(() => validateBalance(bad2)).toThrow(/investigateChance/);
  });
});
