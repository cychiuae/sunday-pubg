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
import type {
  AmmoId,
  ArmorId,
  ArmorSlot,
  ArmorTier,
  BotPersonalityId,
  GunId,
  HealId,
  ItemId,
  ItemLevel,
  LootTier,
  M2cArmorTier,
  M2cGunId,
  M2cHeldId,
  M2cSightType,
  M2cWeaponId,
  MeleeId,
  ScopedSightType,
  ScopeId,
  SightType,
  Stance,
  StanceTransitionKey,
  WeaponId,
} from './types';
import {
  AMMO_IDS,
  ARMOR_IDS,
  BOT_PERSONALITY_IDS,
  HEAL_IDS,
  isMeleeId,
  M2C_AMMO_IDS,
  M2C_ARMOR_IDS,
  M2C_ARMOR_PIECES,
  M2C_GUN_IDS,
  M2C_ITEM_IDS,
  M2C_SIGHT_TYPES,
  M2C_WEAPON_IDS,
  MELEE_IDS,
  SCOPE_IDS,
  SCOPED_SIGHT_TYPES,
  STANCE_TRANSITION_KEYS,
  STANCES,
  WEAPON_IDS,
} from './types';

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
  /** M2a: 'none' for fists (validated), a real sight for every gun. */
  sight: SightType;
  /** M2a: FOV divisor at full ADS: fov = clientFeel.cameraFovDeg / lerp(1, adsZoom, adsProgress). 1 for fists. */
  adsZoom: number;
  /** M2a: spread factor A at adsProgress 1: A = 1 + (adsSpreadMultiplier - 1) x adsProgress. */
  adsSpreadMultiplier: number;
  /** M2a: ground speed factor while ADS is engaged (full value from the first engaged tick). */
  adsMoveMultiplier: number;
  /**
   * M2a: ms from 0 to full ADS. > 0 for every weapon with a sight (validated); fists have 0 and never engage
   * (ADR 0004 addendum A1.7).
   */
  adsTimeMs: number;
  /** M2a: ground speed factor for combat.fireMoveWindowMs after each shot (LMG 0.55, else 1). */
  fireMoveMultiplier: number;
}

/** M2a: one armor piece (`items.vest_N` / `items.helmet_N`, systems/armor.md). */
export interface ArmorBalance {
  /** Matches the id prefix (validated). */
  slot: ArmorSlot;
  /** Matches the id suffix (validated). */
  tier: ArmorTier;
  /** Fresh durability (> 0). Design invariant (balance.test): durability < maxHp x f / (1 - f). */
  durability: number;
  /** In [0, 1). a = min(durability, dmg x absorbFraction). */
  absorbFraction: number;
}

/**
 * M2c (smoke.md "Tunable values"): the throw, flight and bounce keys every throwable has (`items.grenade` and
 * `items.smoke`; grenades.md formulas). Unit rule: ms / degrees / metres.
 */
export interface ThrowableBalance {
  maxCarry: number;
  spawnQty: number;
  /** Fuse runs from the pin pull (true) rather than from the throw. */
  cookable: boolean;
  fuseMs: number;
  /** Throw speed = lerp(min, max, t); validated min <= max. */
  throwSpeedMin: number;
  throwSpeedMax: number;
  throwPitchMinDeg: number;
  throwPitchMaxDeg: number;
  throwLiftDeg: number;
  throwOriginForward: number;
  throwSpeedProneMultiplier: number;
  throwRecoveryMs: number;
  dropOnSwitchSpeed: number;
  gravity: number;
  restitution: number;
  friction: number;
  /** Physics radius (contact push-out). */
  collisionRadius: number;
  restSpeed: number;
  waterVelocityDamping: number;
  bounceEventMinSpeed: number;
}

/**
 * M2c: the grenade blast model (grenades.md "Explosion"): flat on `items.grenade`, nested as `weapons.rpg.rocket.blast`.
 * Damage = maxDamage within innerRadius, then linear to maxDamage x minDamageFactor at radius; LOS from
 * centre + losHeightOffset to each chest; vests absorb, helmets do not.
 */
export interface BlastBalance {
  /** Blast radius; validated 0 <= innerRadius < radius. */
  radius: number;
  innerRadius: number;
  maxDamage: number;
  minDamageFactor: number;
  /** The thrower / shooter is damaged by their own blast. */
  selfDamage: boolean;
  /** Blast LOS ray starts this far above the blast centre. */
  losHeightOffset: number;
}

/** M2a: `items.grenade` (the frag; systems/grenades.md). M2c: = the shared throwable keys + the flat blast keys. */
export interface GrenadeBalance extends ThrowableBalance, BlastBalance {
  /**
   * M2a addendum (optional; client only): the HUD danger indicator lists live grenades within radius + dangerMargin
   * metres of the local player. Absent = 2 (grenades.md "Danger indicator"). Must be >= 0.
   */
  dangerMargin?: number;
}

/**
 * Island v2 (systems/grass.md): tall-grass concealment. Rule: src/shared/grass.ts `grassHides`. A player whose feet are
 * at least `edgeInset` m inside a 'grass' patch, in a hiding stance (settled, or moving between two hiding stances),
 * is hidden from every viewer farther than `revealRange` m (horizontal), until `revealAfterShotMs` after their last shot.
 */
export interface GrassBalance {
  revealRange: number;
  revealAfterShotMs: number;
  edgeInset: number;
  hidesCrouched: boolean;
  hidesProne: boolean;
}

/** M2c (smoke.md): `items.smoke.cloud`. Shape over time: src/shared/smoke.ts. */
export interface SmokeCloudBalance {
  /** Opaque radius at full size, m. */
  radius: number;
  /** Sphere centre above the deploy point, m. */
  centerHeight: number;
  growMs: number;
  holdMs: number;
  fadeMs: number;
  /** Two points closer than this see each other through smoke (bots, name tags). */
  closeSightRange: number;
  /** At most this many clouds; a new one forces the oldest into its fade. Integer >= 1. */
  maxActive: number;
}
/** M2c (smoke.md): `items.smoke`: the shared throwable keys (cookable is false) + the cloud. No blast. */
export interface SmokeBalance extends ThrowableBalance {
  cloud: SmokeCloudBalance;
}

/**
 * M2c (melee.md): the extra keys of `weapons.<MeleeId>` (fireIntervalMs = the swing cycle, range = the reach).
 * Validated: 0 < hitFrameMs < fireIntervalMs, sweepRadius >= 0, knockback >= 0, ammo null, magSize 0, sight none.
 */
export interface MeleeFields {
  hitFrameMs: number;
  sweepRadius: number;
  knockbackSpeed: number;
  knockbackLift: number;
}
export type MeleeBalance = WeaponBalance & MeleeFields;

/** M2c (rpg.md): `weapons.rpg.rocket`. weapons.rpg.damage is the impact damage; weapons.rpg.range the max travel. */
export interface RocketBalance {
  /** m/s, > 0. */
  speed: number;
  /** m/s^2 downward, >= 0. */
  gravity: number;
  collisionRadius: number;
  originForward: number;
  /** Travel below this is a dud (impact only, no blast), >= 0. */
  armDistance: number;
  /** maxDamage scales with the level damage multiplier (levels.md). */
  blast: BlastBalance;
}
export type RpgBalance = WeaponBalance & { rocket: RocketBalance };

/** M2c (levels.md): fields a level multiplier may scale. fireIntervalMs also scales melee hitFrameMs; damage the rpg blast. */
export type LevelField = 'damage' | 'reloadMs' | 'fireIntervalMs' | 'spreadDeg';
export const LEVEL_FIELDS: readonly LevelField[] = ['damage', 'reloadMs', 'fireIntervalMs', 'spreadDeg'];
/** Four entries L1..L4; L1 is exactly 1; each in [0.5, 2] (validated). Loot tables: four weights >= 0, sum > 0. */
export type LevelArray = readonly [number, number, number, number];
export type LevelMultipliers = Partial<Record<LevelField, LevelArray>>;
/** M2c (levels.md): `levels`. */
export interface LevelsBalance {
  /** Class default for guns (every weapon with ammo != null). */
  gun: LevelMultipliers;
  /** Class default for MeleeIds. */
  melee: LevelMultipliers;
  /** Per-weapon overrides (any weapon id except fists); win over the class default field by field. */
  overrides: Partial<Record<Exclude<M2cWeaponId, 'fists'>, LevelMultipliers>>;
  /** Relative L1..L4 weights for a weapon rolled at a loot spot of that tier. */
  lootTiers: Record<LootTier, LevelArray>;
  /** Bots multiply a weapon's loot value by this per level (index 0 = 1). */
  botValueMultiplier: LevelArray;
}

/** M2c (scopes.md): `scopes.<ScopeId>`. */
export interface ScopeBalance {
  /** The sight it gives; never 'none' or 'iron'. */
  sight: ScopedSightType;
  /** adsZoom while mounted (>= 1). */
  zoom: number;
}
/** M2c (scopes.md): `scopes.sightFactors.<sight>`. Factors > 0; ranks unique. */
export interface SightFactorBalance {
  rank: number;
  adsTime: number;
  adsSpread: number;
  adsMove: number;
}
/** M2c (scopes.md): `scopes`. */
export type ScopesBalance = Record<ScopeId, ScopeBalance> & {
  sightFactors: Record<ScopedSightType, SightFactorBalance>;
  /** ScopeIds each gun accepts (never its default sight). Guns not listed, melee and fists accept none. */
  compatible: Partial<Record<M2cGunId, ScopeId[]>>;
  /** Spare-scope pouch size (integer >= 0; 1 in M2c). */
  spareSlots: number;
  /** T sight switch duration, ms. */
  swapMs: number;
};

/** M2c (layout.md): `layout` (per-map override `maps.<id>.layout`). */
export interface LayoutBalance {
  /** Activated loot points per tier per match (integers >= 0). Must equal the sum of the level data's group uses. */
  lootUsedPerTier: Record<LootTier, number>;
  /** Every loot group has >= ceil(use x this) candidates (>= 1). */
  lootCandidateFactorMin: number;
  /** Metres between activated loot points (>= 0). */
  minLootSpacing: number;
  /** Cover parity, in [0, 1]. */
  minCoverFraction: number;
}

/** M2c (loot.md "Guaranteed weapons"): `loot.guaranteedWeapon`. */
export interface GuaranteedWeaponBalance {
  /** Relative weights of guns (weights >= 0, sum > 0). */
  weights: Partial<Record<M2cGunId, number>>;
  /** Relative L1..L4 weights. */
  levels: LevelArray;
}

