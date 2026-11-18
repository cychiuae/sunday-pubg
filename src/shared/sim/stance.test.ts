import { describe, expect, it } from 'vitest';
import type { Balance } from '../balance';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import type { HeldId, MovementInput, MovementState, PlayerInput, PropPlacement, StanceRequest } from '../types';
import { adsProgressOf, effectiveSpreadDeg } from './combat';
import { createMovementContext, initialMovementState, stepMovement, toMovementInput, type MovementContext } from './movement';
import { chestPoint, eyeHeightOf, hitboxHeightOf, rayHitbox, stanceProgress } from './stance';
import { balanceWith, flatMap, input, land, playingWorld, run } from './testkit';

const b = BALANCE;
const st = b.movement.stances;
const mv = (over: Partial<MovementInput> = {}): MovementInput => ({
  moveForward: 0,
  moveRight: 0,
  yaw: 0,
  jump: false,
  sprint: false,
  speedMultiplier: 1,
  canSprint: true,
  stanceToggle: null,
  ads: false,
  held: 'rifle',
  adsBlocked: false,
  ...over,
});
const on = (x: number, y: number, z: number, over: Partial<MovementState> = {}): MovementState => ({
  ...initialMovementState({ x, y, z }, false),
  ...over,
});
const settled = (s: MovementState['stance'], y = 2): MovementState => on(0, y, 0, { stance: s, stanceFrom: s });
const hs = (s: MovementState): number => Math.hypot(s.vel.x, s.vel.z);

function steps(ctx: MovementContext, s0: MovementState, n: number, f: (i: number) => Partial<MovementInput>) {
  let s = s0;
  const results = [];
  for (let i = 0; i < n; i++) {
    const r = stepMovement(s, mv(f(i)), SIM_DT, ctx);
    results.push(r);
    s = r.state;
  }
  return { s, results };
}

