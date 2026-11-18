/**
 * M2b acceptance tests on the World: the carrier drop (drop.md 1-11, sim parts), the one-match World options
 * (ADR 0006 §2: matchStart, timeOriginMs, finished), prediction equivalence through a jump and a manual deploy, and
 * BUG-010 (stall-neutral inputs). Indoor geometry lives in indoor.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Balance } from '../balance';
import { BALANCE, balanceForMap } from '../balance';
import { SIM_DT } from '../constants';
import { carrierPosAt } from '../maps';
import { createRng } from '../math';
import type { AnyMapData, DropSimEvent, PlayerInput, SimEvent } from '../types';
import { advanceActionTimers, applyActionEdges, cloneActionState, fireSlowedOf, type ActionState } from './actions';
import { initialMovementState, stepMovement, toMovementInput } from './movement';
import { drawRouteGeometry } from './route';
import { balanceWith, flatMap, input, land, noSpreadBalance, playingWorld, roomMap, run } from './testkit';
import { heightAt } from './terrain';
import { createDebugWorld, type DebugWorld, type WorldOptions } from './World';
import { activeHeld } from './inventory';
import { ISLAND } from '../../game/levels/island';

type AnyEvent = SimEvent | DropSimEvent;
type Ev<T extends AnyEvent['type']> = Extract<AnyEvent, { type: T }>;
const ofType = <T extends AnyEvent['type']>(ev: readonly unknown[], t: T): Ev<T>[] =>
  (ev as AnyEvent[]).filter((e): e is Ev<T> => e.type === t);
const TICK_MS = SIM_DT * 1000;
const ticks = (ms: number) => Math.ceil(ms / TICK_MS - 1e-9);

const OFFICE = balanceForMap(BALANCE, 'office');
/** Office-sized synthetic floor (234 x 144 m, half extents 117 x 72). */
const officeFloor = (): AnyMapData => roomMap([], [], { floor: { minX: -117, minZ: -72, maxX: 117, maxZ: 72 }, walls: [] });

/** A one-match World (matchStart) with `humans` humans and no bots; returns ids and the world in 'countdown'. */
function matchWorld(
  humans: number,
  o: { map?: AnyMapData; balance?: Balance; seed?: number; countdownMs?: number; extra?: Partial<WorldOptions> } = {},
): { w: DebugWorld; ids: number[] } {
  const w = createDebugWorld({
    map: o.map ?? flatMap(),
    balance: o.balance ?? balanceWith(() => {}),
    seed: o.seed ?? 7,
    botNames: ['Bot'],
    matchStart: { countdownMs: o.countdownMs ?? 0, fillBots: false, matchId: 5 },
    ...o.extra,
  });
  const ids: number[] = [];
  for (let i = 0; i < humans; i++) ids.push(w.addPlayer(`P${i}`)!);
  // An extra idle human so a one-player test match does not end on its first tick (last one standing).
  w.addPlayer('Idle');
  return { w, ids };
}

/** Steps until the phase is 'playing'. */
function toPlaying(w: DebugWorld): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let i = 0; i < 10_000 && w.getMatch().phase !== 'playing'; i++) ev.push(...w.step(SIM_DT));
  return ev;
}

/** Feeds `f(i)` to player `id` for n ticks (other players get nothing). */
function feed(w: DebugWorld, id: number, n: number, f: (i: number) => Partial<PlayerInput>): SimEvent[] {
  return run(w, n, { [id]: f });
}

