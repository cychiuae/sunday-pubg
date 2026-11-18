/**
 * The shared per-tick action step (REVIEW-M2a M1): weapon swap, reload, heal, fire interval and trigger latch, grenade
 * cook / throw / cook-out and the auto-switch after the last grenade. One implementation for the authoritative World
 * (`World.processPlayer`) and the client's action prediction (src/game/actionPrediction.ts).
 *
 * Per-tick order (stance.md "Per-tick order", ADR 0004):
 *   1. `advanceActionTimers` (before movement): swap, throw recovery, reload (finish fills the mag), heal (finish applies
 *      the heal). Then `fireSlowedOf` gives the movement status.
 *   2. the shared movement step (stance, ADS, motion)
 *   3. `applyActionEdges` (after movement): selectSlot, then (unless cooking) reload and heal presses, the interact hook
 *      (World: pickups; not predicted), then fire.
 *
 * State is mutated in place (`ActionState` is a structural subset of the World's SimPlayer, so the World passes its
 * player record directly). Predictors clone first (`cloneActionState`). Side effects the step cannot resolve (shots,
 * grenade entities, explosions, events, refusals) go through `ActionHooks`, called in the World's event order.
 *
 * BUG-010: `stalled` marks a server-injected neutral input (the human's queue ran dry for more than
 * MAX_INPUT_REPEAT_TICKS). It is "no information", not a release: the trigger latch and the previous fire state are
 * left untouched so the next real input is not a new press.
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import type {
  ActionFailReason,
  AmmoId,
  FailedAction,
  GunId,
  HealId,
  HeldId,
  MovementState,
  PlayerInput,
  SlotIndex,
  WeaponId,
  WeaponSlotState,
} from '../types';
import { FISTS_SLOT, GRENADE_SLOT } from '../types';
import { chooseHeal, healedHp, reloadAmount } from './inventory';

/**
 * Timers complete when within this many ms of zero (float accumulation of 1000/30 ms steps). One value for World and
 * prediction.
 */
export const TIMER_EPSILON_MS = 1e-6;
/** Safety cap on shots resolved for one player in one tick (fire intervals shorter than a tick). */
export const MAX_SHOTS_PER_TICK = 8;

/** The inventory fields the action step reads and writes (sim Inventory satisfies it). */
export interface ActionInventory {
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  grenades: number;
}

/** Action state of one player. The World's SimPlayer is a superset (same field names). */
export interface ActionState {
  hp: number;
  inv: ActionInventory;
  reload: { slot: 0 | 1; weapon: GunId; remainingMs: number; totalMs: number } | null;
  heal: { item: HealId; remainingMs: number; totalMs: number } | null;
  swapRemainingMs: number;
  throwRecoveryMs: number;
  /** Grenade in hand with the pin pulled (explodes at this server ms), or null. */
  cook: { explodesAt: number } | null;
  /** Last non-grenade slot held (auto-switch target after the last grenade). */
  lastGunSlot: SlotIndex;
  /** Server ms when the next shot may fire. */
  nextFireAt: number;
  /** Server ms of the last shot (-Infinity before the first) and its gun (fire-move window). */
  lastShotAt: number;
  lastShotWeapon: GunId | null;
  /** Semi-auto click buffered until it can fire (or the button is released). */
  triggerLatched: boolean;
  prevFire: boolean;
}

/** Events of the action step, without the player id (World adds it; prediction maps the local ones). */
export type ActionEvent =
  | { type: 'reloadStart'; weapon: GunId; durationMs: number }
  | { type: 'reloadEnd'; weapon: GunId; completed: boolean }
  | { type: 'healStart'; item: HealId; durationMs: number }
  | { type: 'healEnd'; item: HealId; completed: boolean; hpAfter: number }
  | { type: 'weaponSwitch'; weapon: HeldId; slot: SlotIndex }
  /** Pin pulled. */
  | { type: 'grenadeCook'; explodesAt: number };

/** Side effects the caller resolves. Every hook is optional (prediction passes none or a few). */
export interface ActionHooks {
  event?(e: ActionEvent): void;
  /** A refused human edge action (the World filters bots). */
  failed?(action: FailedAction, reason: ActionFailReason): void;
  /** One trigger pull of `weapon`: resolve rays and damage. Called before the mag decrement. */
  fire?(weapon: WeaponId): void;
  /**
   * The cooked grenade leaves the hand as an entity: 'throw' (LMB release) or 'switch' (short drop on a slot change).
   * `cook` is already null when this runs.
   */
  release?(how: 'throw' | 'switch', explodesAt: number): void;
  /** The fuse ended in hand (cook-out explosion at the eye). `cook` is already null. */
  cookOut?(): void;
  /** E pressed while allowed (not dropping, not cooking). World: pickups. Called between the heal press and fire. */
  interact?(): void;
}

