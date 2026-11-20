import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { aimDirection, createRng, DEG2RAD } from '../math';
import type { WeaponId } from '../types';
import { adsProgressOf, applyArmorPiece, effectiveSpreadDeg, pelletDamage, rayCylinder, sampleCone } from './combat';

const b = BALANCE;
const rifle = b.weapons.rifle;

describe('combat math', () => {
  it('rifle falloff: 23 at 10 m, 18.975 at 60 m, 14.95 at 90 and 120 m (combat.md AT1)', () => {
    expect(pelletDamage(rifle, 10, false)).toBeCloseTo(23, 9);
    expect(pelletDamage(rifle, 60, false)).toBeCloseTo(18.975, 9);
    expect(pelletDamage(rifle, 90, false)).toBeCloseTo(14.95, 9);
    expect(pelletDamage(rifle, 120, false)).toBeCloseTo(14.95, 9);
  });

  it('headshot multiplier (AT2; the head zones are covered by stance.test.ts rayHitbox)', () => {
    expect(pelletDamage(rifle, 10, true)).toBeCloseTo(41.4, 9);
  });

  it('armor piece: a = min(durability, dmg x f); destroyed at 0 (armor.md AT1)', () => {
    const f = b.items.vest_2.absorbFraction;
    const a = applyArmorPiece({ tier: 2, durability: 55 }, 30, f);
    expect(a.absorbed).toBeCloseTo(12);
    expect(a.hpLoss).toBeCloseTo(18);
    expect(a.piece).toEqual({ tier: 2, durability: 43 });
    const c = applyArmorPiece(a.piece, 100, f);
    expect(c.absorbed).toBeCloseTo(40);
    expect(c.piece!.durability).toBeCloseTo(3);
    const d = applyArmorPiece(c.piece, 10, f);
    expect(d.absorbed).toBeCloseTo(3);
    expect(d.hpLoss).toBeCloseTo(7);
    expect(d.broken).toBe(true);
    expect(d.piece).toBeNull();
    expect(applyArmorPiece(null, 25, f)).toEqual({ piece: null, absorbed: 0, broken: false, hpLoss: 25 });
  });

  it('spread = spreadDeg x A x S x M x J (combat.md AT13, AT16)', () => {
    const still = { horizontalSpeed: 0, airborne: false };
    expect(effectiveSpreadDeg('rifle', b, { ...still, adsProgress: 1 })).toBeCloseTo(0.8, 9);
    expect(effectiveSpreadDeg('rifle', b, { ...still, adsProgress: 100 / 230 })).toBeCloseTo(1.6 * (1 - 0.5 * (100 / 230)), 9);
    expect(effectiveSpreadDeg('sniper', b, { ...still, adsProgress: 1, stance: 'prone' })).toBeCloseTo(0.072, 9);
    // Same while crawling at 0.5 m/s (below the 1.0 m/s threshold).
    expect(effectiveSpreadDeg('sniper', b, { horizontalSpeed: 0.5, airborne: false, adsProgress: 1, stance: 'prone' })).toBeCloseTo(0.072, 9);
    expect(effectiveSpreadDeg('lmg', b, { horizontalSpeed: 1.5, airborne: false, adsProgress: 1, stance: 'crouch' })).toBeCloseTo(2.808, 9);
    // S does not apply during a transition.
    expect(effectiveSpreadDeg('rifle', b, { ...still, stance: 'prone', stanceSettled: false })).toBeCloseTo(1.6, 9);
    // Every table row of combat.md "Resulting cones".
    const rows: [WeaponId, number, number, number, number, number, number][] = [
      ['pistol', 1.5, 3.0, 0.9, 1.8, 0.72, 0.54],
      ['smg', 3.0, 4.2, 1.95, 2.73, 1.56, 1.17],
      ['shotgun', 7.0, 8.4, 5.95, 7.14, 4.76, 3.57],
      ['rifle', 1.6, 4.0, 0.8, 2.0, 0.64, 0.48],
      ['lmg', 2.6, 7.8, 1.17, 3.51, 0.936, 0.702],
      ['dmr', 3.0, 7.5, 0.3, 0.75, 0.24, 0.18],
      ['sniper', 6.0, 18.0, 0.12, 0.36, 0.096, 0.072],
    ];
    const moving = { horizontalSpeed: 2, airborne: false };
    for (const [w, hip, hipMove, ads, adsMove, adsCrouch, adsProne] of rows) {
      expect(effectiveSpreadDeg(w, b, still)).toBeCloseTo(hip, 9);
      expect(effectiveSpreadDeg(w, b, moving)).toBeCloseTo(hipMove, 9);
      expect(effectiveSpreadDeg(w, b, { ...still, adsProgress: 1 })).toBeCloseTo(ads, 9);
      expect(effectiveSpreadDeg(w, b, { ...moving, adsProgress: 1 })).toBeCloseTo(adsMove, 9);
      expect(effectiveSpreadDeg(w, b, { ...still, adsProgress: 1, stance: 'crouch' })).toBeCloseTo(adsCrouch, 9);
      expect(effectiveSpreadDeg(w, b, { ...still, adsProgress: 1, stance: 'prone' })).toBeCloseTo(adsProne, 9);
    }
  });

  it('adsProgressOf: adsMs / adsTimeMs, 0 for the grenade and fists', () => {
    expect(adsProgressOf({ adsMs: 115 }, 'rifle', b)).toBeCloseTo(0.5, 9);
    expect(adsProgressOf({ adsMs: 999 }, 'rifle', b)).toBe(1);
    expect(adsProgressOf({ adsMs: 100 }, 'grenade', b)).toBe(0);
    expect(adsProgressOf({ adsMs: 100 }, 'fists', b)).toBe(0);
  });

  it('sniper constraint: body never kills a full-HP player; a bare head kills; any helmet caps the head loss (combat.md)', () => {
    const sn = b.weapons.sniper;
    const H = sn.damage * sn.headshotMultiplier;
    expect(sn.damage).toBeLessThan(100);
    expect(H).toBeGreaterThanOrEqual(100);
    const cap = b.combat.helmetHeadshotCap;
    expect(cap.weapons).toContain('sniper');
    expect(cap.maxHpLoss).toBeLessThan(100);
    // Without the cap every helmet below tier 4 would still let the head shot kill.
    const loss = (id: 'helmet_1' | 'helmet_2' | 'helmet_3') =>
      applyArmorPiece({ tier: b.items[id].tier, durability: b.items[id].durability }, H, b.items[id].absorbFraction).hpLoss;
    expect(loss('helmet_1')).toBeGreaterThanOrEqual(100);
    expect(Math.min(loss('helmet_1'), cap.maxHpLoss)).toBe(cap.maxHpLoss);
  });

  it('shotgun point-blank all pellets = 117 (AT4)', () => {
    const sg = b.weapons.shotgun;
    expect(pelletDamage(sg, 2, false) * sg.pellets).toBeCloseTo(117, 9);
  });

  it('effective spread multiplies when moving and airborne', () => {
    const base = b.weapons.rifle.spreadDeg;
    expect(effectiveSpreadDeg('rifle', b, { horizontalSpeed: 0, airborne: false })).toBe(base);
    expect(effectiveSpreadDeg('rifle', b, { horizontalSpeed: 5, airborne: false })).toBe(base * rifle.moveSpreadMultiplier);
    expect(effectiveSpreadDeg('rifle', b, { horizontalSpeed: 5, airborne: true })).toBe(
      base * rifle.moveSpreadMultiplier * b.combat.airSpreadMultiplier,
    );
    expect(effectiveSpreadDeg('fists', b, { horizontalSpeed: 5, airborne: true })).toBe(0);
  });

  it('cone samples stay within the half-angle', () => {
    const rng = createRng(3);
    const dir = aimDirection(0.3, 0.2);
    for (let i = 0; i < 2000; i++) {
      const d = sampleCone(dir, 7 * DEG2RAD, rng);
      const dot = d.x * dir.x + d.y * dir.y + d.z * dir.z;
      expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
      expect(dot).toBeGreaterThanOrEqual(Math.cos(7 * DEG2RAD) - 1e-9);
    }
  });

  it('ray vs player cylinder', () => {
    const feet = { x: 0, y: 0, z: -10 };
    const hit = rayCylinder({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, feet, 0.45, 1.3, 100);
    expect(hit?.t).toBeCloseTo(9.55, 9);
    expect(hit?.y).toBeCloseTo(1, 9);
    expect(rayCylinder({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, feet, 0.45, 1.3, 100)).toBeNull();
    expect(rayCylinder({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, feet, 0.45, 1.3, 9)).toBeNull();
  });
});