describe('carrier route (drop.md AT1-2)', () => {
  it('AT1: same seed -> identical route; headings spread evenly over 10,000 seeds', () => {
    const map = flatMap({ islandRadius: 110, worldRadius: 135 });
    const a = drawRouteGeometry(map, BALANCE, createRng(42));
    const b = drawRouteGeometry(map, BALANCE, createRng(42));
    expect(a).toEqual(b);
    const buckets = new Array(12).fill(0) as number[];
    const N = 10_000;
    for (let s = 1; s <= N; s++) {
      const g = drawRouteGeometry(map, BALANCE, createRng(s * 7919));
      const deg = (g.heading * 180) / Math.PI;
      buckets[Math.min(11, Math.floor(deg / 30))]!++;
    }
    for (const c of buckets) expect(Math.abs(c / N - 1 / 12)).toBeLessThan(0.01);
  });

  it('AT2 island: window >= 150 m, entry/exit >= 135 m from the centre, eject within 100 m', () => {
    const map = flatMap({ islandRadius: 110, worldRadius: 135 });
    const d = BALANCE.drop;
    for (let s = 1; s <= 10_000; s++) {
      const g = drawRouteGeometry(map, BALANCE, createRng(s));
      expect(g.window).toBeGreaterThanOrEqual(d.minJumpWindowMetres - 1e-9);
      expect(Math.hypot(g.entry.x, g.entry.z)).toBeGreaterThanOrEqual(135);
      expect(Math.hypot(g.exit.x, g.exit.z)).toBeGreaterThanOrEqual(135);
      expect(Math.hypot(g.eject.x, g.eject.z)).toBeLessThanOrEqual(100 + 1e-6);
    }
  });

  it('AT2 office: window >= 90 m, entry/exit on the floor edge, eject inside the 15 m inset', () => {
    const map = officeFloor();
    const onEdge = (p: { x: number; z: number }) =>
      (Math.abs(Math.abs(p.x) - 117) < 1e-6 && Math.abs(p.z) <= 72 + 1e-6) ||
      (Math.abs(Math.abs(p.z) - 72) < 1e-6 && Math.abs(p.x) <= 117 + 1e-6);
    for (let s = 1; s <= 10_000; s++) {
      const g = drawRouteGeometry(map, OFFICE, createRng(s));
      expect(g.window).toBeGreaterThanOrEqual(OFFICE.drop.minJumpWindowMetres - 1e-9);
      expect(onEdge(g.entry)).toBe(true);
      expect(onEdge(g.exit)).toBe(true);
      expect(Math.abs(g.eject.x)).toBeLessThanOrEqual(117 - 15 + 1e-6);
      expect(Math.abs(g.eject.z)).toBeLessThanOrEqual(72 - 15 + 1e-6);
    }
  });

  it('route times: startsAt <= noJumpUntil <= ejectAt <= endsAt, and the carrier is at the eject point at ejectAt', () => {
    const { w } = matchWorld(1, { countdownMs: 3000, extra: { timeOriginMs: 50_000 } });
    const r = w.getMatch().route!;
    expect(r.startsAt).toBeLessThanOrEqual(r.noJumpUntil);
    expect(r.noJumpUntil).toBeLessThanOrEqual(r.ejectAt);
    expect(r.ejectAt).toBeLessThanOrEqual(r.endsAt);
    expect(r.noJumpUntil - r.startsAt).toBe(BALANCE.drop.noJumpMs);
    const c = carrierPosAt(r, r.ejectAt);
    expect(c.x).toBeCloseTo(r.eject.x, 6);
    expect(c.z).toBeCloseTo(r.eject.z, 6);
    expect(r.altitude).toBe(BALANCE.drop.carrierAltitude);
  });
});