describe('stance transitions (stance.md acceptance)', () => {
  const flat = createMovementContext(flatMap(), b);

  it('AT1: stand -> crouch settles after 6 ticks; crouch walk 2.75 m/s', () => {
    const t = (n: number) => steps(flat, settled('stand'), n, (i) => ({ stanceToggle: i === 0 ? 'crouch' : null }));
    const five = t(5);
    expect(five.results[0]!.stanceChanged).toEqual({ from: 'stand', to: 'crouch', forced: false, durationMs: 200 });
    expect(five.s.stanceMs).toBeGreaterThan(0);
    expect(t(7).s.stanceMs).toBe(0);
    expect(t(7).s.stanceFrom).toBe('crouch');
    const walk = steps(flat, settled('crouch'), 60, () => ({ moveForward: 1 })).s;
    expect(hs(walk)).toBeCloseTo(2.75, 2);
  });

  it('AT2: prone crawl 1.25 m/s; in 0.18 m water 0.75 m/s', () => {
    expect(hs(steps(flat, settled('prone'), 60, () => ({ moveForward: 1 })).s)).toBeCloseTo(1.25, 2);
    const shallow = createMovementContext(flatMap({ baseHeight: -0.18 }), b);
    expect(hs(steps(shallow, settled('prone', -0.18), 60, () => ({ moveForward: 1 })).s)).toBeCloseTo(0.75, 2);
  });

  it('AT3: crouched + sprint + forward starts crouch_stand that tick; 7.2 m/s only after it settles', () => {
    const r = steps(flat, settled('crouch'), 60, () => ({ moveForward: 1, sprint: true }));
    expect(r.results[0]!.stanceChanged).toMatchObject({ from: 'crouch', to: 'stand' });
    const settleTick = r.results.findIndex((x) => x.state.stanceMs === 0);
    expect(settleTick).toBeGreaterThan(5);
    for (let i = 0; i < settleTick; i++) expect(hs(r.results[i]!.state)).toBeLessThanOrEqual(b.movement.walkSpeed + 1e-9);
    expect(hs(r.s)).toBeCloseTo(b.movement.sprintSpeed, 3);
  });

  it('AT4: Space jumps when standing, stands up from crouch (no jump), goes to crouch from prone', () => {
    const j = stepMovement(settled('stand'), mv({ jump: true }), SIM_DT, flat);
    expect(j.jumped).toBe(true);
    expect(j.state.vel.y).toBeCloseTo(b.movement.jumpVelocity - b.movement.gravity * SIM_DT, 9);
    const c = stepMovement(settled('crouch'), mv({ jump: true }), SIM_DT, flat);
    expect(c.jumped).toBe(false);
    expect(c.state.vel.y).toBe(0);
    expect(c.state.stance).toBe('stand');
    expect(stepMovement(settled('prone'), mv({ jump: true }), SIM_DT, flat).state.stance).toBe('crouch');
    // C and Space on the same tick while prone: the toggle wins (prone -> crouch).
    expect(stepMovement(settled('prone'), mv({ jump: true, stanceToggle: 'crouch' }), SIM_DT, flat).state.stance).toBe('crouch');
  });

  it('AT5: Z at depth 0.3 and C at depth 0.6 are refused tooDeep', () => {
    const d3 = createMovementContext(flatMap({ baseHeight: -0.3 }), b);
    const z = stepMovement(settled('stand', -0.3), mv({ stanceToggle: 'prone' }), SIM_DT, d3);
    expect(z.stanceRefused).toBe('tooDeep');
    expect(z.state.stance).toBe('stand');
    const d6 = createMovementContext(flatMap({ baseHeight: -0.6 }), b);
    expect(stepMovement(settled('stand', -0.6), mv({ stanceToggle: 'crouch' }), SIM_DT, d6).stanceRefused).toBe('tooDeep');
  });

  it('AT6: crawling into water deeper than 0.2 forces prone_stand (700 ms)', () => {
    // Seabed at -0.1, dipping to -0.4 around (0, -6).
    const map = flatMap({ baseHeight: -0.1, hills: [{ x: 0, z: -6, radius: 6, height: -0.3 }] });
    const ctx = createMovementContext(map, b);
    const r = steps(ctx, settled('prone', -0.1), 150, () => ({ moveForward: 1 }));
    const forced = r.results.findIndex((x) => x.stanceChanged?.forced === true);
    expect(forced).toBeGreaterThan(0);
    expect(r.results[forced]!.stanceChanged).toEqual({ from: 'prone', to: 'stand', forced: true, durationMs: 700 });
    expect(-r.results[forced - 1]!.state.pos.y).toBeGreaterThan(st.proneMaxWaterDepth);
    expect(-r.results[forced - 2]!.state.pos.y).toBeLessThanOrEqual(st.proneMaxWaterDepth + 0.05);
    expect(r.results[forced + 21]!.state.stance).toBe('stand');
    expect(r.results[forced + 21]!.state.stanceMs).toBe(0);
  });

  it('AT7: headroom under a raised collider (bottom at feet + 1.1)', () => {
    // A raised slab (a roof or leaning trunk) whose bottom is 1.1 m above the ground.
    const slab: PropPlacement = { kind: 'crate', x: 0, z: 0, rotY: 0, scale: 1 };
    const raised = (bal: Balance): MovementContext => {
      const c = createMovementContext(flatMap({}, [slab]), bal);
      const col = c.colliders.colliders[0] as { bottom: number; top: number };
      col.bottom = 2 + 1.1;
      col.top = 2 + 3;
      return c;
    };
    const ctx = raised(b);
    const at = (s: MovementState['stance']) => on(0, 2, 0, { stance: s, stanceFrom: s });
    expect(stepMovement(at('prone'), mv({ stanceToggle: 'crouch' }), SIM_DT, ctx).state.stance).toBe('crouch');
    const space = stepMovement(at('crouch'), mv({ jump: true }), SIM_DT, ctx);
    expect(space.stanceRefused).toBe('noHeadroom');
    expect(space.state.stance).toBe('crouch');
    const z = stepMovement(at('prone'), mv({ stanceToggle: 'prone' }), SIM_DT, ctx);
    expect(z.state.stance).toBe('crouch'); // fallback
    expect(z.stanceRefused).toBeNull();
    // Sprint-triggered stand-up fails silently.
    const sprint = stepMovement(at('crouch'), mv({ sprint: true, moveForward: 1 }), SIM_DT, ctx);
    expect(sprint.stanceRefused).toBeNull();
    expect(sprint.state.stance).toBe('crouch');
    const off = raised(balanceWith((x) => (x.movement.stances.headroomCheck = false)));
    expect(stepMovement(at('crouch'), mv({ jump: true }), SIM_DT, off).state.stance).toBe('stand');
  });

  it('a player standing next to a crate (touching after push-out) can still stand up', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -1, rotY: 0, scale: 1 };
    const ctx = createMovementContext(flatMap({}, [crate]), b);
    const s = on(0, 2, -1 + 0.5 + b.player.radius, { stance: 'prone', stanceFrom: 'prone' });
    expect(stepMovement(s, mv({ stanceToggle: 'prone' }), SIM_DT, ctx).state.stance).toBe('stand');
  });

  it('AT14/15: requests while airborne, dropping or mid-transition are ignored', () => {
    expect(stepMovement({ ...settled('stand'), grounded: false }, mv({ stanceToggle: 'crouch' }), SIM_DT, flat).state.stance).toBe('stand');
    expect(stepMovement(initialMovementState({ x: 0, y: 30, z: 0 }, true), mv({ stanceToggle: 'prone' }), SIM_DT, flat).state.stance).toBe('stand');
    const r = steps(flat, settled('stand'), 7, (i) => ({ stanceToggle: (i === 0 ? 'crouch' : i === 3 ? 'prone' : null) as StanceRequest | null }));
    expect(r.s.stance).toBe('crouch');
    expect(r.s.stanceMs).toBe(0);
  });

  it('AT13: eye height lerps during a transition (300 ms into stand_prone = 0.70)', () => {
    const r = steps(flat, settled('stand'), 9, (i) => ({ stanceToggle: i === 0 ? 'prone' : null }));
    expect(stanceProgress(r.s, b)).toBeCloseTo(0.5, 6);
    expect(eyeHeightOf(r.s, b)).toBeCloseTo(0.7, 2);
    expect(hitboxHeightOf(r.s, b)).toBe(st.stand.height);
    // BUG-008: prone height 0.6, chest 0.3 (stance.md "Visual fit").
    expect(chestPoint({ x: 0, y: 0, z: 0 }, settled('prone'), b).y).toBeCloseTo(0.3, 9);
    expect(chestPoint({ x: 0, y: 0, z: 0 }, settled('crouch'), b).y).toBeCloseTo(0.475, 9);
  });
});

