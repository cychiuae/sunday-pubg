/**
 * Pure input state: raw key/button/mouse events in, one PlayerInput per fixed step out. No DOM access, so it is
 * fully unit-testable; InputController feeds it from browser events.
 *
 * - Held fields (move, sprint, fire) reflect the state at sample time.
 * - Edge fields (jump, reload, interact, useHeal, selectSlot) latch on key-down and are true for exactly one
 *   sampled input, then clear (ARCHITECTURE §6 "latched edge buttons").
 * - `fire` is true if LMB is held OR was pressed since the last sample (so a click shorter than one tick still
 *   fires). If LMB was released and pressed again within one tick while the previous input already had fire=true,
 *   this input sends fire=false so the sim sees a fresh trigger edge on the next one (semi-auto weapons).
 */
import { PITCH_MAX, PITCH_MIN } from '../../shared/constants';
import { clamp, wrapAngle } from '../../shared/math';
import type { PlayerInput, SlotIndex } from '../../shared/types';

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
  | 'slot3';

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
};

/** Mouse button index for fire (MouseEvent.button). */
export const FIRE_BUTTON = 0;

const SLOT_FOR_ACTION: Partial<Record<GameAction, SlotIndex>> = { slot1: 0, slot2: 1, slot3: 2 };

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
  private wheelLatch: 1 | -1 | 0 = 0;
  private firePressedLatch = false;
  private fireReleasedLatch = false;
  private lastSentFire = false;
  private deferredFire = false;
  /** Space or LMB pressed; consumed by the spectate camera (separate from the jump/fire latches). */
  private spectateNextLatch = false;

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

  /** Snap the look angles (e.g. to the spawn facing). */
  setLook(yaw: number, pitch: number): void {
    this.yaw = wrapAngle(yaw);
    this.pitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
  }

  /** Mouse movement in pixels (MouseEvent.movementX/Y). Right turns right, up looks up (unless invertY). */
  look(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const k = this.radiansPerPixel * this.sensitivity;
    this.yaw = wrapAngle(this.yaw - dx * k);
    const dPitch = dy * k * (this.invertY ? 1 : -1);
    this.pitch = clamp(this.pitch + dPitch, PITCH_MIN, PITCH_MAX);
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
      default: {
        const slot = SLOT_FOR_ACTION[action];
        if (slot !== undefined) this.slotLatch = slot;
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
    if (button !== FIRE_BUTTON || this.fireHeld) return;
    this.fireHeld = true;
    this.firePressedLatch = true;
    this.spectateNextLatch = true;
  }

  buttonUp(button: number): void {
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
  }

  /** Drop pending edges without producing an input (used while the local player cannot act). */
  clearEdges(): void {
    this.jumpLatch = false;
    this.reloadLatch = false;
    this.interactLatch = false;
    this.healLatch = false;
    this.slotLatch = -1;
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
    if (selectSlot === -1 && this.wheelLatch !== 0 && resolveWheel) selectSlot = resolveWheel(this.wheelLatch);

    const input: PlayerInput = {
      seq,
      dt,
      moveForward,
      moveRight,
      yaw: this.yaw,
      pitch: this.pitch,
      sprint: this.heldActions.has('sprint'),
      fire,
      jump: this.jumpLatch,
      reload: this.reloadLatch,
      interact: this.interactLatch,
      useHeal: this.healLatch,
      selectSlot,
    };

    this.clearEdges();
    // After a forced gap the click must still fire next tick, even if the button is already up again.
    this.deferredFire = forcedGap;
    this.lastSentFire = fire;
    return { input, firePressed };
  }
}

/** Next/previous selectable slot for the mouse wheel: weapon slots that hold a gun, plus fists (always). */
export function cycleSlot(
  current: SlotIndex,
  filled: readonly [boolean, boolean],
  direction: 1 | -1,
): SlotIndex | -1 {
  const order: SlotIndex[] = [0, 1, 2];
  const available = order.filter((s) => s === 2 || filled[s as 0 | 1]);
  if (available.length <= 1) return -1;
  const idx = available.indexOf(current);
  const start = idx === -1 ? 0 : idx;
  const next = available[(start + direction + available.length) % available.length] as SlotIndex;
  return next === current ? -1 : next;
}
