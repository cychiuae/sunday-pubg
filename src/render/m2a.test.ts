import { describe, expect, it } from 'vitest';
import type { PlayerAnim, Stance } from '../shared/types';
import {
  computePose, DEATH_TOPPLE_S, makePose, PRONE_DEATH_ROLL, PRONE_PITCH_MAX, PRONE_PITCH_MIN, stanceBlend,
  type PoseInput, type StanceBlend,
} from './characterPose';
import { skinCacheSize, skinChibi, skinKey } from './chibiSkin';
import { fuseBlinkHz, resampleArc } from './GrenadeLayer';
import { GLINT_COS_MIN, glintStrength, scopeGlintVisible } from './PlayerViews';
import { createCharacter, CHIBI_STANCES } from './procedural';
import { lodZoom } from './Renderer';
import { explosionShake } from './vfx/Explosions';

const anim = (over: Partial<PlayerAnim> = {}): PlayerAnim => ({
  moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false,
  healing: false, ads: false, cooking: false, ...over,
});
const input = (over: Partial<PoseInput> = {}): PoseInput => ({
  time: 1, anim: anim(), weapon: 'rifle', pitch: 0, speed: 0, sprintSpeed: 7.2, crawlSpeed: 1.2, velY: 0, walkPhase: 0,
  recoil: 0, hit: 0, deathTime: -1, seed: 0, crouch: 0, prone: 0, ads: 0, ...over,
});
const blend = (to: Stance, from: Stance, k: number): StanceBlend => stanceBlend(to, from, k, { crouch: -1, prone: -1 });

describe('stance blend (STYLE.md §16 staging)', () => {
  it('settled stances map to fixed weights', () => {
    expect(blend('stand', 'stand', 1)).toEqual({ crouch: 0, prone: 0 });
    expect(blend('crouch', 'crouch', 1)).toEqual({ crouch: 1, prone: 0 });
    expect(blend('prone', 'prone', 1)).toEqual({ crouch: 1, prone: 1 });
    // progress is ignored once settled (stance === stanceFrom)
    expect(blend('prone', 'prone', 0.2)).toEqual({ crouch: 1, prone: 1 });
  });

  it('stand -> prone crouches first (k < 0.4), then lies down', () => {
    const a = blend('prone', 'stand', 0.2);
    expect(a.prone).toBe(0);
    expect(a.crouch).toBeGreaterThan(0.3);
    expect(a.crouch).toBeLessThan(1);
    const b = blend('prone', 'stand', 0.4);
    expect(b).toEqual({ crouch: 1, prone: 0 });
    const c = blend('prone', 'stand', 0.7);
    expect(c.crouch).toBe(1);
    expect(c.prone).toBeCloseTo(0.5, 6);
  });

  it('prone -> stand pushes up to crouch, then stands', () => {
    const a = blend('stand', 'prone', 0.3);
    expect(a.crouch).toBe(1);
    expect(a.prone).toBeCloseTo(0.5, 6);
    const b = blend('stand', 'prone', 0.8);
    expect(b.prone).toBe(0);
    expect(b.crouch).toBeGreaterThan(0);
    expect(b.crouch).toBeLessThan(1);
  });

  it('is continuous and monotonic over every transition', () => {
    const pairs: [Stance, Stance][] = [['crouch', 'stand'], ['stand', 'crouch'], ['prone', 'stand'], ['stand', 'prone'], ['prone', 'crouch'], ['crouch', 'prone']];
    for (const [to, from] of pairs) {
      let prev = blend(to, from, 0);
      const start = { crouch: from === 'stand' ? 0 : 1, prone: from === 'prone' ? 1 : 0 };
      expect(prev.crouch).toBeCloseTo(start.crouch, 6);
      expect(prev.prone).toBeCloseTo(start.prone, 6);
      for (let i = 1; i <= 100; i++) {
        const cur = blend(to, from, i / 100);
        expect(Math.abs(cur.crouch - prev.crouch)).toBeLessThan(0.08);
        expect(Math.abs(cur.prone - prev.prone)).toBeLessThan(0.08);
        prev = cur;
      }
      expect(prev).toEqual(blend(to, to, 1));
    }
  });

  it('clamps bad progress', () => {
    expect(blend('crouch', 'stand', 5)).toEqual({ crouch: 1, prone: 0 });
    expect(blend('crouch', 'stand', Number.NaN)).toEqual({ crouch: 1, prone: 0 });
    expect(blend('crouch', 'stand', -1).crouch).toBe(0);
  });
});