/** M2c bot blocks (all keys required when the block is present). */
export interface BotMeleeBalance {
  /** Per melee id plus 'fists' (the empty melee slot). */
  lootValue: Record<MeleeId | 'fists', number>;
  lootScoreMelee: number;
  swingRangeFraction: number;
  closeSwitchRange: number;
  chaseRange: number;
}
export interface BotRpgBalance {
  lootValue: number;
  minRange: number;
  maxRange: number;
  coverRadius: number;
  groupRadius: number;
  stillSpeed: number;
  fireChancePerDecision: number;
  cooldownMs: number;
  selfSafeDistance: number;
  leadFactor: number;
  aimErrorMetres: number;
}
export interface BotSmokeBalance {
  lootScoreSmoke: number;
  retreatThrowChance: number;
  zoneCrossThrowChance: number;
  recentDamageMs: number;
  throwDistance: number;
  cooldownMs: number;
}
export interface BotScopesBalance {
  lootScoreScope: number;
  mountedMaxRangeMultiplier: Record<ScopeId, number>;
}
/**
 * Bot tactics (GDD 10 "Tactics"; `bots.tactics`, required, every key required; consumer: src/shared/sim/bots.ts).
 * Cover, range planning against the enemy's held weapon, smart reloads, pushing and investigating gunfire.
 */
export interface BotTacticsBalance {
  /** Cover is searched among colliders within this many metres. */
  coverSearchRadius: number;
  /** At most this many nearest colliders are tested per search (each costs up to 2 sight rays). */
  coverMaxCandidates: number;
  /** One cover search per bot per this many ms. */
  coverSearchCooldownMs: number;
  /** A cover state ends after this long whatever its reason, ms. */
  coverMaxMs: number;
  /** Shot by an enemy the bot cannot answer: hold cover this long, ms. */
  coverHoldMs: number;
  /** After such an under-fire cover ends, no new one for this long, ms. */
  coverCooldownMs: number;
  /** Cover score: metres of walking added per metre the spot is closer to the threat than the bot is. */
  coverTowardThreatPenalty: number;
  /** Seek cover for a reload only with at least this much of it left, ms. */
  coverReloadMinMs: number;
  /** An empty or reloading gun with a visible enemy within this many metres: swap to a loaded second gun instead. */
  swapInsteadOfReloadRange: number;
  /** The target is out of sight: reload when the mag is below this fraction of magSize. */
  hiddenReloadFraction: number;
  /** Move to another fight distance only when it raises the damage share (mine / (mine + theirs)) by at least this. */
  rangeAdvantageMargin: number;
  /** Sprint after a target that broke line of sight within this many ms of this bot hitting it. */
  pushWindowMs: number;
  /** Chance to flip strafe direction when hit while fighting. */
  hitJukeChance: number;
  /** Heard gunfire is remembered (and an investigation lasts) this long, ms. */
  investigateMemoryMs: number;
  /** Investigate only at or above this eagerness. */
  investigateMinEagerness: number;
  /** Stop investigating at this fraction of the bot's best fire range from the heard shot. */
  investigateStandoffFraction: number;
}

/** M2a: `movement.stances.<stance>`. */
export interface StanceBalance {
  speedMultiplier: number;
  /** Hitbox and collision height (feet to top). stand.height must equal player.height (validated). */
  height: number;
  /** Shot origin, throw origin, LOS and camera pivot. stand.eyeHeight must equal player.eyeHeight (validated). */
  eyeHeight: number;
}

/** M2a: `movement.stances` (systems/stance.md). */
export type StancesBalance = Record<Stance, StanceBalance> & {
  transitionMs: Record<StanceTransitionKey, number>;
  /** Water depth = max(0, -terrainHeight) at the feet. */
  proneMaxWaterDepth: number;
  crouchMaxWaterDepth: number;
  headroomCheck: boolean;
  headroomMargin: number;
  /**
   * M2b (camera.md "Prone pitch"): sim pitch clamp, degrees, while the stance is prone or a transition has prone at
   * either end. min < 0 < max, within PITCH_MIN/MAX (+-80).
   */
  pronePitchMinDeg: number;
  pronePitchMaxDeg: number;
};

/** M2a: `combat.hitbox` (stance.md "Hitboxes"). Stand uses player.radius/height/headZoneFraction. */
export interface HitboxBalance {
  crouchHeadZoneFraction: number;
  /** Prone box, centred on the feet (x, z), long axis along the look yaw. */
  proneLength: number;
  proneWidth: number;
  /** Head = the front proneHeadLength metres of the box (toward the look direction). */
  proneHeadLength: number;
}

/** M2a (optional `bots.weaponPrefs.<GunId>`; consumer: bots.ts). All three keys required per listed gun. */
export interface BotWeaponPrefBalance {
  minRange: number;
  maxRange: number;
  lootValue: number;
}
/**
 * M2a (`bots.ads`). The block and `scopedFireMinProgress` are required since M2b (REVIEW-M2b M1, see Balance.bots);
 * the other keys are optional and fall back to bots.ts defaults.
 */
export interface BotAdsBalance {
  minRange?: number;
  aimErrorMultiplier?: number;
  scopedVisionRange?: number;
  /**
   * M2a addendum (ADR 0004 A1.6): a bot holding a scoped gun fires only at adsProgress >= this, in [0, 1].
   * Required (REVIEW-M2b M1).
   */
  scopedFireMinProgress?: number;
}
/** M2a (optional `bots.stance`). */
export interface BotStanceBalance {
  minRange?: number;
  holdMs?: number;
  proneShare?: number;
}
/** M2a (optional `bots.grenade`). */
export interface BotGrenadeBalance {
  minRange?: number;
  maxRange?: number;
  throwChancePerDecision?: number;
  cooldownMs?: number;
  cookMs?: number;
  coverMemoryMs?: number;
  aimErrorMetres?: number;
  fleeRadius?: number;
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
  /** M2a: cosmetic camera blend-out time after ADS ends (the sim exit is instant). */
  adsExitBlendMs?: number;
  /** M2a: how far ahead (seconds of flight) the grenade arc preview is simulated. */
  grenadeArcPreviewSeconds?: number;
  // M2b first person (camera.md "Tunable values"; C-gate). M2a adsCameraDistance/adsCameraShoulderOffset removed.
  /** Fixed vertical FOV of the viewmodel pass, degrees. */
  viewmodelFovDeg?: number;
  fpBobWalkVertical?: number;
  fpBobWalkLateral?: number;
  fpBobSprintVertical?: number;
  fpBobSprintLateral?: number;
  fpBobCrouchFactor?: number;
  fpBobProneFactor?: number;
  /** Cap on the total cosmetic camera offset from the eye, m (0 at full ADS). */
  fpMaxCameraOffset?: number;
  fpLandDip?: number;
  fpLandDipMs?: number;
  vmBobFactor?: number;
  vmSwayIdleDeg?: number;
  vmSwayIdlePeriodMs?: number;
  vmSwayLookFactor?: number;
  vmSwayMaxDeg?: number;
  reducedMotionViewmodelFactor?: number;
  adsCrosshairFadeStart?: number;
  adsCrosshairFadeEnd?: number;
  scopeOverlayFadeMs?: number;
  fpAdsRecoilFactor?: number;
  /** Camera distance behind the carrier while aboard (CameraView view 'carrier'). */
  carrierCameraDistance?: number;
  /** M2b (camera.md "Camera mode per state"): the death cam orbits the killer when alive within this range, m. */
  deathCamKillerRange?: number;
  /** Visual-only recoil per gun (FpRecoilBalance). M2c: keys may be any M2cGunId. */
  fpRecoil?: Partial<Record<M2cGunId, FpRecoilBalance>>;
}

/**
 * M2b (camera.md "Recoil", `clientFeel.fpRecoil.<GunId>`): visual-only recoil. All five keys required per listed gun;
 * an unknown gun key is an error.
 */
export interface FpRecoilBalance {
  kickBack: number;
  kickPitchDeg: number;
  rollDeg: number;
  fovPunchDeg: number;
  returnMs: number;
}
/**
 * M2b (camera.md "Tunable values"): the first-person clientFeel number keys (optional numbers; tuning.test pins them
 * against ClientTuning). The FOV setting range is NOT here: it is a settings range (FP_FOV_* in contracts.ts).
 */
export const CLIENT_FEEL_FP_KEYS: readonly (keyof ClientFeelBalance)[] = [
  'viewmodelFovDeg', 'fpBobWalkVertical', 'fpBobWalkLateral', 'fpBobSprintVertical', 'fpBobSprintLateral',
  'fpBobCrouchFactor', 'fpBobProneFactor', 'fpMaxCameraOffset', 'fpLandDip', 'fpLandDipMs', 'vmBobFactor',
  'vmSwayIdleDeg', 'vmSwayIdlePeriodMs', 'vmSwayLookFactor', 'vmSwayMaxDeg', 'reducedMotionViewmodelFactor',
  'adsCrosshairFadeStart', 'adsCrosshairFadeEnd', 'scopeOverlayFadeMs', 'fpAdsRecoilFactor', 'carrierCameraDistance',
];
const FP_RECOIL_SPEC: Record<keyof FpRecoilBalance, Kind> = {
  kickBack: 'number', kickPitchDeg: 'number', rollDeg: 'number', fovPunchDeg: 'number', returnMs: 'number',
};

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
  /** M2a: armor value = (lootScoreVest | lootScoreHelmet) + lootScoreArmorPerTier x tier, if the pickup is accepted. */
  lootScoreHelmet?: number;
  lootScoreArmorPerTier?: number;
  /** M2a: a grenade stack while below items.grenade.maxCarry. */
  lootScoreGrenade?: number;
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
  /** M2a: chance per strafe change to crouch/prone while engaged (bots.stance). */
  stanceChance?: number;
  /** M2a: multiplies bots.grenade.throwChancePerDecision. */
  grenadeChanceMultiplier?: number;
  /** M2b (drop.md): added to the bot's planned jump time, ms (negative = earlier). */
  jumpTimingBiasMs?: number;
  /** M2b (drop.md): multiplies bots.drop.tierWeights.epic for this personality. */
  dropEpicWeightMultiplier?: number;
  /** M2c (smoke.md "Bots"): multiplies bots.smoke retreat/zone throw chances. */
  smokeChanceMultiplier?: number;
  /** Tactics (GDD 10): chance to go and look when it hears a fight (bots.tactics.investigate*). */
  investigateChance?: number;
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
  /** M2a: range bands and loot value per gun. Absent guns use the M1 expectedBodyDps rule. M2c: any M2cGunId. */
  weaponPrefs?: Partial<Record<M2cGunId, BotWeaponPrefBalance>>;
  /** M2a. */
  ads?: BotAdsBalance;
  /** M2a. */
  stance?: BotStanceBalance;
  /** M2a. */
  grenade?: BotGrenadeBalance;
  /** M2b: bot jump choice (drop.md). */
  drop?: BotDropBalance;
  /** M2c (melee.md "Bots"). Required at the C-gate. */
  melee?: BotMeleeBalance;
  /** M2c (rpg.md "Bots"). Required at the C-gate. */
  rpg?: BotRpgBalance;
  /** M2c (smoke.md "Bots"). Required at the C-gate. */
  smoke?: BotSmokeBalance;
  /** M2c (scopes.md "Bots"). Required at the C-gate. */
  scopes?: BotScopesBalance;
}
/** M2b (systems/drop.md; `bots.drop`, required since REVIEW-M2b M1). All four keys required. */
export interface BotDropBalance {
  /** Candidate targets: loot spawns within auto-deploy reach x this of the in-window route. */
  reachSafetyFraction: number;
  tierWeights: Record<LootTier, number>;
  maxBotsPerTarget: number;
  jumpJitterMs: number;
}
/**
 * M2b (systems/maps.md §4; optional `bots.nav`, consumer: the indoor nav graph in bots). All keys required when the
 * block is present. Island maps ignore it.
 */
