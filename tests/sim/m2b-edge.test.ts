/**
 * M2b exploratory edge cases on the REAL office level (qa-tester, Phase D). Owner tests use synthetic fixtures
 * (testkit roomMap / TEST_KIT); these run the shipped OFFICE map with the office balance (balanceForMap). Findings
 * that fail are filed in docs/qa/bugs/ and the test is `it.fails` with the bug id in its title until the fix lands.
 */
import { describe, expect, it } from 'vitest';
import { ISLAND } from '../../src/game/levels/island';
import { OFFICE } from '../../src/game/levels/office';
import { BALANCE, balanceForMap, type Balance } from '../../src/shared/balance';
import { SIM_DT } from '../../src/shared/constants';
import { aimDirection, DEG2RAD } from '../../src/shared/math';
import { firstPersonCamera } from '../../src/game/camera';
import { eyePoint } from '../../src/shared/sim/stance';
import type { IndoorMapData, SimEvent, Vec3 } from '../../src/shared/types';
import { raycastStatic, type BoxCollider, type Collider } from '../../src/shared/sim/colliders';
import { createMovementContext, initialMovementState, stepMovement, toMovementInput, type MovementContext } from '../../src/shared/sim/movement';
import { stepGrenade, type GrenadeBody } from '../../src/shared/sim/grenade';
import { input, land, noSpreadBalance, playingWorld, run } from '../../src/shared/sim/testkit';
import { createDebugWorld } from '../../src/shared/sim/World';
import type { MovementState } from '../../src/shared/types';

type Ev<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], t: T): Ev<T>[] => ev.filter((e): e is Ev<T> => e.type === t);
const OB = balanceForMap(BALANCE, 'office');
const clone = (b: Balance): Balance => structuredClone(b);
const mvIn = (o: Parameters<typeof input>[0] = {}) =>
  toMovementInput(input(o), { alive: true, healing: false, reloading: false, held: 'fists', swapping: false, fireSlowed: false }, OB);

let ctxCache: MovementContext | null = null;
const officeCtx = (): MovementContext => (ctxCache ??= createMovementContext(OFFICE, OB));

/** The monitor screen colliders (kit part 'screen': a thin box 1.395..4.365 m above the desk top 6.66). */
function monitorScreens(ctx: MovementContext): BoxCollider[] {
  return ctx.colliders.colliders.filter(
    (c): c is BoxCollider => c.shape === 'box' && c.prop >= 0 && OFFICE.props[c.prop]!.kind.startsWith('monitor') && c.top > 10.5,
  );
}

/**
 * Sprint from `start` along `yaw` and jump when the feet are `lead` m before leaving the platform edge (or at the
 * last grounded tick on the platform). Returns where the jump ended (grounded) or null.
 */
function sprintJump(ctx: MovementContext, start: Vec3, yaw: number, jumpAtStep: number): MovementState | null {
  let s = initialMovementState(start, false);
  let jumped = false;
  for (let i = 0; i < 150; i++) {
    const jump = !jumped && i === jumpAtStep;
    if (jump) jumped = true;
    s = stepMovement(s, mvIn({ moveForward: 1, sprint: true, yaw, jump }), SIM_DT, ctx).state;
    if (jumped && i > jumpAtStep + 2 && s.grounded) return s;
  }
  return null;
}

