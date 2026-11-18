/**
 * M2b render tests (ARCHITECTURE §15.7): camera cases and indoor limits, the carrier placement, drop poses and the
 * parachute timeline, BUG-008 head fit at the prone pitch limits, indoor geometry helpers (floor zones, wall and
 * placement matrices, cover data, merging) and an IndoorScene build / T13 retract / dispose on the real office level.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MAPS } from '../game/levels';
import { BALANCE } from '../shared/balance';
import type { CameraView } from '../shared/contracts';
import { isIndoor, wallFrame } from '../shared/maps';
import type { AnyMapData, DropRoute, IndoorMapData, PlayerAnim, PlayerState } from '../shared/types';
import { CameraObstacles, CameraRig, slideAlongCeiling } from './cameraRig';
import { carrierPlacement } from './CarrierLayer';
import {
  computePose, CROUCH_HEAD_TILT_MAX, makePose, PRONE_HEAD_PITCH_DOWN, PRONE_HEAD_PITCH_UP, type Pose, type PoseInput,
} from './characterPose';
import { COVER_HEIGHT_STEP, INDOOR_FX } from './indoorFx';
import { buildCoverData, coverTopAt, floorMaterialAt, IndoorScene, placementMatrix, wallMatrix } from './IndoorScene';
import type { MapSceneFrame } from './mapScene';
import { MergeBucket } from './mergeBuilder';
import { CHUTE_COLLAPSE_S, CHUTE_DEPLOY_S, chuteDeployValue, dropPhaseOf, isAboard } from './PlayerViews';
import { createChibi, OUTLINE_NORMAL_ATTR } from './procedural';
import { QUALITY_PRESETS } from './quality';
import { cameraCaseOf } from './Renderer';

const office = (() => {
  const m = (MAPS as Record<string, AnyMapData>).office;
  if (!m || !isIndoor(m)) throw new Error('office level missing');
  return m;
})();

const anim = (o: Partial<PlayerAnim> = {}): PlayerAnim => ({
  moving: false, sprinting: false, airborne: false, dropping: false, inWater: false, firing: false, reloading: false,
  healing: false, ads: false, cooking: false, ...o,
});
const input = (o: Partial<PoseInput> = {}): PoseInput => ({
  time: 0, anim: anim(), weapon: 'rifle', pitch: 0, speed: 0, sprintSpeed: 7, velY: 0, walkPhase: 0, recoil: 0, hit: 0,
  deathTime: -1, seed: 0, ...o,
});
const camView = (o: Partial<CameraView> = {}): CameraView => ({
  mode: 'follow', target: { x: 0, y: 1, z: 0 }, yaw: 0, pitch: 0, distance: 4, shoulderOffset: 0, fovDeg: 70,
  firstPerson: false, view: 'chase', subjectId: null, roll: 0, ...o,
});
/** A pre-gate CameraView without `view` (cameraCaseOf derives the case). */
const legacyView = (o: Partial<CameraView>): CameraView => ({ ...camView(o), view: undefined }) as unknown as CameraView;

describe('camera cases', () => {
  it('uses CameraView.view, else derives it from mode / firstPerson', () => {
    expect(cameraCaseOf(camView({ view: 'carrier' }))).toBe('carrier');
    expect(cameraCaseOf(legacyView({ firstPerson: true }))).toBe('firstPerson');
    expect(cameraCaseOf(legacyView({}))).toBe('chase');
    expect(cameraCaseOf(legacyView({ mode: 'orbit' }))).toBe('title');
  });

  it('indoor limits keep the 3P camera under the ceiling and inside the floor', () => {
    const o = new CameraObstacles(() => 0, [], 150);
    o.setLimits(27, office.floor, 0.6);
    const rig = new CameraRig(o);
    // Carrier orbit 2 m under the ceiling, looking down: the boom slides along the ceiling instead of collapsing.
    const cam = camView({ view: 'carrier', target: { x: 0, y: 25, z: 0 }, pitch: -0.5, distance: 16 });
    const p = rig.update(cam, 1 / 60);
    expect(p.y).toBeLessThanOrEqual(26.4 + 1e-9);
    expect(Math.hypot(p.x, p.y - 25, p.z)).toBeGreaterThan(15);
    // Out past the outer wall: clamped back inside.
    const q = rig.update(camView({ target: { x: 116, y: 1, z: 0 }, yaw: Math.PI / 2, distance: 8 }), 1 / 60);
    expect(q.x).toBeLessThanOrEqual(office.floor.maxX - 0.6 + 1e-9);
  });

  it('slideAlongCeiling keeps the boom length', () => {
    const o = new CameraObstacles(() => 0, [], 50);
    o.setLimits(27, null, 0.6);
    const cam = camView({ target: { x: 0, y: 25, z: 0 } });
    const d = { x: 0, y: 30, z: 8 };
    const len = Math.hypot(8, 5);
    slideAlongCeiling(cam, d, o);
    expect(d.y).toBeCloseTo(26.4, 9);
    expect(Math.hypot(d.x, d.y - 25, d.z)).toBeCloseTo(len, 6);
  });
});

