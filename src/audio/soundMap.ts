/**
 * Pure event -> cue mapping helpers. Owner: audio-designer. Full table in docs/audio/AUDIO.md section 4.
 */
import type { ZoneTheme } from '../shared/balance';
import type {
  ArmorHit,
  ArmorSlot,
  GlassSurface,
  ImpactSurface,
  ItemLevel,
  LookId,
  M2cItemId,
  M2cSightType,
  M2cWeaponId,
  MeleeId,
  ShotImpact,
  Stance,
  Vec3,
} from '../shared/types';
import { AUDIO_TUNING, type CueId } from './cues';

/**
 * Shot cue per weapon. M2c: melee swings are voiced by meleeSwing and the rpg launch by rocketFired, so a `shotFired`
 * for those (if a producer ever sends one) maps to null and stays silent (never voiced twice).
 */
export function shotCue(weapon: M2cWeaponId, isLocal: boolean): CueId | null {
  const side = isLocal ? 'local' : 'remote';
  switch (weapon) {
    case 'fists':
      return `shot.fists.${side}`;
    case 'pistol':
      return `shot.pistol.${side}`;
    case 'smg':
      return `shot.smg.${side}`;
    case 'shotgun':
      return `shot.shotgun.${side}`;
    case 'rifle':
      return `shot.rifle.${side}`;
    case 'lmg':
      return `shot.lmg.${side}`;
    case 'dmr':
      return `shot.dmr.${side}`;
    case 'sniper':
      return `shot.sniper.${side}`;
    case 'dbshotgun':
      return `shot.dbshotgun.${side}`;
    case 'revolver':
      return `shot.revolver.${side}`;
    case 'knife':
    case 'machete':
    case 'paddle':
    case 'rpg':
      return null;
  }
}

/**
 * Impact cue for a ray end, or null when the impact makes no world sound ('player' is voiced by damage events).
 * M2b: `'glass'` (glass walls and kit parts) is typed here through GlassSurface, so this compiles before and after the
 * C-gate adds it to ImpactSurface.
 */
export function impactCue(surface: ImpactSurface | GlassSurface): CueId | null {
  switch (surface) {
    case 'terrain':
      return 'impact.ground';
    case 'prop':
      return 'impact.prop';
    case 'water':
      return 'impact.water';
    case 'glass':
      return 'impact.glass';
    case 'player':
    case 'none':
      return null;
  }
}

/**
 * Picks which impacts of one shot get a sound: at most one per surface type and at most `max` total, in ray order.
 * Shotguns fire many pellets; voicing each would be mush and waste voices.
 */
export function selectImpacts(impacts: readonly ShotImpact[], max: number = AUDIO_TUNING.maxImpactsPerShot): ShotImpact[] {
  const out: ShotImpact[] = [];
  let seen = 0; // bitmask: 1 terrain, 2 prop, 4 water, 8 glass
  for (const imp of impacts) {
    if (out.length >= max) break;
    const s: string = imp.surface;
    const bit = s === 'terrain' ? 1 : s === 'prop' ? 2 : s === 'water' ? 4 : s === 'glass' ? 8 : 0;
    if (bit === 0 || (seen & bit) !== 0) continue;
    seen |= bit;
    out.push(imp);
  }
  return out;
}

export type ItemSoundClass = 'weapon' | 'ammo' | 'heal' | 'vest' | 'helmet' | 'grenade' | 'scope';

