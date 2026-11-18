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
import { ammoFor } from '../balance';
import { DEG2RAD, type Rng, wrapAngle } from '../math';
import type { BotPersonalityId, GunId, LootId, MapData, PlayerId, PlayerInput, SlotIndex, Vec2, Vec3, WeaponId, ZoneState } from '../types';
import { BOT_PERSONALITY_IDS, FISTS_SLOT } from '../types';
import { lineOfSight, raycastColliders } from './colliders';
import { expectedBodyDps } from './combat';
import { activeWeapon, chooseHeal, isAmmo, isGun, isHeal } from './inventory';
import type { LootEntity } from './loot';
import type { MovementContext } from './movement';
import type { SimPlayer } from './state';

/**
 * AI plumbing defaults (steering, probes, timers). Overridable per key from the optional `balance.bots.ai` block
 * (see BotAiBalance in src/shared/balance.ts); read them through `botAi(balance)`.
 */
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
  lootScoreVest: 50,
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
    aggressive: { share: 0.3, engageRangeMultiplier: 1.25, lootPhaseMultiplier: 0.8, reactionMultiplier: 0.85, retreatBelowHp: 0 },
    balanced: { share: 0.4, engageRangeMultiplier: 1, lootPhaseMultiplier: 1, reactionMultiplier: 1, retreatBelowHp: 45 },
    cautious: { share: 0.3, engageRangeMultiplier: 0.75, lootPhaseMultiplier: 1.3, reactionMultiplier: 1.15, retreatBelowHp: 60 },
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
    };
  }
  return out;
}

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
  /** Retreating (no fire, run away from the target) until this server ms. */
  retreatUntil: number;
  retreatCooldownUntil: number;
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
    retreatUntil: 0,
    retreatCooldownUntil: 0,
  };
}

export interface RecentShot {
  shooterId: PlayerId;
  origin: Vec3;
  at: number;
}

export interface BotEnv {
  now: number;
  balance: Balance;
  map: MapData;
  ctx: MovementContext;
  /** All match participants (dead ones have alive = false). */
  players: readonly SimPlayer[];
  loot: readonly LootEntity[];
  zone: ZoneState | null;
  recentShots: readonly RecentShot[];
}

const eyeOf = (p: SimPlayer, b: Balance): Vec3 => ({ x: p.move.pos.x, y: p.move.pos.y + b.player.eyeHeight, z: p.move.pos.z });
const chestOf = (p: SimPlayer, b: Balance): Vec3 => ({
  x: p.move.pos.x,
  y: p.move.pos.y + b.player.height * botAi(b).aimHeightFraction,
  z: p.move.pos.z,
});
const distXZ = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (from: Vec2, to: Vec2): number => Math.atan2(-(to.x - from.x), -(to.z - from.z));

function hasUsableGun(self: SimPlayer, b: Balance): boolean {
  for (const s of self.inv.slots) if (s && (s.mag > 0 || self.inv.ammo[ammoFor(b, s.weapon)] > 0)) return true;
  return false;
}

const usableSlot = (self: SimPlayer, i: 0 | 1, b: Balance): boolean => {
  const s = self.inv.slots[i];
  return !!s && (s.mag > 0 || self.inv.ammo[ammoFor(b, s.weapon)] > 0);
};

function gunScore(gun: GunId, b: Balance): number {
  return expectedBodyDps(b.weapons[gun], botAi(b).gunScoreDistance, b.player.radius);
}

/** Distance within which a bot pulls the trigger with this weapon: lerp(falloffStart, falloffEnd, f), fists: range. */
export function botFireRange(weapon: WeaponId, b: Balance): number {
  const w = b.weapons[weapon];
  if (weapon === 'fists') return w.range;
  const f = botTuning(b).fireRangeFalloffFraction;
  return Math.min(w.range, w.falloffStart + (w.falloffEnd - w.falloffStart) * f);
}