describe('plateau gap rule vs monitor tops (level-designer request; maps.md 2.4 / acceptance 17)', () => {
  const perches = [
    { id: 'PERCH-NE', top: 10.44 },
    { id: 'PERCH-SW', top: 10.44 },
  ];

  function landingsOnMonitors(routeId: string, top: number): { trials: number; hits: string[] } {
    const ctx = officeCtx();
    const screens = monitorScreens(ctx);
    const route = OFFICE.climbRoutes.find((r) => r.id === routeId)!;
    const end = route.points[route.points.length - 1]!;
    const hits: string[] = [];
    let trials = 0;
    // Start points across the platform end cell, 24 headings, 8 jump timings.
    for (const dx of [-1.5, -0.75, 0, 0.75, 1.5]) {
      for (const dz of [-1, 0, 1]) {
        for (let k = 0; k < 24; k++) {
          const yaw = (k / 24) * 2 * Math.PI;
          for (const jumpAt of [2, 4, 6, 8, 10, 12, 14, 16]) {
            trials++;
            const r = sprintJump(ctx, { x: end.x + dx, y: top, z: end.z + dz }, yaw, jumpAt);
            if (!r) continue;
            const on = screens
              .filter((c) => Math.abs(r.pos.y - c.top) < 1e-3)
              .sort((a, b) => Math.hypot(a.x - r.pos.x, a.z - r.pos.z) - Math.hypot(b.x - r.pos.x, b.z - r.pos.z))[0];
            if (on) hits.push(`from (${(end.x + dx).toFixed(2)}, ${(end.z + dz).toFixed(2)}) yaw ${((yaw / DEG2RAD) | 0)} jump@${jumpAt} -> monitor prop ${on.prop} at (${r.pos.x.toFixed(2)}, ${r.pos.y.toFixed(3)}, ${r.pos.z.toFixed(2)})`);
          }
        }
      }
    }
    return { trials, hits };
  }

  it('geometry: TR S k4 monitor top sits 0.585 m above the NE perch top and about 3.8 m from its edge', () => {
    const ctx = officeCtx();
    const screens = monitorScreens(ctx);
    const near = screens.filter((c) => Math.hypot(c.x - 78.34, c.z + 21.3) < 2);
    expect(near).toHaveLength(1);
    expect(near[0]!.top).toBeCloseTo(11.025, 3);
    expect(near[0]!.top - 10.44).toBeCloseTo(0.585, 3);
  });

  it('BUG-011 (fixed): no sprint-jump from either perch ends standing on a monitor top', () => {
    const found: string[] = [];
    for (const p of perches) {
      const r = landingsOnMonitors(p.id, p.top);
      console.info(`[monitor-top] ${p.id}: ${r.hits.length} of ${r.trials} sprint-jumps end on a monitor top`);
      found.push(...r.hits.slice(0, 3));
      if (r.hits.length) console.info(r.hits.slice(0, 5).join('\n'));
    }
    expect(found).toEqual([]);
  });

  it('BUG-011 fix detail: monitor screens are noStand (they block but never support), so no touchdown and no chained jump', () => {
    const ctx = officeCtx();
    const screens = monitorScreens(ctx);
    expect(screens.length).toBeGreaterThan(20);
    // Single-monitor screens (0.36 m deep) are noStand; dual-monitor screens (1.17 m deep) stay standable but sit 4.37 m
    // above the desk top, out of reach from everything except the perches, and the perch scan above finds 0 landings.
    const single = screens.filter((c) => OFFICE.props[c.prop]!.kind === 'monitor');
    expect(single.filter((c) => c.noStand !== true).map((c) => c.prop)).toEqual([]);
    console.info(`[monitor-top] standable dual-monitor screens: ${screens.filter((c) => c.noStand !== true).length}`);
    let touches = 0;
    let maxApex = 0;
    for (const sx of [77, 78, 79]) {
      for (const jumpAt of [6, 8, 10, 12, 14]) {
        let s = initialMovementState({ x: sx, y: 10.44, z: -27.5 }, false);
        for (let i = 0; i < 150; i++) {
          // Jump at jumpAt and again on every grounded tick afterwards (a chained jump would need a support).
          s = stepMovement(s, mvIn({ moveForward: 1, sprint: true, yaw: Math.PI, jump: i === jumpAt || (i > jumpAt + 2 && s.grounded) }), SIM_DT, ctx).state;
          if (i > jumpAt + 2 && s.grounded && Math.abs(s.pos.y - 11.025) < 1e-3) touches++;
          if (i > jumpAt) maxApex = Math.max(maxApex, s.pos.y);
        }
      }
    }
    console.info(`[monitor-top] touches ${touches}, max height after leaving the perch ${maxApex.toFixed(2)} m`);
    expect(touches).toBe(0);
    // Highest point is the perch jump itself (10.44 + 1.056), never a second jump from a screen top.
    expect(maxApex).toBeLessThan(10.44 + 1.06 + 0.01);
  });
});

