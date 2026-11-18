/**
 * M2b indoor sim (ADR 0005 §2-3, maps.md §2 and acceptance 11-16, 17b) on small synthetic IndoorMapData fixtures
 * (testkit roomMap / TEST_KIT; the real office level is tested by the level-designer). Also mapVote (maps.md 1-4),
 * pitchLimits and the arc preview's out buffer.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE, balanceForMap } from '../balance';
import { SIM_DT } from '../constants';
import { wallFrame } from '../maps';
import { createRng, DEG2RAD } from '../math';
import type { IndoorPropPlacement, SimEvent, Vec3 } from '../types';
import { buildColliders, lineOfSight, platformHeightAt, raycastStatic, RAMP_STEP_FRACTION, type BoxCollider } from './colliders';
import { lootSpawnsInsideColliders } from './loot';
import { resolveMapChoice } from './mapVote';
import { createMovementContext, groundHeightAt, initialMovementState, prepareMap, stepMovement, type MovementContext } from './movement';
import { predictGrenadeArc, stepGrenade, type GrenadeBody } from './grenade';
import { pitchLimits } from './stance';
import { heightAt, raycastTerrain, surfaceAt } from './terrain';
import { balanceWith, flatMap, input, land, noSpreadBalance, playingWorld, roomMap, run, wall } from './testkit';
import { toMovementInput } from './movement';
import { createZone, updateZone } from './zone';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const OFFICE = balanceForMap(BALANCE, 'office');
const STEP = BALANCE.movement.stepHeight;
const prop = (kind: string, x: number, z: number, rotY = 0, y = 0, scale = 1): IndoorPropPlacement => ({ kind, x, y, z, rotY, scale });
const mvIn = (o: Parameters<typeof input>[0] = {}) =>
  toMovementInput(input(o), { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, BALANCE);

describe('terrain dispatch (ADR 0005 §2)', () => {
  const map = roomMap();
  it('heightAt = 0, surfaceAt = floor zones (later wins) else floorMaterial', () => {
    expect(heightAt(5, 5, map)).toBe(0);
    expect(surfaceAt(0, 0, map)).toBe('wood');
    expect(surfaceAt(30, 0, map)).toBe('carpet');
    const two = roomMap([], [], { floorZones: [{ minX: -10, minZ: -10, maxX: 10, maxZ: 10, material: 'carpet' }, { minX: 0, minZ: 0, maxX: 10, maxZ: 10, material: 'tile' }] });
    expect(surfaceAt(5, 5, two)).toBe('tile');
    expect(surfaceAt(-5, -5, two)).toBe('carpet');
  });
  it('raycastTerrain hits the floor going down and the ceiling going up', () => {
    expect(raycastTerrain(0, 10, 0, 0, -1, 0, 100, map)).toBeCloseTo(10, 9);
    expect(raycastTerrain(0, 10, 0, 0, 1, 0, 100, map)).toBeCloseTo(20, 9);
    expect(raycastTerrain(0, 10, 0, 1, 0, 0, 100, map)).toBe(-1);
    expect(raycastTerrain(0, 10, 0, 0, 1, 0, 5, map)).toBe(-1);
  });
});

describe('indoor colliders (ADR 0005 §2, office kit rules)', () => {
  it('walls go through wallFrame; glass walls are glass; raycastStatic reports glass', () => {
    const g = wall(-10, 10, 10, 10, true);
    const map = roomMap([], [g, wall(-10, -10, 10, -20)]);
    const set = buildColliders(map, STEP);
    const gc = set.colliders.find((c) => c.glass) as BoxCollider;
    const f = wallFrame(g);
    expect(gc).toMatchObject({ shape: 'box', x: f.cx, z: f.cz, hx: f.halfLength, hz: f.halfThickness, bottom: 0, top: 27, prop: -1 });
    expect(gc.sin).toBeCloseTo(Math.sin(f.rotY), 12);
    const hit = raycastStatic(set, map, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, 50);
    expect(hit).toMatchObject({ kind: 'glass' });
    expect(hit!.t).toBeCloseTo(10 - 0.45, 9);
    // The diagonal solid wall: a ray across it hits 'prop'.
    expect(raycastStatic(set, map, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 50)).toMatchObject({ kind: 'prop' });
    // Ceiling and floor stop rays ('terrain').
    expect(raycastStatic(set, map, { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }, 50)).toMatchObject({ kind: 'terrain', t: 29 });
  });

  it('kit parts follow T(x, y, z) R_y(rotY) S(scale); surface props sit on the placement y', () => {
    const map = roomMap([prop('desk', 10, 5, Math.PI / 2, 0, 1), prop('step', 0, 0, 0, 6.66, 2)]);
    const set = buildColliders(map, STEP);
    const top = set.colliders.find((c) => c.prop === 0 && c.top === 6.66) as BoxCollider;
    // Local X maps to world (cos, -sin) = (0, -1) at rotY 90 deg: the 12 m desk now runs along Z.
    expect(top.x).toBeCloseTo(10, 9);
    expect(top.z).toBeCloseTo(5, 9);
    expect(top.hx).toBeCloseTo(6, 9);
    expect(platformHeightAt(set, 10.5, 5 + 5.5, 6.66, STEP)).toBe(6.66);
    expect(platformHeightAt(set, 10 + 5.5, 5, 6.66, STEP)).toBe(-Infinity);
    // A step at scale 2 placed on a 6.66 m top: 2 x 2 x 1.89 m from y 6.66.
    const st = set.colliders.find((c) => c.prop === 1) as BoxCollider;
    expect(st).toMatchObject({ x: 0, z: 0, hx: 2, hz: 2, bottom: 6.66 });
    expect(st.top).toBeCloseTo(6.66 + 1.89, 9);
  });

  it('a kit ramp becomes n = ceil(rise / (0.8 x stepHeight)) flat steps climbing toward -Z; walking up never needs a jump', () => {
    const map = roomMap([prop('ramp', 0, 0)]);
    const set = buildColliders(map, STEP);
    const steps = set.colliders.filter((c) => c.prop === 0) as BoxCollider[];
    const n = Math.ceil(6.66 / (RAMP_STEP_FRACTION * STEP));
    expect(steps.length).toBe(n);
    steps.forEach((s, i) => {
      expect(s.top).toBeCloseTo((6.66 * (i + 1)) / n, 9);
      expect(s.hz).toBeCloseTo(14 / n / 2, 9);
      expect(s.z).toBeCloseTo(7 - (14 / n) * (i + 0.5), 9);
    });
    // Walk up from the front (z = +8) toward -Z: ends on the desk-top height without jumping.
    const ctx = createMovementContext(map, BALANCE);
    let m = initialMovementState({ x: 0, y: 0, z: 8 }, false);
    for (let i = 0; i < 200 && m.pos.z > -6.5; i++) {
      m = stepMovement(m, mvIn({ moveForward: 1, yaw: 0 }), SIM_DT, ctx).state;
      expect(m.grounded).toBe(true);
    }
    expect(m.pos.z).toBeLessThanOrEqual(-6.5);
    expect(m.pos.y).toBeCloseTo(6.66, 6);
  });

  it('the ping-pong net (1.6 m over the top) is a separate wall: 50 sprint-jumps from either half never cross it', () => {
    const map = roomMap([prop('pingPongTable', 0, 0)]);
    const ctx = createMovementContext(map, BALANCE);
    const net = ctx.colliders.colliders.find((c) => c.prop === 0 && c.bottom === 6.84) as BoxCollider;
    expect(net.top - net.bottom).toBeCloseTo(1.6, 9);
    expect(net.hz).toBeCloseTo(0.09, 9);
    for (let k = 0; k < 50; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const yaw = (side > 0 ? 0 : Math.PI) + (((k % 25) - 12) / 12) * 30 * DEG2RAD;
      let m = initialMovementState({ x: (k % 7) - 3, y: 6.84, z: side * 6 }, false);
      for (let i = 0; i < 60; i++) {
        m = stepMovement(m, mvIn({ moveForward: 1, sprint: true, yaw, jump: i % 8 === 4 }), SIM_DT, ctx).state;
        if (m.pos.y < 6) break; // fell off the table end
      }
      if (m.pos.y >= 6.84 - 1e-6) expect(Math.sign(m.pos.z)).toBe(side);
    }
  });

  it('grid: boxes are inserted by oriented-box coverage, not by bounding circle', () => {
    const long = wall(-60, 0, 60, 0); // 120 m along X
    const set = buildColliders(roomMap([], [long]), STEP);
    const idx = set.colliders.findIndex((c) => c.shape === 'box' && c.z === 0 && Math.abs((c as BoxCollider).hx - 60) < 1e-9);
    let cells = 0;
    for (const c of set.cells) if (c.includes(idx)) cells++;
    // 120 m / 8 m cells = 15-16 columns, one or two rows; the bounding circle would cover ~16 x 16.
    expect(cells).toBeLessThanOrEqual(2 * 17);
    // A diagonal wall still blocks rays everywhere along it.
    const diag = buildColliders(roomMap([], [wall(-40, -30, 40, 30)]), STEP);
    const map = roomMap([], [wall(-40, -30, 40, 30)]);
    for (let t = -35; t <= 35; t += 5) {
      const x = t;
      const z = (t * 30) / 40;
      expect(raycastStatic(diag, map, { x: x - 3, y: 1, z: z + 3 }, { x: Math.SQRT1_2, y: 0, z: -Math.SQRT1_2 }, 10)).not.toBeNull();
    }
  });

  it('island grid and colliders are unchanged by the new insert (same set of colliders per ray)', () => {
    const map = flatMap({}, [
      { kind: 'hut', x: 10, z: 10, rotY: 0.7, scale: 1 },
      { kind: 'crate', x: -20, z: 5, rotY: 1.1, scale: 1.5 },
      { kind: 'palm', x: 30, z: -30, rotY: 0, scale: 1 },
    ]);
    const set = buildColliders(map, STEP);
    expect(set.colliders.length).toBe(4 + 1 + 3);
    expect(raycastStatic(set, map, { x: 10, y: 3, z: 0 }, { x: 0, y: 0, z: 1 }, 30)).toMatchObject({ kind: 'prop' });
  });

  it('prepareMap builds a nav graph only for indoor maps and only when asked', () => {
    expect(prepareMap(flatMap(), BALANCE).nav).toBeNull();
    expect(prepareMap(roomMap(), OFFICE, { nav: false }).nav).toBeNull();
    const rt = prepareMap(roomMap([prop('desk', 0, 0)]), OFFICE);
    expect(rt.nav).not.toBeNull();
    expect(rt.ctx.colliders.colliders.length).toBeGreaterThan(4);
  });
});

describe('indoor movement', () => {
  it('feet are clamped to the floor rectangle inset by player.radius (also with no outer walls)', () => {
    const map = roomMap([], [], { walls: [] });
    const ctx = createMovementContext(map, BALANCE);
    let m = initialMovementState({ x: 55, y: 0, z: 0 }, false);
    for (let i = 0; i < 60; i++) m = stepMovement(m, mvIn({ moveRight: 1, yaw: 0 }), SIM_DT, ctx).state;
    expect(m.pos.x).toBeCloseTo(60 - BALANCE.player.radius, 9);
    expect(m.vel.x).toBe(0);
    m = initialMovementState({ x: 0, y: 30, z: -35 }, true, 'freefall');
    for (let i = 0; i < 30; i++) m = stepMovement(m, mvIn({ moveForward: 1, yaw: 0 }), SIM_DT, createMovementContext(map, OFFICE)).state;
    expect(m.pos.z).toBeCloseTo(-40 + BALANCE.player.radius, 9);
  });

  it('players cannot walk through glass (maps.md 15)', () => {
    const map = roomMap([prop('pane', 0, -5)]);
    const ctx = createMovementContext(map, BALANCE);
    let m = initialMovementState({ x: 0, y: 0, z: 0 }, false);
    for (let i = 0; i < 90; i++) m = stepMovement(m, mvIn({ moveForward: 1, sprint: true, yaw: 0 }), SIM_DT, ctx).state;
    expect(m.pos.z).toBeGreaterThan(-5);
  });

  it('maps.md 17b: touching a 0.945 m step and pressing jump ends on top (50 trials, yaw -30..+30 deg)', () => {
    const map = roomMap([prop('step', 0, -1.5)]);
    const ctx = createMovementContext(map, BALANCE);
    for (let k = 0; k < 50; k++) {
      const yawOff = (-30 + (60 * k) / 49) * DEG2RAD;
      // Standing with the body touching the step's +Z face (step spans z -2.5..-0.5).
      let m = initialMovementState({ x: Math.sin(yawOff) * 0.3, y: 0, z: -0.5 + BALANCE.player.radius + 0.01 }, false);
      let onTop = false;
      for (let i = 0; i < 30 && !onTop; i++) {
        m = stepMovement(m, mvIn({ moveForward: 1, yaw: yawOff, jump: i === 0 }), SIM_DT, ctx).state;
        onTop = m.grounded && Math.abs(m.pos.y - 0.945) < 1e-9;
      }
      expect(onTop).toBe(true);
    }
  });

  it('REVIEW-M2b L2: landing on a ledge while still rising reports no impact speed', () => {
    const ctx = createMovementContext(roomMap([prop('step', 0, 0)]), BALANCE);
    const start = { ...initialMovementState({ x: 0, y: 0.7, z: 0 }, false), grounded: false, vel: { x: 0, y: 4, z: 0 } };
    const r = stepMovement(start, mvIn(), SIM_DT, ctx);
    expect(r.landed).toBe(true);
    expect(r.state.pos.y).toBeCloseTo(0.945, 9);
    expect(r.landingSpeed).toBe(0);
  });

  it('auto-deploy ignores props: freefall over a desk opens at 10 m above the floor', () => {
    const map = roomMap([prop('desk', 0, 0)]);
    const ctx = createMovementContext(map, OFFICE);
    let m = initialMovementState({ x: 0, y: 25, z: 0 }, true, 'freefall');
    let openedAt = NaN;
    for (let i = 0; i < 200 && m.dropping; i++) {
      const y0 = m.pos.y;
      const r = stepMovement(m, mvIn(), SIM_DT, ctx);
      if (r.chuteOpened === 'auto') openedAt = y0;
      m = r.state;
    }
    expect(openedAt).toBeLessThanOrEqual(10);
    expect(openedAt).toBeGreaterThan(10 - 15 * SIM_DT - 1e-9);
    expect(m.pos.y).toBeCloseTo(6.66, 9);
    expect(m.dropping).toBe(false);
  });
});

describe('maps.md 11: fall damage on the office balance (and the island control)', () => {
  function fall(height: number, office: boolean, walkOff = false) {
    const map = office ? roomMap([prop('desk', 0, 0)], [], { walls: [] }) : flatMap();
    const b = office ? OFFICE : balanceWith(() => {});
    const { w, ids } = playingWorld(2, { map, balance: b });
    const [a] = ids as [number];
    land(w, ids[1]!, 30, 30);
    const p = w.debugPlayer(a)!;
    const ground = office ? 0 : 2;
    if (walkOff) {
      p.move = initialMovementState({ x: 5, y: 6.66, z: 0 }, false);
      return run(w, 90, { [a]: () => ({ moveRight: 1, yaw: 0 }) });
    }
    p.move = { ...initialMovementState({ x: -30, y: ground + height, z: -20 }, false), grounded: false };
    return run(w, 90, { [a]: () => ({}) });
  }
  const fallDmg = (ev: SimEvent[]) => ofType(ev, 'damage').filter((d) => d.cause === 'fall').reduce((s, d) => s + d.amount, 0);
  it('walking off a 6.7 m plateau: 0; falling 9 m: 5.8 HP (+-0.3); island 6.7 m: 20.2 HP (+-0.5)', () => {
    expect(fallDmg(fall(0, true, true))).toBe(0);
    expect(fallDmg(fall(6.66, true))).toBe(0);
    expect(Math.abs(fallDmg(fall(9, true)) - 5.8)).toBeLessThanOrEqual(0.3);
    expect(Math.abs(fallDmg(fall(6.7, false)) - 20.2)).toBeLessThanOrEqual(0.5);
  });
  it('jumping off the plateau (6.66 m + jump apex): 0', () => {
    const map = roomMap([prop('desk', 0, 0)], [], { walls: [] });
    const { w, ids } = playingWorld(2, { map, balance: OFFICE });
    land(w, ids[1]!, 30, 30);
    w.debugPlayer(ids[0]!)!.move = initialMovementState({ x: 5, y: 6.66, z: 0 }, false);
    const ev = run(w, 90, { [ids[0]!]: (i) => ({ moveRight: 1, yaw: 0, jump: i === 5 }) });
    expect(ofType(ev, 'damage').filter((d) => d.cause === 'fall')).toEqual([]);
    expect(w.debugPlayer(ids[0]!)!.move.pos.y).toBe(0);
  });
});

describe('glass in combat (maps.md 15) and grenades (maps.md 15-16)', () => {
  it('a shot at a player behind glass stops at the glass (impact glass, no damage); a bot-sight / LOS ray is blocked', () => {
    const map = roomMap([prop('pane', 0, -5)]);
    const { w, ids } = playingWorld(2, { map, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 0, -10);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 30 };
    sp.inv.activeSlot = 0;
    const ev = run(w, 1, { [s]: () => ({ fire: true, pitch: Math.atan2(-0.6, 10) }), [t]: () => ({}) });
    const shot = ofType(ev, 'shot')[0]!;
    expect(shot.impacts[0]!.surface as string).toBe('glass');
    expect(shot.impacts[0]!.point.z).toBeCloseTo(-5 + 0.2, 6);
    expect(ofType(ev, 'damage')).toEqual([]);
    const ctx = w.debugContext();
    expect(lineOfSight(ctx.colliders, map, { x: 0, y: 1.2, z: 0 }, { x: 0, y: 1.2, z: -10 })).toBe(false);
  });

  it('a grenade blast behind glass deals no damage', () => {
    const map = roomMap([prop('pane', 0, -5)]);
    const { w, ids } = playingWorld(2, { map });
    const [a, t] = ids as [number, number];
    land(w, a, 20, 20);
    land(w, t, 0, -6.5);
    w.debugSpawnGrenade(a, { x: 0, y: 0.08, z: -3.5 }, { x: 0, y: 0, z: 0 }, 1);
    const ev = run(w, 2);
    expect(ofType(ev, 'explosion').length).toBe(1);
    expect(ofType(ev, 'damage')).toEqual([]);
  });

  function ctxOf(map = roomMap([prop('pane', 0, -5)])): MovementContext {
    return createMovementContext(map, BALANCE);
  }
  const fly = (ctx: MovementContext, pos: Vec3, vel: Vec3, n: number) => {
    let body: GrenadeBody = { pos, vel, inWater: false };
    const contacts: string[] = [];
    let first: { vel: Vec3 } | null = null;
    for (let i = 0; i < n; i++) {
      const r = stepGrenade(body, SIM_DT, ctx);
      body = r.body;
      if (r.contact) {
        contacts.push(r.contact.surface);
        if (!first) first = { vel: { ...r.body.vel } };
      }
    }
    return { body, contacts, first };
  };

  it('maps.md 16: a grenade thrown straight at a wall bounces back with the normal velocity reversed x restitution (+-5%)', () => {
    const ctx = ctxOf(roomMap([], [wall(-10, -5, 10, -5)]));
    const g = BALANCE.items.grenade;
    const v0 = 12;
    // Fly horizontally (no time to drop much) toward the wall at z = -5 + 0.45.
    const r = fly(ctx, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -v0 }, 15);
    expect(r.contacts[0]).toBe('prop');
    expect(r.first!.vel.z).toBeGreaterThan(0);
    expect(Math.abs(r.first!.vel.z - v0 * g.restitution) / (v0 * g.restitution)).toBeLessThan(0.05);
  });

  it('grenades bounce off glass (contact glass), the floor-rectangle edge (edge) and the ceiling (-Y)', () => {
    const glass = fly(ctxOf(), { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -12 }, 15);
    expect(glass.contacts[0]).toBe('glass');
    expect(glass.first!.vel.z).toBeGreaterThan(0);
    const noWalls = createMovementContext(roomMap([], [], { walls: [] }), BALANCE);
    const edge = fly(noWalls, { x: 55, y: 5, z: 0 }, { x: 20, y: 0, z: 0 }, 15);
    expect(edge.contacts[0]).toBe('edge');
    expect(edge.first!.vel.x).toBeLessThan(0);
    expect(edge.body.pos.x).toBeLessThanOrEqual(60);
    const ceil = fly(noWalls, { x: 0, y: 28, z: 0 }, { x: 0, y: 20, z: 0 }, 5);
    expect(ceil.contacts[0]).toBe('terrain');
    expect(ceil.first!.vel.y).toBeLessThan(0);
    expect(ceil.body.pos.y).toBeLessThan(30);
  });

  it('predictGrenadeArc reuses the `out` buffer (REVIEW-M2a M2) and returns the same points', () => {
    const ctx = ctxOf();
    const launch = { pos: { x: 0, y: 2, z: 0 }, vel: { x: 3, y: 6, z: -4 } };
    const fresh = predictGrenadeArc(launch, 3500, ctx, 4);
    const out = { points: [] as Vec3[] };
    const a = predictGrenadeArc(launch, 3500, ctx, 4, out);
    const firstObj = out.points[0];
    expect(a.points).toBe(out.points);
    expect(a).toEqual(fresh);
    const b = predictGrenadeArc({ pos: launch.pos, vel: { x: 0, y: 0, z: 0 } }, 3500, ctx, 4, out);
    expect(out.points[0]).toBe(firstObj);
    expect(b.points.length).toBeLessThan(fresh.points.length);
  });
});

describe('indoor zone (maps.md 12-14)', () => {
  const office = roomMap([], [], { floor: { minX: -117, minZ: -72, maxX: 117, maxZ: 72 }, walls: [], zoneCenters: [{ x: 60, z: 20 }, { x: -110, z: 0 }] });
  it('12: radius 140 covers every floor corner at t = 0; phase end radii and times match maps.md', () => {
    const z = createZone(OFFICE, office, createRng(1), 0);
    expect(z.state.radius).toBe(140);
    expect(z.state.center).toEqual({ x: 0, z: 0 });
    expect(Math.hypot(117, 72)).toBeLessThanOrEqual(140);
    const radii: number[] = [];
    const ends: number[] = [];
    let last = z.state.phaseIndex;
    for (let t = 0; t <= 530_000; t += 100) {
      updateZone(z, OFFICE, office, createRng(2), t);
      if (z.state.phaseIndex !== last) {
        radii.push(z.state.radius);
        ends.push(t);
        last = z.state.phaseIndex;
      }
    }
    [95, 70, 50, 30, 15, 5].forEach((r, i) => expect(Math.abs(radii[i]! - r)).toBeLessThanOrEqual(0.1));
    [120, 225, 320, 390, 440, 480].forEach((s, i) => expect(ends[i]).toBe(s * 1000));
    expect(z.closed).toBe(true);
  });

  it('13: over 1000 seeds every centre lies inside the floor inset 15 m and every circle inside the previous one', () => {
    const inset = OFFICE.zone.indoorCenterInset ?? 15;
    expect(inset).toBe(15);
    for (let seed = 1; seed <= 1000; seed++) {
      const rng = createRng(seed);
      const z = createZone(OFFICE, office, rng, 0);
      let prev = { c: { ...z.state.targetCenter }, r: z.state.targetRadius };
      const check = (c: { x: number; z: number }) => {
        expect(Math.abs(c.x)).toBeLessThanOrEqual(117 - inset + 1e-6);
        expect(Math.abs(c.z)).toBeLessThanOrEqual(72 - inset + 1e-6);
      };
      check(prev.c);
      let idx = z.state.phaseIndex;
      for (let t = 0; t <= 480_000; t += 5000) {
        updateZone(z, OFFICE, office, rng, t);
        if (z.state.phaseIndex !== idx && z.state.phaseIndex < OFFICE.zone.phases.length) {
          idx = z.state.phaseIndex;
          const cur = { c: { ...z.state.targetCenter }, r: z.state.targetRadius };
          check(cur.c);
          expect(Math.hypot(cur.c.x - prev.c.x, cur.c.z - prev.c.z) + cur.r).toBeLessThanOrEqual(prev.r + 1e-6);
          prev = cur;
        }
      }
    }
  });

  it('14: outside the circle on the office: HP loss at the phase dps, no speed change, prone allowed', () => {
    const map = roomMap([], [], { walls: [] });
    const { w, ids } = playingWorld(2, { map, balance: OFFICE });
    const [a] = ids as [number];
    land(w, ids[1]!, 0, 0);
    land(w, a, 50, 30);
    const z = w.debugZone()!;
    z.state.center = { x: 0, z: 0 };
    z.state.radius = 5;
    z.state.dps = 4;
    const hp0 = w.debugPlayer(a)!.hp;
    run(w, 30, { [a]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null }) });
    const p = w.debugPlayer(a)!;
    expect(p.move.stance).toBe('prone');
    expect(hp0 - p.hp).toBeCloseTo(4, 6);
    const x0 = p.move.pos.x;
    run(w, 30, { [a]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null, moveRight: -1 }) });
    // Standing walk speed outside the circle: unchanged (no water).
    run(w, 30, { [a]: () => ({ moveRight: -1 }) });
    expect(x0 - p.move.pos.x).toBeGreaterThan(0);
  });
});

describe('loot on plateaus (LootSpawn.y)', () => {
  it('a spawn with y lands on the desk top; without y on the floor under it; neither counts as inside a collider', () => {
    const map = roomMap([prop('desk', 0, 0)], [], {
      lootSpawns: [
        { x: 1, z: 1, tier: 'common', y: 6.66 },
        { x: -1, z: -1, tier: 'common' },
      ],
    });
    const ctx = createMovementContext(map, BALANCE);
    expect(groundHeightAt(ctx, 1, 1, 6.66)).toBe(6.66);
    expect(groundHeightAt(ctx, -1, -1, 0)).toBe(0);
    expect(lootSpawnsInsideColliders(map, ctx.colliders)).toEqual([]);
    const b = balanceWith((x) => {
      x.loot.spawnChance = 1;
      x.loot.extraAmmoWithWeapon = 0;
    });
    const { w } = playingWorld(2, { map, balance: b });
    const ys = w.debugLoot().map((l) => l.pos.y).sort();
    expect(ys).toEqual([0, 6.66]);
    // A spawn inside a desk leg is flagged.
    const bad = roomMap([prop('desk', 0, 0)], [], { lootSpawns: [{ x: 5.8, z: 0, tier: 'common' }] });
    expect(lootSpawnsInsideColliders(bad, buildColliders(bad, STEP))).toEqual([0]);
  });
});

describe('pitchLimits (ADR 0005 §9)', () => {
  it('prone or a transition from/to prone uses movement.stances.pronePitch*Deg; otherwise PITCH_MIN/MAX', () => {
    const s = BALANCE.movement.stances;
    const m = (stance: 'stand' | 'crouch' | 'prone', from = stance, ms = 0) => ({ stance, stanceFrom: from, stanceMs: ms });
    expect(pitchLimits(m('prone'), BALANCE)).toEqual({ min: s.pronePitchMinDeg! * DEG2RAD, max: s.pronePitchMaxDeg! * DEG2RAD });
    expect(pitchLimits(m('stand', 'prone', 100), BALANCE).min).toBeCloseTo(s.pronePitchMinDeg! * DEG2RAD, 12);
    expect(pitchLimits(m('crouch'), BALANCE)).toEqual({ min: -80 * DEG2RAD, max: 80 * DEG2RAD });
  });
  it('World sanitize clamps a prone player pitch', () => {
    const { w, ids } = playingWorld(2);
    const id = ids[0]!;
    run(w, 40, { [id]: (i) => ({ stanceToggle: i === 0 ? 'prone' : null }) });
    run(w, 1, { [id]: () => ({ pitch: -1.2 }) });
    expect(w.debugPlayer(id)!.pitch).toBeCloseTo(BALANCE.movement.stances.pronePitchMinDeg! * DEG2RAD, 12);
  });
});

describe('resolveMapChoice (maps.md 1-4, ADR 0006 §4)', () => {
  const maps = ['island01', 'office'];
  const base = { pin: null, mode: 'vote' as const, maps, previous: null };
  it('1: office, office, island01 -> office (vote)', () => {
    expect(resolveMapChoice({ ...base, votes: ['office', 'office', 'island01'], rng: createRng(1) })).toEqual({ mapId: 'office', via: 'vote' });
  });
  it('2: a tie is 50/50 over 1000 seeds and stable per seed', () => {
    let office = 0;
    for (let s = 1; s <= 1000; s++) {
      const r = resolveMapChoice({ ...base, votes: ['island01', 'office'], rng: createRng(s) });
      expect(resolveMapChoice({ ...base, votes: ['island01', 'office'], rng: createRng(s) })).toEqual(r);
      if (r.mapId === 'office') office++;
    }
    expect(Math.abs(office / 1000 - 0.5)).toBeLessThanOrEqual(0.05);
  });
  it('3: random wins, then uniform over both maps', () => {
    let office = 0;
    for (let s = 1; s <= 1000; s++) {
      const r = resolveMapChoice({ ...base, votes: ['random', 'random', 'island01'], rng: createRng(s) });
      expect(r.via).toBe('random');
      if (r.mapId === 'office') office++;
    }
    expect(Math.abs(office / 1000 - 0.5)).toBeLessThanOrEqual(0.05);
  });
  it('4: no votes rotate island01, office, island01; pin and fixed mode win', () => {
    let prev: string | null = null;
    const seq: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = resolveMapChoice({ ...base, votes: [null, null], previous: prev, rng: createRng(i) });
      expect(r.via).toBe('rotation');
      seq.push(r.mapId);
      prev = r.mapId;
    }
    expect(seq).toEqual(['island01', 'office', 'island01']);
    expect(resolveMapChoice({ ...base, pin: 'office', votes: ['island01'], rng: createRng(1) })).toEqual({ mapId: 'office', via: 'pinned' });
    expect(resolveMapChoice({ ...base, pin: 'bogus', mode: 'island01', votes: ['office'], rng: createRng(1) })).toEqual({ mapId: 'island01', via: 'fixed' });
  });
});
