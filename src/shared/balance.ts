/**
 * Typed access to docs/design/balance.json. Owner: tech-lead (type + validation); game-designer owns the numbers.
 *
 * Unit rule from balance.json `_meta`: times are ms unless the key ends in `Seconds`; angles in degrees.
 * Every non-`?` key in `Balance` is REQUIRED; `?` keys are validated only when present. Adding keys to the JSON is free; removing or renaming one listed
 * here is a breaking change (validateBalance throws at startup and in tests).
 *
 * Code receives balance by injection (`createWorld({ balance })`, `ClientGame({ balance })`) so tests can
 * override numbers. Only composition roots (src/main.ts, server/index.ts) import BALANCE directly.
 */
import balanceJson from '../../docs/design/balance.json';
import type { AmmoId, BotPersonalityId, GunId, HealId, ItemId, LootTier, WeaponId } from './types';
import { AMMO_IDS, BOT_PERSONALITY_IDS, HEAL_IDS, WEAPON_IDS } from './types';

export interface WeaponBalance {
  damage: number;
  headshotMultiplier: number;
  fireIntervalMs: number;
  /** 0 for fists. */
  magSize: number;
  reloadMs: number;
  /** null for fists. */
  ammo: AmmoId | null;
  range: number;
  spreadDeg: number;
  pellets: number;
  automatic: boolean;
  falloffStart: number;
  falloffEnd: number;
  minDamageFactor: number;
  moveSpreadMultiplier: number;
}

export interface HealBalance {
  heal: number;
  healCap: number;
  useMs: number;
  maxStack: number;
  spawnQty: number;
  /**
   * M1-fix (optional; producer: game-designer; consumer: sim inventory.ts medkitPreferBelowHp). Only read on
   * `items.medkit`: Q picks a medkit over a bandage at or below this HP. Absent = player.maxHp / 2.
   */
  preferAtOrBelowHp?: number;
}

/**
 * M1-fix (optional section; producer: game-designer; consumer: src/game/tuning.ts resolveClientTuning).
 * Client presentation feel, not sim rules. Every key is optional; absent keys use DEFAULT_CLIENT_TUNING.
 * Key names match `ClientTuning` exactly.
 */
export interface ClientFeelBalance {
  /** Base look speed (radians per pixel), multiplied by Settings.mouseSensitivity. */
  mouseRadiansPerPixel?: number;
  cameraDistance?: number;
  /** Must stay < 0.6 (ARCHITECTURE.md §6 hitscan note). */
  cameraShoulderOffset?: number;
  cameraFovDeg?: number;
  orbitDistanceFactor?: number;
  orbitPitchDeg?: number;
  orbitDegPerSecond?: number;
  /** Reconciliation: corrections larger than this (m) snap. */
  correctionSnapDistance?: number;
  /** Reconciliation: visual offset decay time constant. */
  correctionDecayMs?: number;
  maxPendingInputs?: number;
  /** Metres per footstep. */
  footstepStrideWalk?: number;
  footstepStrideSprint?: number;
  animMoveSpeed?: number;
  maxFrameTravel?: number;
}

/**
 * M1-fix (optional `bots.ai` block; producer: game-designer; consumer: src/shared/sim/bots.ts BOT_AI defaults).
 * Bot steering constants. Every key optional; absent keys use BOT_AI. Unit rule applies (degrees, ms, `Seconds`).
 */
