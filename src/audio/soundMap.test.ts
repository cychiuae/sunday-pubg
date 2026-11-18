import { describe, expect, it } from 'vitest';
import type { ShotImpact } from '../shared/types';
import { ITEM_IDS, WEAPON_IDS } from '../shared/types';
import { CUES } from './cues';
import { countdownIntensity, hitKind, impactCue, itemClass, landIntensity, pickupCue, selectImpacts, shotCue } from './soundMap';

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
    for (const w of ['pistol', 'smg', 'shotgun', 'rifle'] as const) {
      expect(CUES[shotCue(w, false)].maxDistance).toBeGreaterThan(100);
    }
    expect(CUES[shotCue('fists', false)].maxDistance).toBeLessThan(30);
  });

  it('maps impacts by surface and leaves players to damage events', () => {
    expect(impactCue('terrain')).toBe('impact.ground');
    expect(impactCue('prop')).toBe('impact.prop');
    expect(impactCue('water')).toBe('impact.water');
    expect(impactCue('player')).toBeNull();
    expect(impactCue('none')).toBeNull();
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
    expect(pickupCue('vest')).toBe('pickup.vest');
    expect(itemClass('bandage')).toBe('heal');
  });

  it('classifies armor hits from last known armor', () => {
    expect(hitKind(undefined, 0)).toBe('body');
    expect(hitKind(0, 0)).toBe('body');
    expect(hitKind(50, 35)).toBe('armor');
    expect(hitKind(undefined, 10)).toBe('armor');
    expect(hitKind(35, 0)).toBe('armorBreak');
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
  });
});