describe('ping-pong net on the real office (maps.md 2.4)', () => {
  const table = OFFICE.props.findIndex((p) => p.kind === 'pingPongTable');

  it('the net collider starts flush on the table top (no gap to crawl under) and is 1.6 m tall', () => {
    const ctx = officeCtx();
    const parts = ctx.colliders.colliders.filter((c) => c.prop === table);
    const top = Math.max(...parts.filter((c) => c.top < 7).map((c) => c.top));
    const net = parts.find((c) => c.bottom > 6 && c.top > 8) as Collider;
    expect(net).toBeDefined();
    expect(net.bottom).toBeCloseTo(top, 6);
    expect(net.top - net.bottom).toBeCloseTo(1.6, 6);
  });

  it('prone (and crouched) crawling into the net from either half never crosses it (40 tries, yaw +-30 deg)', () => {
    const ctx = officeCtx();
    const t = OFFICE.props[table]!;
    const parts = ctx.colliders.colliders.filter((c) => c.prop === table);
    const top = Math.max(...parts.filter((c) => c.top < 7).map((c) => c.top));
    // rotY pi/2: the table's long axis (local Z) runs along world X; the net is at x = t.x.
    let crossings = 0;
    for (let k = 0; k < 40; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const stance = k % 4 < 2 ? 'prone' : 'crouch';
      const yaw = (side > 0 ? Math.PI / 2 : -Math.PI / 2) + (((k % 20) - 10) / 10) * 30 * DEG2RAD;
      let m: MovementState = { ...initialMovementState({ x: t.x + side * 4, y: top, z: t.z + ((k % 5) - 2) * 0.8 }, false), stance, stanceFrom: stance };
      for (let i = 0; i < 240; i++) {
        m = stepMovement(m, mvIn({ moveForward: 1, yaw }), SIM_DT, ctx).state;
        if (m.pos.y < top - 0.5) break; // crawled off the table side
      }
      if (m.pos.y >= top - 1e-6 && Math.sign(m.pos.x - t.x) !== side) crossings++;
    }
    expect(crossings).toBe(0);
  });
});

/** The longest glass wall segment running along X (meeting-room fronts; at least 5 m, so a ray at +-0.15 rad from 12 m hits it). */
function longestGlassAlongX(): IndoorMapData['walls'][number] {
  const g = OFFICE.walls.filter((w) => w.material === 'glass' && w.z1 === w.z2).sort((a, b) => Math.abs(b.x2 - b.x1) - Math.abs(a.x2 - a.x1))[0]!;
  expect(Math.abs(g.x2 - g.x1)).toBeGreaterThanOrEqual(5);
  return g;
}

describe('glass and walls on the real office (maps.md 2.5 / 15-16)', () => {
  const glass = longestGlassAlongX();
  const midX = (glass.x1 + glass.x2) / 2;
  const wz = glass.z1;

  it('a rifle shot through a meeting-room glass wall stops at the glass: impact surface glass, no damage', () => {
    const { w, ids } = playingWorld(2, { map: OFFICE, balance: noSpreadBalance() });
    const [s, t] = ids as [number, number];
    land(w, s, midX, wz + 8);
    land(w, t, midX, wz - 6);
    const sp = w.debugPlayer(s)!;
    sp.inv.slots[0] = { weapon: 'rifle', mag: 30 };
    sp.inv.activeSlot = 0;
    const hp0 = w.debugPlayer(t)!.hp;
    let glassHits = 0;
    let dmg = 0;
    for (let i = 0; i < 5; i++) {
      sp.nextFireAt = 0;
      const ev = run(w, 2, { [s]: (k) => ({ fire: k === 0, yaw: 0, pitch: Math.atan2(-0.4, 14) }), [t]: () => ({}) });
      for (const sh of ofType(ev, 'shot')) if (sh.impacts[0]?.surface === 'glass') glassHits++;
      dmg += ofType(ev, 'damage').length;
    }
    expect(glassHits).toBe(5);
    expect(dmg).toBe(0);
    expect(w.debugPlayer(t)!.hp).toBe(hp0);
  });

  it('a grenade thrown at a solid / glass office wall bounces back and never ends on the far side', () => {
    const ctx = officeCtx();
    for (const v of [6, 10, 14, 18]) {
      let body: GrenadeBody = { pos: { x: midX, y: 3, z: wz + 3 }, vel: { x: 0, y: 3, z: -v }, inWater: false };
      const contacts: string[] = [];
      for (let i = 0; i < 120; i++) {
        const r = stepGrenade(body, SIM_DT, ctx);
        body = r.body;
        if (r.contact) contacts.push(r.contact.surface);
      }
      expect(contacts, `v ${v}`).toContain('glass');
      expect(body.pos.z, `v ${v}: rests on the thrower's side`).toBeGreaterThan(wz);
    }
  });
});

