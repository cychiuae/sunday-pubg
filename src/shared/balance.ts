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
  LootTier,
  SightType,
  Stance,
  StanceTransitionKey,
  WeaponId,
} from './types';
import {
  AMMO_IDS,
  ARMOR_IDS,
  ARMOR_PIECES,
  BOT_PERSONALITY_IDS,
  GUN_IDS,
  HEAL_IDS,
  ITEM_IDS,
  SIGHT_TYPES,
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

/** M2a: `items.grenade` (systems/grenades.md; see its `_note` for formulas). Unit rule: ms / degrees / metres. */
export interface GrenadeBalance {
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
  /** Blast radius; validated innerRadius < radius. */
  radius: number;
  innerRadius: number;
  maxDamage: number;
  minDamageFactor: number;
  /** The thrower is damaged by their own blast. */
  selfDamage: boolean;
  /** Blast LOS ray starts this far above the grenade centre. */
  losHeightOffset: number;
  /**
   * M2a addendum (optional; client only): the HUD danger indicator lists live grenades within radius + dangerMargin
   * metres of the local player. Absent = 2 (grenades.md "Danger indicator"). Must be >= 0.
   */
  dangerMargin?: number;
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
  /** Visual-only recoil per gun (FpRecoilBalance). */
  fpRecoil?: Partial<Record<GunId, FpRecoilBalance>>;
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
  /** M2a: range bands and loot value per gun. Absent guns use the M1 expectedBodyDps rule. */
  weaponPrefs?: Partial<Record<GunId, BotWeaponPrefBalance>>;
  /** M2a. */
  ads?: BotAdsBalance;
  /** M2a. */
  stance?: BotStanceBalance;
  /** M2a. */
  grenade?: BotGrenadeBalance;
  /** M2b: bot jump choice (drop.md). */
  drop?: BotDropBalance;
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
  };
  weapons: Record<WeaponId, WeaponBalance>;
  /** M2a: M1 `items.vest` removed; armor pieces and the grenade added. */
  items: Record<HealId, HealBalance> & Record<AmmoId, AmmoBalance> & Record<ArmorId, ArmorBalance> & {
    grenade: GrenadeBalance;
  };
  /** M2a: M1 `absorbFraction` moved per piece. Worn pieces with durability > 0 drop on death when true. */
  armor: { dropOnDeath: boolean };
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
const GRENADE_SPEC: Record<Exclude<keyof GrenadeBalance, 'dangerMargin'>, Kind> = {
  maxCarry: N, spawnQty: N, cookable: B, fuseMs: N, throwSpeedMin: N, throwSpeedMax: N, throwPitchMinDeg: N,
  throwPitchMaxDeg: N, throwLiftDeg: N, throwOriginForward: N, throwSpeedProneMultiplier: N, throwRecoveryMs: N,
  dropOnSwitchSpeed: N, gravity: N, restitution: N, friction: N, collisionRadius: N, restSpeed: N,
  waterVelocityDamping: N, bounceEventMinSpeed: N, radius: N, innerRadius: N, maxDamage: N, minDamageFactor: N,
  selfDamage: B, losHeightOffset: N,
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

  for (const [section, spec] of Object.entries(SECTION_SPEC)) check(raw[section], section, spec);

  // Weapons: per-id spec, ammo, sight (M2a).
  const weapons = raw['weapons'];
  for (const id of WEAPON_IDS) {
    const w = get(weapons, id);
    check(w, `weapons.${id}`, WEAPON_SPEC);
    const ammo = get(w, 'ammo');
    const ammoOk = id === 'fists' ? ammo === null : (AMMO_IDS as readonly unknown[]).includes(ammo);
    if (!ammoOk) errors.push(`weapons.${id}.ammo must be ${id === 'fists' ? 'null' : 'an AmmoId'}`);
    const sight = get(w, 'sight');
    if (!(SIGHT_TYPES as readonly unknown[]).includes(sight)) {
      errors.push(`weapons.${id}.sight must be one of ${SIGHT_TYPES.join('|')}`);
    } else if ((id === 'fists') !== (sight === 'none')) {
      errors.push(`weapons.${id}.sight must ${id === 'fists' ? 'be' : 'not be'} 'none'`);
    }
    const adsZoom = get(w, 'adsZoom');
    if (isNum(adsZoom) && adsZoom < 1) errors.push(`weapons.${id}.adsZoom must be >= 1`);
    const adsTimeMs = get(w, 'adsTimeMs');
    if (isNum(adsTimeMs) && adsTimeMs < 0) errors.push(`weapons.${id}.adsTimeMs must be >= 0`);
    // ADR 0004 addendum A1.7: a sighted weapon with adsTimeMs 0 could never engage ADS (adsMs stays 0).
    if (isNum(adsTimeMs) && sight !== 'none' && (SIGHT_TYPES as readonly unknown[]).includes(sight) && !(adsTimeMs > 0)) {
      errors.push(`weapons.${id}.adsTimeMs must be > 0 for a weapon with a sight`);
    }
  }

  // Items: heals, ammo, armor pieces (M2a), grenade (M2a).
  const items = raw['items'];
  for (const id of HEAL_IDS) check(get(items, id), `items.${id}`, HEAL_SPEC);
  for (const id of AMMO_IDS) check(get(items, id), `items.${id}`, AMMO_SPEC);
  for (const id of ARMOR_IDS) {
    const a = get(items, id);
    const path = `items.${id}`;
    check(a, path, ARMOR_SPEC);
    if (!isObj(a)) continue;
    const piece = ARMOR_PIECES[id];
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
    const { innerRadius, radius, throwSpeedMin, throwSpeedMax } = grenade;
    if (isNum(innerRadius) && isNum(radius) && !(innerRadius >= 0 && innerRadius < radius)) {
      errors.push('items.grenade.innerRadius must be in [0, radius)');
    }
    if (isNum(throwSpeedMin) && isNum(throwSpeedMax) && !(throwSpeedMin <= throwSpeedMax)) {
      errors.push('items.grenade.throwSpeedMin must be <= throwSpeedMax');
    }
    const { throwPitchMinDeg, throwPitchMaxDeg } = grenade;
    if (isNum(throwPitchMinDeg) && isNum(throwPitchMaxDeg) && !(throwPitchMinDeg < throwPitchMaxDeg)) {
      errors.push('items.grenade.throwPitchMinDeg must be < throwPitchMaxDeg');
    }
    const dm = grenade['dangerMargin'];
    if (dm !== undefined && !(isNum(dm) && dm >= 0)) errors.push('items.grenade.dangerMargin must be a number >= 0');
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

  // Loot tiers: objects of known ItemId -> non-negative weight (M2a: unknown ids are a data bug).
  const loot = raw['loot'];
  const tiers = get(loot, 'tiers');
  for (const tier of ['common', 'rare', 'epic'] as const) {
    const t = get(tiers, tier);
    if (!isObj(t)) {
      errors.push(`loot.tiers.${tier} must be an object`);
      continue;
    }
    for (const k of dataKeys(t)) {
      if (!(ITEM_IDS as readonly string[]).includes(k)) errors.push(`loot.tiers.${tier}.${k} is not an ItemId`);
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
      if (!(GUN_IDS as readonly string[]).includes(key)) errors.push(`clientFeel.fpRecoil.${key} is not a gun`);
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
      if (!(GUN_IDS as readonly string[]).includes(key)) {
        errors.push(`bots.weaponPrefs.${key} is not a gun (${GUN_IDS.join(', ')})`);
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
export const sightOf = (balance: Balance, held: WeaponId | 'grenade'): SightType =>
  held === 'grenade' ? 'none' : balance.weapons[held].sight;

/**
 * M2a: true for scope_4x / scope_8x (full-screen scope view at adsProgress 1; scope glint for remotes). A type guard,
 * so Ui can use it instead of its own copy (REVIEW-M2a L2).
 */
export const isScopeSight = (sight: SightType): sight is 'scope_4x' | 'scope_8x' =>
  sight === 'scope_4x' || sight === 'scope_8x';

/** M2a: balance entry of an armor piece by slot and tier. */
export const armorBalance = (balance: Balance, slot: ArmorSlot, tier: ArmorTier): ArmorBalance =>
  balance.items[`${slot}_${tier}` as ArmorId];
