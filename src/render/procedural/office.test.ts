/** M2b office prop kit: budgets, instanceability, collider data. Owner: graphics-designer. */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BALANCE, balanceForMap } from '../../shared/balance';
import {
  OFFICE_KIT, OFFICE_KIT_KINDS, OFFICE_PING_PONG_NET_WALL, isOfficeKitKind,
} from '../../shared/kits/office';
import type { PropKit } from '../../shared/types';
import {
  createOfficeProp, createOfficeWall, getOfficePropBounds, getOfficePropInfo, getOfficePropModelOrigin, getOfficePropParts,
  OFFICE_DESK_TOP_Y, OFFICE_PROP_KINDS, OFFICE_WALL_HEIGHT, type OfficeCollider,
} from './index';

const tris = (g: THREE.BufferGeometry) => g.getAttribute('position').count / 3;
const top = (c: OfficeCollider) => (c.type === 'cylinder' ? c.y1 : c.max[1]);

describe('office props', () => {
  for (const kind of OFFICE_PROP_KINDS) {
    it(`${kind}: within budget, identity part matrices, colliders inside the model bounds`, () => {
      const parts = getOfficePropParts(kind);
      const info = getOfficePropInfo(kind);
      expect(parts[0].name).toBe('body');
      expect(tris(parts[0].geometry)).toBeLessThanOrEqual(info.budget);
      for (const p of parts) expect(p.matrix.equals(new THREE.Matrix4())).toBe(true);
      const b = getOfficePropBounds(kind).expandByScalar(0.6);
      for (const c of info.colliders) {
        if (c.type === 'cylinder') {
          expect(b.containsPoint(new THREE.Vector3(c.x, c.y1, c.z))).toBe(true);
        } else {
          expect(b.containsPoint(new THREE.Vector3(...c.min))).toBe(true);
          expect(b.containsPoint(new THREE.Vector3(...c.max))).toBe(true);
        }
      }
      expect(createOfficeProp(kind).children.length).toBe(parts.length);
    });
  }
  it('desk tops sit at OFFICE_DESK_TOP_Y (6.66 m) with a walk-under gap', () => {
    for (const k of ['desk', 'deskWood'] as const) {
      const cols = getOfficePropInfo(k).colliders;
      expect(top(cols.find((c) => c.name === 'top')!)).toBeCloseTo(OFFICE_DESK_TOP_Y, 5);
      const beam = cols.find((c) => c.name === 'beam')!;
      expect(beam.type === 'box' && beam.min[1]).toBeGreaterThan(5);
    }
  });
  it('climb routes: book stair steps rise <= 0.95 m (jump cap) and the desk top is a walk-up from the last; ramps reach their targets', () => {
    const steps = getOfficePropInfo('bookStairs').colliders.map(top);
    let prev = 0;
    for (const h of steps) {
      expect(h - prev).toBeLessThanOrEqual(0.95 + 1e-9);
      prev = h;
    }
    expect(prev).toBeCloseTo(6.615, 6);
    expect(OFFICE_DESK_TOP_Y - prev).toBeGreaterThan(0);
    expect(OFFICE_DESK_TOP_Y - prev).toBeLessThanOrEqual(0.35); // movement.stepHeight
    expect(top(getOfficePropInfo('whiteboardRamp').colliders[0])).toBeCloseTo(OFFICE_DESK_TOP_Y, 5);
    expect(top(getOfficePropInfo('keyboardRamp').colliders[0])).toBeCloseTo(top(getOfficePropInfo('bookStack').colliders[0]), 5);
    expect(top(getOfficePropInfo('boxSmall').colliders[0])).toBeLessThanOrEqual(1.0);
  });
  it('glass kinds carry glass + frost parts; light panels glow', () => {
    for (const k of ['wallGlass', 'phoneBooth'] as const) {
      const names = getOfficePropParts(k).map((p) => p.name);
      expect(names).toContain('glass');
      expect(names).toContain('frost');
    }
    expect(getOfficePropParts('lightPanel').map((p) => p.name)).toContain('glow');
  });
  it('wall runs of any length are full height and cached', () => {
    const w = createOfficeWall('glass', 47.3);
    const box = new THREE.Box3().setFromObject(w);
    expect(box.max.x - box.min.x).toBeCloseTo(47.3, 0);
    expect(box.max.y).toBeCloseTo(OFFICE_WALL_HEIGHT, 3);
    expect((createOfficeWall('glass', 47.3).children[0] as THREE.Mesh).geometry).toBe((w.children[0] as THREE.Mesh).geometry);
  });
});

/** Sizes in the kit are the drawn bounds rounded to the cm. */
const SIZE_TOL = 0.02;

