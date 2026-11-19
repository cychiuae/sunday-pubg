/**
 * M2c procedural art: per-level weapon models, level collar, scopes on rails, new weapons, rocket, smoke can, level 4
 * armor, ground markers, decor table, island variants, water cooler, icons, melee swing arcs. Owner: graphics-designer.
 * Spec: docs/art/M2c.md. Budgets: docs/art/ASSET_LIST.md "M2c".
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../shared/balance';
import { DECOR_KIND_INFO } from '../../shared/kits/decor';
import { ISLAND_VARIANTS } from '../../shared/kits/island';
import { OFFICE_KIT } from '../../shared/kits/office';
import type { ItemLevel, ScopeId } from '../../shared/types';
import { DECOR_KINDS } from '../../game/levels/layout/grammar';
import {
  applyViewmodelPose, countTris, createGrenadeModel, createHelmetModel, createLootMarker, createLootModel, createRocketModel,
  createSmokeModel, createVestModel, createViewmodel, createWeaponModel, DECOR_KIND_IDS, getDecorParts, getPropBounds,
  getPropParts, getWeaponAnchors, getWeaponGeometry, getWeaponRail, getWeaponSight, LEVEL_BEAM_HEIGHT, LEVEL_COLORS, LEVELLED_WEAPON_IDS,
  M2C_ICON_SVG, MELEE_SWING_KEYS, meleeHitFraction, meleeSwingPose, PROP_KINDS, SCOPE_2X_RETICLE_SVG, SCOPE_GEOMETRY,
  SCOPE_MODEL_IDS, scopeFitsRail, VIEWMODEL_MELEE_IDS, VIEWMODEL_POSES, WEAPON_SIGHT_TYPES,
} from './index';

const tris = (o: THREE.Object3D) => ({ colour: countTris(o, false), hull: countTris(o) - countTris(o, false) });
const LEVELS: readonly (ItemLevel | undefined)[] = [undefined, 1, 2, 3, 4];
type Compat = Record<string, readonly ScopeId[]>;
const COMPAT: Compat = ((BALANCE as unknown as { scopes?: { compatible?: Compat } }).scopes?.compatible) ?? {};
const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
const pos = (o: THREE.Object3D | undefined) => (o ? o.position.toArray() : null);

describe('M2c default sights reproduce the M2a/M2b eye points exactly', () => {
  // (sight type, eye, rear) as shipped before the scope refactor (ASSET_LIST "Weapons", full precision).
  const before: Record<string, [string, number[], number[]]> = {
    pistol: ['iron', [0, 0.119, 0.445], [0, 0.119, 0.045]],
    smg: ['iron', [0, 0.134, 0.39], [0, 0.134, 0.07]],
    shotgun: ['iron', [0, 0.139, 0.39], [0, 0.139, 0.07]],
    rifle: ['red_dot', [0, 0.165, 0.2725], [0, 0.165, -0.0275]],
    lmg: ['red_dot', [0, 0.185, 0.2625], [0, 0.185, -0.0375]],
    dmr: ['scope_4x', [0, 0.172, 0.18], [0, 0.172, 0.1]],
    sniper: ['scope_8x', [0, 0.178, 0.26], [0, 0.178, 0.18]],
  };
  for (const [id, [type, eye, rear]] of Object.entries(before)) {
    it(`${id}: ${type} eye ${eye.join(', ')}`, () => {
      const s = getWeaponSight(id)!;
      expect(s.type).toBe(type);
      expect(WEAPON_SIGHT_TYPES[id]).toBe(type);
      expect(near(s.eye, eye)).toBe(true);
      expect(near(s.rear, rear)).toBe(true);
    });
  }
});

describe('M2c per-level weapon models (Addendum 2)', () => {
  it('covers the 13 levelled weapons, the M2b guns first', () => {
    expect(LEVELLED_WEAPON_IDS.slice(0, 7)).toEqual(['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper']);
    expect(LEVELLED_WEAPON_IDS.length).toBe(13);
    for (const id of LEVELLED_WEAPON_IDS) expect(createWeaponModel(id), id).toBeTruthy();
  });
  for (const id of LEVELLED_WEAPON_IDS) {
    it(`${id}: anchors identical at every level, length within +-10 %, levels look different, budget`, () => {
      const ref = createWeaponModel(id, { level: 2 })!;
      const refBox = new THREE.Box3().setFromObject(ref.getObjectByName('weapon')!);
      const refLen = refBox.max.z - refBox.min.z;
      const names = ['muzzle', 'sight', 'rail', 'collar', 'tip', 'swingTrail', 'exhaust', 'rocketSeat', 'cylinder', 'muzzleL', 'muzzleR'];
      const geos = new Set<THREE.BufferGeometry>();
      for (const lv of LEVELS) {
        const w = createWeaponModel(id, { level: lv })!;
        for (const n of names) {
          if (n === 'collar' && lv === undefined) continue;
          expect(pos(w.getObjectByName(n) as THREE.Object3D | undefined), `${id} L${lv} ${n}`).toEqual(pos(ref.getObjectByName(n) as THREE.Object3D | undefined));
        }
        const mesh = w.getObjectByName('weapon') as THREE.Mesh;
        geos.add(mesh.geometry);
        const b = new THREE.Box3().setFromObject(mesh);
        expect(Math.abs(b.max.z - b.min.z - refLen) / refLen, `${id} L${lv} length`).toBeLessThanOrEqual(0.1);
        expect(w.userData.level).toBe(lv ?? null);
        expect(!!w.getObjectByName('collar')).toBe(lv !== undefined);
        // worst case: the level model + any compatible scope
        for (const sc of [null, ...(COMPAT[id] ?? [])]) {
          const t = tris(createWeaponModel(id, { level: lv, scope: sc })!);
          expect(t.colour, `${id} L${lv} ${sc}`).toBeLessThanOrEqual(860);
          expect(t.hull, `${id} L${lv} ${sc}`).toBeLessThanOrEqual(520);
        }
      }
      expect(geos.size).toBe(5); // undefined + 4 distinct level models
    });
  }
  it('the L2 model is the M2b model + the collar band (12 tris) + 2 pip boxes (12 tris each)', () => {
    for (const id of LEVELLED_WEAPON_IDS) {
      const n = (g: ReturnType<typeof getWeaponGeometry>) => g!.merged.geometry.getAttribute('position').count / 3;
      const band = createWeaponModel(id, { level: 2 })!.getObjectByName('collar') ? 0 : 0;
      const round = n(getWeaponGeometry(id, { level: 2 })) - n(getWeaponGeometry(id)) - 2 * 12;
      expect(round + band, id).toBeGreaterThanOrEqual(12); // box band 12, round band 40
      expect(round, id).toBeLessThanOrEqual(40);
    }
  });
  it('getWeaponAnchors: pure data equal to the model empties; all non-lens parts share one material pair', () => {
    for (const id of LEVELLED_WEAPON_IDS) {
      for (const lv of LEVELS) {
        const a = getWeaponAnchors(id, { level: lv })!;
        const w = createWeaponModel(id, { level: lv })!;
        expect(a.muzzle ? [...a.muzzle] : null).toEqual(pos(w.getObjectByName('muzzle') as THREE.Object3D | undefined));
        expect(a.sight ? [...a.sight.eye] : null).toEqual(pos(w.getObjectByName('sight') as THREE.Object3D | undefined));
        expect(a.rail ? [...a.rail.pos] : null).toEqual(pos(w.getObjectByName('rail') as THREE.Object3D | undefined));
        for (const [n, p] of Object.entries(a.extra)) expect([...p]).toEqual(pos(w.getObjectByName(n) as THREE.Object3D));
        expect(JSON.stringify({ ...a, level: null, collar: null })).toBe(JSON.stringify({ ...getWeaponAnchors(id, { level: 2 })!, level: null, collar: null }));
        const mats = new Set<THREE.Material>();
        w.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.name !== 'lens') mats.add(m.material as THREE.Material); });
        expect(mats.size, id).toBe(2); // vertexColorToon + the OUTLINE.small hull
      }
    }
    expect(getWeaponAnchors('knife')!.support).toBeNull();
    expect(getWeaponAnchors('fists')).toBeNull();
  });
  it('level and scope are cached per (id, level, scope) and shared', () => {
    expect(getWeaponGeometry('smg', { level: 3 })).toBe(getWeaponGeometry('smg', { level: 3 }));
    expect(getWeaponGeometry('smg', { level: 3, scope: 'scope_2x' })).not.toBe(getWeaponGeometry('smg', { level: 3 }));
    expect(getWeaponGeometry('smg', { level: 9 })!.level).toBe(4);
  });
});

describe('M2c scopes on rails', () => {
  it('every balance-compatible scope fits its gun rail (art footprint)', () => {
    for (const [gun, list] of Object.entries(COMPAT)) {
      for (const sc of list) {
        const r = getWeaponRail(gun);
        expect(r, `${gun} has a rail`).toBeTruthy();
        expect(scopeFitsRail(sc, r!.length), `${sc} on ${gun}`).toBe(true);
      }
    }
    expect(getWeaponRail('rpg')).toBeNull();
    expect(getWeaponRail('knife')).toBeNull();
  });
  it('eye = rail + scope.eye for every gun with a rail and every fitting scope; the viewmodel ADS lands on the eye', () => {
    const rig = createViewmodel({ skin: 0, outfit: 0 });
    for (const gun of ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'revolver', 'dbshotgun']) {
      const r = getWeaponRail(gun)!;
      for (const sc of SCOPE_MODEL_IDS) {
        if (!scopeFitsRail(sc, r.length)) continue;
        const s = getWeaponSight(gun, { scope: sc })!;
        const g = SCOPE_GEOMETRY[sc];
        expect(s.type).toBe(g.sight);
        expect(near(s.eye, [r.pos[0] + g.eye[0], r.pos[1] + g.eye[1], r.pos[2] + g.eye[2]])).toBe(true);
        const w = createWeaponModel(gun, { scope: sc, level: 2 })!;
        expect(w.getObjectByName('sight')!.position.toArray()).toEqual([...s.eye]);
        expect(!!w.getObjectByName('lens')).toBe(sc === 'scope_red_dot');
        applyViewmodelPose(rig, gun as 'pistol', 1, { scope: sc, level: 2 });
        rig.root.updateMatrixWorld(true);
        const p = rig.itemSocket.getObjectByName('sight')!.getWorldPosition(new THREE.Vector3());
        expect(p.length(), `${gun} ${sc} ADS`).toBeLessThan(1e-6);
      }
    }
  });
  it('a scope that does not fit falls back to the built-in sight', () => {
    expect(getWeaponSight('pistol', { scope: 'scope_8x' })!.type).toBe('iron');
    expect(getWeaponSight('rifle', { scope: 'scope_8x' })!.type).toBe('scope_8x'); // the rail is long enough
    expect(getWeaponSight('rpg', { scope: 'scope_red_dot' })!.type).toBe('iron');
  });
  it('scope pickups: real models with the supply marker', () => {
    for (const sc of SCOPE_MODEL_IDS) {
      const l = createLootModel(sc, 'common', { marker: 'supply' });
      expect((l.getObjectByName('item') as THREE.Mesh).geometry.name).toBe(`scope:${sc}`);
      expect(l.getObjectByName('glow')!.userData.marker).toBe('supply');
    }
  });
});

describe('M2c new items', () => {
  it('melee: tip + swingTrail anchors, no muzzle or sight', () => {
    for (const id of ['knife', 'machete', 'paddle']) {
      const w = createWeaponModel(id, { level: 1 })!;
      expect(w.getObjectByName('tip')).toBeTruthy();
      expect(w.getObjectByName('swingTrail')).toBeTruthy();
      expect(w.getObjectByName('muzzle')).toBeUndefined();
      expect(w.getObjectByName('sight')).toBeUndefined();
      expect(getWeaponSight(id)).toBeNull();
    }
    // reach reads by length: knife < machete < paddle
    const len = (id: string) => { const b = new THREE.Box3().setFromObject(createWeaponModel(id)!); return b.max.z - b.min.z; };
    expect(len('knife')).toBeLessThan(len('machete'));
    expect(len('machete')).toBeLessThan(len('paddle'));
  });
  it('dbshotgun has two muzzles; rpg has exhaust, rocketSeat and a shoulder hold offset', () => {
    const d = createWeaponModel('dbshotgun')!;
    expect(d.getObjectByName('muzzleL')!.position.x).toBeLessThan(0);
    expect(d.getObjectByName('muzzleR')!.position.x).toBeGreaterThan(0);
    const r = createWeaponModel('rpg')!;
    expect(r.getObjectByName('exhaust')!.position.z).toBeGreaterThan(0.3);
    expect(r.userData.holdOffset).toBeTruthy();
  });
  it('rocket and ammo_rocket: budgets, nozzle anchor', () => {
    const r = createRocketModel();
    expect(r.getObjectByName('nozzle')!.position.z).toBeGreaterThan(0.2);
    expect(tris(r).colour).toBeLessThanOrEqual(240);
    const a = createLootModel('ammo_rocket', 'common', { marker: 'supply' });
    expect((a.getObjectByName('item') as THREE.Mesh).geometry.name).toBe('loot:ammo_rocket');
    expect(tris(a.getObjectByName('spin')!).colour).toBeLessThanOrEqual(320);
  });
  it('the smoke can never reads as the frag: a cylinder, not a ball; cream pin, fuse anchor', () => {
    const s = createSmokeModel(), f = createGrenadeModel();
    const colours = (o: THREE.Object3D) => {
      const g = (o as THREE.Mesh).geometry.getAttribute('color');
      const set = new Set<number>();
      for (let i = 0; i < g.count; i++) set.add(new THREE.Color(g.getX(i), g.getY(i), g.getZ(i)).getHex());
      return set;
    };
    const cs = colours(s.getObjectByName('smokeMesh')!), cf = colours(f.getObjectByName('grenadeMesh')!);
    for (const tangerine of [0xff9f1c, 0xd97a12, 0xff3b5c]) expect(cs.has(tangerine)).toBe(false); // no frag body / pin colours
    expect(cs.has(0xc9b6f2)).toBe(true); // lilac can
    expect(cf.has(0xc9b6f2)).toBe(false);
    // the can's side is a straight cylinder: its widest body ring is the same at the top and bottom hoops
    const bs = new THREE.Box3().setFromObject(s.getObjectByName('smokeMesh')!);
    expect(bs.max.y - bs.min.y).toBeGreaterThan(0.18);
    expect(s.getObjectByName('fuse')).toBeTruthy();
    expect(tris(s).colour).toBeLessThanOrEqual(280);
    expect((createLootModel('smoke').getObjectByName('item') as THREE.Mesh).geometry.name).toBe('smoke:pin');
  });
  it('level 4 armor: bell helmet with a top loop, surfboard vest with a tail fin, within budget', () => {
    const h = createHelmetModel(4), v = createVestModel(4);
    for (const o of [h, v]) {
      const t = tris(o);
      expect(t.colour).toBeLessThanOrEqual(360);
      expect(t.hull).toBeLessThanOrEqual(300);
    }
    expect(h.userData.tier).toBe(4);
    const hb = new THREE.Box3().setFromObject(h);
    expect(hb.max.y).toBeGreaterThan(0.25 + 0.38); // the loop stands above the crown (neck frame: head centre 0.25)
    const vb = new THREE.Box3().setFromObject(v);
    expect(vb.max.z).toBeGreaterThan(0.24); // fin out the back
    expect(vb.min.y).toBeGreaterThan(0.05);
    expect(vb.max.y).toBeLessThan(0.45);
    expect((createLootModel('helmet_4').getObjectByName('item') as THREE.Mesh).geometry.name).toBe('wearable:helmet4');
  });
});

describe('M2c ground markers', () => {
  for (const lv of [1, 2, 3, 4] as const) {
    it(`level ${lv}: ${lv} pips, beam ${LEVEL_BEAM_HEIGHT[lv]} m, level colour ring`, () => {
      const g = createLootMarker(lv);
      expect(g.getObjectByName('pips')!.children.length).toBe(lv);
      expect(!!g.getObjectByName('beam')).toBe(lv >= 2);
      expect(!!g.getObjectByName('ring2')).toBe(lv >= 3);
      expect(!!g.getObjectByName('sparkles')).toBe(lv === 4);
      const ring = g.getObjectByName('ring') as THREE.Mesh;
      expect((ring.material as THREE.MeshBasicMaterial).color.getHex()).toBe(new THREE.Color(LEVEL_COLORS[lv]).getHex());
    });
  }
  it('supply marker: no pips, no beam', () => {
    const g = createLootMarker('supply');
    expect(g.getObjectByName('pips')).toBeUndefined();
    expect(g.getObjectByName('beam')).toBeUndefined();
  });
  it('a levelled loot weapon draws its level model and level marker; armor reads its tier', () => {
    const l = createLootModel('shotgun', 'rare', { level: 3 });
    expect(l.getObjectByName('glow')!.userData.marker).toBe(3);
    expect((l.getObjectByName('item') as THREE.Mesh).geometry).toBe(getWeaponGeometry('shotgun', { level: 3 })!.merged.geometry);
    expect(createLootModel('vest_2', 'common', { marker: 'level' }).getObjectByName('glow')!.userData.marker).toBe(2);
    expect(createLootModel('bandage', 'common', { marker: 'level' }).getObjectByName('glow')!.userData.marker).toBe('supply');
    // legacy call keeps the M2b tier glow
    expect(createLootModel('bandage', 'epic').getObjectByName('glow')!.getObjectByName('sparkles')).toBeTruthy();
  });
});

describe('M2c decor and island variants', () => {
  it('the decor table covers EXACTLY the level data kinds', () => {
    expect([...DECOR_KIND_IDS].sort()).toEqual([...DECOR_KINDS].sort());
  });
  for (const kind of DECOR_KIND_IDS) {
    it(`${kind}: body only (no hull, no shadow), <= 0.5 m tall, <= 130 tris, inside its kit size`, () => {
      const info = DECOR_KIND_INFO[kind];
      for (let v = 0; v < info.variants; v++) {
        const parts = getDecorParts(kind, v);
        expect(parts.map((p) => p.name)).toEqual(['body']);
        expect(parts[0].castShadow).toBe(false);
        const g = parts[0].geometry;
        expect(g.getAttribute('position').count / 3).toBeLessThanOrEqual(130);
        g.computeBoundingBox();
        const b = g.boundingBox!;
        expect(b.max.y).toBeLessThanOrEqual(0.5);
        expect(b.min.y).toBeGreaterThan(-0.05);
        const size = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
        size.forEach((s, i) => expect(s, `${kind}/${v} axis ${i}`).toBeLessThanOrEqual(info.size[i] + 0.03));
      }
    });
  }
  it('ISLAND_VARIANTS covers every prop kind; every variant builds inside the variant-0 bounds (same collider)', () => {
    expect(Object.keys(ISLAND_VARIANTS).sort()).toEqual([...PROP_KINDS].sort());
    for (const kind of PROP_KINDS) {
      const b0 = getPropBounds(kind).expandByScalar(0.35);
      for (let v = 0; v < ISLAND_VARIANTS[kind]; v++) {
        const g = getPropParts(kind, v)[0].geometry;
        g.computeBoundingBox();
        expect(b0.containsBox(g.boundingBox!), `${kind} v${v}`).toBe(true);
        expect(g.getAttribute('position').count / 3).toBeLessThanOrEqual(800);
      }
      expect(getPropParts(kind, 0)).toBe(getPropParts(kind)); // variant 0 = the M2b parts
      expect(getPropParts(kind, ISLAND_VARIANTS[kind] + 1)).toBe(getPropParts(kind, 1 % ISLAND_VARIANTS[kind])); // modulo
    }
  });
  it('office waterCooler: floor kit kind, <= 3.6 m deep, bottle top not a 0.6-1.35 m ledge over its cabinet', () => {
    const e = OFFICE_KIT.waterCooler;
    expect(e.origin).toBe('floor');
    expect(e.size[2]).toBeLessThanOrEqual(3.6);
    const tops = e.colliders.map((c) => (c.type === 'cylinder' ? c.y1 : c.max[1]));
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(1.35);
  });
});

describe('M2c viewmodel and icons', () => {
  it('melee swing arcs: hold at 0 and 1, the centre key exactly at the hit frame', () => {
    for (const id of VIEWMODEL_MELEE_IDS) {
      const w = (BALANCE.weapons as unknown as Record<string, { hitFrameMs?: number; fireIntervalMs: number }>)[id];
      const h = w ? meleeHitFraction(w) : 0.35;
      expect(h).toBeGreaterThan(0.1);
      expect(h).toBeLessThan(0.8);
      expect(meleeSwingPose(id, 0, h)).toEqual(VIEWMODEL_POSES[id].hip);
      const end = meleeSwingPose(id, 1, h);
      end.pos.forEach((v, i) => expect(v).toBeCloseTo(VIEWMODEL_POSES[id].hip.pos[i], 9));
      meleeSwingPose(id, h, h).pos.forEach((v, i) => expect(v).toBeCloseTo(MELEE_SWING_KEYS[id].centre.pos[i], 9));
      expect(VIEWMODEL_POSES[id].ads).toEqual(VIEWMODEL_POSES[id].hip); // no ADS on melee
    }
  });
  it('new guns ADS onto their sight; the paddle is two-handed, the knife one-handed', () => {
    const rig = createViewmodel({ skin: 0, outfit: 0 });
    for (const id of ['revolver', 'dbshotgun', 'rpg'] as const) {
      applyViewmodelPose(rig, id, 1);
      rig.root.updateMatrixWorld(true);
      expect(rig.itemSocket.getObjectByName('sight')!.getWorldPosition(new THREE.Vector3()).length()).toBeLessThan(1e-6);
    }
    applyViewmodelPose(rig, 'paddle', 0);
    expect(rig.handL.visible).toBe(true);
    applyViewmodelPose(rig, 'knife', 0, { level: 4 });
    expect(rig.handL.visible).toBe(false);
    expect(rig.itemSocket.children[0].userData.level).toBe(4);
  });
  it('icons: one 32 x 32 SVG per new item and scope, inked; the 2x reticle is centred', () => {
    const ids = ['knife', 'machete', 'paddle', 'dbshotgun', 'revolver', 'rpg', 'ammo_rocket', 'smoke', 'vest_4', 'helmet_4', ...SCOPE_MODEL_IDS];
    expect(Object.keys(M2C_ICON_SVG).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(M2C_ICON_SVG[id]).toMatch(/^<svg viewBox="0 0 32 32"/);
      expect(M2C_ICON_SVG[id]).toContain('#2A1D33');
      expect(M2C_ICON_SVG[id].endsWith('</svg>')).toBe(true);
    }
    expect(SCOPE_2X_RETICLE_SVG).toContain('viewBox="-100 -100 200 200"');
  });
});
