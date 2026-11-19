/**
 * Internal (server-side) player record shared by World and bots. Not part of the wire format.
 */
import type {
  Appearance,
  ArmorPieceState,
  DeathCause,
  GunId,
  HealId,
  HeldId,
  ItemLevel,
  MovementState,
  PlayerId,
  PlayerInput,
  SlotIndex,
  WeaponId,
} from '../types';
import type { ScopeSwapState, SwingState } from './actions';
import type { BotBrain } from './bots';
import type { Inventory } from './inventory';

export interface ReloadState {
  slot: 0 | 1;
  weapon: GunId;
  remainingMs: number;
  totalMs: number;
}

export interface HealState {
  item: HealId;
  remainingMs: number;
  totalMs: number;
}

export interface PendingDeath {
  killerId: PlayerId | null;
  weapon: HeldId | null;
  cause: DeathCause;
  /** The lethal hit was a headshot (kill event `headshot`). */
  headshot?: boolean;
  /** M2c: level of `weapon` at the kill (null for fists, frags, zone, fall). */
  weaponLevel?: ItemLevel | null;
  /** M2c: a rocket kill whose rocket struck the victim. */
  direct?: boolean;
}

export interface SimPlayer {
  id: PlayerId;
  name: string;
  isBot: boolean;
  appearance: Appearance;
  /** Participant still in the match world (false after death resolution or disconnect). */
  alive: boolean;
  /** Took lethal damage this tick; resolved (placement, drops, kill event) at the end of the tick. */
  dying: PendingDeath | null;
  /** Disconnected mid-match (hidden from snapshots, kept in standings). */
  left: boolean;
  hp: number;
  /** M2a: worn vest / helmet (armor.md), null = none. Replaces the M1 `armor` number. */
  vest: ArmorPieceState | null;
  helmet: ArmorPieceState | null;
  kills: number;
  move: MovementState;
  yaw: number;
  pitch: number;
  inv: Inventory;
  reload: ReloadState | null;
  heal: HealState | null;
  swapRemainingMs: number;
  /** Server ms when the next shot may fire. */
  nextFireAt: number;
  prevFire: boolean;
  /** Semi-auto click buffered until it can fire (or the button is released). */
  triggerLatched: boolean;
  /** anim.firing stays true until this server ms. */
  firingUntil: number;
  /** M2a: server ms of the last shot (combat.fireMoveWindowMs slow-down), -Infinity before the first. */
  lastShotAt: number;
  /** M2a: weapon of the last shot or melee hit frame (the fire-move window only applies while it is still in hand). */
  lastShotWeapon: WeaponId | null;
  /** M2a: grenade in hand with the pin pulled (explodes at this server ms), or null. */
  cook: { explodesAt: number } | null;
  /** M2a: ms until the next pin pull is allowed (items.grenade.throwRecoveryMs after a throw). */
  throwRecoveryMs: number;
  /** M2a: last non-grenade slot held (auto-switch target after the last grenade is thrown). */
  lastGunSlot: SlotIndex;
  /** M2c: melee swing in its wind-up (actions.ts). */
  swing: SwingState | null;
  /** M2c: running T sight switch (actions.ts). */
  scopeSwap: ScopeSwapState | null;
  /** M2c: LMB held with a smoke selected. */
  smokeHeld: boolean;
  /** M2c: server ms of the last damage taken from anyone (bots: smoke on a zone escape). */
  lastHurtAt: number;
  queue: PlayerInput[];
  lastInput: PlayerInput | null;
  /** Consecutive ticks the last input has been repeated because the queue was empty (MAX_INPUT_REPEAT_TICKS). */
  inputRepeatTicks: number;
  lastProcessedInputSeq: number;
  /** Last enemy damage for kill credit and for bots turning toward attackers. */
  lastDamagedBy: { id: PlayerId; at: number } | null;
  /** hp + vest + helmet durability at the start of the current tick (same-tick death ordering). */
  tickStartHpArmor: number;
  placement: number | null;
  /** Bot brain (null for humans). */
  brain: BotBrain | null;
  /**
   * M2b (drop.md "Aboard"): riding the carrier. move.pos = the carrier position every tick, move.dropping = true with
   * dropPhase null. Invulnerable, untargetable, ignored by blasts and zone damage; only look and the jump edge work.
   */
  aboard: boolean;
  /**
   * BUG-010: the input processed this tick was a server-injected stall-neutral input (queue empty for more than
   * MAX_INPUT_REPEAT_TICKS). The trigger latch, prevFire and adsMs are left as they were.
   */
  stalled: boolean;
}
