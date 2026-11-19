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
 * M2c (ADR 0007 §3, §5, §6): melee swings (wind-up to the hit frame, `meleeHit` hook with this tick's aim), the throwable
 * slot (frag and smoke stacks, selection, the 4 / G cycle, the non-cookable smoke throw), the T sight switch
 * (`scopeSwap`, applied at its end through `scopeChanged`), and level / scope aware reload and fire intervals
 * (effectiveWeapon). The M2c fields of ActionState / ActionInventory are optional so an older predictor still compiles;
 * absent = no melee, no smoke, frag selected, empty pouch, nothing running.
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
  ItemLevel,
  M2cThrowableId,
  MeleeId,
  MeleeSlotState,
  MovementState,
  PlayerInput,
  ScopeId,
  SlotIndex,
  WeaponId,
  WeaponSlotState,
} from '../types';
import { FISTS_SLOT, GRENADE_SLOT } from '../types';
import { chooseHeal, healedHp, reloadAmount } from './inventory';
import { effWeapon, slotWeapon } from './levels';
import { scopeCyclePlan } from './scopes';

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
  /** M2c: the melee slot's weapon (null / absent = fists). */
  melee?: MeleeSlotState | null;
  /** M2c: carried smoke canisters (absent = 0). */
  smokes?: number;
  /** M2c: the throwable slot's selected type (absent = 'grenade'). */
  selectedThrowable?: M2cThrowableId;
  /** M2c: the spare-scope pouch (absent = empty). */
  spareScope?: ScopeId | null;
}

/** M2c: a melee swing in its wind-up: the hit check runs on the first tick at or after `hitAt`. */
export interface SwingState {
  weapon: MeleeId;
  level: ItemLevel;
  hitAt: number;
}

/** M2c: a T sight switch on gun slot `slot` (scopes.swapMs); applied when it ends. */
export interface ScopeSwapState {
  slot: 0 | 1;
  remainingMs: number;
  totalMs: number;
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
  /** Server ms of the last shot or melee hit frame (-Infinity before the first) and its weapon (fire-move window). */
  lastShotAt: number;
  lastShotWeapon: WeaponId | null;
  /** Semi-auto click buffered until it can fire (or the button is released). */
  triggerLatched: boolean;
  prevFire: boolean;
  /** M2c: the melee swing in its wind-up, else null / absent. */
  swing?: SwingState | null;
  /** M2c: a running T sight switch, else null / absent. */
  scopeSwap?: ScopeSwapState | null;
  /** M2c: LMB held with a smoke selected (the throw aims; nothing consumed until release). */
  smokeHeld?: boolean;
}

/** Events of the action step, without the player id (World adds it; prediction maps the local ones). */
export type ActionEvent =
  | { type: 'reloadStart'; weapon: GunId; durationMs: number; rounds: number }
  | { type: 'reloadEnd'; weapon: GunId; completed: boolean }
  | { type: 'healStart'; item: HealId; durationMs: number }
  | { type: 'healEnd'; item: HealId; completed: boolean; hpAfter: number }
  | { type: 'weaponSwitch'; weapon: HeldId; slot: SlotIndex; level: ItemLevel | null }
  /** Pin pulled. */
  | { type: 'grenadeCook'; explodesAt: number }
  /** M2c: a melee swing started (hit frame at `hitAt`, server ms). */
  | { type: 'meleeSwing'; weapon: MeleeId; level: ItemLevel; hitAt: number; cycleMs: number };

/** Side effects the caller resolves. Every hook is optional (prediction passes none or a few). */
export interface ActionHooks {
  event?(e: ActionEvent): void;
  /** A refused human edge action (the World filters bots). */
  failed?(action: FailedAction, reason: ActionFailReason): void;
  /** One trigger pull of `weapon`: resolve rays and damage. Called before the mag decrement. */
  fire?(weapon: WeaponId): void;
  /**
   * The cooked grenade leaves the hand as an entity: 'throw' (LMB release) or 'switch' (short drop on a slot change).
   * `cook` is already null when this runs. M2c: `kind` 'smoke' for a smoke throw (fuse from the release).
   */
  release?(how: 'throw' | 'switch', explodesAt: number, kind: M2cThrowableId): void;
  /** The fuse ended in hand (cook-out explosion at the eye). `cook` is already null. */
  cookOut?(): void;
  /** E pressed while allowed (not dropping, not cooking). World: pickups. Called between the heal press and fire. */
  interact?(): void;
  /** M2c: a melee swing reached its hit frame (World: the hit check with this tick's eye and aim). */
  meleeHit?(swing: SwingState): void;
  /** M2c: a T sight switch ended and changed the scope on gun slot `slot` (to null = built-in sight). */
  scopeChanged?(slot: 0 | 1, gun: GunId, from: ScopeId | null, to: ScopeId | null): void;
}

