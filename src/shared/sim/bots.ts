/**
 * Bot brains (GDD section 10). A bot produces one PlayerInput per tick that goes through the same World input path as a
 * human's. Bots only use information a player could have: visible enemies (range + FOV + line of sight), gunfire
 * within hearing range, damage direction, the public zone state and the public loot list.
 *
 * Gameplay-facing tuning comes from balance.bots (botTuning adds the M1-fix pacing keys with defaults). BOT_AI holds
 * steering/AI plumbing (turn rates, probe distances), overridable from balance.bots.ai.
 *
 * Pacing model (M1-fix): after landing a bot is in a loot phase (lootPhaseSeconds x personality) in which it only
 * fights enemies within lootPhaseEngageRange or who shot it. Afterwards its engagement range ramps (eagerness) with time
 * and with the tide phase up to the held weapon's chase range. Bots fire only within their weapon's fire range, after a
 * reaction delay, and spread over targets (focus penalty + per-pair bias) instead of converging on one player.
 */
import type { Balance } from '../balance';
import type { BotDropBalance } from '../balance';
import { ammoFor, effectiveSight, isScopeSight } from '../balance';
import { segmentBlockedBySmoke } from '../smoke';
import { isIndoor } from '../maps';
import { DEG2RAD, type Rng, wrapAngle } from '../math';
import type {
  AnyMapData,
  BotPersonalityId,
  DropRoute,
  GrenadeId,
  GunId,
  ItemLevel,
  LootId,
  LootSpawn,
  PlayerId,
  PlayerInput,
  ScopeId,
  SlotIndex,
  SmokeCloudState,
  Stance,
  StanceRequest,
  Vec2,
  Vec3,
  WeaponId,
  WeaponSlotState,
  MeleeSlotState,
  ZoneState,
} from '../types';
import { BOT_PERSONALITY_IDS, FISTS_SLOT, GRENADE_SLOT, isArmorId, isM2cGunId, isMeleeId, isScopeId } from '../types';
import { forEachColliderNear, lineOfSight, overlapsCircle, raycastColliders, raycastStatic } from './colliders';
import { adsProgressOf, expectedBodyDps } from './combat';
import { type GrenadeBody, stepGrenade, throwLaunch, throwSpeedFor } from './grenade';
import { activeWeapon, armorAccepted, chooseHeal, isAmmo, isGrenade, isGun, isHeal, upgradeSlotFor } from './inventory';
import { effWeapon, levelValue, slotWeapon } from './levels';
import { wouldMount } from './scopes';
import type { LootEntity } from './loot';
import type { MovementContext } from './movement';
import {
  type NavBudget,
  type NavGraph,
  type NavPath,
  navColliders,
  navTuning,
  nearestNode,
  nodePos,
  type PathCache,
  plateauNodes,
  requestPath,
} from './nav';
import { eyePoint, hitboxHeightOf, isStanceSettled, pitchLimits, stanceAllowedAtDepth, stanceWaterDepth } from './stance';
import type { SimPlayer } from './state';
import { heightAt } from './terrain';

/**
 * AI plumbing defaults (steering, probes, timers). Overridable per key from the optional `balance.bots.ai` block
 * (see BotAiBalance in src/shared/balance.ts); read them through `botAi(balance)`.
 */
/** M2c plan timeouts and aim tolerance (behaviour constants, not balance; the M2a BOT_M2A_AI pattern). */
export const BOT_M2C_AI = {
  /** Give up an rpg plan that has not fired after this long (swap + ADS + aim take about 1 s). */
  rpgPlanTimeoutMs: 3000,
  /** Radians of yaw and pitch error within which the rocket is released. */
  rpgAimTolerance: 0.02,
  /** Give up a smoke plan after this long. */
  smokePlanTimeoutMs: 2500,
  /**
   * In-match stuck follow-up: zone urgency hysteresis. A bot that had to rotate in keeps the tide goal until it is this
   * far inside the safe circle, and then ignores loot within this distance of its edge (no shuttling on the line).
   */
  zoneHysteresisMetres: 3,
} as const;

export const BOT_AI = {
  /** Aim point height as a fraction of player.height (chest; below the head zone). */
  aimHeightFraction: 0.45,
  /** Max yaw turn rate when not fighting, rad/s (balance key: idleTurnDegPerSecond). */
  idleTurnRate: Math.PI * 3,
  /** Max yaw/pitch tracking rate in a fight, rad/s (balance key: combatTurnDegPerSecond). */
  combatTurnRate: Math.PI * 4,
  /** Knee-height probe distance for obstacle avoidance, metres. */
  probeDistance: 1.8,
  probeHeight: 0.4,
  /** Below this displacement per decision (fraction of expected) the bot counts as stuck. */
  stuckFraction: 0.25,
  detourMs: 900,
  arriveDistance: 1.2,
  /** Interact when within this fraction of player.pickupRange. */
  interactFraction: 0.8,
  /** Give up on a pickup after this many interact presses. */
  lootGiveUpPresses: 6,
  /** Idle reload when the mag is below this fraction. */
  idleReloadFraction: 0.5,
  /** Zone urgency: travel-time multiplier and buffer (s; balance key: zoneUrgencyBufferSeconds). */
  zoneUrgencyFactor: 1.6,
  zoneUrgencyBufferS: 4,
  /** Wander inside this fraction of the safe target radius. */
  wanderFraction: 0.5,
  /** Distance used to rank guns for loot decisions, metres. */
  gunScoreDistance: 20,
  /** Preferred engage distance as a fraction of the weapon's falloffStart (fists: of range). */
  preferredRangeFraction: 1,
  /** Loot desirability scores (relative; divided by 1 + distance / lootDistanceFalloff). */
  lootScoreUnarmedGun: 100,
  lootScoreSecondGun: 55,
  /** A second copy of a gun already carried while a slot is free. */
  lootScoreDuplicateGun: 8,
  /** Replacing the weaker gun with one scoring > gunUpgradeFactor x better. */
  lootScoreUpgradeGun: 40,
  gunUpgradeFactor: 1.15,
  lootScoreVest: 40,
  /** M2a: armor value = (lootScoreVest | lootScoreHelmet) + lootScoreArmorPerTier x tier, when it would be accepted. */
  lootScoreHelmet: 32,
  lootScoreArmorPerTier: 10,
  /** M2a: a grenade stack while below items.grenade.maxCarry. */
  lootScoreGrenade: 18,
  /** Ammo for a carried gun while below 2 pickups' worth / otherwise. */
  lootScoreAmmoLow: 35,
  lootScoreAmmo: 15,
  lootScoreMedkit: 30,
  lootScoreBandage: 22,
  lootDistanceFalloff: 10,
};

export type BotAi = typeof BOT_AI;

/** BOT_AI keys that map 1:1 (same name and unit) onto `balance.bots.ai`. */
type SameNameAiKey = Exclude<keyof BotAi, 'idleTurnRate' | 'combatTurnRate' | 'zoneUrgencyBufferS'>;
const SAME_NAME_AI_KEYS = (Object.keys(BOT_AI) as (keyof BotAi)[]).filter(
  (k): k is SameNameAiKey => k !== 'idleTurnRate' && k !== 'combatTurnRate' && k !== 'zoneUrgencyBufferS',
);

/**
 * BOT_AI with any `balance.bots.ai` overrides applied. idleTurnRate / combatTurnRate come from the deg/s keys and
 * zoneUrgencyBufferS from zoneUrgencyBufferSeconds. Pure: no caching (sim modules hold no module-level mutable state).
 */
export function botAi(b: Balance): BotAi {
  const src = b.bots.ai;
  if (!src) return BOT_AI;
  const out: BotAi = { ...BOT_AI };
  for (const k of SAME_NAME_AI_KEYS) out[k] = src[k] ?? BOT_AI[k];
  out.idleTurnRate = src.idleTurnDegPerSecond !== undefined ? src.idleTurnDegPerSecond * DEG2RAD : BOT_AI.idleTurnRate;
  out.combatTurnRate = src.combatTurnDegPerSecond !== undefined ? src.combatTurnDegPerSecond * DEG2RAD : BOT_AI.combatTurnRate;
  out.zoneUrgencyBufferS = src.zoneUrgencyBufferSeconds ?? BOT_AI.zoneUrgencyBufferS;
  return out;
}

export type BotPersonality = BotPersonalityId;
export const BOT_PERSONALITIES: readonly BotPersonality[] = BOT_PERSONALITY_IDS;

export interface BotPersonalityTuning {
  /** Relative share of bots rolled with this personality. */
  share: number;
  /** Multiplies the engagement range (and the early-game close-threat range). */
  engageRangeMultiplier: number;
  /** Multiplies lootPhaseSeconds. */
  lootPhaseMultiplier: number;
  /** Multiplies bots.reactionMs. */
  reactionMultiplier: number;
  /** Break off and retreat to heal below this HP when carrying a heal (0 = never retreats). */
  retreatBelowHp: number;
  /** M2a: chance per strafe change to crouch/prone while engaged (bots.stance). */
  stanceChance: number;
  /** M2a: multiplies bots.grenade.throwChancePerDecision. */
  grenadeChanceMultiplier: number;
  /** M2b (drop.md): added to the planned jump time, ms (negative = earlier). */
  jumpTimingBiasMs: number;
  /** M2b (drop.md): multiplies bots.drop.tierWeights.epic. */
  dropEpicWeightMultiplier: number;
  /** M2c (smoke.md "Bots"): multiplies bots.smoke.retreatThrowChance and zoneCrossThrowChance. */
  smokeChanceMultiplier: number;
}

/**
 * Pacing / behaviour tunables introduced in M1-fix. Read from `balance.bots.<key>` / `balance.bots.personalities`
 * (BotPacingBalance, ADR 0003) when present, otherwise these defaults; use `botTuning(balance)`.
 */
export interface BotTuning {
  /** Seconds after landing during which a bot prioritises looting and only fights close threats or attackers. */
  lootPhaseSeconds: number;
  /** During the loot phase, only engage enemies within this many metres (or who shot the bot). */
  lootPhaseEngageRange: number;
  /**
   * Skip loot within this many metres of a visible enemy the bot is not fighting, and back away from it. Full during
   * the loot phase, fading to 0 as eagerness reaches 1. 0 disables.
   */
  avoidRange: number;
  /** While dropping, skip guns within this many metres of another dropping bot's chosen landing gun. */
  dropSpreadRange: number;
  /** Seconds after the loot phase for engagement range to ramp to full. */
  eagernessRampSeconds: number;
  /** Zone phase index at which eagerness is full regardless of time (phase i / this = eagerness floor). */
  eagernessFullAtPhase: number;
  /** Eagerness = (linear ramp)^this: > 1 keeps the mid-game calmer and the late game hot. */
  eagernessCurve: number;
  /** Bots fire only within lerp(falloffStart, falloffEnd, this) of the held weapon (fists: range). */
  fireRangeFalloffFraction: number;
  /** Full-eagerness engagement (chase) range is max(fire range, this), capped by visionRange. */
  minEngageRange: number;
  /** A current target is kept until it is beyond engage range x this. */
  disengageRangeFactor: number;
  /** An enemy who damaged the bot within this many ms is a valid target at any visible range. */
  retaliateMs: number;
  /** Target score penalty per other bot already fighting that target (spreads bots over targets). */
  focusPenalty: number;
  /** Per bot-target pair random preference: target score x [1 - spread, 1 + spread]. */
  targetBiasSpread: number;
  /**
   * A bot below this HP that carries a usable heal does not start new fights (it still fights back when shot); it
   * heals first. 0 disables.
   */
  healBeforeFightBelowHp: number;
  /** How long a retreat lasts before the bot reconsiders, ms. */
  retreatMs: number;
  /**
   * With nothing to loot and already inside the next circle, bots hold their area: they drift to random points within
   * this many metres instead of walking to the circle centre. Aggressive bots roam toward the centre once eagerness
   * reaches roamEagerness.
   */
  holdWanderRadius: number;
  /** Holding bots pause (look around, stand still) this long, x [0.5, 1.5], at each hold point, ms. */
  holdPauseMs: number;
  roamEagerness: number;
  /**
   * Rotating into the next circle, bots head for safeRadius x f along the line to its centre (1 = edge), with f drawn
   * per bot and phase in [zoneEntryFraction - zoneEntrySpread, zoneEntryFraction].
   */
  zoneEntryFraction: number;
  zoneEntrySpread: number;
  personalities: Record<BotPersonality, BotPersonalityTuning>;
}

export const BOT_TUNING_DEFAULTS: BotTuning = {
  lootPhaseSeconds: 90,
  lootPhaseEngageRange: 4,
  avoidRange: 20,
  dropSpreadRange: 15,
  eagernessRampSeconds: 300,
  eagernessFullAtPhase: 5,
  eagernessCurve: 1.5,
  fireRangeFalloffFraction: 0.2,
  minEngageRange: 15,
  disengageRangeFactor: 1.4,
  retaliateMs: 4000,
  focusPenalty: 0.6,
  targetBiasSpread: 0.25,
  healBeforeFightBelowHp: 80,
  retreatMs: 3500,
  holdWanderRadius: 12,
  holdPauseMs: 5000,
  roamEagerness: 0.5,
  zoneEntryFraction: 0.95,
  zoneEntrySpread: 0.25,
  personalities: {
    aggressive: {
      share: 0.3,
      engageRangeMultiplier: 1.25,
      lootPhaseMultiplier: 0.8,
      reactionMultiplier: 0.85,
      retreatBelowHp: 0,
      stanceChance: 0,
      grenadeChanceMultiplier: 1.5,
      jumpTimingBiasMs: -1000,
      dropEpicWeightMultiplier: 1.5,
      smokeChanceMultiplier: 0.5,
    },
    balanced: {
      share: 0.4,
      engageRangeMultiplier: 1,
      lootPhaseMultiplier: 1,
      reactionMultiplier: 1,
      retreatBelowHp: 45,
      stanceChance: 0.1,
      grenadeChanceMultiplier: 1,
      jumpTimingBiasMs: 0,
      dropEpicWeightMultiplier: 1,
      smokeChanceMultiplier: 1,
    },
    cautious: {
      share: 0.3,
      engageRangeMultiplier: 0.75,
      lootPhaseMultiplier: 1.3,
      reactionMultiplier: 1.15,
      retreatBelowHp: 60,
      stanceChance: 0.35,
      grenadeChanceMultiplier: 0.6,
      jumpTimingBiasMs: 1500,
      dropEpicWeightMultiplier: 0.5,
      smokeChanceMultiplier: 1.5,
    },
  },
};

type PacingKey = Exclude<keyof BotTuning, 'personalities'>;
const PACING_KEYS = (Object.keys(BOT_TUNING_DEFAULTS) as (keyof BotTuning)[]).filter(
  (k): k is PacingKey => k !== 'personalities',
);

/** BOT_TUNING_DEFAULTS with any `balance.bots.*` pacing keys and `balance.bots.personalities.*` applied, per key. */
export function botTuning(b: Balance): BotTuning {
  const src = b.bots;
  const out = { ...BOT_TUNING_DEFAULTS, personalities: { ...BOT_TUNING_DEFAULTS.personalities } };
  for (const k of PACING_KEYS) out[k] = src[k] ?? BOT_TUNING_DEFAULTS[k];
  for (const name of BOT_PERSONALITIES) {
    const def = BOT_TUNING_DEFAULTS.personalities[name];
    const p = src.personalities?.[name];
    out.personalities[name] = {
      share: p?.share ?? def.share,
      engageRangeMultiplier: p?.engageRangeMultiplier ?? def.engageRangeMultiplier,
      lootPhaseMultiplier: p?.lootPhaseMultiplier ?? def.lootPhaseMultiplier,
      reactionMultiplier: p?.reactionMultiplier ?? def.reactionMultiplier,
      retreatBelowHp: p?.retreatBelowHp ?? def.retreatBelowHp,
      stanceChance: p?.stanceChance ?? def.stanceChance,
      grenadeChanceMultiplier: p?.grenadeChanceMultiplier ?? def.grenadeChanceMultiplier,
      jumpTimingBiasMs: p?.jumpTimingBiasMs ?? def.jumpTimingBiasMs,
      dropEpicWeightMultiplier: p?.dropEpicWeightMultiplier ?? def.dropEpicWeightMultiplier,
      smokeChanceMultiplier: p?.smokeChanceMultiplier ?? def.smokeChanceMultiplier,
    };
  }
  return out;
}