export interface BotAiBalance {
  /** Aim point height as a fraction of player.height. */
  aimHeightFraction?: number;
  /** Max yaw turn rate when not fighting (BOT_AI.idleTurnRate is rad/s; this is deg/s). */
  idleTurnDegPerSecond?: number;
  /** Max yaw/pitch tracking rate in a fight, deg/s. */
  combatTurnDegPerSecond?: number;
  probeDistance?: number;
  probeHeight?: number;
  stuckFraction?: number;
  detourMs?: number;
  arriveDistance?: number;
  interactFraction?: number;
  lootGiveUpPresses?: number;
  idleReloadFraction?: number;
  zoneUrgencyFactor?: number;
  /** BOT_AI.zoneUrgencyBufferS. */
  zoneUrgencyBufferSeconds?: number;
  wanderFraction?: number;
  gunScoreDistance?: number;
  preferredRangeFraction?: number;
  /**
   * Revision 1b: loot desirability scores (relative). The bot divides each by 1 + distance / lootDistanceFalloff.
   * Names match BOT_AI in src/shared/sim/bots.ts.
   */
  lootScoreUnarmedGun?: number;
  lootScoreSecondGun?: number;
  /** A second copy of a gun already carried while a slot is free. */
  lootScoreDuplicateGun?: number;
  /** Replacing the weaker gun with one that scores more than gunUpgradeFactor times better. */
  lootScoreUpgradeGun?: number;
  gunUpgradeFactor?: number;
  lootScoreVest?: number;
  /** Ammo for a carried gun while below two pickups' worth. */
  lootScoreAmmoLow?: number;
  lootScoreAmmo?: number;
  lootScoreMedkit?: number;
  lootScoreBandage?: number;
  /** Metres. */
  lootDistanceFalloff?: number;
}

/**
 * Revision 1b (optional `bots.personalities.<id>`; producer: game-designer; consumer: bots.ts botTuning).
 * Every key optional; absent keys use BOT_TUNING_DEFAULTS.personalities.
 */
export interface BotPersonalityBalance {
  /** Relative share of bots rolled with this personality. */
  share?: number;
  engageRangeMultiplier?: number;
  /** Multiplies bots.lootPhaseSeconds. */
  lootPhaseMultiplier?: number;
  /** Multiplies bots.reactionMs. */
  reactionMultiplier?: number;
  /** Retreat to heal below this HP when carrying a heal (0 = never). */
  retreatBelowHp?: number;
}

/**
 * Revision 1b (optional top-level `bots.*` pacing keys; producer: game-designer; consumer: bots.ts botTuning).
 * Names match BotTuning in src/shared/sim/bots.ts (see its doc comments for meaning); absent keys use
 * BOT_TUNING_DEFAULTS. Unit rule applies: `*Seconds` are seconds, `*Ms` are ms, ranges and radii are metres.
 */
export interface BotPacingBalance {
  lootPhaseSeconds?: number;
  lootPhaseEngageRange?: number;
  avoidRange?: number;
  dropSpreadRange?: number;
  eagernessRampSeconds?: number;
  eagernessFullAtPhase?: number;
  eagernessCurve?: number;
  fireRangeFalloffFraction?: number;
  minEngageRange?: number;
  disengageRangeFactor?: number;
  retaliateMs?: number;
  focusPenalty?: number;
  targetBiasSpread?: number;
  healBeforeFightBelowHp?: number;
  retreatMs?: number;
  holdWanderRadius?: number;
  holdPauseMs?: number;
  roamEagerness?: number;
  zoneEntryFraction?: number;
  zoneEntrySpread?: number;
  personalities?: Partial<Record<BotPersonalityId, BotPersonalityBalance>>;
}
export interface AmmoBalance { pickupQty: number; maxCarry: number }
export interface ZonePhaseBalance { waitSeconds: number; shrinkSeconds: number; radiusFraction: number; dps: number }

