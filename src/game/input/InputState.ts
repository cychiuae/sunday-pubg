/**
 * Pure input state: raw key/button/mouse events in, one PlayerInput per fixed step out. No DOM access, so it is
 * fully unit-testable; InputController feeds it from browser events.
 *
 * - Held fields (move, sprint, fire, ads) reflect the state at sample time.
 * - Edge fields (jump, reload, interact, useHeal, selectSlot, stanceToggle) latch on key-down and are true for exactly
 *   one sampled input, then clear (ARCHITECTURE §6 "latched edge buttons").
 * - M2a ADS (RMB): in 'hold' mode `ads` is RMB held. In 'toggle' mode each RMB press flips a latch that is sent as the
 *   held flag; the latch clears on any slot change, a sprint press, death (ClientGame calls clearAdsToggle) and when
 *   input is released (pointer lock lost). A press only latches while ADS is allowed for the item in hand
 *   (setAdsAllowed), so a toggled RMB with fists or the grenade never suppresses sprint by accident.
 * - M2a stance: C -> 'crouch', Z -> 'prone'; when both are pressed within one tick the later press wins. Ctrl is
 *   never bound (Ctrl+W closes the tab).
 * - M2a look: the per-pixel turn rate is multiplied by a look scale (ClientGame sets it each frame from the ADS
 *   zoom and Settings.adsSensitivity).
 * - M2b: F is a second jump key that only works while ClientGame enables it (aboard the carrier or dropping:
 *   setAltJumpEnabled); V latches the spectate view toggle (consumeViewToggle). The look clamp follows the sim's
 *   pitchLimits (setPitchLimits): mouse look never leaves the range, and a pitch already outside it (entering prone)
 *   is eased in by ClientGame (easePitchIntoLimits) over the stance transition.
 * - `fire` is true if LMB is held OR was pressed since the last sample (so a click shorter than one tick still
 *   fires). If LMB was released and pressed again within one tick while the previous input already had fire=true,
 *   this input sends fire=false so the sim sees a fresh trigger edge on the next one (semi-auto weapons).
 */
import { PITCH_MAX, PITCH_MIN } from '../../shared/constants';
import { clamp, wrapAngle } from '../../shared/math';
import type { AdsMode } from '../../shared/contracts';
import type { PlayerInput, SlotIndex, StanceRequest } from '../../shared/types';

export type GameAction =
  | 'forward'
  | 'back'
  | 'left'
  | 'right'
  | 'sprint'
  | 'jump'
  | 'reload'
  | 'interact'
  | 'heal'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'crouch'
  | 'prone'
  | 'jumpAlt'
  | 'spectateView';

/** Keyed by KeyboardEvent.code (layout independent: KeyW is W on QWERTY, Z on AZERTY). */
export const DEFAULT_KEY_BINDINGS: Readonly<Record<string, GameAction>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  ArrowUp: 'forward',
  ArrowDown: 'back',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'jump',
  KeyR: 'reload',
  KeyE: 'interact',
  KeyQ: 'heal',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Numpad1: 'slot1',
  Numpad2: 'slot2',
  Numpad3: 'slot3',
  Digit4: 'slot4',
  Numpad4: 'slot4',
  KeyG: 'slot4',
  KeyC: 'crouch',
  KeyZ: 'prone',
  // M2b: F = jump/deploy while aboard or dropping only (drop.md); V = spectate view toggle (camera.md).
  KeyF: 'jumpAlt',
  KeyV: 'spectateView',
};

/** Mouse button index for fire (MouseEvent.button). */
export const FIRE_BUTTON = 0;
/** M2a: mouse button index for aim down sights (MouseEvent.button 2 = right). */
export const ADS_BUTTON = 2;

const SLOT_FOR_ACTION: Partial<Record<GameAction, SlotIndex>> = { slot1: 0, slot2: 1, slot3: 2, slot4: 3 };
const STANCE_FOR_ACTION: Partial<Record<GameAction, StanceRequest>> = { crouch: 'crouch', prone: 'prone' };

export interface SampledInput {
  input: PlayerInput;
  /** LMB went down since the previous sample (for client-side dryFire). */
  firePressed: boolean;
}

