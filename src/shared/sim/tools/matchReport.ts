/**
 * Headless pacing report (dev tool, not shipped). Simulates full matches at net.simHz with one scripted human plus
 * bots and prints pacing statistics.
 *
 *   npx tsx src/shared/sim/tools/matchReport.ts [--matches N] [--seed S] [--override '<json>'] [--players P]
 *                                               [--variant idle|looter|both] [--end-when-no-humans] [--json]
 *                                               [--map island01|office] [--layout-seed S | --layout-seeds N]
 *                                               [--m2c-pending]
 *
 * --override deep-merges a JSON object into balance.json (e.g. '{"bots":{"reactionMs":600}}'); arrays are replaced.
 * --map picks the level (default island01); the match uses balanceForMap(base + override, map) like the server.
 * M2c: --layout-seed S plays every match on the layout of seed S (0 = baseline; hex 0x... accepted); --layout-seeds N
 * cycles match m through layoutSeedFor(seed + (m mod N)), like the server's per-match pick. Without either, the base
 * map. The layout is built with buildMatchLayout(base, seed, { decor: false }) and applyLayout, as the server does.
 * --nav-walk SECONDS (MF1, LV14; indoor maps): instead of matches, the nav-walk stuck rate (navStuck.ts) on every layout
 *   seed of --layout-seed / --layout-seeds; --players = bots (default 12). Matches also print an in-match bot stuck line.
 * --m2c-pending previews balance merge step 2 (balance.json _m2cPending: the M2c loot tables and bots.eagernessCurve).
 * M2b: every match starts with the carrier drop. The idle human rides to the auto-eject; the looter jumps at a seeded
 * time in the jump window. "landing s" is the median time from the match start to landing over all participants.
 * By default the match keeps running after the human dies (match.endWhenNoHumansAlive = false) so match length
 * measures the bots' natural pacing; pass --end-when-no-humans to use the shipped rule.
 *
 * Human variants:
 *   idle   - lands and stands still forever.
 *   looter - walks between inland loot spawns inside the safe circle and picks things up; heals when hurt;
 *            never aims or fires; walks to the next circle centre when there is nothing left to loot.
 */
import type { Balance } from '../../balance';
import { BALANCE, balanceForMap, validateBalance } from '../../balance';
import { SIM_DT } from '../../constants';
import { createRng } from '../../math';
import { isIndoor } from '../../maps';
import type { AnyMapData, HeldId, PlayerInput, SimEvent } from '../../types';
import { isArmorId } from '../../types';
import { MAPS } from '../../../game/levels/index';
import { applyLayout, buildMatchLayout } from '../../../game/levels/layout/index';
import { layoutSeedFor, parseLayoutSeed } from '../../layout';
import balanceJson from '../../../../docs/design/balance.json';
import { navStuckForLayoutSeeds } from './navStuck';

/** Level by id (MAPS is AnyMapData; getMap is island-typed until the C-gate). */
function mapById(id: string): AnyMapData {
  const m = Object.prototype.hasOwnProperty.call(MAPS, id) ? MAPS[id] : undefined;
  if (!m) throw new Error(`unknown map "${id}" (known: ${Object.keys(MAPS).join(', ')})`);
  return m;
}
import { chooseHeal, isGun } from '../inventory';
import { prepareMap } from '../movement';
import { createDebugWorld, type DebugWorld } from '../World';

type Variant = 'idle' | 'looter';

