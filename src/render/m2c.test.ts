/**
 * M2c render groundwork tests (art M2c §4.2, §10, §11; Addendum 2): look presets (noon / day unchanged, guardrails),
 * the island per-chunk prop merge (same geometry as the instanced path, few chunks), the smoke cloud renderer (sim
 * radius, seeded puffs, ground clearance, veil, fade, no quality dependence) and the by-material model batch.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MAPS } from '../game/levels';
import { applyLayout, buildMatchLayout } from '../game/levels/layout';
import { BALANCE, type SmokeCloudBalance } from '../shared/balance';
import type { FrameView, SmokeCloudView, ViewmodelView } from '../shared/contracts';
import { glassPanes, isIndoor } from '../shared/maps';
import { smokeRadiusAt } from '../shared/smoke';
import { ISLAND_LOOK_IDS, OFFICE_LOOK_IDS, type AnyMapData, type IndoorMapData, type IslandMapData, type LootState, type PlayerState, type SmokeCloudState } from '../shared/types';
import { glintCut, sceneLookFor, sunDiscCosines } from './looks';
import { LootLayer, lootMarkerKey, lootModelKey } from './LootLayer';
import { ModelBatch } from './ModelBatch';
import { computePose, isTwoHanded, makePose, MELEE_SWING_3P, RPG_ARM_X, swingWeights } from './characterPose';
import { buildDebris, paneLayout } from './GlassLayer';
import { IndoorScene, OFFICE_LOOK } from './IndoorScene';
import { heldScope, PlayerViews } from './PlayerViews';
import { QUALITY_PRESETS } from './quality';
import { RocketLayer, rocketQuaternion } from './RocketLayer';
import { GrenadeLayer } from './GrenadeLayer';
import { meleeSwingPose, palette } from './procedural';
import { createVmOut, isGun, ViewmodelAnimator, viewmodelItemFor } from './viewmodelAnim';
import { ViewmodelPass } from './ViewmodelPass';
import { chunkGridFor, chunkIndexOf, ISLAND_CHUNK, PropLayer } from './PropLayer';
import { createProp } from './procedural';
import {
  cloudViewsFrom, coreDissolve, puffDissolve, puffLayout, SMOKE_CORE_SCALE, SMOKE_PUFFS, SmokeLayer, veilOpacity,
} from './SmokeLayer';
import { ISLAND_LOOK } from './Sky';

const island = (() => {
  const m = (MAPS as Record<string, AnyMapData>).island01;
  if (!m || isIndoor(m)) throw new Error('island level missing');
  return m as IslandMapData;
})();

const cloudCfg: SmokeCloudBalance = BALANCE.items.smoke?.cloud ?? {
  radius: 6.5, centerHeight: 1.2, growMs: 1500, holdMs: 18000, fadeMs: 3000, closeSightRange: 2, maxActive: 12,
};

const hex = (h: number): [number, number, number] => [(h >> 16) & 255, (h >> 8) & 255, h & 255];

describe('look presets (art M2c §10)', () => {
  it('noon and day ARE the shipped looks (same objects), and an absent or wrong-kind id gives the baseline', () => {
    expect(sceneLookFor('island', 'noon')).toBe(ISLAND_LOOK);
    expect(sceneLookFor('indoor', 'day')).toBe(OFFICE_LOOK);
    expect(sceneLookFor('island')).toBe(ISLAND_LOOK);
    expect(sceneLookFor('indoor', null)).toBe(OFFICE_LOOK);
    expect(sceneLookFor('island', 'afterHours')).toBe(ISLAND_LOOK);
    expect(sceneLookFor('indoor', 'golden')).toBe(OFFICE_LOOK);
    // The shipped looks carry none of the optional preset fields, so every consumer keeps its shipped default.
    for (const k of ['sky', 'clouds', 'sea', 'flameScale', 'exposure', 'office'] as const) {
      expect(ISLAND_LOOK[k]).toBeUndefined();
      expect(OFFICE_LOOK[k]).toBeUndefined();
    }
  });

  it('noon sky and sea constants are bit-identical to the shipped shader literals', () => {
    expect(sunDiscCosines(1, false)).toEqual({ disc: 0.99935, halo: 0.9965 });
    expect(glintCut(1)).toBe(0.965);
    expect(Math.fround(glintCut(1))).toBe(Math.fround(0.965));
    // Golden hour: a bigger disc (smaller cosine); overcast: hidden.
    const g = sunDiscCosines(1.6, false);
    expect(g.disc).toBeLessThan(0.99935);
    expect(sunDiscCosines(1, true).disc).toBeGreaterThan(1);
    expect(glintCut(1.2)).toBeLessThan(0.965);
    expect(glintCut(0.25)).toBeGreaterThan(0.965);
  });

  it('every preset keeps the guardrails (fog = horizon, sun not dyed, hemisphere >= 0.85, fog far limits)', () => {
    for (const id of ISLAND_LOOK_IDS) {
      const l = sceneLookFor('island', id);
      expect(l.fogFar, id).toBeGreaterThanOrEqual(200);
      expect(l.hemiIntensity, id).toBeGreaterThanOrEqual(0.85);
      const s = hex(l.sunColor);
      expect(Math.min(...s), id).toBeGreaterThanOrEqual(0.6 * Math.max(...s));
      if (l.sky) expect(l.fogColor, id).toBe(l.sky.horizon);
      expect(l.background, id).toBe(l.fogColor);
      expect(Math.abs(l.sunDir.length() - 1), id).toBeLessThan(1e-9);
      // Golden hour keeps the sun at >= 20 deg (shadow frustum; art §10.1).
      expect(Math.asin(l.sunDir.y) * (180 / Math.PI), id).toBeGreaterThanOrEqual(20);
    }
    for (const id of OFFICE_LOOK_IDS) {
      const l = sceneLookFor('indoor', id);
      expect(l.fogFar, id).toBeGreaterThanOrEqual(250);
      expect(l.hemiIntensity, id).toBeGreaterThanOrEqual(0.85);
      const s = hex(l.sunColor);
      expect(Math.min(...s), id).toBeGreaterThanOrEqual(0.6 * Math.max(...s));
      expect(l.background, id).toBe(l.fogColor);
    }
  });

  it('island presets differ from noon where the art table says so (relative to the shipped noon)', () => {
    const m = sceneLookFor('island', 'morning');
    expect(m.sunDir.x).toBeGreaterThan(0); // from the east
    expect(sceneLookFor('island', 'golden').sunDir.x).toBeLessThan(0); // from the west
    expect(sceneLookFor('island', 'overcast').sky?.sunDisc).toBeNull();
    expect(sceneLookFor('island', 'overcast').exposure).toBe(1.05);
    expect(sceneLookFor('island', 'overcast').clouds?.count).toBe(22);
    expect(m.sunIntensity).toBeCloseTo((2.0 / 2.4) * ISLAND_LOOK.sunIntensity, 9);
    expect(sceneLookFor('indoor', 'afterHours').office?.underDesk).toBe(0.85);
  });
});

describe('island static props merged per chunk (art M2c §11.1)', () => {
  const heightAt = () => 0;
  it('chunk grid covers the placements and the index clamps to it', () => {
    const g = chunkGridFor(island.props, ISLAND_CHUNK);
    expect(g.nx * g.size).toBeGreaterThanOrEqual(Math.max(...island.props.map((p) => p.x)) - Math.min(...island.props.map((p) => p.x)));
    for (const p of island.props) {
      const i = chunkIndexOf(p.x, p.z, g);
      const cx = g.minX + (i % g.nx) * g.size, cz = g.minZ + Math.floor(i / g.nx) * g.size;
      expect(p.x).toBeGreaterThanOrEqual(cx - 1e-9);
      expect(p.x).toBeLessThanOrEqual(cx + g.size + 1e-9);
      expect(p.z).toBeGreaterThanOrEqual(cz - 1e-9);
    }
    expect(chunkIndexOf(-1e4, -1e4, g)).toBe(0);
    expect(chunkIndexOf(1e4, 1e4, g)).toBe(g.nx * g.nz - 1);
    expect(chunkGridFor([], 56)).toEqual({ minX: 0, minZ: 0, size: 56, nx: 1, nz: 1 });
  });

  it('bakes exactly the instanced geometry into <= 2 meshes per chunk; flames stay instanced', () => {
    const merged = new PropLayer(island, heightAt);
    const inst = new PropLayer(island, heightAt, { merge: false });
    // Expected triangles from the per-kind templates.
    let body = 0, hull = 0;
    for (const p of island.props) {
      for (const c of createProp(p.kind).children) {
        const g = (c as THREE.Mesh).geometry;
        const tris = g.getAttribute('position').count / 3;
        if (c.name === 'outline') hull += tris;
        else if (c.name !== 'flame') body += tris;
      }
    }
    expect(merged.stats.bodyTris).toBe(body);
    expect(merged.stats.hullTris).toBe(hull);
    const g = chunkGridFor(island.props, ISLAND_CHUNK);
    expect(merged.chunkCount).toBeLessThanOrEqual(g.nx * g.nz);
    const meshes = merged.group.children.filter((c) => (c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBeLessThanOrEqual(2 * merged.chunkCount);
    // Only the tiki flames remain instanced.
    const instanced = merged.group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    expect(instanced.map((c) => c.name)).toEqual(['prop:tikiTorch:flame']);
    expect(inst.group.children.length).toBeGreaterThan(merged.group.children.length - merged.chunkCount * 2);
    // The camera colliders are the same either way.
    expect(merged.colliders).toEqual(inst.colliders);
    merged.dispose();
    inst.dispose();
    expect(merged.group.children.length).toBe(0);
  });

  it('hides chunks past the draw distance and hulls past the outline distance', () => {
    const layer = new PropLayer(island, heightAt);
    const frustum = new THREE.Frustum();
    const cam = new THREE.Vector3(0, 2, 0);
    layer.update(frustum, cam, 0, 1e6, 1e6);
    const bodies = layer.group.children.filter((c) => c.name.endsWith(':body'));
    const hulls = layer.group.children.filter((c) => c.name.endsWith(':hull'));
    expect(bodies.every((b) => b.visible)).toBe(true);
    expect(hulls.every((b) => b.visible)).toBe(true);
    layer.update(frustum, cam, 0, 1e6, 1);
    expect(hulls.some((h) => !h.visible)).toBe(true);
    layer.update(frustum, cam, 0, 1, 1);
    expect(bodies.some((b) => !b.visible)).toBe(true);
    layer.dispose();
  });
});

describe('smoke clouds (art M2c §4.2)', () => {
  const state = (id: number, deployedAt: number, x = 0, z = 0): SmokeCloudState => ({
    id, ownerId: 1, pos: { x, y: 0, z }, deployedAt, fadeAt: deployedAt + cloudCfg.growMs + cloudCfg.holdMs,
  });

  it('views carry the sim radius (smoke.ts) and drop clouds that are gone', () => {
    const s = [state(5, 0), state(6, -100000)];
    const out: SmokeCloudView[] = [];
    cloudViewsFrom(s, 700, cloudCfg, out);
    expect(out.length).toBe(1);
    expect(out[0].radius).toBe(smokeRadiusAt(s[0], 700, cloudCfg));
    expect(out[0].center.y).toBe(cloudCfg.centerHeight);
    cloudViewsFrom(s, cloudCfg.growMs + 1, cloudCfg, out);
    expect(out[0].radius).toBe(cloudCfg.radius);
  });

  it('puff layout is seeded by the cloud id, stays inside 1.02 r and off the ground', () => {
    const below = cloudCfg.centerHeight / cloudCfg.radius;
    const a = puffLayout(42, below), b = puffLayout(42, below), c = puffLayout(43, below);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    for (let i = 0; i < SMOKE_PUFFS; i++) {
      const [x, y, z, r] = [a[i * 7], a[i * 7 + 1], a[i * 7 + 2], a[i * 7 + 3]];
      expect(y - r).toBeGreaterThanOrEqual(-below + 0.15 - 1e-6);
      // Outer extent within the shell (puffs pushed up off the ground may poke further out, never past 1.02 r + lift).
      if (y - r > -below + 0.15 + 1e-6) expect(Math.hypot(x, y, z) + r).toBeLessThanOrEqual(1.02 + 1e-6);
    }
  });

  it('veil: none outside, full (0.96) inside 0.75 r; dissolve top-first, core last', () => {
    expect(veilOpacity(7, 6.5)).toBe(0);
    expect(veilOpacity(6.5, 6.5)).toBe(0);
    expect(veilOpacity(0, 6.5)).toBeCloseTo(0.96, 9);
    expect(veilOpacity(0.75 * 6.5, 6.5)).toBeCloseTo(0.96, 9);
    expect(veilOpacity(0.9 * 6.5, 6.5)).toBeGreaterThan(0);
    expect(veilOpacity(0, 0)).toBe(0);
    expect(puffDissolve(0, 1)).toBe(0);
    expect(puffDissolve(0.3, 1)).toBeGreaterThan(puffDissolve(0.3, 0));
    expect(puffDissolve(1, 0)).toBe(1);
    expect(coreDissolve(0.5)).toBe(0);
    expect(coreDissolve(1)).toBe(1);
  });

  it('draws 3 instanced meshes for any number of clouds, the core at 0.88 r, the veil only inside', () => {
    const layer = new SmokeLayer();
    const out: SmokeCloudView[] = [];
    const t = 5000;
    cloudViewsFrom([state(1, 0), state(2, 0, 30, 0), state(3, 0, -30, 10)], t, cloudCfg, out);
    layer.update(out, t, cloudCfg, new THREE.Vector3(0, 50, 80), 1, false);
    expect(layer.cloudCount).toBe(3);
    expect(layer.puffs.count).toBe(3 * SMOKE_PUFFS);
    expect(layer.hulls.count).toBe(3 * SMOKE_PUFFS);
    expect(layer.veil.visible).toBe(false);
    const m = new THREE.Matrix4();
    layer.core.getMatrixAt(0, m);
    const s = new THREE.Vector3().setFromMatrixScale(m);
    expect(s.x).toBeCloseTo(cloudCfg.radius * SMOKE_CORE_SCALE, 6);
    // Camera at the centre of cloud 1.
    layer.update(out, t, cloudCfg, new THREE.Vector3(0, cloudCfg.centerHeight, 0), 1, false);
    expect(layer.veil.visible).toBe(true);
    expect(layer.veilAmount).toBeCloseTo(0.96, 6);
    // Reduced motion: same coverage (core matrix identical), churn off.
    const m2 = new THREE.Matrix4();
    layer.update(out, t, cloudCfg, new THREE.Vector3(0, 50, 80), 1, true);
    layer.core.getMatrixAt(0, m2);
    expect(m2.equals(m)).toBe(true);
    // No balance block: nothing drawn.
    layer.update(out, t, null, new THREE.Vector3(), 1, false);
    expect(layer.core.visible).toBe(false);
    layer.dispose();
  });
});

describe('ModelBatch: per-level models batched by material (Addendum 2)', () => {
  it('is not culled as a whole by a stale bounding sphere (ground loot showed only its marker)', () => {
    const batch = new ModelBatch('cull', { instances: 2, vertices: 1024 });
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    // Looking at loot far from the world origin (the origin itself out of view).
    cam.position.set(50, 1, 55);
    cam.lookAt(50, 0, 50);
    cam.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
    );
    // First frame: the batch is empty, three.js caches an empty bounding sphere for it.
    for (const b of [batch.body, batch.hull]) {
      b.updateMatrixWorld();
      frustum.intersectsObject(b);
    }
    batch.register('rock', () => createProp('rock'));
    const h = batch.acquire('rock');
    batch.setMatrix(h, new THREE.Matrix4().makeTranslation(50, 0, 50));
    batch.setVisible(h, true);
    // The renderer only frustum-tests objects with frustumCulled set; the cached sphere would reject the batch.
    for (const b of [batch.body, batch.hull]) expect(!b.frustumCulled || frustum.intersectsObject(b)).toBe(true);
    batch.dispose();
  });

  it('builds each key lazily once and keeps 2 meshes for any number of models', () => {
    const batch = new ModelBatch('test', { instances: 2, vertices: 1024 });
    const calls: Record<string, number> = {};
    const kinds = ['palm', 'rock', 'crate', 'bush', 'hut'] as const;
    for (const k of kinds) {
      for (let lv = 1; lv <= 4; lv++) {
        const key = `${k}:L${lv}`;
        batch.register(key, () => {
          calls[key] = (calls[key] ?? 0) + 1;
          return createProp(k);
        });
      }
    }
    expect(batch.stats.models).toBe(0); // lazy
    const handles = [];
    for (const k of kinds) for (let lv = 1; lv <= 4; lv++) handles.push(batch.acquire(`${k}:L${lv}`));
    handles.push(batch.acquire('rock:L1'));
    expect(batch.stats.models).toBe(20);
    expect(Object.values(calls).every((n) => n === 1)).toBe(true);
    expect(batch.liveInstances).toBe(21);
    expect(batch.stats.grows).toBeGreaterThan(0); // grew from 2 instances and 1024 vertices
    const m = new THREE.Matrix4().makeTranslation(1, 2, 3);
    batch.setMatrix(handles[0], m);
    batch.setVisible(handles[0], true, false);
    expect(batch.body.getVisibleAt(handles[0].body)).toBe(true);
    expect(batch.hull.getVisibleAt(handles[0].hull)).toBe(false);
    batch.swap(handles[0], 'hut:L4');
    expect(batch.body.getGeometryIdAt(handles[0].body)).toBe(handles[0].entry.bodyGeo);
    batch.release(handles[1]);
    expect(batch.liveInstances).toBe(20);
    batch.dispose();
  });
});

describe('LootLayer: ground loot batched by material (Addendum 2)', () => {
  const frustum = new THREE.Frustum(); // default planes contain everything
  const cam = new THREE.Vector3(0, 2, 0);
  const guns = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'revolver', 'dbshotgun', 'rpg', 'knife', 'machete', 'paddle'];
  const mixed = (): LootState[] =>
    guns.flatMap((g, i) => ([1, 2, 3, 4] as const).map((lv) => ({
      id: i * 4 + lv, item: g, qty: 1, pos: { x: i, y: 0, z: lv }, tier: 'common', level: lv,
      scope: g === 'rifle' && lv === 4 ? 'scope_4x' : null,
    }) as unknown as LootState));

  it('keys and markers', () => {
    expect(lootModelKey({ item: 'rifle', level: 3, scope: 'scope_4x' } as never)).toBe('rifle|3|scope_4x');
    expect(lootModelKey({ item: 'bandage' } as never)).toBe('bandage|-|-');
    expect(lootMarkerKey({ item: 'rifle', level: 2 } as never)).toBe('L2');
    expect(lootMarkerKey({ item: 'vest_3' } as never)).toBe('L3');
    expect(lootMarkerKey({ item: 'ammo_light' } as never)).toBe('supply');
  });

  it('52 distinct weapon models on the ground share 2 batched meshes; instances follow the loot list', () => {
    const layer = new LootLayer(island, BALANCE);
    const loot = mixed();
    layer.update(loot, 3, 1, frustum, cam, 1e4);
    const items = layer.items!;
    expect(items.stats.models).toBe(52);
    expect(items.liveInstances).toBe(52);
    const batched = layer.group.children.filter((c) => (c as THREE.BatchedMesh).isBatchedMesh);
    expect(batched.length).toBe(2);
    // Markers: level parts only (no per-weapon instanced item meshes).
    const inst = layer.group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh && c.visible);
    expect(inst.length).toBeLessThanOrEqual(20);
    // Pick-up: the instance is freed; a level change swaps the model in place.
    loot.pop();
    (loot[0] as { level: number }).level = 4;
    layer.update(loot, null, 2, frustum, cam, 1e4);
    expect(items.liveInstances).toBe(51);
    expect(items.stats.models).toBe(52); // pistol L4 existed already
    layer.dispose();
  });

  it('the M2b path (no levels) still draws one instanced mesh per item part and the tier glow', () => {
    const layer = new LootLayer(island, BALANCE, false);
    const loot = [{ id: 1, item: 'rifle', qty: 1, pos: { x: 0, y: 0, z: 0 }, tier: 'epic' } as LootState];
    layer.update(loot, null, 1, frustum, cam, 1e4);
    expect(layer.items).toBeNull();
    expect(layer.group.children.some((c) => c.name === 'loot:item' && c.visible)).toBe(true);
    layer.dispose();
  });
});

describe('held items share the item batch (Addendum 2)', () => {
  const anim = { moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false, healing: false, ads: false, cooking: false };
  const mkState = (id: number, weapon: string, level: number | null, sight: string): PlayerState => ({
    id, name: `P${id}`, pos: { x: id * 2, y: 0, z: 0 }, velY: 0, yaw: 0, pitch: 0, hp: 100, vestTier: 0, helmetTier: 0, alive: true,
    weapon, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1, anim: { ...anim }, appearance: { skin: 0, outfit: 0, hair: 0 },
    isBot: true, kills: 0, weaponLevel: level, sight,
  }) as unknown as PlayerState;

  it('every armed player is one batch instance; the proxy keeps anchors and hides its own meshes', () => {
    const items = new ModelBatch('items');
    const views = new PlayerViews(BALANCE, { onPoof: () => {} }, items);
    const states = [
      mkState(1, 'rifle', 3, 'scope_4x'), mkState(2, 'rpg', 4, 'iron'), mkState(3, 'knife', 2, 'none'),
      mkState(4, 'fists', null, 'none'), mkState(5, 'smoke', null, 'none'), mkState(6, 'dbshotgun', 1, 'iron'),
    ];
    const frame = { time: 1, dt: 1 / 60, serverTime: 1000, cam: new THREE.Vector3(0, 2, 10), follow: false, hideId: null, localAds: 0 };
    views.update(states.map((s) => ({ state: s, isLocal: false, isSpectateTarget: false })), frame);
    expect(items.liveInstances).toBe(5); // fists draw nothing
    expect(items.stats.models).toBe(5);
    // No per-player toon or hull mesh is visible under the hands.
    let visibleWeaponMeshes = 0;
    views.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && (m.name === 'weapon' || m.name === 'grenadeMesh' || m.name === 'smokeMesh') && m.visible) visibleWeaponMeshes++;
    });
    expect(visibleWeaponMeshes).toBe(0);
    // The muzzle anchor still resolves (VFX).
    const out = { x: 0, y: 0, z: 0 };
    expect(views.getMuzzle(1, out)).toBe(true);
    expect(heldScope('rifle', 'scope_4x')).toBe('scope_4x');
    expect(heldScope('rifle', 'red_dot')).toBeNull();
    expect(heldScope('dmr', 'scope_8x')).toBe('scope_8x');
    expect(heldScope('knife', 'none')).toBeNull();
    // First-person subject: its instance hides.
    views.update(states.map((s) => ({ state: s, isLocal: s.id === 1, isSpectateTarget: false })), { ...frame, hideId: 1 });
    const h = (views as unknown as { views: Map<number, { heldHandle: { body: number } }> }).views.get(1)!.heldHandle;
    expect(items.body.getVisibleAt(h.body)).toBe(false);
    views.dispose();
    items.dispose();
  });
});

describe('viewmodel M2c items (art M2c §7)', () => {
  const vm = (over: Record<string, unknown> = {}) => ({
    playerId: 1, appearance: { skin: 1, outfit: 2, hair: 0 }, vestTier: 0, item: 'rifle', cooking: false, action: 'idle',
    actionProgress: 0, adsBlend: 0, visible: true, shotCount: 0, stance: 'stand', stanceFrom: 'stand', stanceProgress: 1,
    dropPhase: null, bobPhase: 0, bobAmount: 0, sprinting: false, lookRate: { yaw: 0, pitch: 0 }, motionScale: 0, ...over,
  }) as unknown as ViewmodelView;
  const frame = (v: ViewmodelView, time = 0): FrameView => ({
    time, serverTime: 0, phase: 'playing', localId: 1,
    camera: { mode: 'follow', target: { x: 0, y: 1.2, z: 0 }, yaw: 0, pitch: 0, distance: 0, shoulderOffset: 0, fovDeg: 70, firstPerson: true, view: 'firstPerson', subjectId: 1, roll: 0 },
    players: [], loot: [], highlightLootId: null, zone: null, grenades: [], grenadeArc: null, ads: null, viewmodel: v, reducedMotion: false,
    rockets: [], smokes: [], brokenPanes: [], look: 'noon',
  }) as unknown as FrameView;

  it('maps the new ids', () => {
    expect(viewmodelItemFor('revolver', false)).toBe('revolver');
    expect(viewmodelItemFor('knife', false)).toBe('knife');
    expect(viewmodelItemFor('smoke', true)).toBe('smoke_cooking');
    expect(isGun('rpg')).toBe(true);
    expect(isGun('paddle')).toBe(false);
  });

  for (const [gun, sight] of [['rifle', 'scope_2x'], ['dmr', 'scope_8x'], ['revolver', 'iron'], ['dbshotgun', 'iron'], ['rpg', 'iron'], ['smg', 'red_dot']] as const) {
    it(`${gun} L4 with ${sight}: the sight anchor is on the view axis at ADS`, () => {
      const pass = new ViewmodelPass(BALANCE);
      for (let i = 0; i < 60; i++) pass.update(frame(vm({ item: gun, level: 4, sight, adsBlend: 1 }), i / 60), 1 / 60);
      const root = pass.scene.getObjectByName('viewmodel')!;
      root.updateMatrixWorld(true);
      const s = root.getObjectByName('sight')!;
      const eye = s.getWorldPosition(new THREE.Vector3());
      expect(Math.hypot(eye.x, eye.y)).toBeLessThan(1e-4);
      expect(root.getObjectByName('itemSocket')!.children[0].userData.level).toBe(4);
      pass.dispose();
    });
  }

  it('melee swing follows the designer arc and the blade crosses the centre at the hit frame', () => {
    const a = new ViewmodelAnimator();
    const out = createVmOut();
    const ctx = { airborne: false };
    a.step(vm({ item: 'machete', level: 2, sight: 'none' }), ctx, 1 / 60, out);
    const h = 0.4;
    a.step(vm({ item: 'machete', action: 'swing', actionProgress: h, hitFraction: h }), ctx, 1 / 60, out);
    const ref = meleeSwingPose('machete', h, h, false);
    expect(out.sockAbsW).toBe(1);
    expect(Array.from(out.sockAbsPos)).toEqual(ref.pos);
    expect(out.item).toBe('machete');
    // A pass draws every melee item.
    const pass = new ViewmodelPass(BALANCE);
    for (const item of ['knife', 'machete', 'paddle', 'smoke']) {
      for (let i = 0; i < 5; i++) pass.update(frame(vm({ item, action: item === 'smoke' ? 'idle' : 'swing', actionProgress: i / 5, hitFraction: 0.35 }), i / 60), 1 / 60);
    }
    pass.dispose();
  });
});

describe('third-person melee and rpg poses (art M2c §8)', () => {
  const anim = { moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false, healing: false, ads: false, cooking: false };
  const input = (o: Record<string, unknown> = {}) => ({
    time: 0, anim, weapon: 'machete', pitch: 0, speed: 0, sprintSpeed: 7, velY: 0, walkPhase: 0, recoil: 0, hit: 0, deathTime: -1, seed: 0, ...o,
  }) as never;

  it('swing weights: hold -> wind-up -> strike -> hold', () => {
    expect(swingWeights(0, 0.4)).toEqual({ windup: 0, strike: 0 });
    expect(swingWeights(0.28, 0.4).windup).toBeCloseTo(1, 9);
    expect(swingWeights(0.5, 0.4).strike).toBeCloseTo(1, 9);
    const end = swingWeights(1, 0.4);
    expect(end.windup + end.strike).toBeCloseTo(0, 9);
  });

  it('machete: the arm is raised at the wind-up and forward at the strike; prone swings at half range', () => {
    const hold = computePose(input(), makePose());
    const wind = computePose(input({ swing: { weapon: 'machete', progress: 0.28, hitFraction: 0.4 } }), makePose());
    const strike = computePose(input({ swing: { weapon: 'machete', progress: 0.5, hitFraction: 0.4 } }), makePose());
    expect(wind.armRX).toBeCloseTo(MELEE_SWING_3P.machete.windup.armX, 6);
    expect(strike.armRX).toBeCloseTo(MELEE_SWING_3P.machete.strike.armX, 6);
    expect(strike.bodyX).toBeLessThan(hold.bodyX);
    const proneHold = computePose(input({ prone: 1, crouch: 1 }), makePose());
    const proneWind = computePose(input({ prone: 1, crouch: 1, swing: { weapon: 'machete', progress: 0.28, hitFraction: 0.4 } }), makePose());
    expect(proneWind.armRX - proneHold.armRX).toBeCloseTo((MELEE_SWING_3P.machete.windup.armX - proneHold.armRX) * 0.5, 6);
    expect(proneWind.bodyY_rot).toBe(proneHold.bodyY_rot);
  });

  it('rpg rides on the shoulder (arm at pi/2 + 0.15 at level aim); paddle is two-handed', () => {
    expect(computePose(input({ weapon: 'rpg' }), makePose()).armRX).toBeCloseTo(RPG_ARM_X, 9);
    expect(isTwoHanded('paddle')).toBe(true);
    expect(isTwoHanded('knife')).toBe(false);
  });
});

describe('rockets in flight (art M2c §3)', () => {
  it('nose (-Z) along the velocity, rolled about it', () => {
    const q = rocketQuaternion({ x: 3, y: 4, z: 0 }, 0.7);
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    expect(nose.x).toBeCloseTo(0.6, 9);
    expect(nose.y).toBeCloseTo(0.8, 9);
  });

  it('one batch instance per live rocket, trail puffs every 0.35 m, released when gone', () => {
    const items = new ModelBatch('items');
    const fx = { flames: 0, puffs: 0, sparks: 0, rocketFlame() { this.flames++; }, rocketPuff() { this.puffs++; }, rocketSpark() { this.sparks++; } };
    const layer = new RocketLayer(items, fx);
    const rv = (id: number, x: number) => ({ id, ownerId: 1, level: 1, pos: { x, y: 2, z: 0 }, vel: { x: 50, y: 0, z: 0 }, origin: { x: 0, y: 2, z: 0 }, firedAt: 0 }) as never;
    for (let f = 0; f <= 60; f++) layer.update([rv(1, f * 0.7), rv(2, f * 0.7), rv(3, 10 + f * 0.7)], f / 60, false);
    expect(items.liveInstances).toBe(3);
    // 60 frames x 0.7 m = 42 m per rocket -> 120 puffs per rocket, 60 sparks.
    expect(fx.puffs).toBe(3 * 120);
    expect(fx.sparks).toBe(3 * 60);
    expect(fx.flames).toBe(3 * 61);
    layer.update([rv(2, 50)], 2, false);
    expect(items.liveInstances).toBe(1);
    layer.dispose();
    expect(items.liveInstances).toBe(0);
    items.dispose();
  });
});

describe('breakable glass (art M2c §5.2)', () => {
  const office = (MAPS as Record<string, AnyMapData>).office as IndoorMapData;

  it('every pane has a rectangle; glass triangles carry pane ids; breaking collapses them and adds debris', () => {
    const panes = glassPanes(office);
    const layout = paneLayout(office);
    expect(layout.rects.length).toBe(panes.length);
    expect(panes.length).toBeGreaterThan(0);
    for (const r of layout.rects) {
      expect(r.top).toBeGreaterThan(r.bottom);
      expect(r.half).toBeGreaterThan(0);
    }
    const s = new IndoorScene(office, QUALITY_PRESETS.medium, { zoneTheme: 'sprinklers', preset: 'medium', splash: () => {} });
    const glass = s.group.getObjectByName('office:glass') as THREE.Mesh;
    const ids = glass.geometry.getAttribute('paneId');
    expect(ids).toBeDefined();
    const seen = new Set<number>();
    for (let i = 0; i < ids.count; i++) seen.add(ids.getX(i));
    // Every glass wall pane is drawn in the merged glass mesh.
    for (const p of panes) if ('wall' in p) expect(seen.has(p.id)).toBe(true);
    expect(Math.max(...seen)).toBeLessThan(panes.length);
    const debris = s.group.getObjectByName('office:glassDebris') as THREE.Mesh;
    expect(debris.visible).toBe(false);
    s.setBrokenPanes([0, 2]);
    expect(s.isPaneBroken(0)).toBe(true);
    expect(s.isPaneBroken(1)).toBe(false);
    expect(debris.visible).toBe(true);
    expect(debris.geometry.drawRange.count).toBe(2 * (8 + 12) * 3);
    // A new match on the same scene (shorter list) clears the mask.
    s.setBrokenPanes([]);
    expect(s.isPaneBroken(0)).toBe(false);
    expect(debris.visible).toBe(false);
    s.dispose();
  });

  it('debris builder stays inside its buffer', () => {
    const out = new Float32Array(30);
    expect(buildDebris(paneLayout(office).rects, [0, 1, 2], 0, out)).toBeLessThanOrEqual(10);
  });
});

describe('per-match layouts in the static world (decor, variants, lit panels)', () => {
  const office = (MAPS as Record<string, AnyMapData>).office as IndoorMapData;

  it('island: a real layout with decor and variants merges into the same chunks (no extra meshes per kind)', () => {
    const layout = buildMatchLayout(island, 12345, { decor: true });
    const applied = applyLayout(island, layout) as IslandMapData;
    const layer = new PropLayer(applied, () => 0, { decor: layout.decor });
    const islandDecor = layout.decor.filter((d) => d.kind !== 'paperSheets').length;
    expect(layer.stats.decor).toBe(islandDecor);
    expect(layer.stats.decorTris).toBeGreaterThan(0);
    const meshes = layer.group.children.filter((c) => (c as THREE.Mesh).isMesh && !(c as THREE.InstancedMesh).isInstancedMesh);
    expect(meshes.length).toBeLessThanOrEqual(2 * layer.chunkCount);
    // Only the tiki flames stay instanced, whatever the variants.
    const instanced = layer.group.children.filter((c) => (c as THREE.InstancedMesh).isInstancedMesh);
    expect(instanced.every((c) => c.name.startsWith('prop:tikiTorch'))).toBe(true);
    layer.dispose();
  });

  it('office: paper decor joins the chunks; After Hours lights only the lightsOn panels in one glow call', () => {
    const layout = buildMatchLayout(office, 777, { decor: true });
    const applied = applyLayout(office, layout) as IndoorMapData;
    const panels = applied.props.map((p, i) => [p, i] as const).filter(([p]) => p.kind === 'lightPanel');
    const lightsOn = panels.filter((_, k) => k % 3 === 0).map(([, i]) => i);
    const s = new IndoorScene(applied, QUALITY_PRESETS.medium, {
      zoneTheme: 'sprinklers', preset: 'medium', splash: () => {}, look: sceneLookFor('indoor', 'afterHours'), decor: layout.decor, lightsOn,
    });
    expect(s.stats.decor).toBe(layout.decor.filter((d) => d.kind === 'paperSheets').length);
    expect(s.stats.litPanels).toBe(lightsOn.length);
    const glow = s.group.getObjectByName('office:lightPanel:glow') as THREE.InstancedMesh;
    expect(glow.instanceColor).not.toBeNull();
    s.dispose();
  });
});

describe('throw arc ring by throwable (review SF3)', () => {
  it('lilac at the cloud radius for smoke, danger red for the frag', () => {
    const markers = { add: () => {} } as never;
    const layer = new GrenadeLayer(markers, { fuseSpark: () => {}, trailPuff: () => {} }, () => 0);
    const arc = (kind: 'smoke' | 'grenade', radius: number) => ({
      points: [{ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: -10 }], end: { x: 0, y: 0, z: -10 }, radius, kind,
    }) as never;
    const ring = layer.group.getObjectByName('grenade:arcRing') as THREE.Mesh;
    const col = () => (ring.material as THREE.MeshBasicMaterial).color.getHex();
    layer.update([], arc('smoke', 6.5), 0, 1 / 60, 0);
    expect(col()).toBe(new THREE.Color(palette.smokeShadow).getHex());
    const pos = ring.geometry.getAttribute('position');
    expect(Math.hypot(pos.getX(1), pos.getZ(1) + 10)).toBeCloseTo(6.5, 5);
    layer.update([], arc('grenade', 4), 0, 1 / 60, 0);
    expect(col()).toBe(new THREE.Color(palette.danger).getHex());
    layer.dispose();
  });
});