export interface ActionStepOptions {
  /** Server ms of this tick and of the previous tick (fire interval anchor). */
  now: number;
  prevMs: number;
  /** Movement state after this tick's movement step (dropping, stance settled). */
  after: Pick<MovementState, 'dropping' | 'stanceMs'>;
  /** BUG-010: the input is a server-injected stall-neutral input (see the module doc). */
  stalled?: boolean;
}

const settled = (m: Pick<MovementState, 'stanceMs'>): boolean => !(m.stanceMs > 0);
const gunSlot = (slot: SlotIndex): 0 | 1 | null => (slot === 0 || slot === 1 ? slot : null);
const cloneSlot = (s: WeaponSlotState | null): WeaponSlotState | null => (s ? { weapon: s.weapon, mag: s.mag } : null);

/** Deep copy (predictors keep immutable history). */
export function cloneActionState<T extends ActionState>(s: T): T {
  return {
    ...s,
    inv: {
      ...s.inv,
      slots: [cloneSlot(s.inv.slots[0]), cloneSlot(s.inv.slots[1])],
      ammo: { ...s.inv.ammo },
      heals: { ...s.inv.heals },
    },
    reload: s.reload ? { ...s.reload } : null,
    heal: s.heal ? { ...s.heal } : null,
    cook: s.cook ? { ...s.cook } : null,
  };
}

/** Item in hand ('grenade' for slot 3, 'fists' for the fists slot or an empty gun slot). */
export function heldOfActions(s: Pick<ActionState, 'inv'>): HeldId {
  const a = s.inv.activeSlot;
  if (a === GRENADE_SLOT) return 'grenade';
  const g = gunSlot(a);
  return g === null ? 'fists' : (s.inv.slots[g]?.weapon ?? 'fists');
}

/** Within combat.fireMoveWindowMs of a shot with the gun still in hand (LMG slow-down; movement status). */
export function fireSlowedOf(s: ActionState, now: number, b: Balance): boolean {
  return s.lastShotWeapon !== null && heldOfActions(s) === s.lastShotWeapon && now - s.lastShotAt < b.combat.fireMoveWindowMs;
}

/** Step 1 (before movement). */
export function advanceActionTimers(s: ActionState, dtMs: number, b: Balance, hooks: ActionHooks = {}): void {
  if (s.swapRemainingMs > 0) {
    s.swapRemainingMs -= dtMs;
    if (s.swapRemainingMs <= TIMER_EPSILON_MS) s.swapRemainingMs = 0;
  }
  if (s.throwRecoveryMs > 0) {
    s.throwRecoveryMs -= dtMs;
    if (s.throwRecoveryMs <= TIMER_EPSILON_MS) s.throwRecoveryMs = 0;
  }
  if (s.reload) {
    s.reload.remainingMs -= dtMs;
    if (s.reload.remainingMs <= TIMER_EPSILON_MS) finishReload(s, b, hooks);
  }
  if (s.heal) {
    s.heal.remainingMs -= dtMs;
    if (s.heal.remainingMs <= TIMER_EPSILON_MS) finishHeal(s, b, hooks);
  }
}

/**
 * Step 3 (after movement): this input's edges and the trigger. Returns `endAds` = a swap, reload or heal started this
 * step (combat.md: the caller sets adsMs = 0).
 */
export function applyActionEdges(
  s: ActionState,
  input: Pick<PlayerInput, 'selectSlot' | 'reload' | 'useHeal' | 'interact' | 'fire'>,
  opts: ActionStepOptions,
  b: Balance,
  hooks: ActionHooks = {},
): { endAds: boolean } {
  const ctx: StepCtx = { b, hooks, endAds: false };
  const dropping = opts.after.dropping;
  if (input.selectSlot !== -1) selectSlot(s, input.selectSlot, ctx);
  if (!s.cook) {
    if (input.reload && !tryStartReload(s, ctx)) {
      const g = gunSlot(s.inv.activeSlot);
      const slot = g === null ? null : s.inv.slots[g];
      if (slot && !s.reload && slot.mag < b.weapons[slot.weapon].magSize && s.inv.ammo[ammoFor(b, slot.weapon)] <= 0) {
        hooks.failed?.('reload', 'noAmmo');
      }
    }
    if (input.useHeal) {
      if (s.heal) cancelHeal(s, ctx);
      else if (!dropping && !tryStartHeal(s, ctx)) {
        const any = s.inv.heals.bandage + s.inv.heals.medkit > 0;
        hooks.failed?.('heal', any ? 'fullHp' : 'noHeals');
      }
    }
    if (input.interact && !dropping) hooks.interact?.();
  }
  handleFire(s, input.fire, opts, ctx);
  return { endAds: ctx.endAds };
}