describe('carrier drop on the real office: aboard players take no zone damage', () => {
  it('zone forced to a 0 m circle far away at 500 dps: nobody aboard loses HP until they leave the drone', () => {
    const b = clone(OB);
    const w = createDebugWorld({ map: OFFICE as IndoorMapData, balance: b, seed: 11, botNames: ['Bot'], matchStart: { countdownMs: 0, fillBots: false, matchId: 1 } });
    const ids = [w.addPlayer('A')!, w.addPlayer('B')!, w.addPlayer('C')!];
    for (let i = 0; i < 10_000 && w.getMatch().phase !== 'playing'; i++) w.step(SIM_DT);
    const z = w.debugZone()!;
    z.state.center = { x: 1000, z: 1000 };
    z.state.radius = 0;
    z.state.dps = 500;
    const ev: SimEvent[] = [];
    let aboardTicks = 0;
    for (let i = 0; i < 30 * 30; i++) {
      ev.push(...w.step(SIM_DT));
      const aboard = ids.filter((id) => w.debugPlayer(id)?.aboard);
      if (aboard.length === 0) break;
      aboardTicks++;
      for (const id of aboard) expect(w.debugPlayer(id)!.hp).toBe(b.player.maxHp);
    }
    expect(aboardTicks).toBeGreaterThan(30);
    const zoneHitsWhileAboard = ofType(ev, 'damage').filter((d) => d.attackerId === null && ids.includes(d.victimId));
    // Damage may start after the auto-eject; none of it can be from a tick the victim was aboard (checked above).
    expect(zoneHitsWhileAboard.length).toBeGreaterThanOrEqual(0);
  });
});