describe('World options (ADR 0006 §2): matchStart, timeOriginMs, finished', () => {
  it('starts in countdown at creation with the route already drawn; timeMs = origin + tick x SIM_DT', () => {
    const origin = 123_456;
    const { w, ids } = matchWorld(1, { countdownMs: 3000, extra: { timeOriginMs: origin } });
    const m0 = w.getMatch();
    expect(m0.phase).toBe('countdown');
    expect(m0.matchId).toBe(5);
    expect(m0.mapId).toBe('test-flat');
    expect(m0.route).not.toBeNull();
    expect(w.timeMs).toBe(origin);
    w.step(SIM_DT);
    expect(w.timeMs).toBe(origin + 1 * SIM_DT * 1000);
    // A player joining after the lock (creation) gets the route too, and becomes a participant at the start.
    const late = w.addPlayer('Late')!;
    expect(w.snapshotFor(late).match).toMatchObject({ route: m0.route });
    toPlaying(w);
    const m = w.getMatch();
    expect(m.route!.startsAt).toBe(w.timeMs);
    expect(m0.route!.startsAt).toBe(w.timeMs);
    expect(w.timeMs).toBeGreaterThanOrEqual(origin + 3000);
    expect(w.timeMs - origin).toBeLessThan(3000 + TICK_MS);
    expect(m.totalPlayers).toBe(3); // 1 + the idle helper + Late; fillBots false: no bots
    expect(w.debugPlayer(late)!.aboard).toBe(true);
    expect(w.debugPlayer(ids[0]!)!.aboard).toBe(true);
  });

  it('ignores match.minHumansToStart; fillBots fills to targetPlayers; finished after results, no new lobby', () => {
    const b = balanceWith((x) => {
      x.match.minHumansToStart = 5;
      x.match.resultsSeconds = 1;
    });
    const w = createDebugWorld({
      map: flatMap(),
      balance: b,
      seed: 3,
      botNames: ['Bot'],
      matchStart: { countdownMs: 100, fillBots: true, matchId: 9 },
    });
    const h = w.addPlayer('A')!;
    toPlaying(w);
    expect(w.getMatch().totalPlayers).toBe(b.match.targetPlayers);
    for (const p of w.snapshotFor(h).players) if (p.id !== h) w.debugPlayer(p.id)!.dying = { killerId: h, weapon: 'pistol', cause: 'weapon' };
    w.step(SIM_DT);
    expect(w.getMatch().phase).toBe('results');
    expect(w.finished).toBe(false);
    for (let i = 0; i < ticks(1000) + 1; i++) w.step(SIM_DT);
    expect(w.finished).toBe(true);
    expect(w.getMatch().phase).toBe('results');
    expect(w.getMatch().matchId).toBe(9);
    expect(w.step(SIM_DT)).toEqual([]);
  });

  it('a legacy World (no matchStart) draws the route at the match start and never finishes', () => {
    const { w } = playingWorld(1, { drop: true });
    const r = w.getMatch().route!;
    expect(r).not.toBeNull();
    expect(r.startsAt).toBeLessThanOrEqual(w.timeMs);
    expect(w.finished).toBe(false);
  });

  it('runtime: a prepared map is reused (same colliders object)', async () => {
    const { prepareMap } = await import('./movement');
    const map = flatMap();
    const b = balanceWith(() => {});
    const rt = prepareMap(map, b);
    const w = createDebugWorld({ map, balance: b, seed: 1, botNames: [], runtime: rt });
    expect(w.debugContext()).toBe(rt.ctx);
    expect(rt.nav).toBeNull(); // island: no nav graph
  });
});

