/**
 * M2a procedural art: new guns + sights, armor wearables, grenade, loot ids, stance pivot. Owner: graphics-designer.
 * Budgets: docs/art/ASSET_LIST.md.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  armorFromItemId, CHIBI_DIMENSIONS, CHIBI_STANCES, countTris, createChibi, createGrenadeModel, createHelmetModel,
  createLootModel, createVestModel, createWeaponModel, crouchLegAngle, getWearableGeometry, getWeaponSight,
  hairHiddenByHelmet, HAIR_STYLES, WEAPON_SIGHT_TYPES, attachWearable, CHIBI_LEG_LENGTH,
} from './index';

const tris = (o: THREE.Object3D) => ({ colour: countTris(o, false), hull: countTris(o) - countTris(o, false) });

describe('M2a weapons', () => {
  const brief: Record<string, string> = {
    pistol: 'iron', smg: 'iron', shotgun: 'iron', rifle: 'red_dot', lmg: 'red_dot', dmr: 'scope_4x', sniper: 'scope_8x',
  };
  for (const [id, sight] of Object.entries(brief)) {
    it(`${id}: builds with muzzle + sight anchor, sight type ${sight}, within budget`, () => {
      const w = createWeaponModel(id)!;
      expect(w).toBeTruthy();
      expect(w.getObjectByName('muzzle')).toBeTruthy();
      const s = w.getObjectByName('sight')!;
      expect(s).toBeTruthy();
      expect(s.userData.sightType).toBe(sight);
      expect(WEAPON_SIGHT_TYPES[id]).toBe(sight);
      const info = getWeaponSight(id)!;
      // eye sits behind the rear aperture on the same axis, above the receiver
      expect(info.eye[2]).toBeGreaterThan(info.rear[2]);
      expect(info.eye[1]).toBeCloseTo(info.rear[1], 6);
      expect(info.eye[0]).toBe(0);
      expect(info.eye[1]).toBeGreaterThan(0.1);
      const t = tris(w);
      expect(t.colour).toBeLessThanOrEqual(620);
      expect(t.hull).toBeLessThanOrEqual(460);
    });
  }
  it('fists and unknown ids have no model', () => {
    expect(createWeaponModel('fists')).toBeNull();
    expect(createWeaponModel('banana')).toBeNull();
    expect(getWeaponSight('fists')).toBeNull();
  });
  it('the muzzle is in front of the sight (barrel along -Z)', () => {
    for (const id of ['dmr', 'sniper', 'lmg']) {
      const w = createWeaponModel(id)!;
      expect(w.getObjectByName('muzzle')!.position.z).toBeLessThan(-0.6);
    }
  });
});

describe('M2a loot', () => {
  const ids = ['dmr', 'sniper', 'lmg', 'ammo_sniper', 'grenade', 'vest', 'vest_1', 'vest_2', 'vest_3', 'helmet_1', 'helmet_2', 'helmet_3'];
  for (const id of ids) {
    it(`${id}: real item mesh (not the crate fallback)`, () => {
      const l = createLootModel(id, 'rare');
      const item = l.getObjectByName('spin')!.children[0] as THREE.Mesh;
      expect(item.name).toBe('item');
      expect((item.geometry.name ?? '')).not.toMatch(/crate/);
      expect(tris(l.getObjectByName('spin')!).colour).toBeLessThanOrEqual(620);
    });
  }
  it('legacy vest draws the tier-1 vest; unknown ids fall back to a mini crate', () => {
    const a = createLootModel('vest').getObjectByName('item') as THREE.Mesh;
    const b = createLootModel('vest_1').getObjectByName('item') as THREE.Mesh;
    expect(a.geometry).toBe(b.geometry);
    expect(createLootModel('mystery_box').getObjectByName('item')).toBeTruthy();
  });
  it('armor ids parse with a safe fallback', () => {
    expect(armorFromItemId('vest')).toEqual({ kind: 'vest', tier: 1 });
    expect(armorFromItemId('helmet_3')).toEqual({ kind: 'helmet', tier: 3 });
    expect(armorFromItemId('vest_9')).toEqual({ kind: 'vest', tier: 3 });
    expect(armorFromItemId('medkit')).toBeNull();
  });
});

describe('M2a wearables', () => {
  it('attach with identity transforms to the head (neck) and body (hip) pivots', () => {
    const c = createChibi({ skin: 0, outfit: 0, hair: 0, helmet: true });
    const h = createHelmetModel(2);
    const v = createVestModel(3);
    attachWearable(c.parts, h);
    attachWearable(c.parts, v);
    expect(h.parent).toBe(c.parts.head);
    expect(v.parent).toBe(c.parts.body);
    for (const o of [h, v]) {
      expect(o.position.length()).toBe(0);
      expect(o.rotation.x + o.rotation.y + o.rotation.z).toBe(0);
      expect(o.scale.x).toBe(1);
    }
  });
  it('budgets: helmet and vest colour <= 360 tris, hull <= 300', () => {
    for (let t = 1; t <= 3; t++) {
      for (const m of [createHelmetModel(t), createVestModel(t)]) {
        const n = tris(m);
        expect(n.colour).toBeLessThanOrEqual(360);
        expect(n.hull).toBeLessThanOrEqual(300);
      }
    }
  });
  it('helmets sit on the head and vests wrap the torso', () => {
    const headY = CHIBI_DIMENSIONS.headCenterY - CHIBI_DIMENSIONS.neckY;
    for (let t = 1; t <= 3; t++) {
      const hb = getWearableGeometry('helmet', t).geometry.boundingBox!;
      expect(hb.max.y).toBeGreaterThan(headY + CHIBI_DIMENSIONS.headRadius); // covers the crown
      expect(hb.min.x).toBeLessThan(-CHIBI_DIMENSIONS.headRadius);
      expect(hb.max.x).toBeGreaterThan(CHIBI_DIMENSIONS.headRadius);
      const vb = getWearableGeometry('vest', t).geometry.boundingBox!;
      expect(vb.min.x).toBeLessThan(-0.17); // torso capsule r 0.16
      expect(vb.max.x).toBeGreaterThan(0.17);
      expect(vb.min.y).toBeGreaterThan(0.05); // shorts / skirt stay visible
      expect(vb.max.y).toBeLessThan(0.45);
    }
  });
  it('helmet-safe hair: nothing pokes out of the crown, sun hat is hidden', () => {
    const headY = CHIBI_DIMENSIONS.headCenterY - CHIBI_DIMENSIONS.neckY;
    const p = new THREE.Vector3();
    for (let hair = 0; hair < HAIR_STYLES.length; hair++) {
      const c = createChibi({ skin: 0, outfit: 0, hair, helmet: true });
      const pos = c.meshes.head.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        p.y -= headY;
        // above 0.1 m over the head centre the smallest helmet shell (r 0.29) covers everything
        if (p.y > 0.1) expect(p.length()).toBeLessThan(0.29);
      }
    }
    expect(hairHiddenByHelmet(4)).toBe(true); // style 4 = sunhat
    expect(hairHiddenByHelmet(0)).toBe(false);
  });
  it('setVariant toggles helmet hair through the geometry cache', () => {
    const c = createChibi({ skin: 1, outfit: 1, hair: 0 });
    const g0 = c.meshes.head.geometry;
    c.setVariant({ helmet: true });
    expect(c.meshes.head.geometry).not.toBe(g0);
    c.setVariant({ helmet: false });
    expect(c.meshes.head.geometry).toBe(g0);
  });
});

describe('M2a grenade', () => {
  it('has a fuse anchor, a pin variant, and stays small', () => {
    const g = createGrenadeModel();
    const n = createGrenadeModel({ pin: false });
    expect(g.getObjectByName('fuse')).toBeTruthy();
    expect(tris(g).colour).toBeGreaterThan(tris(n).colour);
    expect(tris(g).colour).toBeLessThanOrEqual(240);
  });
});

describe('M2a stance pivot', () => {
  it('body and legs hang off parts.stance; resetPose clears it', () => {
    const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
    const s = c.parts.stance;
    expect(s.parent).toBe(c.root);
    for (const k of ['body', 'legL', 'legR'] as const) expect(c.parts[k].parent).toBe(s);
    s.position.set(0, -0.2, 0.5);
    s.rotation.x = -1;
    c.resetPose();
    expect(s.position.length()).toBe(0);
    expect(s.rotation.x).toBe(0);
  });
  it('crouch legs keep the soles on the ground', () => {
    const k = CHIBI_STANCES.crouch;
    expect(crouchLegAngle(k.drop)).toBeCloseTo(k.legSwing, 1);
    const hip = CHIBI_DIMENSIONS.hipY - k.drop;
    expect(hip - CHIBI_LEG_LENGTH * Math.cos(crouchLegAngle(k.drop))).toBeCloseTo(0, 6);
  });
  it('prone lies along -Z, body inside the prone box, the belly on (not in) the sand', () => {
    const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
    const k = CHIBI_STANCES.prone;
    c.parts.stance.rotation.x = k.pitch;
    c.parts.stance.position.set(0, k.lift, k.back);
    c.parts.body.rotation.x = k.chestUp;
    c.root.updateMatrixWorld(true);
    const head = c.parts.head.getWorldPosition(new THREE.Vector3());
    const hips = c.parts.body.getWorldPosition(new THREE.Vector3());
    expect(head.z).toBeLessThan(hips.z); // head forward (-Z)
    expect(Math.abs(hips.z)).toBeLessThan(0.2); // hips near the root (the head sits in the front of the box)
    const box = new THREE.Box3().setFromObject(c.meshes.torso, true);
    expect(box.min.y).toBeGreaterThan(-0.03);
  });
});

/**
 * BUG-008 (docs/design/systems/stance.md "Visual fit"): the posed chibi fits its sim stance hitbox. Measured with
 * precise mesh bounds (visible geometry) for every hair style. "Eye" = head centre, as in stance.md (the head is
 * centred on the stance eyeHeight; CHIBI_DIMENSIONS.eyeY is the head centre line when standing).
 * Aim pitch tilts the prone head by pitch * HEAD_K (characterPose.ts, graphics-engineer); checked at k 0.3.
 */
