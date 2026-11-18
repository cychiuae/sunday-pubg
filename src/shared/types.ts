/**
 * Core shared types. Owner: tech-lead. Pure types plus a few readonly id lists.
 * Imported by sim, server, net, game, render, ui and audio. Never import anything non-shared here.
 *
 * Conventions (see docs/tech/ARCHITECTURE.md):
 * - Units: metres, Y up, sea level y = 0. Angles in radians unless a name ends in `Deg`.
 * - Yaw 0 looks toward -Z. Forward = (-sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, -sin(yaw)).
 *   Pitch > 0 looks up. Same convention as Three.js `rotation.y`.
 * - Durations: `dt` is seconds; anything named `...Ms` is milliseconds; `serverTime`/`...At` are server-clock ms.
 * - Everything here is plain JSON-serialisable data (no classes, no Maps, no undefined in arrays).
 */

// ---------------------------------------------------------------------------------------------
// Map data (fixed by the M1 brief; verbatim)
// ---------------------------------------------------------------------------------------------
export type Vec2 = { x: number; z: number };
export type PropKind = 'palm' | 'rock' | 'bush' | 'crate' | 'hut' | 'dock' | 'umbrella' | 'boat' | 'tikiTorch' | 'driftwood';
export interface PropPlacement { kind: PropKind; x: number; z: number; rotY: number; scale: number }
export type LootTier = 'common' | 'rare' | 'epic';
export interface MapData {
  id: string;
  nameKey: string;              // string key in en.json
  islandRadius: number;         // where sand meets sea level (y=0), metres from origin
  worldRadius: number;          // hard boundary, out in shallow water
  baseHeight: number;           // terrain height near island centre before hills
  beachWidth: number;           // width of sand band inside islandRadius (grass inland of it)
  shoreNoise: { amplitude: number; frequency: number; seed: number }; // makes coastline irregular
  hills: { x: number; z: number; radius: number; height: number }[];
  props: PropPlacement[];
  playerSpawns: Vec2[];
  lootSpawns: (Vec2 & { tier: LootTier })[];
  zoneCenters: Vec2[];          // candidate final-circle centres
  pois: { id: string; nameKey: string; x: number; z: number; radius: number }[];
}

// ---------------------------------------------------------------------------------------------
// Basics and ids
// ---------------------------------------------------------------------------------------------
export interface Vec3 { x: number; y: number; z: number }

/** Assigned by the sim (`World.addPlayer` for humans, internally for bots). Positive integer, unique per server run. */
export type PlayerId = number;
/** Assigned by the sim. Positive integer, unique per match. */
export type LootId = number;

export type WeaponId = 'fists' | 'pistol' | 'smg' | 'shotgun' | 'rifle';
/** Weapons that occupy a slot and can lie on the ground (everything except fists). */
export type GunId = Exclude<WeaponId, 'fists'>;
export type AmmoId = 'ammo_light' | 'ammo_heavy' | 'ammo_shell';
export type HealId = 'bandage' | 'medkit';
export type ArmorId = 'vest';
/** Anything that can exist as a ground loot item. Fists never appear as loot. */
export type ItemId = GunId | AmmoId | HealId | ArmorId;

export const WEAPON_IDS: readonly WeaponId[] = ['fists', 'pistol', 'smg', 'shotgun', 'rifle'];
export const GUN_IDS: readonly GunId[] = ['pistol', 'smg', 'shotgun', 'rifle'];
export const AMMO_IDS: readonly AmmoId[] = ['ammo_light', 'ammo_heavy', 'ammo_shell'];
export const HEAL_IDS: readonly HealId[] = ['bandage', 'medkit'];
export const ITEM_IDS: readonly ItemId[] = [...GUN_IDS, ...AMMO_IDS, ...HEAL_IDS, 'vest'];

/** Bot personality (server-only; never on the wire). Keys of balance `bots.personalities`. */
export type BotPersonalityId = 'aggressive' | 'balanced' | 'cautious';
export const BOT_PERSONALITY_IDS: readonly BotPersonalityId[] = ['aggressive', 'balanced', 'cautious'];

