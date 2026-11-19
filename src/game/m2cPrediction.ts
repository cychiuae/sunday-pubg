/**
 * M2c local feedback on top of the shared action step (ADR 0007 §3, §5, §6). Owner: game-developer.
 *
 * The shared action step (src/shared/sim/actions.ts) owns every rule: the throwable cycle, the melee swing timing and
 * the T sight switch run in the client's Predictor exactly as in the World and reconcile by input seq. This module only
 * turns the predicted action states into what the HUD, the arms and the bus need within a frame:
 * - `throwableCycled` when a 4 / G press changed the selection while the throwable slot stayed held, and the 'cycle'
 *   arms for combat.throwableCycleMs;
 * - the local `meleeSwing` event on the tick a swing starts (the server echo is ignored), and the swing record that
 *   outlives the action state's wind-up: `meleeRecovery`, the 'swing' arms and `PlayerView.swing`;
 * - the T switch's TARGET sight and pouch during the switch (sim scopeCyclePlan on the predicted inventory), so the
 *   HUD chip changes on the press while the sim applies the change at the end.
 *
 * Called by ClientGame once per NEW input (never for replays). Times are server ms on the predicted action timeline.
 */
import type { Balance } from '../shared/balance';
import type { MeleeSwingView } from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import { selectedThrowableOf } from '../shared/sim/actions';
import { effWeapon } from '../shared/sim/levels';
import { scopeCyclePlan } from '../shared/sim/scopes';
import type { ItemLevel, MeleeId, PlayerId, ScopeId } from '../shared/types';
import { GRENADE_SLOT } from '../shared/types';
import { actionsNowMs, type PredictedActions } from './actionPrediction';

/** A predicted melee swing on the action timeline (kept through the recovery, after the wind-up state is gone). */
export interface PredictedSwing {
  weapon: MeleeId;
  level: ItemLevel;
  startMs: number;
  cycleMs: number;
  hitFrameMs: number;
}

/** Events one input produced (ClientGame emits them; it fills `pos`). */
export interface M2cStepEvents {
  throwableCycled: GameEvents['throwableCycled'] | null;
  meleeSwing: Omit<GameEvents['meleeSwing'], 'pos'> | null;
}

/** HUD scope fields from the predicted inventory: a running T switch shows its target. */
export interface PredictedScopes {
  slotScopes: [ScopeId | null, ScopeId | null];
  spare: ScopeId | null;
  /** 0..1 through the T switch, else null. */
  progress: number | null;
}

export class M2cLocalPredictor {
  /** Action ms the last throwable cycle started, or null. */
  private cycleStartMs: number | null = null;
  private lastSwingAt = -Infinity;
  private swingNow: PredictedSwing | null = null;

  reset(): void {
    this.cycleStartMs = null;
    this.lastSwingAt = -Infinity;
    this.swingNow = null;
  }

  /** Death or the end of local control. */
  clearTransient(): void {
    this.cycleStartMs = null;
    this.swingNow = null;
  }

  /** Server ms of the last predicted swing start (-Infinity before one). */
  get lastSwingStart(): number {
    return this.lastSwingAt;
  }

  /** One NEW input: the predicted action state before and after it. */
  step(before: PredictedActions, after: PredictedActions, playerId: PlayerId, balance: Balance): M2cStepEvents {
    const out: M2cStepEvents = { throwableCycled: null, meleeSwing: null };
    const now = actionsNowMs(after);

    // ---- Throwable cycle: the selection changed while slot 3 stayed held ----
    const from = selectedThrowableOf(before.inv);
    const to = selectedThrowableOf(after.inv);
    if (before.inv.activeSlot === GRENADE_SLOT && after.inv.activeSlot === GRENADE_SLOT && from !== to) {
      this.cycleStartMs = now;
      out.throwableCycled = { from, to };
    }
    if (after.inv.activeSlot !== GRENADE_SLOT) this.cycleStartMs = null;

    // ---- Melee swing: a new wind-up in the shared state ----
    if (before.inv.activeSlot !== after.inv.activeSlot) this.swingNow = null;
    const sw = after.swing ?? null;
    if (sw && (!before.swing || before.swing.hitAt !== sw.hitAt)) {
      const eff = effWeapon(balance, sw.weapon, sw.level);
      const startMs = sw.hitAt - eff.hitFrameMs;
      this.lastSwingAt = startMs;
      this.swingNow = { weapon: sw.weapon, level: sw.level, startMs, cycleMs: eff.fireIntervalMs, hitFrameMs: eff.hitFrameMs };
      out.meleeSwing = {
        playerId,
        weapon: sw.weapon,
        level: sw.level,
        windupMs: Math.max(0, sw.hitAt - now),
        cycleMs: eff.fireIntervalMs,
        isLocal: true,
      };
    } else if (before.swing && !sw && after.lastShotAt === before.lastShotAt) {
      // The wind-up ended without a hit frame (cancelled: swap, drop): no recovery to show.
      this.swingNow = null;
    }
    return out;
  }