export interface ActionStepOptions {
  /** Server ms of this tick and of the previous tick (fire interval anchor). */
  now: number;
  prevMs: number;
  /** Movement state after this tick's movement step (dropping, stance settled; M2c: adsMs for T). */
  after: Pick<MovementState, 'dropping' | 'stanceMs'> & { adsMs?: number };
  /** BUG-010: the input is a server-injected stall-neutral input (see the module doc). */
  stalled?: boolean;
}

const settled = (m: Pick<MovementState, 'stanceMs'>): boolean => !(m.stanceMs > 0);
const gunSlot = (slot: SlotIndex): 0 | 1 | null => (slot === 0 || slot === 1 ? slot : null);
const cloneSlot = (s: WeaponSlotState | null): WeaponSlotState | null => (s ? { ...s } : null);

/** Deep copy (predictors keep immutable history). */
export function cloneActionState<T extends ActionState>(s: T): T {
  const out: T = {
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
  if (s.inv.melee) out.inv.melee = { ...s.inv.melee };
  if (s.swing) out.swing = { ...s.swing };
  if (s.scopeSwap) out.scopeSwap = { ...s.scopeSwap };
  return out;
}

/** M2c: selected throwable (absent = frag). */
export const selectedThrowableOf = (inv: ActionInventory): M2cThrowableId => inv.selectedThrowable ?? 'grenade';
/** M2c: carried count of a throwable type. */
export const carriedThrowables = (inv: ActionInventory, kind: M2cThrowableId): number =>
  kind === 'smoke' ? (inv.smokes ?? 0) : inv.grenades;
const otherKind = (k: M2cThrowableId): M2cThrowableId => (k === 'smoke' ? 'grenade' : 'smoke');

/**
 * Item in hand: the selected throwable for slot 3, the melee weapon (or 'fists') for slot 2, 'fists' for an empty gun
 * slot.
 */
export function heldOfActions(s: Pick<ActionState, 'inv'>): HeldId {
  const a = s.inv.activeSlot;
  if (a === GRENADE_SLOT) return selectedThrowableOf(s.inv);
  if (a === FISTS_SLOT) return s.inv.melee?.weapon ?? 'fists';
  const g = gunSlot(a);
  return g === null ? 'fists' : (s.inv.slots[g]?.weapon ?? 'fists');
}

/** M2c: level of the item in hand (gun slot level, melee level), null for fists and throwables. */
export function heldLevelOfActions(s: Pick<ActionState, 'inv'>): ItemLevel | null {
  const a = s.inv.activeSlot;
  if (a === GRENADE_SLOT) return null;
  if (a === FISTS_SLOT) return s.inv.melee ? s.inv.melee.level : null;
  const g = gunSlot(a);
  const slot = g === null ? null : s.inv.slots[g];
  return slot ? (slot.level ?? 1) : null;
}

/** M2c: a weapon swap, a throwable cycle or a T sight switch is running (movement status `swapping`: no ADS). */
export const isSwapping = (s: Pick<ActionState, 'swapRemainingMs' | 'scopeSwap'>): boolean =>
  s.swapRemainingMs > 0 || (s.scopeSwap !== undefined && s.scopeSwap !== null);

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
  if (s.scopeSwap) {
    s.scopeSwap.remainingMs -= dtMs;
    if (s.scopeSwap.remainingMs <= TIMER_EPSILON_MS) finishScopeSwap(s, b, hooks);
  }
}