export interface BotNavBalance {
  cellSize: number;
  climbCostMultiplier: number;
  dropCost: number;
  pathCacheSize: number;
  maxPathsPerTick: number;
  replanMs: number;
  plateauHoldChance: number;
}
export interface AmmoBalance { pickupQty: number; maxCarry: number }
export interface ZonePhaseBalance { waitSeconds: number; shrinkSeconds: number; radiusFraction: number; dps: number }

/**
 * M2b (systems/drop.md, ADR 0005 §8): the carrier drop. Base values are the island's; the office overrides them in
 * `maps.office.drop`. Altitudes are absolute y. The parachute phase uses movement.dropFallSpeed / dropSteerSpeed.
 */
export interface DropBalance {
  carrierAltitude: number;
  /** m/s along the route. */
  carrierSpeed: number;
  /** No jumping for this long after the flight starts. */
  noJumpMs: number;
  /** Lateral offset bound as a fraction of the play area's half-width along the route normal, in [0, 1). */
  routeLateralFraction: number;
  /** Entry and exit lie on the play area expanded by this (m, >= 0). */
  routeEntryMargin: number;
  /** The eject point is where the route leaves the play area inset by this (m, >= 0). */
  ejectInset: number;
  minJumpWindowMetres: number;
  /** Integer >= 1. */
  routeMaxTries: number;
  freefallSpeed: number;
  freefallSteerSpeed: number;
  /** Auto-deploy at this height above the terrain or floor below (props ignored). */
  chuteDeployHeight: number;
  /** The jump edge during freefall opens the parachute (after minFreefallMs). */
  manualDeploy: boolean;
  minFreefallMs: number;
}

/**
 * M2b (systems/rooms.md, ADR 0006): room rules. Gameplay-facing room numbers; ops limits (MAX_ROOMS, rate limits)
 * are server env/config. All keys required when the block is present. Not overridable per map (lobby-time).
 */
export interface RoomsBalance {
  defaultMaxHumans: number;
  minMaxHumans: number;
  maxMaxHumans: number;
  fillWithBotsDefault: boolean;
  minHumansToStartWithBots: number;
  minHumansToStartWithoutBots: number;
  autoStartAllReadyMinHumans: number;
  publicAutoStartMinHumans: number;
  publicAutoStartSeconds: number;
  nameMaxLength: number;
  kickRejoinBlockSeconds: number;
}

/** M2b (systems/maps.md 2.1): zone fiction. Selects strings (`hud.<theme>.*`), visuals and audio. Never sim rules. */
export type ZoneTheme = 'tide' | 'sprinklers' | 'lightsOut';
export const ZONE_THEMES: readonly ZoneTheme[] = ['tide', 'sprinklers', 'lightsOut'];

/** Recursive partial for override blocks: objects partial key by key; arrays and scalars replace wholesale. */
export type BalanceOverride<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: BalanceOverride<T[K]> }
    : T;

/**
 * M2b (ADR 0005 §4): `maps.<mapId>`. `zoneTheme` is required (not an override). Every other key is an override path
 * that must exist in the base (except inside the open records in OPEN_RECORD_PATHS) and may not be in
 * MAP_OVERRIDE_FORBIDDEN. The effective balance of a match = balanceForMap(base, mapId).
 */
export type MapBalanceEntry = { zoneTheme: ZoneTheme } & BalanceOverride<Omit<Balance, 'maps' | 'net'>>;

