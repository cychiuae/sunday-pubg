import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { aimDirection, createRng, DEG2RAD } from '../math';
import { applyDamage, effectiveSpreadDeg, falloffFactor, isHeadshot, pelletDamage, rayCylinder, sampleCone } from './combat';

const b = BALANCE;
const rifle = b.weapons.rifle;

describe('combat math', () => {
  it('rifle falloff: 22 at 10 m, 15.4 at 110 m (combat.md AT1)', () => {
    expect(pelletDamage(rifle, 10, false)).toBeCloseTo(22, 9);
    expect(pelletDamage(rifle, 110, false)).toBeCloseTo(15.4, 9);
    expect(pelletDamage(rifle, 140, false)).toBeCloseTo(15.4, 9);
    expect(falloffFactor(rifle, 75)).toBeCloseTo(0.85, 9);
  });

  it('headshot zone is the top headZoneFraction of the cylinder (AT2)', () => {
    expect(isHeadshot(1.0, 0, b)).toBe(true);
    expect(isHeadshot(0.7, 0, b)).toBe(false);
    expect(pelletDamage(rifle, 10, isHeadshot(1.0, 0, b))).toBeCloseTo(38.5, 9);
    expect(pelletDamage(rifle, 10, isHeadshot(0.7, 0, b))).toBeCloseTo(22, 9);
  });

  it('armor absorbs absorbFraction until empty (AT3)', () => {
    const a = applyDamage(100, 50, 30, b.armor.absorbFraction);
    expect(a.hp).toBeCloseTo(85);
    expect(a.armor).toBeCloseTo(35);
    const c = applyDamage(a.hp, a.armor, 100, b.armor.absorbFraction);
    expect(c.armorTaken).toBeCloseTo(35);
    expect(c.armor).toBeCloseTo(0);
    expect(c.hp).toBeCloseTo(20);
    expect(applyDamage(100, 50, 10, b.armor.absorbFraction, true)).toMatchObject({ hp: 90, armor: 50 });
  });

  it('shotgun point-blank all pellets = 99 (AT4)', () => {
    const sg = b.weapons.shotgun;
    expect(pelletDamage(sg, 2, false) * sg.pellets).toBeCloseTo(99, 9);
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