/** M2c: the T switch ends: the exchange is re-planned on the current inventory and applied (scopes.md "T"). */
function finishScopeSwap(s: ActionState, b: Balance, hooks: ActionHooks): void {
  const sw = s.scopeSwap;
  s.scopeSwap = null;
  if (!sw || s.inv.activeSlot !== sw.slot) return;
  const plan = scopeCyclePlan(s.inv, b);
  if (plan.kind !== 'swap' || plan.slot !== sw.slot) return;
  const slot = s.inv.slots[plan.slot];
  if (!slot) return;
  slot.scope = plan.to;
  s.inv.spareScope = plan.pouch;
  hooks.scopeChanged?.(plan.slot, slot.weapon, plan.from, plan.to);
}

/**
 * Step 3 (after movement): this input's edges and the trigger. Returns `endAds` = a swap, reload or heal started this
 * step (combat.md: the caller sets adsMs = 0).
 */
export function applyActionEdges(
  s: ActionState,
  input: Pick<PlayerInput, 'selectSlot' | 'reload' | 'useHeal' | 'interact' | 'fire' | 'cycleScope'>,
  opts: ActionStepOptions,
  b: Balance,
  hooks: ActionHooks = {},
): { endAds: boolean } {
  const ctx: StepCtx = { b, hooks, endAds: false };
  const dropping = opts.after.dropping;
  // M2c melee: the hit frame resolves first, with this tick's aim; becoming a dropping player cancels the swing.
  if (s.swing) {
    if (dropping) s.swing = null;
    else if (opts.now >= s.swing.hitAt - TIMER_EPSILON_MS) {
      const sw = s.swing;
      s.swing = null;
      s.lastShotAt = opts.now;
      s.lastShotWeapon = sw.weapon;
      hooks.meleeHit?.(sw);
    }
  }
  if (input.selectSlot !== -1) selectSlot(s, input.selectSlot, ctx);
  if (input.cycleScope === true && !s.cook && !s.smokeHeld && !dropping) startScopeSwap(s, opts, ctx);
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
  s.swing = null;
  s.scopeSwap = null;
  s.smokeHeld = false;
  s.swapRemainingMs = b.combat.swapMs;
  s.triggerLatched = false;
  hooks.event?.({ type: 'weaponSwitch', weapon: heldOfActions(s), slot: s.inv.activeSlot, level: heldLevelOfActions(s) });
  return true;
}

/**
 * M2c (levels.md "Upgrade swap"): gun slot `slot` was replaced in place by a higher level copy. No swap time; a reload
 * of that slot is cancelled, and so is a T switch on it. Returns true when it is the held slot (the caller ends ADS).
 */
export function slotUpgradedByPickup(s: ActionState, slot: 0 | 1, b: Balance, hooks: ActionHooks = {}): boolean {
  const ctx: StepCtx = { b, hooks, endAds: false };
  if (s.reload && s.reload.slot === slot) cancelReload(s, ctx);
  if (s.scopeSwap && s.scopeSwap.slot === slot) s.scopeSwap = null;
  return s.inv.activeSlot === slot;
}

/** Cancels a running reload and heal (death, disconnect, match end). Emits the `completed: false` ends. */
export function cancelActionTimers(s: ActionState, b: Balance, hooks: ActionHooks = {}): void {
  const ctx: StepCtx = { b, hooks, endAds: false };
  cancelReload(s, ctx);
  cancelHeal(s, ctx);
  s.swing = null;
  s.scopeSwap = null;
  s.smokeHeld = false;
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
  // M2c: a slot change cancels a melee wind-up, a T switch and a held smoke throw (nothing consumed).
  s.swing = null;
  s.scopeSwap = null;
  s.smokeHeld = false;
  ctx.endAds = true;
  s.inv.activeSlot = slot;
  s.swapRemainingMs = ctx.b.combat.swapMs;
  s.triggerLatched = false;
  ctx.hooks.event?.({ type: 'weaponSwitch', weapon: heldOfActions(s), slot, level: heldLevelOfActions(s) });
}