describe('office kit (src/shared/kits/office.ts, ARCHITECTURE §15.6)', () => {
  it('is pure data: no three.js, DOM or render import', () => {
    const src = readFileSync(new URL('../../shared/kits/office.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../types']);
    expect(src).not.toMatch(/\bTHREE\b|document\.|window\./);
  });
  it('covers every render kind and nothing else; satisfies PropKit', () => {
    const kit: PropKit = OFFICE_KIT;
    expect(Object.keys(kit).sort()).toEqual([...OFFICE_PROP_KINDS].sort());
    expect(OFFICE_KIT_KINDS).toBe(OFFICE_PROP_KINDS);
    expect(isOfficeKitKind('desk')).toBe(true);
    expect(isOfficeKitKind('palmTree')).toBe(false);
    expect(isOfficeKitKind('toString')).toBe(false);
  });
  for (const kind of OFFICE_KIT_KINDS) {
    it(`${kind}: kit size = drawn bounds (±${SIZE_TOL} m), origin = model origin, info = kit + budget/notes`, () => {
      const entry = OFFICE_KIT[kind];
      const b = getOfficePropBounds(kind);
      const drawn = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
      for (let i = 0; i < 3; i++) expect(Math.abs(entry.size[i] - drawn[i])).toBeLessThanOrEqual(SIZE_TOL);
      expect(getOfficePropModelOrigin(kind)).toBe(entry.origin);
      const info = getOfficePropInfo(kind);
      expect(info.colliders).toBe(entry.colliders);
      expect(info.size).toBe(entry.size);
      expect(info.origin).toBe(entry.origin);
      expect(info.budget).toBeGreaterThan(0);
      for (const c of entry.colliders) {
        if (c.type === 'cylinder') {
          expect(c.r).toBeGreaterThan(0);
          expect(c.y1).toBeGreaterThan(c.y0);
        } else {
          for (let i = 0; i < 3; i++) expect(c.max[i]).toBeGreaterThan(c.min[i]);
        }
      }
      const names = entry.colliders.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      if (entry.origin === 'ceiling') expect(entry.colliders).toHaveLength(0);
    });
  }
  it('glass parts are marked: wallGlass and the phone booth door; solid parts are not', () => {
    const glassNames = (k: keyof typeof OFFICE_KIT) =>
      OFFICE_KIT[k].colliders.filter((c) => c.type === 'box' && c.glass).map((c) => c.name);
    expect(glassNames('wallGlass')).toEqual(['wall']);
    expect(glassNames('phoneBooth')).toEqual(['door']);
    expect(glassNames('wallSolid')).toEqual([]);
    for (const k of OFFICE_KIT_KINDS) {
      if (k === 'wallGlass' || k === 'phoneBooth') continue;
      expect(glassNames(k)).toEqual([]);
    }
    // the booth is still closed: pod + door cover the full footprint
    const [pod, door] = OFFICE_KIT.phoneBooth.colliders;
    expect(pod.type === 'box' && door.type === 'box' && door.max[2]).toBeCloseTo(pod.type === 'box' ? pod.min[2] : NaN, 6);
  });
  it('the ping-pong net collider is a 1.6 m wall over the top (model stays 1.35 m)', () => {
    const cols = OFFICE_KIT.pingPongTable.colliders;
    const top = cols.find((c) => c.name === 'top')!;
    const net = cols.find((c) => c.name === 'net')!;
    if (top.type !== 'box' || net.type !== 'box') throw new Error('box colliders expected');
    expect(net.min[1]).toBeCloseTo(top.max[1], 6);
    expect(net.max[1] - top.max[1]).toBeCloseTo(1.6, 6);
    expect(OFFICE_PING_PONG_NET_WALL).toBe(1.6);
    expect(net.max[1] - top.max[1]).toBeGreaterThan(0.95); // over the maps.md jump cap
    expect(net.max[2] - net.min[2]).toBeGreaterThanOrEqual(0.15); // thick enough to never tunnel
    // spans the table width so neither half can walk around it on the top
    expect(net.min[0]).toBeLessThanOrEqual(top.min[0]);
    expect(net.max[0]).toBeGreaterThanOrEqual(top.max[0]);
    // the model is unchanged: a 1.35 m net plus its 0.09 m top tape, below the collider
    const b = getOfficePropBounds('pingPongTable');
    expect(b.max.y - top.max[1]).toBeGreaterThan(1.3);
    expect(b.max.y - top.max[1]).toBeLessThan(1.5);
  });
  it('ramps compile to legal stairs (ADR 0005 §3: rises <= 0.8 x stepHeight) for the island and office balance', () => {
    const stepHeights = new Set([BALANCE.movement.stepHeight, balanceForMap(BALANCE, 'office').movement.stepHeight]);
    const ramps = OFFICE_KIT_KINDS.flatMap((k) => OFFICE_KIT[k].colliders.filter((c) => c.type === 'ramp').map((c) => ({ k, c })));
    expect(ramps.map((r) => r.k).sort()).toEqual(['keyboardRamp', 'whiteboardRamp']);
    for (const stepHeight of stepHeights) {
      const maxRise = 0.8 * stepHeight;
      for (const { c } of ramps) {
        if (c.type !== 'ramp') continue;
        expect(c.min[1]).toBe(0); // starts on the floor / its support
        const n = Math.ceil((c.max[1] - c.min[1]) / maxRise);
        const rise = (c.max[1] - c.min[1]) / n;
        const tread = (c.max[2] - c.min[2]) / n;
        expect(rise).toBeLessThanOrEqual(maxRise + 1e-9);
        expect(rise).toBeLessThanOrEqual(stepHeight);
        expect(tread).toBeGreaterThanOrEqual(0.5);
        expect(c.max[0] - c.min[0]).toBeGreaterThan(2 * BALANCE.player.radius); // a player fits across
      }
    }
    const rampTop = (k: 'keyboardRamp' | 'whiteboardRamp') => {
      const c = OFFICE_KIT[k].colliders[0];
      return c.type === 'ramp' ? c.max[1] : NaN;
    };
    expect(rampTop('whiteboardRamp')).toBeCloseTo(OFFICE_DESK_TOP_Y, 6);
    const stack = OFFICE_KIT.bookStack.colliders[0];
    expect(rampTop('keyboardRamp')).toBeCloseTo(stack.type === 'box' ? stack.max[1] : NaN, 6);
  });
});