/**
 * The active weapon changed outside the step (a pickup into the active slot): cancel reload and heal, start the swap
 * timer and release the trigger, like a swap. Emits weaponSwitch. Returns true (ends ADS).
 */
export function activeChangedByPickup(s: ActionState, b: Balance, hooks: ActionHooks = {}): boolean {
  const ctx: StepCtx = { b, hooks, endAds: true };
  cancelReload(s, ctx);
  cancelHeal(s, ctx);
  s.swapRemainingMs = b.combat.swapMs;
  s.triggerLatched = false;
  hooks.event?.({ type: 'weaponSwitch', weapon: heldOfActions(s), slot: s.inv.activeSlot });
  return true;
}

/** Cancels a running reload and heal (death, disconnect, match end). Emits the `completed: false` ends. */
export function cancelActionTimers(s: ActionState, b: Balance, hooks: ActionHooks = {}): void {
  const ctx: StepCtx = { b, hooks, endAds: false };
  cancelReload(s, ctx);
  cancelHeal(s, ctx);
}

// ---------------------------------------------------------------------------------------------

interface StepCtx {
  b: Balance;
  hooks: ActionHooks;
  endAds: boolean;
}

function beginSwap(s: ActionState, slot: SlotIndex, ctx: StepCtx): void {
  if (s.inv.activeSlot !== GRENADE_SLOT) s.lastGunSlot = s.inv.activeSlot;
  cancelReload(s, ctx);
  cancelHeal(s, ctx);
  ctx.endAds = true;
  s.inv.activeSlot = slot;
  s.swapRemainingMs = ctx.b.combat.swapMs;
  s.triggerLatched = false;
  ctx.hooks.event?.({ type: 'weaponSwitch', weapon: heldOfActions(s), slot });
}

function selectSlot(s: ActionState, slot: SlotIndex, ctx: StepCtx): void {
  if (slot === s.inv.activeSlot) return;
  if (slot === GRENADE_SLOT) {
    if (s.inv.grenades <= 0) {
      ctx.hooks.failed?.('swap', 'noGrenades');
      return;
    }
  } else if (slot !== FISTS_SLOT && s.inv.slots[slot as 0 | 1] === null) return;
  // Switching away while cooking releases a short drop (grenades.md "Cooking and throwing" 5).
  if (s.cook) {
    const at = s.cook.explodesAt;
    s.cook = null;
    ctx.hooks.release?.('switch', at);
  }
  beginSwap(s, slot, ctx);
}

/** After the last grenade: back to the last gun slot used (or fists), paying combat.swapMs. */
function autoSwitchFromGrenade(s: ActionState, ctx: StepCtx): void {
  const last = s.lastGunSlot;
  const target: SlotIndex = (last === 0 || last === 1) && s.inv.slots[last] ? last : FISTS_SLOT;
  beginSwap(s, target, ctx);
}

function tryStartReload(s: ActionState, ctx: StepCtx): boolean {
  if (s.reload || s.swapRemainingMs > 0) return false;
  const g = gunSlot(s.inv.activeSlot);
  const slot = g === null ? null : s.inv.slots[g];
  if (!slot || g === null) return false;
  const reserve = s.inv.ammo[ammoFor(ctx.b, slot.weapon)];
  if (reloadAmount(slot, reserve, ctx.b) <= 0) return false;
  cancelHeal(s, ctx);
  ctx.endAds = true;
  const ms = ctx.b.weapons[slot.weapon].reloadMs;
  s.reload = { slot: g, weapon: slot.weapon, remainingMs: ms, totalMs: ms };
  ctx.hooks.event?.({ type: 'reloadStart', weapon: slot.weapon, durationMs: ms });
  return true;
}

function finishReload(s: ActionState, b: Balance, hooks: ActionHooks): void {
  const r = s.reload;
  if (!r) return;
  s.reload = null;
  const slot = s.inv.slots[r.slot];
  if (slot && slot.weapon === r.weapon) {
    const ammo = ammoFor(b, slot.weapon);
    const n = reloadAmount(slot, s.inv.ammo[ammo], b);
    slot.mag += n;
    s.inv.ammo[ammo] -= n;
  }
  hooks.event?.({ type: 'reloadEnd', weapon: r.weapon, completed: true });
}

function cancelReload(s: ActionState, ctx: StepCtx): void {
  if (!s.reload) return;
  const w = s.reload.weapon;
  s.reload = null;
  ctx.hooks.event?.({ type: 'reloadEnd', weapon: w, completed: false });
}