describe('stance poses', () => {
  it('crouch drops the stance pivot and bends the legs (CHIBI_STANCES.crouch)', () => {
    const p = computePose(input({ crouch: 1 }), makePose());
    expect(p.stanceY).toBeCloseTo(-CHIBI_STANCES.crouch.drop, 6);
    expect(p.legLX).toBeCloseTo(CHIBI_STANCES.crouch.legSwing, 6);
    expect(p.legRX).toBeCloseTo(-CHIBI_STANCES.crouch.legSwing, 6);
    expect(p.bodyX).toBeCloseTo(CHIBI_STANCES.crouch.bodyLean, 6);
    // Aim arm compensates the lean so the gun stays on target.
    expect(p.armRX).toBeCloseTo(Math.PI / 2 - CHIBI_STANCES.crouch.bodyLean, 6);
  });

  it('prone lies along the yaw on the sim hitbox centre', () => {
    const p = computePose(input({ crouch: 1, prone: 1 }), makePose());
    expect(p.stanceX).toBeCloseTo(-Math.PI / 2, 6);
    expect(p.stanceY).toBeCloseTo(CHIBI_STANCES.prone.lift, 6);
    expect(p.stanceZ).toBeCloseTo(CHIBI_STANCES.prone.back, 6);
    expect(p.rootTiltX).toBe(0);
  });

  it('clamps prone aim pitch to about -0.25..+0.45', () => {
    const up = computePose(input({ crouch: 1, prone: 1, pitch: 1.0 }), makePose());
    const up2 = computePose(input({ crouch: 1, prone: 1, pitch: PRONE_PITCH_MAX }), makePose());
    expect(up.armRX).toBeCloseTo(up2.armRX, 6);
    const down = computePose(input({ crouch: 1, prone: 1, pitch: -1.0 }), makePose());
    const down2 = computePose(input({ crouch: 1, prone: 1, pitch: PRONE_PITCH_MIN }), makePose());
    expect(down.armRX).toBeCloseTo(down2.armRX, 6);
    expect(PRONE_PITCH_MIN).toBeCloseTo(-0.25, 6);
    expect(PRONE_PITCH_MAX).toBeCloseTo(0.45, 6);
  });

  it('crawl amplitude scales with speed', () => {
    const at = (speed: number) => {
      const p = computePose(input({ crouch: 1, prone: 1, speed, anim: anim({ moving: true }), walkPhase: Math.PI / 2 }), makePose());
      return Math.abs(p.legLZ + CHIBI_STANCES.prone.legSplay);
    };
    expect(at(0.3)).toBeLessThan(at(1.2));
    expect(at(1.2)).toBeCloseTo(CHIBI_STANCES.prone.crawlSwing, 6);
    const still = computePose(input({ crouch: 1, prone: 1 }), makePose());
    expect(still.legLZ).toBeCloseTo(-CHIBI_STANCES.prone.legSplay, 6);
  });

  it('death while prone rolls onto the side instead of toppling back', () => {
    const p = computePose(input({ crouch: 1, prone: 1, deathTime: DEATH_TOPPLE_S, deathSide: -1 }), makePose());
    expect(p.rootTiltX).toBe(0);
    expect(p.rootTiltZ).toBeCloseTo(-PRONE_DEATH_ROLL, 6);
    expect(p.stanceX).toBeCloseTo(-Math.PI / 2, 6);
    expect(p.weaponVisible).toBe(false);
    const stand = computePose(input({ deathTime: DEATH_TOPPLE_S }), makePose());
    expect(stand.rootTiltX).toBeGreaterThan(1.3);
    expect(stand.rootTiltZ).toBe(0);
  });

  it('mid-blend poses stay between the two key poses', () => {
    const a = computePose(input({ crouch: 1, prone: 0 }), makePose());
    const b = computePose(input({ crouch: 1, prone: 1 }), makePose());
    const m = computePose(input({ crouch: 1, prone: 0.5 }), makePose());
    expect(m.stanceX).toBeCloseTo((a.stanceX + b.stanceX) / 2, 6);
    expect(m.stanceZ).toBeCloseTo((a.stanceZ + b.stanceZ) / 2, 6);
  });

  it('grenade: wind-up while cooking, held low otherwise, long guns two-handed', () => {
    const cook = computePose(input({ weapon: 'grenade', anim: anim({ cooking: true }) }), makePose());
    expect(cook.armRX).toBeGreaterThan(Math.PI);
    expect(cook.weaponVisible).toBe(true);
    const hold = computePose(input({ weapon: 'grenade' }), makePose());
    expect(hold.armRX).toBeLessThan(Math.PI / 2);
    for (const w of ['dmr', 'sniper', 'lmg'] as const) {
      expect(computePose(input({ weapon: w }), makePose()).armLZ).toBeCloseTo(0.62, 6);
    }
  });

  it('ADS pulls the gun arm in and stops the idle head turn', () => {
    const hip = computePose(input(), makePose());
    const ads = computePose(input({ ads: 1 }), makePose());
    expect(ads.armRZ).toBeLessThan(hip.armRZ);
    expect(ads.headY).toBe(0);
    expect(ads.armRX).toBeCloseTo(hip.armRX, 6);
  });
});