interface Args {
  matches: number;
  seed: number;
  override: Record<string, unknown>;
  players: number | null;
  variants: Variant[];
  endWhenNoHumans: boolean;
  json: boolean;
  map: string;
  /** M2c: a pinned layout seed, or null. */
  layoutSeed: number | null;
  /** M2c: cycle through this many per-match layout seeds (0 = off). */
  layoutSeeds: number;
  m2cPending: boolean;
  /** MF1: run the nav walk (navStuck.ts) for this many seconds per layout seed instead of matches; 0 = off. */
  navWalk: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { matches: 10, seed: 1, override: {}, players: null, variants: ['idle', 'looter'], endWhenNoHumans: false, json: false, map: 'island01', layoutSeed: null, layoutSeeds: 0, m2cPending: false, navWalk: 0 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--matches':
        a.matches = Math.max(1, Number(v));
        i++;
        break;
      case '--seed':
        a.seed = Number(v);
        i++;
        break;
      case '--override':
        a.override = JSON.parse(v ?? '{}') as Record<string, unknown>;
        i++;
        break;
      case '--players':
        a.players = Number(v);
        i++;
        break;
      case '--variant':
        a.variants = v === 'both' ? ['idle', 'looter'] : [v as Variant];
        i++;
        break;
      case '--end-when-no-humans':
        a.endWhenNoHumans = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--map':
        a.map = v ?? 'island01';
        i++;
        break;
      case '--layout-seed': {
        const p = parseLayoutSeed(v);
        if (p === null) throw new Error(`invalid --layout-seed ${v}`);
        a.layoutSeed = p;
        i++;
        break;
      }
      case '--layout-seeds':
        a.layoutSeeds = Math.max(1, Math.floor(Number(v)));
        i++;
        break;
      case '--m2c-pending':
        a.m2cPending = true;
        break;
      case '--nav-walk':
        a.navWalk = Math.max(1, Number(v));
        i++;
        break;
      default:
        throw new Error(`unknown argument ${k}`);
    }
  }
  return a;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(base[k])) deepMerge(base[k] as Record<string, unknown>, v);
    else base[k] = v;
  }
}

export function balanceWithOverride(override: Record<string, unknown>): Balance {
  const b = JSON.parse(JSON.stringify(BALANCE)) as Record<string, unknown>;
  deepMerge(b, override);
  return validateBalance(b);
}

const BOT_NAMES = Array.from({ length: 32 }, (_, i) => `Bot ${i + 1}`);

export interface MatchResult {
  variant: Variant;
  seed: number;
  durationS: number;
  firstKillS: number | null;
  humanSurvivalS: number;
  humanCause: string;
  humanPlacement: number;
  humanPickups: number;
  phaseAtEnd: string;
  deathsByCause: Record<string, number>;
  killsByWeapon: Record<string, number>;
  aliveAtFinalPhase: number | null;
  aliveAtPhaseStart: (number | null)[];
  winnerIsHuman: boolean;
  /** M2a grenade pipeline: stacks spawned at match start, pickups, pin pulls, throws, swap/death drops, blasts, kills. */
  grenades: { spawned: number; pickups: number; cooks: number; thrown: number; dropped: number; explosions: number; kills: number };
  /** M2a: armor pickups by id, and stance transitions started (all players). */
  armorPickups: Record<string, number>;
  stanceChanges: number;
  /** M2b: seconds from the match start to landing, per participant that landed. */
  landingS: number[];
  /** M2c: layout seed of the match (null = base map). */
  layoutSeed: number | null;
  /** M2c: kills per weapon level ('L1'..'L4'; frags, fists, zone and fall excluded). */
  killsByLevel: Record<string, number>;
  /** M2c: rockets fired / duds, smoke clouds, glass panes broken, melee swings, scope mounts (auto + T). */
  m2c: { rockets: number; duds: number; smokes: number; glass: number; swings: number; scopeMounts: number };
  /** M2c: weapon pickups by level. */
  pickupsByLevel: Record<string, number>;
  /** MF1: in-match bot stuck samples (1 s samples while moving to a goal, out of combat) and the worst bot's rate. */
  stuck: { samples: number; stuck: number; worstBot: number };
}

/** Scripted looter human: chooses inputs from the same public information a player sees. */
class Looter {
  private targetId: number | null = null;
  private presses = 0;
  private readonly ignored = new Set<number>();
  private lastPos = { x: 0, z: 0 };
  private lastCheck = 0;
  private detourUntil = 0;
  private detourYaw = 0;
  private readonly rng;
  /** Fraction of the jump window at which the looter jumps (seeded). */
  private readonly jumpFrac: number;
  pickups = 0;