describe('aboard (drop.md AT4-7)', () => {
  it('AT4: everyone aboard at the carrier on the first playing tick; rays, blasts and zone damage do not touch them', () => {
    const { w, ids } = matchWorld(2, { balance: noSpreadBalance(), countdownMs: 0 });
    toPlaying(w);
    const [a, t] = ids as [number, number];
    const r = w.getMatch().route!;
    const c = carrierPosAt(r, w.timeMs);
    for (const id of ids) {
      const p = w.debugPlayer(id)!;
      expect(p.aboard).toBe(true);
      expect(p.move.pos).toEqual({ x: c.x, y: r.altitude, z: c.z });
    }
    expect(w.getMatch().aboardCount).toBe(3);
    // A shooter hovering 10 m from the aboard player at the same height, aiming straight at its chest. Players are
    // processed in id order, so the target is still where it was last tick when the shot resolves.
    const tp = w.debugPlayer(t)!;
    const hp0 = tp.hp;
    const ap = w.debugPlayer(a)!;
    ap.aboard = false;
    ap.move = initialMovementState({ x: tp.move.pos.x, y: tp.move.pos.y, z: tp.move.pos.z + 10 }, false);
    ap.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    ap.inv.activeSlot = 0;
    const ev = feed(w, a, 1, () => ({ fire: true, yaw: 0, pitch: Math.atan2(-0.6, 10) }));
    expect(ofType(ev, 'shot').length).toBe(1);
    expect(ofType(ev, 'shot')[0]!.impacts[0]!.surface).toBe('none');
    expect(ofType(ev, 'damage').length).toBe(0);
    // Blast at the aboard player's chest.
    w.debugSpawnGrenade(a, { ...tp.move.pos, y: tp.move.pos.y + 0.5 }, { x: 0, y: 0, z: 0 }, 1);
    const blast = run(w, 2);
    expect(ofType(blast, 'explosion').length).toBe(1);
    expect(ofType(blast, 'damage').filter((d) => d.victimId === t)).toEqual([]);
    // Zone damage: force a zero-radius circle far away.
    const z = w.debugZone()!;
    z.state.center = { x: 1000, z: 1000 };
    z.state.radius = 0;
    z.state.dps = 50;
    ap.hp = 1e9;
    const zev = run(w, ticks(2000));
    expect(ofType(zev, 'damage').filter((d) => d.victimId === t)).toEqual([]);
    expect(tp.hp).toBe(hp0);
    expect(tp.aboard).toBe(true);
  });

  it('AT5: fire, reload, heal, pickup, slot and stance inputs do nothing aboard; position follows the carrier', () => {
    const { w, ids } = matchWorld(1, { countdownMs: 0 });
    toPlaying(w);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 10 };
    p.inv.ammo.ammo_light = 30;
    p.inv.ammo.ammo_heavy = 30;
    p.inv.heals.bandage = 3;
    p.hp = 50;
    const r = w.getMatch().route!;
    for (let i = 0; i < 20; i++) {
      const ev = feed(w, id, 1, (k) => ({
        fire: true,
        reload: true,
        useHeal: true,
        interact: true,
        selectSlot: 0,
        stanceToggle: 'prone',
        moveForward: 1,
        sprint: true,
        yaw: 1 + k,
        pitch: 0.3,
      }));
      expect(ev.filter((e) => e.type !== 'spawn')).toEqual([]);
      const c = carrierPosAt(r, w.timeMs);
      expect(p.move.pos).toEqual({ x: c.x, y: r.altitude, z: c.z });
      expect(p.yaw).toBeCloseTo(1, 9); // look works
    }
    expect(p.inv.activeSlot).toBe(2);
    expect(p.move.stance).toBe('stand');
    expect(p.hp).toBe(50);
  });

  it('AT6: a jump edge before noJumpUntil is ignored; after it the player is in freefall at the carrier, zero horizontal velocity', () => {
    const { w, ids } = matchWorld(1, { countdownMs: 0 });
    toPlaying(w);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    const r = w.getMatch().route!;
    // Step to the tick at or before noJumpUntil - 100 ms (2900 ms on the island).
    while (w.timeMs + TICK_MS <= r.noJumpUntil - 100) feed(w, id, 1, () => ({}));
    const early = feed(w, id, 1, () => ({ jump: true }));
    expect(ofType(early, 'dropJump')).toEqual([]);
    expect(p.aboard).toBe(true);
    while (w.timeMs + TICK_MS < r.noJumpUntil) feed(w, id, 1, () => ({}));
    const ev = feed(w, id, 1, () => ({ jump: true }));
    const j = ofType(ev, 'dropJump');
    expect(j.length).toBe(1);
    expect(j[0]).toMatchObject({ playerId: id, auto: false });
    const c = carrierPosAt(r, w.timeMs);
    expect(p.aboard).toBe(false);
    expect(p.move.pos).toEqual({ x: c.x, y: r.altitude, z: c.z });
    expect(p.move.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.move.dropPhase).toBe('freefall');
    expect(p.move.dropping).toBe(true);
    expect(w.getMatch().aboardCount).toBe(1); // the idle helper is still aboard
  });

  it('AT7: nobody jumps -> everyone is ejected on the tick the carrier reaches the eject point', () => {
    const { w, ids } = matchWorld(3, { countdownMs: 0 });
    toPlaying(w);
    const r = w.getMatch().route!;
    const ev: SimEvent[] = [];
    let ejectTick = -1;
    while (w.getMatch().aboardCount > 0) {
      const e = w.step(SIM_DT);
      if (ofType(e, 'dropJump').length > 0 && ejectTick < 0) ejectTick = w.timeMs;
      ev.push(...e);
    }
    const jumps = ofType(ev, 'dropJump');
    expect(jumps.length).toBe(4);
    expect(jumps.every((j) => j.auto)).toBe(true);
    expect(ejectTick).toBeGreaterThanOrEqual(r.ejectAt - 1e-6);
    expect(ejectTick).toBeLessThan(r.ejectAt + TICK_MS);
    for (const id of ids) expect(w.debugPlayer(id)!.move.dropPhase).toBe('freefall');
  });

  it('a manual jump on the eject tick stays manual (auto: false)', () => {
    const { w, ids } = matchWorld(2, { countdownMs: 0 });
    toPlaying(w);
    const r = w.getMatch().route!;
    while (w.timeMs + TICK_MS < r.ejectAt - 1e-6) w.step(SIM_DT);
    const ev = run(w, 1, { [ids[0]!]: () => ({ jump: true }) });
    const j = ofType(ev, 'dropJump');
    expect(j.find((e) => e.playerId === ids[0])!.auto).toBe(false);
    expect(j.find((e) => e.playerId === ids[1])!.auto).toBe(true);
  });

  it('disconnect aboard: eliminated as "left", nothing dropped', () => {
    const { w, ids } = matchWorld(3, { countdownMs: 0 });
    toPlaying(w);
    const lootBefore = w.debugLoot().length;
    w.removePlayer(ids[0]!);
    w.step(SIM_DT);
    expect(w.debugLoot().length).toBe(lootBefore);
    expect(w.getMatch().aliveCount).toBe(3);
  });
});