/** Resolves a mouse-wheel step (+1 next, -1 previous) to a slot, or -1 for no change. */
export type WheelResolver = (direction: 1 | -1) => SlotIndex | -1;

export class InputState {
  /** Latest look angles (radians). Rendered every frame; sampled into each input. */
  yaw = 0;
  pitch = 0;

  private radiansPerPixel: number;
  private sensitivity = 1;
  private invertY = false;
  /** M2a: extra look multiplier while aiming (1 / zoom x ADS sensitivity), set per frame by ClientGame. */
  private lookScale = 1;
  private adsMode: AdsMode = 'hold';
  private adsAllowed = true;
  private adsHeld = false;
  private adsToggled = false;

  private readonly heldActions = new Set<GameAction>();
  /** code -> action, so key-up releases the action that key-down set even if bindings change. */
  private readonly downCodes = new Map<string, GameAction>();
  private fireHeld = false;

  // Edge latches (cleared by sample() / clearEdges()).
  private jumpLatch = false;
  private reloadLatch = false;
  private interactLatch = false;
  private healLatch = false;
  private slotLatch: SlotIndex | -1 = -1;
  private stanceLatch: StanceRequest | null = null;
  private wheelLatch: 1 | -1 | 0 = 0;
  private firePressedLatch = false;
  private fireReleasedLatch = false;
  private lastSentFire = false;
  private deferredFire = false;
  /** Space or LMB pressed; consumed by the spectate camera (separate from the jump/fire latches). */
  private spectateNextLatch = false;
  /** M2b: V pressed (spectate FP / chase toggle). */
  private viewToggleLatch = false;
  /** M2b: F counts as the jump edge (aboard or dropping). */
  private altJumpEnabled = false;
  /** M2b: current sim pitch range (stance.ts pitchLimits). */
  private pitchMin = PITCH_MIN;
  private pitchMax = PITCH_MAX;

  constructor(
    radiansPerPixel: number,
    private readonly bindings: Readonly<Record<string, GameAction>> = DEFAULT_KEY_BINDINGS,
  ) {
    this.radiansPerPixel = radiansPerPixel;
  }

  setSensitivity(multiplier: number, invertY: boolean): void {
    this.sensitivity = Number.isFinite(multiplier) ? multiplier : 1;
    this.invertY = invertY;
  }

  setRadiansPerPixel(radiansPerPixel: number): void {
    this.radiansPerPixel = radiansPerPixel;
  }