  constructor(seed: number) {
    this.rng = createRng(seed ^ 0x5bd1e995);
    this.jumpFrac = this.rng.next() * 0.8;
  }

  think(w: DebugWorld, id: number, b: Balance, seq: number): PlayerInput {
    const p = w.debugPlayer(id)!;
    const now = w.timeMs;
    const pos = p.move.pos;
    const inp: PlayerInput = {
      seq, dt: SIM_DT, moveForward: 0, moveRight: 0, yaw: p.yaw, pitch: 0, sprint: false, fire: false,
      jump: false, reload: false, interact: false, useHeal: false, selectSlot: -1, ads: false, stanceToggle: null,
    };
    if (p.aboard) {
      const r = w.getMatch().route;
      if (r) inp.jump = now + SIM_DT * 1000 >= r.noJumpUntil + (r.ejectAt - r.noJumpUntil) * this.jumpFrac;
      return inp;
    }
    const indoor = isIndoor(w.map);
    const zone = w.debugZone()?.state ?? null;
    const loot = w.debugLoot();
    // Pick a loot target: inland, inside the current and the next circle, not ignored.
    let target = this.targetId !== null ? loot.find((l) => l.id === this.targetId) ?? null : null;
    if (!target) {
      this.presses = 0;
      let best = Infinity;
      for (const l of loot) {
        if (this.ignored.has(l.id)) continue;
        if (!indoor && Math.hypot(l.pos.x, l.pos.z) > 85) continue;
        // Don't ping-pong guns once both slots are full (a swap drops the held gun at our feet).
        if (isGun(l.item) && p.inv.slots[0] && p.inv.slots[1]) continue;
        if (zone) {
          if (Math.hypot(l.pos.x - zone.center.x, l.pos.z - zone.center.z) > zone.radius - 3) continue;
          if (Math.hypot(l.pos.x - zone.targetCenter.x, l.pos.z - zone.targetCenter.z) > zone.targetRadius - 2) continue;
        }
        const d = Math.hypot(l.pos.x - pos.x, l.pos.z - pos.z);
        if (d < best) {
          best = d;
          target = l;
        }
      }
      this.targetId = target ? target.id : null;
    }
    let gx: number;
    let gz: number;
    if (target) {
      gx = target.pos.x;
      gz = target.pos.z;
    } else if (zone) {
      gx = zone.targetCenter.x;
      gz = zone.targetCenter.z;
    } else {
      gx = 0;
      gz = 0;
    }
    const dx = gx - pos.x;
    const dz = gz - pos.z;
    const d = Math.hypot(dx, dz);
    // Stuck detour.
    if (!p.move.dropping && now - this.lastCheck >= 1000) {
      const moved = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
      if (moved < 0.8 && d > 2) {
        this.detourUntil = now + 700;
        this.detourYaw = this.rng.next() * Math.PI * 2;
        inp.jump = true;
      }
      this.lastPos = { x: pos.x, z: pos.z };
      this.lastCheck = now;
    }
    if (now < this.detourUntil) {
      inp.yaw = this.detourYaw;
      inp.moveForward = 1;
    } else if (d > 0.4) {
      inp.yaw = Math.atan2(-dx, -dz);
      inp.moveForward = 1;
      inp.sprint = d > 3;
    }
    if (target && !p.move.dropping) {
      const d3 = Math.hypot(target.pos.x - pos.x, target.pos.y - pos.y, target.pos.z - pos.z);
      if (d3 <= b.player.pickupRange * 0.8 && (seq & 1) === 0) {
        inp.interact = true;
        if (++this.presses > 4) {
          this.ignored.add(target.id);
          this.targetId = null;
        }
      }
    }
    if (!p.heal && !p.move.dropping && p.hp < 70 && chooseHeal(p.hp, p.inv.heals, b)) inp.useHeal = true;
    if (p.heal) inp.sprint = false;
    return inp;
  }
}