  /** 0..1 through a throwable cycle (arms 'cycle'), else null. */
  cycleProgress(balance: Balance, nowMs: number): number | null {
    const total = balance.combat.throwableCycleMs;
    if (this.cycleStartMs === null || !(total > 0)) return null;
    const p = (nowMs - this.cycleStartMs) / total;
    return p >= 0 && p < 1 ? p : null;
  }

  /** The predicted swing while it runs, else null. */
  swing(nowMs: number): PredictedSwing | null {
    const s = this.swingNow;
    if (!s) return null;
    if (nowMs - s.startMs >= s.cycleMs) {
      this.swingNow = null;
      return null;
    }
    return s;
  }

  /** HudLocalView.meleeRecovery: 0 during the wind-up, then 0..1 to the end of the cycle; null when ready. */
  meleeRecovery(nowMs: number): number | null {
    const s = this.swing(nowMs);
    if (!s) return null;
    const t = nowMs - s.startMs;
    if (t < s.hitFrameMs) return 0;
    const rec = s.cycleMs - s.hitFrameMs;
    return rec > 0 ? clamp01((t - s.hitFrameMs) / rec) : null;
  }

  /** PlayerView.swing / the viewmodel for the local player. */
  swingView(nowMs: number): MeleeSwingView | null {
    const s = this.swing(nowMs);
    return s ? swingViewOf(s.weapon, nowMs - s.startMs, s.cycleMs, s.hitFrameMs) : null;
  }
}

/**
 * HUD scope fields of a predicted action state: the inventory's scopes and pouch, with a running T switch showing its
 * target (the sim's scopeCyclePlan on the same inventory, re-planned at the end exactly like finishScopeSwap).
 */
export function predictedScopes(a: PredictedActions, balance: Balance): PredictedScopes {
  const inv = a.inv;
  const slotScopes: [ScopeId | null, ScopeId | null] = [inv.slots[0]?.scope ?? null, inv.slots[1]?.scope ?? null];
  let spare = inv.spareScope ?? null;
  const sw = a.scopeSwap ?? null;
  if (!sw) return { slotScopes, spare, progress: null };
  const plan = scopeCyclePlan({ slots: inv.slots, activeSlot: sw.slot, spareScope: spare }, balance);
  if (plan.kind === 'swap') {
    slotScopes[plan.slot] = plan.to;
    spare = plan.pouch;
  }
  const total = balance.scopes.swapMs;
  return { slotScopes, spare, progress: total > 0 ? clamp01(1 - sw.remainingMs / total) : null };
}

/** MeleeSwingView at `elapsedMs` into a swing. */
export function swingViewOf(weapon: MeleeId, elapsedMs: number, cycleMs: number, hitFrameMs: number): MeleeSwingView {
  return {
    weapon,
    progress: cycleMs > 0 ? clamp01(elapsedMs / cycleMs) : 1,
    hitFraction: cycleMs > 0 ? clamp01(hitFrameMs / cycleMs) : 0,
  };
}

/** Remote melee swings from `meleeSwing` SimEvents (no per-tick swing state on the wire, ADR 0007 §9.3). */
export class RemoteSwingTracker {
  private readonly swings = new Map<PlayerId, { weapon: MeleeId; startMs: number; cycleMs: number; hitFrameMs: number }>();

  reset(): void {
    this.swings.clear();
  }

  /** SimEvent meleeSwing: the hit frame is at `hitAt`; the wind-up started hitFrameMs before it. */
  onSwing(ev: { playerId: PlayerId; weapon: MeleeId; level: ItemLevel; hitAt: number; cycleMs: number }, balance: Balance): void {
    const eff = effWeapon(balance, ev.weapon, ev.level);
    const cycle = ev.cycleMs > 0 ? ev.cycleMs : eff.fireIntervalMs;
    const hit = Math.min(eff.hitFrameMs, cycle);
    this.swings.set(ev.playerId, { weapon: ev.weapon, startMs: ev.hitAt - hit, cycleMs: cycle, hitFrameMs: hit });
  }

  /** Death or leaving cancels a swing. */
  cancel(id: PlayerId): void {
    this.swings.delete(id);
  }

  /** The swing at render time `t` (server ms, the remotes' interpolation time), else null. Prunes finished swings. */
  view(id: PlayerId, t: number): MeleeSwingView | null {
    const s = this.swings.get(id);
    if (!s) return null;
    const e = t - s.startMs;
    if (e >= s.cycleMs) {
      this.swings.delete(id);
      return null;
    }
    if (e < 0) return null;
    return swingViewOf(s.weapon, e, s.cycleMs, s.hitFrameMs);
  }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