/** M2a bot tuning (`bots.ads`, `bots.stance`, `bots.grenade`; every key optional). Read through botM2a(balance). */
export interface BotM2aTuning {
  /** scopedFireMinProgress (REVIEW-M2a M7): scoped guns hold fire until ADS progress reaches this. */
  ads: { minRange: number; aimErrorMultiplier: number; scopedVisionRange: number; scopedFireMinProgress: number };
  stance: { minRange: number; holdMs: number; proneShare: number };
  grenade: {
    minRange: number;
    maxRange: number;
    throwChancePerDecision: number;
    cooldownMs: number;
    cookMs: number;
    coverMemoryMs: number;
    aimErrorMetres: number;
    fleeRadius: number;
  };
}

export const BOT_M2A_DEFAULTS: Omit<BotM2aTuning, 'ads'> & { ads: Omit<BotM2aTuning['ads'], 'scopedFireMinProgress'> } = {
  ads: { minRange: 15, aimErrorMultiplier: 0.5, scopedVisionRange: 70 },
  stance: { minRange: 20, holdMs: 2500, proneShare: 0.35 },
  grenade: {
    minRange: 8,
    maxRange: 30,
    throwChancePerDecision: 0.08,
    cooldownMs: 8000,
    cookMs: 1200,
    coverMemoryMs: 3000,
    aimErrorMetres: 2.5,
    fleeRadius: 7,
  },
};

function required<T>(v: T | undefined, path: string): T {
  if (v === undefined) throw new Error(`balance.${path} is required`);
  return v;
}

/** BOT_M2A_DEFAULTS with any `balance.bots.ads/stance/grenade` keys applied. */
export function botM2a(b: Balance): BotM2aTuning {
  const d = BOT_M2A_DEFAULTS;
  const a = b.bots.ads ?? {};
  const st = b.bots.stance ?? {};
  const g = b.bots.grenade ?? {};
  return {
    ads: {
      minRange: a.minRange ?? d.ads.minRange,
      aimErrorMultiplier: a.aimErrorMultiplier ?? d.ads.aimErrorMultiplier,
      scopedVisionRange: a.scopedVisionRange ?? d.ads.scopedVisionRange,
      // REVIEW-M2b M1: required data, no code default.
      scopedFireMinProgress: required(a.scopedFireMinProgress, 'bots.ads.scopedFireMinProgress'),
    },
    stance: {
      minRange: st.minRange ?? d.stance.minRange,
      holdMs: st.holdMs ?? d.stance.holdMs,
      proneShare: st.proneShare ?? d.stance.proneShare,
    },
    grenade: {
      minRange: g.minRange ?? d.grenade.minRange,
      maxRange: g.maxRange ?? d.grenade.maxRange,
      throwChancePerDecision: g.throwChancePerDecision ?? d.grenade.throwChancePerDecision,
      cooldownMs: g.cooldownMs ?? d.grenade.cooldownMs,
      cookMs: g.cookMs ?? d.grenade.cookMs,
      coverMemoryMs: g.coverMemoryMs ?? d.grenade.coverMemoryMs,
      aimErrorMetres: g.aimErrorMetres ?? d.grenade.aimErrorMetres,
      fleeRadius: g.fleeRadius ?? d.grenade.fleeRadius,
    },
  };
}

/**
 * `balance.bots.drop` (drop.md "Bots: jump choice"). Required data (game-designer ships it; tech-lead makes the type
 * required, REVIEW-M2b M1); no copy of the numbers in code.
 */
export function botDropTuning(b: Balance): BotDropBalance {
  const d = b.bots.drop;
  if (!d) throw new Error('balance.bots.drop is required (systems/drop.md)');
  return d;
}

/** Bot plumbing added in M2b (not design tuning). */
const BOT_M2B_AI = {
  /** Keep avoiding an enemy this long after it was last seen (ms). */
  avoidMemoryMs: 1500,
};

/** Bot plumbing for M2b indoor navigation (geometry tolerances, not design tuning). */
export const BOT_NAV_AI = {
  /** A path point counts as reached within this horizontal distance (m)... */
  arriveRadius: 0.7,
  /** ...when the feet are no more than this below it (m; stepHeight is added). */
  arriveBelowMargin: 0.05,
  /** Replan when the goal moved further than this (m). */
  replanGoalDistance: 2,
  /** Jump at a climb step when a knee-height ray hits its face within player.radius + this (m). */
  jumpFaceDistance: 0.5,
  /** Goals and targets more than this (m) above or below are on another layer. */
  layerDy: 1.0,
  /** Before a path is known, the zone walk is the straight distance x this (maps.md 2.2 "wall detours x1.4"). */
  detourFactor: 1.4,
  /** Within this distance (m) of a route's first waypoint the bot is committed to the route (no replans). */
  routeCommitDistance: 3,
  /** Stuck checks in a row on a climb route before the bot gives the route up (replan + detour). */
  routeStuckLimit: 4,
  /** Plateau hold: sample this many plateau cells inside the circle and take the closest. */
  plateauHoldSamples: 8,
  /** Remember a cross-layer loot path length this long (ms) before asking again. */
  lootLenMemoryMs: 3000,
};

/** Bot plumbing for M2a behaviour (not design tuning). */
const BOT_M2A_AI = {
  /** Grenade aim search: coarse pitch step and refine step, degrees. */
  throwPitchStepDeg: 2.5,
  throwPitchRefineDeg: 0.5,
  /** Real arcs per tick of the cook-time search (ThrowSearch); about 0.4 ms each on the office. */
  throwRefineArcsPerTick: 2,
  /** The bias-corrected retry searches this far either side of the first pick, degrees. */
  throwCorrectSpanDeg: 10,
  /** Try the high-arc (lob) seed when the best low-arc throw still misses by more than this (cover in the way), m. */
  lobMissMetres: 2,
  /** The lob seed is at least this many degrees above the low-arc seed. */
  lobMinSeparationDeg: 10,
  /** Give up a throw plan (releasing any cooked grenade) after this long, ms. */
  throwPlanTimeoutMs: 4000,
};

/** Rolls a personality by share (deterministic for the given Rng). */
export function rollPersonality(b: Balance, rng: Rng): BotPersonality {
  const t = botTuning(b).personalities;
  const total = BOT_PERSONALITIES.reduce((a, n) => a + Math.max(0, t[n].share), 0);
  if (total <= 0) return 'balanced';
  let x = rng.next() * total;
  for (const n of BOT_PERSONALITIES) {
    x -= Math.max(0, t[n].share);
    if (x < 0) return n;
  }
  return 'balanced';
}

export interface BotBrain {
  personality: BotPersonality;
  /** Server ms of the first grounded decision (-1 while dropping). */
  landedAt: number;
  nextDecisionAt: number;
  targetId: PlayerId | null;
  targetVisible: boolean;
  /** Where the current target was last seen (bots never chase a target's true position out of sight). */
  lastSeenPos: Vec2 | null;
  firstSeenAt: number;
  lastSeenAt: number;
  trackingSince: number;
  lookAt: Vec3 | null;
  lookUntil: number;
  goal: Vec2 | null;
  sprint: boolean;
  lootId: LootId | null;
  lootPresses: number;
  ignoredLoot: LootId[];
  burstUntil: number;
  pauseUntil: number;
  strafeDir: number;
  nextStrafeAt: number;
  lastPos: Vec2;
  wantedMove: boolean;
  detourUntil: number;
  detourDir: Vec2;
  jumpNext: boolean;
  wanderPoint: Vec2 | null;
  wanderPhase: number;
  parity: boolean;
  pendingSlot: SlotIndex | -1;
  pendingReload: boolean;
  pendingHeal: boolean;
  dropGoalChosen: boolean;
  /** Holding still at the current wander point until this server ms. */
  holdUntil: number;
  /** Nearest visible enemy the bot is avoiding (not fighting), recomputed every decision. */
  avoidPos: Vec2 | null;
  /** M2b: keep backing away from avoidPos until this server ms (BOT_M2B_AI.avoidMemoryMs). */
  avoidUntil: number;
  /** Retreating (no fire, run away from the target) until this server ms. */
  retreatUntil: number;
  retreatCooldownUntil: number;
  /** M2a: hold this stance until stanceUntil (bots.stance), then stand. */
  stanceWant: Stance;
  stanceUntil: number;
  /** M2a: grenade throw in progress (bots.grenade). */
  throwPlan: BotThrowPlan | null;
  nextGrenadeAt: number;
  /** M2a: running away from a visible live grenade until fleeUntil. */
  fleeUntil: number;
  /** M2b: height hint for `goal` (plateau loot, plateau holds); null = the bot's own layer. */
  goalY: number | null;
  /** M2b: height of the current wander point when it is a plateau hold, else null. */
  wanderY: number | null;
  /** M2b: drop target and jump time (assignBotDrops); null in drop-less test Worlds. */
  dropPlan: BotDropPlan | null;
  /** M2b: indoor path following (nav graph). */
  nav: BotNavFollow;
  /** M2b: navigation drove this tick's movement (the M1 stuck detour stays off). */
  navActive: boolean;
  /** M2b: last zone walk length by path (zone urgency), with when and for which phase it was measured. */
  zoneLen: { at: number; phase: number; len: number } | null;
  /** M2b: cross-layer loot path lengths (Infinity = unreachable). */
  lootLen: { id: LootId; len: number; at: number }[];
  /** Where the current target was last seen, height (chase reachability). */
  lastSeenY: number;
  /** REVIEW-M2a M3: server ms of this bot's last grenade pitch solve (one solve per tick across bots). */
  throwSolvedAt: number;
  /** M2c (rpg.md "Bots"): a rocket shot in progress, and the next allowed one. */
  rpgPlan: BotRpgPlan | null;
  nextRpgAt: number;
  /** Zone phase in which the tide became urgent for this bot (urgency hysteresis), -1 = none. */
  zoneUrgentPhase: number;
  /** Zone phase in which this bot had to rotate in: it then ignores loot outside the next circle for that phase. */
  zoneRotatedPhase: number;
  /** M2c (smoke.md "Bots"): a quick smoke throw in progress, and the next allowed one. */
  smokePlan: BotSmokePlan | null;
  nextSmokeAt: number;
}

/** M2c: an RPG shot: swap to the rpg slot, aim with lead and a seeded offset, fire once, swap back. */
export interface BotRpgPlan {
  targetId: PlayerId;
  slot: 0 | 1;
  startedAt: number;
  /** Seeded aim offset (within bots.rpg.aimErrorMetres) on the ground plane. */
  offset: Vec2;
  fired: boolean;
}

/** M2c: a quick smoke throw toward `aim` (no cook): select the smoke, press, release. */
export interface BotSmokePlan {
  aim: Vec3;
  startedAt: number;
  stage: 'swap' | 'press' | 'release';
  yaw: number | null;
  pitch: number | null;
}

/** M2b (drop.md): a bot's drop choice, fixed at the route reveal. */
export interface BotDropPlan {
  /** Loot spawn position (y = its support height). */
  target: Vec3;
  /** Index into map.lootSpawns, -1 when the fallback picked the nearest spawn to a random jump point. */
  spawn: number;
  /** Server ms the bot presses jump (already clamped to the jump window). */
  jumpAt: number;
  /** The manual-deploy decision was made (once, at drop.minFreefallMs). */
  deployDecided: boolean;
}

/** M2b: per-bot path-following state. */
export interface BotNavFollow {
  path: NavPath | null;
  idx: number;
  goal: Vec3 | null;
  plannedAt: number;
  replan: boolean;
  /** The last search found no path to `goal`. */
  unreachable: boolean;
  checkAt: number;
  checkPos: Vec2;
  wanted: boolean;
  stuck: number;
  detourUntil: number;
  detourDir: Vec2;
}

export function createNavFollow(): BotNavFollow {
  return {
    path: null,
    idx: 0,
    goal: null,
    plannedAt: -Infinity,
    replan: false,
    unreachable: false,
    checkAt: -Infinity,
    checkPos: { x: 0, z: 0 },
    wanted: false,
    stuck: 0,
    detourUntil: 0,
    detourDir: { x: 0, z: 0 },
  };
}

/** M2a: a planned grenade throw: swap to slot 3, cook cookMs, release toward `aim`. */
export interface BotThrowPlan {
  stage: 'swap' | 'cook';
  aim: Vec3;
  startedAt: number;
  /** Server ms the cook started (pin pulled), -1 before. */
  cookStartAt: number;
  yaw: number | null;
  pitch: number | null;
  /** REVIEW-M2a M3: the exhaustive search continued during the cook (null before the first solve). */
  search?: ThrowSearch | null;
}

export function createBotBrain(now: number, offsetMs: number, personality: BotPersonality = 'balanced'): BotBrain {
  return {
    personality,
    landedAt: -1,
    nextDecisionAt: now + offsetMs,
    targetId: null,
    targetVisible: false,
    lastSeenPos: null,
    firstSeenAt: 0,
    lastSeenAt: 0,
    trackingSince: 0,
    lookAt: null,
    lookUntil: 0,
    goal: null,
    sprint: false,
    lootId: null,
    lootPresses: 0,
    ignoredLoot: [],
    burstUntil: 0,
    pauseUntil: 0,
    strafeDir: 1,
    nextStrafeAt: 0,
    lastPos: { x: 0, z: 0 },
    wantedMove: false,
    detourUntil: 0,
    detourDir: { x: 0, z: 0 },
    jumpNext: false,
    wanderPoint: null,
    wanderPhase: -2,
    parity: false,
    pendingSlot: -1,
    pendingReload: false,
    pendingHeal: false,
    dropGoalChosen: false,
    holdUntil: 0,
    avoidPos: null,
    avoidUntil: 0,
    retreatUntil: 0,
    retreatCooldownUntil: 0,
    stanceWant: 'stand',
    stanceUntil: 0,
    throwPlan: null,
    nextGrenadeAt: 0,
    fleeUntil: 0,
    goalY: null,
    wanderY: null,
    dropPlan: null,
    nav: createNavFollow(),
    navActive: false,
    zoneLen: null,
    lootLen: [],
    lastSeenY: 0,
    throwSolvedAt: -Infinity,
    rpgPlan: null,
    nextRpgAt: 0,
    zoneUrgentPhase: -1,
    zoneRotatedPhase: -1,
    smokePlan: null,
    nextSmokeAt: 0,
  };
}

/** M2a: what a bot may see of a live grenade (position only; the fuse is not read). */
export interface BotGrenadeInfo {
  id: GrenadeId;
  ownerId: PlayerId;
  pos: Vec3;
}

export interface RecentShot {
  shooterId: PlayerId;
  origin: Vec3;
  at: number;
}

export interface BotEnv {
  now: number;
  balance: Balance;
  map: AnyMapData;
  ctx: MovementContext;
  /** All match participants (dead ones have alive = false). */
  players: readonly SimPlayer[];
  loot: readonly LootEntity[];
  zone: ZoneState | null;
  recentShots: readonly RecentShot[];
  /** M2a: live grenades (fleeing). Optional so M1 callers keep working. */
  grenades?: readonly BotGrenadeInfo[];
  /** M2b: the carrier route (aboard bots jump on their plan; null in drop-less Worlds). */
  route?: DropRoute | null;
  /** M2b (ADR 0005 §6): the indoor nav graph (MapRuntime.nav); null on the island (M1 steering). */
  nav?: NavGraph | null;
  /** M2b: the World's path cache and per-tick search budget (required with `nav`). */
  pathCache?: PathCache | null;
  navBudget?: NavBudget | null;
  /** M2c: live smoke clouds (opaque in every bot line-of-sight test). Absent = none. */
  smokes?: readonly SmokeCloudState[];
}

/** The nav parts of a BotEnv when the map has a graph. */
export interface BotNavEnv {
  nav: NavGraph;
  pathCache: PathCache;
  navBudget: NavBudget;
}

const navEnvOf = (env: BotEnv): BotNavEnv | null =>
  env.nav && env.pathCache && env.navBudget ? { nav: env.nav, pathCache: env.pathCache, navBudget: env.navBudget } : null;

