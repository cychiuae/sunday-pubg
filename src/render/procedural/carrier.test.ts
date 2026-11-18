/** M2b plane drop art: carriers, parachute, freefall helpers. Owner: graphics-designer. */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createDeliveryDrone, createParachute, createSeaplane, DRONE_DIMENSIONS, freefallStanceOffset, OFFICE_WALL_HEIGHT,
  setParachuteDeploy, CHIBI_DIMENSIONS, CHIBI_FREEFALL,
} from './index';

const colourTris = (o: THREE.Object3D) => {
  let n = 0;
  o.traverse((m) => {
    const mesh = m as THREE.Mesh;
    if (mesh.isMesh && mesh.name !== 'outline' && mesh.name !== 'blur') n += mesh.geometry.getAttribute('position').count / 3;
  });
  return n;
};
const bounds = (o: THREE.Object3D) => {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3();
  o.traverse((m) => { const mesh = m as THREE.Mesh; if (mesh.isMesh && mesh.name !== 'blur') b.expandByObject(mesh); });
  return b;
};

describe('carriers', () => {
  it('seaplane: named spinners + door + jump point, readable size, within budget', () => {
    const p = createSeaplane();
    for (const n of ['body', 'propellerL', 'propellerR', 'door', 'jumpPoint']) expect(p.getObjectByName(n)).toBeTruthy();
    expect(p.getObjectByName('propellerL')!.getObjectByName('blur')!.visible).toBe(false);
    const b = bounds(p);
    expect(b.max.x - b.min.x).toBeGreaterThan(20);
    expect(b.max.z - b.min.z).toBeGreaterThan(14);
    expect(colourTris(p)).toBeLessThanOrEqual(1400);
    expect(p.getObjectByName('jumpPoint')!.position.x).toBeLessThan(b.min.x + 20); // door side (-X)
  });
  it('drone: 4 rotors, fits under the office ceiling at 25 m, within budget', () => {
    const d = createDeliveryDrone();
    for (let i = 0; i < 4; i++) expect(d.getObjectByName(`rotor${i}`)).toBeTruthy();
    const b = bounds(d);
    expect(25 + b.max.y).toBeLessThan(OFFICE_WALL_HEIGHT);
    expect(b.min.y).toBeGreaterThanOrEqual(DRONE_DIMENSIONS.bottomY - 0.05);
    expect(colourTris(d)).toBeLessThanOrEqual(900);
  });
});

describe('parachute', () => {
  it('packed shows only the pack; open shows canopy + lines; collapse hides at 2', () => {
    const c = createParachute({ stripe: 3, deploy: 0 });
    const vis = (n: string) => c.getObjectByName(n)!.visible;
    expect([vis('pack'), vis('canopy'), vis('lines')]).toEqual([true, false, false]);
    setParachuteDeploy(c, 1);
    expect([vis('pack'), vis('canopy'), vis('lines')]).toEqual([false, true, true]);
    expect(c.getObjectByName('canopy')!.scale.x).toBeCloseTo(1, 5);
    setParachuteDeploy(c, 2);
    expect(vis('canopy')).toBe(false);
    expect(colourTris(createParachute())).toBeLessThanOrEqual(400);
  });
  it('lines end at the shoulders and the canopy is overhead', () => {
    const c = createParachute();
    const b = bounds(c.getObjectByName('lines')!);
    expect(b.min.y).toBeLessThan(CHIBI_DIMENSIONS.shoulderY + 0.2);
    expect(bounds(c.getObjectByName('canopy')!).min.y).toBeGreaterThan(3.5);
  });
  it('freefall stance offset rotates about the hips', () => {
    const [, y, z] = freefallStanceOffset(CHIBI_FREEFALL.freefall.pitch);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(CHIBI_FREEFALL.freefall.pitch, 0, 0)), new THREE.Vector3(1, 1, 1));
    const hip = new THREE.Vector3(0, CHIBI_DIMENSIONS.hipY, 0).applyMatrix4(m);
    expect(hip.distanceTo(new THREE.Vector3(0, CHIBI_DIMENSIONS.hipY, 0))).toBeLessThan(1e-6);
  });
});