export interface Balance {
  match: {
    targetPlayers: number;
    minHumansToStart: number;
    countdownSeconds: number;
    resultsSeconds: number;
    /** M2b: only the drop-less test World (WorldOptions.drop false) uses it; the carrier drop replaced the M1 spawn. */
    dropHeight?: number;
    maxPlayers: number;
    /** M2b: as dropHeight. */
    spawnJitter?: number;
    killCreditWindowSeconds: number;
    deathScreenSeconds: number;
    endWhenNoHumansAlive: boolean;
    lastHumanDeathDelaySeconds: number;
    /**
     * M2b (maps.md 1.3): voting closes and the map and drop route are resolved this many seconds before the countdown
     * ends. Lobby-time key: may not be overridden per map.
     */
    mapVoteLockSeconds: number;
  };
  player: {
    maxHp: number;
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
    /** M2a. */
    stances: StancesBalance;
  };
  combat: {
    swapMs: number;
    airSpreadMultiplier: number;
    moveSpreadSpeedThreshold: number;
    deathDropScatter: number;
    /** M2a: factor S, applied only while the stance is settled (1 during transitions). */
    stanceSpreadMultiplier: Record<Stance, number>;
    /** M2a: window after a shot during which weapons[w].fireMoveMultiplier applies. */
    fireMoveWindowMs: number;
    /** M2a. */
    hitbox: HitboxBalance;
    /** M2c (grenades.md "Throwable slot"): 4 / G while the throwable slot is ready cycles frag <-> smoke. Gate: required. */
    throwableCycleMs: number;
    /**
     * Damage pass 2026-11 (combat.md "Sniper rules"): a headshot from one of `weapons` on a player wearing a helmet loses
     * at most `maxHpLoss` HP from the head part of the shot (the helmet still absorbs as usual). Gate: required.
     */
    helmetHeadshotCap: { weapons: WeaponId[]; maxHpLoss: number; minHelmetTier: number };
  };
  /**
   * M2c: the new weapons are optional until the C-gate (the merged balance.json has them; WEAPONS lookups for them go
   * through `weaponBalance()`), then `Record<WeaponId, ...>` covers them.
   */
  weapons: Record<WeaponId, WeaponBalance> & Record<MeleeId, MeleeBalance> & { rpg: RpgBalance };
  /** M2a: M1 `items.vest` removed; armor pieces and the grenade added. M2c: optional new items until the C-gate. */
  items: Record<HealId, HealBalance> & Record<AmmoId, AmmoBalance> & Record<ArmorId, ArmorBalance> & {
    grenade: GrenadeBalance;
    smoke: SmokeBalance;
  };
  /** M2a: M1 `absorbFraction` moved per piece. Worn pieces with durability > 0 drop on death when true. */
  armor: { dropOnDeath: boolean };
  loot: {
    /** Relative weights per tier; missing item = weight 0. M2c: keys may be any M2cItemId. */
    tiers: Record<LootTier, Partial<Record<ItemId | (typeof M2C_ITEM_IDS)[number], number>>>;
    /** M2c (loot.md): guaranteed-weapon points. Gate: required. */
    guaranteedWeapon: GuaranteedWeaponBalance;
    extraAmmoWithWeapon: number;
    spawnChance: number;
    weaponSpawnsWithFullMag: boolean;
    extraAmmoScatter: number;
    pickupBobHeight: number;
  };
  /** Island v2: tall-grass concealment (GrassBalance). */
  grass: GrassBalance;
  zone: {
    damageTickMs: number;
    /**
     * Island: radius of the first circle. M2b indoor maps override it (office 140, covering the floor). The first
     * centre is (0, 0) on every map.
     */
    startRadius: number;
    /**
     * M2b (maps.md 2.2): indoor zone centres must lie inside the floor rectangle inset by this many metres. Ignored by
     * island maps.
     */
    indoorCenterInset: number;
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
    /** M2c (required since the C-gate). */
    melee: BotMeleeBalance;
    rpg: BotRpgBalance;
    smoke: BotSmokeBalance;
    scopes: BotScopesBalance;
    /** Tactics (GDD 10 "Tactics"): cover, range plan, smart reloads, push, investigate. Required. */
    tactics: BotTacticsBalance;
    /** M2b: indoor navigation (maps.md §4). Required in the base; island maps ignore it. */
    nav: BotNavBalance;
    /** M2b: bot jump choice (drop.md). Required (REVIEW-M2b M1). */
    drop: BotDropBalance;
    /** M2a/M2b: required block with a required scopedFireMinProgress (REVIEW-M2b M1). */
    ads: BotAdsBalance & { scopedFireMinProgress: number };
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
  /** M2b: carrier drop (drop.md). */
  drop: DropBalance;
  /** M2b: room rules (rooms.md). */
  rooms: RoomsBalance;
  /**
   * M2b: per-map entries keyed by map id. See MapBalanceEntry. Code never reads this directly: it receives the
   * effective balance from balanceForMap and the theme from zoneThemeOf. Absent in a merged (effective) balance.
   */
  maps?: Record<string, MapBalanceEntry>;
  /** M2c (levels.md). */
  levels: LevelsBalance;
  /** M2c (scopes.md). */
  scopes: ScopesBalance;
  /** M2c (layout.md). */
  layout: LayoutBalance;
}

type Kind = 'number' | 'boolean';
const N: Kind = 'number';
const B: Kind = 'boolean';

const SECTION_SPEC: Record<string, Record<string, Kind>> = {
  match: {
    targetPlayers: N, minHumansToStart: N, countdownSeconds: N, resultsSeconds: N, maxPlayers: N,
    killCreditWindowSeconds: N, deathScreenSeconds: N, endWhenNoHumansAlive: B, lastHumanDeathDelaySeconds: N,
    mapVoteLockSeconds: N,
  },
  // M2a: maxArmor removed.
  player: { maxHp: N, radius: N, height: N, eyeHeight: N, pickupRange: N, headZoneFraction: N },
  movement: {
    walkSpeed: N, sprintSpeed: N, airControl: N, jumpVelocity: N, gravity: N, accel: N, friction: N,
    waterSpeedMultiplier: N, waterDepthThreshold: N, fallDamageMinSpeed: N, fallDamagePerMs: N, terminalVelocity: N,
    stepHeight: N, healMoveMultiplier: N, dropFallSpeed: N, dropSteerSpeed: N,
  },
  combat: { swapMs: N, airSpreadMultiplier: N, moveSpreadSpeedThreshold: N, deathDropScatter: N, fireMoveWindowMs: N },
  // M2a: absorbFraction moved per piece.
  armor: { dropOnDeath: B },
  loot: { extraAmmoWithWeapon: N, spawnChance: N, weaponSpawnsWithFullMag: B, extraAmmoScatter: N, pickupBobHeight: N },
  grass: { revealRange: N, revealAfterShotMs: N, edgeInset: N, hidesCrouched: B, hidesProne: B },
  zone: {
    damageTickMs: N, startRadius: N, indoorCenterInset: N, ignoresArmor: B, landCheckMinHeight: N, landCheckMaxTries: N,
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
  // M2a
  adsZoom: N, adsSpreadMultiplier: N, adsMoveMultiplier: N, adsTimeMs: N, fireMoveMultiplier: N,
};

const HEAL_SPEC: Record<string, Kind> = { heal: N, healCap: N, useMs: N, maxStack: N, spawnQty: N };
const AMMO_SPEC: Record<string, Kind> = { pickupQty: N, maxCarry: N };
const ARMOR_SPEC: Record<string, Kind> = { tier: N, durability: N, absorbFraction: N };
const THROWABLE_SPEC: Record<keyof ThrowableBalance, Kind> = {
  maxCarry: N, spawnQty: N, cookable: B, fuseMs: N, throwSpeedMin: N, throwSpeedMax: N, throwPitchMinDeg: N,
  throwPitchMaxDeg: N, throwLiftDeg: N, throwOriginForward: N, throwSpeedProneMultiplier: N, throwRecoveryMs: N,
  dropOnSwitchSpeed: N, gravity: N, restitution: N, friction: N, collisionRadius: N, restSpeed: N,
  waterVelocityDamping: N, bounceEventMinSpeed: N,
};
const BLAST_SPEC: Record<keyof BlastBalance, Kind> = {
  radius: N, innerRadius: N, maxDamage: N, minDamageFactor: N, selfDamage: B, losHeightOffset: N,
};
const GRENADE_SPEC: Record<Exclude<keyof GrenadeBalance, 'dangerMargin'>, Kind> = { ...THROWABLE_SPEC, ...BLAST_SPEC };
// M2c
const SMOKE_CLOUD_SPEC: Record<keyof SmokeCloudBalance, Kind> = {
  radius: N, centerHeight: N, growMs: N, holdMs: N, fadeMs: N, closeSightRange: N, maxActive: N,
};
const MELEE_SPEC: Record<keyof MeleeFields, Kind> = { hitFrameMs: N, sweepRadius: N, knockbackSpeed: N, knockbackLift: N };
const ROCKET_SPEC: Record<Exclude<keyof RocketBalance, 'blast'>, Kind> = {
  speed: N, gravity: N, collisionRadius: N, originForward: N, armDistance: N,
};
const SIGHT_FACTOR_SPEC: Record<keyof SightFactorBalance, Kind> = { rank: N, adsTime: N, adsSpread: N, adsMove: N };
const LAYOUT_SPEC: Record<Exclude<keyof LayoutBalance, 'lootUsedPerTier'>, Kind> = {
  lootCandidateFactorMin: N, minLootSpacing: N, minCoverFraction: N,
};
const BOT_MELEE_SPEC: Record<Exclude<keyof BotMeleeBalance, 'lootValue'>, Kind> = {
  lootScoreMelee: N, swingRangeFraction: N, closeSwitchRange: N, chaseRange: N,
};
const BOT_RPG_SPEC: Record<keyof BotRpgBalance, Kind> = {
  lootValue: N, minRange: N, maxRange: N, coverRadius: N, groupRadius: N, stillSpeed: N, fireChancePerDecision: N,
  cooldownMs: N, selfSafeDistance: N, leadFactor: N, aimErrorMetres: N,
};
const BOT_SMOKE_SPEC: Record<keyof BotSmokeBalance, Kind> = {
  lootScoreSmoke: N, retreatThrowChance: N, zoneCrossThrowChance: N, recentDamageMs: N, throwDistance: N, cooldownMs: N,
};
const STANCE_SPEC: Record<keyof StanceBalance, Kind> = { speedMultiplier: N, height: N, eyeHeight: N };
const STANCES_SPEC: Record<string, Kind> = {
  proneMaxWaterDepth: N, crouchMaxWaterDepth: N, headroomCheck: B, headroomMargin: N, pronePitchMinDeg: N,
  pronePitchMaxDeg: N,
};
const HITBOX_SPEC: Record<keyof HitboxBalance, Kind> = {
  crouchHeadZoneFraction: N, proneLength: N, proneWidth: N, proneHeadLength: N,
};
const BOT_WEAPON_PREF_SPEC: Record<keyof BotWeaponPrefBalance, Kind> = { minRange: N, maxRange: N, lootValue: N };
const BOT_TACTICS_SPEC: Record<keyof BotTacticsBalance, Kind> = {
  coverSearchRadius: N, coverMaxCandidates: N, coverSearchCooldownMs: N, coverMaxMs: N, coverHoldMs: N, coverCooldownMs: N,
  coverTowardThreatPenalty: N, coverReloadMinMs: N, swapInsteadOfReloadRange: N, hiddenReloadFraction: N,
  rangeAdvantageMargin: N, pushWindowMs: N, hitJukeChance: N, investigateMemoryMs: N, investigateMinEagerness: N,
  investigateStandoffFraction: N,
};
const DROP_SPEC: Record<keyof DropBalance, Kind> = {
  carrierAltitude: N, carrierSpeed: N, noJumpMs: N, routeLateralFraction: N, routeEntryMargin: N, ejectInset: N,
  minJumpWindowMetres: N, routeMaxTries: N, freefallSpeed: N, freefallSteerSpeed: N, chuteDeployHeight: N,
  manualDeploy: B, minFreefallMs: N,
};
const BOT_DROP_SPEC: Record<Exclude<keyof BotDropBalance, 'tierWeights'>, Kind> = {
  reachSafetyFraction: N, maxBotsPerTarget: N, jumpJitterMs: N,
};
const BOT_NAV_SPEC: Record<keyof BotNavBalance, Kind> = {
  cellSize: N, climbCostMultiplier: N, dropCost: N, pathCacheSize: N, maxPathsPerTick: N, replanMs: N,
  plateauHoldChance: N,
};
const LOOT_TIERS: readonly LootTier[] = ['common', 'rare', 'epic'];

/**
 * M2c C-gate switch (ADR 0007 §10). false: every M2c block and id is validated when present, so the live balance.json
 * validates both before and after the game-designer merges `_m2cPending`. true (at the gate): they are required.
 */
export const M2C_BALANCE_REQUIRED: boolean = true;
const ROOMS_SPEC: Record<keyof RoomsBalance, Kind> = {
  defaultMaxHumans: N, minMaxHumans: N, maxMaxHumans: N, fillWithBotsDefault: B, minHumansToStartWithBots: N,
  minHumansToStartWithoutBots: N, autoStartAllReadyMinHumans: N, publicAutoStartMinHumans: N,
  publicAutoStartSeconds: N, nameMaxLength: N, kickRejoinBlockSeconds: N,
};

/**
 * M2b (ADR 0005 §4): override paths a map may not change. `net` feeds module constants (SIM_HZ...). The `match` keys
 * are read in the lobby before the map is known. `maps` cannot nest.
 */
export const MAP_OVERRIDE_FORBIDDEN: readonly string[] = [
  'net', 'maps', 'rooms', 'match.maxPlayers', 'match.minHumansToStart', 'match.countdownSeconds', 'match.mapVoteLockSeconds',
];
/**
 * M2b: records keyed by ids, where an override may add a key the base does not list (a loot weight for an item the
 * base tier omits, a weaponPrefs gun, a personality). Values are still type-checked by the merged validation.
 */
export const OPEN_RECORD_PATHS: readonly string[] = [
  'loot.tiers.common', 'loot.tiers.rare', 'loot.tiers.epic', 'bots.weaponPrefs', 'bots.personalities',
  // M2c
  'loot.guaranteedWeapon.weights', 'levels.overrides', 'scopes.compatible', 'clientFeel.fpRecoil',
];

/** M1-fix: keys allowed in the optional sections. Each one present must be a finite number. */
const CLIENT_FEEL_KEYS: readonly (keyof ClientFeelBalance)[] = [
  'mouseRadiansPerPixel', 'cameraDistance', 'cameraShoulderOffset', 'cameraFovDeg', 'orbitDistanceFactor',
  'orbitPitchDeg', 'orbitDegPerSecond', 'correctionSnapDistance', 'correctionDecayMs', 'maxPendingInputs',
  'footstepStrideWalk', 'footstepStrideSprint', 'animMoveSpeed', 'maxFrameTravel',
  // M2a
  'adsExitBlendMs', 'grenadeArcPreviewSeconds',
  // M2b
  'deathCamKillerRange',
];
const BOT_AI_KEYS: readonly (keyof BotAiBalance)[] = [
  'aimHeightFraction', 'idleTurnDegPerSecond', 'combatTurnDegPerSecond', 'probeDistance', 'probeHeight',
  'stuckFraction', 'detourMs', 'arriveDistance', 'interactFraction', 'lootGiveUpPresses', 'idleReloadFraction',
  'zoneUrgencyFactor', 'zoneUrgencyBufferSeconds', 'wanderFraction', 'gunScoreDistance', 'preferredRangeFraction',
  'lootScoreUnarmedGun', 'lootScoreSecondGun', 'lootScoreDuplicateGun', 'lootScoreUpgradeGun', 'gunUpgradeFactor',
  'lootScoreVest', 'lootScoreAmmoLow', 'lootScoreAmmo', 'lootScoreMedkit', 'lootScoreBandage', 'lootDistanceFalloff',
  // M2a
  'lootScoreHelmet', 'lootScoreArmorPerTier', 'lootScoreGrenade',
];
const BOT_PACING_KEYS: readonly Exclude<keyof BotPacingBalance, 'personalities' | 'weaponPrefs' | 'ads' | 'stance' | 'grenade'>[] = [
  'lootPhaseSeconds', 'lootPhaseEngageRange', 'avoidRange', 'dropSpreadRange', 'eagernessRampSeconds',
  'eagernessFullAtPhase', 'eagernessCurve', 'fireRangeFalloffFraction', 'minEngageRange', 'disengageRangeFactor',
  'retaliateMs', 'focusPenalty', 'targetBiasSpread', 'healBeforeFightBelowHp', 'retreatMs', 'holdWanderRadius',
  'holdPauseMs', 'roamEagerness', 'zoneEntryFraction', 'zoneEntrySpread',
];
const BOT_PERSONALITY_KEYS: readonly (keyof BotPersonalityBalance)[] = [
  'share', 'engageRangeMultiplier', 'lootPhaseMultiplier', 'reactionMultiplier', 'retreatBelowHp',
  // M2a
  'stanceChance', 'grenadeChanceMultiplier',
  // M2b
  'jumpTimingBiasMs', 'dropEpicWeightMultiplier',
  // M2c
  'smokeChanceMultiplier',
  // Tactics
  'investigateChance',
];
const BOT_ADS_KEYS: readonly (keyof BotAdsBalance)[] = [
  'minRange', 'aimErrorMultiplier', 'scopedVisionRange', 'scopedFireMinProgress',
];
const BOT_STANCE_KEYS: readonly (keyof BotStanceBalance)[] = ['minRange', 'holdMs', 'proneShare'];
const BOT_GRENADE_KEYS: readonly (keyof BotGrenadeBalance)[] = [
  'minRange', 'maxRange', 'throwChancePerDecision', 'cooldownMs', 'cookMs', 'coverMemoryMs', 'aimErrorMetres',
  'fleeRadius',
];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** `_`-prefixed keys are documentation (balance.json `_meta.units`); every key iteration skips them. */
const dataKeys = (o: Record<string, unknown>): string[] => Object.keys(o).filter((k) => !k.startsWith('_'));

/** Throws an Error listing every missing/mistyped required key. Returns the input typed as Balance. */
export function validateBalance(raw: unknown): Balance {
  const errors = balanceErrors(raw);
  if (errors.length > 0) throw new Error(`balance.json invalid:\n  ${errors.join('\n  ')}`);
  return raw as Balance;
}

/** Every validation error of a raw balance (empty = valid). M2b: also validates each `maps.<id>` merged balance. */
function balanceErrors(raw: unknown): string[] {
  const errors: string[] = [];
  const check = (obj: unknown, path: string, spec: Record<string, Kind>): void => {
    if (!isObj(obj)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const [key, kind] of Object.entries(spec)) {
      const v = obj[key];
      // Numbers must also be finite (JSON cannot hold NaN, but tests and overrides can).
      if (kind === N ? !isNum(v) : typeof v !== kind) errors.push(`${path}.${key} must be a ${kind}`);
    }
  };
  const get = (obj: unknown, key: string): unknown => (isObj(obj) ? obj[key] : undefined);
  if (!isObj(raw)) throw new Error('balance.json: root must be an object');
  /** M2a/M2c throw keys (items.grenade, items.smoke). */
  const checkThrowable = (t: Record<string, unknown>, path: string): void => {
    const { throwSpeedMin, throwSpeedMax, throwPitchMinDeg, throwPitchMaxDeg, maxCarry } = t;
    if (isNum(throwSpeedMin) && isNum(throwSpeedMax) && !(throwSpeedMin <= throwSpeedMax)) {
      errors.push(`${path}.throwSpeedMin must be <= throwSpeedMax`);
    }
    if (isNum(throwPitchMinDeg) && isNum(throwPitchMaxDeg) && !(throwPitchMinDeg < throwPitchMaxDeg)) {
      errors.push(`${path}.throwPitchMinDeg must be < throwPitchMaxDeg`);
    }
    if (isNum(maxCarry) && !(Number.isInteger(maxCarry) && maxCarry >= 1)) errors.push(`${path}.maxCarry must be an integer >= 1`);
  };
  /** M2a/M2c blast model (items.grenade flat, weapons.rpg.rocket.blast). */
  const checkBlast = (b: unknown, path: string): void => {
    check(b, path, BLAST_SPEC);
    if (!isObj(b)) return;
    const { innerRadius, radius } = b;
    if (isNum(innerRadius) && isNum(radius) && !(innerRadius >= 0 && innerRadius < radius)) {
      errors.push(`${path}.innerRadius must be in [0, radius)`);
    }
  };

  for (const [section, spec] of Object.entries(SECTION_SPEC)) check(raw[section], section, spec);

  // Weapons: per-id spec, ammo, sight (M2a). M2c: melee (sight 'none', no ammo) and the new guns, validated when
  // present until the C-gate (M2C_BALANCE_REQUIRED), then required.
  const weapons = raw['weapons'];
  for (const id of M2C_WEAPON_IDS) {
    const w = get(weapons, id);
    if (w === undefined && !M2C_BALANCE_REQUIRED && !(WEAPON_IDS as readonly string[]).includes(id)) continue;
    const path = `weapons.${id}`;
    check(w, path, WEAPON_SPEC);
    const unarmed = id === 'fists' || isMeleeId(id);
    const ammo = get(w, 'ammo');
    const ammoOk = unarmed ? ammo === null : (M2C_AMMO_IDS as readonly unknown[]).includes(ammo);
    if (!ammoOk) errors.push(`${path}.ammo must be ${unarmed ? 'null' : 'an AmmoId'}`);
    const sight = get(w, 'sight');
    const sightKnown = (M2C_SIGHT_TYPES as readonly unknown[]).includes(sight);
    if (!sightKnown) {
      errors.push(`${path}.sight must be one of ${M2C_SIGHT_TYPES.join('|')}`);
    } else if (unarmed !== (sight === 'none')) {
      errors.push(`${path}.sight must ${unarmed ? 'be' : 'not be'} 'none' (only fists and melee have no sight)`);
    }
    const adsZoom = get(w, 'adsZoom');
    if (isNum(adsZoom) && adsZoom < 1) errors.push(`${path}.adsZoom must be >= 1`);
    const adsTimeMs = get(w, 'adsTimeMs');
    if (isNum(adsTimeMs) && adsTimeMs < 0) errors.push(`${path}.adsTimeMs must be >= 0`);
    // ADR 0004 addendum A1.7: a sighted weapon with adsTimeMs 0 could never engage ADS (adsMs stays 0).
    if (isNum(adsTimeMs) && sight !== 'none' && sightKnown && !(adsTimeMs > 0)) {
      errors.push(`${path}.adsTimeMs must be > 0 for a weapon with a sight`);
    }
    if (isMeleeId(id) && isObj(w)) {
      // M2c (melee.md "Tunable values").
      check(w, path, MELEE_SPEC);
      const { hitFrameMs, fireIntervalMs, range, magSize, sweepRadius, knockbackSpeed, knockbackLift } = w;
      if (isNum(hitFrameMs) && isNum(fireIntervalMs) && !(hitFrameMs > 0 && hitFrameMs < fireIntervalMs)) {
        errors.push(`${path}.hitFrameMs must be in (0, fireIntervalMs)`);
      }
      if (isNum(range) && !(range > 0)) errors.push(`${path}.range must be > 0`);
      if (isNum(magSize) && magSize !== 0) errors.push(`${path}.magSize must be 0`);
      for (const [k, v] of [['sweepRadius', sweepRadius], ['knockbackSpeed', knockbackSpeed], ['knockbackLift', knockbackLift]] as const) {
        if (isNum(v) && !(v >= 0)) errors.push(`${path}.${k} must be >= 0`);
      }
    }
    if (id === 'rpg' && isObj(w)) {
      // M2c (rpg.md "Tunable values").
      if (isNum(w['magSize']) && w['magSize'] !== 1) errors.push(`${path}.magSize must be 1`);
      const rocket = w['rocket'];
      check(rocket, `${path}.rocket`, ROCKET_SPEC);
      if (isObj(rocket)) {
        if (isNum(rocket['speed']) && !(rocket['speed'] > 0)) errors.push(`${path}.rocket.speed must be > 0`);
        for (const k of ['gravity', 'armDistance', 'collisionRadius', 'originForward'] as const) {
          const v = rocket[k];
          if (isNum(v) && !(v >= 0)) errors.push(`${path}.rocket.${k} must be >= 0`);
        }
        checkBlast(rocket['blast'], `${path}.rocket.blast`);
      }
    }
  }

  // Items: heals, ammo, armor pieces (M2a), grenade (M2a). M2c: ammo_rocket, vest_4, helmet_4, smoke.
  const items = raw['items'];
  const m2cOptional = (list: readonly string[], id: string): boolean =>
    !M2C_BALANCE_REQUIRED && !list.includes(id) && get(items, id) === undefined;
  for (const id of HEAL_IDS) check(get(items, id), `items.${id}`, HEAL_SPEC);
  for (const id of M2C_AMMO_IDS) {
    if (m2cOptional(AMMO_IDS, id)) continue;
    check(get(items, id), `items.${id}`, AMMO_SPEC);
  }
  for (const id of M2C_ARMOR_IDS) {
    if (m2cOptional(ARMOR_IDS, id)) continue;
    const a = get(items, id);
    const path = `items.${id}`;
    check(a, path, ARMOR_SPEC);
    if (!isObj(a)) continue;
    const piece = M2C_ARMOR_PIECES[id];
    if (a['slot'] !== piece.slot) errors.push(`${path}.slot must be '${piece.slot}'`);
    if (isNum(a['tier']) && a['tier'] !== piece.tier) errors.push(`${path}.tier must be ${piece.tier} (the id suffix)`);
    if (isNum(a['durability']) && !(a['durability'] > 0)) errors.push(`${path}.durability must be > 0`);
    const f = a['absorbFraction'];
    if (isNum(f) && !(f >= 0 && f < 1)) errors.push(`${path}.absorbFraction must be in [0, 1)`);
  }
  if (isObj(items) && 'vest' in items) errors.push('items.vest was removed in M2a (use items.vest_1..3)');
  const grenade = get(items, 'grenade');
  check(grenade, 'items.grenade', GRENADE_SPEC);
  if (isObj(grenade)) {
    checkThrowable(grenade, 'items.grenade');
    checkBlast(grenade, 'items.grenade');
    const dm = grenade['dangerMargin'];
    if (dm !== undefined && !(isNum(dm) && dm >= 0)) errors.push('items.grenade.dangerMargin must be a number >= 0');
  }
  // M2c (smoke.md): the smoke canister and its cloud.
  const smoke = get(items, 'smoke');
  if (smoke !== undefined || M2C_BALANCE_REQUIRED) {
    check(smoke, 'items.smoke', THROWABLE_SPEC);
    if (isObj(smoke)) {
      checkThrowable(smoke, 'items.smoke');
      const cloud = smoke['cloud'];
      check(cloud, 'items.smoke.cloud', SMOKE_CLOUD_SPEC);
      if (isObj(cloud)) {
        if (isNum(cloud['radius']) && !(cloud['radius'] > 0)) errors.push('items.smoke.cloud.radius must be > 0');
        for (const k of ['centerHeight', 'growMs', 'holdMs', 'fadeMs', 'closeSightRange'] as const) {
          const v = cloud[k];
          if (isNum(v) && !(v >= 0)) errors.push(`items.smoke.cloud.${k} must be >= 0`);
        }
        const ma = cloud['maxActive'];
        if (isNum(ma) && !(Number.isInteger(ma) && ma >= 1)) errors.push('items.smoke.cloud.maxActive must be an integer >= 1');
      }
    }
  }

  // M2a: movement.stances.
  const player = raw['player'];
  const stances = get(raw['movement'], 'stances');
  check(stances, 'movement.stances', STANCES_SPEC);
  if (isObj(stances)) {
    for (const s of STANCES) check(stances[s], `movement.stances.${s}`, STANCE_SPEC);
    const tms = stances['transitionMs'];
    check(tms, 'movement.stances.transitionMs', Object.fromEntries(STANCE_TRANSITION_KEYS.map((k) => [k, N])));
    if (isObj(tms)) {
      for (const k of dataKeys(tms)) {
        if (!(STANCE_TRANSITION_KEYS as readonly string[]).includes(k)) {
          errors.push(`movement.stances.transitionMs.${k} is not a transition (${STANCE_TRANSITION_KEYS.join(', ')})`);
        }
      }
    }
    const pmin = stances['pronePitchMinDeg'];
    const pmax = stances['pronePitchMaxDeg'];
    if (isNum(pmin) && isNum(pmax) && !(pmin >= -80 && pmin < 0 && pmax > 0 && pmax <= 80)) {
      errors.push('movement.stances.pronePitchMinDeg/MaxDeg: need -80 <= min < 0 < max <= 80');
    }
    const stand = stances['stand'];
    for (const k of ['height', 'eyeHeight'] as const) {
      const sv = get(stand, k);
      const pv = get(player, k);
      if (isNum(sv) && isNum(pv) && sv !== pv) errors.push(`movement.stances.stand.${k} must equal player.${k}`);
    }
  }

  // M2a: combat.stanceSpreadMultiplier and combat.hitbox.
  const combat = raw['combat'];
  check(get(combat, 'stanceSpreadMultiplier'), 'combat.stanceSpreadMultiplier', Object.fromEntries(STANCES.map((s) => [s, N])));
  check(get(combat, 'hitbox'), 'combat.hitbox', HITBOX_SPEC);

  // Loot tiers: objects of known ItemId -> non-negative weight (M2a: unknown ids are a data bug). M2c: M2cItemId.
  const loot = raw['loot'];
  const tiers = get(loot, 'tiers');
  for (const tier of ['common', 'rare', 'epic'] as const) {
    const t = get(tiers, tier);
    if (!isObj(t)) {
      errors.push(`loot.tiers.${tier} must be an object`);
      continue;
    }
    for (const k of dataKeys(t)) {
      if (!(M2C_ITEM_IDS as readonly string[]).includes(k)) errors.push(`loot.tiers.${tier}.${k} is not an ItemId`);
      else if (!(isNum(t[k]) && (t[k] as number) >= 0)) errors.push(`loot.tiers.${tier}.${k} must be a number >= 0`);
    }
  }

  const zone = raw['zone'];
  const phases = get(zone, 'phases');
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
      if (v !== undefined && !isNum(v)) errors.push(`${path}.${key} must be a number`);
    }
  };
  checkOptional(raw['clientFeel'], 'clientFeel', CLIENT_FEEL_KEYS);
  checkOptional(raw['clientFeel'], 'clientFeel', CLIENT_FEEL_FP_KEYS);
  const recoil = get(raw['clientFeel'], 'fpRecoil');
  if (recoil !== undefined && !isObj(recoil)) errors.push('clientFeel.fpRecoil must be an object when present');
  if (isObj(recoil)) {
    for (const key of dataKeys(recoil)) {
      if (!(M2C_GUN_IDS as readonly string[]).includes(key)) errors.push(`clientFeel.fpRecoil.${key} is not a gun`);
      else check(recoil[key], `clientFeel.fpRecoil.${key}`, FP_RECOIL_SPEC);
    }
  }
  const bots = raw['bots'];
  checkOptional(get(bots, 'ai'), 'bots.ai', BOT_AI_KEYS);
  // Revision 1b: optional bot pacing keys, personalities, and player.lowHpThreshold.
  if (isObj(bots)) checkOptional(bots, 'bots', BOT_PACING_KEYS);
  const personalities = get(bots, 'personalities');
  if (personalities !== undefined && !isObj(personalities)) errors.push('bots.personalities must be an object when present');
  if (isObj(personalities)) {
    for (const key of dataKeys(personalities)) {
      // A misspelt personality would silently fall back to defaults.
      if (!(BOT_PERSONALITY_IDS as readonly string[]).includes(key)) {
        errors.push(`bots.personalities.${key} is not a personality (${BOT_PERSONALITY_IDS.join(', ')})`);
      }
    }
    for (const id of BOT_PERSONALITY_IDS) checkOptional(personalities[id], `bots.personalities.${id}`, BOT_PERSONALITY_KEYS);
  }
  // M2a: optional bot blocks.
  const prefs = get(bots, 'weaponPrefs');
  if (prefs !== undefined && !isObj(prefs)) errors.push('bots.weaponPrefs must be an object when present');
  if (isObj(prefs)) {
    for (const key of dataKeys(prefs)) {
      if (!(M2C_GUN_IDS as readonly string[]).includes(key)) {
        errors.push(`bots.weaponPrefs.${key} is not a gun (${M2C_GUN_IDS.join(', ')})`);
        continue;
      }
      const p = prefs[key];
      check(p, `bots.weaponPrefs.${key}`, BOT_WEAPON_PREF_SPEC);
      const lo = get(p, 'minRange');
      const hi = get(p, 'maxRange');
      if (isNum(lo) && isNum(hi) && !(lo <= hi)) errors.push(`bots.weaponPrefs.${key}.minRange must be <= maxRange`);
    }
  }
  // REVIEW-M2b M1: bots.ads and its scopedFireMinProgress are required; the other ads keys stay optional.
  check(get(bots, 'ads'), 'bots.ads', { scopedFireMinProgress: N });
  checkOptional(get(bots, 'ads'), 'bots.ads', BOT_ADS_KEYS);
  const sfmp = get(get(bots, 'ads'), 'scopedFireMinProgress');
  if (isNum(sfmp) && !(sfmp >= 0 && sfmp <= 1)) errors.push('bots.ads.scopedFireMinProgress must be in [0, 1]');
  checkOptional(get(bots, 'stance'), 'bots.stance', BOT_STANCE_KEYS);
  checkOptional(get(bots, 'grenade'), 'bots.grenade', BOT_GRENADE_KEYS);
  // Tactics (GDD 10): required block, every key required.
  const tactics = get(bots, 'tactics');
  check(tactics, 'bots.tactics', BOT_TACTICS_SPEC);
  if (isObj(tactics)) {
    for (const k of ['hiddenReloadFraction', 'hitJukeChance', 'investigateMinEagerness', 'rangeAdvantageMargin'] as const) {
      const v = tactics[k];
      if (isNum(v) && !(v >= 0 && v <= 1)) errors.push(`bots.tactics.${k} must be in [0, 1]`);
    }
    const n = tactics['coverMaxCandidates'];
    if (isNum(n) && !(Number.isInteger(n) && n >= 0)) errors.push('bots.tactics.coverMaxCandidates must be an integer >= 0');
  }