/** Longest fire range among the bot's usable guns (fists range when unarmed). */
function bestFireRange(self: SimPlayer, b: Balance): number {
  let r = b.weapons.fists.range;
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
  return Math.min(b.bots.visionRange, r * p.engageRangeMultiplier);
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

/** Best slot for a fight at distance `dist` (guns with ammo), else fists. */
function bestSlotFor(self: SimPlayer, dist: number, b: Balance): SlotIndex {
  let best: SlotIndex = FISTS_SLOT;
  let bestScore = 0;
  self.inv.slots.forEach((s, i) => {
    if (!s) return;
    if (s.mag <= 0 && self.inv.ammo[ammoFor(b, s.weapon)] <= 0) return;
    const sc = expectedBodyDps(b.weapons[s.weapon], dist, b.player.radius) + 1e-3;
    if (sc > bestScore) {
      bestScore = sc;
      best = i as SlotIndex;
    }
  });
  return best;
}

/** Slot index of the weaker gun when both are full, else null. */
function worstGunSlot(self: SimPlayer, b: Balance): 0 | 1 | null {
  const [a, c] = self.inv.slots;
  if (!a || !c) return null;
  return gunScore(a.weapon, b) <= gunScore(c.weapon, b) ? 0 : 1;
}

/** Value of a pickup for this bot (0 = not wanted / would be refused). Scores come from botAi (balance.bots.ai). */
function lootValue(self: SimPlayer, l: LootEntity, b: Balance, ai: BotAi): number {
  const inv = self.inv;
  if (isGun(l.item)) {
    const hasGun = inv.slots[0] !== null || inv.slots[1] !== null;
    if (!hasGun) return ai.lootScoreUnarmedGun;
    if (inv.slots[0] === null || inv.slots[1] === null) {
      // Don't carry two of the same gun when an empty slot could hold something else.
      if (inv.slots.some((s) => s?.weapon === l.item)) return ai.lootScoreDuplicateGun;
      return ai.lootScoreSecondGun;
    }
    const worst = worstGunSlot(self, b);
    if (worst === null) return 0;
    const cur = inv.slots[worst]!;
    return gunScore(l.item, b) > gunScore(cur.weapon, b) * ai.gunUpgradeFactor ? ai.lootScoreUpgradeGun : 0;
  }
  if (l.item === 'vest') return self.armor < Math.min(b.player.maxArmor, b.items.vest.armor) ? ai.lootScoreVest : 0;
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

function zoneInfo(self: SimPlayer, env: BotEnv): ZoneInfo | null {
  const z = env.zone;
  if (!z) return null;
  const b = env.balance;
  const ai = botAi(b);
  const margin = b.bots.zoneSafetyMargin;
  const safeR = Math.max(0, z.targetRadius - margin > z.targetRadius * 0.5 ? z.targetRadius - margin : z.targetRadius * 0.5);
  const p = { x: self.move.pos.x, z: self.move.pos.z };
  const distOut = distXZ(p, z.targetCenter) - safeR;
  const dc = distXZ(p, z.center);
  const outsideCurrent = dc > z.radius;
  if (distOut <= 0 && !outsideCurrent) return { urgent: false, safeCenter: z.targetCenter, safeR };
  const timeLeftS = Math.max(0, z.phaseEndsAt - env.now) / 1000;
  const travelS = Math.max(0, distOut) / b.movement.walkSpeed;
  const urgent = outsideCurrent || travelS * ai.zoneUrgencyFactor + ai.zoneUrgencyBufferS >= timeLeftS || z.shrinking;
  return { urgent, safeCenter: z.targetCenter, safeR };
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
  if (brain.wantedMove && !self.move.dropping && moved < expected * ai.stuckFraction && now >= brain.detourUntil) {
    const a = rng.next() * Math.PI * 2;
    brain.detourDir = { x: Math.cos(a), z: Math.sin(a) };
    brain.detourUntil = now + ai.detourMs;
    brain.jumpNext = true;
  }
  brain.lastPos = p2;

  // Drop: steer toward the nearest gun reachable during the fall.
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
  for (const o of env.players) {
    if (o.id === self.id || !o.alive || o.dying || o.move.dropping) continue;
    const d = distXZ(p2, o.move.pos);
    if (d > b.bots.visionRange) continue;
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
    if (!lineOfSight(env.ctx.colliders, env.map, eye, chestOf(o, b))) continue;
    if (engageable && score < bestScore) {
      bestTarget = o;
      bestScore = score;
    } else if (!engageable && d < avoidD) {
      avoid = o;
      avoidD = d;
    }
  }
  brain.avoidPos = avoid ? { x: avoid.move.pos.x, z: avoid.move.pos.z } : null;
  if (bestTarget) {
    if (brain.targetId !== bestTarget.id || !brain.targetVisible) {
      if (brain.targetId !== bestTarget.id || now - brain.lastSeenAt > b.bots.loseTargetMs) brain.firstSeenAt = now;
      brain.trackingSince = now;
    }
    brain.targetId = bestTarget.id;
    brain.targetVisible = true;
    brain.lastSeenAt = now;
    brain.lastSeenPos = { x: bestTarget.move.pos.x, z: bestTarget.move.pos.z };
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

  const zi = zoneInfo(self, env);
  const target = brain.targetId !== null ? env.players.find((o) => o.id === brain.targetId) ?? null : null;
  const armed = hasUsableGun(self, b);
  brain.pendingSlot = -1;
  brain.pendingReload = false;
  brain.pendingHeal = false;
  brain.sprint = false;

  // Weapon management.
  const active = activeWeapon(self.inv);
  if (target && target.alive) {
    const want = bestSlotFor(self, distXZ(p2, target.move.pos), b);
    if (want !== self.inv.activeSlot && self.swapRemainingMs <= 0 && !self.reload) brain.pendingSlot = want;
  } else if (active === 'fists' && armed) {
    brain.pendingSlot = bestSlotFor(self, ai.gunScoreDistance, b);
  } else if (active !== 'fists') {
    const s = self.inv.slots[self.inv.activeSlot as 0 | 1];
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
    brain.sprint = !brain.targetVisible;
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
  if (target && target.alive && chasePos && (armed || !brain.targetVisible || distXZ(p2, target.move.pos) < b.bots.lootSearchRadius)) {
    if (armed || activeWeapon(target.inv) === 'fists' || !nearestWantedLoot(brain, self, env)) {
      if (!brain.targetVisible && distXZ(p2, chasePos) < ai.arriveDistance) {
        // Reached the last known position without regaining sight: give up.
        brain.targetId = null;
        brain.lastSeenPos = null;
      } else {
        brain.goal = { x: chasePos.x, z: chasePos.z };
        brain.lootId = null;
        return;
      }
    }
  }

  // 4. Heal when nothing is in sight.
  if (!brain.targetVisible && !self.heal && self.hp < b.bots.healBelowHp && canHeal) {
    brain.pendingHeal = true;
  }

  // 5. Loot.
  const l = nearestWantedLoot(brain, self, env);
  if (l) {
    if (brain.lootId !== l.id) {
      brain.lootId = l.id;
      brain.lootPresses = 0;
    }
    brain.goal = { x: l.pos.x, z: l.pos.z };
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
    const arrived = !!brain.wanderPoint && distXZ(p2, brain.wanderPoint) < ai.arriveDistance * 2;
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
      const a = rng.next() * Math.PI * 2;
      const u = Math.sqrt(rng.next());
      if (inside && !roam) {
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
    }
    if (now < brain.holdUntil && now >= brain.lookUntil) {
      // Scan while holding.
      brain.lookAt = { x: pos.x + Math.cos(rng.next() * Math.PI * 2) * 10, y: pos.y, z: pos.z + Math.sin(rng.next() * Math.PI * 2) * 10 };
      brain.lookUntil = now + tun.holdPauseMs / 3;
    }
    brain.goal = brain.wanderPoint;
  } else {
    brain.goal = null;
  }
}

function nearestWantedLoot(brain: BotBrain, self: SimPlayer, env: BotEnv): LootEntity | null {
  const b = env.balance;
  const ai = botAi(b);
  const avoid = brain.avoidPos;
  const avoidR = avoid ? botTuning(b).avoidRange : 0;
  const pos = self.move.pos;
  const z = env.zone;
  let best: LootEntity | null = null;
  let bestScore = 0;
  for (const l of env.loot) {
    const d = Math.hypot(l.pos.x - pos.x, l.pos.z - pos.z);
    if (d > b.bots.lootSearchRadius) continue;
    if (z && Math.hypot(l.pos.x - z.center.x, l.pos.z - z.center.z) > z.radius) continue;
    if (brain.ignoredLoot.includes(l.id)) continue;
    // Contested loot: closer to a visible enemy than the avoid range (and not clearly ours).
    if (avoid && distXZ(avoid, l.pos) < avoidR && distXZ(avoid, l.pos) < d) continue;
    const v = lootValue(self, l, b, ai);
    if (v <= 0) continue;
    const score = v / (1 + d / ai.lootDistanceFalloff);
    if (score > bestScore) {
      bestScore = score;
      best = l;
    }
  }
  return best;
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
  };

  // Movement direction (world XZ, unit or zero).
  let mx = 0;
  let mz = 0;
  const target = brain.targetId !== null ? env.players.find((o) => o.id === brain.targetId) ?? null : null;
  const engaged = !!target && target.alive && !target.dying && brain.targetVisible && !self.move.dropping;
  const retreating = now < brain.retreatUntil;
  let dist = Infinity;
  if (target) dist = distXZ(p2, target.move.pos);

  if (brain.goal) {
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
  if (engaged && target && !retreating) {
    const zi = zoneInfo(self, env);
    const tx = (target.move.pos.x - pos.x) / Math.max(dist, 1e-6);
    const tz = (target.move.pos.z - pos.z) / Math.max(dist, 1e-6);
    if (now >= brain.nextStrafeAt) {
      brain.strafeDir = rng.next() < 0.5 ? -1 : 1;
      brain.nextStrafeAt = now + b.bots.strafeChangeMs * (0.5 + rng.next());
    }
    const preferred = Math.min(fireRange, weapon === 'fists' ? wb.range * 0.6 : wb.falloffStart * ai.preferredRangeFraction);
    let ax = 0;
    let az = 0;
    if (dist > preferred * 1.3 || dist > fireRange) {
      ax = tx;
      az = tz;
    } else if (dist < preferred * 0.4 && weapon !== 'fists' && weapon !== 'shotgun') {
      ax = -tx * 0.5;
      az = -tz * 0.5;
    }
    // Perpendicular strafe.
    const sx = -tz * brain.strafeDir;
    const sz = tx * brain.strafeDir;
    let cx = ax + sx * 0.8;
    let cz = az + sz * 0.8;
    if (zi && zi.urgent && brain.goal) {
      cx = mx * 1.2 + sx * 0.4;
      cz = mz * 1.2 + sz * 0.4;
    }
    const cl = Math.hypot(cx, cz);
    mx = cl > 1e-6 ? cx / cl : 0;
    mz = cl > 1e-6 ? cz / cl : 0;
  }

  // Obstacle avoidance and stuck detour. A low obstacle (log, crate edge) under the probe gets a hop.
  if (now < brain.detourUntil) {
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
    desiredYaw += bell(rng) * err * DEG2RAD;
    desiredPitch += bell(rng) * err * DEG2RAD;
  } else if (brain.lookAt && now < brain.lookUntil && !retreating) {
    desiredYaw = yawTo(p2, brain.lookAt);
  } else if (mx !== 0 || mz !== 0) {
    desiredYaw = Math.atan2(-mx, -mz);
  }
  input.yaw = turnToward(self.yaw, desiredYaw, maxTurn);
  input.pitch = self.pitch + Math.max(-maxTurn, Math.min(maxTurn, desiredPitch - self.pitch));

  // Camera-relative move: forward = (-sin, -cos), right = (cos, -sin).
  const sy = Math.sin(input.yaw);
  const cy = Math.cos(input.yaw);
  input.moveForward = mx * -sy + mz * -cy;
  input.moveRight = mx * cy + mz * -sy;
  input.sprint = brain.sprint && (!engaged || retreating) && input.moveForward > 0.7;
  if (brain.jumpNext && self.move.grounded) {
    input.jump = true;
    brain.jumpNext = false;
  }

  // Fire control: after the reaction delay, in bursts, only within the weapon's fire range.
  if (engaged && target && !self.move.dropping && !retreating) {
    const pers = botTuning(b).personalities[brain.personality];
    const reacted = now - brain.firstSeenAt >= b.bots.reactionMs * pers.reactionMultiplier;
    if (now >= brain.burstUntil && now >= brain.pauseUntil) {
      brain.burstUntil = now + b.bots.fireBurstMs;
      brain.pauseUntil = brain.burstUntil + b.bots.burstPauseMs;
    }
    const inBurst = now < brain.burstUntil;
    const aimed = Math.abs(wrapAngle(input.yaw - desiredYaw)) < Math.max(maxTurn, 0.15);
    if (reacted && inBurst && dist <= fireRange && aimed) {
      input.fire = wb.automatic ? true : brain.parity;
    }
  }

  // One-shot actions decided this period.
  if (brain.pendingSlot !== -1 && brain.pendingSlot !== self.inv.activeSlot) {
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
        input.interact = true;
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