export function itemClass(item: M2cItemId): ItemSoundClass {
  switch (item) {
    case 'knife':
    case 'machete':
    case 'paddle':
    case 'dbshotgun':
    case 'revolver':
    case 'rpg':
    case 'pistol':
    case 'smg':
    case 'shotgun':
    case 'rifle':
    case 'lmg':
    case 'dmr':
    case 'sniper':
      return 'weapon';
    case 'ammo_light':
    case 'ammo_heavy':
    case 'ammo_shell':
    case 'ammo_sniper':
    case 'ammo_rocket':
      return 'ammo';
    case 'bandage':
    case 'medkit':
      return 'heal';
    case 'vest_1':
    case 'vest_2':
    case 'vest_3':
    case 'vest_4':
      return 'vest';
    case 'helmet_1':
    case 'helmet_2':
    case 'helmet_3':
    case 'helmet_4':
      return 'helmet';
    case 'grenade':
    case 'smoke':
      return 'grenade';
    case 'scope_red_dot':
    case 'scope_2x':
    case 'scope_4x':
    case 'scope_8x':
      return 'scope';
  }
}

/** Pickup / equip cue: velcro for vests, strap click for helmets, a metal clink for grenades. */
export function pickupCue(item: M2cItemId): CueId {
  switch (itemClass(item)) {
    case 'scope':
      return 'pickup.scope';
    case 'weapon':
      return 'pickup.weapon';
    case 'ammo':
      return 'pickup.ammo';
    case 'heal':
      return 'pickup.heal';
    case 'vest':
      return 'pickup.vest';
    case 'helmet':
      return 'pickup.helmet';
    case 'grenade':
      return 'pickup.grenade';
  }
}

// --- Armor (M2a: two pieces, each with an ArmorHit per damage event) ---------------------------------------------

/** Recipe variant for one armor piece in one hit: `vest1`..`vest3`, `helmet1`..`helmet3`, or `vestBreak` / `helmetBreak`. */
export const armorVariant = (slot: ArmorSlot, hit: ArmorHit): string => (hit.broken ? `${slot}Break` : `${slot}${hit.tier}`);

/** The local victim's armor cue for one piece. */
export const damageArmorCue = (slot: ArmorSlot, hit: ArmorHit): CueId =>
  slot === 'vest' ? (hit.broken ? 'damage.vestBreak' : 'damage.vest') : hit.broken ? 'damage.helmetBreak' : 'damage.helmet';

/** The local attacker's hit-confirm cue for one piece. */
export const confirmArmorCue = (slot: ArmorSlot, hit: ArmorHit): CueId =>
  slot === 'vest'
    ? hit.broken
      ? 'hitConfirm.vestBreak'
      : 'hitConfirm.vest'
    : hit.broken
      ? 'hitConfirm.helmetBreak'
      : 'hitConfirm.helmet';

/** The pieces a damage event touched, helmet first (a shotgun event can carry both). */
export function armorPieces(e: { vest: ArmorHit | null; helmet: ArmorHit | null }): [ArmorSlot, ArmorHit][] {
  const out: [ArmorSlot, ArmorHit][] = [];
  if (e.helmet) out.push(['helmet', e.helmet]);
  if (e.vest) out.push(['vest', e.vest]);
  return out;
}

/**
 * One variant for a remote-on-remote `hit.remote`: a break beats a plain armor hit (helmet before vest), which beats
 * a bare headshot, which beats a body hit.
 */
export function remoteHitVariant(e: { headshot: boolean; vest: ArmorHit | null; helmet: ArmorHit | null }): string {
  if (e.helmet?.broken) return 'helmetBreak';
  if (e.vest?.broken) return 'vestBreak';
  if (e.helmet) return armorVariant('helmet', e.helmet);
  if (e.vest) return armorVariant('vest', e.vest);
  return e.headshot ? 'head' : 'body';
}

// --- Movement and stance ----------------------------------------------------------------------------------------

/** Footstep cue by stance: crouch steps are quieter / shorter range for others, prone uses the crawl drag. */
export function footCue(stance: Stance, isLocal: boolean): CueId {
  if (stance === 'prone') return isLocal ? 'foot.crawl.local' : 'foot.crawl.remote';
  if (stance === 'crouch') return isLocal ? 'foot.local' : 'foot.crouch.remote';
  return isLocal ? 'foot.local' : 'foot.remote';
}

