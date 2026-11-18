/**
 * Internal (server-side) player record shared by World and bots. Not part of the wire format.
 */
import type {
  Appearance,
  DeathCause,
  GunId,
  HealId,
  MovementState,
  PlayerId,
  PlayerInput,
  WeaponId,
} from '../types';
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
  weapon: WeaponId | null;
  cause: DeathCause;
  /** The lethal hit was a headshot (kill event `headshot`). */
  headshot?: boolean;
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
  armor: number;
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
  queue: PlayerInput[];
  lastInput: PlayerInput | null;
  /** Consecutive ticks the last input has been repeated because the queue was empty (MAX_INPUT_REPEAT_TICKS). */
  inputRepeatTicks: number;
  lastProcessedInputSeq: number;
  /** Last enemy damage for kill credit and for bots turning toward attackers. */
  lastDamagedBy: { id: PlayerId; at: number } | null;
  /** hp + armor at the start of the current tick (same-tick death ordering). */
  tickStartHpArmor: number;
  placement: number | null;
  /** Bot brain (null for humans). */
  brain: BotBrain | null;
}
