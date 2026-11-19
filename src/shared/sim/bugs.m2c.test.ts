/**
 * QA bugs fixed in M2c: BUG-011 (thin raised kit parts never support feet) and BUG-012 (prone pitch clamp on the
 * transition's first tick); glass movement through a broken pane.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import { DEG2RAD } from '../math';
import type { PropKit } from '../types';
import { OFFICE } from '../../game/levels/office';
import { layoutSeedFor } from '../layout';
import { glassPanes } from '../maps';
import { buildColliders, platformHeightAt, withBrokenPanes } from './colliders';
import { layoutOffice } from './tools/navStuck';
import { createMovementContext, initialMovementState, stepMovement, toMovementInput, withBrokenGlass } from './movement';
import { input, land, playingWorld, roomMap, run, TEST_KIT } from './testkit';

const KIT: PropKit = {
  ...TEST_KIT,
  monitor: {
    origin: 'surface',
    size: [5, 4.4, 0.4],
    colliders: [{ type: 'box', name: 'screen', min: [-2.5, 1.4, -0.18], max: [2.5, 4.4, 0.18] }],
  },
};

describe('BUG-011: monitor screens are canopies, not platforms', () => {
  it('a thin raised kit box blocks but never supports; a desk top still does', () => {
    const map = roomMap([{ kind: 'monitor', x: 0, y: 0, z: 0, rotY: 0, scale: 1 }, { kind: 'desk', x: 20, y: 0, z: 0, rotY: 0, scale: 1 }], [], { kit: KIT });
    const set = buildColliders(map, BALANCE.movement.stepHeight, BALANCE.player.radius / 2);
    expect(set.colliders.find((c) => c.prop === 0)!.noStand).toBe(true);
    expect(platformHeightAt(set, 0, 0, 4.4, BALANCE.movement.stepHeight)).toBe(-Infinity);
    expect(platformHeightAt(set, 20, 0, 6.66, BALANCE.movement.stepHeight)).toBeCloseTo(6.66, 9);
    // A player dropped onto the screen top falls past it.
    const ctx = createMovementContext(map, BALANCE);
    let m = initialMovementState({ x: 0, y: 4.45, z: 0 }, false);
    m = { ...m, grounded: false };
    for (let i = 0; i < 30; i++) {
      m = stepMovement(m, toMovementInput(input(), { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, BALANCE), SIM_DT, ctx).state;
    }
    expect(m.pos.y).toBeLessThan(4.4);
  });
});

describe('BUG-012: prone pitch clamp on the first tick of the transition', () => {
  it('entering prone at +70 deg ends at the prone max on the toggle tick', () => {
    const { w, ids } = playingWorld(2);
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 30, 30);
    const p = w.debugPlayer(s)!;
    const up = 70 * DEG2RAD;
    run(w, 3, { [s]: () => ({ pitch: up }) });
    run(w, 1, { [s]: () => ({ pitch: up, stanceToggle: 'prone' }) });
    expect(p.move.stance).toBe('prone');
    expect(p.pitch).toBeCloseTo(BALANCE.movement.stances.pronePitchMaxDeg! * DEG2RAD, 9);
    expect(w.snapshotFor(t).players.find((x) => x.id === s)!.pitch).toBeCloseTo(p.pitch, 9);
  });
});

describe('glass: movement through a broken pane (ADR 0007 §7)', () => {
  it('an intact pane stops a walker; with the pane in the broken set the walker passes (client: withBrokenGlass)', () => {
    const map = roomMap([{ kind: 'pane', x: 0, y: 0, z: -3, rotY: 0, scale: 1 }]);
    const ctx = createMovementContext(map, BALANCE);
    const walk = (c: typeof ctx): number => {
      let m = initialMovementState({ x: 0, y: 0, z: 0 }, false);
      for (let i = 0; i < 60; i++) {
        m = stepMovement(m, toMovementInput(input({ moveForward: 1 }), { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, BALANCE), SIM_DT, c).state;
      }
      return m.pos.z;
    };
    expect(walk(ctx)).toBeGreaterThan(-3);
    expect(walk(withBrokenGlass(ctx, new Set([0])))).toBeLessThan(-5);
    expect(withBrokenPanes(ctx.colliders, new Set([0])).colliders).toBe(ctx.colliders.colliders);
  });
});

describe('SF1: collider pane ids come from glassPanes (one numbering)', () => {
  it('every pane of the office and of 12 office layouts maps to exactly its own glass colliders', () => {
    const seeds = [0, ...Array.from({ length: 12 }, (_, i) => layoutSeedFor(100 + i, 0))];
    for (const seed of seeds) {
      const map = layoutOffice(OFFICE, seed);
      const panes = glassPanes(map);
      const set = buildColliders(map, BALANCE.movement.stepHeight, BALANCE.player.radius / 2);
      const glass = set.colliders.filter((c) => c.glass === true);
      expect(glass.every((c) => c.pane !== undefined)).toBe(true);
      for (const p of panes) {
        const cs = glass.filter((c) => c.pane === p.id);
        expect(cs.length).toBeGreaterThan(0);
        if ('wall' in p) expect(cs.every((c) => c.prop === -1)).toBe(true);
        else expect(cs.every((c) => c.prop === p.prop)).toBe(true);
      }
      expect(new Set(glass.map((c) => c.pane)).size).toBe(panes.length);
    }
  }, 60_000);
});
