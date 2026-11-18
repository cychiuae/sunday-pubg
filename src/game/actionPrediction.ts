/**
 * Local prediction of the action timers that change movement (REVIEW-M1 m1). Owner: game-developer.
 *
 * The server picks the movement status (`healing` -> movement.healMoveMultiplier, no sprint) from the heal state of
 * the CURRENT tick, after that tick's edge inputs. Using the snapshot's heal flag for every pending input made the
 * client apply the multiplier about one RTT late (start) or early (end), so every heal caused a correction.
 *
 * `stepActions` mirrors the order of `World.processPlayer` for the parts that decide whether a heal is running:
 *   1. timers: swap, reload (finish fills the mag), heal (finish applies the heal)
 *   2. selectSlot (cancels reload and heal, starts the swap)
 *   3. reload press (tryStartReload: cancels heal)
 *   4. useHeal press (cancel when healing, else start unless dropping; cancels reload)
 *   5. held fire cancels a heal
 * Not predicted (rare, and reconciliation corrects them): pickups that change the active weapon, rounds spent by
 * firing and the auto-reload on an empty mag, damage that changes which heal Q picks.
 *
 * Pure and immutable: returns a new state, never mutates its input.
 */
import { ammoFor, type Balance } from '../shared/balance';
import { chooseHeal, healedHp, reloadAmount } from '../shared/sim/inventory';
import type {
  AmmoId,
  GunId,
  HealId,
  LocalPlayerState,
  PlayerInput,
  SlotIndex,
  WeaponSlotState,
} from '../shared/types';
import type { PredictStatus, StatusModel } from './prediction';

/**
 * Same value as World.ts TIMER_EPSILON_MS (not exported from the sim). A timer completes when it is within this many
 * ms of zero, which absorbs the float error of summing 1000/30 ms steps.
 */
const TIMER_EPSILON_MS = 1e-6;

export interface PredictedActions {
  hp: number;
  activeSlot: SlotIndex;
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  swapMs: number;
  reload: { slot: 0 | 1; weapon: GunId; remainingMs: number } | null;
  heal: { item: HealId; remainingMs: number } | null;
}

/** The weapon slot index (0 or 1) for a slot, or null for fists. */
const gunSlot = (slot: SlotIndex): 0 | 1 | null => (slot === 0 || slot === 1 ? slot : null);

const cloneSlot = (s: WeaponSlotState | null): WeaponSlotState | null => (s ? { weapon: s.weapon, mag: s.mag } : null);

/** Action state at snapshot time (the reconciliation base). `hp` is the local PlayerState hp. */
export function actionsFromSnapshot(local: LocalPlayerState, hp: number): PredictedActions {
  const active = gunSlot(local.activeSlot);
  const activeGun = active === null ? null : local.slots[active];
  return {
    hp,
    activeSlot: local.activeSlot,
    slots: [cloneSlot(local.slots[0]), cloneSlot(local.slots[1])],
    ammo: { ...local.ammo },
    heals: { ...local.heals },
    swapMs: local.swapRemainingMs,
    // A reload always belongs to the active slot (switching slots cancels it).
    reload:
      local.reloadRemainingMs > 0 && activeGun && active !== null
        ? { slot: active, weapon: activeGun.weapon, remainingMs: local.reloadRemainingMs }
        : null,
    heal: local.healRemainingMs > 0 && local.healItem ? { item: local.healItem, remainingMs: local.healRemainingMs } : null,
  };
}

/** Movement status for the tick that `actions` describes (after `stepActions`). */
export function statusOfActions(actions: PredictedActions): PredictStatus {
  return { alive: true, healing: actions.heal !== null, reloading: actions.reload !== null };
}

/**
 * Advance the action state by one input, like World.processPlayer does before the movement step.
 * `dropping` is the movement state's dropping flag before this tick's movement step.
 */
export function stepActions(prev: PredictedActions, input: PlayerInput, dropping: boolean, balance: Balance): PredictedActions {
  const a: PredictedActions = {
    ...prev,
    slots: [cloneSlot(prev.slots[0]), cloneSlot(prev.slots[1])],
    ammo: { ...prev.ammo },
    heals: { ...prev.heals },
    reload: prev.reload ? { ...prev.reload } : null,
    heal: prev.heal ? { ...prev.heal } : null,
  };
  const dtMs = input.dt * 1000;

  // 1. Timers.
  if (a.swapMs > 0) {
    a.swapMs -= dtMs;
    if (a.swapMs <= TIMER_EPSILON_MS) a.swapMs = 0;
  }
  if (a.reload) {
    a.reload.remainingMs -= dtMs;
    if (a.reload.remainingMs <= TIMER_EPSILON_MS) finishReload(a, balance);
  }
  if (a.heal) {
    a.heal.remainingMs -= dtMs;
    if (a.heal.remainingMs <= TIMER_EPSILON_MS) {
      const item = a.heal.item;
      a.heal = null;
      if (a.heals[item] > 0) {
        a.hp = healedHp(a.hp, item, balance);
        a.heals[item]--;
      }
    }
  }

  // 2. Slot select.
  const slot = input.selectSlot;
  const selectedGun = slot === -1 ? null : gunSlot(slot);
  if (slot !== -1 && slot !== a.activeSlot && (selectedGun === null || a.slots[selectedGun] !== null)) {
    a.reload = null;
    a.heal = null;
    a.activeSlot = slot;
    a.swapMs = balance.combat.swapMs;
  }

  // 3. Reload press.
  if (input.reload) tryStartReload(a, balance);

  // 4. Heal press.
  if (input.useHeal) {
    if (a.heal) a.heal = null;
    else if (!dropping) {
      const item = chooseHeal(a.hp, a.heals, balance);
      if (item) {
        a.reload = null;
        a.heal = { item, remainingMs: balance.items[item].useMs };
      }
    }
  }

  // 5. Held fire cancels a heal (World.handleFire).
  if (input.fire) a.heal = null;

  return a;
}

/** StatusModel for the Predictor: action state = PredictedActions, status = statusOfActions after the step. */
export function actionStatusModel(balance: Balance): StatusModel<PredictedActions> {
  return {
    step: (actions, input, before) => {
      const next = stepActions(actions, input, before.dropping, balance);
      return { actions: next, status: statusOfActions(next) };
    },
  };
}

function finishReload(a: PredictedActions, balance: Balance): void {
  const r = a.reload;
  a.reload = null;
  if (!r) return;
  const s = a.slots[r.slot];
  if (!s || s.weapon !== r.weapon) return;
  const ammo = ammoFor(balance, s.weapon);
  const n = reloadAmount(s, a.ammo[ammo], balance);
  s.mag += n;
  a.ammo[ammo] -= n;
}

function tryStartReload(a: PredictedActions, balance: Balance): void {
  const active = gunSlot(a.activeSlot);
  if (a.reload || a.swapMs > 0 || active === null) return;
  const s = a.slots[active];
  if (!s) return;
  if (reloadAmount(s, a.ammo[ammoFor(balance, s.weapon)], balance) <= 0) return;
  a.heal = null;
  a.reload = { slot: active, weapon: s.weapon, remainingMs: balance.weapons[s.weapon].reloadMs };
}