function selectSlot(s: ActionState, slot: SlotIndex, ctx: StepCtx): void {
  if (slot === GRENADE_SLOT) {
    const sel = selectedThrowableOf(s.inv);
    const other = otherKind(sel);
    if (carriedThrowables(s.inv, sel) + carriedThrowables(s.inv, other) <= 0) {
      if (slot !== s.inv.activeSlot) ctx.hooks.failed?.('swap', 'noGrenades');
      return;
    }
    if (slot === s.inv.activeSlot) {
      // grenades.md "Cycling": 4 / G on a ready throwable slot switches type (throwableCycleMs); ignored while cooking
      // or holding a smoke throw; nothing with only one type carried.
      if (s.cook || s.smokeHeld || s.swapRemainingMs > 0 || carriedThrowables(s.inv, other) <= 0) return;
      s.inv.selectedThrowable = other;
      s.swapRemainingMs = ctx.b.combat.throwableCycleMs;
      s.triggerLatched = false;
      ctx.hooks.event?.({ type: 'weaponSwitch', weapon: other, slot, level: null });
      return;
    }
    // Selecting: the selected type if carried, else the other one.
    if (carriedThrowables(s.inv, sel) <= 0) s.inv.selectedThrowable = other;
  } else {
    if (slot === s.inv.activeSlot) return;
    if (slot !== FISTS_SLOT && s.inv.slots[slot as 0 | 1] === null) return;
  }
  // Switching away while cooking releases a short drop (grenades.md "Cooking and throwing" 5).
  if (s.cook) {
    const at = s.cook.explodesAt;
    s.cook = null;
    ctx.hooks.release?.('switch', at, 'grenade');
  }
  beginSwap(s, slot, ctx);
}

/**
 * After the last throwable of the selected type: back to the last gun slot used (or the melee slot), paying
 * combat.swapMs; the selected type becomes the other type if carried (grenades.md "Running out").
 */
function autoSwitchFromGrenade(s: ActionState, ctx: StepCtx): void {
  const sel = selectedThrowableOf(s.inv);
  if (carriedThrowables(s.inv, sel) <= 0 && carriedThrowables(s.inv, otherKind(sel)) > 0) s.inv.selectedThrowable = otherKind(sel);
  const last = s.lastGunSlot;
  const target: SlotIndex = (last === 0 || last === 1) && s.inv.slots[last] ? last : FISTS_SLOT;
  beginSwap(s, target, ctx);
}

/** M2c (scopes.md "T"): start a sight switch on the held gun, or refuse. T while aiming is ignored. */
function startScopeSwap(s: ActionState, opts: ActionStepOptions, ctx: StepCtx): void {
  if ((opts.after.adsMs ?? 0) > 0) return;
  if (isSwapping(s) || !settled(opts.after)) return;
  const plan = scopeCyclePlan(s.inv, ctx.b);
  if (plan.kind === 'refused') {
    ctx.hooks.failed?.('scope', plan.reason);
    return;
  }
  cancelReload(s, ctx);
  cancelHeal(s, ctx);
  ctx.endAds = true;
  s.triggerLatched = false;
  const ms = ctx.b.scopes.swapMs;
  s.scopeSwap = { slot: plan.slot, remainingMs: ms, totalMs: ms };
  if (!(ms > 0)) finishScopeSwap(s, ctx.b, ctx.hooks);
}