function tryStartHeal(s: ActionState, ctx: StepCtx): boolean {
  const item = chooseHeal(s.hp, s.inv.heals, ctx.b);
  if (!item) return false;
  cancelReload(s, ctx);
  ctx.endAds = true;
  const ms = ctx.b.items[item].useMs;
  s.heal = { item, remainingMs: ms, totalMs: ms };
  ctx.hooks.event?.({ type: 'healStart', item, durationMs: ms });
  return true;
}

function finishHeal(s: ActionState, b: Balance, hooks: ActionHooks): void {
  const h = s.heal;
  if (!h) return;
  s.heal = null;
  if (s.inv.heals[h.item] > 0) {
    s.hp = healedHp(s.hp, h.item, b);
    s.inv.heals[h.item]--;
  }
  hooks.event?.({ type: 'healEnd', item: h.item, completed: true, hpAfter: s.hp });
}

function cancelHeal(s: ActionState, ctx: StepCtx): void {
  if (!s.heal) return;
  const item = s.heal.item;
  s.heal = null;
  ctx.hooks.event?.({ type: 'healEnd', item, completed: false, hpAfter: s.hp });
}

function handleFire(s: ActionState, fire: boolean, opts: ActionStepOptions, ctx: StepCtx): void {
  const { now, prevMs, after } = opts;
  const dropping = after.dropping;
  // BUG-010: a stall-neutral input never counts as a press or a release of the trigger.
  const pressed = !opts.stalled && fire && !s.prevFire;
  if (!opts.stalled) {
    if (pressed) s.triggerLatched = true;
    if (!fire) s.triggerLatched = false;
    s.prevFire = fire;
  }
  if (s.inv.activeSlot === GRENADE_SLOT) {
    handleGrenade(s, fire, pressed, dropping, now, after, ctx);
    return;
  }
  if (!fire) return;
  if (s.heal) cancelHeal(s, ctx);
  if (dropping) return;
  const b = ctx.b;
  for (let guard = 0; guard < MAX_SHOTS_PER_TICK; guard++) {
    if (s.reload || s.swapRemainingMs > 0 || !settled(after)) {
      // A press while firing is blocked (transition, swap, reload) is dropped (combat.md "Shot resolution" 1).
      if (pressed) s.triggerLatched = false;
      return;
    }
    if (s.nextFireAt > now) return;
    const weapon = heldOfActions(s) as WeaponId;
    const wb = b.weapons[weapon];
    if (!wb.automatic && !s.triggerLatched) return;
    const g = gunSlot(s.inv.activeSlot);
    const slot = g === null ? null : s.inv.slots[g];
    if (slot && slot.mag <= 0) {
      tryStartReload(s, ctx);
      return;
    }
    const shotAt = Math.max(s.nextFireAt, prevMs);
    ctx.hooks.fire?.(weapon);
    s.nextFireAt = shotAt + wb.fireIntervalMs;
    s.lastShotAt = now;
    s.lastShotWeapon = slot ? slot.weapon : null;
    if (!wb.automatic) s.triggerLatched = false;
    if (slot) {
      slot.mag--;
      if (slot.mag <= 0) {
        tryStartReload(s, ctx);
        return;
      }
    }
  }
}

/** Grenade slot: pin pull on a ready press, throw on release, cook-out when the fuse ends in hand. */
function handleGrenade(
  s: ActionState,
  fire: boolean,
  pressed: boolean,
  dropping: boolean,
  now: number,
  after: Pick<MovementState, 'stanceMs'>,
  ctx: StepCtx,
): void {
  const g = ctx.b.items.grenade;
  if (s.cook) {
    if (!fire) {
      const at = s.cook.explodesAt;
      s.cook = null;
      ctx.hooks.release?.('throw', at);
      s.throwRecoveryMs = g.throwRecoveryMs;
      if (s.inv.grenades <= 0) autoSwitchFromGrenade(s, ctx);
    } else if (now >= s.cook.explodesAt - TIMER_EPSILON_MS) {
      s.cook = null;
      ctx.hooks.cookOut?.();
      s.throwRecoveryMs = g.throwRecoveryMs;
      if (s.inv.grenades <= 0) autoSwitchFromGrenade(s, ctx);
    }
    return;
  }
  if (fire && s.heal) cancelHeal(s, ctx);
  if (!pressed || dropping) return;
  if (s.swapRemainingMs > 0 || s.throwRecoveryMs > 0 || !settled(after)) return;
  if (s.inv.grenades <= 0) {
    autoSwitchFromGrenade(s, ctx);
    return;
  }
  s.inv.grenades--;
  const explodesAt = now + g.fuseMs;
  s.cook = { explodesAt };
  ctx.hooks.event?.({ type: 'grenadeCook', explodesAt });
}