/**
 * Jumps player `id` (aboard) at the first allowed tick (`nearCentre`: the first allowed tick at or after the carrier's
 * closest approach to the map centre, so the whole fall is over flat ground); returns the World time of the jump.
 */
function jumpNow(w: DebugWorld, id: number, nearCentre = false): number {
  const r = w.getMatch().route!;
  let at = r.noJumpUntil;
  if (nearCentre) {
    const dx = r.exit.x - r.entry.x;
    const dz = r.exit.z - r.entry.z;
    const u = Math.max(0, Math.min(1, -(r.entry.x * dx + r.entry.z * dz) / (dx * dx + dz * dz)));
    at = Math.max(at, r.startsAt + u * (r.endsAt - r.startsAt));
  }
  for (let i = 0; i < 100_000 && w.timeMs + TICK_MS < at; i++) feed(w, id, 1, () => ({}));
  feed(w, id, 1, () => ({ jump: true }));
  expect(w.debugPlayer(id)!.aboard).toBe(false);
  return w.timeMs;
}

describe('freefall and parachute (drop.md AT8-11)', () => {
  it('AT8 island: freefall 30 m/s, auto-deploy at y <= 42, parachute 8 m/s, lands ~7.6 s after the jump, no damage', () => {
    // A flat island at ground 2 under the whole route.
    const map = flatMap({ islandRadius: 300, worldRadius: 330 });
    const { w, ids } = matchWorld(1, { map, countdownMs: 0 });
    toPlaying(w);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    const t0 = jumpNow(w, id, true);
    const hp0 = p.hp;
    let deployY = NaN;
    let landedAt = NaN;
    for (let i = 0; i < ticks(12_000) && Number.isNaN(landedAt); i++) {
      const y0 = p.move.pos.y;
      const ev = feed(w, id, 1, () => ({}));
      const c = ofType(ev, 'chuteOpen');
      if (c.length > 0) {
        deployY = y0;
        expect(c[0]!.manual).toBe(false);
        expect(p.move.vel.y).toBe(-BALANCE.movement.dropFallSpeed);
      } else if (p.move.dropPhase === 'freefall') expect(p.move.vel.y).toBe(-BALANCE.drop.freefallSpeed);
      if (!p.move.dropping) landedAt = w.timeMs;
    }
    expect(deployY).toBeLessThanOrEqual(2 + BALANCE.drop.chuteDeployHeight + 1e-9);
    expect(deployY).toBeGreaterThan(2 + BALANCE.drop.chuteDeployHeight - BALANCE.drop.freefallSpeed * SIM_DT - 1e-9);
    expect(Math.abs(landedAt - t0 - 7600)).toBeLessThanOrEqual(TICK_MS + 1e-6);
    expect(p.hp).toBe(hp0);
    expect(p.move.dropPhase).toBeNull();
    expect(p.move.dropMs).toBe(0);
  });

  it('AT9: a jump edge at dropMs 400 does nothing, at 600 opens the parachute; max reach ~81 m (auto) vs ~123 m (early)', () => {
    const map = flatMap({ islandRadius: 400, worldRadius: 430 });
    const reach = (deployAtMs: number | null): { dist: number; manual: boolean | null } => {
      const { w, ids } = matchWorld(1, { map, countdownMs: 0 });
      toPlaying(w);
      const id = ids[0]!;
      const p = w.debugPlayer(id)!;
      jumpNow(w, id, true);
      const start = { ...p.move.pos };
      let manual: boolean | null = null;
      let pressedEarly = false;
      for (let i = 0; i < ticks(20_000) && p.move.dropping; i++) {
        const pre = p.move.dropMs;
        let jump = false;
        if (deployAtMs !== null && !pressedEarly && pre >= 400 - 1e-9 && pre < 400 + TICK_MS) {
          jump = true; // dropMs 400: ignored
          pressedEarly = true;
        } else if (deployAtMs !== null && manual === null && pre >= deployAtMs - 1e-9) jump = true;
        const ev = feed(w, id, 1, () => ({ moveForward: 1, yaw: 0, jump }));
        if (jump && pre < 500) expect(ofType(ev, 'chuteOpen')).toEqual([]);
        const c = ofType(ev, 'chuteOpen');
        if (c.length > 0) manual = c[0]!.manual;
      }
      return { dist: Math.hypot(p.move.pos.x - start.x, p.move.pos.z - start.z), manual };
    };
    const auto = reach(null);
    expect(auto.manual).toBe(false);
    expect(Math.abs(auto.dist - 81)).toBeLessThanOrEqual(3);
    const early = reach(600);
    expect(early.manual).toBe(true);
    expect(Math.abs(early.dist - 123)).toBeLessThanOrEqual(3);
  });

  it('AT10 / maps.md 10 office: drone at y 25, freefall 15 m/s, deploy at y <= 10, lands ~2.25 s later with no damage (floor and desk top)', () => {
    for (const onDesk of [false, true]) {
      const map = roomMap([], [], { floor: { minX: -117, minZ: -72, maxX: 117, maxZ: 72 }, walls: [] });
      const { w, ids } = matchWorld(1, { map, balance: OFFICE, countdownMs: 0 });
      toPlaying(w);
      const r = w.getMatch().route!;
      expect(r.altitude).toBe(25);
      const id = ids[0]!;
      const p = w.debugPlayer(id)!;
      const t0 = jumpNow(w, id);
      if (onDesk) {
        // Put a desk under the jump point (colliders are rebuilt from a patched map copy).
        const desk = { kind: 'desk', x: p.move.pos.x, y: 0, z: p.move.pos.z, rotY: 0, scale: 1 };
        const map2 = { ...map, props: [desk] };
        const w2 = createDebugWorld({ map: map2, balance: OFFICE, seed: 7, botNames: [], matchStart: { countdownMs: 0, fillBots: false, matchId: 5 } });
        const id2 = w2.addPlayer('A')!;
        w2.addPlayer('Idle');
        toPlaying(w2);
        const t2 = jumpNow(w2, id2);
        const p2 = w2.debugPlayer(id2)!;
        let landed = NaN;
        for (let i = 0; i < ticks(5000) && Number.isNaN(landed); i++) {
          feed(w2, id2, 1, () => ({}));
          if (!p2.move.dropping) landed = w2.timeMs;
        }
        expect(p2.move.pos.y).toBeCloseTo(6.66, 6);
        expect(p2.hp).toBe(OFFICE.player.maxHp);
        // 15 m freefall at 15 m/s + (10 - 6.66) m at 8 m/s.
        expect(Math.abs(landed - t2 - (1000 + (3.34 / 8) * 1000))).toBeLessThanOrEqual(TICK_MS + 1e-6);
        continue;
      }
      let deployY = NaN;
      let landed = NaN;
      for (let i = 0; i < ticks(5000) && Number.isNaN(landed); i++) {
        const y0 = p.move.pos.y;
        const ev = feed(w, id, 1, () => ({}));
        if (ofType(ev, 'chuteOpen').length > 0) deployY = y0;
        else if (p.move.dropPhase === 'freefall') expect(p.move.vel.y).toBe(-15);
        if (!p.move.dropping) landed = w.timeMs;
      }
      expect(deployY).toBeLessThanOrEqual(10 + 1e-9);
      expect(Math.abs(landed - t0 - 2250)).toBeLessThanOrEqual(TICK_MS + 1e-6);
      expect(p.hp).toBe(OFFICE.player.maxHp);
    }
  });

  it('AT11: freefall players cannot be hit and cannot fire, pick up or heal', () => {
    const map = flatMap({ islandRadius: 300, worldRadius: 330 });
    const { w, ids } = matchWorld(2, { map, balance: noSpreadBalance(), countdownMs: 0 });
    toPlaying(w);
    const [a, t] = ids as [number, number];
    jumpNow(w, t);
    const tp = w.debugPlayer(t)!;
    expect(tp.move.dropPhase).toBe('freefall');
    tp.inv.slots[0] = { weapon: 'rifle', mag: 30 };
    tp.inv.activeSlot = 0;
    tp.inv.heals.bandage = 2;
    tp.hp = 40;
    const ev = feed(w, t, 3, () => ({ fire: true, useHeal: true, interact: true }));
    expect(ofType(ev, 'shot')).toEqual([]);
    expect(ofType(ev, 'healStart')).toEqual([]);
    // A grounded shooter aiming straight at the falling player.
    land(w, a, tp.move.pos.x, tp.move.pos.z + 5);
    const ap = w.debugPlayer(a)!;
    ap.inv.slots[0] = { weapon: 'sniper', mag: 5 };
    ap.inv.activeSlot = 0;
    const eyeY = ap.move.pos.y + BALANCE.player.eyeHeight;
    const pitch = Math.atan2(tp.move.pos.y + 0.6 - eyeY, 5);
    const shots = run(w, 1, { [a]: () => ({ fire: true, pitch }), [t]: () => ({}) });
    expect(ofType(shots, 'shot').length).toBe(1);
    expect(ofType(shots, 'damage')).toEqual([]);
  });
});