function tryStartReload(s: ActionState, ctx: StepCtx): boolean {
  if (s.reload || isSwapping(s)) return false;
  const g = gunSlot(s.inv.activeSlot);
  const slot = g === null ? null : s.inv.slots[g];
  if (!slot || g === null) return false;
  const reserve = s.inv.ammo[ammoFor(ctx.b, slot.weapon)];
  const rounds = reloadAmount(slot, reserve, ctx.b);
  if (rounds <= 0) return false;
  cancelHeal(s, ctx);
  ctx.endAds = true;
  // levels.md: reloadMs x the level multiplier.
  const ms = slotWeapon(ctx.b, slot).reloadMs;
  s.reload = { slot: g, weapon: slot.weapon, remainingMs: ms, totalMs: ms };
  ctx.hooks.event?.({ type: 'reloadStart', weapon: slot.weapon, durationMs: ms, rounds });
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
    if (selectedThrowableOf(s.inv) === 'smoke' && !s.cook) handleSmoke(s, fire, pressed, dropping, now, after, ctx);
    else handleGrenade(s, fire, pressed, dropping, now, after, ctx);
    return;
  }
  if (!fire) return;
  if (s.heal) cancelHeal(s, ctx);
  if (dropping) return;
  const b = ctx.b;
  const melee = s.inv.activeSlot === FISTS_SLOT ? (s.inv.melee ?? null) : null;
  if (melee) {
    startSwing(s, melee, pressed, now, prevMs, after, ctx);
    return;
  }
  for (let guard = 0; guard < MAX_SHOTS_PER_TICK; guard++) {
    if (s.reload || isSwapping(s) || !settled(after)) {
      // A press while firing is blocked (transition, swap, reload) is dropped (combat.md "Shot resolution" 1).
      if (pressed) s.triggerLatched = false;
      return;
    }
    if (s.nextFireAt > now) return;
    const weapon = heldOfActions(s) as WeaponId;
    const g = gunSlot(s.inv.activeSlot);
    const slot = g === null ? null : s.inv.slots[g];
    // levels.md: fireIntervalMs x the level multiplier (the base `automatic` flag never changes).
    const wb = slot ? slotWeapon(b, slot) : effWeapon(b, weapon);
    if (!wb.automatic && !s.triggerLatched) return;
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

/**
 * M2c (melee.md "Swing"): a swing starts at the click (automatic while held) once the cycle allows; the hit check runs
 * at the hit frame (applyActionEdges). Blocked by a swap, a stance transition and a swing already winding up.
 */
function startSwing(
  s: ActionState,
  melee: MeleeSlotState,
  pressed: boolean,
  now: number,
  prevMs: number,
  after: Pick<MovementState, 'stanceMs'>,
  ctx: StepCtx,
): void {
  if (s.swing || isSwapping(s) || !settled(after)) {
    if (pressed) s.triggerLatched = false;
    return;
  }
  if (s.nextFireAt > now) return;
  const ew = effWeapon(ctx.b, melee.weapon, melee.level);
  if (!ew.automatic && !s.triggerLatched) return;
  // A fresh click starts the swing now (the wind-up is the telegraph); a held repeat keeps the exact cycle cadence.
  const shotAt = s.nextFireAt > prevMs ? s.nextFireAt : now;
  s.swing = { weapon: melee.weapon, level: melee.level, hitAt: shotAt + ew.hitFrameMs };
  s.nextFireAt = shotAt + ew.fireIntervalMs;
  if (!ew.automatic) s.triggerLatched = false;
  ctx.hooks.event?.({ type: 'meleeSwing', weapon: melee.weapon, level: melee.level, hitAt: s.swing.hitAt, cycleMs: ew.fireIntervalMs });
}

/**
 * M2c (smoke.md "Carrying and throwing"): not cookable. A ready press starts aiming (nothing consumed); the release
 * throws with the fuse starting then; recovery follows; the last smoke auto-switches away.
 */
function handleSmoke(
  s: ActionState,
  fire: boolean,
  pressed: boolean,
  dropping: boolean,
  now: number,
  after: Pick<MovementState, 'stanceMs'>,
  ctx: StepCtx,
): void {
  const sm = ctx.b.items.smoke;
  if (s.smokeHeld) {
    if (fire) return;
    s.smokeHeld = false;
    if ((s.inv.smokes ?? 0) <= 0) return;
    s.inv.smokes = (s.inv.smokes ?? 0) - 1;
    ctx.hooks.release?.('throw', now + sm.fuseMs, 'smoke');
    s.throwRecoveryMs = sm.throwRecoveryMs;
    if ((s.inv.smokes ?? 0) <= 0) autoSwitchFromGrenade(s, ctx);
    return;
  }
  if (fire && s.heal) cancelHeal(s, ctx);
  if (!pressed || dropping) return;
  if (s.swapRemainingMs > 0 || s.throwRecoveryMs > 0 || !settled(after)) return;
  if ((s.inv.smokes ?? 0) <= 0) {
    autoSwitchFromGrenade(s, ctx);
    return;
  }
  s.smokeHeld = true;
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
      ctx.hooks.release?.('throw', at, 'grenade');
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
