/** First-person viewmodel art: poses, sight alignment, rig, budgets. Owner: graphics-designer. */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyViewmodelPose, createViewmodel, VIEWMODEL_ITEM_IDS, VIEWMODEL_POSES, viewmodelArmColors } from './index';

const GUNS = ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'] as const;

describe('viewmodel', () => {
  it('has a pose for every held item, and the rig exposes the named bones', () => {
    for (const id of VIEWMODEL_ITEM_IDS) expect(VIEWMODEL_POSES[id]).toBeTruthy();
    const rig = createViewmodel({ skin: 0, outfit: 0 });
    for (const n of ['itemSocket', 'handR', 'handL', 'fingersR', 'fingersL']) expect(rig.root.getObjectByName(n)).toBeTruthy();
  });
  for (const id of GUNS) {
    it(`${id}: ADS puts the sight anchor on the eye, looking down -Z`, () => {
      const rig = createViewmodel({ skin: 1, outfit: 3 });
      applyViewmodelPose(rig, id, 1);
      rig.root.updateMatrixWorld(true);
      const sight = rig.itemSocket.getObjectByName('sight')!;
      const p = sight.getWorldPosition(new THREE.Vector3());
      expect(p.length()).toBeLessThan(1e-6);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sight.getWorldQuaternion(new THREE.Quaternion()));
      expect(fwd.z).toBeCloseTo(-1, 6);
      // hip: the gun sits in the lower right, in front of the camera
      applyViewmodelPose(rig, id, 0);
      expect(rig.itemSocket.position.x).toBeGreaterThan(0);
      expect(rig.itemSocket.position.y).toBeLessThan(0);
      expect(rig.itemSocket.position.z).toBeLessThan(-0.3);
      expect(rig.handR.visible && rig.handL.visible).toBe(true);
    });
  }
  it('grenade cooking frees the left hand; fists have no item', () => {
    const rig = createViewmodel({ skin: 0, outfit: 0 });
    applyViewmodelPose(rig, 'grenade_cooking', 0);
    expect(rig.handL.visible).toBe(false);
    applyViewmodelPose(rig, 'fists', 0);
    expect(rig.itemSocket.children.length).toBe(0);
  });
  it('arms are low-poly and coloured from the appearance', () => {
    const rig = createViewmodel({ skin: 2, outfit: 3 }); // wetsuit: long sleeves
    let tris = 0;
    rig.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.name !== 'outline') tris += m.geometry.getAttribute('position').count / 3;
    });
    expect(tris).toBeLessThanOrEqual(500);
    const c = viewmodelArmColors({ skin: 2, outfit: 3 });
    expect(c.sleeve).not.toBe(c.skin);
    expect(viewmodelArmColors({ skin: 2, outfit: 0 }).sleeve).toBe(c.skin); // tank top: bare forearm
  });
});

describe('viewmodel framing at the balance FOV', () => {
  it('VIEWMODEL_FOV matches clientFeel.viewmodelFovDeg; hip poses keep their authored 50 deg framing', async () => {
    const { BALANCE } = await import('../../shared/balance');
    const { VIEWMODEL_FOV, VIEWMODEL_AUTHORED_FOV, VIEWMODEL_FOV_DEPTH } = await import('./viewmodel');
    expect(VIEWMODEL_FOV).toBe((BALANCE.clientFeel as unknown as Record<string, number>).viewmodelFovDeg);
    const project = (p: readonly number[], fov: number) => {
      const t = Math.tan((fov * Math.PI) / 360);
      return [p[0] / (-p[2] * t), p[1] / (-p[2] * t)];
    };
    // rifle hip socket, as authored at 50 deg, lands on the same NDC point at 55 deg
    const authored = [0.18, -0.2, -0.47];
    const shipped = VIEWMODEL_POSES.rifle.hip.pos;
    expect(shipped[2]).toBeCloseTo(authored[2] * VIEWMODEL_FOV_DEPTH, 9);
    const a = project(authored, VIEWMODEL_AUTHORED_FOV), b = project(shipped, VIEWMODEL_FOV);
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
  });
});