/** 0 and 1 are the two weapon slots (keys 1 and 2). 2 is always fists (key 3). */
export type SlotIndex = 0 | 1 | 2;
export const FISTS_SLOT: SlotIndex = 2;

export type Surface = 'sand' | 'grass' | 'water';

/** Chibi variant indices. Small non-negative ints; the character factory wraps them. Assigned by the sim. */
export interface Appearance { skin: number; outfit: number; hair: number }

// ---------------------------------------------------------------------------------------------
// Input (client -> server, and the input to the shared movement step)
// ---------------------------------------------------------------------------------------------
/**
 * One input = one sim tick (SIM_DT) of player intent. The client produces exactly one per local fixed step
 * (30 Hz) and sends each one. Held buttons are the state during the tick. Edge buttons are true for exactly
 * one input after the key was pressed (the client latches key-down events until the next input).
 */
export interface PlayerInput {
  /** Strictly increasing per connection, starting at 1. Echoed back as `lastProcessedInputSeq`. */
  seq: number;
  /** Seconds this input covers. Always SIM_DT in M1; the server clamps to [0, SIM_DT]. */
  dt: number;
  /** Camera-relative intent in [-1, 1]. +1 = forward (toward look yaw). Magnitude of (forward, right) is clamped to 1. */
  moveForward: number;
  /** Camera-relative intent in [-1, 1]. +1 = strafe right. */
  moveRight: number;
  /** Radians, any value (wrapped by the sim). */
  yaw: number;
  /** Radians, clamped by the sim to [PITCH_MIN, PITCH_MAX]. */
  pitch: number;
  // Held
  sprint: boolean;
  fire: boolean;
  // Edge (pressed since the previous input)
  jump: boolean;
  reload: boolean;
  interact: boolean;
  useHeal: boolean;
  /** -1 = no change. Otherwise the slot whose key was pressed this tick. */
  selectSlot: SlotIndex | -1;
}

// ---------------------------------------------------------------------------------------------
// Movement (shared by server sim and client prediction)
// ---------------------------------------------------------------------------------------------
export interface MovementState {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  grounded: boolean;
  /** True from spawn (in the air at match.dropHeight) until first ground contact. Uses drop fall/steer speeds. */
  dropping: boolean;
}

/** The subset of input the movement step reads, plus status modifiers computed by `toMovementInput` in the sim. */
export interface MovementInput {
  moveForward: number;
  moveRight: number;
  yaw: number;
  jump: boolean;
  sprint: boolean;
  /** 1 normally; e.g. movement.healMoveMultiplier while healing; 0 when dead. */
  speedMultiplier: number;
  /** False while healing/reloading if the design forbids sprinting then. */
  canSprint: boolean;
}

export interface MovementStepResult {
  state: MovementState;
  /** A jump started this step. */
  jumped: boolean;
  /** Transitioned from airborne to grounded this step. */
  landed: boolean;
  /** Downward speed (m/s, >= 0) at the moment of landing; 0 if not landed. Used for fall damage and land SFX. */
  landingSpeed: number;
}

// ---------------------------------------------------------------------------------------------
// Snapshot state
// ---------------------------------------------------------------------------------------------
export interface PlayerAnim {
  moving: boolean;
  sprinting: boolean;
  airborne: boolean;
  dropping: boolean;
  inWater: boolean;
  /** True for the weapon's fire interval after a shot (or 150 ms, whichever is longer). */
  firing: boolean;
  reloading: boolean;
  healing: boolean;
}

/** A player as every client sees it. Dead players stay in the list (alive = false) until the match ends. */
export interface PlayerState {
  id: PlayerId;
  name: string;
  /** Feet position. */
  pos: Vec3;
  /** Vertical velocity, for jump/fall poses. */
  velY: number;
  yaw: number;
  pitch: number;
  hp: number;
  armor: number;
  alive: boolean;
  /** Weapon currently in hand. */
  weapon: WeaponId;
  anim: PlayerAnim;
  appearance: Appearance;
  isBot: boolean;
  kills: number;
}