export function playMatch(
  b0: Balance,
  seed: number,
  variant: Variant,
  players: number | null,
  endWhenNoHumans: boolean,
  map: AnyMapData = mapById('island01'),
  layoutSeed: number | null = null,
): MatchResult {
  const b = JSON.parse(JSON.stringify(b0)) as Balance;
  if (players !== null) b.match.targetPlayers = players;
  b.match.endWhenNoHumansAlive = endWhenNoHumans;
  // Like the server (ADR 0005 §6): a prepared runtime per map (colliders + nav graph for indoor maps).
  const w = createDebugWorld({ map, balance: b, seed, botNames: BOT_NAMES, runtime: prepareMap(map, b) });
  const human = w.addPlayer('Human')!;
  const looter = variant === 'looter' ? new Looter(seed) : null;
  const phases = b.zone.phases.length;
  let startAt = -1;
  let firstKill: number | null = null;
  let humanDeath: number | null = null;
  let humanCause = 'survived';
  let humanPlacement = 1;
  const deathsByCause: Record<string, number> = {};
  const killsByWeapon: Record<string, number> = {};
  const aliveAtPhaseStart: (number | null)[] = new Array<number | null>(phases + 1).fill(null);
  let lastPhase = -2;
  let endedAt = -1;
  let winnerIsHuman = false;
  let seq = 0;
  const grenades = { spawned: 0, pickups: 0, cooks: 0, thrown: 0, dropped: 0, explosions: 0, kills: 0 };
  const armorPickups: Record<string, number> = {};
  let stanceChanges = 0;
  const killsByLevel: Record<string, number> = {};
  const pickupsByLevel: Record<string, number> = {};
  const m2c = { rockets: 0, duds: 0, smokes: 0, glass: 0, swings: 0, scopeMounts: 0 };
  const perSecond = Math.round(1 / SIM_DT);
  const stuckHist = new Map<number, ({ x: number; y: number; z: number } | null)[]>();
  const stuckGoal = new Map<number, { x: number; z: number }>();
  const stuckSamples = { samples: 0, stuck: 0, perBot: {} as Record<number, { samples: number; stuck: number }> };
  let lootCounted = false;
  const landingS: number[] = [];
  const falling = new Set<number>();
  const totalS =
    b.zone.phases.reduce((a, p) => a + p.waitSeconds + p.shrinkSeconds, 0) + b.zone.finalCollapseDelaySeconds + b.zone.finalCollapseSeconds;
  const limit = Math.ceil((b.match.countdownSeconds + totalS + 60) / SIM_DT);
  for (let i = 0; i < limit && endedAt < 0; i++) {
    const phase = w.getMatch().phase;
    if (phase === 'playing' && looter) {
      const p = w.debugPlayer(human);
      if (p && p.alive) w.applyInput(human, looter.think(w, human, b, ++seq));
    }
    const ev: SimEvent[] = w.step(SIM_DT);
    if (w.getMatch().phase === 'playing') {
      for (const e of ev) if (e.type === 'spawn') falling.add(e.playerId);
      for (const id of [...falling]) {
        const p = w.debugPlayer(id);
        if (!p || !p.alive) falling.delete(id);
        else if (!p.aboard && !p.move.dropping) {
          falling.delete(id);
          landingS.push((w.timeMs - startAt) / 1000);
        }
      }
    }
    // MF1: in-match bot stuck samples (navStuck.ts definition: < 1 m of 3D progress over 3 s), counted only while the bot
    // wants to move toward a goal and is not fighting, holding, healing or running a throw / rocket / smoke plan.
    if (w.getMatch().phase === 'playing' && w.tick % perSecond === 0) {
      for (const p of botsOf(w)) {
        if (!p.alive || p.aboard || p.move.dropping || !p.brain) continue;
        const br = p.brain;
        const active = br.wantedMove && !br.targetVisible && w.timeMs >= br.holdUntil && !br.throwPlan && !br.rpgPlan && !br.smokePlan && !p.heal;
        // Like navStuck.ts (history cleared on arrival): a new goal starts a new window, so walking out and back for a
        // new goal (a route that starts behind the bot) is not "stuck".
        const g = br.goal;
        const lastGoal = stuckGoal.get(p.id);
        if (g && (!lastGoal || Math.hypot(g.x - lastGoal.x, g.z - lastGoal.z) > 1)) {
          stuckGoal.set(p.id, { x: g.x, z: g.z });
          stuckHist.set(p.id, []);
        }
        const h = stuckHist.get(p.id) ?? [];
        h.push(active ? { ...p.move.pos } : null);
        if (h.length > 4) h.shift();
        stuckHist.set(p.id, h);
        if (h.length === 4 && h.every((x) => x !== null)) {
          const a = h[0]!;
          const c = h[3]!;
          const stuck = Math.hypot(c.x - a.x, c.y - a.y, c.z - a.z) < 1;
          stuckSamples.samples++;
          if (stuck) stuckSamples.stuck++;
          const pb = stuckSamples.perBot[p.id] ?? { samples: 0, stuck: 0 };
          pb.samples++;
          if (stuck) pb.stuck++;
          stuckSamples.perBot[p.id] = pb;
        }
      }
    }
    if (!lootCounted && w.getMatch().phase === 'playing') {
      lootCounted = true;
      grenades.spawned = w.debugLoot().filter((l) => l.item === 'grenade').length;
    }
    for (const e of ev) {
      if (e.type === 'pickup' && e.item === 'grenade') grenades.pickups++;
      else if (e.type === 'pickup' && isArmorId(e.item)) armorPickups[e.item] = (armorPickups[e.item] ?? 0) + 1;
      else if (e.type === 'grenadeCook') grenades.cooks++;
      else if (e.type === 'grenadeThrown') {
        if (e.dropped) grenades.dropped++;
        else grenades.thrown++;
      } else if (e.type === 'explosion') grenades.explosions++;
      else if (e.type === 'stanceChange') stanceChanges++;
      else if (e.type === 'rocketFired') m2c.rockets++;
      else if (e.type === 'rocketDud') m2c.duds++;
      else if (e.type === 'smokeDeployed') m2c.smokes++;
      else if (e.type === 'glassBroken') m2c.glass++;
      else if (e.type === 'meleeSwing') m2c.swings++;
      else if (e.type === 'scopeChanged' && e.to !== null) m2c.scopeMounts++;
      if (e.type === 'pickup' && e.level !== undefined) pickupsByLevel[`L${e.level}`] = (pickupsByLevel[`L${e.level}`] ?? 0) + 1;
      if (e.type === 'kill' && e.weapon === 'grenade') grenades.kills++;
      if (e.type === 'spawn' && startAt < 0) startAt = w.timeMs;
      else if (e.type === 'kill') {
        const t = (w.timeMs - startAt) / 1000;
        if (firstKill === null) firstKill = t;
        deathsByCause[e.cause] = (deathsByCause[e.cause] ?? 0) + 1;
        if ((e.cause === 'weapon' || e.cause === 'explosion' || e.cause === 'melee' || e.cause === 'rocket') && e.weapon) {
          killsByWeapon[e.weapon] = (killsByWeapon[e.weapon] ?? 0) + 1;
        }
        if (e.weaponLevel != null) killsByLevel[`L${e.weaponLevel}`] = (killsByLevel[`L${e.weaponLevel}`] ?? 0) + 1;
        if (e.victimId === human) {
          humanDeath = t;
          humanPlacement = e.placement;
          humanCause = e.weapon ? `weapon:${e.weapon as HeldId}` : e.cause;
        }
      } else if (e.type === 'pickup' && e.playerId === human && looter) looter.pickups++;
      else if (e.type === 'matchEnded') {
        endedAt = w.timeMs;
        winnerIsHuman = e.winnerId === human;
      }
    }
    const z = w.debugZone();
    if (z && w.getMatch().phase === 'playing' && z.state.phaseIndex !== lastPhase) {
      lastPhase = z.state.phaseIndex;
      if (lastPhase >= 0 && lastPhase <= phases) aliveAtPhaseStart[lastPhase] = w.getMatch().aliveCount;
    }
  }
  const z = w.debugZone()?.state;
  const phaseAtEnd = !z
    ? '?'
    : z.phaseIndex >= phases
      ? 'collapse'
      : `${z.phaseIndex + 1}${z.shrinking ? 's' : 'w'}`;
  const durationS = (endedAt - startAt) / 1000;
  return {
    variant,
    seed,
    durationS,
    firstKillS: firstKill,
    humanSurvivalS: humanDeath ?? durationS,
    humanCause,
    humanPlacement,
    humanPickups: looter ? looter.pickups : 0,
    phaseAtEnd,
    deathsByCause,
    killsByWeapon,
    aliveAtFinalPhase: aliveAtPhaseStart[phases - 1] ?? null,
    aliveAtPhaseStart,
    winnerIsHuman,
    grenades,
    armorPickups,
    stanceChanges,
    landingS,
    layoutSeed,
    killsByLevel,
    m2c,
    pickupsByLevel,
    stuck: {
      samples: stuckSamples.samples,
      stuck: stuckSamples.stuck,
      worstBot: Math.max(0, ...Object.values(stuckSamples.perBot).map((x) => (x.samples >= 30 ? x.stuck / x.samples : 0))),
    },
  };
}

