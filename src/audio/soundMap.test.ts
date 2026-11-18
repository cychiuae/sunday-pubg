import { describe, expect, it } from 'vitest';
import type { ArmorHit, ShotImpact } from '../shared/types';
import { ARMOR_IDS, ITEM_IDS, STANCES, WEAPON_IDS } from '../shared/types';
import { AUDIO_TUNING, CUES } from './cues';
import {
  armorPieces,
  armorVariant,
  blastCloseness,
  bounceIntensity,
  confirmArmorCue,
  countdownIntensity,
  damageArmorCue,
  footCue,
  impactCue,
  isWaterBlast,
  itemClass,
  landIntensity,
  pickupCue,
  remoteHitVariant,
  sceneOf,
  selectImpacts,
  shotCue,
  zoneThemeCues,
} from './soundMap';
import { ZONE_THEMES } from '../shared/balance';

const hit = (tier: 1 | 2 | 3, broken = false): ArmorHit => ({ tier, absorbed: 10, broken });

const imp = (surface: ShotImpact['surface'], x = 0): ShotImpact => ({ point: { x, y: 0, z: 0 }, surface, playerId: null, headshot: false });

describe('event -> cue mapping', () => {
  it('maps every weapon to a distinct local and remote shot cue', () => {
    const seen = new Set<string>();
    for (const w of WEAPON_IDS) {
      const local = shotCue(w, true);
      const remote = shotCue(w, false);
      expect(CUES[local].spatial).toBe(false);
      expect(CUES[remote].spatial).toBe(true);
      seen.add(local);
      seen.add(remote);
    }
    expect(seen.size).toBe(WEAPON_IDS.length * 2);
  });

  it('remote gunshots carry much farther than fists', () => {
    for (const w of ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'] as const) {
      expect(CUES[shotCue(w, false)].maxDistance).toBeGreaterThan(100);
    }
    expect(CUES[shotCue('fists', false)].maxDistance).toBeLessThan(30);
  });

  it('the sniper carries farthest of all guns, the LMG at least as far as the rifle', () => {
    const range = (w: (typeof WEAPON_IDS)[number]): number => CUES[shotCue(w, false)].maxDistance;
    for (const w of WEAPON_IDS) if (w !== 'sniper') expect(range('sniper')).toBeGreaterThan(range(w));
    expect(range('lmg')).toBeGreaterThanOrEqual(range('rifle'));
    expect(shotCue('dmr', true)).toBe('shot.dmr.local');
    expect(shotCue('lmg', false)).toBe('shot.lmg.remote');
  });

  it('maps impacts by surface and leaves players to damage events', () => {
    expect(impactCue('terrain')).toBe('impact.ground');
    expect(impactCue('prop')).toBe('impact.prop');
    expect(impactCue('water')).toBe('impact.water');
    expect(impactCue('player')).toBeNull();
    expect(impactCue('none')).toBeNull();
    expect(impactCue('glass')).toBe('impact.glass'); // M2b
  });

  it('M2b: glass is its own impact surface in the per-shot selection', () => {
    const glass = imp('none', 9);
    (glass as { surface: string }).surface = 'glass';
    expect(selectImpacts([imp('terrain', 1), glass, imp('prop', 3)], 3).map((i) => i.point.x)).toEqual([1, 9, 3]);
    expect(selectImpacts([glass, glass], 3)).toHaveLength(1);
  });

  it('M2b: every zone theme has start, enter and exit cues; only tide and sprinklers loop', () => {
    for (const theme of ZONE_THEMES) {
      const c = zoneThemeCues(theme);
      for (const cue of [c.start, c.enter, c.exit]) expect(CUES[cue], `${theme}:${cue}`).toBeDefined();
      if (c.loop) expect(CUES[c.loop].bus).toBe('ambience');
    }
    expect(zoneThemeCues('tide')).toMatchObject({ start: 'zone.tideRising', loop: 'zone.tideLoop', enter: 'zone.enterSurf' });
    expect(zoneThemeCues('sprinklers')).toMatchObject({ start: 'zone.sprinklerStart', loop: 'zone.sprinklerLoop', enter: 'zone.enterSpray' });
    expect(zoneThemeCues('lightsOut').loop).toBeNull();
    expect(sceneOf('indoor')).toBe('indoor');
    expect(sceneOf('island')).toBe('island');
    expect(sceneOf(undefined)).toBe('island');
  });

  it('M2b: grenade fuse ticks outrank footsteps; chute pops carry farther than jumps; carrier beds have sane ranges', () => {
    expect(CUES['grenade.fuseTick'].priority).toBeGreaterThan(CUES['foot.remote'].priority);
    expect(CUES['grenade.fuseTick'].maxDistance).toBeLessThanOrEqual(12);
    expect(CUES['drop.chutePop'].maxDistance).toBeGreaterThan(CUES['drop.jump'].maxDistance);
    expect(CUES['amb.keys'].bus).toBe('ambience');
    for (const def of Object.values(AUDIO_TUNING.carrier)) {
      expect(def.maxDistance).toBeGreaterThan(def.refDistance);
      expect(def.gain).toBeGreaterThan(0);
    }
    expect(AUDIO_TUNING.carrier.seaplane.maxDistance).toBeGreaterThan(AUDIO_TUNING.carrier.drone.maxDistance);
  });

  it('voices at most one impact per surface and at most `max` per shot', () => {
    const pellets = [imp('terrain', 1), imp('terrain', 2), imp('player'), imp('prop', 3), imp('water', 4), imp('none')];
    const chosen = selectImpacts(pellets, 2);
    expect(chosen.map((i) => i.surface)).toEqual(['terrain', 'prop']);
    expect(chosen[0]?.point.x).toBe(1);
    expect(selectImpacts(pellets, 5).map((i) => i.surface)).toEqual(['terrain', 'prop', 'water']);
    expect(selectImpacts([imp('player'), imp('none')])).toEqual([]);
  });

  it('maps every item to a pickup cue by class', () => {
    for (const item of ITEM_IDS) expect(CUES[pickupCue(item)]).toBeDefined();
    expect(pickupCue('rifle')).toBe('pickup.weapon');
    expect(pickupCue('ammo_shell')).toBe('pickup.ammo');
    expect(pickupCue('medkit')).toBe('pickup.heal');
    expect(pickupCue('sniper')).toBe('pickup.weapon');
    expect(pickupCue('ammo_sniper')).toBe('pickup.ammo');
    expect(pickupCue('grenade')).toBe('pickup.grenade');
    for (const id of ARMOR_IDS) expect(pickupCue(id)).toBe(id.startsWith('vest') ? 'pickup.vest' : 'pickup.helmet');
    expect(itemClass('bandage')).toBe('heal');
    expect(itemClass('helmet_2')).toBe('helmet');
  });

  it('maps armor hits per piece: separate vest / helmet cues, a break cue per piece, tier in the variant', () => {
    expect(armorVariant('vest', hit(2))).toBe('vest2');
    expect(armorVariant('helmet', hit(3, true))).toBe('helmetBreak');
    expect(damageArmorCue('vest', hit(1))).toBe('damage.vest');
    expect(damageArmorCue('vest', hit(1, true))).toBe('damage.vestBreak');
    expect(damageArmorCue('helmet', hit(1))).toBe('damage.helmet');
    expect(damageArmorCue('helmet', hit(1, true))).toBe('damage.helmetBreak');
    expect(confirmArmorCue('vest', hit(2))).toBe('hitConfirm.vest');
    expect(confirmArmorCue('vest', hit(2, true))).toBe('hitConfirm.vestBreak');
    expect(confirmArmorCue('helmet', hit(2))).toBe('hitConfirm.helmet');
    expect(confirmArmorCue('helmet', hit(2, true))).toBe('hitConfirm.helmetBreak');
    expect(armorPieces({ vest: hit(1), helmet: hit(2) }).map(([s]) => s)).toEqual(['helmet', 'vest']);
    expect(armorPieces({ vest: null, helmet: null })).toEqual([]);
  });

  it('picks one remote hit variant: break > armor > head > body', () => {
    expect(remoteHitVariant({ headshot: false, vest: null, helmet: null })).toBe('body');
    expect(remoteHitVariant({ headshot: true, vest: null, helmet: null })).toBe('head');
    expect(remoteHitVariant({ headshot: true, vest: null, helmet: hit(3) })).toBe('helmet3');
    expect(remoteHitVariant({ headshot: false, vest: hit(1), helmet: null })).toBe('vest1');
    expect(remoteHitVariant({ headshot: true, vest: hit(1, true), helmet: hit(2) })).toBe('vestBreak');
    expect(remoteHitVariant({ headshot: true, vest: hit(1, true), helmet: hit(2, true) })).toBe('helmetBreak');
  });

  it('maps footsteps by stance; crouch and crawl are shorter range than standing for others', () => {
    for (const s of STANCES) {
      expect(CUES[footCue(s, true)].spatial).toBe(false);
      expect(CUES[footCue(s, false)].spatial).toBe(true);
    }
    expect(footCue('prone', true)).toBe('foot.crawl.local');
    const r = (s: (typeof STANCES)[number]): number => CUES[footCue(s, false)].maxDistance;
    expect(r('crouch')).toBeLessThan(r('stand'));
    expect(r('prone')).toBeLessThan(r('crouch'));
  });

  it('grenade helpers: bounce intensity, water blast, blast closeness', () => {
    expect(bounceIntensity(0)).toBe(0);
    expect(bounceIntensity(6)).toBeCloseTo(0.5, 6);
    expect(bounceIntensity(99)).toBe(1);
    expect(bounceIntensity(Number.NaN)).toBe(0);
    expect(isWaterBlast({ x: 0, y: -0.3, z: 0 }, undefined)).toBe(true);
    expect(isWaterBlast({ x: 0, y: 0.4, z: 0 }, 'water')).toBe(true);
    expect(isWaterBlast({ x: 0, y: 0.4, z: 0 }, 'terrain')).toBe(false);
    expect(blastCloseness(null, 6)).toBeNull();
    expect(blastCloseness(7, 6)).toBeNull();
    expect(blastCloseness(0, 6)).toBe(1);
    expect(blastCloseness(3, 6)).toBeCloseTo(0.5, 6);
    expect(blastCloseness(6, 6)).toBe(0);
    expect(blastCloseness(1, 0)).toBeNull();
  });

  it('scales landing intensity and countdown emphasis', () => {
    expect(landIntensity(0)).toBe(0);
    expect(landIntensity(-3)).toBe(0);
    expect(landIntensity(7.5)).toBeCloseTo(0.5, 6);
    expect(landIntensity(100)).toBe(1);
    expect(landIntensity(Number.NaN)).toBe(0);
    expect(countdownIntensity(5)).toBe(0);
    expect(countdownIntensity(3)).toBe(1);
  });
});