/** 0..1 landing intensity from downward speed. */
export function landIntensity(fallSpeed: number): number {
  const v = fallSpeed / AUDIO_TUNING.landFullSpeed;
  return v <= 0 || !Number.isFinite(v) ? 0 : v >= 1 ? 1 : v;
}

// --- Grenades ---------------------------------------------------------------------------------------------------

/** 0..1 bounce clink intensity from contact speed (m/s). */
export function bounceIntensity(speed: number): number {
  const v = speed / AUDIO_TUNING.bounceFullSpeed;
  return v <= 0 || !Number.isFinite(v) ? 0 : v >= 1 ? 1 : v;
}

/** Water variant when the blast is below the sea surface or the grenade's last contact was water. */
export const isWaterBlast = (pos: Vec3, lastContact: string | undefined): boolean =>
  pos.y < AUDIO_TUNING.seaLevelY || lastContact === 'water';

/**
 * 1 at point blank, 0 at the blast radius edge, null outside the radius (or no live local player). Drives the ear
 * ring and the sfx/ambience muffle.
 */
export function blastCloseness(localDistance: number | null, radius: number): number | null {
  if (localDistance === null || !Number.isFinite(localDistance) || !(radius > 0) || localDistance > radius) return null;
  return Math.min(1, Math.max(0, 1 - localDistance / radius));
}

/** Countdown beep pitch class: the last three seconds are higher and brighter. */
export const countdownIntensity = (secondsLeft: number): number => (secondsLeft <= 3 ? 1 : 0);

// --- Maps and zone themes (M2b) ---------------------------------------------------------------------------------

/** Ambience scene per map kind: the island beach, or the indoor office (HVAC, buzz, typing, reverb). */
export type AmbienceScene = 'island' | 'indoor';

export const sceneOf = (kind: 'island' | 'indoor' | undefined): AmbienceScene => (kind === 'indoor' ? 'indoor' : 'island');

/** Cues for one zone theme: shrink start sting, the loop while shrinking, and the local crossing in and out. */
export interface ZoneThemeCues {
  start: CueId;
  /** null = no loop for this theme. */
  loop: CueId | null;
  enter: CueId;
  exit: CueId;
  /** Recipe variants for start / enter / exit ('' if none). */
  startVariant: string;
  enterVariant: string;
  exitVariant: string;
}

const TIDE_CUES: ZoneThemeCues = {
  start: 'zone.tideRising', loop: 'zone.tideLoop', enter: 'zone.enterSurf', exit: 'zone.exitSurf',
  startVariant: '', enterVariant: '', exitVariant: '',
};
const SPRINKLER_CUES: ZoneThemeCues = {
  start: 'zone.sprinklerStart', loop: 'zone.sprinklerLoop', enter: 'zone.enterSpray', exit: 'zone.exitSpray',
  startVariant: '', enterVariant: '', exitVariant: '',
};
const LIGHTS_OUT_CUES: ZoneThemeCues = {
  start: 'zone.lights', loop: null, enter: 'zone.lights', exit: 'zone.lights',
  startVariant: 'down', enterVariant: 'enter', exitVariant: 'exit',
};

export function zoneThemeCues(theme: ZoneTheme): ZoneThemeCues {
  switch (theme) {
    case 'tide':
      return TIDE_CUES;
    case 'sprinklers':
      return SPRINKLER_CUES;
    case 'lightsOut':
      return LIGHTS_OUT_CUES;
  }
}

// --- M2c: item levels (docs/audio/M2c.md §6, §7) ------------------------------------------------------------------

/**
 * Level of a picked-up item for the sparkle: the event's `level` (weapons and melee), else the armor tier from the id
 * (`vest_4` -> 4). null = no sparkle (ammo, heals, throwables, scopes, missing level).
 */
