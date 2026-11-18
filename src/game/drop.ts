/**
 * Client side of the carrier drop (drop.md, ADR 0005 §8). Owner: game-developer.
 *
 * - Small accessors for the drop fields of LocalPlayerState, PlayerState, MatchState and MovementState.
 * - HudDropView (aboard countdowns, aboard count, altitude, deploy height, canDeploy) and MinimapRouteView.
 * - CarrierDepartTracker: `carrierDeparted` once per route when serverNow passes route.startsAt.
 * - The predicted carrier jump (World.processAboard): freefall at carrierPosAt(route, now), zero velocity, no movement
 *   step on the jump tick, allowed from route.noJumpUntil.
 */
import type { Balance } from '../shared/balance';
import type { HudDropView, MinimapRouteView } from '../shared/contracts';
import { carrierHeading, carrierPosAt } from '../shared/maps';
import { TIMER_EPSILON_MS } from '../shared/sim/actions';
import { initialMovementState, type DropAwareMovementState } from '../shared/sim/movement';
import { heightAt } from '../shared/sim/terrain';
import type {
  AnyMapData,
  DropMovementFields,
  DropPhase,
  DropRoute,
  LocalPlayerState,
  MatchState,
  MovementState,
  PlayerState,
} from '../shared/types';
import type { Bus } from './derived';

// ---- accessors (the drop fields are on the state types since the C-gate) ----

export const localAboard = (l: LocalPlayerState | null | undefined): boolean => l?.aboard === true;
export const playerAboard = (p: PlayerState | null | undefined): boolean => p?.aboard === true;
export const playerDropPhase = (p: PlayerState): DropPhase | null => p.dropPhase;
export const matchRoute = (m: MatchState | null | undefined): DropRoute | null => m?.route ?? null;
export const matchAboardCount = (m: MatchState | null | undefined): number => m?.aboardCount ?? 0;
export const matchMapId = (m: MatchState | null | undefined): string | null => m?.mapId ?? null;
export function moveDrop(m: MovementState): DropMovementFields {
  return { dropPhase: m.dropping ? m.dropPhase : null, dropMs: m.dropMs };
}

// ---- jump ----

/** A jump edge at server ms `now` would leave the carrier (World.processAboard: on or after noJumpUntil). */
export const canJumpAt = (route: DropRoute, now: number): boolean => now >= route.noJumpUntil - TIMER_EPSILON_MS;

/** Movement state right after a carrier jump at `now` (freefall at the carrier, zero velocity). */
export function jumpState(route: DropRoute, now: number): DropAwareMovementState {
  const c = carrierPosAt(route, now);
  return initialMovementState({ x: c.x, y: route.altitude, z: c.z }, true, 'freefall');
}

// ---- views ----

const secondsUntil = (at: number, now: number): number => Math.max(0, Math.ceil((at - now) / 1000));

export interface DropHudInput {
  /** The local player is aboard (snapshot) and no jump is predicted. */
  aboard: boolean;
  route: DropRoute | null;
  now: number;
  aboardCount: number;
  /** Predicted (or snapshot) movement of the live local player; null when not a live participant. */
  movement: MovementState | null;
  map: AnyMapData;
  balance: Balance;
}

/** HudView.drop: null when the local player is neither aboard nor dropping in a carrier drop phase. */
export function buildDropHud(i: DropHudInput): HudDropView | null {
  const d = i.balance.drop;
  if (i.aboard) {
    return {
      stage: 'aboard',
      noJumpSecondsLeft: i.route ? secondsUntil(i.route.noJumpUntil, i.now) : 0,
      ejectSecondsLeft: i.route ? secondsUntil(i.route.ejectAt, i.now) : 0,
      aboardCount: i.aboardCount,
      altitude: i.route ? i.route.altitude : d.carrierAltitude,
      deployHeight: d.chuteDeployHeight,
      canDeploy: false,
    };
  }
  const m = i.movement;
  if (!m || !m.dropping) return null;
  const { dropPhase, dropMs } = moveDrop(m);
  if (dropPhase === null) return null;
  return {
    stage: dropPhase,
    noJumpSecondsLeft: 0,
    ejectSecondsLeft: 0,
    aboardCount: i.aboardCount,
    altitude: Math.max(0, m.pos.y - heightAt(m.pos.x, m.pos.z, i.map)),
    deployHeight: d.chuteDeployHeight,
    canDeploy: dropPhase === 'freefall' && d.manualDeploy && dropMs >= d.minFreefallMs,
  };
}

/** HudMinimapView.route: the dashed line, the eject marker and the carrier (null outside startsAt..endsAt). */
export function buildRouteView(route: DropRoute | null, now: number): MinimapRouteView | null {
  if (!route) return null;
  const flying = now >= route.startsAt && now <= route.endsAt;
  return {
    from: { ...route.entry },
    to: { ...route.exit },
    eject: { ...route.eject },
    carrier: flying ? { pos: carrierPosAt(route, now), heading: carrierHeading(route) } : null,
  };
}

/** carrierDeparted once per route, when the server clock passes route.startsAt. */
export class CarrierDepartTracker {
  private emittedFor: string | null = null;

  reset(): void {
    this.emittedFor = null;
  }

  update(route: DropRoute | null, matchId: number | null, now: number, bus: Bus): void {
    if (!route || now < route.startsAt) return;
    const key = `${matchId ?? ''}:${route.mapId}:${route.startsAt}`;
    if (key === this.emittedFor) return;
    this.emittedFor = key;
    // Late joiners after the carrier is gone get nothing.
    if (now > route.endsAt) return;
    bus.emit('carrierDeparted', { route });
  }
}
