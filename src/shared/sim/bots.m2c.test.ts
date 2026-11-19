/**
 * M2c bot behaviour (melee.md 13, rpg.md 13, smoke.md 5 and 12, scopes.md 11, levels.md 13), seeded World tests.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../balance';
import { SIM_DT } from '../constants';
import type { PropPlacement, SimEvent, SmokeCloudState } from '../types';
import { BALANCE, balanceForMap } from '../balance';
import { MAPS } from '../../game/levels/index';
import { createBotBrain } from './bots';
import { playMatch } from './tools/matchReport';
import { flatMap, land, noSpreadBalance } from './testkit';
import { createDebugWorld } from './World';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);

function botWorld(patch?: (b: Balance) => void, props: PropPlacement[] = []) {
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
  const bots = [human + 1, human + 2].map((id) => w.debugPlayer(id)!);
  land(w, human, 100, 100);
  land(w, bots[1]!.id, -150, -150);
  const bot = bots[0]!;
  bot.brain = createBotBrain(w.timeMs, 0, 'balanced');
  bot.brain.landedAt = 0;
  return { w, human, bot, balance, hp: w.debugPlayer(human)! };
}

const balanceOf = (w: ReturnType<typeof botWorld>['w']): Balance => (w.debugContext().balance as Balance);

function steps(w: ReturnType<typeof botWorld>['w'], n: number, until?: (ev: SimEvent[]) => boolean): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ev = w.step(SIM_DT);
    all.push(...ev);
    if (until?.(ev)) break;
  }
  return all;
}

describe('bots M2c', () => {
  it('melee 13: an unarmed bot with a machete and an enemy within 2 m lands a hit within reaction + hit frame (about 1 s)', () => {
    const { w, human, bot, hp } = botWorld();
    land(w, bot.id, 0, 0);
    land(w, human, 0, -1.8);
    hp.hp = 1e6;
    bot.inv.melee = { weapon: 'machete', level: 1 };
    bot.inv.activeSlot = 2;
    bot.yaw = 0;
    // bots.reactionMs (800) + the machete hit frame (200) + one decision interval of jitter.
    const budget = balanceOf(w).bots.reactionMs + 200 + balanceOf(w).bots.decisionIntervalMs;
    const ev = steps(w, Math.ceil(budget / (SIM_DT * 1000)));
    expect(ofType(ev, 'damage').some((d) => d.victimId === human && d.cause === 'melee' && d.weapon === 'machete')).toBe(true);
  });

  it('melee 13: an empty SMG mag and an enemy at 2 m: the bot switches to its knife instead of reloading', () => {
    const { w, human, bot, hp } = botWorld();
    land(w, bot.id, 0, 0);
    land(w, human, 0, -2);
    hp.hp = 1e6;
    bot.inv.melee = { weapon: 'knife', level: 1 };
    bot.inv.slots[0] = { weapon: 'smg', mag: 0, level: 1, scope: null };
    bot.inv.ammo.ammo_light = 60;
    bot.inv.activeSlot = 0;
    bot.yaw = 0;
    const ev = steps(w, 45);
    expect(ofType(ev, 'weaponSwitch').some((e) => e.playerId === bot.id && e.slot === 2 && e.weapon === 'knife')).toBe(true);
    expect(ofType(ev, 'reloadStart').filter((e) => e.playerId === bot.id)).toEqual([]);
  });

  it('rpg 13: a visible still target at 25 m: fires within a few decisions (chance 1); at 8 m never', () => {
    for (const [dist, fires] of [[25, true], [8, false]] as const) {
      const { w, human, bot } = botWorld((b) => {
        b.bots.rpg.fireChancePerDecision = 1;
        b.bots.personalities = { ...b.bots.personalities, balanced: { ...b.bots.personalities!.balanced!, grenadeChanceMultiplier: 1 } };
      });
      land(w, bot.id, 0, 0);
      land(w, human, 0, -dist);
      bot.inv.slots[0] = { weapon: 'rifle', mag: 25, level: 1, scope: null };
      bot.inv.slots[1] = { weapon: 'rpg', mag: 1, level: 1, scope: null };
      bot.inv.ammo.ammo_heavy = 50;
      bot.inv.activeSlot = 0;
      bot.yaw = 0;
      w.debugPlayer(human)!.hp = 1e6;
      const ev = steps(w, 120);
      expect(ofType(ev, 'rocketFired').filter((e) => e.ownerId === bot.id).length > 0).toBe(fires);
    }
  });

  it('smoke 12: a bot entering Retreat with a smoke throws toward its attacker; the cloud deploys near the 4 m point', () => {
    const { w, human, bot } = botWorld((b) => {
      b.bots.smoke.retreatThrowChance = 1;
      b.bots.personalities = { ...b.bots.personalities, balanced: { ...b.bots.personalities!.balanced!, smokeChanceMultiplier: 1 } };
    });
    land(w, bot.id, 0, 0);
    land(w, human, 0, -20);
    w.debugPlayer(human)!.hp = 1e6;
    bot.hp = 30;
    bot.inv.heals.bandage = 2;
    bot.inv.smokes = 1;
    bot.inv.slots[0] = { weapon: 'rifle', mag: 25, level: 1, scope: null };
    bot.inv.activeSlot = 0;
    bot.lastDamagedBy = { id: human, at: w.timeMs };
    bot.yaw = 0;
    const ev = steps(w, 150, (e) => ofType(e, 'smokeDeployed').length > 0);
    const thrown = ofType(ev, 'grenadeThrown').find((e) => e.ownerId === bot.id && e.kind === 'smoke');
    expect(thrown).toBeDefined();
    const dep = ofType(ev, 'smokeDeployed')[0]!;
    // The 4 m point from where the bot was when it planned, toward the attacker (-Z).
    expect(Math.hypot(dep.pos.x - 0, dep.pos.z - -4)).toBeLessThan(3 + 2);
  });

  it('smoke 5: a holding cloud between bot and target hides it; a cloud 7 m off the line does not', () => {
    for (const [off, visible] of [[0, false], [7, true]] as const) {
      const { w, human, bot } = botWorld();
      land(w, bot.id, 0, 0);
      land(w, human, 0, -20);
      bot.inv.slots[0] = { weapon: 'rifle', mag: 25, level: 1, scope: null };
      bot.inv.activeSlot = 0;
      bot.yaw = 0;
      const cloud: SmokeCloudState = { id: 999, ownerId: human, pos: { x: off, y: 2, z: -10 }, deployedAt: w.timeMs - 5000, fadeAt: w.timeMs + 60_000 };
      (w.debugClouds() as SmokeCloudState[]).push(cloud);
      steps(w, 3);
      expect(bot.brain!.targetVisible).toBe(visible);
    }
  });

  it('scopes 11: a bot with a rifle walks to a nearby 4x and mounts it; a scope that would only go to the pouch is ignored', () => {
    const { w, bot } = botWorld();
    land(w, bot.id, 0, 0);
    bot.inv.slots[0] = { weapon: 'rifle', mag: 25, level: 1, scope: null };
    bot.inv.activeSlot = 0;
    w.debugLoot().push({ id: 501, item: 'scope_4x', qty: 1, mag: null, pos: { x: 6, y: 2, z: 0 }, tier: 'rare', durability: null });
    w.debugLoot().push({ id: 502, item: 'scope_8x', qty: 1, mag: null, pos: { x: -4, y: 2, z: 0 }, tier: 'epic', durability: null });
    steps(w, 200);
    expect(bot.inv.slots[0]!.scope).toBe('scope_4x');
    expect(bot.inv.spareScope).toBeNull();
    expect(w.debugLoot().some((l) => l.id === 502)).toBe(true);
  });

  it('levels 13: a bot carrying an L1 rifle takes an L2 rifle nearby', () => {
    const { w, bot } = botWorld();
    land(w, bot.id, 0, 0);
    bot.inv.slots[0] = { weapon: 'rifle', mag: 25, level: 1, scope: null };
    bot.inv.slots[1] = { weapon: 'smg', mag: 30, level: 1, scope: null };
    bot.inv.activeSlot = 0;
    w.debugLoot().push({ id: 503, item: 'rifle', qty: 1, mag: 25, pos: { x: 8, y: 2, z: 3 }, tier: 'rare', durability: null, level: 2 });
    steps(w, 200);
    expect(bot.inv.slots.find((s) => s?.weapon === 'rifle')).toMatchObject({ level: 2 });
  });
});

describe('in-match stuck (zone urgency hysteresis, M2c follow-up)', () => {
  it('office bots do not shuttle between loot and the tide goal: in-match stuck < 5% over 3 matches (was ~10%)', () => {
    const office = MAPS['office']!;
    const b = balanceForMap(BALANCE, 'office');
    let stuck = 0;
    let samples = 0;
    for (const seed of [1, 2, 3]) {
      const r = playMatch(b, seed, 'idle', null, false, office);
      stuck += r.stuck.stuck;
      samples += r.stuck.samples;
    }
    expect(samples).toBeGreaterThan(300);
    expect(stuck / samples).toBeLessThan(0.05);
  }, 120_000);
});