  /** M2a: multiplier on look speed (ADS zoom and ADS sensitivity). Non-finite or <= 0 values reset it to 1. */
  setLookScale(scale: number): void {
    this.lookScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  get currentLookScale(): number {
    return this.lookScale;
  }

  /** M2a: Settings.adsMode. Switching modes drops the toggle latch. */
  setAdsMode(mode: AdsMode): void {
    if (mode !== this.adsMode) this.adsToggled = false;
    this.adsMode = mode;
  }

  /**
   * M2a: whether the item in hand has a sight (ClientGame, per frame). Toggle mode only latches a press while
   * allowed; hold mode always sends the held button (the sim ignores ADS without a sight).
   */
  setAdsAllowed(allowed: boolean): void {
    this.adsAllowed = allowed;
  }

  /** M2a: drop the toggle latch (death, slot change seen in a snapshot). */
  clearAdsToggle(): void {
    this.adsToggled = false;
  }

  /** M2a: the `ads` flag the next input would carry. */
  get adsActive(): boolean {
    return this.adsMode === 'hold' ? this.adsHeld : this.adsToggled;
  }

  /** M2b: F maps to the jump edge only while this is on (ClientGame: aboard or dropping). */
  setAltJumpEnabled(enabled: boolean): void {
    this.altJumpEnabled = enabled;
  }

  /** M2b: the sim pitch range for the predicted stance (stance.ts pitchLimits), within PITCH_MIN..PITCH_MAX. */
  setPitchLimits(min: number, max: number): void {
    this.pitchMin = Math.max(PITCH_MIN, Number.isFinite(min) ? min : PITCH_MIN);
    this.pitchMax = Math.min(PITCH_MAX, Number.isFinite(max) ? max : PITCH_MAX);
  }

  get pitchLimits(): { min: number; max: number } {
    return { min: this.pitchMin, max: this.pitchMax };
  }

  /**
   * M2b (camera.md "Prone pitch"): move a pitch that is outside the limits toward them by `alpha` of the gap (1 = snap).
   * ClientGame passes frame dt / remaining transition time, so the camera eases in over the stance transition.
   */
  easePitchIntoLimits(alpha: number): void {
    const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
    if (this.pitch > this.pitchMax) this.pitch = a >= 1 ? this.pitchMax : this.pitch - (this.pitch - this.pitchMax) * a;
    else if (this.pitch < this.pitchMin) this.pitch = a >= 1 ? this.pitchMin : this.pitch + (this.pitchMin - this.pitch) * a;
  }

  /** M2b: true once per V press. */
  consumeViewToggle(): boolean {
    const v = this.viewToggleLatch;
    this.viewToggleLatch = false;
    return v;
  }

  /** Snap the look angles (e.g. to the spawn facing). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
  }

  /** Mouse movement in pixels (MouseEvent.movementX/Y). Right turns right, up looks up (unless invertY). */
  look(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const k = this.radiansPerPixel * this.sensitivity * this.lookScale;
    this.yaw = wrapAngle(this.yaw - dx * k);
    const dPitch = dy * k * (this.invertY ? 1 : -1);
    // Never further out of the sim range; a pitch still outside it (being eased in) may move toward it.
    const lo = Math.min(this.pitchMin, this.pitch);
    const hi = Math.max(this.pitchMax, this.pitch);
    this.pitch = clamp(this.pitch + dPitch, Math.max(PITCH_MIN, lo), Math.min(PITCH_MAX, hi));
  }

  /** Returns true if the code is bound (caller may preventDefault). `repeat` = OS auto-repeat. */
  keyDown(code: string, repeat = false): boolean {
    const action = this.bindings[code];
    if (!action) return false;
    if (repeat || this.downCodes.has(code)) return true;
    this.downCodes.set(code, action);
    this.heldActions.add(action);
    switch (action) {
      case 'jump':
        this.jumpLatch = true;
        this.spectateNextLatch = true;
        break;
      case 'reload':
        this.reloadLatch = true;
        break;
      case 'interact':
        this.interactLatch = true;
        break;
      case 'heal':
        this.healLatch = true;
        break;
      case 'sprint':
        this.adsToggled = false;
        break;
      case 'jumpAlt':
        if (this.altJumpEnabled) this.jumpLatch = true;
        break;
      case 'spectateView':
        this.viewToggleLatch = true;
        break;
      default: {
        const slot = SLOT_FOR_ACTION[action];
        if (slot !== undefined) {
          this.slotLatch = slot;
          this.adsToggled = false;
        }
        const stance = STANCE_FOR_ACTION[action];
        if (stance !== undefined) this.stanceLatch = stance;
      }
    }
    return true;
  }

  keyUp(code: string): boolean {
    const action = this.downCodes.get(code);
    if (!action) return this.bindings[code] !== undefined;
    this.downCodes.delete(code);
    // Another key bound to the same action may still be down (e.g. W and ArrowUp).
    let stillHeld = false;
    for (const a of this.downCodes.values()) if (a === action) stillHeld = true;
    if (!stillHeld) this.heldActions.delete(action);
    return true;
  }

  buttonDown(button: number): void {
    if (button === ADS_BUTTON) {
      if (this.adsHeld) return;
      this.adsHeld = true;
      if (this.adsMode === 'toggle') this.adsToggled = this.adsToggled ? false : this.adsAllowed;
      return;
    }
    if (button !== FIRE_BUTTON || this.fireHeld) return;
    this.fireHeld = true;
    this.firePressedLatch = true;
    this.spectateNextLatch = true;
  }

  buttonUp(button: number): void {
    if (button === ADS_BUTTON) {
      this.adsHeld = false;
      return;
    }
    if (button !== FIRE_BUTTON || !this.fireHeld) return;
    this.fireHeld = false;
    this.fireReleasedLatch = true;
  }

  /** WheelEvent.deltaY: positive = scroll down = next slot. */
  wheel(deltaY: number): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    this.wheelLatch = deltaY > 0 ? 1 : -1;
  }