const eyeOf = (p: SimPlayer, b: Balance): Vec3 => eyePoint(p.move.pos, p.move, b);
/** Aim point: feet + the stance hitbox height x aimHeightFraction (combat.md "Bots"). */
const chestOf = (p: SimPlayer, b: Balance): Vec3 => ({
  x: p.move.pos.x,
  y: p.move.pos.y + hitboxHeightOf(p.move, b) * botAi(b).aimHeightFraction,
  z: p.move.pos.z,
});
const distXZ = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from: Vec2, to: Vec2): number => Math.atan2(-(to.x - from.x), -(to.z - from.z));

/** A gun slot the bot fights with: loaded or with reserve ammo. The rpg is a special action (rpg.md), never counted. */
const usableSlot = (self: SimPlayer, i: 0 | 1, b: Balance): boolean => {
  const s = self.inv.slots[i];
  return !!s && s.weapon !== 'rpg' && (s.mag > 0 || self.inv.ammo[ammoFor(b, s.weapon)] > 0);
};

function hasUsableGun(self: SimPlayer, b: Balance): boolean {
  return usableSlot(self, 0, b) || usableSlot(self, 1, b);
}

/** M2c: a gun instance (id, level) for value comparisons. */
interface GunInst {
  weapon: GunId;
  level: ItemLevel;
}
const instOf = (s: WeaponSlotState | LootEntity): GunInst => ({
  weapon: ('weapon' in s ? s.weapon : s.item) as GunId,
  level: s.level ?? 1,
});

function gunScore(g: GunInst, b: Balance): number {
  return expectedBodyDps(effWeapon(b, g.weapon, g.level), botAi(b).gunScoreDistance, b.player.radius);
}

/**
 * Loot value of a gun: bots.weaponPrefs.<gun>.lootValue (the rpg: bots.rpg.lootValue) x levels.botValueMultiplier,
 * or null when the gun has no value entry.
 */
const prefValue = (g: GunInst, b: Balance): number | null => {
  const base = g.weapon === 'rpg' ? b.bots.rpg.lootValue : (b.bots.weaponPrefs?.[g.weapon]?.lootValue ?? null);
  return base === null ? null : base * levelValue(b, g.level);
};

/** True when gun `a` is worth more than gun `c` x factor (lootValue when both have one, else the M1 DPS score). */
function gunBetter(a: GunInst, c: GunInst, factor: number, b: Balance): boolean {
  const va = prefValue(a, b);
  const vc = prefValue(c, b);
  if (va !== null && vc !== null) return va > vc * factor;
  return gunScore(a, b) > gunScore(c, b) * factor;
}

/**
 * Does a bot aim down sights with this gun at this distance (bots.ads._note)? M2c: by the EFFECTIVE sight (a mounted
 * scope): 4x / 8x always, 2x / red dot / iron beyond ads.minRange.
 */
export function botWouldAds(gun: WeaponId, dist: number, b: Balance, scope: ScopeId | null = null): boolean {
  const sight = effectiveSight(b, gun, scope);
  if (sight === 'none') return false;
  return isScopeSight(sight) || dist > botM2a(b).ads.minRange;
}

/** Body DPS at a distance using the cone the bot will actually shoot with (ADS when botWouldAds). */
function botDps(s: WeaponSlotState, dist: number, b: Balance): number {
  const w = slotWeapon(b, s);
  const spread = botWouldAds(s.weapon, dist, b, s.scope ?? null) ? w.spreadDeg * w.adsSpreadMultiplier : w.spreadDeg;
  return expectedBodyDps(w, dist, b.player.radius, spread);
}

/** Carries a usable gun with an effective scope_4x / scope_8x (bots see up to bots.ads.scopedVisionRange). */
function hasUsableScope(self: SimPlayer, b: Balance): boolean {
  for (const i of [0, 1] as const) {
    const s = self.inv.slots[i];
    if (s && usableSlot(self, i, b) && isScopeSight(effectiveSight(b, s.weapon, s.scope ?? null))) return true;
  }
  return false;
}

/** M2c (smoke.md "Bots"): line of sight for bots: static colliders AND every live smoke cloud (closeSightRange aside). */
function botSees(env: BotEnv, a: Vec3, c: Vec3): boolean {
  if (!lineOfSight(env.ctx.colliders, env.map, a, c)) return false;
  const clouds = env.smokes;
  return !clouds || clouds.length === 0 || !segmentBlockedBySmoke(clouds, a, c, env.now, env.balance.items.smoke.cloud);
}

/** M2c: the melee value of a melee weapon (or fists) at a level (bots.melee.lootValue x levels.botValueMultiplier). */
const meleeValue = (m: MeleeSlotState | null, b: Balance): number =>
  m ? b.bots.melee.lootValue[m.weapon] * levelValue(b, m.level) : b.bots.melee.lootValue.fists;

/** M2c: the gun slot holding the rpg, else null. */
const rpgSlot = (self: SimPlayer): 0 | 1 | null =>
  self.inv.slots[0]?.weapon === 'rpg' ? 0 : self.inv.slots[1]?.weapon === 'rpg' ? 1 : null;

/** Sight range: bots.ads.scopedVisionRange while carrying a usable scoped gun, else bots.visionRange. */
export function botVisionRange(self: SimPlayer, b: Balance): number {
  return hasUsableScope(self, b) ? Math.max(b.bots.visionRange, botM2a(b).ads.scopedVisionRange) : b.bots.visionRange;
}

/** Distance within which a bot pulls the trigger with this weapon: lerp(falloffStart, falloffEnd, f), fists: range. */
export function botFireRange(weapon: WeaponId, b: Balance): number {
  const w = b.weapons[weapon];
  if (weapon === 'fists') return w.range;
  // M2c (melee.md "Bots"): swing when the target is within range x swingRangeFraction.
  if (isMeleeId(weapon)) return w.range * b.bots.melee.swingRangeFraction;
  const f = botTuning(b).fireRangeFalloffFraction;
  return Math.min(w.range, w.falloffStart + (w.falloffEnd - w.falloffStart) * f);
}

/** Longest fire range among the bot's usable guns (fists range when unarmed). */
function bestFireRange(self: SimPlayer, b: Balance): number {
  let r = self.inv.melee ? botFireRange(self.inv.melee.weapon, b) : b.weapons.fists.range;
  for (const i of [0, 1] as const) if (usableSlot(self, i, b)) r = Math.max(r, botFireRange(self.inv.slots[i]!.weapon, b));
  return r;
}

/** 0 during the loot phase, ramping to 1 with time since landing and with the tide phase. */
export function botEagerness(brain: BotBrain, now: number, zone: ZoneState | null, b: Balance): number {
  const t = botTuning(b);
  const p = t.personalities[brain.personality];
  const landed = brain.landedAt < 0 ? now : brain.landedAt;
  const since = (now - landed) / 1000 - t.lootPhaseSeconds * p.lootPhaseMultiplier;
  let e = since < 0 ? 0 : t.eagernessRampSeconds <= 0 ? 1 : Math.min(1, since / t.eagernessRampSeconds);
  if (zone && zone.phaseIndex > 0 && t.eagernessFullAtPhase > 0) e = Math.max(e, Math.min(1, zone.phaseIndex / t.eagernessFullAtPhase));
  return t.eagernessCurve === 1 ? e : e ** Math.max(0.01, t.eagernessCurve);
}

/** Distance within which this bot starts a fight (before the retaliation exception). */
export function botEngageRange(brain: BotBrain, self: SimPlayer, now: number, zone: ZoneState | null, b: Balance): number {
  const t = botTuning(b);
  const p = t.personalities[brain.personality];
  const armed = hasUsableGun(self, b);
  const full = armed ? Math.max(bestFireRange(self, b), t.minEngageRange) : t.lootPhaseEngageRange;
  const e = botEagerness(brain, now, zone, b);
  const r = t.lootPhaseEngageRange + (full - t.lootPhaseEngageRange) * e;
  return Math.min(botVisionRange(self, b), r * p.engageRangeMultiplier);
}