describe('prediction equivalence through a jump and a manual deploy', () => {
  it('the shared movement step from the post-jump state reproduces the World tick for tick', () => {
    const map = flatMap({ islandRadius: 300, worldRadius: 330 });
    const b = balanceWith(() => {});
    const { w, ids } = matchWorld(1, { map, balance: b, countdownMs: 0 });
    toPlaying(w);
    const id = ids[0]!;
    const p = w.debugPlayer(id)!;
    jumpNow(w, id);
    // The client's predicted state at the jump: freefall at the carrier position (ADR 0005 §8).
    let pred = initialMovementState({ ...p.move.pos }, true, 'freefall');
    expect(pred).toEqual(p.move);
    const status = { alive: true, healing: false, reloading: false, held: activeHeld(p.inv), swapping: false, fireSlowed: false };
    let chuteManual = 0;
    for (let i = 0; i < ticks(15_000) && p.move.dropping; i++) {
      const inp = input({ moveForward: i % 40 < 30 ? 1 : 0, moveRight: i % 17 < 5 ? -1 : 0.5, yaw: Math.sin(i * 0.05), jump: i === 20 || i === 40 });
      const res = stepMovement(pred, toMovementInput(inp, status, b), SIM_DT, w.debugContext());
      pred = res.state;
      const ev = feed(w, id, 1, () => inp);
      if (ofType(ev, 'chuteOpen').some((c) => c.manual)) {
        chuteManual++;
        expect(res.chuteOpened).toBe('manual');
      }
      expect(p.move).toEqual(pred);
    }
    expect(chuteManual).toBe(1);
    expect(p.move.dropping).toBe(false);
    expect(pred.dropping).toBe(false);
  });
});

