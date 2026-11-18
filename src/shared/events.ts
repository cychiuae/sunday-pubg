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
import type { Balance, ZoneTheme } from './balance';
import type {
  ActionFailReason,
  AnyMapData,
  DropRoute,
  MapId,
  MapPickVia,
  MemberId,
  RoomId,
  ArmorHit,
  ConnectionStatus,
  DeathCause,
  FailedAction,
  GrenadeContactSurface,
  GrenadeId,
  GunId,
  HealId,
  HeldId,
  ItemId,
  LootId,
  MatchPhase,
  PlayerId,
  ShotImpact,
  SightType,
  SlotIndex,
  Stance,
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
    /**
     * M2a (replaces armorAfter/armorBefore; copied from SimEvent damage). Vest hit = vest !== null; vest break =
     * vest?.broken. Pitch the clink by vest.tier. Same for helmet (head hits only).
     */
    vest: ArmorHit | null;
    helmet: ArmorHit | null;
    isLocalVictim: boolean;
    isLocalAttacker: boolean;
  };
  /**
   * The local player damaged someone (hit marker / hit sound). Emitted after the matching playerDamaged.
   * M2a: vest/helmet copied from the damage event, for the "armor hit" / "helmet hit" marker variants and the
   * break flash. cause 'explosion' for grenade hits (no headshot).
   */
  localHitConfirmed: {
    victimId: PlayerId;
    amount: number;
    headshot: boolean;
    killed: boolean;
    vest: ArmorHit | null;
    helmet: ArmorHit | null;
    cause: DeathCause;
  };
  playerKilled: {
    killerId: PlayerId | null;
    killerName: string | null;
    victimId: PlayerId;
    victimName: string;
    /** M2a: 'grenade' for explosion kills (kill feed icon). */
    weapon: HeldId | null;
    cause: DeathCause;
    victimPos: Vec3;
    placement: number;
    /** M1-fix (producer: ClientGame, copied from SimEvent kill.headshot). Absent = unknown. */
    headshot?: boolean;
    isLocalVictim: boolean;
    isLocalKiller: boolean;
  };

  /** M2a: `durability` for armor pickups (the worn piece's durability after equipping). */
  itemPickedUp: { playerId: PlayerId; item: ItemId; qty: number; pos: Vec3; isLocal: boolean; durability?: number };
  reloadStarted: { playerId: PlayerId; weapon: GunId; durationMs: number; pos: Vec3; isLocal: boolean };
  /** completed = false when cancelled (switch weapon, death). */
  reloadFinished: { playerId: PlayerId; weapon: GunId; completed: boolean; pos: Vec3; isLocal: boolean };
  healStarted: { playerId: PlayerId; item: HealId; durationMs: number; pos: Vec3; isLocal: boolean };
  healFinished: { playerId: PlayerId; item: HealId; hpAfter: number; pos: Vec3; isLocal: boolean };
  healCancelled: { playerId: PlayerId; item: HealId; pos: Vec3; isLocal: boolean };
  /** M1-fix: `pos` (producer: ClientGame) = the player's current view position, like reload/heal events. */
  /** M2a: weapon 'grenade' with slot 3. */
  weaponSwitched: { playerId: PlayerId; weapon: HeldId; slot: SlotIndex; isLocal: boolean; pos?: Vec3 };
  /**
   * M1-fix (producer: ClientGame, from SimEvent actionFailed; emitted only when isLocal in M1). Ui shows the
   * string from ARCHITECTURE.md §12 "Contract revision 1"; audio plays a refusal cue. Not emitted for `fire`
   * (ClientGame's local `dryFire` already covers it). M2a reasons: ARCHITECTURE.md §14 string table.
   */
  actionFailed: { playerId: PlayerId; action: FailedAction; reason: ActionFailReason; isLocal: boolean };

  /**
   * M2a: a stance transition started. Local player: emitted from PREDICTION (MovementStepResult.stanceChanged) on the
   * step it starts; the server echo for the local id is ignored. Remotes: from SimEvent stanceChange.
   * Consumers: audio (cloth rustle, prone thud after durationMs), render (splash when forced), ui (stance icon anim).
   */
  stanceChanged: {
    playerId: PlayerId;
    from: Stance;
    to: Stance;
    forced: boolean;
    durationMs: number;
    pos: Vec3;
    isLocal: boolean;
  };
  /**
   * M2a, local only, client-derived from prediction: ADS engaged (adsMs went 0 -> > 0) or ended (-> 0).
   * Audio: ADS rustle, scope-in lens sound when `sight` is a scope.
   */
  localAdsChanged: { engaged: boolean; weapon: WeaponId; sight: SightType };
  /** M2a: pin pulled (SimEvent grenadeCook). Audio: positional click (~10 m). */
  grenadeCooked: { playerId: PlayerId; pos: Vec3; explodesAt: number; isLocal: boolean };
  /** M2a: grenade entity created (SimEvent grenadeThrown). `dropped` = no throw whoosh. isLocal = local owner. */
  grenadeThrown: {
    id: GrenadeId;
    ownerId: PlayerId;
    pos: Vec3;
    vel: Vec3;
    explodesAt: number;
    dropped: boolean;
    isLocal: boolean;
  };
  /** M2a: SimEvent grenadeBounce. Audio clink pitched by speed; water plop when surface 'water'; render splash. */
  grenadeBounced: { id: GrenadeId; pos: Vec3; surface: GrenadeContactSurface; speed: number };
  /**
   * M2a: SimEvent explosion (emitted on the bus BEFORE the playerDamaged events of the same blast).
   * `localDistance`: 3D distance from the local player's predicted eye to `pos` (null when no live local player);
   * render scales camera shake by it (none beyond 2 x radius), audio plays the muffled ring when <= radius.
   */
  explosion: {
    id: GrenadeId;
    ownerId: PlayerId;
    pos: Vec3;
    radius: number;
    inHand: boolean;
    isLocalOwner: boolean;
    localDistance: number | null;
  };

  /** Derived from snapshots: first zone, phaseIndex change, or shrinking flag change. */
  zoneChanged: { zone: ZoneState };
  /** Once per phase when time until the shrink starts drops to zone.warningSecondsBeforeShrink. */
  zoneWarning: { phaseIndex: number; secondsUntilShrink: number };
  /** Local player crossed the safe-zone edge. */
  localZoneStatusChanged: { outside: boolean };

  /**
   * Client-derived from movement (local predicted + interpolated remotes), cadence by speed.
   * M2a addendum (producer: game-developer; consumer: audio crouch/crawl steps): `stance` = the player's target stance
   * at the step (local: predicted MovementState.stance; remotes: interpolated PlayerState.stance). Optional until
   * ClientGame and derived.ts fill it; absent = audio falls back to its last stanceChanged per player.
   */
  footstep: { playerId: PlayerId; pos: Vec3; surface: Surface; sprinting: boolean; isLocal: boolean; stance?: Stance };
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
  /**
   * M2a: `durability` = the pickup's LootState.durability for armor ("[E] Vest (Lv 2) 31/55"), else null.
   * `refusal` = the reason E would be refused right now, predicted from the latest snapshot.local (inventoryFull,
   * betterArmor), else null, so the prompt can warn before the press.
   */
  interactPromptChanged: {
    lootId: LootId | null;
    item: ItemId | null;
    qty: number;
    durability: number | null;
    /**
     * M2a addendum (producer: game-developer derived.ts, from balance items.<id>.durability; consumer: Ui prompt
     * "31/55"): fresh durability of the armor piece in the prompt, null for every other item. Optional until the
     * producer fills it; absent = Ui uses its own cache.
     */
    maxDurability?: number | null;
    refusal: ActionFailReason | null;
  };
  // ---- M2b (ADR 0005 / 0006). Producer: ClientGame. ----
  /**
   * The active map changed (first welcome, or a welcome for a different map). Emitted BEFORE the first frame that
   * uses it. `balance` is the effective per-map balance (balanceForMap): render, audio and Ui must use it instead of
   * their constructor balance for per-match numbers. Renderer rebuilds its scene (terrain or indoor floor, walls,
   * props, water or rain curtain); Ui rebuilds the minimap; audio switches ambience, reverb and zone loops by theme.
   */
  mapChanged: { mapId: MapId; map: AnyMapData; balance: Balance; zoneTheme: ZoneTheme };
  /** The carrier left its entry point (client-derived when serverNow passes route.startsAt). Engine loop, announcer. */
  carrierDeparted: { route: DropRoute };
  /** A player left the carrier (SimEvent dropJump; local from prediction). Hatch whoosh, announcer. */
  playerJumped: { playerId: PlayerId; pos: Vec3; auto: boolean; isLocal: boolean };
  /** A parachute opened (SimEvent chuteOpen; local from prediction). Pop sound, canopy model. */
  parachuteOpened: { playerId: PlayerId; pos: Vec3; manual: boolean; isLocal: boolean };
  /** You entered a room (create, join, or rejoin). */
  roomJoined: { roomId: RoomId; code: string; asHost: boolean; spectating: boolean };
  /** A join failed (reject). `code` = the code you tried, if any. */
  roomJoinFailed: { reason: 'notFound' | 'full' | 'closed' | 'rateLimited' | 'badCode' | 'kicked'; code: string | null };
  roomCreateFailed: { reason: 'roomLimit' | 'rateLimited' | 'badSettings' | 'busy' };
  roomLeft: { reason: 'left' | 'kicked' | 'closed' };
  roomHostChanged: { hostId: MemberId; hostName: string; isLocal: boolean };
  roomMemberChanged: { memberId: MemberId; name: string; change: 'joined' | 'left' };
  /** The host changed settings (waiting-room toast, non-hosts only). */
  roomSettingsChanged: { byHost: true };
  /** The match's map was decided (room lock). */
  mapVoteLocked: { mapId: MapId; via: MapPickVia };

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