export interface Balance {
  match: {
    targetPlayers: number;
    minHumansToStart: number;
    countdownSeconds: number;
    resultsSeconds: number;
    dropHeight: number;
    maxPlayers: number;
    spawnJitter: number;
    killCreditWindowSeconds: number;
    deathScreenSeconds: number;
    endWhenNoHumansAlive: boolean;
    lastHumanDeathDelaySeconds: number;
  };
  player: {
    maxHp: number;
    maxArmor: number;
    radius: number;
    height: number;
    eyeHeight: number;
    pickupRange: number;
    headZoneFraction: number;
    /**
     * Revision 1b (optional; producer: game-designer). Local HP at or below this (and above 0) is "low health":
     * HUD stripes (via HudLocalView.lowHpThreshold) and the audio heartbeat (injected by main.ts). Absolute HP.
     */
    lowHpThreshold?: number;
  };
  movement: {
    walkSpeed: number;
    sprintSpeed: number;
    airControl: number;
    jumpVelocity: number;
    gravity: number;
    accel: number;
    friction: number;
    waterSpeedMultiplier: number;
    waterDepthThreshold: number;
    fallDamageMinSpeed: number;
    fallDamagePerMs: number;
    terminalVelocity: number;
    stepHeight: number;
    healMoveMultiplier: number;
    dropFallSpeed: number;
    dropSteerSpeed: number;
  };
  combat: {
    swapMs: number;
    airSpreadMultiplier: number;
    moveSpreadSpeedThreshold: number;
    deathDropScatter: number;
  };
  weapons: Record<WeaponId, WeaponBalance>;
  items: Record<HealId, HealBalance> & Record<AmmoId, AmmoBalance> & { vest: { armor: number } };
  armor: { absorbFraction: number };
  loot: {
    /** Relative weights per tier; missing item = weight 0. */
    tiers: Record<LootTier, Partial<Record<ItemId, number>>>;
    extraAmmoWithWeapon: number;
    spawnChance: number;
    weaponSpawnsWithFullMag: boolean;
    extraAmmoScatter: number;
    pickupBobHeight: number;
  };
  zone: {
    damageTickMs: number;
    startRadius: number;
    ignoresArmor: boolean;
    landCheckMinHeight: number;
    landCheckMaxTries: number;
    phases: ZonePhaseBalance[];
    finalCollapseDelaySeconds: number;
    finalCollapseSeconds: number;
    finalCollapseDps: number;
    warningSecondsBeforeShrink: number;
  };
  bots: BotPacingBalance & {
    reactionMs: number;
    aimErrorDeg: number;
    aimErrorDegMoving: number;
    aimSettleMs: number;
    aimSettleFactor: number;
    visionRange: number;
    fovDeg: number;
    hearingRange: number;
    fireBurstMs: number;
    burstPauseMs: number;
    lootSearchRadius: number;
    decisionIntervalMs: number;
    loseTargetMs: number;
    strafeChangeMs: number;
    healBelowHp: number;
    zoneSafetyMargin: number;
    /** M1-fix: optional steering constants (see BotAiBalance). */
    ai?: BotAiBalance;
  };
  net: {
    simHz: number;
    snapshotHz: number;
    inputHz: number;
    interpolationDelayMs: number;
  };
  /** M1-fix: optional client feel section (see ClientFeelBalance). */
  clientFeel?: ClientFeelBalance;
}

type Kind = 'number' | 'boolean';
const N: Kind = 'number';
const B: Kind = 'boolean';

const SECTION_SPEC: Record<string, Record<string, Kind>> = {
  match: {
    targetPlayers: N, minHumansToStart: N, countdownSeconds: N, resultsSeconds: N, dropHeight: N, maxPlayers: N,
    spawnJitter: N, killCreditWindowSeconds: N, deathScreenSeconds: N, endWhenNoHumansAlive: B,
    lastHumanDeathDelaySeconds: N,
  },
  player: { maxHp: N, maxArmor: N, radius: N, height: N, eyeHeight: N, pickupRange: N, headZoneFraction: N },
  movement: {
    walkSpeed: N, sprintSpeed: N, airControl: N, jumpVelocity: N, gravity: N, accel: N, friction: N,
    waterSpeedMultiplier: N, waterDepthThreshold: N, fallDamageMinSpeed: N, fallDamagePerMs: N, terminalVelocity: N,
    stepHeight: N, healMoveMultiplier: N, dropFallSpeed: N, dropSteerSpeed: N,
  },
  combat: { swapMs: N, airSpreadMultiplier: N, moveSpreadSpeedThreshold: N, deathDropScatter: N },
  armor: { absorbFraction: N },
  loot: { extraAmmoWithWeapon: N, spawnChance: N, weaponSpawnsWithFullMag: B, extraAmmoScatter: N, pickupBobHeight: N },
  zone: {
    damageTickMs: N, startRadius: N, ignoresArmor: B, landCheckMinHeight: N, landCheckMaxTries: N,
    finalCollapseDelaySeconds: N, finalCollapseSeconds: N, finalCollapseDps: N, warningSecondsBeforeShrink: N,
  },
  bots: {
    reactionMs: N, aimErrorDeg: N, aimErrorDegMoving: N, aimSettleMs: N, aimSettleFactor: N, visionRange: N, fovDeg: N,
    hearingRange: N, fireBurstMs: N, burstPauseMs: N, lootSearchRadius: N, decisionIntervalMs: N, loseTargetMs: N,
    strafeChangeMs: N, healBelowHp: N, zoneSafetyMargin: N,
  },
  net: { simHz: N, snapshotHz: N, inputHz: N, interpolationDelayMs: N },
};