describe('carrier', () => {
  const route: DropRoute = {
    mapId: 'office', entry: { x: -100, z: 0 }, exit: { x: 100, z: 0 }, eject: { x: 90, z: 0 }, altitude: 25, speed: 10,
    startsAt: 1000, noJumpUntil: 2000, ejectAt: 19000, endsAt: 21000,
  };
  const out = { x: 0, y: 0, z: 0, yaw: 0 };

  it('flies the route at its altitude and heading, and is gone after endsAt', () => {
    expect(carrierPlacement(route, 11000, camView(), out)).toBe(true);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.y).toBe(25);
    // Heading +X: yaw convention forward = (-sin yaw, -cos yaw) -> yaw = -PI/2.
    expect(out.yaw).toBeCloseTo(-Math.PI / 2, 6);
    expect(carrierPlacement(route, 22000, camView(), out)).toBe(false);
  });

  it('without a route, the carrier camera case places it at the camera target', () => {
    expect(carrierPlacement(null, 0, camView({ view: 'carrier', target: { x: 5, y: 120, z: 6 } }), out)).toBe(true);
    expect([out.x, out.y, out.z]).toEqual([5, 120, 6]);
    expect(carrierPlacement(null, 0, camView({ view: 'chase' }), out)).toBe(false);
  });
});

describe('drop poses and the parachute', () => {
  const st = (o: Partial<PlayerState> & Record<string, unknown>): PlayerState => ({ anim: anim(), ...o }) as unknown as PlayerState;

  it('drop phase: null on foot, freefall pre-gate, the snapshot phase otherwise; aboard flag', () => {
    expect(dropPhaseOf(st({}))).toBeNull();
    expect(dropPhaseOf(st({ anim: anim({ dropping: true }) }))).toBe('freefall');
    expect(dropPhaseOf(st({ anim: anim({ dropping: true }), dropPhase: 'chute' }))).toBe('chute');
    expect(isAboard(st({ aboard: true }))).toBe(true);
    expect(isAboard(st({}))).toBe(false);
  });

  it('parachute deploy timeline: packed, pops open, collapses after landing, then hidden', () => {
    expect(chuteDeployValue('freefall', 0, -1)).toBe(0);
    expect(chuteDeployValue('chute', CHUTE_DEPLOY_S / 2, -1)).toBeCloseTo(0.5, 9);
    expect(chuteDeployValue('chute', 5, -1)).toBe(1);
    expect(chuteDeployValue(null, 5, CHUTE_COLLAPSE_S / 2)).toBeCloseTo(1.5, 9);
    expect(chuteDeployValue(null, 5, CHUTE_COLLAPSE_S + 0.01)).toBe(-1);
    expect(chuteDeployValue(null, 0, -1)).toBe(-1);
  });

  it('freefall: belly-down on the stance pivot, banks with steering, dives forward; hang: upright, arms up', () => {
    const ff = computePose(input({ anim: anim({ dropping: true }), dropPhase: 'freefall' }), makePose());
    expect(ff.stanceX).toBeCloseTo(-1.35, 6);
    expect(ff.rootTiltX).toBe(0);
    expect(ff.weaponVisible).toBe(false);
    const bank = computePose(input({ anim: anim({ dropping: true }), dropPhase: 'freefall', steerX: 1 }), makePose());
    expect(bank.stanceRotY).toBeGreaterThan(0.3);
    const dive = computePose(input({ anim: anim({ dropping: true }), dropPhase: 'freefall', steerZ: 1 }), makePose());
    expect(dive.stanceX).toBeLessThan(ff.stanceX - 0.3);
    const hang = computePose(input({ anim: anim({ dropping: true }), dropPhase: 'chute', chute: 1 }), makePose());
    expect(hang.stanceX).toBeCloseTo(0, 6);
    expect(hang.armLX).toBeGreaterThan(2.5);
    // Halfway through the deploy blend the pose is in between.
    const mid = computePose(input({ anim: anim({ dropping: true }), dropPhase: 'chute', chute: 0.5 }), makePose());
    expect(mid.stanceX).toBeLessThan(-0.3);
    expect(mid.stanceX).toBeGreaterThan(-1.1);
  });
});