export interface WeaponSlotState { weapon: GunId; mag: number }

/** Extra state only the owning client receives. */
export interface LocalPlayerState {
  id: PlayerId;
  /** Seq of the last input the server applied to this player. Inputs <= this are acknowledged. */
  lastProcessedInputSeq: number;
  /**
   * Authoritative movement state at snapshot time: after `lastProcessedInputSeq`, plus any ticks the server ran on a
   * repeated input while the queue was empty (bounded by MAX_INPUT_REPEAT_TICKS). Reconciliation base.
   */
  movement: MovementState;
  slots: [WeaponSlotState | null, WeaponSlotState | null];
  activeSlot: SlotIndex;
  ammo: Record<AmmoId, number>;
  heals: Record<HealId, number>;
  /** 0 when not reloading. */
  reloadRemainingMs: number;
  reloadTotalMs: number;
  /** 0 when not healing. */
  healRemainingMs: number;
  healTotalMs: number;
  healItem: HealId | null;
  /** 0 when not swapping weapons (combat.swapMs). */
  swapRemainingMs: number;
}

export interface LootState {
  id: LootId;
  item: ItemId;
  qty: number;
  /** Resting position on the ground (the renderer adds bob/spin). */
  pos: Vec3;
  /**
   * M1-fix (producer: game-developer, sim loot spawn): tier of the spawn point this item came from; death drops use
   * 'common'. Renderer draws the tier ring from it and only falls back to nearest-spawn inference when absent.
   */
  tier?: LootTier;
}

export interface ZoneState {
  /**
   * -1 before the first phase starts. 0..phases.length-1 = balance zone.phases[i].
   * phases.length = final collapse (shrinks to radius 0 using zone.finalCollapse*).
   */
  phaseIndex: number;
  phaseCount: number;
  /** Current safe circle. */
  center: Vec2;
  radius: number;
  /** Circle at the end of this phase's shrink. Equal to current while not yet decided. */
  targetCenter: Vec2;
  targetRadius: number;
  /** Server ms when the current wait (if !shrinking) or shrink (if shrinking) ends. */
  phaseEndsAt: number;
  shrinking: boolean;
  /** HP per second applied outside the circle, in whole-tick chunks of zone.damageTickMs. */
  dps: number;
}

export type MatchPhase = 'lobby' | 'countdown' | 'playing' | 'results';

export interface MatchState {
  /** Increments each time a new lobby opens. */
  matchId: number;
  phase: MatchPhase;
  /** Server ms when countdown or results end; null in lobby/playing. */
  phaseEndsAt: number | null;
  /** Humans queued for the next match (lobby/countdown). */
  lobbyCount: number;
  targetPlayers: number;
  /** Alive participants (humans + bots) while playing. */
  aliveCount: number;
  /** Participants the match started with. 0 before playing. */
  totalPlayers: number;
  winnerId: PlayerId | null;
  winnerName: string | null;
}

export interface WorldSnapshot {
  tick: number;
  /** Server clock ms at this tick (sim time). */
  serverTime: number;
  match: MatchState;
  /** null outside 'playing'/'results'. */
  zone: ZoneState | null;
  /** Match participants (empty in lobby/countdown). */
  players: PlayerState[];
  /** Bumped whenever the loot set changes. */
  lootVersion: number;
  /**
   * Full loot list. The wire protocol may omit it when lootVersion is unchanged, but NetClient always
   * re-fills it so consumers always see the full list.
   */
  loot: LootState[];
  /** Per-recipient. null if the recipient is not a participant (lobby, mid-match spectator). */
  local: LocalPlayerState | null;
}

export interface Standing {
  id: PlayerId;
  name: string;
  isBot: boolean;
  kills: number;
  /** 1 = winner. */
  placement: number;
}