describe('stance hitboxes (stance.md AT10-12)', () => {
  const feet = { x: 0, y: 0, z: 0 };
  const horiz = (y: number) => rayHitbox({ x: 0, y, z: 10 }, { x: 0, y: 0, z: -1 }, 100, feet, 0, settled('crouch'), b);
  const down = (x: number, z: number, yaw: number) =>
    rayHitbox({ x, y: 5, z }, { x: 0, y: -1, z: 0 }, 100, feet, yaw, settled('prone'), b);

  it('crouch: y 0.9 head, y 0.4 body, y 1.0 miss', () => {
    expect(horiz(0.9)).toMatchObject({ headshot: true });
    expect(horiz(0.4)).toMatchObject({ headshot: false });
    expect(horiz(1.0)).toBeNull();
  });

  it('prone box: centred on the feet, head at the front, rotates with yaw', () => {
    expect(down(0, -0.6, 0)).toMatchObject({ headshot: true });
    expect(down(0, 0.6, 0)).toMatchObject({ headshot: false });
    expect(down(0.5, 0, 0)).toBeNull();
    // AT11 (BUG-008, prone height 0.6): y 0.55 hits, y 0.7 misses.
    expect(rayHitbox({ x: 0, y: 0.55, z: 10 }, { x: 0, y: 0, z: -1 }, 100, feet, 0, settled('prone'), b)).not.toBeNull();
    expect(rayHitbox({ x: 0, y: 0.7, z: 10 }, { x: 0, y: 0, z: -1 }, 100, feet, 0, settled('prone'), b)).toBeNull();
    const q = Math.PI / 2;
    expect(down(0, -0.6, q)).toBeNull();
    expect(down(0, 0.6, q)).toBeNull();
    expect(down(0.5, 0, q)).toMatchObject({ headshot: false });
    expect(down(-0.6, 0, q)).toMatchObject({ headshot: true }); // yaw 90 deg looks toward -X
  });

  it('during stand_prone the standing cylinder applies (y 1.2 is a head hit)', () => {
    const m: MovementState = { ...settled('stand'), stance: 'prone', stanceFrom: 'stand', stanceMs: 300 };
    expect(rayHitbox({ x: 0, y: 1.2, z: 10 }, { x: 0, y: 0, z: -1 }, 100, feet, 0, m, b)).toMatchObject({ headshot: true });
  });
});