export function pickupLevel(item: M2cItemId, level: ItemLevel | null | undefined): ItemLevel | null {
  const cls = itemClass(item);
  if (cls === 'vest' || cls === 'helmet') {
    const n = Number(item.slice(-1));
    return n === 1 || n === 2 || n === 3 || n === 4 ? n : null;
  }
  if (cls !== 'weapon') return null;
  return level === 1 || level === 2 || level === 3 || level === 4 ? level : null;
}

// --- M2c: melee (§2) ----------------------------------------------------------------------------------------------

export type MeleeMaterial = 'body' | 'head' | 'vest' | 'helmet' | 'glass' | 'wall' | 'ground' | 'water';

/** Contact material for a non-player meleeHit surface (null = nothing to voice). */
export function meleeSurfaceMaterial(surface: ImpactSurface | GlassSurface): MeleeMaterial | null {
  switch (surface) {
    case 'terrain':
      return 'ground';
    case 'prop':
      return 'wall';
    case 'water':
      return 'water';
    case 'glass':
      return 'glass';
    case 'player':
    case 'none':
      return null;
  }
}

/** Contact material on a player: armor beats bare (helmet only on head hits), head beats body. */
export function meleePlayerMaterial(e: { headshot: boolean; vest: ArmorHit | null; helmet: ArmorHit | null }): MeleeMaterial {
  if (e.helmet) return 'helmet';
  if (e.vest) return 'vest';
  return e.headshot ? 'head' : 'body';
}

/** `melee.hit` recipe variant. */
export const meleeHitVariant = (weapon: MeleeId, material: MeleeMaterial): string => `${weapon}.${material}`;

/** Whoosh peak time (s) from the event's windupMs, clamped (M2c §2.2). */
export function meleePeakS(windupMs: number): number {
  const s = Number.isFinite(windupMs) ? windupMs / 1000 : AUDIO_TUNING.meleePeakMinS;
  return Math.min(AUDIO_TUNING.meleePeakMaxS, Math.max(AUDIO_TUNING.meleePeakMinS, s));
}

/** Remote swing range per melee weapon (m): the knife is the quietest, the paddle's wind-up carries farthest. */
export const MELEE_SWING_RANGE_M: Readonly<Record<MeleeId, number>> = { knife: 14, machete: 16, paddle: 20 };

/** 1 inside 80 % of the weapon's swing range, then a linear fade to 0 at the range (remote swings). */
export function meleeRangeFade(weapon: string, d: number): number {
  const r = isMeleeWeapon(weapon) ? MELEE_SWING_RANGE_M[weapon] : MELEE_SWING_RANGE_M.machete;
  if (!(d > r * 0.8)) return 1;
  return Math.max(0, 1 - (d - r * 0.8) / (r * 0.2));
}

/** Is this held id a melee weapon (typed wide so it accepts pre- and post-gate unions). */
export const isMeleeWeapon = (w: string | null | undefined): w is MeleeId => w === 'knife' || w === 'machete' || w === 'paddle';

// --- M2c: rockets (§4) ----------------------------------------------------------------------------------------------

/**
 * Doppler-ish pitch ratio for a source at `src` moving with `vel` heard at `listener` (listener motion ignored).
 * > 1 approaching, < 1 receding, clamped to AUDIO_TUNING.rocketDoppler{Min,Max}.
 */
export function dopplerRatio(src: Vec3, vel: Vec3, listener: Vec3): number {
  const T = AUDIO_TUNING;
  const dx = listener.x - src.x;
  const dy = listener.y - src.y;
  const dz = listener.z - src.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d > 1e-6)) return 1;
  const vr = (vel.x * dx + vel.y * dy + vel.z * dz) / d;
  const denom = T.rocketSoundSpeed - vr;
  const r = denom > 1e-6 ? T.rocketSoundSpeed / denom : T.rocketDopplerMax;
  return r < T.rocketDopplerMin ? T.rocketDopplerMin : r > T.rocketDopplerMax ? T.rocketDopplerMax : r;
}