describe('cue table sanity', () => {
  it('has valid numbers for every cue', () => {
    for (const [id, def] of Object.entries(CUES)) {
      expect(def.priority, id).toBeGreaterThanOrEqual(0);
      expect(def.priority, id).toBeLessThanOrEqual(100);
      expect(def.maxInstances, id).toBeGreaterThanOrEqual(1);
      expect(def.gain, id).toBeGreaterThan(0);
      expect(def.gain, id).toBeLessThanOrEqual(1);
      if (def.spatial) {
        expect(def.maxDistance, id).toBeGreaterThan(def.refDistance);
        expect(Number.isFinite(def.maxDistance), id).toBe(true);
      }
    }
  });

  it('puts PvP-critical cues above ambience and impacts', () => {
    expect(CUES['foot.remote'].priority).toBeGreaterThan(CUES['impact.ground'].priority);
    expect(CUES['hitConfirm.kill'].priority).toBeGreaterThan(CUES['shot.smg.local'].priority);
    expect(CUES['damage.hp'].priority).toBeGreaterThan(CUES['shot.rifle.remote'].priority);
    expect(CUES['amb.gull'].priority).toBeLessThan(CUES['impact.water'].priority);
    expect(CUES['explosion'].priority).toBeGreaterThanOrEqual(CUES['shot.sniper.remote'].priority);
    expect(CUES['grenade.bounce'].priority).toBeGreaterThan(CUES['foot.remote'].priority);
    expect(CUES['grenade.pin'].maxDistance).toBeLessThanOrEqual(15);
    expect(CUES['stance.change'].maxDistance).toBe(15);
    // The ear ring must not be dulled by the sfx/ambience muffle it plays with.
    expect(CUES['explosion.ring'].bus).toBe('ui');
  });
});