describe('ADS in the movement step (combat.md AT13-15)', () => {
  const flat = createMovementContext(flatMap(), b);

  it('AT13: rifle ADS ramps to full in 7 ticks; 3 ticks give 1.2522; release is instant', () => {
    const r = steps(flat, settled('stand'), 7, () => ({ ads: true }));
    const prog = (s: MovementState) => adsProgressOf(s, 'rifle', b);
    const spread = (s: MovementState) => effectiveSpreadDeg('rifle', b, { horizontalSpeed: 0, airborne: false, adsProgress: prog(s) });
    expect(spread(r.results[2]!.state)).toBeCloseTo(1.6 * (1 - 0.5 * (100 / 230)), 3);
    expect(spread(r.s)).toBeCloseTo(0.8, 9);
    expect(r.results[6]!.adsEngaged).toBe(true);
    const off = stepMovement(r.s, mv({ ads: false }), SIM_DT, flat);
    expect(off.state.adsMs).toBe(0);
  });

  it('AT14: ADS blocked (reload/heal/swap), with fists or the grenade, and during transitions', () => {
    for (const over of [{ adsBlocked: true }, { held: 'fists' as HeldId }, { held: 'grenade' as HeldId }]) {
      expect(steps(flat, settled('stand'), 5, () => ({ ads: true, ...over })).s.adsMs).toBe(0);
    }
    // AT9: ads held while a transition runs stays at 0, then ramps after settle.
    const r = steps(flat, settled('stand'), 12, (i) => ({ ads: true, stanceToggle: i === 0 ? 'crouch' : null }));
    for (const x of r.results) if (x.state.stanceMs > 0) expect(x.state.adsMs).toBe(0);
    expect(r.s.adsMs).toBeGreaterThan(0);
    // ADS from a running ADS is reset on the tick a transition starts.
    const ads = steps(flat, settled('stand'), 3, () => ({ ads: true })).s;
    expect(stepMovement(ads, mv({ ads: true, stanceToggle: 'crouch' }), SIM_DT, flat).state.adsMs).toBe(0);
  });

  it('AT15: sprint + forward + ads settles at walk x adsMoveMultiplier; releasing ads resumes sprint', () => {
    const r = steps(flat, settled('stand'), 60, () => ({ ads: true, sprint: true, moveForward: 1 }));
    expect(hs(r.s)).toBeCloseTo(b.movement.walkSpeed * b.weapons.rifle.adsMoveMultiplier, 2);
    const back = steps(flat, r.s, 60, () => ({ sprint: true, moveForward: 1 })).s;
    expect(hs(back)).toBeCloseTo(b.movement.sprintSpeed, 2);
  });

  it('LMG fire window: toMovementInput applies fireMoveMultiplier (2.75 m/s)', () => {
    const i: PlayerInput = input({ moveForward: 1, fire: true });
    const status = { alive: true, healing: false, reloading: false, held: 'lmg' as HeldId, swapping: false, fireSlowed: true };
    const r = steps(flat, settled('stand'), 60, () => ({ ...toMovementInput(i, status, b), held: 'lmg' }));
    expect(hs(r.s)).toBeCloseTo(2.75, 2);
    const dead = toMovementInput({ ...i, ads: true, stanceToggle: 'prone' }, { ...status, alive: false }, b);
    expect(dead).toMatchObject({ stanceToggle: null, ads: false, adsBlocked: true, speedMultiplier: 0 });
  });
});

describe('stance prediction equivalence (stance.md AT16)', () => {
  it('replaying the same inputs through the shared step matches the World tick for tick', () => {
    const balance: Balance = balanceWith(() => {});
    const { w, ids } = playingWorld(1, { balance });
    const id = ids[0]!;
    land(w, id, 0, 0);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 25 };
    p.inv.activeSlot = 0;
    const script = (i: number): Partial<PlayerInput> => ({
      moveForward: i % 40 < 30 ? 1 : 0,
      sprint: i % 50 > 20,
      ads: i % 70 > 50,
      jump: i % 37 === 0,
      stanceToggle: i % 23 === 0 ? 'crouch' : i % 41 === 0 ? 'prone' : null,
      yaw: i * 0.01,
    });
    const ctx = w.debugContext();
    let predicted = { ...p.move };
    for (let i = 1; i <= 240; i++) {
      run(w, 1, { [id]: () => script(i) });
      const status = { alive: true, healing: false, reloading: false, held: 'rifle' as HeldId, swapping: false, fireSlowed: false };
      predicted = stepMovement(predicted, toMovementInput(input(script(i)), status, balance), SIM_DT, ctx).state;
      const server = w.debugPlayer(id)!.move;
      expect([predicted.stance, predicted.stanceFrom, predicted.stanceMs, predicted.adsMs]).toEqual([
        server.stance,
        server.stanceFrom,
        server.stanceMs,
        server.adsMs,
      ]);
      expect(predicted.pos).toEqual(server.pos);
    }
  });
});