describe('determinism', () => {
  it('two island Worlds with the same seed and inputs produce identical snapshots (bots, drop, zone)', () => {
    const make = () => {
      const w = createDebugWorld({ map: ISLAND, balance: balanceWith(() => {}), seed: 99, botNames: ['A', 'B', 'C'], matchStart: { countdownMs: 0, fillBots: true, matchId: 1 } });
      const h = w.addPlayer('H')!;
      return { w, h };
    };
    const x = make();
    const y = make();
    for (let i = 0; i < ticks(20_000); i++) {
      const inp = input({ seq: i + 1, moveForward: 1, yaw: Math.sin(i * 0.003), jump: i === 120 });
      x.w.applyInput(x.h, inp);
      y.w.applyInput(y.h, inp);
      expect(x.w.step(SIM_DT)).toEqual(y.w.step(SIM_DT));
    }
    expect(x.w.snapshotFor(x.h)).toEqual(y.w.snapshotFor(y.h));
  });
});

describe('BUG-010: a stall-neutral input is not a trigger or ADS release', () => {
  function stall(gun: 'dmr' | 'sniper', held: Partial<PlayerInput>, gap: number, after: number) {
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 80, 80);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: gun, mag: BALANCE.weapons[gun].magSize };
    p.inv.activeSlot = 0;
    p.inv.ammo[BALANCE.weapons[gun].ammo!] = 50;
    const ev: SimEvent[] = [];
    const ads: number[] = [];
    ev.push(...run(w, 1, { [id]: () => held }));
    for (let i = 0; i < gap; i++) {
      ev.push(...run(w, 1));
      ads.push(p.move.adsMs);
    }
    for (let i = 0; i < after; i++) {
      ev.push(...run(w, 1, { [id]: () => held }));
      ads.push(p.move.adsMs);
    }
    return { ev, ads };
  }
  it('a 10-tick stall holding LMB on a semi-auto fires once', () => {
    expect(ofType(stall('dmr', { fire: true }, 10, 40).ev, 'shot').length).toBe(1);
  });
  it('a 10-tick stall holding RMB keeps ADS (frozen, not reset)', () => {
    const { ads } = stall('sniper', { ads: true }, 10, 2);
    expect(ads.every((a) => a > 0)).toBe(true);
  });
  it('a real release after the stall still releases the trigger (the next press fires)', () => {
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 80, 80);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'pistol', mag: 10 };
    p.inv.activeSlot = 0;
    run(w, 1, { [id]: () => ({ fire: true }) });
    run(w, 10);
    run(w, 30, { [id]: () => ({ fire: false }) });
    expect(ofType(run(w, 1, { [id]: () => ({ fire: true }) }), 'shot').length).toBe(1);
  });
});