/** Rocket blast size factor from its radius (6 m = the frag): longer, not louder (§4.3). */
export function blastSize(radius: number): number {
  const s = Number.isFinite(radius) ? radius / 6 : 1;
  return Math.min(1.5, Math.max(0.8, s));
}

// --- M2c: smoke (§5) ------------------------------------------------------------------------------------------------

/** Hiss envelope (seconds) for one cloud: grow, hold, fade, and how far into it we start (late joiner). */
export interface SmokeShape {
  growS: number;
  holdS: number;
  fadeS: number;
  offsetS: number;
}

/**
 * Hiss shape from the cloud record (server ms) and the balance cloud timings (ms; null = audio fallbacks).
 * `now` = server ms when the loop starts (deployedAt for a fresh deploy).
 */
export function smokeShape(
  cloud: { deployedAt: number; fadeAt: number },
  now: number,
  cfg: { growMs: number; fadeMs: number } | null,
): SmokeShape {
  const T = AUDIO_TUNING;
  const growS = cfg ? Math.max(0, cfg.growMs) / 1000 : T.smokeFallbackGrowS;
  const fadeS = cfg ? Math.max(0, cfg.fadeMs) / 1000 : T.smokeFallbackFadeS;
  const untilFadeS = Math.max(0, (cloud.fadeAt - cloud.deployedAt) / 1000);
  const g = Math.min(growS, untilFadeS);
  const holdS = Math.max(0, untilFadeS - g);
  const offsetS = Number.isFinite(now) ? Math.max(0, (now - cloud.deployedAt) / 1000) : 0;
  return { growS: g, holdS, fadeS, offsetS };
}

/** Seconds left in the hiss (0 = over). */
export const smokeRemainingS = (s: SmokeShape): number => Math.max(0, s.growS + s.holdS + s.fadeS - s.offsetS);

// --- M2c: scopes (§7a) ----------------------------------------------------------------------------------------------

/** ADS sweep length (s) by sight: 0 for iron / red dot, then 2x < 4x < 8x. */
export function adsSweepS(sight: M2cSightType | string): number {
  switch (sight) {
    case 'scope_2x':
      return 0.14;
    case 'scope_4x':
      return 0.2;
    case 'scope_8x':
      return 0.3;
    default:
      return 0;
  }
}

// --- M2c: look presets (§8) -----------------------------------------------------------------------------------------

/** A detail one-shot scheduled by the engine while a look is active. Distances in metres around the listener. */
export interface LookDetail {
  cue: CueId;
  minS: number;
  maxS: number;
  minR: number;
  maxR: number;
  /** Height above the listener (negative = below), random in [minUp, maxUp]. */
  minUp: number;
  maxUp: number;
}

/** Island bed parameters (multipliers on the M2b bed; noon = all 1 / baseline). */
export interface IslandLook {
  scene: 'island';
  wave: number;
  waveLpHz: number;
  swellRate: number;
  wind: number;
  windHz: number;
  windQ: number;
  windGust: number;
  /** Gull call interval (s). */
  gullMinS: number;
  gullMaxS: number;
  details: readonly LookDetail[];
}

/** Office bed parameters (day = baseline). */
export interface OfficeLook {
  scene: 'indoor';
  hvac: number;
  buzz: number;
  /** Flicker depth multiplier, plus an extra slow stutter (0 = none). */
  flicker: number;
  stutter: number;
  /** Server fan whir bed level (0 = none). */
  fan: number;
  keysMinS: number;
  keysMaxS: number;
  details: readonly LookDetail[];
}

export type AmbienceLook = IslandLook | OfficeLook;

