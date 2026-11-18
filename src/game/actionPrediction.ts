/**
 * Local prediction of the action timers that change movement (REVIEW-M1 m1, M2a; REVIEW-M2a M1). Owner: game-developer.
 *
 * The rules live once in the shared action step (`src/shared/sim/actions.ts`), which `World.processPlayer` also runs.
 * This module only adds the predictor's bookkeeping around it:
 * - the predicted tick and the World's clock (`now = originMs + tick x SIM_DT x 1000`; originMs is the World's
 *   timeOriginMs, recovered from the snapshot),
 * - the fire slow-down flag for the tick's movement status (`fireSlowedOf` after the timers),
 * - the snapshot base (`actionsFromSnapshot`) plus the fields the snapshot does not carry (next shot time, last shot,
 *   trigger latch, auto-switch slot), taken from the predictor's own history at the acknowledged seq (`carry`), so a
 *   correct prediction reconciles with no correction.
 * Not predicted (rare; reconciliation corrects them): pickups that change the active weapon, damage that changes which
 * heal Q picks, server ticks that repeated an input.
 *
 * Pure and immutable from the outside: every function clones before running the (in-place) shared step.
 */
import type { Balance } from '../shared/balance';
import { SIM_DT } from '../shared/constants';
import {
  advanceActionTimers,
  applyActionEdges,
  cloneActionState,
  fireSlowedOf,
  heldOfActions,
  type ActionState,
} from '../shared/sim/actions';
import type { HeldId, LocalPlayerState, MovementState, PlayerInput, SlotIndex, WorldSnapshot } from '../shared/types';
import { GRENADE_SLOT } from '../shared/types';
import type { PredictStatus, StatusModel } from './prediction';

export interface PredictedActions extends ActionState {
  /** Predicted server tick of this state. */
  tick: number;
  /** The World's time origin (server ms of tick 0): now = originMs + tick x SIM_DT x 1000. */
  originMs: number;
  /** The fire slow-down applies to this tick's movement (computed after the timers). */
  fireSlowed: boolean;
}

/** Fields the snapshot lacks; carried from the predicted state at the acknowledged seq. */
export type CarriedActions = Pick<
  PredictedActions,
  'lastGunSlot' | 'nextFireAt' | 'lastShotAt' | 'lastShotWeapon' | 'triggerLatched' | 'prevFire'
>;

/** Server ms of a predicted tick (World: timeOriginMs + tick x SIM_DT x 1000). */
export const tickTimeMs = (tick: number, originMs = 0): number => originMs + tick * SIM_DT * 1000;

/** The World's time origin from a snapshot (serverTime is the World clock at `tick`). */
export const snapshotOriginMs = (snap: Pick<WorldSnapshot, 'tick' | 'serverTime'>): number =>
  snap.serverTime - snap.tick * SIM_DT * 1000;

/** Server ms "now" of an action state. */
export const actionsNowMs = (a: Pick<PredictedActions, 'tick' | 'originMs'>): number => tickTimeMs(a.tick, a.originMs);

/** Remaining cook fuse (ms) on the predicted timeline, or null when not cooking. */
export const cookRemainingMs = (a: PredictedActions): number | null =>
  a.cook === null ? null : Math.max(0, a.cook.explodesAt - actionsNowMs(a));

/** Item in hand. */
export const heldOf = (a: Pick<ActionState, 'inv'>): HeldId => heldOfActions(a);

const clonePredicted = (a: PredictedActions): PredictedActions => cloneActionState(a);

/**
 * Action state at snapshot time (the reconciliation base). `hp` is the local PlayerState hp, `tick` the snapshot's
 * tick and `originMs` the World's time origin (snapshotOriginMs). `carry` = the predicted state after the
 * acknowledged input (Predictor.actionsAfter), for the fields the snapshot does not have; without it they start
 * neutral (no recent shot, trigger released).
 */