  isHeld(action: GameAction): boolean {
    return this.heldActions.has(action);
  }

  get isFireHeld(): boolean {
    return this.fireHeld;
  }

  /** Release every held key and button (pointer lock lost, window blur) so nothing sticks. Keeps look angles. */
  releaseAll(): void {
    this.heldActions.clear();
    this.downCodes.clear();
    if (this.fireHeld) this.fireReleasedLatch = true;
    this.fireHeld = false;
    this.adsHeld = false;
    this.adsToggled = false;
  }

  /** Drop pending edges without producing an input (used while the local player cannot act). */
  clearEdges(): void {
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.interactLatch = false;
    this.healLatch = false;
    this.slotLatch = -1;
    this.stanceLatch = null;
    this.wheelLatch = 0;
    this.firePressedLatch = false;
    this.fireReleasedLatch = false;
    this.lastSentFire = false;
    this.deferredFire = false;
  }

  /** True once per Space/LMB press. Call every frame; the result is discarded when not spectating. */
  consumeSpectateNext(): boolean {
    const v = this.spectateNextLatch;
    this.spectateNextLatch = false;
    return v;
  }

  /** Build the next PlayerInput and clear edge latches. */
  sample(seq: number, dt: number, resolveWheel?: WheelResolver): SampledInput {
    let moveForward = (this.heldActions.has('forward') ? 1 : 0) - (this.heldActions.has('back') ? 1 : 0);
    let moveRight = (this.heldActions.has('right') ? 1 : 0) - (this.heldActions.has('left') ? 1 : 0);
    const len = Math.hypot(moveForward, moveRight);
    if (len > 1) {
      moveForward /= len;
      moveRight /= len;
    }

    let fire = this.fireHeld || this.firePressedLatch || this.deferredFire;
    let forcedGap = false;
    if (fire && this.lastSentFire && this.firePressedLatch && this.fireReleasedLatch) {
      // Released and re-pressed within one tick: send a gap so the sim sees a new trigger edge next tick.
      fire = false;
      forcedGap = true;
    }
    const firePressed = this.firePressedLatch;

    let selectSlot: SlotIndex | -1 = this.slotLatch;
    if (selectSlot === -1 && this.wheelLatch !== 0 && resolveWheel) {
      selectSlot = resolveWheel(this.wheelLatch);
      if (selectSlot !== -1) this.adsToggled = false;
    }

    const input: PlayerInput = {
      seq,
      dt,
      moveForward,
      moveRight,
      yaw: this.yaw,
      pitch: this.pitch,
      sprint: this.heldActions.has('sprint'),
      fire,
      ads: this.adsActive,
      jump: this.jumpLatch,
      reload: this.reloadLatch,
      interact: this.interactLatch,
      useHeal: this.healLatch,
      selectSlot,
      stanceToggle: this.stanceLatch,
    };

    this.clearEdges();
    // After a forced gap the click must still fire next tick, even if the button is already up again.
    this.deferredFire = forcedGap;
    this.lastSentFire = fire;
    return { input, firePressed };
  }
}

/**
 * Next/previous selectable slot for the mouse wheel, cycling 0 -> 1 -> 2 -> 3 -> 0: weapon slots that hold a gun,
 * fists (always), and the grenade slot only while carrying grenades (combat.md "Inventory state").
 */
export function cycleSlot(
  current: SlotIndex,
  filled: readonly [boolean, boolean],
  direction: 1 | -1,
  hasGrenades = false,
): SlotIndex | -1 {
  const order: SlotIndex[] = [0, 1, 2, 3];
  const available = order.filter((s) => s === 2 || (s === 3 ? hasGrenades : filled[s as 0 | 1]));
  const idx = available.indexOf(current);
  // Current slot not selectable any more (e.g. grenade slot at 0 grenades): step to the first/last available one.
  const next =
    idx === -1
      ? (available[direction > 0 ? 0 : available.length - 1] as SlotIndex)
      : (available[(idx + direction + available.length) % available.length] as SlotIndex);
  return next === current ? -1 : next;
}
