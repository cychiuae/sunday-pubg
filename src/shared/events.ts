/**
 * Typed event bus and the client-side GameEvents map. Owner: tech-lead.
 *
 * Rules (docs/tech/ARCHITECTURE.md, "Event flow"):
 * - On the client, ONLY ClientGame emits on the bus. Renderer, Ui and AudioEngine only subscribe.
 * - Events are for discrete moments. Continuous state (hp, ammo, positions, timers) goes through
 *   FrameView/HudView every frame, never through events.
 * - Payloads are plain data. Handlers must not mutate them (they are shared between subscribers).
 * - `isLocal*` flags are relative to the local player id (or false when there is none).
 * - Positions are world space; times are server-clock ms unless named otherwise.
 */
import type {
  ActionFailReason,
  ConnectionStatus,
  DeathCause,
  FailedAction,
  GunId,
  HealId,
  ItemId,
  LootId,
  MatchPhase,
  PlayerId,
  ShotImpact,
  SlotIndex,
  Standing,
  Surface,
  Vec3,
  WeaponId,
  ZoneState,
} from './types';

export interface GameEvents {
  /** Derived from snapshot match.phase transitions. Also emitted once on the first snapshot (prev = null). */
  matchPhaseChanged: { phase: MatchPhase; prev: MatchPhase | null; endsAt: number | null };
  /** During 'countdown', once per whole second as the remaining whole seconds change (N..1). */
  countdown: { secondsLeft: number };
  /** The local player entered the match (start of the drop). */
  localPlayerSpawned: { playerId: PlayerId; pos: Vec3 };

  /** One trigger pull. `origin` is the shooter's eye; renderer may start tracers at its own muzzle point. */
  shotFired: { shooterId: PlayerId; weapon: WeaponId; origin: Vec3; impacts: ShotImpact[]; isLocal: boolean };
  /** Local player pressed fire with an empty magazine (client-side only). */
  dryFire: { weapon: WeaponId };
  playerDamaged: {
    victimId: PlayerId;
    attackerId: PlayerId | null;
    amount: number;
    headshot: boolean;
    cause: DeathCause;
    sourcePos: Vec3;
    /** Victim's current position (for hit VFX / positional audio). */
    victimPos: Vec3;
    hpAfter: number;
    armorAfter: number;
    /** M1-fix (producer: ClientGame, copied from SimEvent damage.armorBefore). Absent = unknown. */
    armorBefore?: number;
    isLocalVictim: boolean;
    isLocalAttacker: boolean;
  };
  /** The local player damaged someone (hit marker / hit sound). Emitted after the matching playerDamaged. */
  localHitConfirmed: { victimId: PlayerId; amount: number; headshot: boolean; killed: boolean };
  playerKilled: {
    killerId: PlayerId | null;
    killerName: string | null;
    victimId: PlayerId;
    victimName: string;
    weapon: WeaponId | null;
    cause: DeathCause;
    victimPos: Vec3;
    placement: number;
    /** M1-fix (producer: ClientGame, copied from SimEvent kill.headshot). Absent = unknown. */
    headshot?: boolean;
    isLocalVictim: boolean;
    isLocalKiller: boolean;
  };

  itemPickedUp: { playerId: PlayerId; item: ItemId; qty: number; pos: Vec3; isLocal: boolean };
  reloadStarted: { playerId: PlayerId; weapon: GunId; durationMs: number; pos: Vec3; isLocal: boolean };
  /** completed = false when cancelled (switch weapon, death). */
  reloadFinished: { playerId: PlayerId; weapon: GunId; completed: boolean; pos: Vec3; isLocal: boolean };
  healStarted: { playerId: PlayerId; item: HealId; durationMs: number; pos: Vec3; isLocal: boolean };
  healFinished: { playerId: PlayerId; item: HealId; hpAfter: number; pos: Vec3; isLocal: boolean };
  healCancelled: { playerId: PlayerId; item: HealId; pos: Vec3; isLocal: boolean };
  /** M1-fix: `pos` (producer: ClientGame) = the player's current view position, like reload/heal events. */
  weaponSwitched: { playerId: PlayerId; weapon: WeaponId; slot: SlotIndex; isLocal: boolean; pos?: Vec3 };
  /**
   * M1-fix (producer: ClientGame, from SimEvent actionFailed; emitted only when isLocal in M1). Ui shows the
   * string from ARCHITECTURE.md §12 "Contract revision 1"; audio plays a refusal cue. Not emitted for `fire`
   * (ClientGame's local `dryFire` already covers it).
   */
  actionFailed: { playerId: PlayerId; action: FailedAction; reason: ActionFailReason; isLocal: boolean };

  /** Derived from snapshots: first zone, phaseIndex change, or shrinking flag change. */
  zoneChanged: { zone: ZoneState };
  /** Once per phase when time until the shrink starts drops to zone.warningSecondsBeforeShrink. */
  zoneWarning: { phaseIndex: number; secondsUntilShrink: number };
  /** Local player crossed the safe-zone edge. */
  localZoneStatusChanged: { outside: boolean };

  /** Client-derived from movement (local predicted + interpolated remotes), cadence by speed. */
  footstep: { playerId: PlayerId; pos: Vec3; surface: Surface; sprinting: boolean; isLocal: boolean };
  jump: { playerId: PlayerId; pos: Vec3; isLocal: boolean };
  /** fallSpeed: downward m/s at touchdown (>= 0). */
  land: { playerId: PlayerId; pos: Vec3; fallSpeed: number; surface: Surface; isLocal: boolean };

  matchEnded: {
    winnerId: PlayerId | null;
    winnerName: string | null;
    /** null if the local client did not take part (joined mid-match). */
    localPlacement: number | null;
    localKills: number;
    totalPlayers: number;
    isLocalWinner: boolean;
    /** Sorted by placement ascending. */
    standings: Standing[];
  };

  /** Nearest pickable loot within player.pickupRange changed. lootId null = nothing in range. */
  interactPromptChanged: { lootId: LootId | null; item: ItemId | null; qty: number };
  /** Spectate camera target changed (local dead or not participating). null = not spectating. */
  spectateTargetChanged: { targetId: PlayerId | null; targetName: string | null };
  connectionStatus: { status: ConnectionStatus; reason?: string };
}

export type GameEventName = keyof GameEvents;
export type Handler<T> = (payload: T) => void;

/** Minimal synchronous typed event bus. Handlers run in subscription order; a throwing handler is logged and skipped. */
export class EventBus<E extends object> {
  private readonly handlers = new Map<keyof E, Set<Handler<never>>>();

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  /** Subscribe for a single emission. Returns an unsubscribe function. */
  once<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof E>(type: K, handler: Handler<E[K]>): void {
    this.handlers.get(type)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers.get(type);
    if (!set || set.size === 0) return;
    for (const h of [...set]) {
      try {
        (h as Handler<E[K]>)(payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${String(type)}" threw`, err);
      }
    }
  }

  /** Remove all handlers (tests, dispose). */
  clear(): void {
    this.handlers.clear();
  }
}