/** Bot participants of a debug World (ids after the human's). */
function botsOf(w: DebugWorld): import('../state').SimPlayer[] {
  const out: import('../state').SimPlayer[] = [];
  for (let id = 1; id < 64; id++) {
    const p = w.debugPlayer(id);
    if (p && p.isBot) out.push(p);
  }
  return out;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, c) => a - c);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (x: number | null | undefined): string => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(0));
const mmm = (xs: number[]): string =>
  xs.length === 0 ? '-' : `${fmt(Math.min(...xs))} / ${fmt(median(xs))} / ${fmt(Math.max(...xs))}`;
const sumRec = (rs: Record<string, number>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rs) for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
  return out;
};
const recStr = (r: Record<string, number>): string =>
  Object.entries(r)
    .sort((a, c) => c[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || '-';

/** Share of weapon kills (guns, fists and grenades) per weapon, highest first. */
const shareStr = (r: Record<string, number>): string => {
  const total = Object.values(r).reduce((a, v) => a + v, 0);
  if (total === 0) return '-';
  return Object.entries(r)
    .sort((a, c) => c[1] - a[1])
    .map(([k, v]) => `${k} ${((100 * v) / total).toFixed(1)}%`)
    .join(', ');
};

const grenadeStr = (rs: MatchResult[]): string => {
  const keys = ['spawned', 'pickups', 'cooks', 'thrown', 'dropped', 'explosions', 'kills'] as const;
  return keys
    .map((k) => {
      const t = rs.reduce((a, r) => a + r.grenades[k], 0);
      return `${k} ${t} (${(t / rs.length).toFixed(2)})`;
    })
    .join(', ');
};

export function summarize(results: MatchResult[], variant: Variant): string {
  const rs = results.filter((r) => r.variant === variant);
  if (rs.length === 0) return '';
  const surv = rs.map((r) => r.humanSurvivalS);
  const pct = (t: number): string => `${Math.round((100 * surv.filter((s) => s >= t).length) / surv.length)}%`;
  const phases = rs[0]!.aliveAtPhaseStart.length;
  const alivePerPhase: string[] = [];
  for (let i = 0; i < phases; i++) {
    const xs = rs.map((r) => r.aliveAtPhaseStart[i]).filter((x): x is number => x !== null);
    alivePerPhase.push(`${i < phases - 1 ? `P${i + 1}` : 'C'}:${xs.length ? median(xs).toFixed(1) : '-'}(${xs.length}/${rs.length})`);
  }
  const phaseEnd: Record<string, number> = {};
  for (const r of rs) phaseEnd[r.phaseAtEnd] = (phaseEnd[r.phaseAtEnd] ?? 0) + 1;
  const humanCauses: Record<string, number> = {};
  for (const r of rs) humanCauses[r.humanCause] = (humanCauses[r.humanCause] ?? 0) + 1;
  const finalAlive = rs.map((r) => r.aliveAtFinalPhase).filter((x): x is number => x !== null);
  const lines = [
    `== ${variant} human, ${rs.length} matches ==`,
    `match duration s (min/med/max): ${mmm(rs.map((r) => r.durationS))}`,
    `first kill s (min/med/max):     ${mmm(rs.map((r) => r.firstKillS).filter((x): x is number => x !== null))}`,
    `landing s (median of medians):  ${median(rs.map((r) => median(r.landingS)).filter((x) => !Number.isNaN(x))).toFixed(1)}`,
    `human survival s (min/med/max): ${mmm(surv)}   >=45s ${pct(45)}  >=90s ${pct(90)}  wins ${rs.filter((r) => r.winnerIsHuman).length}`,
    `human placement (median):       ${median(rs.map((r) => r.humanPlacement)).toFixed(1)}   death causes: ${recStr(humanCauses)}` +
      (variant === 'looter' ? `   pickups (median) ${median(rs.map((r) => r.humanPickups)).toFixed(0)}` : ''),
    `tide phase at end:              ${recStr(phaseEnd)}`,
    `deaths by cause:                ${recStr(sumRec(rs.map((r) => r.deathsByCause)))}`,
    `kills per weapon:               ${recStr(sumRec(rs.map((r) => r.killsByWeapon)))}`,
    `weapon kill share:              ${shareStr(sumRec(rs.map((r) => r.killsByWeapon)))}`,
    `grenades (total / per match):   ${grenadeStr(rs)}`,
    `armor pickups:                  ${recStr(sumRec(rs.map((r) => r.armorPickups)))}   stance changes/match ${(rs.reduce((a, r) => a + r.stanceChanges, 0) / rs.length).toFixed(1)}`,
    `alive at final phase start:     median ${finalAlive.length ? median(finalAlive).toFixed(1) : '-'} when reached (reached in ${finalAlive.length}/${rs.length})`,
    `alive at phase start (median):  ${alivePerPhase.join(' ')}`,
    `kills by weapon level:          ${shareStr(sumRec(rs.map((r) => r.killsByLevel)))}`,
    `weapon pickups by level:        ${recStr(sumRec(rs.map((r) => r.pickupsByLevel)))}`,
    `M2c per match:                  ${(['rockets', 'duds', 'smokes', 'glass', 'swings', 'scopeMounts'] as const)
      .map((k) => `${k} ${(rs.reduce((a, r) => a + r.m2c[k], 0) / rs.length).toFixed(2)}`)
      .join(', ')}`,
    `bot stuck (in match):           ${stuckStr(rs)}`,
    `layouts:                        ${[...new Set(rs.map((r) => (r.layoutSeed === null ? 'base' : `0x${r.layoutSeed.toString(16)}`)))].slice(0, 8).join(' ')}`,
  ];
  return lines.join('\n');
}

/** MF1: pooled in-match stuck rate, the worst match and the worst single bot (>= 30 samples). */
function stuckStr(rs: MatchResult[]): string {
  const s = rs.reduce((a, r) => a + r.stuck.stuck, 0);
  const n = rs.reduce((a, r) => a + r.stuck.samples, 0);
  const pct = (x: number): string => `${(100 * x).toFixed(2)}%`;
  const worstMatch = Math.max(0, ...rs.map((r) => (r.stuck.samples > 0 ? r.stuck.stuck / r.stuck.samples : 0)));
  const worstBot = Math.max(0, ...rs.map((r) => r.stuck.worstBot));
  return `${pct(n > 0 ? s / n : 0)} of ${n} bot-seconds; worst match ${pct(worstMatch)}, worst bot ${pct(worstBot)}`;
}

/** M2c: the layout-applied map of a seed (cached per seed: building and preparing a layout is the server's lock work). */
const layoutCache = new Map<number, AnyMapData>();
export function layoutMap(base: AnyMapData, seed: number): AnyMapData {
  let m = layoutCache.get(seed);
  if (!m) {
    m = applyLayout(base, buildMatchLayout(base, seed, { decor: false }));
    layoutCache.set(seed, m);
  }
  return m;
}

/** balance.json _m2cPending without its notes (merge step 2 preview). */
function pendingOverride(): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) out[k] = strip(x);
    return out;
  };
  return strip((balanceJson as Record<string, unknown>)['_m2cPending'] ?? {}) as Record<string, unknown>;
}