describe('actions.ts (REVIEW-M2a M1): the World and a cloned predictor agree', () => {
  it('reload, heal, swap and fire timers match tick for tick', () => {
    const b = noSpreadBalance();
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }), balance: b });
    const id = ids[0]!;
    land(w, id, 0, 0);
    land(w, ids[1]!, 100, 100);
    const p = w.debugPlayer(id)!;
    p.inv.slots[0] = { weapon: 'rifle', mag: 3 };
    p.inv.slots[1] = { weapon: 'pistol', mag: 2 };
    p.inv.activeSlot = 0;
    p.inv.ammo.ammo_light = 40;
    p.inv.ammo.ammo_heavy = 40;
    p.inv.heals.bandage = 2;
    p.hp = 40;
    let pred: ActionState = cloneActionState(p);
    const script = (i: number): Partial<PlayerInput> => ({
      fire: i < 20 || (i > 120 && i < 125),
      reload: i === 60,
      useHeal: i === 200,
      selectSlot: i === 100 ? 1 : i === 150 ? 0 : -1,
    });
    for (let i = 0; i < 400; i++) {
      const inp = input(script(i));
      const prevMs = w.timeMs;
      const now = w.timeMs + TICK_MS;
      const s = cloneActionState(pred);
      advanceActionTimers(s, TICK_MS, b);
      void fireSlowedOf(s, now, b);
      run(w, 1, { [id]: () => script(i) });
      applyActionEdges(s, inp, { now: w.timeMs, prevMs, after: p.move }, b);
      pred = s;
      expect(pred.inv).toEqual(p.inv);
      expect(pred.reload).toEqual(p.reload);
      expect(pred.heal).toEqual(p.heal);
      expect(pred.swapRemainingMs).toBe(p.swapRemainingMs);
      expect(pred.nextFireAt).toBe(p.nextFireAt);
      expect(pred.hp).toBe(p.hp);
    }
    expect(p.hp).toBeGreaterThan(40);
  });
});

void heightAt;