const T0 = AUDIO_TUNING;
const ISLAND_LOOKS: Readonly<Record<'morning' | 'noon' | 'golden' | 'overcast', IslandLook>> = {
  morning: {
    scene: 'island', wave: 0.8, waveLpHz: 380, swellRate: 0.85, wind: 0.7, windHz: 550, windQ: 0.6, windGust: 1,
    gullMinS: 5, gullMaxS: 12,
    details: [{ cue: 'amb.bird', minS: 6, maxS: 14, minR: 20, maxR: 50, minUp: 8, maxUp: 15 }],
  },
  noon: {
    scene: 'island', wave: 1, waveLpHz: 420, swellRate: 1, wind: 1, windHz: 550, windQ: 0.6, windGust: 1,
    gullMinS: T0.gullMinIntervalS, gullMaxS: T0.gullMaxIntervalS, details: [],
  },
  golden: {
    scene: 'island', wave: 0.9, waveLpHz: 360, swellRate: 0.9, wind: 1.1, windHz: 450, windQ: 0.6, windGust: 1,
    gullMinS: 12, gullMaxS: 25,
    details: [
      { cue: 'amb.crickets', minS: 4, maxS: 9, minR: 15, maxR: 40, minUp: -1, maxUp: 0 },
      { cue: 'amb.chime', minS: 18, maxS: 35, minR: 30, maxR: 60, minUp: 1, maxUp: 3 },
    ],
  },
  overcast: {
    scene: 'island', wave: 1.2, waveLpHz: 520, swellRate: 1.25, wind: 1.8, windHz: 550, windQ: 0.5, windGust: 2,
    gullMinS: 20, gullMaxS: 40,
    details: [{ cue: 'amb.palms', minS: 5, maxS: 12, minR: 15, maxR: 40, minUp: 4, maxUp: 9 }],
  },
};
const OFFICE_LOOKS: Readonly<Record<'day' | 'evening' | 'afterHours', OfficeLook>> = {
  day: { scene: 'indoor', hvac: 1, buzz: 1, flicker: 1, stutter: 0, fan: 0, keysMinS: T0.keysMinIntervalS, keysMaxS: T0.keysMaxIntervalS, details: [] },
  evening: {
    scene: 'indoor', hvac: 0.85, buzz: 0.9, flicker: 1, stutter: 0, fan: 0, keysMinS: 8, keysMaxS: 18,
    details: [{ cue: 'amb.copier', minS: 25, maxS: 50, minR: 20, maxR: 45, minUp: -1, maxUp: 0 }],
  },
  afterHours: {
    scene: 'indoor', hvac: 0.7, buzz: 0.5, flicker: 2, stutter: 1, fan: 0.06, keysMinS: 30, keysMaxS: 60,
    details: [
      { cue: 'amb.cooler', minS: 20, maxS: 40, minR: 15, maxR: 35, minUp: -1, maxUp: 0 },
      { cue: 'amb.hvacCycle', minS: 30, maxS: 60, minR: 10, maxR: 30, minUp: 4, maxUp: 8 },
    ],
  },
};

/** The default look of a scene (the M2b bed). */
export const defaultLookId = (scene: AmbienceScene): LookId => (scene === 'indoor' ? 'day' : 'noon');

/**
 * Bed parameters for a scene and look id. An unknown id, a missing id, or an id from the other map kind falls back
 * to the scene's default (noon / day).
 */
export function lookOf(scene: AmbienceScene, look: LookId | string | null | undefined): AmbienceLook {
  if (scene === 'indoor') {
    return (look && Object.prototype.hasOwnProperty.call(OFFICE_LOOKS, look) ? OFFICE_LOOKS[look as keyof typeof OFFICE_LOOKS] : OFFICE_LOOKS.day);
  }
  return look && Object.prototype.hasOwnProperty.call(ISLAND_LOOKS, look) ? ISLAND_LOOKS[look as keyof typeof ISLAND_LOOKS] : ISLAND_LOOKS.noon;
}

/** The resolved look id (for change detection): the given id when it belongs to the scene, else the default. */
export function resolveLookId(scene: AmbienceScene, look: LookId | string | null | undefined): string {
  const table = scene === 'indoor' ? OFFICE_LOOKS : ISLAND_LOOKS;
  return look && Object.prototype.hasOwnProperty.call(table, look) ? look : defaultLookId(scene);
}
