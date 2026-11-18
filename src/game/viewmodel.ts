/**
 * First-person viewmodel state (FrameView.viewmodel, ADR 0005 §9, camera.md "Viewmodel"). Owner: game-developer.
 * Plain data for the renderer's second pass; the renderer owns the poses and animation curves.
 *
 * - Local player: the action and its progress come from the predicted action state (shared sim action step), so the
 *   arms react on the press.
 * - FP spectate: from the target's interpolated PlayerState anim flags (no progress beyond what anim shows); their
 *   ADS blend is rebuilt from anim.ads (SpectateAdsClock).
 */
import type { Balance } from '../shared/balance';
import type { ViewmodelAction, ViewmodelView } from '../shared/contracts';
import { wrapAngle } from '../shared/math';
import type { Appearance, ArmorTierOrNone, DropPhase, HealId, HeldId, PlayerId, PlayerState, Stance } from '../shared/types';
import { actionsNowMs, heldOf, type PredictedActions } from './actionPrediction';

/** Time constant of the look-rate smoothing (sway input filter, not a feel number: the feel is vmSwayLookFactor). */
export const LOOK_RATE_SMOOTHING_MS = 50;

export interface VmAction {
  item: HeldId | HealId;
  cooking: boolean;
  action: ViewmodelAction;
  actionProgress: number;
}

const progressOf = (remaining: number, total: number): number =>
  total > 0 ? Math.min(1, Math.max(0, 1 - remaining / total)) : 0;

/**
 * The local arms' action from the predicted action state. Priority: heal, reload, swap-in, cook, throw recovery,
 * punch (fists within one fire interval of the last swing), idle.
 */
export function localVmAction(a: PredictedActions, balance: Balance): VmAction {
  const held = heldOf(a);
  const cooking = a.cook !== null;
  if (a.heal) return { item: a.heal.item, cooking, action: 'heal', actionProgress: progressOf(a.heal.remainingMs, a.heal.totalMs) };
  if (a.reload) return { item: held, cooking, action: 'reload', actionProgress: progressOf(a.reload.remainingMs, a.reload.totalMs) };
  if (a.swapRemainingMs > 0) {
    return { item: held, cooking, action: 'swapIn', actionProgress: progressOf(a.swapRemainingMs, balance.combat.swapMs) };
  }
  const now = actionsNowMs(a);
  if (a.cook) {
    const fuse = balance.items.grenade.fuseMs;
    return { item: held, cooking, action: 'cook', actionProgress: progressOf(a.cook.explodesAt - now, fuse) };
  }
  if (a.throwRecoveryMs > 0) {
    return { item: held, cooking, action: 'throw', actionProgress: progressOf(a.throwRecoveryMs, balance.items.grenade.throwRecoveryMs) };
  }
  if (held === 'fists') {
    const interval = balance.weapons.fists.fireIntervalMs;
    const since = now - a.lastShotAt;
    if (since >= 0 && since < interval) return { item: held, cooking, action: 'punch', actionProgress: since / interval };
  }
  return { item: held, cooking, action: 'idle', actionProgress: 0 };
}

/** A spectated player's arms from their anim flags (progress 0: the snapshot has no timers for remotes). */
export function remoteVmAction(p: Pick<PlayerState, 'weapon' | 'anim'>): VmAction {
  const a = p.anim;
  const base = { item: p.weapon, cooking: a.cooking, actionProgress: 0 };
  if (a.healing) return { ...base, action: 'heal' };
  if (a.reloading) return { ...base, action: 'reload' };
  if (a.cooking) return { ...base, action: 'cook' };
  if (a.firing && p.weapon === 'fists') return { ...base, action: 'punch' };
  return { ...base, action: 'idle' };
}

export interface ViewmodelArgs {
  playerId: PlayerId;
  appearance: Appearance;
  vestTier: ArmorTierOrNone;
  act: VmAction;
  adsBlend: number;
  visible: boolean;
  shotCount: number;
  stance: Stance;
  stanceFrom: Stance;
  stanceProgress: number;
  dropPhase: DropPhase | null;
  bobPhase: number;
  bobAmount: number;
  sprinting: boolean;
  lookRate: { yaw: number; pitch: number };
  motionScale: number;
}

export function buildViewmodel(a: ViewmodelArgs): ViewmodelView {
  return {
    playerId: a.playerId,
    appearance: a.appearance,
    vestTier: a.vestTier,
    item: a.act.item,
    cooking: a.act.cooking,
    action: a.act.action,
    actionProgress: a.act.actionProgress,
    adsBlend: a.adsBlend,
    visible: a.visible,
    shotCount: a.shotCount,
    stance: a.stance,
    stanceFrom: a.stanceFrom,
    stanceProgress: a.stanceProgress,
    dropPhase: a.dropPhase,
    bobPhase: a.bobPhase,
    bobAmount: a.bobAmount,
    sprinting: a.sprinting,
    lookRate: { ...a.lookRate },
    motionScale: a.motionScale,
  };
}

/** Smoothed look speed (rad/s) for the viewmodel's sway lag. Restarts on a new subject. */
export class LookRate {
  private subject: PlayerId | null = null;
  private last: { yaw: number; pitch: number } | null = null;
  private rate = { yaw: 0, pitch: 0 };

  reset(): void {
    this.subject = null;
    this.last = null;
    this.rate = { yaw: 0, pitch: 0 };
  }

  update(subject: PlayerId, yaw: number, pitch: number, dt: number): { yaw: number; pitch: number } {
    if (subject !== this.subject) {
      this.reset();
      this.subject = subject;
    }
    if (this.last && dt > 0) {
      const k = 1 - Math.exp((-dt * 1000) / LOOK_RATE_SMOOTHING_MS);
      const ry = wrapAngle(yaw - this.last.yaw) / dt;
      const rp = (pitch - this.last.pitch) / dt;
      this.rate = { yaw: this.rate.yaw + (ry - this.rate.yaw) * k, pitch: this.rate.pitch + (rp - this.rate.pitch) * k };
    }
    this.last = { yaw, pitch };
    return this.rate;
  }
}

/**
 * camera.md "Viewmodel": a spectated player's ADS is shown from anim.ads, with the scope overlay once adsTimeMs has
 * passed since it turned on. Returns the equivalent adsMs (ms since anim.ads rose; 0 when off). `now` = client ms.
 */
export class SpectateAdsClock {
  private subject: PlayerId | null = null;
  private since: number | null = null;

  reset(): void {
    this.subject = null;
    this.since = null;
  }

  update(subject: PlayerId, ads: boolean, now: number): number {
    if (subject !== this.subject) {
      this.subject = subject;
      this.since = null;
    }
    if (!ads) {
      this.since = null;
      return 0;
    }
    if (this.since === null) this.since = now;
    return Math.max(0, now - this.since);
  }
}

/** Monotonic shot counts per player (ViewmodelView.shotCount, recoil impulses). Reset per match. */
export class ShotCounter {
  private readonly counts = new Map<PlayerId, number>();

  add(id: PlayerId): void {
    this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
  }

  of(id: PlayerId): number {
    return this.counts.get(id) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}
