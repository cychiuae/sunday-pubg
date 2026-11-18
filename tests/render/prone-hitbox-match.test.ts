/**
 * M2a QA cross-check (2a-D1 "hitbox mismatches with prone visuals"): the settled prone chibi, posed with
 * CHIBI_STANCES.prone exactly as STYLE.md §16 / PlayerViews do, must sit inside the sim's prone hitbox (ADR 0004 §2):
 * a level box centred on the feet, proneLength along the yaw (head toward -Z at yaw 0), proneWidth across,
 * stances.prone.height tall, with the head zone the front proneHeadLength metres.
 *
 * Render code is imported read-only; nothing here runs in the sim.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/shared/balance';
import { CHIBI_STANCES, createChibi } from '../../src/render/procedural/chibi';

const hb = BALANCE.combat.hitbox;
const half = { x: hb.proneWidth / 2, z: hb.proneLength / 2, y: BALANCE.movement.stances.prone.height };
const TOL = 0.12; // cartoon silhouettes (hair tufts, outlines) may poke out a little

function posedProne() {
  const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
  const k = CHIBI_STANCES.prone;
  c.parts.stance.rotation.x = k.pitch;
  c.parts.stance.position.set(0, k.lift, k.back);
  c.parts.body.rotation.x = k.chestUp;
  c.parts.head.rotation.x = k.headUp;
  c.parts.legL.rotation.x = k.legLift;
  c.parts.legR.rotation.x = k.legLift;
  c.parts.legL.rotation.z = -k.legSplay;
  c.parts.legR.rotation.z = k.legSplay;
  c.root.updateMatrixWorld(true);
  return c;
}

/** Precise bounds (vertex-level, not the transformed AABB of the geometry's box), so rotated parts are not inflated. */
const boxOf = (o: THREE.Object3D): THREE.Box3 => new THREE.Box3().setFromObject(o, true);

describe('prone chibi vs the sim prone hitbox', () => {
  it('scale check: the standing chibi is about the standing hitbox height (so the comparison below is 1:1)', () => {
    const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
    c.root.updateMatrixWorld(true);
    const b = boxOf(c.root);
    console.info('[prone-hitbox] standing chibi y %s..%s (stand hitbox %s)', b.min.y.toFixed(2), b.max.y.toFixed(2), BALANCE.movement.stances.stand.height);
    expect(b.max.y).toBeGreaterThan(BALANCE.movement.stances.stand.height - 0.2);
    expect(b.max.y).toBeLessThan(BALANCE.movement.stances.stand.height + 0.2);
  });

  it('BUG-008 (fixed): torso, head and legs lie inside the box (x, y, z) within a small tolerance', () => {
    const c = posedProne();
    const parts = { torso: c.meshes.torso, head: c.meshes.head, legL: c.meshes.legL, legR: c.meshes.legR };
    const report: Record<string, string> = {};
    for (const [name, mesh] of Object.entries(parts)) {
      const b = boxOf(mesh);
      report[name] = `x ${b.min.x.toFixed(2)}..${b.max.x.toFixed(2)} y ${b.min.y.toFixed(2)}..${b.max.y.toFixed(2)} z ${b.min.z.toFixed(2)}..${b.max.z.toFixed(2)}`;
    }
    console.info('[prone-hitbox] sim box x +-%s z +-%s y 0..%s; visual %s', half.x, half.z, half.y, JSON.stringify(report));
    for (const [name, mesh] of Object.entries(parts)) {
      const b = boxOf(mesh);
      expect(b.min.z, `${name} min z`).toBeGreaterThanOrEqual(-half.z - TOL);
      expect(b.max.z, `${name} max z`).toBeLessThanOrEqual(half.z + TOL);
      expect(b.min.x, `${name} min x`).toBeGreaterThanOrEqual(-half.x - TOL);
      expect(b.max.x, `${name} max x`).toBeLessThanOrEqual(half.x + TOL);
      expect(b.min.y, `${name} min y`).toBeGreaterThanOrEqual(-TOL);
      expect(b.max.y, `${name} max y`).toBeLessThanOrEqual(half.y + TOL);
    }
  });

  it('the head mesh centre is in the head zone (front proneHeadLength m), the torso centre is not', () => {
    const c = posedProne();
    const head = boxOf(c.meshes.head).getCenter(new THREE.Vector3());
    const torso = boxOf(c.meshes.torso).getCenter(new THREE.Vector3());
    const headZoneBack = -half.z + hb.proneHeadLength; // -0.25 at the shipped numbers
    expect(head.z).toBeLessThanOrEqual(headZoneBack + 0.05);
    expect(head.z).toBeGreaterThanOrEqual(-half.z - TOL);
    expect(torso.z).toBeGreaterThan(headZoneBack - 0.05);
  });
});

describe('crouched chibi vs the sim crouch cylinder', () => {
  it('BUG-008 (fixed): the crouched head top is under stances.crouch.height (+ tolerance)', () => {
    const c = createChibi({ skin: 0, outfit: 0, hair: 0 });
    const k = CHIBI_STANCES.crouch;
    c.parts.stance.position.y = -k.drop;
    c.parts.legL.rotation.x = k.legSwing;
    c.parts.legR.rotation.x = -k.legSwing;
    c.parts.body.rotation.x = k.bodyLean;
    c.parts.head.rotation.x = k.headComp;
    c.root.updateMatrixWorld(true);
    const top = boxOf(c.meshes.head).max.y;
    console.info('[crouch-hitbox] crouched head top %s m vs crouch hitbox height %s m', top.toFixed(2), BALANCE.movement.stances.crouch.height);
    expect(top).toBeLessThanOrEqual(BALANCE.movement.stances.crouch.height + TOL);
  });
});