describe('scope glint', () => {
  it('shows only for living remote players aiming a scoped weapon', () => {
    expect(scopeGlintVisible(false, true, { ads: true }, 'scope_8x')).toBe(true);
    expect(scopeGlintVisible(false, true, { ads: true }, 'scope_4x')).toBe(true);
    expect(scopeGlintVisible(false, true, { ads: true }, 'red_dot')).toBe(false);
    expect(scopeGlintVisible(false, true, { ads: true }, 'iron')).toBe(false);
    expect(scopeGlintVisible(false, true, { ads: false }, 'scope_8x')).toBe(false);
    expect(scopeGlintVisible(true, true, { ads: true }, 'scope_8x')).toBe(false);
    expect(scopeGlintVisible(false, false, { ads: true }, 'scope_8x')).toBe(false);
  });

  it('is full when the scope points at the camera and zero beyond ~30 degrees', () => {
    expect(glintStrength(0, 0, -1, 0, 0, -1)).toBe(1);
    expect(glintStrength(0, 0, -1, 0, 0, 1)).toBe(0);
    const a = (deg: number) => (deg * Math.PI) / 180;
    expect(glintStrength(0, 0, -1, Math.sin(a(45)), 0, -Math.cos(a(45)))).toBe(0);
    const mid = glintStrength(0, 0, -1, Math.sin(a(18)), 0, -Math.cos(a(18)));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(Math.cos(a(30))).toBeCloseTo(GLINT_COS_MIN, 6);
  });
});

describe('grenade arc and fuse', () => {
  it('resamples the tick polyline into evenly spaced dots', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }];
    const out = new Float32Array(30);
    const n = resampleArc(pts, 0.5, 0.25, out, 10);
    expect(n).toBe(6); // 0.25, 0.75, ..., 2.75
    for (let i = 0; i < n; i++) {
      expect(out[i * 3]).toBeCloseTo(0.25 + i * 0.5, 5);
      expect(out[i * 3 + 1]).toBe(0);
    }
  });

  it('respects the dot cap and the buffer size, and handles degenerate input', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 100 }];
    expect(resampleArc(pts, 0.35, 0, new Float32Array(3 * 500), 200)).toBe(200);
    expect(resampleArc(pts, 0.35, 0, new Float32Array(3 * 7), 200)).toBe(7);
    expect(resampleArc([pts[0]], 0.35, 0, new Float32Array(30), 10)).toBe(0);
    expect(resampleArc(pts, 0, 0, new Float32Array(30), 10)).toBe(0);
  });

  it('follows bends (dots lie on the polyline)', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 2, y: 0, z: 0 }];
    const out = new Float32Array(300);
    const n = resampleArc(pts, 0.2, 0, out, 100);
    expect(n).toBe(Math.floor((2 * Math.SQRT2) / 0.2) + 1);
    for (let i = 0; i < n; i++) {
      const x = out[i * 3], y = out[i * 3 + 1];
      expect(y).toBeCloseTo(x <= 1 ? x : 2 - x, 4);
    }
  });

  it('blinks faster as the fuse runs out', () => {
    expect(fuseBlinkHz(3500)).toBe(2);
    expect(fuseBlinkHz(2500)).toBe(2);
    expect(fuseBlinkHz(1000)).toBeGreaterThan(fuseBlinkHz(2000));
    expect(fuseBlinkHz(0)).toBe(10);
    expect(fuseBlinkHz(-50)).toBe(10);
  });
});