/**
 * MF1 / LV14: the nav-walk stuck rate (navStuck.ts, the M2b office definition) per layout seed. Seeds: --layout-seed,
 * else layoutSeedFor(seed .. seed + N - 1) for --layout-seeds N (default 1 = the base map with seed 0). --players sets
 * the bot count (default 12). Gate (variety.md LV14): pooled < 2 %, every seed <= 5 %.
 */
function navWalkReport(args: Args, base: AnyMapData, balance: Balance): void {
  if (!isIndoor(base)) throw new Error('--nav-walk needs an indoor map (the island has no nav graph)');
  const seeds =
    args.layoutSeed !== null
      ? [args.layoutSeed]
      : args.layoutSeeds > 0
        ? Array.from({ length: args.layoutSeeds }, (_, i) => layoutSeedFor(args.seed + i, 0))
        : [0];
  const t0 = Date.now();
  const r = navStuckForLayoutSeeds(base, balance, seeds, args.players ?? 12, args.navWalk, args.seed);
  if (args.json) {
    console.log(JSON.stringify(r.perSeed.map((x) => ({ layoutSeed: x.layoutSeed, stuckRate: x.stuckRate, samples: x.samples, arrivals: x.arrivals }))));
    return;
  }
  const pct = (x: number): string => `${(100 * x).toFixed(2)}%`;
  const sorted = [...r.perSeed].sort((a, c) => c.stuckRate - a.stuckRate);
  const over5 = r.perSeed.filter((x) => x.stuckRate > 0.05).length;
  console.log(`nav walk ${base.id}: ${seeds.length} layout seeds, ${args.players ?? 12} bots x ${args.navWalk} s, walk seed ${args.seed}`);
  console.log(`pooled stuck rate ${pct(r.pooledRate)}  (gate < 2%); seeds > 5%: ${over5}; worst ${pct(r.worst.stuckRate)} at 0x${r.worst.layoutSeed.toString(16)}`);
  console.log(`median seed ${pct(sorted[sorted.length >> 1]!.stuckRate)}; worst 10: ${sorted.slice(0, 10).map((x) => `0x${x.layoutSeed.toString(16)} ${pct(x.stuckRate)}`).join(', ')}`);
  console.log(`arrivals per seed (median): ${median(r.perSeed.map((x) => x.arrivals)).toFixed(0)}; plateau arrivals (median): ${median(r.perSeed.map((x) => x.plateauArrivals)).toFixed(0)}`);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s wall)`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const base = mapById(args.map);
  const override = args.m2cPending ? pendingOverride() : {};
  deepMerge(override, args.override);
  const balance = balanceForMap(balanceWithOverride(override), base.id);
  if (args.navWalk > 0) {
    navWalkReport(args, base, balance);
    return;
  }
  const results: MatchResult[] = [];
  const t0 = Date.now();
  for (const variant of args.variants) {
    for (let m = 0; m < args.matches; m++) {
      const ls = args.layoutSeed ?? (args.layoutSeeds > 0 ? layoutSeedFor(args.seed + (m % args.layoutSeeds), 0) : null);
      const map = ls === null ? base : layoutMap(base, ls);
      results.push(playMatch(balance, args.seed + m, variant, args.players, args.endWhenNoHumans, map, ls));
    }
  }
  const map = base;
  if (args.json) {
    console.log(JSON.stringify(results));
    return;
  }
  const players = args.players ?? balance.match.targetPlayers;
  console.log(`map ${map.id}, players ${players} (1 human + ${players - 1} bots), seeds ${args.seed}..${args.seed + args.matches - 1}, override ${JSON.stringify(args.override)}`);
  for (const v of args.variants) console.log(summarize(results, v));
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s wall)`);
}

const isMain = typeof process !== 'undefined' && process.argv[1] !== undefined && /matchReport\.ts$/.test(process.argv[1]);
if (isMain) main();