  if (isObj(player)) checkOptional({ lowHpThreshold: player['lowHpThreshold'] }, 'player', ['lowHpThreshold']);
  const medkit = get(items, 'medkit');
  checkOptional(isObj(medkit) ? { preferAtOrBelowHp: medkit['preferAtOrBelowHp'] } : undefined, 'items.medkit', [
    'preferAtOrBelowHp',
  ]);

  // M2b: carrier drop.
  const drop = raw['drop'];
  check(drop, 'drop', DROP_SPEC);
  if (isObj(drop)) {
    const f = drop['routeLateralFraction'];
    if (isNum(f) && !(f >= 0 && f < 1)) errors.push('drop.routeLateralFraction must be in [0, 1)');
    for (const k of ['carrierSpeed', 'freefallSpeed'] as const) {
      const v = drop[k];
      if (isNum(v) && !(v > 0)) errors.push(`drop.${k} must be > 0`);
    }
    for (const k of ['noJumpMs', 'routeEntryMargin', 'ejectInset', 'minFreefallMs', 'chuteDeployHeight'] as const) {
      const v = drop[k];
      if (isNum(v) && !(v >= 0)) errors.push(`drop.${k} must be >= 0`);
    }
    const tries = drop['routeMaxTries'];
    if (isNum(tries) && !(Number.isInteger(tries) && tries >= 1)) errors.push('drop.routeMaxTries must be an integer >= 1');
  }
  const botDrop = get(bots, 'drop');
  {
    check(botDrop, 'bots.drop', BOT_DROP_SPEC);
    check(get(botDrop, 'tierWeights'), 'bots.drop.tierWeights', Object.fromEntries(LOOT_TIERS.map((t) => [t, N])));
  }
  const nav = get(bots, 'nav');
  {
    check(nav, 'bots.nav', BOT_NAV_SPEC);
    const cell = get(nav, 'cellSize');
    if (isNum(cell) && !(cell > 0)) errors.push('bots.nav.cellSize must be > 0');
    for (const k of ['pathCacheSize', 'maxPathsPerTick'] as const) {
      const v = get(nav, k);
      if (isNum(v) && !(Number.isInteger(v) && v >= 1)) errors.push(`bots.nav.${k} must be an integer >= 1`);
    }
  }
  const rooms = raw['rooms'];
  {
    check(rooms, 'rooms', ROOMS_SPEC);
    if (isObj(rooms)) {
      const lo = rooms['minMaxHumans'];
      const def = rooms['defaultMaxHumans'];
      const hi = rooms['maxMaxHumans'];
      const cap = get(raw['match'], 'maxPlayers');
      if (isNum(lo) && isNum(def) && isNum(hi) && isNum(cap) && !(lo >= 1 && lo <= def && def <= hi && hi <= cap)) {
        errors.push('rooms: need 1 <= minMaxHumans <= defaultMaxHumans <= maxMaxHumans <= match.maxPlayers');
      }
      const noBots = rooms['minHumansToStartWithoutBots'];
      if (isNum(noBots) && !(noBots >= 2)) errors.push('rooms.minHumansToStartWithoutBots must be >= 2');
    }
  }
  const match = raw['match'];
  if (isObj(match)) {
    checkOptional({ dropHeight: match['dropHeight'], spawnJitter: match['spawnJitter'] }, 'match', ['dropHeight', 'spawnJitter']);
  }