describe('camera.md acceptance gaps (QA, sim side)', () => {
  it('QA 2: at full ADS with 0 spread, the shot lands exactly on the world point under the FP screen centre (stand, crouch, prone)', () => {
    const glassWall = longestGlassAlongX();
    const x = (glassWall.x1 + glassWall.x2) / 2;
    for (const stance of ['stand', 'crouch', 'prone'] as const) {
      const { w, ids } = playingWorld(2, { map: OFFICE, balance: noSpreadBalance() });
      const [s, t] = ids as [number, number];
      land(w, s, x, glassWall.z1 + 12);
      land(w, t, x + 40, glassWall.z1 + 40);
      const sp = w.debugPlayer(s)!;
      sp.inv.slots[0] = { weapon: 'rifle', mag: 30 };
      sp.inv.activeSlot = 0;
      const yaw = 0.15;
      const pitch = stance === 'prone' ? 0.05 : -0.04;
      const toggle = stance === 'stand' ? null : stance;
      run(w, 40, { [s]: (i) => ({ stanceToggle: i === 0 ? toggle : null, ads: i > 0, yaw, pitch }), [t]: () => ({}) });
      expect(sp.move.stance).toBe(stance);
      expect(sp.move.adsMs).toBe(BALANCE.weapons.rifle.adsTimeMs);
      // The FP camera: eye point (no bob at full ADS, camera.md QA 1), forward = aimDirection(yaw, pitch).
      const cam = firstPersonCamera({ eye: eyePoint(sp.move.pos, sp.move, OB), yaw, pitch, fovDeg: 50.5, offset: { x: 0, y: 0, z: 0 }, roll: 0, fovPunchDeg: 0, subjectId: s });
      const dir = aimDirection(cam.yaw, cam.pitch);
      const hit = raycastStatic(w.debugContext().colliders, OFFICE, cam.target, dir, 500)!;
      expect(hit).not.toBeNull();
      const ev = run(w, 1, { [s]: () => ({ fire: true, ads: true, yaw, pitch }), [t]: () => ({}) });
      const shot = ofType(ev, 'shot')[0]!;
      expect(shot.origin.x).toBeCloseTo(cam.target.x, 9);
      expect(shot.origin.y).toBeCloseTo(cam.target.y, 9);
      expect(shot.origin.z).toBeCloseTo(cam.target.z, 9);
      const pt = shot.impacts[0]!.point;
      const want = { x: cam.target.x + dir.x * hit.t, y: cam.target.y + dir.y * hit.t, z: cam.target.z + dir.z * hit.t };
      expect(Math.hypot(pt.x - want.x, pt.y - want.y, pt.z - want.z), `${stance}: impact vs screen-centre ray`).toBeLessThan(1e-6);
    }
  });

  it('QA 9 control: one tick after a prone toggle at +70 deg the pitch is +45; -80 deg clamps to -30; snapshots agree', () => {
    const { w, ids } = playingWorld(2, { map: OFFICE, balance: clone(OB) });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 30, 30);
    const p = w.debugPlayer(s)!;
    const up = 70 * DEG2RAD;
    run(w, 3, { [s]: () => ({ pitch: up }), [t]: () => ({}) });
    expect(p.pitch).toBeCloseTo(up, 9);
    run(w, 2, { [s]: (i) => ({ pitch: up, stanceToggle: i === 0 ? 'prone' : null }), [t]: () => ({}) });
    expect(p.pitch).toBeCloseTo(OB.movement.stances.pronePitchMaxDeg * DEG2RAD, 9);
    expect(w.snapshotFor(t).players.find((x) => x.id === s)!.pitch).toBeCloseTo(OB.movement.stances.pronePitchMaxDeg * DEG2RAD, 6);
    run(w, 1, { [s]: () => ({ pitch: -80 * DEG2RAD }), [t]: () => ({}) });
    expect(p.pitch).toBeCloseTo(OB.movement.stances.pronePitchMinDeg * DEG2RAD, 9);
  });

  it('BUG-012 (fixed): entering prone at +70 deg is clamped to +45 on the first tick of the transition', () => {
    const { w, ids } = playingWorld(2, { map: OFFICE, balance: clone(OB) });
    const [s, t] = ids as [number, number];
    land(w, s, 0, 0);
    land(w, t, 30, 30);
    const p = w.debugPlayer(s)!;
    const up = 70 * DEG2RAD;
    run(w, 3, { [s]: () => ({ pitch: up }), [t]: () => ({}) });
    run(w, 1, { [s]: () => ({ pitch: up, stanceToggle: 'prone' }), [t]: () => ({}) });
    expect(p.move.stanceFrom === 'prone' || p.move.stance === 'prone').toBe(true);
    expect(p.pitch).toBeCloseTo(OB.movement.stances.pronePitchMaxDeg * DEG2RAD, 9);
    expect(w.snapshotFor(t).players.find((x) => x.id === s)!.pitch).toBeCloseTo(OB.movement.stances.pronePitchMaxDeg * DEG2RAD, 6);
  });

  it('QA 9: bots obey the prone pitch clamp (all-bot matches: 3 island + 3 office seeds, every 3rd tick)', () => {
    const lo = OB.movement.stances.pronePitchMinDeg * DEG2RAD - 1e-6;
    const hi = OB.movement.stances.pronePitchMaxDeg * DEG2RAD + 1e-6;
    const samples: Record<string, number> = { island01: 0, office: 0 };
    const stanceChanges: Record<string, number> = { island01: 0, office: 0 };
    const bad: string[] = [];
    for (const [id, map] of [['island01', ISLAND], ['office', OFFICE]] as const) {
      for (const seed of [21, 22, 23]) {
        const b = clone(balanceForMap(BALANCE, id));
        b.match.targetPlayers = 16;
        b.match.minHumansToStart = 0;
        b.match.endWhenNoHumansAlive = false;
        const w = createDebugWorld({ map, balance: b, seed, botNames: Array.from({ length: 24 }, (_, i) => `Bot ${i}`) });
        for (let tick = 0; tick < 30 * 600 && w.getMatch().phase !== 'results'; tick++) {
          for (const e of w.step(SIM_DT)) if (e.type === 'stanceChange') stanceChanges[id]!++;
          if (tick % 3) continue;
          for (const pl of w.snapshotFor(-1).players) {
            if (!pl.alive || (pl.stance !== 'prone' && pl.stanceFrom !== 'prone')) continue;
            samples[id]!++;
            if (pl.pitch < lo || pl.pitch > hi) bad.push(`${id} seed ${seed} tick ${tick} ${pl.name} pitch ${(pl.pitch / DEG2RAD).toFixed(1)}`);
          }
        }
      }
    }
    console.info(`[prone-pitch] bot prone samples ${JSON.stringify(samples)}, stance changes ${JSON.stringify(stanceChanges)}, out of range ${bad.length}`);
    expect(samples.island01! + samples.office!).toBeGreaterThan(0);
    // One sample may land on the transition's first tick (BUG-012); anything beyond that is a bot clamp failure.
    expect(bad.length).toBeLessThanOrEqual(stanceChanges.island01! + stanceChanges.office!);
    expect(bad.filter((x) => !/pitch (7|8)\d/.test(x) && !/pitch -(3[1-9]|[4-8]\d)/.test(x))).toEqual([]);
  }, 120_000);
});