/** Deterministic per (bot, target) preference in [1 - spread, 1 + spread]. */
function pairBias(a: PlayerId, c: PlayerId, spread: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(c + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 15;
  const u = (h >>> 0) / 4294967296;
  return 1 + (u * 2 - 1) * spread;
}

/**
 * Best slot for a fight at distance `dist` (combat.md "Bots"): a usable gun whose bots.weaponPrefs band contains the
 * distance (highest lootValue wins), else the best expectedBodyDps with the cone the bot will use, else fists.
 */
export function bestSlotFor(self: SimPlayer, dist: number, b: Balance): SlotIndex {
  const prefs = b.bots.weaponPrefs;
  let banded: SlotIndex | null = null;
  let bandValue = -Infinity;
  let best: SlotIndex = FISTS_SLOT;
  let bestScore = 0;
  for (const i of [0, 1] as const) {
    if (!usableSlot(self, i, b)) continue;
    const s = self.inv.slots[i]!;
    const gun = s.weapon;
    const pref = prefs?.[gun];
    // scopes.md "Bots": a mounted scope stretches the band (maxRange x mountedMaxRangeMultiplier).
    const maxR = pref ? pref.maxRange * (s.scope ? b.bots.scopes.mountedMaxRangeMultiplier[s.scope] : 1) : 0;
    const value = pref ? pref.lootValue * levelValue(b, s.level ?? 1) : 0;
    if (pref && dist >= pref.minRange && dist <= maxR && value > bandValue) {
      banded = i;
      bandValue = value;
    }
    const sc = botDps(s, dist, b) + 1e-3;
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  return banded ?? best;
}

/** Slot index of the weaker gun when both are full, else null. */
function worstGunSlot(self: SimPlayer, b: Balance): 0 | 1 | null {
  const [a, c] = self.inv.slots;
  if (!a || !c) return null;
  return gunBetter(instOf(a), instOf(c), 1, b) ? 1 : 0;
}

/** Value of a pickup for this bot (0 = not wanted / would be refused). Scores come from botAi (balance.bots.ai). */
function lootValue(self: SimPlayer, l: LootEntity, b: Balance, ai: BotAi): number {
  const inv = self.inv;
  if (isGun(l.item)) {
    const g = instOf(l);
    // levels.md "Upgrade swap": the same gun at a lower level is replaced in place (L1 -> L2: 1.2 > 1.15).
    const same = upgradeSlotFor(inv, g.weapon, g.level);
    if (same !== null) return gunBetter(g, instOf(inv.slots[same]!), ai.gunUpgradeFactor, b) ? ai.lootScoreUpgradeGun : 0;
    const hasGun = inv.slots[0] !== null || inv.slots[1] !== null;
    if (!hasGun) return l.item === 'rpg' ? ai.lootScoreSecondGun : ai.lootScoreUnarmedGun;
    if (inv.slots[0] === null || inv.slots[1] === null) {
      // Don't carry two of the same gun when an empty slot could hold something else.
      if (inv.slots.some((s) => s?.weapon === l.item)) return ai.lootScoreDuplicateGun;
      return ai.lootScoreSecondGun;
    }
    const worst = worstGunSlot(self, b);
    if (worst === null) return 0;
    const cur = inv.slots[worst]!;
    return gunBetter(g, instOf(cur), ai.gunUpgradeFactor, b) ? ai.lootScoreUpgradeGun : 0;
  }
  if (isMeleeId(l.item)) {
    const v = b.bots.melee.lootValue[l.item] * levelValue(b, l.level ?? 1);
    return v > meleeValue(inv.melee, b) * ai.gunUpgradeFactor ? b.bots.melee.lootScoreMelee : 0;
  }
  if (isScopeId(l.item)) {
    // scopes.md "Bots": only when it would auto-mount on a carried gun; never into the pouch.
    return wouldMount(b, inv.slots[0], l.item) || wouldMount(b, inv.slots[1], l.item) ? b.bots.scopes.lootScoreScope : 0;
  }
  if (l.item === 'smoke') return inv.smokes < b.items.smoke.maxCarry ? b.bots.smoke.lootScoreSmoke : 0;
  if (isArmorId(l.item)) {
    if (!armorAccepted(self, l.item)) return 0;
    const it = b.items[l.item];
    return (it.slot === 'vest' ? ai.lootScoreVest : ai.lootScoreHelmet) + ai.lootScoreArmorPerTier * it.tier;
  }
  if (isGrenade(l.item)) return inv.grenades < b.items.grenade.maxCarry ? ai.lootScoreGrenade : 0;
  if (isAmmo(l.item)) {
    if (inv.ammo[l.item] >= b.items[l.item].maxCarry) return 0;
    const used = inv.slots.some((s) => s && ammoFor(b, s.weapon) === l.item);
    return used ? (inv.ammo[l.item] < b.items[l.item].pickupQty * 2 ? ai.lootScoreAmmoLow : ai.lootScoreAmmo) : 0;
  }
  if (isHeal(l.item)) {
    if (inv.heals[l.item] >= b.items[l.item].maxStack) return 0;
    return l.item === 'medkit' ? ai.lootScoreMedkit : ai.lootScoreBandage;
  }
  return 0;
}

interface ZoneInfo {
  urgent: boolean;
  safeCenter: Vec2;
  safeR: number;
}

/**
 * Zone state for this bot. Indoors (nav graph) the walk to the next circle is the path length to the bot's entry point
 * (maps.md §4 "Zone urgency uses path length"): measured under the search budget when `search` (decisions), at most
 * every bots.nav.replanMs; until one is known, the straight distance x BOT_NAV_AI.detourFactor.
 */
function zoneInfo(self: SimPlayer, env: BotEnv, brain?: BotBrain, search = false): ZoneInfo | null {
  const z = env.zone;
  if (!z) return null;
  const b = env.balance;
  const ai = botAi(b);
  const safeR = safeRadiusOf(z, b);
  const p = { x: self.move.pos.x, z: self.move.pos.z };
  const distOut = distXZ(p, z.targetCenter) - safeR;
  const dc = distXZ(p, z.center);
  const outsideCurrent = dc > z.radius;
  if (distOut <= 0 && !outsideCurrent) {
    // Hysteresis: a bot that rotated in stays "urgent" until it is a few metres inside, not on the line.
    if (brain && brain.zoneUrgentPhase === z.phaseIndex && distOut > -BOT_M2C_AI.zoneHysteresisMetres) {
      return { urgent: true, safeCenter: z.targetCenter, safeR };
    }
    if (brain) brain.zoneUrgentPhase = -1;
    return { urgent: false, safeCenter: z.targetCenter, safeR };
  }
  const timeLeftS = Math.max(0, z.phaseEndsAt - env.now) / 1000;
  let walk = Math.max(0, distOut);
  const n = navEnvOf(env);
  if (n && brain && distOut > 0) {
    const zl = brain.zoneLen;
    const fresh = !!zl && zl.phase === z.phaseIndex && env.now - zl.at < navTuning(b).replanMs;
    if (!fresh && search) {
      const e = zoneEntryPoint(p, { urgent: false, safeCenter: z.targetCenter, safeR }, botTuning(b), self.id, z.phaseIndex);
      const r = requestPath(n.nav, self.move.pos, { x: e.x, y: self.move.pos.y, z: e.z }, n.pathCache, n.navBudget, env.now);
      if (r !== 'wait') brain.zoneLen = { at: env.now, phase: z.phaseIndex, len: r ? r.length : distOut * BOT_NAV_AI.detourFactor };
    }
    const known = brain.zoneLen && brain.zoneLen.phase === z.phaseIndex ? brain.zoneLen.len : null;
    walk = known ?? distOut * BOT_NAV_AI.detourFactor;
  }
  const travelS = walk / b.movement.walkSpeed;
  let urgent = outsideCurrent || travelS * ai.zoneUrgencyFactor + ai.zoneUrgencyBufferS >= timeLeftS || z.shrinking;
  // Hysteresis (in-match stuck follow-up): once urgent in a phase, stay urgent until inside the safe circle. Without it
  // the estimate flips as the bot moves (toward the circle: not urgent -> back to loot; away: urgent again) and the bot
  // shuttles between the loot and the zone goal every decision.
  if (brain) {
    if (urgent) {
      brain.zoneUrgentPhase = z.phaseIndex;
      brain.zoneRotatedPhase = z.phaseIndex;
    }
    else if (brain.zoneUrgentPhase === z.phaseIndex) urgent = true;
  }
  return { urgent, safeCenter: z.targetCenter, safeR };
}

/** Radius of the next circle the bots treat as safe (targetRadius - zoneSafetyMargin, at least half of it). */
function safeRadiusOf(z: ZoneState, b: Balance): number {
  const margin = b.bots.zoneSafetyMargin;
  return Math.max(0, z.targetRadius - margin > z.targetRadius * 0.5 ? z.targetRadius - margin : z.targetRadius * 0.5);
}

/**
 * Nearest point a little inside the safe circle along the line to its centre (players rotate to the edge of the next
 * circle rather than all walking to its centre).
 */
function zoneEntryPoint(p: Vec2, zi: ZoneInfo, tun: BotTuning, botId: PlayerId, phase: number): Vec2 {
  const dx = p.x - zi.safeCenter.x;
  const dz = p.z - zi.safeCenter.z;
  const d = Math.hypot(dx, dz);
  const jitter = pairBias(botId, phase + 1000, 1) / 2; // deterministic per bot and phase, in [0, 1)
  const r = zi.safeR * Math.max(0, tun.zoneEntryFraction - tun.zoneEntrySpread * jitter);
  if (d <= r || d < 1e-6) return { x: zi.safeCenter.x, z: zi.safeCenter.z };
  return { x: zi.safeCenter.x + (dx / d) * r, z: zi.safeCenter.z + (dz / d) * r };
}

/** rpg.md "Bots": the target is near cover, grouped with another enemy, or (nearly) standing still. */
function rpgWorthy(self: SimPlayer, target: SimPlayer, env: BotEnv): boolean {
  const r = env.balance.bots.rpg;
  const tp = target.move.pos;
  if (Math.hypot(target.move.vel.x, target.move.vel.z) < r.stillSpeed) return true;
  for (const o of env.players) {
    if (o === self || o === target || !o.alive || o.dying || o.aboard) continue;
    if (Math.hypot(o.move.pos.x - tp.x, o.move.pos.z - tp.z) <= r.groupRadius) return true;
  }
  let cover = false;
  forEachColliderNear(env.ctx.colliders, tp.x, tp.z, r.coverRadius, (c) => {
    if (!cover && overlapsCircle(c, tp.x, tp.z, r.coverRadius)) cover = true;
  });
  return cover;
}

/**
 * smoke.md "Bots": with a smoke carried and the cooldown over, roll `chance` and plan a quick throw at the point
 * bots.smoke.throwDistance from the bot toward the attacker (the last damager, else `toward`).
 */
function maybeSmoke(brain: BotBrain, self: SimPlayer, env: BotEnv, rng: Rng, chance: number, toward: SimPlayer | null = null): void {
  const b = env.balance;
  const now = env.now;
  if (brain.smokePlan || brain.throwPlan || self.cook || self.inv.smokes <= 0 || now < brain.nextSmokeAt) return;
  const att = self.lastDamagedBy ? (env.players.find((o) => o.id === self.lastDamagedBy!.id) ?? null) : null;
  const src = att && att.alive ? att.move.pos : toward ? toward.move.pos : null;
  if (!src) return;
  if (!(rng.next() < chance)) return;
  const pos = self.move.pos;
  const dx = src.x - pos.x;
  const dz = src.z - pos.z;
  const d = Math.max(1e-6, Math.hypot(dx, dz));
  const k = b.bots.smoke.throwDistance / d;
  const ax = pos.x + dx * k;
  const az = pos.z + dz * k;
  brain.smokePlan = { aim: { x: ax, y: pos.y, z: az }, startedAt: now, stage: 'swap', yaw: null, pitch: null };
  brain.nextSmokeAt = now + b.bots.smoke.cooldownMs;
}

/** The loot E would take from `pos` (World.tryPickup: nearest in 3D within range; the later entity wins a tie). */
function nearestPickable(loot: readonly LootEntity[], pos: Vec3, range: number): LootEntity | null {
  let best: LootEntity | null = null;
  let bestD = range * range;
  for (const l of loot) {
    const d = (l.pos.x - pos.x) ** 2 + (l.pos.y - pos.y) ** 2 + (l.pos.z - pos.z) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = l;
    }
  }
  return best;
}

/** Periodic decision: perception, target, goals and one-shot actions. */
function decide(brain: BotBrain, self: SimPlayer, env: BotEnv, rng: Rng): void {
  const b = env.balance;
  const ai = botAi(b);
  const tun = botTuning(b);
  const pers = tun.personalities[brain.personality];
  const now = env.now;
  const pos = self.move.pos;
  const p2 = { x: pos.x, z: pos.z };

  // Stuck detection: wanted to move but barely moved since the last decision.
  const moved = distXZ(p2, brain.lastPos);
  const expected = b.movement.walkSpeed * (b.bots.decisionIntervalMs / 1000);
  if (brain.wantedMove && !brain.navActive && !self.move.dropping && moved < expected * ai.stuckFraction && now >= brain.detourUntil) {
    const a = rng.next() * Math.PI * 2;
    brain.detourDir = { x: Math.cos(a), z: Math.sin(a) };
    brain.detourUntil = now + ai.detourMs;
    brain.jumpNext = true;
  }
  brain.lastPos = p2;

  // M2b: aboard, or falling with a drop plan: botThink steers (dropInput).
  if (self.aboard || (self.move.dropping && brain.dropPlan)) {
    brain.sprint = false;
    return;
  }
  // Drop-less test Worlds (M1 spawn): steer toward the nearest gun reachable during the fall.
  if (self.move.dropping) {
    if (!brain.dropGoalChosen) {
      brain.dropGoalChosen = true;
      const fallS = Math.max(0, pos.y - 0) / b.movement.dropFallSpeed;
      const reach = fallS * b.movement.dropSteerSpeed;
      const claimed: Vec2[] = [];
      for (const o of env.players) {
        if (o !== self && o.alive && o.move.dropping && o.brain?.dropGoalChosen && o.brain.goal) claimed.push(o.brain.goal);
      }
      const spread = botTuning(b).dropSpreadRange;
      let best: LootEntity | null = null;
      let bestD = Infinity;
      for (const l of env.loot) {
        const d = distXZ(p2, l.pos);
        if (d > reach || d >= bestD || !isGun(l.item)) continue;
        if (claimed.some((c) => distXZ(c, l.pos) < spread)) continue;
        best = l;
        bestD = d;
      }
      brain.goal = best ? { x: best.pos.x, z: best.pos.z } : null;
      brain.lootId = best ? best.id : null;
    }
    brain.sprint = false;
    return;
  }
  if (brain.landedAt < 0) brain.landedAt = now;
  brain.goalY = null;
  const navEnv = navEnvOf(env);

  // Perception: the best visible enemy within engagement range (or one who just shot us).
  const eye = eyeOf(self, b);
  const fwdYaw = self.yaw;
  const halfFov = (b.bots.fovDeg * DEG2RAD) / 2;
  const engageR = botEngageRange(brain, self, now, env.zone, b);
  const attackerId =
    self.lastDamagedBy && now - self.lastDamagedBy.at <= tun.retaliateMs ? self.lastDamagedBy.id : null;
  const avoidR = tun.avoidRange * pers.engageRangeMultiplier * (1 - botEagerness(brain, now, env.zone, b));
  // Hurt with a heal in the pocket: only fight back, heal first.
  // Not while the tide is hurting us or once eagerness is full (late game: fight for the circle).
  const z0 = env.zone;
  const inTide = !!z0 && distXZ(p2, z0.center) > z0.radius;
  const healFirst =
    tun.healBeforeFightBelowHp > 0 &&
    self.hp < tun.healBeforeFightBelowHp &&
    !inTide &&
    botEagerness(brain, now, z0, b) < 1 &&
    chooseHeal(self.hp, self.inv.heals, b) !== null;
  let bestTarget: SimPlayer | null = null;
  let bestScore = Infinity;
  let currentOutOfRange = false;
  let avoid: SimPlayer | null = null;
  let avoidD = Infinity;
  const vision = botVisionRange(self, b);
  for (const o of env.players) {
    if (o.id === self.id || !o.alive || o.dying || o.move.dropping) continue;
    const d = distXZ(p2, o.move.pos);
    if (d > vision) continue;
    const isCurrent = o.id === brain.targetId;
    const retaliate = o.id === attackerId;
    const limit = isCurrent ? engageR * tun.disengageRangeFactor : engageR;
    const engageable = retaliate || (d <= limit && (!healFirst || (isCurrent && brain.targetVisible)));
    if (!engageable && isCurrent) currentOutOfRange = true;
    if (!engageable && d > avoidR) continue;
    const ang = Math.abs(wrapAngle(yawTo(p2, o.move.pos) - fwdYaw));
    if (ang > halfFov && !(isCurrent && brain.targetVisible)) continue;
    let score = Infinity;
    if (engageable) {
      let focus = 0;
      for (const q of env.players) {
        if (q !== self && q.alive && q.brain && q.brain.targetId === o.id && q.brain.targetVisible) focus++;
      }
      score = d * pairBias(self.id, o.id, tun.targetBiasSpread) * (1 + tun.focusPenalty * focus);
      if (isCurrent) score *= 0.7;
      if (retaliate) score *= 0.5;
    }
    if (score >= bestScore && (engageable || d >= avoidD)) continue;
    if (!botSees(env, eye, chestOf(o, b))) continue;
    if (engageable && score < bestScore) {
      bestTarget = o;
      bestScore = score;
    } else if (!engageable && d < avoidD) {
      avoid = o;
      avoidD = d;
    }
  }
  // Remembered for avoidMemoryMs: backing away turns the bot, the enemy leaves its FOV, and without the memory it
  // would walk straight back into view and dither on the spot.
  if (avoid) {
    brain.avoidPos = { x: avoid.move.pos.x, z: avoid.move.pos.z };
    brain.avoidUntil = now + BOT_M2B_AI.avoidMemoryMs;
  } else if (now >= brain.avoidUntil) {
    brain.avoidPos = null;
  }
  if (bestTarget) {
    if (brain.targetId !== bestTarget.id || !brain.targetVisible) {
      if (brain.targetId !== bestTarget.id || now - brain.lastSeenAt > b.bots.loseTargetMs) brain.firstSeenAt = now;
      brain.trackingSince = now;
    }
    brain.targetId = bestTarget.id;
    brain.targetVisible = true;
    brain.lastSeenAt = now;
    brain.lastSeenPos = { x: bestTarget.move.pos.x, z: bestTarget.move.pos.z };
    brain.lastSeenY = bestTarget.move.pos.y;
  } else {
    brain.targetVisible = false;
    if (brain.targetId !== null && (currentOutOfRange || now - brain.lastSeenAt > b.bots.loseTargetMs)) {
      brain.targetId = null;
      brain.lastSeenPos = null;
    }
  }

  // Hearing and damage direction: turn toward the source.
  if (!brain.targetVisible) {
    if (self.lastDamagedBy && now - self.lastDamagedBy.at <= b.bots.decisionIntervalMs * 2) {
      const att = env.players.find((o) => o.id === self.lastDamagedBy!.id);
      if (att && att.alive) {
        brain.lookAt = eyeOf(att, b);
        brain.lookUntil = now + b.bots.loseTargetMs;
      }
    } else {
      for (const s of env.recentShots) {
        if (s.shooterId === self.id) continue;
        if (Math.hypot(s.origin.x - pos.x, s.origin.z - pos.z) <= b.bots.hearingRange) {
          brain.lookAt = s.origin;
          brain.lookUntil = now + b.bots.loseTargetMs / 2;
          break;
        }
      }
    }
  }

  const zi = zoneInfo(self, env, brain, true);
  const target = brain.targetId !== null ? env.players.find((o) => o.id === brain.targetId) ?? null : null;
  const armed = hasUsableGun(self, b);
  brain.pendingSlot = -1;
  brain.pendingReload = false;
  brain.pendingHeal = false;
  brain.sprint = false;

  // Weapon management (not while a grenade, rocket or smoke plan is in progress).
  const activeSlot = self.inv.activeSlot;
  const heldGun = activeSlot === 0 || activeSlot === 1 ? self.inv.slots[activeSlot] : null;
  const rs = rpgSlot(self);
  const rpgEmpty = rs !== null && self.inv.slots[rs]!.mag === 0 && self.inv.ammo.ammo_rocket > 0;
  if (brain.throwPlan || self.cook || brain.rpgPlan || brain.smokePlan) {
    // The plan drives the slot.
  } else if (target && target.alive) {
    const d = distXZ(p2, target.move.pos);
    // melee.md "Bots": an empty mag with the target in close range: the melee weapon instead of reloading in its face.
    const best = bestSlotFor(self, d, b);
    const bestGun = best === 0 || best === 1 ? self.inv.slots[best] : null;
    const closeMelee =
      !!self.inv.melee && d <= b.bots.melee.closeSwitchRange && ((!!heldGun && heldGun.mag === 0) || (activeSlot === FISTS_SLOT && !!bestGun && bestGun.mag === 0));
    const want = closeMelee ? FISTS_SLOT : best;
    if (want !== activeSlot && self.swapRemainingMs <= 0 && (!self.reload || closeMelee)) brain.pendingSlot = want;
  } else if (activeSlot === GRENADE_SLOT) {
    brain.pendingSlot = bestSlotFor(self, ai.gunScoreDistance, b);
  } else if (rpgEmpty && activeSlot !== rs && !self.reload) {
    // rpg.md "Bots": out of combat, re-equip and reload an empty rpg (then swap back below).
    brain.pendingSlot = rs!;
  } else if (heldGun && heldGun.weapon === 'rpg' && heldGun.mag > 0) {
    const back = bestSlotFor(self, ai.gunScoreDistance, b);
    if (back !== activeSlot) brain.pendingSlot = back;
  } else if (activeSlot === FISTS_SLOT && armed) {
    brain.pendingSlot = bestSlotFor(self, ai.gunScoreDistance, b);
  } else if (heldGun) {
    const s = heldGun;
    if (s && s.mag === 0 && self.inv.ammo[ammoFor(b, s.weapon)] === 0) {
      brain.pendingSlot = bestSlotFor(self, ai.gunScoreDistance, b);
      if (brain.pendingSlot === self.inv.activeSlot) brain.pendingSlot = -1;
    } else if (
      s &&
      !target &&
      !self.reload &&
      !self.heal &&
      s.mag < b.weapons[s.weapon].magSize * ai.idleReloadFraction &&
      self.inv.ammo[ammoFor(b, s.weapon)] > 0
    ) {
      brain.pendingReload = true;
    }
  }

  // 2. Escape the tide.
  if (zi && zi.urgent) {
    brain.goal = zoneEntryPoint(p2, zi, tun, self.id, env.zone ? env.zone.phaseIndex : 0);
    brain.lootId = null;
    brain.retreatUntil = 0;
    brain.throwPlan = null;
    brain.rpgPlan = null;
    brain.stanceUntil = 0;
    brain.sprint = !brain.targetVisible;
    // smoke.md "Bots": escaping the zone after recent damage: smoke toward the attacker.
    if (now - self.lastHurtAt <= b.bots.smoke.recentDamageMs) {
      maybeSmoke(brain, self, env, rng, b.bots.smoke.zoneCrossThrowChance * pers.smokeChanceMultiplier);
    }
    return;
  }

  // 2a. Flee a visible live grenade (grenades.md "Bots": below the tide, above retreat).
  const m2a = botM2a(b);
  const danger = visibleGrenadeNear(self, env, m2a.grenade.fleeRadius);
  if (danger) {
    const ax = pos.x - danger.x;
    const az = pos.z - danger.z;
    const al = Math.hypot(ax, az);
    const ux = al > 1e-6 ? ax / al : Math.cos(self.yaw);
    const uz = al > 1e-6 ? az / al : -Math.sin(self.yaw);
    brain.goal = { x: pos.x + ux * (m2a.grenade.fleeRadius + 2), z: pos.z + uz * (m2a.grenade.fleeRadius + 2) };
    brain.fleeUntil = now + b.bots.decisionIntervalMs * 2;
    brain.lootId = null;
    brain.throwPlan = null;
    brain.stanceUntil = 0;
    brain.sprint = true;
    return;
  }
  brain.fleeUntil = 0;

  // 2c. Grenade a target that went behind cover (grenades.md "Bots").
  if (
    !brain.throwPlan &&
    self.inv.grenades > 0 &&
    target &&
    target.alive &&
    !brain.targetVisible &&
    brain.lastSeenPos &&
    now - brain.lastSeenAt <= m2a.grenade.coverMemoryMs &&
    now >= brain.nextGrenadeAt &&
    !self.reload &&
    !self.heal
  ) {
    const d = distXZ(p2, brain.lastSeenPos);
    if (d >= m2a.grenade.minRange && d <= m2a.grenade.maxRange) {
      const chance = m2a.grenade.throwChancePerDecision * pers.grenadeChanceMultiplier;
      if (rng.next() < chance) {
        const a = rng.next() * Math.PI * 2;
        const r = m2a.grenade.aimErrorMetres * Math.sqrt(rng.next());
        const ax = brain.lastSeenPos.x + Math.cos(a) * r;
        const az = brain.lastSeenPos.z + Math.sin(a) * r;
        brain.throwPlan = {
          stage: 'swap',
          aim: { x: ax, y: Math.max(0, heightAt(ax, az, env.map)), z: az },
          startedAt: now,
          cookStartAt: -1,
          yaw: null,
          pitch: null,
        };
        brain.nextGrenadeAt = now + m2a.grenade.cooldownMs;
      }
    }
  }
  if (brain.throwPlan) {
    brain.goal = null;
    brain.lootId = null;
    return;
  }

  // 2d. rpg.md "Bots": a rocket at a visible target that is in cover, grouped or standing still.
  if (!brain.rpgPlan && target && target.alive && brain.targetVisible && now >= brain.nextRpgAt && !self.reload && !self.heal) {
    const slot = rpgSlot(self);
    if (slot !== null && (self.inv.slots[slot]!.mag > 0 || self.inv.ammo.ammo_rocket > 0)) {
      const d = distXZ(p2, target.move.pos);
      const r = b.bots.rpg;
      if (d >= r.minRange && d <= r.maxRange && rpgWorthy(self, target, env)) {
        if (rng.next() < r.fireChancePerDecision * pers.grenadeChanceMultiplier) {
          const a = rng.next() * Math.PI * 2;
          const e = r.aimErrorMetres * Math.sqrt(rng.next());
          brain.rpgPlan = { targetId: target.id, slot, startedAt: now, offset: { x: Math.cos(a) * e, z: Math.sin(a) * e }, fired: false };
          brain.nextRpgAt = now + r.cooldownMs;
        }
      }
    }
  }
  if (brain.rpgPlan) {
    brain.goal = null;
    brain.lootId = null;
    return;
  }

  // 2b. Retreat to heal: hurt, carrying a heal, and facing an enemy (personality decides the threshold).
  const canHeal = chooseHeal(self.hp, self.inv.heals, b) !== null;
  if (
    target &&
    brain.targetVisible &&
    now >= brain.retreatCooldownUntil &&
    pers.retreatBelowHp > 0 &&
    self.hp < pers.retreatBelowHp &&
    canHeal
  ) {
    brain.retreatUntil = now + tun.retreatMs;
    brain.retreatCooldownUntil = now + tun.retreatMs * 3;
    // smoke.md "Bots": entering Retreat: smoke toward the attacker.
    maybeSmoke(brain, self, env, rng, b.bots.smoke.retreatThrowChance * pers.smokeChanceMultiplier, target);
  }
  if (now < brain.retreatUntil && brain.lastSeenPos) {
    const ax = pos.x - brain.lastSeenPos.x;
    const az = pos.z - brain.lastSeenPos.z;
    const al = Math.max(1e-6, Math.hypot(ax, az));
    brain.goal = { x: pos.x + (ax / al) * 10, z: pos.z + (az / al) * 10 };
    brain.lootId = null;
    brain.sprint = true;
    if (!brain.targetVisible && !self.heal && canHeal) brain.pendingHeal = true;
    return;
  }

  // 3. Engage: movement handled per tick around the target; out of sight, go to where it was last seen.
  const chasePos = brain.targetVisible && target ? { x: target.move.pos.x, z: target.move.pos.z } : brain.lastSeenPos;
  const meleeChaseOk = armed || distXZ(p2, target ? target.move.pos : p2) <= b.bots.melee.chaseRange;
  if (target && target.alive && chasePos && meleeChaseOk && (armed || !brain.targetVisible || distXZ(p2, target.move.pos) < b.bots.lootSearchRadius)) {
    if (armed || !hasUsableGun(target, b) || !nearestWantedLoot(brain, self, env)) {
      if (!brain.targetVisible && distXZ(p2, chasePos) < ai.arriveDistance) {
        // Reached the last known position without regaining sight: give up.
        brain.targetId = null;
        brain.lastSeenPos = null;
      } else if (!navEnv || brain.targetVisible) {
        brain.goal = { x: chasePos.x, z: chasePos.z };
        brain.goalY = brain.targetVisible && target ? target.move.pos.y : brain.lastSeenY;
        brain.lootId = null;
        return;
      } else {
        // maps.md §4: bots do not chase a target up a climb route; they fight from their layer (grenades, 2c) or
        // carry on looting / holding. A chase waits for the search budget like any other path.
        const r = requestPath(navEnv.nav, pos, { x: chasePos.x, y: brain.lastSeenY, z: chasePos.z }, navEnv.pathCache, navEnv.navBudget, now);
        if (r !== 'wait' && r !== null && r.climbs === 0) {
          brain.goal = { x: chasePos.x, z: chasePos.z };
          brain.goalY = brain.lastSeenY;
          brain.lootId = null;
          return;
        }
      }
    }
  }

  // 4. Heal when nothing is in sight.
  if (!brain.targetVisible && !self.heal && self.hp < b.bots.healBelowHp && canHeal) {
    brain.pendingHeal = true;
  }

  // 5. Loot. Indoors, loot the nav graph cannot reach is ignored (like loot that refuses pickup).
  if (navEnv && brain.lootId !== null && brain.nav.unreachable) {
    brain.ignoredLoot.push(brain.lootId);
    brain.lootId = null;
  }
  const l = nearestWantedLoot(brain, self, env);
  if (l) {
    if (brain.lootId !== l.id) {
      brain.lootId = l.id;
      brain.lootPresses = 0;
    }
    brain.goal = { x: l.pos.x, z: l.pos.z };
    brain.goalY = l.pos.y;
    brain.sprint = !self.heal;
    // Replacing a held gun: hold the weaker one first.
    if (isGun(l.item) && self.inv.slots[0] && self.inv.slots[1]) {
      const worst = worstGunSlot(self, b);
      if (worst !== null && self.inv.activeSlot !== worst && self.swapRemainingMs <= 0) brain.pendingSlot = worst;
    }
    return;
  }
  brain.lootId = null;

  // 5b. Back away from a nearby enemy we are not fighting (strongest early in the match).
  if (brain.avoidPos) {
    const ax = pos.x - brain.avoidPos.x;
    const az = pos.z - brain.avoidPos.z;
    const al = Math.max(1e-6, Math.hypot(ax, az));
    brain.goal = { x: pos.x + (ax / al) * 8, z: pos.z + (az / al) * 8 };
    return;
  }

  // 6. Wander: hold the current area while it is safe; otherwise (or when roaming) head into the next circle.
  const z = env.zone;
  if (z) {
    const safeR = zi ? zi.safeR : z.targetRadius;
    const inside = distXZ(p2, z.targetCenter) < safeR;
    const roam = brain.personality === 'aggressive' && botEagerness(brain, now, z, b) >= tun.roamEagerness;
    const holdR = Math.min(tun.holdWanderRadius, safeR * 0.3);
    const arrived =
      !!brain.wanderPoint &&
      distXZ(p2, brain.wanderPoint) < ai.arriveDistance * 2 &&
      (brain.wanderY === null || Math.abs(pos.y - brain.wanderY) <= BOT_NAV_AI.layerDy);
    if (arrived && brain.holdUntil === 0 && !roam) {
      brain.holdUntil = now + tun.holdPauseMs * (0.5 + rng.next());
    }
    const stale =
      !brain.wanderPoint ||
      brain.wanderPhase !== z.phaseIndex ||
      (arrived && now >= brain.holdUntil) ||
      (inside && distXZ(brain.wanderPoint, z.targetCenter) > safeR);
    if (stale) {
      brain.holdUntil = 0;
      brain.wanderY = null;
      const a = rng.next() * Math.PI * 2;
      const u = Math.sqrt(rng.next());
      // maps.md §4: cautious bots indoors prefer a plateau hold point inside the next circle.
      const plateau =
        inside &&
        !roam &&
        navEnv !== null &&
        brain.personality === 'cautious' &&
        pos.y <= BOT_NAV_AI.layerDy &&
        rng.next() < navTuning(b).plateauHoldChance
          ? plateauHoldPoint(navEnv, z.targetCenter, safeR * 0.9, pos, rng)
          : null;
      if (plateau) {
        brain.wanderPoint = { x: plateau.x, z: plateau.z };
        brain.wanderY = plateau.y;
      } else if (inside && !roam) {
        const d = holdR * u;
        let wx = pos.x + Math.cos(a) * d;
        let wz = pos.z + Math.sin(a) * d;
        const dc = Math.hypot(wx - z.targetCenter.x, wz - z.targetCenter.z);
        if (dc > safeR * 0.9) {
          const k = (safeR * 0.9) / dc;
          wx = z.targetCenter.x + (wx - z.targetCenter.x) * k;
          wz = z.targetCenter.z + (wz - z.targetCenter.z) * k;
        }
        brain.wanderPoint = { x: wx, z: wz };
      } else if (roam || !zi) {
        const d = safeR * ai.wanderFraction * u;
        brain.wanderPoint = { x: z.targetCenter.x + Math.cos(a) * d, z: z.targetCenter.z + Math.sin(a) * d };
      } else {
        // Outside the next circle but not urgent yet: hold here (the current circle is still safe) and rotate late.
        const j = holdR * u;
        brain.wanderPoint = { x: pos.x + Math.cos(a) * j, z: pos.z + Math.sin(a) * j };
      }
      brain.wanderPhase = z.phaseIndex;
      // maps.md §4: wander and hold points are reachable cells.
      if (navEnv && brain.wanderPoint && brain.wanderY === null) {
        const n = nearestNode(navEnv.nav, { x: brain.wanderPoint.x, y: pos.y, z: brain.wanderPoint.z });
        const q = n >= 0 ? nodePos(navEnv.nav, n) : null;
        // A snap that leaves the circle would make the point stale at once (endless re-rolls): keep the raw point then.
        if (q && (!inside || roam || Math.hypot(q.x - z.targetCenter.x, q.z - z.targetCenter.z) <= safeR)) {
          brain.wanderPoint = { x: q.x, z: q.z };
          if (Math.abs(q.y - pos.y) > BOT_NAV_AI.layerDy) brain.wanderY = q.y;
        }
      }
    }
    if (now < brain.holdUntil && now >= brain.lookUntil) {
      // Scan while holding.
      brain.lookAt = { x: pos.x + Math.cos(rng.next() * Math.PI * 2) * 10, y: pos.y, z: pos.z + Math.sin(rng.next() * Math.PI * 2) * 10 };
      brain.lookUntil = now + tun.holdPauseMs / 3;
    }
    brain.goal = brain.wanderPoint;
    brain.goalY = brain.wanderY;
  } else {
    brain.goal = null;
  }
}

/** A plateau cell inside the circle (centre, radius), the closest of a few seeded samples to the bot; null if none. */
function plateauHoldPoint(n: BotNavEnv, centre: Vec2, radius: number, pos: Vec3, rng: Rng): Vec3 | null {
  const plats = plateauNodes(n.nav);
  if (plats.length === 0) return null;
  let best: Vec3 | null = null;
  let bestD = Infinity;
  for (let i = 0; i < BOT_NAV_AI.plateauHoldSamples; i++) {
    const q = nodePos(n.nav, plats[Math.min(plats.length - 1, Math.floor(rng.next() * plats.length))]!);
    if (Math.hypot(q.x - centre.x, q.z - centre.z) > radius) continue;
    const d = Math.hypot(q.x - pos.x, q.z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Nearest live grenade within `radius` (XZ) that the bot can see, or null. */
function visibleGrenadeNear(self: SimPlayer, env: BotEnv, radius: number): Vec3 | null {
  const gs = env.grenades;
  if (!gs || gs.length === 0) return null;
  const b = env.balance;
  const pos = self.move.pos;
  const eye = eyeOf(self, b);
  const lift = b.items.grenade.losHeightOffset;
  let best: Vec3 | null = null;
  let bestD = radius;
  for (const g of gs) {
    const d = Math.hypot(g.pos.x - pos.x, g.pos.z - pos.z);
    if (d > bestD) continue;
    if (!botSees(env, eye, { x: g.pos.x, y: g.pos.y + lift, z: g.pos.z })) continue;
    best = g.pos;
    bestD = d;
  }
  return best;
}

/**
 * Pitch (radians) whose predicted grenade path ends closest to `aim` in XZ, with the fuse left after cooking `cookMs`.
 * Deterministic. REVIEW-M2a M3 (p95 < 1 ms, bots.test.ts): the search runs on a flat-ground emulation of the
 * stepGrenade rules (gravity, one bounce per tick with restitution and friction, rest below restSpeed) at the aim's
 * height, with no raycasts: the throw-pitch grid in throwPitchStepDeg, then a refine in throwPitchRefineDeg. Real arcs
 * (stepGrenade, the shared physics) then check the pick: when it still misses by more than lobMissMetres (cover or a
 * slope in the way), a bias-corrected pitch and the best high-arc lob are tried too, and the best real arc wins.
 */
export function solveThrowPitch(eye: Vec3, yaw: number, aim: Vec3, proneSettled: boolean, cookMs: number, ctx: MovementContext): number {
  return solveThrow(eye, yaw, aim, proneSettled, cookMs, ctx).deg * DEG2RAD;
}

/** Real XZ miss (m) of a throw at `deg`: the shared stepGrenade physics until the fuse ends or the grenade rests. */
function throwArcMiss(eye: Vec3, yaw: number, aim: Vec3, deg: number, proneSettled: boolean, fuse: number, ctx: MovementContext): { miss: number; along: number } {
  const dtS = 1 / ctx.balance.net.simHz;
  const maxTicks = Math.max(0, Math.ceil((fuse / 1000 + dtS) / dtS - 1e-9));
  const launch = throwLaunch(eye, yaw, deg * DEG2RAD, proneSettled, ctx);
  let body: GrenadeBody = { pos: launch.pos, vel: launch.vel, inWater: false };
  let left = fuse;
  for (let i = 0; i < maxTicks; i++) {
    body = stepGrenade(body, dtS, ctx).body;
    left -= dtS * 1000;
    if (left <= 1e-6) break;
    const v = body.vel;
    if (v.x === 0 && v.y === 0 && v.z === 0) break;
  }
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  return {
    miss: Math.hypot(body.pos.x - aim.x, body.pos.z - aim.z),
    along: (body.pos.x - aim.x) * fx + (body.pos.z - aim.z) * fz,
  };
}

/**
 * solveThrowPitch with the pick's real miss (degrees; seeds ThrowSearch) and the number of real arcs it ran (the
 * deterministic cost bound the tests check: 1 to 3).
 */
export function solveThrow(eye: Vec3, yaw: number, aim: Vec3, proneSettled: boolean, cookMs: number, ctx: MovementContext): { deg: number; miss: number; arcs: number } {
  const b = ctx.balance;
  const g = b.items.grenade;
  const ai = BOT_M2A_AI;
  const fuse = Math.max(0, g.fuseMs - cookMs);
  const dtS = 1 / b.net.simHz;
  const maxTicks = Math.max(0, Math.ceil((fuse / 1000 + dtS) / dtS - 1e-9));
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const aimAlong = (aim.x - eye.x) * fx + (aim.z - eye.z) * fz;
  const lo = g.throwPitchMinDeg;
  const hi = g.throwPitchMaxDeg;
  const ground = aim.y;
  const fric = 1 - g.friction;

  /** Along-track end distance of the emulated throw (flat ground at the aim's height). */
  const emulate = (deg: number): number => {
    const pr = deg * DEG2RAD;
    const speed = throwSpeedFor(pr, b) * (proneSettled ? g.throwSpeedProneMultiplier : 1);
    const lp = Math.min(89, deg + g.throwLiftDeg) * DEG2RAD;
    let h = Math.cos(pr) * g.throwOriginForward;
    let y = eye.y + Math.sin(pr) * g.throwOriginForward;
    let vh = speed * Math.cos(lp);
    let vy = speed * Math.sin(lp);
    let left = fuse;
    for (let i = 0; i < maxTicks; i++) {
      vy -= g.gravity * dtS;
      const ny = y + vy * dtS;
      if (ny < ground && vy < 0) {
        h += vh * dtS * ((y - ground) / (y - ny));
        y = ground + g.collisionRadius;
        vh *= fric;
        vy = -vy * g.restitution;
        if (Math.hypot(vh, vy) < g.restSpeed) return h;
      } else {
        h += vh * dtS;
        y = ny;
      }
      left -= dtS * 1000;
      if (left <= 1e-6) break;
    }
    return h;
  };
  const gridBest = (from: number, to: number): { deg: number; err: number } => {
    let deg = from;
    let err = Infinity;
    for (let d = from; d <= to + 1e-9; d += ai.throwPitchStepDeg) {
      const e = Math.abs(emulate(d) - aimAlong);
      if (e < err - 1e-9) {
        err = e;
        deg = d;
      }
    }
    const c = deg;
    for (let k = -4; k <= 4; k++) {
      const d = c + k * ai.throwPitchRefineDeg;
      if (k === 0 || d < lo || d > hi) continue;
      const e = Math.abs(emulate(d) - aimAlong);
      if (e < err - 1e-9) {
        err = e;
        deg = d;
      }
    }
    return { deg, err };
  };

  let arcs = 0;
  const real = (deg: number): { miss: number; along: number } => {
    arcs++;
    return throwArcMiss(eye, yaw, aim, deg, proneSettled, fuse, ctx);
  };

  const first = gridBest(lo, hi);
  let bestDeg = first.deg;
  const r0 = real(bestDeg);
  let bestMiss = r0.miss;
  if (bestMiss <= ai.lobMissMetres) return { deg: bestDeg, miss: bestMiss, arcs };
  const consider = (deg: number): void => {
    const d = Math.min(hi, Math.max(lo, deg));
    if (Math.abs(d - bestDeg) < 1e-9) return;
    const r = real(d);
    if (r.miss < bestMiss - 1e-9) {
      bestMiss = r.miss;
      bestDeg = d;
    }
  };
  // Bias-corrected: aim the emulation at (aim - the real along-track error), e.g. a slope the flat model ignores.
  const corrected = ((): number => {
    let deg = bestDeg;
    let err = Infinity;
    const target = aimAlong - r0.along;
    for (let d = Math.max(lo, bestDeg - ai.throwCorrectSpanDeg); d <= Math.min(hi, bestDeg + ai.throwCorrectSpanDeg) + 1e-9; d += ai.throwPitchRefineDeg) {
      const e = Math.abs(emulate(d) - target);
      if (e < err - 1e-9) {
        err = e;
        deg = d;
      }
    }
    return deg;
  })();
  if (!isIndoor(ctx.map)) {
    // Slopes only exist on the island; indoors the floor is flat, so a miss means cover and only the lob can help.
    consider(corrected);
    if (bestMiss <= ai.lobMissMetres) return { deg: bestDeg, miss: bestMiss, arcs };
  }
  // High arc over cover.
  if (first.deg + ai.lobMinSeparationDeg <= hi) consider(gridBest(first.deg + ai.lobMinSeparationDeg, hi).deg);
  return { deg: bestDeg, miss: bestMiss, arcs };
}

/**
 * REVIEW-M2a M3: the M2a exhaustive pitch search (real arcs on the throwPitchStepDeg grid, then +-4 x
 * throwPitchRefineDeg around the best), run a few arcs per tick while the bot cooks, starting from the fast
 * solveThrowPitch pick. The best real arc so far is always the answer, so a throw released early is still the fast
 * pick or better.
 */
export class ThrowSearch {
  bestDeg: number;
  bestMiss: number;
  /** Real arcs run so far (each step runs at most its `arcs` argument). */
  arcs = 0;
  private readonly queue: number[] = [];
  private refined = false;
  private readonly tried = new Set<number>();
  private readonly fuse: number;
  constructor(
    private readonly eye: Vec3,
    private readonly yaw: number,
    private readonly aim: Vec3,
    private readonly prone: boolean,
    cookMs: number,
    private readonly ctx: MovementContext,
    seedDeg: number,
    seedMiss: number,
  ) {
    const g = ctx.balance.items.grenade;
    this.fuse = Math.max(0, g.fuseMs - cookMs);
    this.bestDeg = seedDeg;
    this.bestMiss = seedMiss;
    this.tried.add(Math.round(seedDeg * 1000));
    for (let d = g.throwPitchMinDeg; d <= g.throwPitchMaxDeg + 1e-9; d += BOT_M2A_AI.throwPitchStepDeg) this.queue.push(d);
  }
  get done(): boolean {
    return this.refined && this.queue.length === 0;
  }
  /** Evaluates up to `arcs` real arcs; returns true when the search is complete. */
  step(arcs: number): boolean {
    let n = 0;
    while (n < arcs) {
      if (this.queue.length === 0) {
        if (this.refined) return true;
        this.refined = true;
        const g = this.ctx.balance.items.grenade;
        const c = this.bestDeg;
        for (let k = -4; k <= 4; k++) {
          const d = c + k * BOT_M2A_AI.throwPitchRefineDeg;
          if (k !== 0 && d >= g.throwPitchMinDeg - 1e-9 && d <= g.throwPitchMaxDeg + 1e-9) this.queue.push(d);
        }
        continue;
      }
      const d = this.queue.shift()!;
      const key = Math.round(d * 1000);
      if (this.tried.has(key)) continue;
      this.tried.add(key);
      n++;
      this.arcs++;
      const m = throwArcMiss(this.eye, this.yaw, this.aim, d, this.prone, this.fuse, this.ctx).miss;
      if (m < this.bestMiss - 1e-9) {
        this.bestMiss = m;
        this.bestDeg = d;
      }
    }
    return this.done;
  }
}

/** C/Z edge that moves a settled stance toward `want` (null when already there). */
function stanceToggleToward(cur: Stance, want: Stance): StanceRequest | null {
  if (cur === want) return null;
  if (want === 'stand') return cur === 'crouch' ? 'crouch' : 'prone';
  if (want === 'crouch') return 'crouch';
  return 'prone';
}

function nearestWantedLoot(brain: BotBrain, self: SimPlayer, env: BotEnv): LootEntity | null {
  const b = env.balance;
  const ai = botAi(b);
  const avoid = brain.avoidPos;
  const avoidR = avoid ? botTuning(b).avoidRange : 0;
  const pos = self.move.pos;
  const z = env.zone;
  const navEnv = navEnvOf(env);
  let best: LootEntity | null = null;
  let bestScore = 0;
  // Indoors, loot on another layer is scored by its path length (climb penalty included; maps.md §4). One unknown
  // length per call is measured, under the search budget, when its straight-line score could win.
  let pending: LootEntity | null = null;
  let pendingScore = 0;
  for (const l of env.loot) {
    const d = Math.hypot(l.pos.x - pos.x, l.pos.z - pos.z);
    if (d > b.bots.lootSearchRadius) continue;
    if (z && Math.hypot(l.pos.x - z.center.x, l.pos.z - z.center.z) > z.radius) continue;
    // After rotating in for this phase, loot outside the next circle would only pull the bot back out (and the tide
    // urgency straight back in): skip it until the next phase.
    if (z && brain.zoneRotatedPhase === z.phaseIndex && distXZ(l.pos, z.targetCenter) > safeRadiusOf(z, b) - BOT_M2C_AI.zoneHysteresisMetres) {
      continue;
    }
    if (brain.ignoredLoot.includes(l.id)) continue;
    // Contested loot: closer to a visible enemy than the avoid range (and not clearly ours).
    if (avoid && distXZ(avoid, l.pos) < avoidR && distXZ(avoid, l.pos) < d) continue;
    const v = lootValue(self, l, b, ai);
    if (v <= 0) continue;
    let dEff = d;
    if (navEnv && Math.abs(l.pos.y - pos.y) > BOT_NAV_AI.layerDy) {
      const known = brain.lootLen.find((e) => e.id === l.id && env.now - e.at < BOT_NAV_AI.lootLenMemoryMs);
      if (!known) {
        const upper = v / (1 + d / ai.lootDistanceFalloff);
        if (upper > pendingScore) {
          pendingScore = upper;
          pending = l;
        }
        continue;
      }
      if (!Number.isFinite(known.len)) continue;
      dEff = known.len;
    }
    const score = v / (1 + dEff / ai.lootDistanceFalloff);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  if (navEnv && pending && pendingScore > bestScore) {
    const r = requestPath(navEnv.nav, pos, pending.pos, navEnv.pathCache, navEnv.navBudget, env.now);
    if (r !== 'wait') {
      const len = r ? r.length : Infinity;
      brain.lootLen = brain.lootLen.filter((e) => e.id !== pending!.id && env.now - e.at < BOT_NAV_AI.lootLenMemoryMs);
      brain.lootLen.push({ id: pending.id, len, at: env.now });
      const score = Number.isFinite(len) ? lootValue(self, pending, b, ai) / (1 + len / ai.lootDistanceFalloff) : 0;
      if (score > bestScore) best = pending;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// M2b: carrier drop (drop.md "Bots: jump choice")
// ---------------------------------------------------------------------------------------------------------------

/**
 * Horizontal reach (m) of a fall that starts at y = fromY and lands at landY, over ground (terrain or floor, props
 * ignored) at groundY: freefall to the auto-deploy height, then the parachute (drop.md "Reach and time"). With
 * `deployAfterMs` the parachute opens after that much freefall instead (a manual early deploy).
 */
export function dropReach(fromY: number, groundY: number, landY: number, b: Balance, deployAfterMs?: number): number {
  const d = b.drop;
  const m = b.movement;
  const land = Math.min(landY, fromY);
  const deployY = Math.max(land, groundY + d.chuteDeployHeight);
  let ffS = Math.max(0, fromY - deployY) / d.freefallSpeed;
  if (deployAfterMs !== undefined) ffS = Math.min(ffS, Math.max(0, deployAfterMs) / 1000);
  const chuteFrom = fromY - ffS * d.freefallSpeed;
  if (deployAfterMs === undefined && land >= groundY + d.chuteDeployHeight) return ((fromY - land) / d.freefallSpeed) * d.freefallSteerSpeed;
  return ffS * d.freefallSteerSpeed + (Math.max(0, chuteFrom - land) / m.dropFallSpeed) * m.dropSteerSpeed;
}

/** The longer of the auto-deploy reach and the early-deploy reach (manual deploy at drop.minFreefallMs). */
export function maxDropReach(fromY: number, groundY: number, landY: number, b: Balance): number {
  const auto = dropReach(fromY, groundY, landY, b);
  if (!b.drop.manualDeploy) return auto;
  return Math.max(auto, dropReach(fromY, groundY, landY, b, b.drop.minFreefallMs));
}

/**
 * drop.md "Bots: jump choice". Writes `brain.dropPlan` for every bot (call once per match at the route reveal, bots in
 * id order, with the World's bot Rng). Candidates are loot spawns within auto-deploy reach x reachSafetyFraction of the
 * in-window route, weighted by tier (x the personality's epic multiplier). A candidate is skipped once
 * maxBotsPerTarget earlier picks lie within dropSpreadRange of it. Jump time = the carrier at the closest route point
 * + personality bias + uniform jitter, clamped to the part of the window from which the target stays within the
 * early-deploy reach x reachSafetyFraction, and to the window. No candidate: a random jump time and the loot spawn
 * nearest to that jump point. Humans never influence the picks.
 */
export function assignBotDrops(bots: readonly SimPlayer[], route: DropRoute, map: AnyMapData, b: Balance, rng: Rng): void {
  const dt = botDropTuning(b);
  const tun = botTuning(b);
  const ex = route.exit.x - route.entry.x;
  const ez = route.exit.z - route.entry.z;
  const total = Math.hypot(ex, ez);
  const dx = total > 1e-9 ? ex / total : 1;
  const dz = total > 1e-9 ? ez / total : 0;
  const speed = Math.max(1e-6, route.speed);
  const sAt = (t: number): number => ((t - route.startsAt) / 1000) * speed;
  const tAt = (sv: number): number => route.startsAt + (sv / speed) * 1000;
  const s0 = sAt(route.noJumpUntil);
  const s1 = Math.max(s0, sAt(route.ejectAt));
  const at = (sv: number): Vec2 => ({ x: route.entry.x + dx * sv, z: route.entry.z + dz * sv });
  const groundOf = (x: number, z: number): number => (isIndoor(map) ? 0 : heightAt(x, z, map));
  interface Cand { i: number; spawn: LootSpawn; target: Vec3; along: number; perp: number; reachMax: number; ok: boolean }
  const cands: Cand[] = map.lootSpawns.map((ls, i) => {
    const g = groundOf(ls.x, ls.z);
    const land = ls.y ?? g;
    const rx = ls.x - route.entry.x;
    const rz = ls.z - route.entry.z;
    const along = rx * dx + rz * dz;
    const perp = Math.abs(rx * dz - rz * dx);
    const near = at(Math.min(s1, Math.max(s0, along)));
    const d = Math.hypot(near.x - ls.x, near.z - ls.z);
    const reach = dropReach(route.altitude, g, land, b) * dt.reachSafetyFraction;
    return { i, spawn: ls, target: { x: ls.x, y: land, z: ls.z }, along, perp, reachMax: maxDropReach(route.altitude, g, land, b), ok: d <= reach };
  });
  const picks: Vec2[] = [];
  const ordered = [...bots].sort((p, q) => p.id - q.id);
  for (const bot of ordered) {
    const brain = bot.brain;
    if (!brain) continue;
    const pers = tun.personalities[brain.personality];
    const crowd = (c: Cand): number => {
      let n = 0;
      for (const q of picks) if (Math.hypot(q.x - c.target.x, q.z - c.target.z) < tun.dropSpreadRange) n++;
      return n;
    };
    const weightOf = (c: Cand): number =>
      Math.max(0, dt.tierWeights[c.spawn.tier] ?? 0) * (c.spawn.tier === 'epic' ? Math.max(0, pers.dropEpicWeightMultiplier) : 1);
    const eligible = cands.filter((c) => c.ok && weightOf(c) > 0 && crowd(c) < dt.maxBotsPerTarget);
    const sum = eligible.reduce((a, c) => a + weightOf(c), 0);
    let plan: BotDropPlan;
    if (eligible.length > 0 && sum > 0) {
      let x = rng.next() * sum;
      let pick = eligible[eligible.length - 1]!;
      for (const c of eligible) {
        x -= weightOf(c);
        if (x < 0) {
          pick = c;
          break;
        }
      }
      const closest = Math.min(s1, Math.max(s0, pick.along));
      let sv = closest + ((pers.jumpTimingBiasMs + rng.range(-dt.jumpJitterMs, dt.jumpJitterMs)) / 1000) * speed;
      const r = pick.reachMax * dt.reachSafetyFraction;
      if (pick.perp < r) {
        const half = Math.sqrt(r * r - pick.perp * pick.perp);
        const lo = Math.max(s0, pick.along - half);
        const hi = Math.min(s1, pick.along + half);
        if (lo <= hi) sv = Math.min(hi, Math.max(lo, sv));
      }
      sv = Math.min(s1, Math.max(s0, sv));
      plan = { target: pick.target, spawn: pick.i, jumpAt: tAt(sv), deployDecided: false };
    } else {
      const sv = s0 + rng.next() * (s1 - s0);
      const jp = at(sv);
      let best: Cand | null = null;
      let bestD = Infinity;
      for (const c of cands) {
        const d = Math.hypot(c.target.x - jp.x, c.target.z - jp.z);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      plan = {
        target: best ? best.target : { x: jp.x, y: groundOf(jp.x, jp.z), z: jp.z },
        spawn: best ? best.i : -1,
        jumpAt: tAt(sv),
        deployDecided: false,
      };
    }
    picks.push({ x: plan.target.x, z: plan.target.z });
    brain.dropPlan = plan;
  }
}

/** Camera-relative move for a world XZ direction (forward = (-sin, -cos), right = (cos, -sin)). */
function setMove(input: PlayerInput, mx: number, mz: number): void {
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  input.moveForward = mx * -sy + mz * -cy;
  input.moveRight = mx * cy + mz * -sy;
}

/** Aboard and falling with a plan: jump on time, steer straight at the target, deploy early when it is far. */
function dropInput(brain: BotBrain, plan: BotDropPlan, self: SimPlayer, env: BotEnv, input: PlayerInput, dt: number): PlayerInput {
  const b = env.balance;
  const now = env.now;
  const pos = self.move.pos;
  const ai = botAi(b);
  const tx = plan.target.x - pos.x;
  const tz = plan.target.z - pos.z;
  const d = Math.hypot(tx, tz);
  if (d > 1e-6) input.yaw = turnToward(self.yaw, Math.atan2(-tx, -tz), ai.idleTurnRate * dt);
  input.pitch = self.pitch + Math.max(-ai.idleTurnRate * dt, Math.min(ai.idleTurnRate * dt, -0.35 - self.pitch));
  if (self.aboard) {
    const route = env.route;
    input.jump = now >= plan.jumpAt && (!route || now >= route.noJumpUntil);
    return input;
  }
  const phase = self.move.dropPhase;
  const steer = phase === 'freefall' ? b.drop.freefallSteerSpeed : b.movement.dropSteerSpeed;
  const mag = d > 1e-6 ? Math.min(1, d / Math.max(1e-6, steer * dt)) : 0;
  if (mag > 0) setMove(input, (tx / d) * mag, (tz / d) * mag);
  if (phase === 'freefall' && !plan.deployDecided && b.drop.manualDeploy && self.move.dropMs >= b.drop.minFreefallMs) {
    plan.deployDecided = true;
    const ground = isIndoor(env.map) ? 0 : heightAt(pos.x, pos.z, env.map);
    const reach = dropReach(pos.y, ground, plan.target.y, b) * botDropTuning(b).reachSafetyFraction;
    if (d > reach) input.jump = true;
  }
  brain.goal = null;
  return input;
}

// ---------------------------------------------------------------------------------------------------------------
// M2b: indoor path following
// ---------------------------------------------------------------------------------------------------------------

export interface NavSteer {
  mx: number;
  mz: number;
  jump: boolean;
  /** false = no usable path (unreachable or not planned yet): the caller steers directly. */
  ok: boolean;
}

/**
 * One tick of path following toward `goal` on the nav graph (maps.md §4). Plans under the World's per-tick search
 * budget and replans when the goal moves, every bots.nav.replanMs and when stuck (a second stuck check in a row falls
 * back to the M1 random detour). Jumps where the next path point is a climb step and its face is right ahead.
 */
export function navSteer(f: BotNavFollow, pos: Vec3, grounded: boolean, goal: Vec3, n: BotNavEnv, now: number, b: Balance, rng: Rng): NavSteer {
  const ai = botAi(b);
  const nai = BOT_NAV_AI;
  const out: NavSteer = { mx: 0, mz: 0, jump: false, ok: true };
  const step = b.movement.stepHeight;

  // Once on a climb route the bot finishes it (a replan from a stair tread would lead off the stairs).
  // A bot that fell off the route (well below the last waypoint it reached) is no longer on it.
  // Committed also while heading for the route's first waypoint from close by (a replan mid-jump onto the first
  // step would otherwise start from the tread and walk the bot back down).
  const onRoute = (): boolean => {
    const p = f.path;
    if (!p || f.idx < 1 || f.idx >= p.points.length) return false;
    if (p.route[f.idx - 1] === true) return pos.y >= p.points[f.idx - 1]!.y - step - nai.layerDy;
    const q = p.points[f.idx]!;
    return p.route[f.idx] === true && Math.hypot(q.x - pos.x, q.z - pos.z) <= nai.routeCommitDistance;
  };

  // Stuck check (same rule as the M1 detour): wanted to move but barely moved over one decision interval. Off a
  // route: replan, and from the second check in a row also the M1 random detour. On a route: a missed jump, so jump
  // again; after routeStuckLimit checks the route is given up (replan and detour).
  if (now - f.checkAt >= b.bots.decisionIntervalMs) {
    const moved = Math.hypot(pos.x - f.checkPos.x, pos.z - f.checkPos.z);
    const expected = b.movement.walkSpeed * (b.bots.decisionIntervalMs / 1000) * ai.stuckFraction;
    if (f.wanted && Number.isFinite(f.checkAt) && moved < expected && now >= f.detourUntil) {
      f.stuck++;
      f.replan = true;
      out.jump = grounded;
      if ((!onRoute() && f.stuck >= 2) || f.stuck >= nai.routeStuckLimit) {
        const a = rng.next() * Math.PI * 2;
        f.detourDir = { x: Math.cos(a), z: Math.sin(a) };
        f.detourUntil = now + ai.detourMs;
      }
    } else if (moved >= expected) {
      f.stuck = 0;
    }
    f.checkAt = now;
    f.checkPos = { x: pos.x, z: pos.z };
  }
  f.wanted = true;
  if (now < f.detourUntil) {
    out.mx = f.detourDir.x;
    out.mz = f.detourDir.z;
    return out;
  }

  // Plan.
  const tun = navTuning(b);
  const midRoute = onRoute() && f.stuck < nai.routeStuckLimit;
  const goalMoved = !f.goal || Math.hypot(goal.x - f.goal.x, goal.y - f.goal.y, goal.z - f.goal.z) > nai.replanGoalDistance;
  const wantPlan = goalMoved || f.replan || now - f.plannedAt >= tun.replanMs || (!f.path && !f.unreachable);
  if (wantPlan && !midRoute) {
    const r = requestPath(n.nav, pos, goal, n.pathCache, n.navBudget, now);
    if (r !== 'wait') {
      f.path = r;
      f.goal = { x: goal.x, y: goal.y, z: goal.z };
      f.plannedAt = now;
      f.replan = false;
      f.unreachable = r === null;
      f.idx = 0;
      if (r && r.points.length > 1) {
        const p0 = r.points[0]!;
        if (Math.hypot(p0.x - pos.x, p0.z - pos.z) < nai.arriveRadius * 2) f.idx = 1;
      }
    } else if (goalMoved && f.path && f.goal && Math.hypot(goal.x - f.goal.x, goal.z - f.goal.z) > nai.replanGoalDistance * 4) {
      f.path = null; // the old path leads somewhere else entirely: steer directly until the search runs
    }
  }
  const path = f.path;
  if (!path) {
    out.ok = false;
    return out;
  }

  // Follow.
  const pts = path.points;
  const below = step + nai.arriveBelowMargin;
  while (f.idx < pts.length) {
    const q = pts[f.idx]!;
    const dq = Math.hypot(q.x - pos.x, q.z - pos.z);
    // On q's level: a climb step is not reached from below, a drop target not from the edge above it.
    const level = Math.abs(pos.y - q.y) <= below;
    let reached = dq < nai.arriveRadius && level;
    if (!reached && f.idx + 1 < pts.length && !path.jump[f.idx + 1] && dq < nai.arriveRadius * 3 && level) {
      // Overshot q sideways: already closer to the next point than q is.
      const r = pts[f.idx + 1]!;
      reached = Math.hypot(r.x - pos.x, r.z - pos.z) < Math.hypot(r.x - q.x, r.z - q.z);
    }
    if (!reached) break;
    f.idx++;
  }
  let tx: number;
  let tz: number;
  let jumpPoint = false;
  if (f.idx < pts.length) {
    const q = pts[f.idx]!;
    tx = q.x - pos.x;
    tz = q.z - pos.z;
    jumpPoint = path.jump[f.idx] === true && q.y - pos.y > step;
  } else {
    tx = goal.x - pos.x;
    tz = goal.z - pos.z;
    const sameLayer = Math.abs(goal.y - pos.y) <= nai.layerDy;
    // The path ends at the goal's snapped cell; a goal far from it is inside a prop or wall, so the end is arrival.
    const last = pts[pts.length - 1]!;
    const offGraph = Math.hypot(goal.x - last.x, goal.z - last.z) > nai.arriveRadius * 2;
    if (Math.hypot(tx, tz) <= ai.arriveDistance * 0.5 || !sameLayer || offGraph) {
      f.wanted = false;
      return out;
    }
  }
  const d = Math.hypot(tx, tz);
  if (d < 1e-6) return out;
  out.mx = tx / d;
  out.mz = tz / d;
  if (jumpPoint && grounded) {
    const o = { x: pos.x, y: pos.y + step + 0.05, z: pos.z };
    const hit = raycastColliders(navColliders(n.nav), o, { x: out.mx, y: 0, z: out.mz }, b.player.radius + nai.jumpFaceDistance);
    if (hit) out.jump = true;
  }
  return out;
}

/** Turn `from` toward `to` by at most maxStep (radians). */
function turnToward(from: number, to: number, maxStep: number): number {
  const d = wrapAngle(to - from);
  if (Math.abs(d) <= maxStep) return to;
  return from + Math.sign(d) * maxStep;
}

/** Sum of two uniforms in [-1, 1] / 2: a cheap bell-ish error in [-1, 1]. */
const bell = (rng: Rng): number => (rng.range(-1, 1) + rng.range(-1, 1)) / 2;

/**
 * One tick of bot control. Returns the PlayerInput for this tick (seq and dt are filled by the World).
 */
export function botThink(brain: BotBrain, self: SimPlayer, env: BotEnv, rng: Rng, dt: number): PlayerInput {
  const b = env.balance;
  const ai = botAi(b);
  const now = env.now;
  if (now >= brain.nextDecisionAt) {
    decide(brain, self, env, rng);
    brain.nextDecisionAt = now + b.bots.decisionIntervalMs;
  }
  brain.parity = !brain.parity;
  const pos = self.move.pos;
  const p2 = { x: pos.x, z: pos.z };

  const input: PlayerInput = {
    seq: 0,
    dt,
    moveForward: 0,
    moveRight: 0,
    yaw: self.yaw,
    pitch: self.pitch,
    sprint: false,
    fire: false,
    jump: false,
    reload: false,
    interact: false,
    useHeal: false,
    selectSlot: -1,
    ads: false,
    stanceToggle: null,
  };
  // M2b: aboard the carrier and the fall (drop.md). Without a plan a bot rides to the auto-eject.
  if (brain.dropPlan && (self.aboard || self.move.dropping)) return dropInput(brain, brain.dropPlan, self, env, input, dt);
  if (self.aboard) return input;
  const m2a = botM2a(b);
  const fleeing = now < brain.fleeUntil;
  const navEnv = navEnvOf(env);

  // Movement direction (world XZ, unit or zero).
  let mx = 0;
  let mz = 0;
  const target = brain.targetId !== null ? env.players.find((o) => o.id === brain.targetId) ?? null : null;
  const engaged = !!target && target.alive && !target.dying && brain.targetVisible && !self.move.dropping;
  const retreating = now < brain.retreatUntil || fleeing;
  let dist = Infinity;
  if (target) dist = distXZ(p2, target.move.pos);

  // Indoors the goal is reached along the nav graph (paths, climb routes, drops); the island steers straight.
  let navJump = false;
  brain.navActive = false;
  if (brain.goal && navEnv && !self.move.dropping) {
    const urgentFight = engaged && !retreating && !!zoneInfo(self, env, brain, false)?.urgent;
    if (!engaged || retreating || urgentFight) {
      const goal3 = { x: brain.goal.x, y: brain.goalY ?? pos.y, z: brain.goal.z };
      const r = navSteer(brain.nav, pos, self.move.grounded, goal3, navEnv, now, b, rng);
      if (r.ok) {
        mx = r.mx;
        mz = r.mz;
        navJump = r.jump;
        brain.navActive = true;
      }
    }
  }
  if (!brain.navActive) {
    brain.nav.wanted = false;
    brain.nav.checkAt = -Infinity;
  }
  if (brain.goal && !brain.navActive) {
    const dx = brain.goal.x - pos.x;
    const dz = brain.goal.z - pos.z;
    const d = Math.hypot(dx, dz);
    if (d > ai.arriveDistance * 0.5) {
      mx = dx / d;
      mz = dz / d;
    }
  }

  // Engagement movement: close in with short-range weapons, strafe otherwise.
  const weapon = activeWeapon(self.inv);
  const wb = b.weapons[weapon];
  const fireRange = botFireRange(weapon, b);
  const heldSlot = self.inv.activeSlot === 0 || self.inv.activeSlot === 1 ? self.inv.slots[self.inv.activeSlot] : null;
  const heldScope = heldSlot?.scope ?? null;
  const closeRange = weapon === 'fists' || isMeleeId(weapon);
  if (engaged && target && !retreating) {
    const zi = zoneInfo(self, env, brain, false);
    const tx = (target.move.pos.x - pos.x) / Math.max(dist, 1e-6);
    const tz = (target.move.pos.z - pos.z) / Math.max(dist, 1e-6);
    if (now >= brain.nextStrafeAt) {
      brain.strafeDir = rng.next() < 0.5 ? -1 : 1;
      brain.nextStrafeAt = now + b.bots.strafeChangeMs * (0.5 + rng.next());
      // M2a stance use (bots.stance): stop and crouch / go prone with a long gun at range.
      const chance = botTuning(b).personalities[brain.personality].stanceChance;
      const sight = wb.sight;
      if (chance > 0 && now >= brain.stanceUntil && dist >= m2a.stance.minRange && sight !== 'none' && sight !== 'iron') {
        if (rng.next() < chance) {
          const depth = stanceWaterDepth(env.map, pos);
          const prone = rng.next() < m2a.stance.proneShare && stanceAllowedAtDepth('prone', depth, b);
          const want: Stance = prone ? 'prone' : 'crouch';
          if (stanceAllowedAtDepth(want, depth, b)) {
            brain.stanceWant = want;
            brain.stanceUntil = now + m2a.stance.holdMs;
          }
        }
      }
    }
    const pref = isM2cGunId(weapon) ? b.bots.weaponPrefs?.[weapon] : undefined;
    const preferred = Math.min(
      fireRange,
      closeRange
        ? wb.range * 0.6
        : pref
          ? (pref.minRange + pref.maxRange) / 2
          : wb.falloffStart * ai.preferredRangeFraction,
    );
    let ax = 0;
    let az = 0;
    // maps.md §4: indoors a bot never closes in on a target standing on a higher layer (plateau); it fights from here.
    const above = !!navEnv && target.move.pos.y - pos.y > BOT_NAV_AI.layerDy;
    if (above) {
      // strafe only
    } else if (dist > preferred * 1.3 || dist > fireRange) {
      ax = tx;
      az = tz;
    } else if (dist < preferred * 0.4 && !closeRange && weapon !== 'shotgun' && weapon !== 'dbshotgun') {
      ax = -tx * 0.5;
      az = -tz * 0.5;
    }
    // Perpendicular strafe. M2c: none for melee and fists inside reach (orbiting a target at 2 m outruns the aim turn).
    const strafe = closeRange && dist <= fireRange ? 0 : 1;
    const sx = -tz * brain.strafeDir * strafe;
    const sz = tx * brain.strafeDir * strafe;
    let cx = ax + sx * 0.8;
    let cz = az + sz * 0.8;
    if (zi && zi.urgent && brain.goal) {
      cx = mx * 1.2 + sx * 0.4;
      cz = mz * 1.2 + sz * 0.4;
    }
    const cl = Math.hypot(cx, cz);
    mx = cl > 1e-6 ? cx / cl : 0;
    mz = cl > 1e-6 ? cz / cl : 0;
    if (now < brain.stanceUntil && !(zi && zi.urgent)) {
      mx = 0;
      mz = 0;
    }
  }
  // Leave a held stance early: target lost, tide urgent (decide), fleeing, or shot by someone the bot is not fighting.
  if (now < brain.stanceUntil) {
    const unseenHit =
      !!self.lastDamagedBy && self.lastDamagedBy.id !== brain.targetId && now - self.lastDamagedBy.at <= b.bots.decisionIntervalMs;
    if (!engaged || retreating || unseenHit) brain.stanceUntil = 0;
  }

  // Grenade throw plan: stand still, swap to slot 3, cook cookMs, release at the solved pitch.
  const plan = brain.throwPlan;
  let planFire: boolean | null = null;
  let planAim: { yaw: number; pitch: number } | null = null;
  if (plan) {
    mx = 0;
    mz = 0;
    if (now - plan.startedAt > BOT_M2A_AI.throwPlanTimeoutMs || self.move.dropping) {
      brain.throwPlan = null;
    } else if (plan.stage === 'swap') {
      planFire = false;
      if (self.inv.activeSlot !== GRENADE_SLOT) {
        if (self.inv.grenades <= 0) brain.throwPlan = null;
        else if (self.swapRemainingMs <= 0 && !self.cook) input.selectSlot = GRENADE_SLOT;
      } else if (self.inv.selectedThrowable !== 'grenade') {
        // M2c: the throwable slot holds a smoke selection: cycle to the frag first.
        if (self.inv.grenades <= 0) brain.throwPlan = null;
        else if (self.swapRemainingMs <= 0 && !self.smokeHeld) input.selectSlot = GRENADE_SLOT;
      } else if (
        self.swapRemainingMs <= 0 &&
        self.throwRecoveryMs <= 0 &&
        isStanceSettled(self.move) &&
        !self.prevFire &&
        // REVIEW-M2a M3: at most one pitch solve per tick across all bots; the others wait a tick.
        !env.players.some((o) => o !== self && o.brain !== null && o.brain.throwSolvedAt === now)
      ) {
        brain.throwSolvedAt = now;
        const eye = eyeOf(self, b);
        const yaw = yawTo(eye, plan.aim);
        const prone = self.move.stance === 'prone';
        plan.yaw = yaw;
        const first = solveThrow(eye, yaw, plan.aim, prone, m2a.grenade.cookMs, env.ctx);
        plan.pitch = first.deg * DEG2RAD;
        if (first.miss > BOT_M2A_AI.lobMissMetres) {
          plan.search = new ThrowSearch(eye, yaw, plan.aim, prone, m2a.grenade.cookMs, env.ctx, first.deg, first.miss);
        }
        plan.stage = 'cook';
        planFire = true;
      }
    } else {
      // Keep searching while cooking: throwRefineArcsPerTick arcs in the tick's one solve slot (shared by all bots).
      const search = plan.search;
      if (search && !search.done && !env.players.some((o) => o !== self && o.brain !== null && o.brain.throwSolvedAt === now)) {
        brain.throwSolvedAt = now;
        search.step(BOT_M2A_AI.throwRefineArcsPerTick);
        plan.pitch = search.bestDeg * DEG2RAD;
      }
      if (self.cook && plan.cookStartAt < 0) plan.cookStartAt = now;
      const cooked = plan.cookStartAt >= 0 && now - plan.cookStartAt >= m2a.grenade.cookMs;
      planFire = !cooked && (self.cook !== null || plan.cookStartAt < 0);
      if (!planFire && plan.cookStartAt >= 0) brain.throwPlan = null;
    }
    if (plan.yaw !== null && plan.pitch !== null) planAim = { yaw: plan.yaw, pitch: plan.pitch };
    else planAim = { yaw: yawTo(p2, plan.aim), pitch: 0 };
  }

  // M2c (rpg.md "Bots"): rocket plan: stand still, swap to the rpg, ADS, lead the target's feet, one shot, swap back.
  const rp = plan ? null : brain.rpgPlan;
  if (rp) {
    mx = 0;
    mz = 0;
    const tgt = env.players.find((o) => o.id === rp.targetId) ?? null;
    const slot = self.inv.slots[rp.slot];
    const r = b.bots.rpg;
    const rb = b.weapons.rpg.rocket;
    const done = rp.fired && self.lastShotWeapon === 'rpg';
    if (done || now - rp.startedAt > BOT_M2C_AI.rpgPlanTimeoutMs || !tgt || !tgt.alive || !slot || slot.weapon !== 'rpg' || self.move.dropping) {
      brain.rpgPlan = null;
      brain.pendingSlot = bestSlotFor(self, tgt ? distXZ(p2, tgt.move.pos) : ai.gunScoreDistance, b);
    } else if (self.inv.activeSlot !== rp.slot) {
      planFire = false;
      if (self.swapRemainingMs <= 0 && !self.cook) input.selectSlot = rp.slot;
    } else {
      const eye = eyeOf(self, b);
      const tp = tgt.move.pos;
      const flight = Math.hypot(tp.x - eye.x, tp.z - eye.z) / rb.speed;
      const ax = tp.x + tgt.move.vel.x * flight * r.leadFactor + rp.offset.x;
      const az = tp.z + tgt.move.vel.z * flight * r.leadFactor + rp.offset.z;
      const hx = ax - eye.x;
      const hz = az - eye.z;
      const hd = Math.hypot(hx, hz);
      const t = hd / rb.speed;
      // Gravity drop compensation (rocketPosAt: y - 0.5 g t^2).
      const yaw = Math.atan2(-hx, -hz);
      const pitch = Math.atan2(tp.y - eye.y + 0.5 * rb.gravity * t * t, hd);
      planAim = { yaw, pitch };
      const aimDir = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
      if (raycastStatic(env.ctx.colliders, env.map, eye, aimDir, r.selfSafeDistance)) {
        brain.rpgPlan = null;
        planFire = false;
      } else {
        input.ads = botWouldAds('rpg', hd, b, slot.scope ?? null);
        const aimed = Math.abs(wrapAngle(self.yaw - yaw)) < BOT_M2C_AI.rpgAimTolerance && Math.abs(self.pitch - pitch) < BOT_M2C_AI.rpgAimTolerance;
        const steady = !input.ads || adsProgressOf(self.move, 'rpg', b, slot.scope ?? null) >= 1;
        const ready = self.swapRemainingMs <= 0 && slot.mag > 0 && !self.reload;
        planFire = ready && aimed && steady && !self.prevFire;
        if (planFire) rp.fired = true;
      }
    }
  }

  // M2c (smoke.md "Bots"): quick smoke throw (no cook): select the smoke, press, release toward the planned point.
  const sp = plan || rp ? null : brain.smokePlan;
  if (sp) {
    // A quick throw: hold position for the half second it takes, so the cloud lands where it was planned.
    mx = 0;
    mz = 0;
    if (now - sp.startedAt > BOT_M2C_AI.smokePlanTimeoutMs || self.move.dropping || (self.inv.smokes <= 0 && sp.stage !== 'release')) {
      brain.smokePlan = null;
    } else if (sp.stage === 'swap') {
      planFire = false;
      if (self.inv.activeSlot !== GRENADE_SLOT) {
        if (self.swapRemainingMs <= 0 && !self.cook) input.selectSlot = GRENADE_SLOT;
      } else if (self.inv.selectedThrowable !== 'smoke') {
        if (self.swapRemainingMs <= 0 && !self.cook) input.selectSlot = GRENADE_SLOT;
      } else if (
        self.swapRemainingMs <= 0 &&
        self.throwRecoveryMs <= 0 &&
        isStanceSettled(self.move) &&
        !self.prevFire &&
        !env.players.some((o) => o !== self && o.brain !== null && o.brain.throwSolvedAt === now)
      ) {
        brain.throwSolvedAt = now;
        const eye = eyeOf(self, b);
        sp.yaw = yawTo(eye, sp.aim);
        // The frag solver with the cook that leaves the smoke fuse (same throw formula; smoke.md "Carrying and throwing").
        const cookMs = Math.max(0, b.items.grenade.fuseMs - b.items.smoke.fuseMs);
        sp.pitch = solveThrow(eye, sp.yaw, sp.aim, self.move.stance === 'prone', cookMs, env.ctx).deg * DEG2RAD;
        sp.stage = 'press';
      }
    } else if (sp.stage === 'press') {
      planFire = true;
      if (self.smokeHeld) sp.stage = 'release';
    } else {
      planFire = false;
      brain.smokePlan = null;
    }
    if (sp.yaw !== null && sp.pitch !== null) planAim = { yaw: sp.yaw, pitch: sp.pitch };
  }

  // Obstacle avoidance and stuck detour. A low obstacle (log, crate edge) under the probe gets a hop. Path following
  // has its own (navSteer).
  if (brain.navActive) {
    // nav graph steering
  } else if (now < brain.detourUntil) {
    mx = brain.detourDir.x;
    mz = brain.detourDir.z;
  } else if (mx !== 0 || mz !== 0) {
    const free = (dx: number, dz: number, h = ai.probeHeight): boolean => {
      const o = { x: pos.x, y: pos.y + h, z: pos.z };
      return raycastColliders(env.ctx.colliders, o, { x: dx, y: 0, z: dz }, ai.probeDistance) === null;
    };
    if (!free(mx, mz)) {
      const base = Math.atan2(mz, mx);
      const offsets = [0.6, -0.6, 1.2, -1.2, 1.8, -1.8];
      const sideFirst = brain.strafeDir;
      for (const o of offsets) {
        const a = base + o * sideFirst;
        const dx = Math.cos(a);
        const dz = Math.sin(a);
        if (free(dx, dz)) {
          mx = dx;
          mz = dz;
          break;
        }
      }
    } else if (self.move.grounded && !free(mx, mz, b.movement.stepHeight * 0.5)) {
      const o = { x: pos.x, y: pos.y + b.movement.stepHeight * 0.5, z: pos.z };
      const hit = raycastColliders(env.ctx.colliders, o, { x: mx, y: 0, z: mz }, ai.probeDistance);
      if (hit && hit.t < b.player.radius + 0.6 && hit.collider.top - pos.y > b.movement.stepHeight) brain.jumpNext = true;
    }
  }
  brain.wantedMove = mx !== 0 || mz !== 0;

  // Aim.
  const maxTurn = (engaged ? ai.combatTurnRate : ai.idleTurnRate) * dt;
  let desiredYaw = self.yaw;
  let desiredPitch = 0;
  if (engaged && target && !retreating) {
    const eye = eyeOf(self, b);
    const chest = chestOf(target, b);
    const hx = chest.x - eye.x;
    const hz = chest.z - eye.z;
    const hd = Math.hypot(hx, hz);
    desiredYaw = Math.atan2(-hx, -hz);
    desiredPitch = Math.atan2(chest.y - eye.y, hd);
    const selfMoving = Math.hypot(self.move.vel.x, self.move.vel.z) > b.combat.moveSpreadSpeedThreshold;
    const tgtMoving = Math.hypot(target.move.vel.x, target.move.vel.z) > b.combat.moveSpreadSpeedThreshold;
    let err = selfMoving || tgtMoving ? b.bots.aimErrorDegMoving : b.bots.aimErrorDeg;
    if (now - brain.trackingSince >= b.bots.aimSettleMs) err *= b.bots.aimSettleFactor;
    if (self.move.adsMs > 0) err *= m2a.ads.aimErrorMultiplier;
    desiredYaw += bell(rng) * err * DEG2RAD;
    desiredPitch += bell(rng) * err * DEG2RAD;
  } else if (brain.lookAt && now < brain.lookUntil && !retreating) {
    desiredYaw = yawTo(p2, brain.lookAt);
  } else if (mx !== 0 || mz !== 0) {
    desiredYaw = Math.atan2(-mx, -mz);
  }
  if (planAim) {
    desiredYaw = planAim.yaw;
    desiredPitch = planAim.pitch;
  }
  input.yaw = turnToward(self.yaw, desiredYaw, planAim ? ai.combatTurnRate * dt : maxTurn);
  const pitchTurn = planAim ? ai.combatTurnRate * dt : maxTurn;
  // ADR 0005 §9: the prone pitch clamp is a sim rule (World sanitize uses the same helper).
  const lim = pitchLimits(self.move, b);
  input.pitch = Math.min(lim.max, Math.max(lim.min, self.pitch + Math.max(-pitchTurn, Math.min(pitchTurn, desiredPitch - self.pitch))));

  // Camera-relative move: forward = (-sin, -cos), right = (cos, -sin).
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  input.moveForward = mx * -sy + mz * -cy;
  input.moveRight = mx * cy + mz * -sy;
  input.sprint = brain.sprint && (!engaged || retreating) && !plan && input.moveForward > 0.7;
  if (navJump && self.move.grounded) input.jump = true;
  if (brain.jumpNext && self.move.grounded) {
    input.jump = true;
    brain.jumpNext = false;
  }

  // ADS (bots.ads): scoped guns always while engaged, iron/red dot beyond ads.minRange (M2c: by the effective sight).
  const holdingGun = heldSlot !== null;
  if (engaged && target && !self.move.dropping && !retreating && !plan && !rp && !sp && holdingGun && dist <= fireRange) {
    input.ads = botWouldAds(weapon, dist, b, heldScope);
  }
  // Stance: hold the rolled stance while it lasts, otherwise get back up (only from a settled stance).
  if (isStanceSettled(self.move) && !self.move.dropping && self.move.grounded) {
    const want: Stance = now < brain.stanceUntil ? brain.stanceWant : 'stand';
    input.stanceToggle = stanceToggleToward(self.move.stance, want);
  }

  // Fire control: after the reaction delay, in bursts, only within the weapon's fire range.
  if (planFire !== null) {
    input.fire = planFire;
  } else if (self.inv.activeSlot === GRENADE_SLOT) {
    input.fire = false; // never cook outside a plan (a held cook is released)
  } else if (engaged && target && !self.move.dropping && !retreating) {
    const pers = botTuning(b).personalities[brain.personality];
    const reacted = now - brain.firstSeenAt >= b.bots.reactionMs * pers.reactionMultiplier;
    if (now >= brain.burstUntil && now >= brain.pauseUntil) {
      brain.burstUntil = now + b.bots.fireBurstMs;
      brain.pauseUntil = brain.burstUntil + b.bots.burstPauseMs;
    }
    // M2c: melee weapons swing on their cycle (the swing is the pacing), no burst pauses.
    const inBurst = now < brain.burstUntil || isMeleeId(weapon);
    const aimed = Math.abs(wrapAngle(input.yaw - desiredYaw)) < Math.max(maxTurn, 0.15);
    const scoped = isScopeSight(effectiveSight(b, weapon, heldScope));
    const steady = !scoped || adsProgressOf(self.move, weapon, b, heldScope) >= m2a.ads.scopedFireMinProgress;
    // The rpg only fires through its plan (rpg.md "Bots").
    if (reacted && inBurst && dist <= fireRange && aimed && steady && weapon !== 'rpg') {
      input.fire = wb.automatic ? true : brain.parity;
    }
  }

  // One-shot actions decided this period.
  if (input.selectSlot !== -1) {
    brain.pendingSlot = -1;
  } else if (
    brain.pendingSlot !== -1 &&
    brain.pendingSlot !== self.inv.activeSlot &&
    !brain.throwPlan &&
    !brain.rpgPlan &&
    !brain.smokePlan &&
    !self.cook &&
    !self.smokeHeld
  ) {
    input.selectSlot = brain.pendingSlot;
    brain.pendingSlot = -1;
  } else {
    brain.pendingSlot = -1;
  }
  if (brain.pendingReload) {
    input.reload = true;
    brain.pendingReload = false;
  }
  if (brain.pendingHeal && !input.fire && !self.heal) {
    input.useHeal = true;
    brain.pendingHeal = false;
  }

  // Pickup when close enough.
  if (brain.lootId !== null && !self.move.dropping && !engaged) {
    const l = env.loot.find((e) => e.id === brain.lootId);
    if (!l) {
      brain.lootId = null;
    } else {
      const d3 = Math.hypot(l.pos.x - pos.x, l.pos.y - pos.y, l.pos.z - pos.z);
      if (d3 <= b.player.pickupRange * ai.interactFraction && brain.parity) {
        // E takes the NEAREST item in reach (World.tryPickup): press only when that is the wanted one, so a gun just
        // dropped at the feet by a swap is not picked straight back up (M2c fix for swap churn).
        if (nearestPickable(env.loot, pos, b.player.pickupRange)?.id === l.id) input.interact = true;
        brain.lootPresses++;
        if (brain.lootPresses > ai.lootGiveUpPresses) {
          brain.ignoredLoot.push(l.id);
          brain.lootId = null;
        }
      }
    }
  }
  return input;
}