/** Head mesh bounds of a chibi posed exactly like PlayerViews.applyPose. */
function headBox(p: Pose): THREE.Box3 {
  const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
  const m = c.parts;
  m.stance.rotation.set(p.stanceX, p.stanceRotY, 0);
  m.stance.position.set(0, p.stanceY, p.stanceZ);
  m.body.position.y += p.bodyY;
  m.body.rotation.set(p.bodyX, p.bodyY_rot, p.bodyZ);
  m.head.rotation.set(p.headX, p.headY, 0);
  c.root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(c.meshes.head, true);
}

describe('BUG-008 head fit (stance.md "Visual fit")', () => {
  const lim = { min: (-30 * Math.PI) / 180, max: (45 * Math.PI) / 180 };
  it('prone at aim pitch -30 / 0 / +45 deg: head top <= 0.70 m, head centre z <= -0.45', () => {
    for (const deg of [-30, 0, 45]) {
      const p = computePose(input({ crouch: 1, prone: 1, pitch: (deg * Math.PI) / 180, pronePitchMin: lim.min, pronePitchMax: lim.max }), makePose());
      const b = headBox(p);
      expect(b.max.y, `top at ${deg}`).toBeLessThanOrEqual(0.7);
      expect(b.getCenter(new THREE.Vector3()).z, `centre z at ${deg}`).toBeLessThanOrEqual(-0.45);
    }
    expect(PRONE_HEAD_PITCH_DOWN).toBeLessThanOrEqual(PRONE_HEAD_PITCH_UP);
  });

  it('crouch: the aim tilts the head at most CROUCH_HEAD_TILT_MAX; head top <= 1.05 m at pitch 0', () => {
    const base = computePose(input({ crouch: 1 }), makePose());
    const up = computePose(input({ crouch: 1, pitch: 1.2 }), makePose());
    expect(up.headX - base.headX).toBeLessThanOrEqual(CROUCH_HEAD_TILT_MAX + 1e-9);
    expect(headBox(base).max.y).toBeLessThanOrEqual(1.05);
  });
});

describe('indoor geometry helpers', () => {
  const zones: Pick<IndoorMapData, 'floorZones' | 'floorMaterial'> = {
    floorMaterial: 'wood',
    floorZones: [
      { minX: 0, maxX: 10, minZ: 0, maxZ: 10, material: 'carpet' },
      { minX: 5, maxX: 15, minZ: 0, maxZ: 10, material: 'tile' },
    ],
  };

  it('floor material: later zones win, else the floor material', () => {
    expect(floorMaterialAt(zones, 2, 2)).toBe('carpet');
    expect(floorMaterialAt(zones, 7, 2)).toBe('tile');
    expect(floorMaterialAt(zones, -5, 2)).toBe('wood');
  });

  it('placementMatrix = T * Ry * S (rotY convention: local +X -> (cos, -sin))', () => {
    const m = placementMatrix({ kind: 'desk', x: 3, y: 2, z: -1, rotY: Math.PI / 2, scale: 2 });
    const v = new THREE.Vector3(1, 1, 0).applyMatrix4(m);
    expect(v.x).toBeCloseTo(3, 9);
    expect(v.y).toBeCloseTo(4, 9);
    expect(v.z).toBeCloseTo(-3, 9);
  });

  it('wallMatrix puts the wall model on its wallFrame (ends, thickness, bottom/top)', () => {
    const w = { x1: 10, z1: 5, x2: 10, z2: 25, thickness: 1.8, bottom: 18.9, top: 27, material: 'solid' as const };
    const m = wallMatrix(w, 20);
    const a = new THREE.Vector3(-10, 0, 0).applyMatrix4(m);
    const b = new THREE.Vector3(10, 27, 0.45).applyMatrix4(m);
    expect(a.x).toBeCloseTo(10, 9);
    expect(a.z).toBeCloseTo(5, 9);
    expect(a.y).toBeCloseTo(18.9, 9);
    expect(b.z).toBeCloseTo(25, 9);
    expect(b.y).toBeCloseTo(27, 9);
    // Half of the 0.9 m model thickness scales to half of 1.8 m, across the wall.
    expect(Math.abs(b.x - wallFrame(w).cx)).toBeCloseTo(0.9, 9);
  });

  it('MergeBucket transforms positions, normals and hull normals and stores the hull width', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
    g.setAttribute(OUTLINE_NORMAL_ATTR, new THREE.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
    const b = new MergeBucket(true);
    b.add(g, new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(5, 0, 0), 0.045);
    const out = b.build('t')!;
    expect(out.getAttribute('position').getX(1)).toBeCloseTo(5, 6);
    expect(out.getAttribute('position').getZ(1)).toBeCloseTo(-1, 6);
    expect(out.getAttribute(OUTLINE_NORMAL_ATTR).getZ(0)).toBeCloseTo(-1, 6);
    expect(out.getAttribute('outlineWidth').getX(2)).toBeCloseTo(0.045, 6);
    expect(new MergeBucket().build('empty')).toBeNull();
  });
});