  // M2c blocks (validated when present; required at the C-gate).
  m2cErrors(raw, errors, check, get);

  // M2b: per-map entries. Each must name a zone theme, override only existing (or open-record) paths, and produce a
  // merged balance that passes this same validation.
  const maps = raw['maps'];
  if (maps !== undefined && !isObj(maps)) errors.push('maps must be an object when present');
  if (isObj(maps)) {
    for (const id of dataKeys(maps)) {
      const entry = maps[id];
      const path = `maps.${id}`;
      if (!isObj(entry)) {
        errors.push(`${path} must be an object`);
        continue;
      }
      if (!(ZONE_THEMES as readonly unknown[]).includes(entry['zoneTheme'])) {
        errors.push(`${path}.zoneTheme must be one of ${ZONE_THEMES.join('|')}`);
      }
      const before = errors.length;
      for (const key of dataKeys(entry)) {
        if (key === 'zoneTheme') continue;
        checkOverride(raw[key], entry[key], key, `${path}.`, errors);
      }
      if (errors.length > before) continue;
      const merged = mergeEntry(raw, entry);
      for (const e of balanceErrors(merged)) errors.push(`${path} (merged): ${e}`);
    }
  }

  return errors;
}

type CheckFn = (obj: unknown, path: string, spec: Record<string, Kind>) => void;
type GetFn = (obj: unknown, key: string) => unknown;

/**
 * M2c (ADR 0007 §10): validation of the M2c blocks. Each block is checked when present and required only when
 * M2C_BALANCE_REQUIRED (the C-gate). Rules: levels.md, scopes.md, layout.md, loot.md, melee/rpg/smoke.md "Bots".
 */