export interface WelcomeInfo {
  playerId: PlayerId;
  mapId: string;
  /** Server clock ms when the welcome was sent. */
  serverTime: number;
  matchId: number;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

// ---------------------------------------------------------------------------------------------
// Sim events (returned by World.step, broadcast by the server, translated to GameEvents by ClientGame)
// ---------------------------------------------------------------------------------------------
export type DeathCause = 'weapon' | 'zone' | 'fall';
export type ImpactSurface = 'player' | 'terrain' | 'prop' | 'water' | 'none';

export interface ShotImpact {
  /** End point of the ray (hit point, or origin + dir * range when it hit nothing). */
  point: Vec3;
  surface: ImpactSurface;
  playerId: PlayerId | null;
  headshot: boolean;
}

export type SimEvent =
  /** A player entered the match world (spawned in the air for the drop). */
  | { type: 'spawn'; playerId: PlayerId; pos: Vec3 }
  /** One trigger pull. `impacts` has one entry per pellet (1 for non-shotguns). Fists: one short-range impact. */
  | { type: 'shot'; shooterId: PlayerId; weapon: WeaponId; origin: Vec3; impacts: ShotImpact[] }
  /** One damage application (pellets of one shot are summed into a single event per victim). */
  | {
      type: 'damage';
      victimId: PlayerId;
      attackerId: PlayerId | null;
      amount: number;
      headshot: boolean;
      cause: DeathCause;
      /** Attacker eye position, or the nearest zone-edge point for zone damage. */
      sourcePos: Vec3;
      hpAfter: number;
      armorAfter: number;
      /**
       * M1-fix (producer: game-developer): victim armor before this hit. Armor hit = armorBefore > 0;
       * armor break = armorBefore > 0 && armorAfter === 0. Absent = unknown (consumers fall back to tracking).
       */
      armorBefore?: number;
    }
  | {
      type: 'kill';
      victimId: PlayerId;
      killerId: PlayerId | null;
      weapon: WeaponId | null;
      cause: DeathCause;
      /** Victim's final placement (aliveCount after death + 1). */
      placement: number;
      /** M1-fix (producer: game-developer): the lethal hit was a headshot. Always false for zone/fall. */
      headshot?: boolean;
    }
  | { type: 'pickup'; playerId: PlayerId; lootId: LootId; item: ItemId; qty: number; pos: Vec3 }
  | { type: 'reloadStart'; playerId: PlayerId; weapon: GunId; durationMs: number }
  | { type: 'reloadEnd'; playerId: PlayerId; weapon: GunId; completed: boolean }
  | { type: 'healStart'; playerId: PlayerId; item: HealId; durationMs: number }
  | { type: 'healEnd'; playerId: PlayerId; item: HealId; completed: boolean; hpAfter: number }
  | { type: 'weaponSwitch'; playerId: PlayerId; weapon: WeaponId; slot: SlotIndex }
  | { type: 'matchEnded'; winnerId: PlayerId | null; standings: Standing[] }
  /** M1-fix (Contract revision 1 #5): translated by src/game/simEvents.ts, validated by protocol isSimEvent. */
  | ActionFailedSimEvent;

/**
 * M1-fix (producer: game-developer). A human's edge action was refused. Emitted at most once per press (edge
 * inputs), never for bots, never for held `fire`. See ARCHITECTURE.md §12 "Contract revision 1" for the
 * reason -> string-key table.
 */
export interface ActionFailedSimEvent { type: 'actionFailed'; playerId: PlayerId; action: FailedAction; reason: ActionFailReason }

/** M1-fix: actions that can be refused by the sim. */
export type FailedAction = 'heal' | 'pickup' | 'reload' | 'fire';
/**
 * M1-fix: why an action was refused.
 * - noHeals: Q with no bandage/medkit.        - fullHp: Q when no carried heal would add HP (at/above healCap).
 * - inventoryFull: E on ammo/heal at maxCarry/maxStack.   - betterArmor: E on a vest with armor >= vest value.
 * - noAmmo: R (or a fire press) with an empty mag and no reserve.
 */
export type ActionFailReason = 'noHeals' | 'fullHp' | 'inventoryFull' | 'betterArmor' | 'noAmmo';

export type SimEventType = SimEvent['type'];