export function actionsFromSnapshot(
  local: LocalPlayerState,
  hp: number,
  tick = 0,
  carry: CarriedActions | null = null,
  originMs = 0,
): PredictedActions {
  const active = local.activeSlot === 0 || local.activeSlot === 1 ? local.activeSlot : null;
  const activeGun = active === null ? null : local.slots[active];
  const cooking = local.cookExplodesAt !== null;
  let lastGunSlot: SlotIndex;
  if (local.activeSlot !== GRENADE_SLOT) lastGunSlot = local.activeSlot;
  else if (carry !== null) lastGunSlot = carry.lastGunSlot;
  else lastGunSlot = local.slots[0] ? 0 : local.slots[1] ? 1 : 2;
  return {
    hp,
    inv: {
      slots: [local.slots[0] ? { ...local.slots[0] } : null, local.slots[1] ? { ...local.slots[1] } : null],
      activeSlot: local.activeSlot,
      ammo: { ...local.ammo },
      heals: { ...local.heals },
      grenades: local.grenades,
    },
    // A reload always belongs to the active slot (switching slots cancels it).
    reload:
      local.reloadRemainingMs > 0 && activeGun && active !== null
        ? { slot: active, weapon: activeGun.weapon, remainingMs: local.reloadRemainingMs, totalMs: local.reloadTotalMs }
        : null,
    heal:
      local.healRemainingMs > 0 && local.healItem
        ? { item: local.healItem, remainingMs: local.healRemainingMs, totalMs: local.healTotalMs }
        : null,
    swapRemainingMs: local.swapRemainingMs,
    throwRecoveryMs: local.throwRecoveryMs,
    cook: cooking ? { explodesAt: local.cookExplodesAt as number } : null,
    lastGunSlot,
    nextFireAt: carry?.nextFireAt ?? 0,
    lastShotAt: carry?.lastShotAt ?? -Infinity,
    lastShotWeapon: carry?.lastShotWeapon ?? null,
    triggerLatched: carry?.triggerLatched ?? false,
    // Cooking means LMB is held; otherwise assume released so the next press counts.
    prevFire: carry?.prevFire ?? cooking,
    tick,
    originMs,
    fireSlowed: false,
  };
}

/** Movement status for the tick that `actions` describes (after `advanceTimers`). */
export function statusOfActions(actions: PredictedActions): PredictStatus {
  return {
    alive: true,
    healing: actions.heal !== null,
    reloading: actions.reload !== null,
    held: heldOf(actions),
    swapping: actions.swapRemainingMs > 0,
    fireSlowed: actions.fireSlowed,
  };
}

/** Step 1 (before movement): the shared timers, then this tick's fire slow-down flag. */
export function advanceTimers(prev: PredictedActions, input: PlayerInput, balance: Balance): PredictedActions {
  const a = clonePredicted(prev);
  a.tick = prev.tick + 1;
  advanceActionTimers(a, input.dt * 1000, balance);
  a.fireSlowed = fireSlowedOf(a, actionsNowMs(a), balance);
  return a;
}

/**
 * Step 3 (after movement): the shared edges and trigger. `after` is the movement state after this tick's movement step
 * (dropping, stance settled). `endAds` = a swap, reload or heal started (the server sets adsMs = 0).
 */
export function applyEdges(
  prev: PredictedActions,
  input: PlayerInput,
  after: MovementState,
  balance: Balance,
): { actions: PredictedActions; endAds: boolean } {
  const a = clonePredicted(prev);
  const now = actionsNowMs(a);
  const { endAds } = applyActionEdges(a, input, { now, prevMs: tickTimeMs(a.tick - 1, a.originMs), after }, balance);
  return { actions: a, endAds };
}

/** Timers then edges with one movement state (tests and simple callers; the Predictor runs movement in between). */
export function stepActions(prev: PredictedActions, input: PlayerInput, movement: MovementState, balance: Balance): PredictedActions {
  return applyEdges(advanceTimers(prev, input, balance), input, movement, balance).actions;
}

/** StatusModel for the Predictor: timers before the movement step, edges after it. */
export function actionStatusModel(balance: Balance | (() => Balance)): StatusModel<PredictedActions> {
  // M2b: ClientGame passes a getter, because the effective balance changes with the map (balanceForMap).
  const b = typeof balance === 'function' ? balance : (): Balance => balance;
  return {
    step: (actions, input) => {
      const next = advanceTimers(actions, input, b());
      return { actions: next, status: statusOfActions(next) };
    },
    after: (actions, input, after) => applyEdges(actions, input, after, b()),
  };
}