describe('explosion shake and zoom LOD', () => {
  it('scales camera shake by local distance: none beyond 2 x radius or without a local player', () => {
    expect(explosionShake(null, 6)).toBe(0);
    expect(explosionShake(12, 6)).toBe(0);
    expect(explosionShake(20, 6)).toBe(0);
    expect(explosionShake(0, 6)).toBe(1);
    expect(explosionShake(3, 6)).toBeGreaterThan(explosionShake(9, 6));
    expect(explosionShake(9, 6)).toBeGreaterThan(0);
  });

  it('grows LOD distances with zoom, capped', () => {
    expect(lodZoom(70, 70)).toBe(1);
    expect(lodZoom(70, 80)).toBe(1);
    expect(lodZoom(70, 70 / 1.6)).toBeGreaterThan(1.5);
    expect(lodZoom(70, 70 / 8)).toBe(4);
    expect(lodZoom(70, 0)).toBe(1);
  });
});

describe('armor merged into the skinned chibi', () => {
  it('keys include the helmet hair flag and both tiers', () => {
    expect(skinKey(1, 2, 3)).toBe('1|2|3|h0|v0|m0');
    expect(skinKey(1, 2, 3, { vest: 2, helmet: 3 })).toBe('1|2|3|h1|v2|m3');
    expect(skinKey(1, 2, 3, { vest: 1, helmet: 0 })).not.toBe(skinKey(1, 2, 3, { vest: 0, helmet: 1 }));
  });

  it('adds the wearable vertices rigidly weighted to the hip and neck bones, still 2 meshes', () => {
    const plain = createCharacter({ skin: 0, outfit: 0, hair: 4 });
    const a = skinChibi(plain, skinKey(0, 0, 4));
    const armored = createCharacter({ skin: 0, outfit: 0, hair: 4 });
    armored.chibi.setVariant({ helmet: true });
    const wear = { vest: 3, helmet: 2 };
    const b = skinChibi(armored, skinKey(0, 0, 4, wear), wear);
    const n0 = a.colour.geometry.getAttribute('position').count;
    const n1 = b.colour.geometry.getAttribute('position').count;
    expect(n1).toBeGreaterThan(n0);
    expect(b.outline.geometry.getAttribute('position').count).toBeGreaterThan(a.outline.geometry.getAttribute('position').count);
    const idx = b.colour.geometry.getAttribute('skinIndex');
    const bones = new Set<number>();
    for (let i = n0; i < n1; i++) bones.add(idx.getX(i));
    // Only the hip (0) and neck (1) bones carry armor (the sun hat hair is removed, so counts differ slightly).
    for (const k of bones) expect([0, 1]).toContain(k);
    expect(bones.size).toBe(2);
    // One colour + one outline skinned mesh under the root, wearable or not.
    expect(armored.root.children.filter((c) => (c as { isSkinnedMesh?: boolean }).isSkinnedMesh).length).toBe(2);
    a.dispose();
    b.dispose();
  });

  it('releases unused armor variants (ref-counted cache, small LRU)', () => {
    const m = createCharacter({ skin: 1, outfit: 1, hair: 1 });
    const s = skinChibi(m, skinKey(1, 1, 1));
    const before = skinCacheSize();
    for (let i = 0; i < 40; i++) {
      const wear = { vest: (i % 3) + 1, helmet: ((i >> 1) % 4) as 0 | 1 | 2 | 3 };
      m.chibi.setVariant({ helmet: wear.helmet > 0 });
      // distinct appearance per step so the cache would grow without eviction
      s.setAppearanceKey(`${skinKey(1, 1, 1, wear)}#${i}`, wear);
    }
    expect(skinCacheSize()).toBeLessThan(before + 15);
    s.dispose();
  });
});
