import { describe, expect, it } from 'vitest';
import { BALANCE } from '../shared/balance';
import type { GameEvents } from '../shared/events';
import { carrierHeading, carrierPosAt } from '../shared/maps';
import { initialMovementState } from '../shared/sim/movement';
import type { DropRoute, MovementState } from '../shared/types';
import { buildDropHud, buildRouteView, canJumpAt, CarrierDepartTracker, jumpState, localAboard, matchRoute, moveDrop } from './drop';
import { makeLocal, makeMatch, makeMovement, TEST_MAP } from './testFixtures';

const ROUTE: DropRoute = {
  mapId: 'test', entry: { x: -100, z: 0 }, exit: { x: 100, z: 0 }, eject: { x: 80, z: 0 },
  altitude: 120, speed: 10, startsAt: 1000, noJumpUntil: 4000, ejectAt: 19_000, endsAt: 21_000,
};
const B = BALANCE;

describe('drop helpers', () => {
  it('C-gate accessors read optional fields', () => {
    expect(localAboard(makeLocal(1))).toBe(false);
    expect(localAboard(Object.assign(makeLocal(1), { aboard: true }))).toBe(true);
    expect(matchRoute(makeMatch())).toBeNull();
    expect(matchRoute(Object.assign(makeMatch(), { route: ROUTE }))).toBe(ROUTE);
    expect(moveDrop(makeMovement())).toEqual({ dropPhase: null, dropMs: 0 });
    expect(moveDrop(Object.assign(makeMovement({ dropping: true }), { dropPhase: 'chute', dropMs: 9 }))).toEqual({ dropPhase: 'chute', dropMs: 9 });
  });

  it('jump: allowed from noJumpUntil; freefall at the carrier position, zero velocity', () => {
    expect(canJumpAt(ROUTE, 3999)).toBe(false);
    expect(canJumpAt(ROUTE, 4000)).toBe(true);
    const s = jumpState(ROUTE, 5000);
    const c = carrierPosAt(ROUTE, 5000);
    expect(s).toMatchObject({ pos: { x: c.x, y: 120, z: c.z }, vel: { x: 0, y: 0, z: 0 }, dropping: true, grounded: false, dropPhase: 'freefall', dropMs: 0 });
  });

  it('aboard HUD: countdowns, aboard count, carrier altitude', () => {
    const v = buildDropHud({ aboard: true, route: ROUTE, now: 2100, aboardCount: 7, movement: null, map: TEST_MAP, balance: B });
    expect(v).toEqual({ stage: 'aboard', noJumpSecondsLeft: 2, ejectSecondsLeft: 17, aboardCount: 7, altitude: 120, deployHeight: B.drop.chuteDeployHeight, canDeploy: false });
    expect(buildDropHud({ aboard: true, route: ROUTE, now: 5000, aboardCount: 1, movement: null, map: TEST_MAP, balance: B })!.noJumpSecondsLeft).toBe(0);
  });

  it('freefall / chute HUD: altitude above the terrain, canDeploy after minFreefallMs; null on foot', () => {
    const ff = (dropMs: number): MovementState => Object.assign(initialMovementState({ x: 0, y: 50, z: 0 }, true, 'freefall'), { dropMs });
    const early = buildDropHud({ aboard: false, route: ROUTE, now: 0, aboardCount: 0, movement: ff(100), map: TEST_MAP, balance: B })!;
    expect(early).toMatchObject({ stage: 'freefall', canDeploy: false });
    expect(early.altitude).toBeCloseTo(50 - TEST_MAP.baseHeight);
    expect(buildDropHud({ aboard: false, route: ROUTE, now: 0, aboardCount: 0, movement: ff(B.drop.minFreefallMs), map: TEST_MAP, balance: B })!.canDeploy).toBe(B.drop.manualDeploy);
    const chute = Object.assign(initialMovementState({ x: 0, y: 20, z: 0 }, true, 'chute'), { dropMs: 3000 });
    expect(buildDropHud({ aboard: false, route: ROUTE, now: 0, aboardCount: 0, movement: chute, map: TEST_MAP, balance: B })).toMatchObject({ stage: 'chute', canDeploy: false });
    expect(buildDropHud({ aboard: false, route: ROUTE, now: 0, aboardCount: 0, movement: makeMovement(), map: TEST_MAP, balance: B })).toBeNull();
    expect(buildDropHud({ aboard: false, route: ROUTE, now: 0, aboardCount: 0, movement: null, map: TEST_MAP, balance: B })).toBeNull();
  });

  it('route view: line and eject always; carrier only between startsAt and endsAt', () => {
    expect(buildRouteView(null, 0)).toBeNull();
    expect(buildRouteView(ROUTE, 500)).toEqual({ from: ROUTE.entry, to: ROUTE.exit, eject: ROUTE.eject, carrier: null });
    const v = buildRouteView(ROUTE, 11_000)!;
    expect(v.carrier).toEqual({ pos: carrierPosAt(ROUTE, 11_000), heading: carrierHeading(ROUTE) });
    expect(buildRouteView(ROUTE, 21_001)!.carrier).toBeNull();
  });

  it('carrierDeparted once per route when the clock passes startsAt; not for late joiners after endsAt', () => {
    const out: GameEvents['carrierDeparted'][] = [];
    const bus = { emit: (_t: 'carrierDeparted', p: GameEvents['carrierDeparted']) => void out.push(p) } as never;
    const t = new CarrierDepartTracker();
    t.update(ROUTE, 1, 999, bus);
    t.update(ROUTE, 1, 1000, bus);
    t.update(ROUTE, 1, 1500, bus);
    expect(out).toEqual([{ route: ROUTE }]);
    t.update({ ...ROUTE, startsAt: 30_000, endsAt: 50_000 }, 2, 31_000, bus);
    expect(out).toHaveLength(2);
    const late = new CarrierDepartTracker();
    late.update(ROUTE, 1, 25_000, bus);
    expect(out).toHaveLength(2);
  });
});