const WEAPON_SPEC: Record<string, Kind> = {
  damage: N, headshotMultiplier: N, fireIntervalMs: N, magSize: N, reloadMs: N, range: N, spreadDeg: N, pellets: N,
  automatic: B, falloffStart: N, falloffEnd: N, minDamageFactor: N, moveSpreadMultiplier: N,
};

/** M1-fix: keys allowed in the optional sections. Each one present must be a finite number. */
const CLIENT_FEEL_KEYS: readonly (keyof ClientFeelBalance)[] = [
  'mouseRadiansPerPixel', 'cameraDistance', 'cameraShoulderOffset', 'cameraFovDeg', 'orbitDistanceFactor',
  'orbitPitchDeg', 'orbitDegPerSecond', 'correctionSnapDistance', 'correctionDecayMs', 'maxPendingInputs',
  'footstepStrideWalk', 'footstepStrideSprint', 'animMoveSpeed', 'maxFrameTravel',
];
const BOT_AI_KEYS: readonly (keyof BotAiBalance)[] = [
  'aimHeightFraction', 'idleTurnDegPerSecond', 'combatTurnDegPerSecond', 'probeDistance', 'probeHeight',
  'stuckFraction', 'detourMs', 'arriveDistance', 'interactFraction', 'lootGiveUpPresses', 'idleReloadFraction',
  'zoneUrgencyFactor', 'zoneUrgencyBufferSeconds', 'wanderFraction', 'gunScoreDistance', 'preferredRangeFraction',
  'lootScoreUnarmedGun', 'lootScoreSecondGun', 'lootScoreDuplicateGun', 'lootScoreUpgradeGun', 'gunUpgradeFactor',
  'lootScoreVest', 'lootScoreAmmoLow', 'lootScoreAmmo', 'lootScoreMedkit', 'lootScoreBandage', 'lootDistanceFalloff',
];
const BOT_PACING_KEYS: readonly Exclude<keyof BotPacingBalance, 'personalities'>[] = [
  'lootPhaseSeconds', 'lootPhaseEngageRange', 'avoidRange', 'dropSpreadRange', 'eagernessRampSeconds',
  'eagernessFullAtPhase', 'eagernessCurve', 'fireRangeFalloffFraction', 'minEngageRange', 'disengageRangeFactor',
  'retaliateMs', 'focusPenalty', 'targetBiasSpread', 'healBeforeFightBelowHp', 'retreatMs', 'holdWanderRadius',
  'holdPauseMs', 'roamEagerness', 'zoneEntryFraction', 'zoneEntrySpread',
];
const BOT_PERSONALITY_KEYS: readonly (keyof BotPersonalityBalance)[] = [
  'share', 'engageRangeMultiplier', 'lootPhaseMultiplier', 'reactionMultiplier', 'retreatBelowHp',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws an Error listing every missing/mistyped required key. Returns the input typed as Balance. */
export function validateBalance(raw: unknown): Balance {
  const errors: string[] = [];
  const check = (obj: unknown, path: string, spec: Record<string, Kind>): void => {
    if (!isObj(obj)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const [key, kind] of Object.entries(spec)) {
      if (typeof obj[key] !== kind) errors.push(`${path}.${key} must be a ${kind}`);
    }
  };
  if (!isObj(raw)) throw new Error('balance.json: root must be an object');

  for (const [section, spec] of Object.entries(SECTION_SPEC)) check(raw[section], section, spec);

  const weapons = raw['weapons'];
  for (const id of WEAPON_IDS) {
    const w = isObj(weapons) ? weapons[id] : undefined;
    check(w, `weapons.${id}`, WEAPON_SPEC);
    const ammo = isObj(w) ? w['ammo'] : undefined;
    const ammoOk = id === 'fists' ? ammo === null : (AMMO_IDS as readonly unknown[]).includes(ammo);
    if (!ammoOk) errors.push(`weapons.${id}.ammo must be ${id === 'fists' ? 'null' : 'an AmmoId'}`);
  }

  const items = raw['items'];
  for (const id of HEAL_IDS) {
    check(isObj(items) ? items[id] : undefined, `items.${id}`, { heal: N, healCap: N, useMs: N, maxStack: N, spawnQty: N });
  }
  for (const id of AMMO_IDS) check(isObj(items) ? items[id] : undefined, `items.${id}`, { pickupQty: N, maxCarry: N });
  check(isObj(items) ? items['vest'] : undefined, 'items.vest', { armor: N });

  const loot = raw['loot'];
  const tiers = isObj(loot) ? loot['tiers'] : undefined;
  for (const tier of ['common', 'rare', 'epic'] as const) {
    if (!isObj(tiers) || !isObj(tiers[tier])) errors.push(`loot.tiers.${tier} must be an object`);
  }

  const zone = raw['zone'];
  const phases = isObj(zone) ? zone['phases'] : undefined;
  if (!Array.isArray(phases) || phases.length === 0) errors.push('zone.phases must be a non-empty array');
  else phases.forEach((p, i) => check(p, `zone.phases[${i}]`, { waitSeconds: N, shrinkSeconds: N, radiusFraction: N, dps: N }));

  // M1-fix: optional sections. Absent is fine; present must be an object whose listed keys (if present) are numbers.
  const checkOptional = (obj: unknown, path: string, keys: readonly string[]): void => {
    if (obj === undefined) return;
    if (!isObj(obj)) {
      errors.push(`${path} must be an object when present`);
      return;
    }
    for (const key of keys) {
      const v = obj[key];
      if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) errors.push(`${path}.${key} must be a number`);
    }
  };
  checkOptional(raw['clientFeel'], 'clientFeel', CLIENT_FEEL_KEYS);
  const bots = raw['bots'];
  checkOptional(isObj(bots) ? bots['ai'] : undefined, 'bots.ai', BOT_AI_KEYS);
  // Revision 1b: optional bot pacing keys, personalities, and player.lowHpThreshold.
  if (isObj(bots)) checkOptional(bots, 'bots', BOT_PACING_KEYS);
  const personalities = isObj(bots) ? bots['personalities'] : undefined;
  if (personalities !== undefined && !isObj(personalities)) errors.push('bots.personalities must be an object when present');
  if (isObj(personalities)) {
    for (const key of Object.keys(personalities)) {
      // A misspelt personality would silently fall back to defaults; `_`-prefixed keys are comments.
      if (!key.startsWith('_') && !(BOT_PERSONALITY_IDS as readonly string[]).includes(key)) {
        errors.push(`bots.personalities.${key} is not a personality (${BOT_PERSONALITY_IDS.join(', ')})`);
      }
    }
    for (const id of BOT_PERSONALITY_IDS) checkOptional(personalities[id], `bots.personalities.${id}`, BOT_PERSONALITY_KEYS);
  }
  const player = raw['player'];
  if (isObj(player)) checkOptional({ lowHpThreshold: player['lowHpThreshold'] }, 'player', ['lowHpThreshold']);
  const medkit = isObj(items) ? items['medkit'] : undefined;
  checkOptional(isObj(medkit) ? { preferAtOrBelowHp: medkit['preferAtOrBelowHp'] } : undefined, 'items.medkit', [
    'preferAtOrBelowHp',
  ]);

  if (errors.length > 0) throw new Error(`balance.json invalid:\n  ${errors.join('\n  ')}`);
  return raw as unknown as Balance;
}

/** Validated balance for composition roots. Everything else receives Balance by injection. */
export const BALANCE: Balance = validateBalance(balanceJson);

/** Convenience: per-gun ammo type (never null for guns). */
export const ammoFor = (balance: Balance, gun: GunId): AmmoId => balance.weapons[gun].ammo as AmmoId;
