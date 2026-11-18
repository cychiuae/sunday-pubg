/**
 * Pure event -> cue mapping helpers. Owner: audio-designer. Full table in docs/audio/AUDIO.md section 4.
 */
import type { ImpactSurface, ItemId, ShotImpact, WeaponId } from '../shared/types';
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
  }
}

/** Impact cue for a ray end, or null when the impact makes no world sound ('player' is voiced by damage events). */
export function impactCue(surface: ImpactSurface): CueId | null {
  switch (surface) {
    case 'terrain':
      return 'impact.ground';
    case 'prop':
      return 'impact.prop';
    case 'water':
      return 'impact.water';
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
  let seen = 0; // bitmask: 1 terrain, 2 prop, 4 water
  for (const imp of impacts) {
    if (out.length >= max) break;
    const bit = imp.surface === 'terrain' ? 1 : imp.surface === 'prop' ? 2 : imp.surface === 'water' ? 4 : 0;
    if (bit === 0 || (seen & bit) !== 0) continue;
    seen |= bit;
    out.push(imp);
  }
  return out;
}

export type ItemSoundClass = 'weapon' | 'ammo' | 'heal' | 'vest';

export function itemClass(item: ItemId): ItemSoundClass {
  switch (item) {
    case 'pistol':
    case 'smg':
    case 'shotgun':
    case 'rifle':
      return 'weapon';
    case 'ammo_light':
    case 'ammo_heavy':
    case 'ammo_shell':
      return 'ammo';
    case 'bandage':
    case 'medkit':
      return 'heal';
    case 'vest':
      return 'vest';
  }
}

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
  }
}

/** What a damage event did to armor, from the victim's last known armor and the armor after the hit. */
export type HitKind = 'body' | 'armor' | 'armorBreak';

/**
 * `prevArmor` is the victim's armor from the previous damage event we saw (undefined if unknown).
 * armorAfter > 0 means armor absorbed part of the hit. armorAfter == 0 with prevArmor > 0 means it just broke.
 * Limitation: a first-ever hit that both meets and breaks armor reads as 'body' (see AUDIO.md contract gaps).
 */
export function hitKind(prevArmor: number | undefined, armorAfter: number): HitKind {
  if (armorAfter > 0) return 'armor';
  if (prevArmor !== undefined && prevArmor > 0) return 'armorBreak';
  return 'body';
}

/** 0..1 landing intensity from downward speed. */
export function landIntensity(fallSpeed: number): number {
  const v = fallSpeed / AUDIO_TUNING.landFullSpeed;
  return v <= 0 || !Number.isFinite(v) ? 0 : v >= 1 ? 1 : v;
}

/** Countdown beep pitch class: the last three seconds are higher and brighter. */
export const countdownIntensity = (secondsLeft: number): number => (secondsLeft <= 3 ? 1 : 0);