function m2cErrors(raw: Record<string, unknown>, errors: string[], check: CheckFn, get: GetFn): void {
  const need = (v: unknown, path: string): boolean => {
    if (v !== undefined) return true;
    if (M2C_BALANCE_REQUIRED) errors.push(`${path} is required (M2c)`);
    return false;
  };
  /** Four multipliers: index 0 exactly 1, each in [0.5, 2]. */
  const multipliers = (v: unknown, path: string): void => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) {
      errors.push(`${path} must be an array of 4 numbers`);
      return;
    }
    if (v[0] !== 1) errors.push(`${path}[0] (L1) must be exactly 1`);
    v.forEach((x: number, i) => {
      if (!(x >= 0.5 && x <= 2)) errors.push(`${path}[${i}] must be in [0.5, 2]`);
    });
  };
  /** Four relative weights: each >= 0, sum > 0. */
  const weights4 = (v: unknown, path: string): void => {
    if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) {
      errors.push(`${path} must be an array of 4 numbers`);
      return;
    }
    if (!v.every((x: number) => x >= 0) || !(v.reduce((a: number, x: number) => a + x, 0) > 0)) {
      errors.push(`${path}: weights must be >= 0 with a positive sum`);
    }
  };
  const fieldTable = (v: unknown, path: string): void => {
    if (!isObj(v)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const f of dataKeys(v)) {
      if (!(LEVEL_FIELDS as readonly string[]).includes(f)) errors.push(`${path}.${f} is not a level field (${LEVEL_FIELDS.join(', ')})`);
      else multipliers(v[f], `${path}.${f}`);
    }
  };

  // combat.throwableCycleMs
  const cycle = get(raw['combat'], 'throwableCycleMs');
  if (need(cycle, 'combat.throwableCycleMs') && !(isNum(cycle) && cycle >= 0)) errors.push('combat.throwableCycleMs must be a number >= 0');

  // combat.helmetHeadshotCap
  const hhc = get(raw['combat'], 'helmetHeadshotCap');
  if (need(hhc, 'combat.helmetHeadshotCap')) {
    if (!isObj(hhc)) errors.push('combat.helmetHeadshotCap must be an object');
    else {
      const ws = hhc['weapons'];
      if (!Array.isArray(ws) || ws.some((w) => !(WEAPON_IDS as readonly unknown[]).includes(w))) {
        errors.push(`combat.helmetHeadshotCap.weapons must be an array of weapon ids (${WEAPON_IDS.join(', ')})`);
      }
      const cap = hhc['maxHpLoss'];
      if (!(isNum(cap) && cap >= 0)) errors.push('combat.helmetHeadshotCap.maxHpLoss must be a number >= 0');
      const mt = hhc['minHelmetTier'];
      if (!(isNum(mt) && Number.isInteger(mt) && mt >= 1 && mt <= 4)) {
        errors.push('combat.helmetHeadshotCap.minHelmetTier must be an integer 1-4');
      }
    }
  }

  // levels
  const levels = raw['levels'];
  if (need(levels, 'levels')) {
    if (!isObj(levels)) errors.push('levels must be an object');
    else {
      fieldTable(levels['gun'], 'levels.gun');
      fieldTable(levels['melee'], 'levels.melee');
      const ov = levels['overrides'];
      if (!isObj(ov)) errors.push('levels.overrides must be an object');
      else {
        for (const id of dataKeys(ov)) {
          if (id === 'fists' || !(M2C_WEAPON_IDS as readonly string[]).includes(id)) {
            errors.push(`levels.overrides.${id} is not a levelled weapon (any weapon id except fists)`);
          } else fieldTable(ov[id], `levels.overrides.${id}`);
        }
      }
      const lt = levels['lootTiers'];
      if (!isObj(lt)) errors.push('levels.lootTiers must be an object');
      else for (const t of LOOT_TIERS) weights4(lt[t], `levels.lootTiers.${t}`);
      multipliers(levels['botValueMultiplier'], 'levels.botValueMultiplier');
    }
  }

  // scopes
  const scopes = raw['scopes'];
  if (need(scopes, 'scopes')) {
    if (!isObj(scopes)) errors.push('scopes must be an object');
    else {
      for (const id of SCOPE_IDS) {
        const sc = scopes[id];
        check(sc, `scopes.${id}`, { zoom: N });
        const sight = get(sc, 'sight');
        if (sight === 'iron' || !(SCOPED_SIGHT_TYPES as readonly unknown[]).includes(sight)) {
          errors.push(`scopes.${id}.sight must be one of red_dot|scope_2x|scope_4x|scope_8x`);
        }
        const zoom = get(sc, 'zoom');
        if (isNum(zoom) && !(zoom >= 1)) errors.push(`scopes.${id}.zoom must be >= 1`);
      }
      const sf = scopes['sightFactors'];
      if (!isObj(sf)) errors.push('scopes.sightFactors must be an object');
      else {
        const ranks = new Set<number>();
        for (const s of SCOPED_SIGHT_TYPES) {
          const f = sf[s];
          check(f, `scopes.sightFactors.${s}`, SIGHT_FACTOR_SPEC);
          if (!isObj(f)) continue;
          for (const k of ['adsTime', 'adsSpread', 'adsMove'] as const) {
            const v = f[k];
            if (isNum(v) && !(v > 0)) errors.push(`scopes.sightFactors.${s}.${k} must be > 0`);
          }
          const r = f['rank'];
          if (isNum(r)) {
            if (ranks.has(r)) errors.push(`scopes.sightFactors.${s}.rank ${r} is not unique`);
            ranks.add(r);
          }
        }
      }
      const comp = scopes['compatible'];
      if (!isObj(comp)) errors.push('scopes.compatible must be an object');
      else {
        for (const gun of dataKeys(comp)) {
          const path = `scopes.compatible.${gun}`;
          if (!(M2C_GUN_IDS as readonly string[]).includes(gun)) {
            errors.push(`${path}: only guns take scopes (${M2C_GUN_IDS.join(', ')})`);
            continue;
          }
          const list = comp[gun];
          if (!Array.isArray(list)) {
            errors.push(`${path} must be an array of ScopeIds`);
            continue;
          }
          const builtIn = get(get(raw['weapons'], gun), 'sight');
          const seen = new Set<unknown>();
          for (const sid of list) {
            if (!(SCOPE_IDS as readonly unknown[]).includes(sid)) errors.push(`${path}: ${String(sid)} is not a ScopeId`);
            else if (get(scopes[sid as string], 'sight') === builtIn) {
              errors.push(`${path}: ${String(sid)} gives the gun's built-in sight (${String(builtIn)}); never list the default`);
            }
            if (seen.has(sid)) errors.push(`${path}: ${String(sid)} listed twice`);
            seen.add(sid);
          }
        }
      }
      const spare = scopes['spareSlots'];
      if (!(isNum(spare) && Number.isInteger(spare) && spare >= 0)) errors.push('scopes.spareSlots must be an integer >= 0');
      const swap = scopes['swapMs'];
      if (!(isNum(swap) && swap >= 0)) errors.push('scopes.swapMs must be a number >= 0');
    }
  }

  // layout
  const layout = raw['layout'];
  if (need(layout, 'layout')) {
    check(layout, 'layout', LAYOUT_SPEC);
    if (isObj(layout)) {
      const used = layout['lootUsedPerTier'];
      check(used, 'layout.lootUsedPerTier', Object.fromEntries(LOOT_TIERS.map((t) => [t, N])));
      if (isObj(used)) {
        for (const t of LOOT_TIERS) {
          const v = used[t];
          if (isNum(v) && !(Number.isInteger(v) && v >= 0)) errors.push(`layout.lootUsedPerTier.${t} must be an integer >= 0`);
        }
      }
      const f = layout['lootCandidateFactorMin'];
      if (isNum(f) && !(f >= 1)) errors.push('layout.lootCandidateFactorMin must be >= 1');
      const sp = layout['minLootSpacing'];
      if (isNum(sp) && !(sp >= 0)) errors.push('layout.minLootSpacing must be >= 0');
      const c = layout['minCoverFraction'];
      if (isNum(c) && !(c >= 0 && c <= 1)) errors.push('layout.minCoverFraction must be in [0, 1]');
    }
  }

  // loot.guaranteedWeapon
  const gw = get(raw['loot'], 'guaranteedWeapon');
  if (need(gw, 'loot.guaranteedWeapon')) {
    if (!isObj(gw)) errors.push('loot.guaranteedWeapon must be an object');
    else {
      const w = gw['weights'];
      if (!isObj(w)) errors.push('loot.guaranteedWeapon.weights must be an object');
      else {
        let sum = 0;
        for (const k of dataKeys(w)) {
          const v = w[k];
          if (!(M2C_GUN_IDS as readonly string[]).includes(k)) errors.push(`loot.guaranteedWeapon.weights.${k} is not a gun`);
          else if (!(isNum(v) && v >= 0)) errors.push(`loot.guaranteedWeapon.weights.${k} must be a number >= 0`);
          else sum += v;
        }
        if (!(sum > 0)) errors.push('loot.guaranteedWeapon.weights must have a positive sum');
      }
      weights4(gw['levels'], 'loot.guaranteedWeapon.levels');
    }
  }

  // bots.melee / rpg / smoke / scopes
  const bots = raw['bots'];
  const melee = get(bots, 'melee');
  if (need(melee, 'bots.melee')) {
    check(melee, 'bots.melee', BOT_MELEE_SPEC);
    check(get(melee, 'lootValue'), 'bots.melee.lootValue', Object.fromEntries(['fists', ...MELEE_IDS].map((k) => [k, N])));
  }
  const rpg = get(bots, 'rpg');
  if (need(rpg, 'bots.rpg')) {
    check(rpg, 'bots.rpg', BOT_RPG_SPEC);
    const lo = get(rpg, 'minRange');
    const hi = get(rpg, 'maxRange');
    if (isNum(lo) && isNum(hi) && !(lo <= hi)) errors.push('bots.rpg.minRange must be <= maxRange');
  }
  const smoke = get(bots, 'smoke');
  if (need(smoke, 'bots.smoke')) check(smoke, 'bots.smoke', BOT_SMOKE_SPEC);
  const bs = get(bots, 'scopes');
  if (need(bs, 'bots.scopes')) {
    check(bs, 'bots.scopes', { lootScoreScope: N });
    check(get(bs, 'mountedMaxRangeMultiplier'), 'bots.scopes.mountedMaxRangeMultiplier', Object.fromEntries(SCOPE_IDS.map((k) => [k, N])));
  }
}