describe('BUG-008 stance visual fit', () => {
  const HEAD_K = 0.3;
  /** Extra front reach allowed for the sunhat brim only (m). */
  const SUNHAT_BRIM_FRONT = 0.14;
  const PITCHES = [0, -Math.PI / 6, Math.PI / 4];
  const pbox = (o: THREE.Object3D) => new THREE.Box3().setFromObject(o, true);
  const headCentre = (c: ReturnType<typeof createChibi>) =>
    new THREE.Vector3(0, CHIBI_DIMENSIONS.headCenterY - CHIBI_DIMENSIONS.neckY, 0).applyMatrix4(c.parts.head.matrixWorld);
  const hairs = HAIR_STYLES.map((_, i) => i);

  it('crouch: head top <= 1.05 m (every hair), head centre 0.72 +- 0.05, head within 0.57 m of the feet', () => {
    const k = CHIBI_STANCES.crouch;
    for (const hair of hairs) {
      const c = createChibi({ skin: 0, outfit: 0, hair });
      c.parts.stance.position.y = -k.drop;
      c.parts.legL.rotation.set(k.legSwing, 0, -k.legSplay);
      c.parts.legR.rotation.set(-k.legSwing, 0, k.legSplay);
      c.parts.body.rotation.x = k.bodyLean;
      c.parts.head.rotation.x = k.headComp;
      c.root.updateMatrixWorld(true);
      const hb = pbox(c.meshes.head);
      expect(hb.max.y, `hair ${hair} top`).toBeLessThanOrEqual(1.05);
      expect(Math.max(-hb.min.x, hb.max.x, -hb.min.z, hb.max.z), `hair ${hair} reach`).toBeLessThanOrEqual(0.57);
      if (hair === 0) expect(Math.abs(headCentre(c).y - 0.72)).toBeLessThanOrEqual(0.05);
    }
  });

  it('prone at aim pitch 0, -30 and +45 deg: head top <= 0.70, centre 0.35 +- 0.05 and z <= -0.45, body in the box', () => {
    const k = CHIBI_STANCES.prone;
    for (const hair of hairs) {
      for (const pitch of PITCHES) {
        const c = createChibi({ skin: 0, outfit: 0, hair });
        c.parts.stance.rotation.x = k.pitch;
        c.parts.stance.position.set(0, k.lift, k.back);
        c.parts.body.rotation.x = k.chestUp;
        c.parts.head.rotation.x = k.headUp + pitch * HEAD_K;
        c.parts.legL.rotation.set(k.legLift, 0, -k.legSplay);
        c.parts.legR.rotation.set(k.legLift, 0, k.legSplay);
        c.root.updateMatrixWorld(true);
        const tag = `hair ${hair} pitch ${pitch.toFixed(2)}`;
        const hb = pbox(c.meshes.head);
        expect(hb.max.y, `${tag} top`).toBeLessThanOrEqual(0.70);
        if (hair === 0) {
          // the sunhat brim (hair 4) is 0.43: inside the box + tolerance, checked below with the other parts
          expect(Math.max(-hb.min.x, hb.max.x), `${tag} head x`).toBeLessThanOrEqual(0.4);
          expect(Math.abs(headCentre(c).y - 0.35), `${tag} eye`).toBeLessThanOrEqual(0.05);
          expect(hb.getCenter(new THREE.Vector3()).z, `${tag} head z`).toBeLessThanOrEqual(-0.445);
          expect(pbox(c.meshes.torso).getCenter(new THREE.Vector3()).z, `${tag} torso z`).toBeGreaterThan(-0.25);
        }
        for (const part of ['torso', 'head', 'legL', 'legR'] as const) {
          const b = pbox(c.meshes[part]);
          // Known exception: the sunhat brim reaches past the front face (STYLE.md §16, BUG-008 note).
          const brim = HAIR_STYLES[hair] === 'sunhat' && part === 'head' ? SUNHAT_BRIM_FRONT : 0;
          expect(b.min.x, `${tag} ${part}`).toBeGreaterThanOrEqual(-0.52);
          expect(b.max.x, `${tag} ${part}`).toBeLessThanOrEqual(0.52);
          expect(b.min.z, `${tag} ${part}`).toBeGreaterThanOrEqual(-0.87 - brim);
          expect(b.max.z, `${tag} ${part}`).toBeLessThanOrEqual(0.87);
          expect(b.min.y, `${tag} ${part}`).toBeGreaterThanOrEqual(-0.12);
          expect(b.max.y, `${tag} ${part}`).toBeLessThanOrEqual(0.72);
        }
      }
    }
  });
});
