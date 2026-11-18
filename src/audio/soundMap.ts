/**
 * Pure event -> cue mapping helpers. Owner: audio-designer. Full table in docs/audio/AUDIO.md section 4.
 */
import type { ZoneTheme } from '../shared/balance';
import type { ArmorHit, ArmorSlot, GlassSurface, ImpactSurface, ItemId, ShotImpact, Stance, Vec3, WeaponId } from '../shared/types';
import { AUDIO_TUNING, type CueId } from './cues';

export function shotCue(weapon: WeaponId, isLocal: boolean): CueId {
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

export type ItemSoundClass = 'weapon' | 'ammo' | 'heal' | 'vest' | 'helmet' | 'grenade';

export function itemClass(item: ItemId): ItemSoundClass {
  switch (item) {
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
      return 'ammo';
    case 'bandage':
    case 'medkit':
      return 'heal';
    case 'vest_1':
    case 'vest_2':
    case 'vest_3':
      return 'vest';
    case 'helmet_1':
    case 'helmet_2':
    case 'helmet_3':
      return 'helmet';
    case 'grenade':
      return 'grenade';
  }
}

/** Pickup / equip cue: velcro for vests, strap click for helmets, a metal clink for grenades. */
export function pickupCue(item: ItemId): CueId {
  switch (itemClass(item)) {
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