/** Checks one override value against the base value at `path` (path without the `maps.<id>.` prefix). */
function checkOverride(base: unknown, ov: unknown, path: string, prefix: string, errors: string[]): void {
  if (MAP_OVERRIDE_FORBIDDEN.includes(path)) {
    errors.push(`${prefix}${path} may not be overridden per map`);
    return;
  }
  if (base === undefined) {
    errors.push(`${prefix}${path} does not exist in the base balance (add it to the base first)`);
    return;
  }
  if (isObj(base)) {
    if (!isObj(ov)) {
      errors.push(`${prefix}${path} must be an object (it merges into the base object)`);
      return;
    }
    const open = OPEN_RECORD_PATHS.includes(path);
    for (const k of dataKeys(ov)) {
      if (open && !(k in base)) continue; // value checked by the merged validation
      checkOverride(base[k], ov[k], `${path}.${k}`, prefix, errors);
    }
    return;
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(ov)) errors.push(`${prefix}${path} must be an array (arrays replace wholesale)`);
    return;
  }
  const kindOf = (v: unknown): string => (v === null ? 'null' : typeof v);
  if (base !== null && kindOf(ov) !== kindOf(base)) errors.push(`${prefix}${path} must be a ${kindOf(base)}`);
}

/**
 * M2b (ADR 0005 §4) deep merge: objects merge key by key, arrays and scalars replace wholesale, `_` keys of the
 * override are skipped. Never mutates its inputs; shares untouched base subtrees.
 */
export function deepMergeBalance(base: unknown, override: unknown): unknown {
  if (!isObj(base) || !isObj(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const k of dataKeys(override)) out[k] = deepMergeBalance(base[k], override[k]);
  return out;
}

/** Base merged with one maps entry (zoneTheme stripped); the result has no `maps` block. */
function mergeEntry(base: Record<string, unknown>, entry: Record<string, unknown>): Record<string, unknown> {
  const ov: Record<string, unknown> = { ...entry };
  delete ov['zoneTheme'];
  const merged = deepMergeBalance(base, ov) as Record<string, unknown>;
  delete merged['maps'];
  return merged;
}

/**
 * M2b (ADR 0005 §4): the effective balance of a match on `mapId` = base deep-merged with `maps[mapId]`. A map without
 * an entry plays the base. The result has no `maps` block. Pure; callers cache it per map id (server: per match,
 * client: per map change). Already validated by validateBalance(base), so no second validation here.
 */
export function balanceForMap(base: Balance, mapId: string): Balance {
  const entry = base.maps?.[mapId];
  const merged = entry
    ? mergeEntry(base as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
    : (({ maps: _maps, ...rest }) => rest)(base);
  return merged as unknown as Balance;
}

/**
 * M2b: zone theme of a map. The `maps.<id>.zoneTheme` entry, else 'tide' for island maps and 'sprinklers' for indoor
 * maps (the fallback only covers the window before game-designer adds the `maps` block).
 */
export function zoneThemeOf(base: Balance, mapId: string, kind: 'island' | 'indoor'): ZoneTheme {
  return base.maps?.[mapId]?.zoneTheme ?? (kind === 'indoor' ? 'sprinklers' : 'tide');
}

/** Validated balance for composition roots. Everything else receives Balance by injection. */
export const BALANCE: Balance = validateBalance(balanceJson);

/** Convenience: per-gun ammo type (never null for guns). */
export const ammoFor = (balance: Balance, gun: GunId): AmmoId => balance.weapons[gun].ammo as AmmoId;

/**
 * M2a: sight of the item in hand ('grenade' has none). Pure lookup; safe for render/ui (they receive Balance by
 * injection).
 */
export const sightOf = (balance: Balance, held: WeaponId | 'grenade' | 'smoke'): SightType =>
  held === 'grenade' || held === 'smoke' ? 'none' : balance.weapons[held].sight;

/**
 * M2a: true for scope_4x / scope_8x (full-screen scope view at adsProgress 1; scope glint for remotes). A type guard,
 * so Ui can use it instead of its own copy (REVIEW-M2a L2).
 */
export const isScopeSight = (sight: SightType): sight is 'scope_4x' | 'scope_8x' =>
  sight === 'scope_4x' || sight === 'scope_8x';

/** M2a: balance entry of an armor piece by slot and tier. */
export const armorBalance = (balance: Balance, slot: ArmorSlot, tier: ArmorTier): ArmorBalance =>
  balance.items[`${slot}_${tier}` as ArmorId];

// ---------------------------------------------------------------------------------------------
// M2c effective stats (ADR 0007 §2, §5). ONE rule for the sim, client prediction, the HUD and bots. Pure lookups that
// tolerate a pre-merge balance (no `levels` / `scopes` block = L1 numbers and built-in sights).
// ---------------------------------------------------------------------------------------------

/** M2c: the balance entry of any weapon id, including the M2c ones. Throws if missing (a data bug). */
export function weaponBalance(balance: Balance, id: M2cWeaponId): WeaponBalance {
  const w = (balance.weapons as Partial<Record<M2cWeaponId, WeaponBalance>>)[id];
  if (!w) throw new Error(`balance.weapons.${id} is missing`);
  return w;
}

/** M2c (levels.md): multiplier for one field at a level: override, else class default, else 1. Fists: always 1. */
export function levelMultiplier(balance: Balance, id: M2cWeaponId, field: LevelField, level: ItemLevel): number {
  const lv = balance.levels;
  if (!lv || id === 'fists') return 1;
  const own = lv.overrides[id]?.[field];
  if (own) return own[level - 1] ?? 1;
  const cls = isMeleeId(id) ? lv.melee[field] : lv.gun[field];
  return cls ? (cls[level - 1] ?? 1) : 1;
}

/** M2c: a weapon's numbers at a level with a mounted scope (levels.md "What a level changes", scopes.md). */
export interface EffectiveWeapon extends Omit<WeaponBalance, 'sight'> {
  id: M2cWeaponId;
  level: ItemLevel;
  /** The scope that applied, or null (none mounted, or it does not fit this gun). */
  scope: ScopeId | null;
  /** weapons.<id>.sight. */
  builtInSight: M2cSightType;
  /** The mounted scope's sight, else builtInSight. */
  sight: M2cSightType;
  /** Melee: hitFrameMs x the fireIntervalMs level multiplier. 0 for every non-melee weapon. */
  hitFrameMs: number;
}

/**
 * M2c: effective stats. damage, reloadMs, fireIntervalMs and spreadDeg x level multipliers (melee hitFrameMs with
 * fireIntervalMs). With a fitting scope: sight and adsZoom from `scopes.<id>`, and adsTimeMs / adsSpreadMultiplier /
 * adsMoveMultiplier x factor[mounted] / factor[built-in]. Hip fire, range, falloff, mag and pellets never change.
 * Allocates one object; cache per (id, level, scope) on hot paths.
 */
export function effectiveWeapon(
  balance: Balance,
  id: M2cWeaponId,
  level: ItemLevel = 1,
  scope: ScopeId | null = null,
): EffectiveWeapon {
  const base = weaponBalance(balance, id);
  const m = (f: LevelField): number => levelMultiplier(balance, id, f, level);
  const fire = m('fireIntervalMs');
  const out: EffectiveWeapon = {
    ...base,
    id,
    level,
    scope: null,
    builtInSight: base.sight,
    sight: base.sight,
    damage: base.damage * m('damage'),
    reloadMs: base.reloadMs * m('reloadMs'),
    fireIntervalMs: base.fireIntervalMs * fire,
    spreadDeg: base.spreadDeg * m('spreadDeg'),
    hitFrameMs: isMeleeId(id) ? ((base as Partial<MeleeFields>).hitFrameMs ?? 0) * fire : 0,
  };
  const sc = balance.scopes;
  if (scope !== null && sc && isGunWithScope(balance, id, scope)) {
    const mounted = sc[scope];
    const fm = sc.sightFactors[mounted.sight];
    const fd = base.sight === 'none' ? undefined : sc.sightFactors[base.sight as ScopedSightType];
    if (fm && fd) {
      out.scope = scope;
      out.sight = mounted.sight;
      out.adsZoom = mounted.zoom;
      out.adsTimeMs = (base.adsTimeMs * fm.adsTime) / fd.adsTime;
      out.adsSpreadMultiplier = (base.adsSpreadMultiplier * fm.adsSpread) / fd.adsSpread;
      out.adsMoveMultiplier = (base.adsMoveMultiplier * fm.adsMove) / fd.adsMove;
    }
  }
  return out;
}

const isGunWithScope = (balance: Balance, id: M2cWeaponId, scope: ScopeId): id is M2cGunId =>
  (M2C_GUN_IDS as readonly string[]).includes(id) && scopeFits(balance, id as M2cGunId, scope);

/** M2c (rpg.md): rocket blast maxDamage at a level (scales with the rpg's damage multiplier). */
export function rocketBlastMaxDamage(balance: Balance, level: ItemLevel): number {
  const rpg = balance.weapons.rpg;
  if (!rpg) throw new Error('balance.weapons.rpg is missing');
  return rpg.rocket.blast.maxDamage * levelMultiplier(balance, 'rpg', 'damage', level);
}

/** M2c (scopes.md): the scopes a gun accepts ([] for guns not listed, melee and fists). */
export function compatibleScopes(balance: Balance, gun: M2cWeaponId): readonly ScopeId[] {
  return (balance.scopes?.compatible as Partial<Record<string, ScopeId[]>> | undefined)?.[gun] ?? [];
}

/** M2c: the gun accepts this scope. */
export const scopeFits = (balance: Balance, gun: M2cWeaponId, scope: ScopeId): boolean =>
  compatibleScopes(balance, gun).includes(scope);

/** M2c: auto-mount rank of a sight (scopes.sightFactors.<sight>.rank); -1 for 'none' or without a scopes block. */
export function sightRank(balance: Balance, sight: M2cSightType): number {
  if (sight === 'none') return -1;
  return balance.scopes?.sightFactors[sight]?.rank ?? -1;
}

/**
 * M2c: the effective sight of an item in hand (PlayerState.sight, AdsView.sight, localAdsChanged.sight): 'none' for
 * throwables, fists and melee; a fitting mounted scope's sight; else the gun's built-in sight.
 */
export function effectiveSight(balance: Balance, held: M2cHeldId, scope: ScopeId | null = null): M2cSightType {
  if (held === 'grenade' || held === 'smoke') return 'none';
  const w = weaponBalance(balance, held);
  if (scope !== null && balance.scopes && isGunWithScope(balance, held, scope)) return balance.scopes[scope].sight;
  return w.sight;
}

/**
 * M2c (scopes.md "Network"): the full-screen scope overlay in first person (Ui) at full ADS: 2x, 4x and 8x.
 * `isScopeSight` (4x / 8x) stays the rule for the remote scope glint and the bots' "scoped" behaviour.
 */
export const hasScopeOverlay = (sight: M2cSightType): sight is 'scope_2x' | 'scope_4x' | 'scope_8x' =>
  sight === 'scope_2x' || sight === 'scope_4x' || sight === 'scope_8x';

/** M2c: armor balance by slot and tier 1-4 (vest_4 / helmet_4 once merged). */
export function armorBalanceM2c(balance: Balance, slot: ArmorSlot, tier: M2cArmorTier): ArmorBalance {
  const a = (balance.items as unknown as Partial<Record<string, ArmorBalance>>)[`${slot}_${tier}`];
  if (!a) throw new Error(`balance.items.${slot}_${tier} is missing`);
  return a;
}