describe('office scene (real level)', () => {
  it('cover data: under a desk is covered at the desk underside; the desk top is walkable', () => {
    const c = buildCoverData(office);
    const desk = office.props.find((p) => p.kind === 'desk')!;
    const i = Math.floor((desk.x - c.rect.minX) / c.cell), j = Math.floor((desk.z - c.rect.minZ) / c.cell);
    const k = (j * c.width + i) * 4;
    expect(c.data[k]).toBe(255);
    expect(c.data[k + 1] * COVER_HEIGHT_STEP).toBeCloseTo(6.39, 1);
    expect(coverTopAt(c, desk.x, desk.z)).toBeGreaterThanOrEqual(6.6); // the desk top, or a monitor / clutter on it
    // The middle of the main aisle is open floor.
    expect(coverTopAt(c, -80, 0)).toBe(0);
  });

  it('builds within the draw budget, retracts ceiling props near the drone (T13) and disposes everything', () => {
    const splashes: number[] = [];
    const s = new IndoorScene(office, QUALITY_PRESETS.medium, { zoneTheme: 'sprinklers', preset: 'medium', splash: (x) => splashes.push(x) });
    let meshes = 0;
    s.group.traverse((o) => { if ((o as THREE.Mesh).isMesh || (o as THREE.Line).isLine) meshes++; });
    // Static world: chunks x 2 + walls 2 + glass/frost/glow 3 + ceiling/ducts 3 + ceiling instanced sets + rain 3.
    expect(meshes).toBeLessThanOrEqual(70);
    expect(s.stats.ceilingInstances).toBeGreaterThan(50);
    expect(INDOOR_FX.uCoverOn.value).toBe(1);

    const panel = office.props.find((p) => p.kind === 'lightPanel')!;
    const im = s.group.getObjectByName('office:lightPanel:body') as THREE.InstancedMesh;
    const idx = office.props.filter((p) => p.kind === 'lightPanel').indexOf(panel);
    const y0 = (() => { const m = new THREE.Matrix4(); im.getMatrixAt(idx, m); return m.elements[13]; })();
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(panel.x, 3, panel.z + 40);
    const frame: MapSceneFrame = {
      time: 0, dt: 1 / 30, serverTime: 0, camera: cam, view: camView(), frustum: new THREE.Frustum(),
      quality: QUALITY_PRESETS.medium, lod: 1, zone: null, firstPerson: false, carrier: new THREE.Vector3(panel.x, 25, panel.z),
    };
    for (let i = 0; i < 60; i++) s.update(frame);
    const m = new THREE.Matrix4();
    im.getMatrixAt(idx, m);
    expect(m.elements[13] - y0).toBeGreaterThan(4); // lowest point lifted to ceiling - 1 m (above the drone top)
    frame.carrier = null;
    for (let i = 0; i < 60; i++) s.update(frame);
    im.getMatrixAt(idx, m);
    expect(m.elements[13]).toBeCloseTo(y0, 3);

    let disposed = 0;
    const geos = new Set<THREE.BufferGeometry>();
    s.group.traverse((o) => { const g = (o as THREE.Mesh).geometry; if (g && (o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) geos.add(g); });
    for (const g of geos) g.addEventListener('dispose', () => disposed++);
    s.dispose();
    expect(disposed).toBe(geos.size);
    expect(s.group.children.length).toBe(0);
    expect(INDOOR_FX.uCoverOn.value).toBe(0);
    void BALANCE;
  });
});