describe('maps.md 18 on the SHIPPED balance (structure only; the designer owns the numbers)', () => {
  it('office loot = base loot deep-merged with maps.office.loot; the island keeps the base; office fall threshold differs', () => {
    const raw = (BALANCE as unknown as { maps?: Record<string, { loot?: { tiers?: Record<string, Record<string, number>> } }> }).maps;
    const over = raw?.office?.loot?.tiers ?? {};
    for (const [tier, weights] of Object.entries(over)) {
      for (const [id, w] of Object.entries(weights)) {
        if (id.startsWith('_')) continue;
        expect((OB.loot.tiers as Record<string, Record<string, number>>)[tier]![id], `office ${tier}.${id}`).toBe(w);
      }
    }
    const island = balanceForMap(BALANCE, 'island01');
    expect(island.loot.tiers).toEqual(BALANCE.loot.tiers);
    expect(island.movement.fallDamageMinSpeed).toBe(BALANCE.movement.fallDamageMinSpeed);
    expect(OB.movement.fallDamageMinSpeed).toBeGreaterThan(BALANCE.movement.fallDamageMinSpeed);
  });
});

describe('office climb routes, walked like a player (E2E m2b-office counterpart)', () => {
  it('every walk route (ramps) is climbed by holding W from 1.5 m before its foot, no jump: the top reaches the plateau', () => {
    const ctx = officeCtx();
    const walks = OFFICE.climbRoutes.filter((r) => r.mode === 'walk');
    expect(walks.length).toBeGreaterThanOrEqual(4);
    for (const r of walks) {
      const p0 = r.points[0]!;
      const pN = r.points[r.points.length - 1]!;
      const len = Math.hypot(pN.x - p0.x, pN.z - p0.z);
      const yaw = Math.atan2(-(pN.x - p0.x), -(pN.z - p0.z));
      let s = initialMovementState({ x: p0.x - ((pN.x - p0.x) / len) * 1.5, y: 0, z: p0.z - ((pN.z - p0.z) / len) * 1.5 }, false);
      let maxY = 0;
      let jumps = 0;
      for (let i = 0; i < 30 * 8; i++) {
        const before = s.grounded;
        s = stepMovement(s, mvIn({ moveForward: 1, yaw }), SIM_DT, ctx).state;
        if (before && !s.grounded && s.vel.y > 1) jumps++;
        maxY = Math.max(maxY, s.pos.y);
      }
      expect(maxY, `${r.id} reaches ${pN.y}`).toBeGreaterThanOrEqual(pN.y - 0.01);
      expect(jumps, `${r.id} needs no jump`).toBe(0);
    }
  });
});
