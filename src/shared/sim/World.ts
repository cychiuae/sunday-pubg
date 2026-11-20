/**
 * Authoritative match simulation (docs/tech/ARCHITECTURE.md section 4). Pure and deterministic for a given seed and
 * input sequence: seeded Rng streams, world time only, no globals.
 */
import type { Balance } from '../balance';
import { armorBalance, effectiveSight, rocketBlastMaxDamage } from '../balance';
import { MAX_INPUT_REPEAT_TICKS, MAX_QUEUED_INPUTS, SIM_DT } from '../constants';
import { carrierHeading, carrierPosAt } from '../maps';
import { aimDirection, clamp, createRng, type Rng, wrapAngle } from '../math';
import type {
  ActionFailedSimEvent,
  ActionFailReason,
  AnyMapData,
  Appearance,
  ArmorHit,
  ArmorPieceState,
  DeathCause,
  DropRoute,
  FailedAction,
  GrenadeId,
  GrenadeState,
  HeldId,
  ImpactSurface,
  ItemLevel,
  LocalM2cFields,
  LocalPlayerState,
  LootId,
  MatchPhase,
  MatchState,
  PlayerId,
  PlayerInput,
  M2cThrowableId,
  PaneId,
  PlayerM2cFields,
  RocketState,
  PlayerState,
  ScopeId,
  ShotImpact,
  SimEvent,
  SmokeCloudState,
  Standing,
  Vec2,
  Vec3,
  WeaponId,
  WorldSnapshot,
} from '../types';
import { FISTS_SLOT, isM2cGunId, isMeleeId } from '../types';
import {
  activeChangedByPickup,
  advanceActionTimers,
  applyActionEdges,
  cancelActionTimers,
  fireSlowedOf,
  isSwapping,
  slotUpgradedByPickup,
  TIMER_EPSILON_MS,
  type ActionEvent,
  type ActionHooks,
  type SwingState,
} from './actions';
import { blastHits } from './blast';
import { addCloud, deployCloud, liveClouds } from './clouds';
import { effWeapon, slotWeapon } from './levels';
import { meleeHitCheck, type MeleeCandidate } from './melee';
import { createRocket, stepRocket, type RocketContact, type RocketEntity } from './rockets';
import { assignBotDrops, botThink, createBotBrain, rollPersonality, type BotEnv, type BotGrenadeInfo, type RecentShot } from './bots';
import { lineOfSight, raycastStatic } from './colliders';
import { adsProgressOf, applyArmorPiece, effectiveSpreadDeg, pelletDamage, sampleCone, spreadRad } from './combat';
import { dropLaunch, stepGrenade, throwLaunch, type GrenadeBody } from './grenade';
import { activeHeld, activeLevel, activeSlotState, applyPickup, createInventory, deathDrops, type GroundItem, type Inventory } from './inventory';
import { dropTierOf, scatterInDisc, spawnMatchLoot, toLootState, type LootEntity } from './loot';
import {
  createMovementContext,
  groundHeightAt,
  horizontalSpeed,
  initialMovementState,
  isInWater,
  MAX_MOVE_INPUT_LEN,
  stepMovement,
  toMovementInput,
  withBrokenGlass,
  type MapRuntime,
  type MovementContext,
} from './movement';
import { NavBudget, navTuning, PathCache, type NavGraph } from './nav';
import { drawDropRoute, shiftRoute } from './route';
import { chestPoint, eyePoint, isStanceSettled, pitchLimits, rayHitbox, stanceProgress } from './stance';
import type { SimPlayer } from './state';
import { heightAt } from './terrain';
import { cloneZoneState, createZone, isOutsideZone, nearestEdgePoint, updateZone, type ZoneRuntime } from './zone';

export { TIMER_EPSILON_MS } from './actions';

/** ADR 0006 §2: a World created by a room at its map lock runs exactly one match. */
export interface MatchStartOptions {
  /** Countdown length from timeOriginMs; the match ('playing') starts on the first tick at or after its end. */
  countdownMs: number;
  /** Fill up to match.targetPlayers with bots at the start. */
  fillBots: boolean;
  /** MatchState.matchId of this match. */
  matchId: number;
}

export interface WorldOptions {
  map: AnyMapData;
  /** The effective (per-map) balance: balanceForMap(base, map.id). */
  balance: Balance;
  seed: number;
  botNames: readonly string[];
  /** M2b: server clock ms at tick 0 (timeMs = timeOriginMs + tick x SIM_DT x 1000). Default 0. */
  timeOriginMs?: number;
  /**
   * M2b (ADR 0006 §2): skip the lobby (match.minHumansToStart ignored): the World is in 'countdown' from creation,
   * starts the match once, and reports `finished` when the results end. Absent = the M1/M2a lobby loop.
   */
  matchStart?: MatchStartOptions;
  /** M2b (ADR 0005 §6): a prepared map (shared colliders and nav graph). Must be for `map` and `balance`. */
  runtime?: MapRuntime;
  /** M2b: carrier drop at match start (default true). false = the M1 spawn above playerSpawns (tests). */
  drop?: boolean;
}

export interface World {
  readonly tick: number;
  /** Server clock ms (timeOriginMs + the sum of step dt; + tick * SIM_DT * 1000 while every step is SIM_DT). */
  readonly timeMs: number;
  readonly map: AnyMapData;
  /** M2b: true once the results of a `matchStart` World have ended (the room drops it). Legacy Worlds never finish. */
  readonly finished: boolean;
  addPlayer(name: string): PlayerId | null;
  removePlayer(id: PlayerId): void;
  applyInput(id: PlayerId, input: PlayerInput): void;
  step(dt: number): SimEvent[];
  snapshotFor(viewerId: PlayerId | null): WorldSnapshot;
  getMatch(): MatchState;
}

/** Presentation constants from types.ts docs (not gameplay rules). */
const ANIM_FIRING_MIN_MS = 150;
const ANIM_MOVING_SPEED = 0.3;
/** Number of appearance variants per channel (the character factory wraps larger values). */
const APPEARANCE_VARIANTS = 8;
const RNG_MATCH = 1;
const RNG_ZONE = 2;
const RNG_COMBAT = 3;
const RNG_BOTS = 4;
/** M2b: the carrier route stream (drawn at World creation, or at the match start of a legacy World). */
const RNG_ROUTE = 5;

function mixSeed(seed: number, a: number, b: number): number {
  let h = Math.imul(seed ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(a + 0x3c6ef372, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

interface Human {
  id: PlayerId;
  name: string;
  appearance: Appearance;
  /** Waiting for the next match (lobby/countdown, or spectating mid-match). */
  queued: boolean;
}

const NEUTRAL_EDGES = {
  jump: false,
  reload: false,
  interact: false,
  useHeal: false,
  selectSlot: -1 as const,
  stanceToggle: null,
};

/** M2a: a live grenade entity (grenades.md). */
export interface GrenadeEntity {
  id: GrenadeId;
  ownerId: PlayerId;
  body: GrenadeBody;
  /** Server ms of the fuse end. */
  explodesAt: number;
  /** Tick it was created on (it first moves on the next tick, grenades.md edge cases). */
  spawnTick: number;
  /** M2c: frag or smoke canister. */
  kind: M2cThrowableId;
}

/** hp + worn armor durability (placement tie-break, armor.md). */
const hpPlusArmor = (p: SimPlayer): number => p.hp + (p.vest ? p.vest.durability : 0) + (p.helmet ? p.helmet.durability : 0);

const armorHit = (before: ArmorPieceState | null, absorbed: number, broken: boolean): ArmorHit | null =>
  before ? { tier: before.tier, absorbed, broken } : null;

export function createWorld(opts: WorldOptions): World {
  return new SimWorld(opts);
}

class SimWorld implements World {
  readonly map: AnyMapData;
  private readonly balance: Balance;
  private readonly seed: number;
  private readonly botNames: readonly string[];
  private readonly ctx: MovementContext;
  private readonly worldRng: Rng;

  private readonly timeOriginMs: number;
  private readonly matchStart: MatchStartOptions | null;
  private readonly dropEnabled: boolean;
  private readonly nav: NavGraph | null;
  private readonly pathCache: PathCache | null;
  private readonly navBudget: NavBudget | null;
  private route: DropRoute | null = null;
  private _finished = false;

  private _tick = 0;
  private _timeMs = 0;
  private uniformDt = true;
  private nextPlayerId = 1;
  private readonly humans = new Map<PlayerId, Human>();
  private participants = new Map<PlayerId, SimPlayer>();

  private matchId = 1;
  private phase: MatchPhase = 'lobby';
  private phaseEndsAt: number | null = null;
  private totalPlayers = 0;
  private winnerId: PlayerId | null = null;
  private winnerName: string | null = null;
  private matchHadHumans = false;
  private noHumansSince: number | null = null;

  private loot: LootEntity[] = [];
  private lootVersion = 1;
  private nextLootId = 1;
  private zone: ZoneRuntime | null = null;
  private nextZoneDamageAt = 0;
  private recentShots: RecentShot[] = [];
  private grenades: GrenadeEntity[] = [];
  /** One id space for grenades, rockets and smoke clouds (ADR 0007 §4). */
  private nextGrenadeId = 1;
  /** M2c: live rockets (launch records + sweep bookkeeping), by id. */
  private rockets: RocketEntity[] = [];
  /** M2c: live smoke clouds, by id. */
  private clouds: SmokeCloudState[] = [];
  /** M2c: broken glass panes of this match (the movement context's colliders read it live). */
  private readonly broken = new Set<PaneId>();

  private matchRng: Rng;
  private zoneRng: Rng;
  private combatRng: Rng;
  private botRng: Rng;
  private events: SimEvent[] = [];
  /** Refused human actions in the current step (also emitted as actionFailed events). */
  private actionFailures: ActionFailedSimEvent[] = [];

  constructor(opts: WorldOptions) {
    this.map = opts.map;
    this.balance = opts.balance;
    this.seed = opts.seed >>> 0;
    this.botNames = opts.botNames;
    const rt = opts.runtime && opts.runtime.map === opts.map && opts.runtime.balance === opts.balance ? opts.runtime : null;
    // M2c: one live broken-pane set per World over the shared (per-map) colliders.
    this.ctx = withBrokenGlass(rt ? rt.ctx : createMovementContext(opts.map, opts.balance), this.broken);
    this.nav = rt ? rt.nav : null;
    const nt = navTuning(opts.balance);
    this.pathCache = this.nav ? new PathCache(nt.pathCacheSize) : null;
    this.navBudget = this.nav ? new NavBudget(nt.maxPathsPerTick) : null;
    this.timeOriginMs = Number.isFinite(opts.timeOriginMs) ? opts.timeOriginMs! : 0;
    this._timeMs = this.timeOriginMs;
    this.matchStart = opts.matchStart ?? null;
    this.dropEnabled = opts.drop !== false;
    this.worldRng = createRng(mixSeed(this.seed, 0, 0));
    this.matchRng = this.zoneRng = this.combatRng = this.botRng = this.worldRng;
    if (this.matchStart) {
      this.matchId = this.matchStart.matchId;
      this.phase = 'countdown';
      // The match starts on the first tick at or after the countdown end; compute that tick's time with the same
      // formula as step() so the route's startsAt equals the 'playing' start exactly.
      const tickMs = SIM_DT * 1000;
      const ticks = Math.max(1, Math.ceil(Math.max(0, this.matchStart.countdownMs) / tickMs - 1e-9));
      this.phaseEndsAt = this.timeOriginMs + ticks * SIM_DT * 1000;
    }
    this.seedMatchRngs();
    // ADR 0005 §8: the route is drawn when the World is created (the room's lock), so clients see it in the countdown.
    if (this.matchStart && this.dropEnabled) this.route = this.drawRoute(this.phaseEndsAt ?? this.timeOriginMs);
  }

  get tick(): number {
    return this._tick;
  }

  get timeMs(): number {
    return this._timeMs;
  }

  get finished(): boolean {
    return this._finished;
  }

  private drawRoute(startsAt: number): DropRoute {
    const rng = createRng(mixSeed(this.seed, this.matchId, RNG_ROUTE));
    return drawDropRoute(this.map, this.balance, rng, startsAt);
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  addPlayer(name: string): PlayerId | null {
    if (this.humans.size >= this.balance.match.maxPlayers) return null;
    const id = this.nextPlayerId++;
    this.humans.set(id, { id, name, appearance: this.rollAppearance(), queued: true });
    return id;
  }

  removePlayer(id: PlayerId): void {
    if (!this.humans.delete(id)) return;
    const p = this.participants.get(id);
    if (!p) return;
    if (this.phase === 'playing' && p.alive && !p.left) {
      // Eliminated on the spot ("left"): kill credit to the last damager, loot drops, no kill event.
      const credit = this.creditFor(p);
      if (credit) credit.kills++;
      p.placement = this.aliveParticipants().length; // alive count after removal + 1
      this.cancelActions(p);
      this.releaseCook(p, 'death');
      this.dropInventory(p);
      p.alive = false;
    }
    p.left = true;
  }

  applyInput(id: PlayerId, input: PlayerInput): void {
    const p = this.participants.get(id);
    if (!p || p.isBot || !p.alive || p.left) return;
    if (this.phase !== 'playing' && this.phase !== 'results') return;
    this.enqueue(p, this.sanitize(input, p));
  }

  step(dt: number): SimEvent[] {
    const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.events = [];
    this.actionFailures = [];
    if (this._finished) return this.events;
    this._tick++;
    const prevMs = this._timeMs;
    // Exactly origin + tick * SIM_DT * 1000 while every step is SIM_DT (the server contract); accumulates otherwise.
    if (d !== SIM_DT) this.uniformDt = false;
    this._timeMs = this.uniformDt ? this.timeOriginMs + this._tick * SIM_DT * 1000 : this._timeMs + d * 1000;
    const now = this._timeMs;

    switch (this.phase) {
      case 'lobby':
        this.checkLobby();
        break;
      case 'countdown':
        if (!this.matchStart && this.queuedCount() < this.balance.match.minHumansToStart) {
          this.phase = 'lobby';
          this.phaseEndsAt = null;
        } else if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
          this.startMatch();
        }
        break;
      case 'playing':
        this.simulatePlaying(d, prevMs, now);
        break;
      case 'results':
        this.simulateResults(d);
        if (this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
          if (this.matchStart) this._finished = true;
          else {
            this.toLobby();
            this.checkLobby();
          }
        }
        break;
    }
    return this.events;
  }

  getMatch(): MatchState {
    const inMatch = this.phase === 'playing' || this.phase === 'results';
    let aboard = 0;
    if (this.phase === 'playing') for (const p of this.participants.values()) if (p.aboard && p.alive && !p.left) aboard++;
    const m: MatchState = {
      matchId: this.matchId,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      lobbyCount: this.queuedCount(),
      targetPlayers: this.balance.match.targetPlayers,
      aliveCount: inMatch ? this.aliveParticipants().length : 0,
      totalPlayers: inMatch ? this.totalPlayers : 0,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
      mapId: this.map.id,
      route: this.route ? { ...this.route, entry: { ...this.route.entry }, exit: { ...this.route.exit }, eject: { ...this.route.eject } } : null,
      aboardCount: aboard,
    };
    return m;
  }

  snapshotFor(viewerId: PlayerId | null): WorldSnapshot {
    const inMatch = this.phase === 'playing' || this.phase === 'results';
    const players: PlayerState[] = [];
    if (inMatch) for (const p of this.participants.values()) if (!p.left) players.push(this.toPlayerState(p));
    const viewer = viewerId !== null && inMatch ? this.participants.get(viewerId) : undefined;
    return {
      tick: this._tick,
      serverTime: this._timeMs,
      match: this.getMatch(),
      zone: inMatch && this.zone ? cloneZoneState(this.zone.state) : null,
      players,
      lootVersion: this.lootVersion,
      loot: inMatch ? this.loot.map(toLootState) : [],
      grenades: this.phase === 'playing' ? this.grenades.map(toGrenadeState) : [],
      local: viewer && !viewer.left ? this.toLocal(viewer) : null,
      rockets: this.phase === 'playing' ? this.rockets.map((r) => cloneRocketState(r.state)) : [],
      smokes: this.phase === 'playing' ? this.clouds.map((c) => ({ ...c, pos: { ...c.pos } })) : [],
      brokenPanes: inMatch ? [...this.broken].sort((x, y) => x - y) : [],
    };
  }

  // -------------------------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------------------------

  private queuedCount(): number {
    let n = 0;
    for (const h of this.humans.values()) if (h.queued) n++;
    return n;
  }

  private checkLobby(): void {
    if (this.phase === 'lobby' && this.queuedCount() >= this.balance.match.minHumansToStart) {
      this.phase = 'countdown';
      this.phaseEndsAt = this._timeMs + this.balance.match.countdownSeconds * 1000;
    }
  }

  private seedMatchRngs(): void {
    this.matchRng = createRng(mixSeed(this.seed, this.matchId, RNG_MATCH));
    this.zoneRng = createRng(mixSeed(this.seed, this.matchId, RNG_ZONE));
    this.combatRng = createRng(mixSeed(this.seed, this.matchId, RNG_COMBAT));
    this.botRng = createRng(mixSeed(this.seed, this.matchId, RNG_BOTS));
  }

  private rollAppearance(): Appearance {
    return {
      skin: this.worldRng.int(APPEARANCE_VARIANTS),
      outfit: this.worldRng.int(APPEARANCE_VARIANTS),
      hair: this.worldRng.int(APPEARANCE_VARIANTS),
    };
  }

  private newPlayer(id: PlayerId, name: string, isBot: boolean, appearance: Appearance): SimPlayer {
    const b = this.balance;
    return {
      id,
      name,
      isBot,
      appearance,
      alive: true,
      dying: null,
      left: false,
      hp: b.player.maxHp,
      vest: null,
      helmet: null,
      kills: 0,
      move: initialMovementState({ x: 0, y: 0, z: 0 }, true),
      yaw: 0,
      pitch: 0,
      inv: createInventory(),
      reload: null,
      heal: null,
      swapRemainingMs: 0,
      nextFireAt: 0,
      prevFire: false,
      triggerLatched: false,
      firingUntil: 0,
      lastShotAt: -Infinity,
      lastShotWeapon: null,
      cook: null,
      throwRecoveryMs: 0,
      lastGunSlot: FISTS_SLOT,
      swing: null,
      scopeSwap: null,
      smokeHeld: false,
      lastHurtAt: -Infinity,
      queue: [],
      lastInput: null,
      inputRepeatTicks: 0,
      lastProcessedInputSeq: 0,
      lastDamagedBy: null,
      tickStartHpArmor: b.player.maxHp,
      placement: null,
      brain: null,
      aboard: false,
      stalled: false,
    };
  }

  private startMatch(): void {
    const b = this.balance;
    const now = this._timeMs;
    this.seedMatchRngs();
    this.participants = new Map();
    this.loot = [];
    this.nextLootId = 1;
    this.lootVersion++;
    this.recentShots = [];
    this.grenades = [];
    this.nextGrenadeId = 1;
    this.rockets = [];
    this.clouds = [];
    this.broken.clear();

    const humans = [...this.humans.values()].filter((h) => h.queued).slice(0, b.match.maxPlayers);
    const list: SimPlayer[] = [];
    for (const h of humans) {
      h.queued = false;
      list.push(this.newPlayer(h.id, h.name, false, h.appearance));
    }
    const fill = this.matchStart ? this.matchStart.fillBots : true;
    const nBots = fill ? Math.max(0, b.match.targetPlayers - humans.length) : 0;
    const names = [...this.botNames];
    shuffle(names, this.matchRng);
    for (let i = 0; i < nBots; i++) {
      const id = this.nextPlayerId++;
      const name = names.length > 0 ? names[i % names.length]! : `#${id}`;
      const bot = this.newPlayer(id, name, true, this.rollAppearance());
      bot.brain = createBotBrain(now, (i * b.bots.decisionIntervalMs) / Math.max(1, nBots), rollPersonality(b, this.botRng));
      list.push(bot);
    }
    for (const p of list) this.participants.set(p.id, p);
    const n = list.length;

    if (this.dropEnabled) {
      // drop.md: everyone starts aboard the carrier (route drawn at creation; a legacy World draws it now).
      if (this.route === null) this.route = this.drawRoute(now);
      else if (this.route.startsAt !== now) this.route = shiftRoute(this.route, now);
      const route = this.route;
      const c = carrierPosAt(route, now);
      const yaw = carrierHeading(route);
      for (const p of list) {
        p.aboard = true;
        p.move = this.aboardMove(c);
        p.yaw = yaw;
        p.tickStartHpArmor = hpPlusArmor(p);
      }
      this.pickBotDrops(list.filter((p) => p.isBot).sort((x, y) => x.id - y.id), route);
    } else {
      // M1 spawn (drop-less test Worlds): random rotation offset, then every (S / N)-th spawn; shuffled assignment;
      // jitter; drop height.
      const spawns = this.map.playerSpawns;
      const order = [...list];
      shuffle(order, this.matchRng);
      const S = spawns.length;
      const offset = S > 0 ? this.matchRng.int(S) : 0;
      const stride = S > 0 ? S / Math.max(1, n) : 0;
      order.forEach((p, k) => {
        const sp = S > 0 ? spawns[Math.floor(offset + k * stride) % S]! : { x: 0, z: 0 };
        const j = scatterInDisc(sp.x, sp.z, b.match.spawnJitter ?? 0, this.matchRng);
        const ground = heightAt(j.x, j.z, this.map);
        p.move = initialMovementState({ x: j.x, y: Math.max(ground, 0) + (b.match.dropHeight ?? b.drop.carrierAltitude), z: j.z }, true);
        p.yaw = Math.atan2(j.x, j.z); // face the island centre (forward = (-sin, -cos))
        p.tickStartHpArmor = hpPlusArmor(p);
      });
    }
    for (const p of list) this.events.push({ type: 'spawn', playerId: p.id, pos: { ...p.move.pos } });

    this.loot = spawnMatchLoot(this.map, b, this.matchRng, () => this.nextLootId++, (x, z, y) =>
      groundHeightAt(this.ctx, x, z, y ?? heightAt(x, z, this.map)),
    );
    this.zone = createZone(b, this.map, this.zoneRng, now);
    this.nextZoneDamageAt = now + b.zone.damageTickMs;

    this.phase = 'playing';
    this.phaseEndsAt = null;
    this.totalPlayers = n;
    this.winnerId = null;
    this.winnerName = null;
    this.matchHadHumans = humans.length > 0;
    this.noHumansSince = null;
  }

  /** Movement state of an aboard player: at the carrier, "dropping" with no phase, never stepped. */
  private aboardMove(c: Vec2): SimPlayer['move'] {
    const alt = this.route ? this.route.altitude : this.balance.drop.carrierAltitude;
    return initialMovementState({ x: c.x, y: alt, z: c.z }, true, null);
  }

  /**
   * drop.md "Bots: jump choice": `assignBotDrops` (bots.ts) writes each bot's target and jump time. Called once per
   * match, at the start, with the bots in id order and the bot Rng (humans never influence the picks).
   */
  private pickBotDrops(bots: SimPlayer[], route: DropRoute): void {
    if (bots.length > 0) assignBotDrops(bots, route, this.map, this.balance, this.botRng);
  }

  private toLobby(): void {
    this.matchId++;
    this.participants = new Map();
    this.loot = [];
    this.lootVersion++;
    this.zone = null;
    this.recentShots = [];
    this.grenades = [];
    this.rockets = [];
    this.clouds = [];
    this.broken.clear();
    this.route = null;
    this.phase = 'lobby';
    this.phaseEndsAt = null;
    this.totalPlayers = 0;
    this.winnerId = null;
    this.winnerName = null;
    for (const h of this.humans.values()) h.queued = true;
  }

  private aliveParticipants(): SimPlayer[] {
    const out: SimPlayer[] = [];
    for (const p of this.participants.values()) if (p.alive && !p.left) out.push(p);
    return out;
  }

  private endMatch(winner: SimPlayer | null): void {
    const now = this._timeMs;
    for (const p of this.participants.values()) {
      this.cancelActions(p);
      p.cook = null;
    }
    // drop.md edge case: aboard players are ranked like other alive players; the flight is over.
    for (const p of this.participants.values()) p.aboard = false;
    // Live grenades, rockets and clouds are removed without exploding (grenades.md test 17, rpg.md, smoke.md).
    this.grenades = [];
    this.rockets = [];
    this.clouds = [];
    if (winner) winner.placement = 1;
    const standings: Standing[] = [...this.participants.values()]
      .map((p) => ({ id: p.id, name: p.name, isBot: p.isBot, kills: p.kills, placement: p.placement ?? this.totalPlayers }))
      .sort((a, b) => a.placement - b.placement || a.id - b.id);
    this.events.push({ type: 'matchEnded', winnerId: winner ? winner.id : null, standings });
    this.phase = 'results';
    this.phaseEndsAt = now + this.balance.match.resultsSeconds * 1000;
    this.winnerId = winner ? winner.id : null;
    this.winnerName = winner ? winner.name : null;
  }

  private checkMatchEnd(placedThisTick: SimPlayer[]): void {
    const alive = this.aliveParticipants();
    if (alive.length <= 1) {
      const winner = alive[0] ?? placedThisTick.find((p) => p.placement === 1) ?? null;
      this.endMatch(winner);
      return;
    }
    const m = this.balance.match;
    if (!m.endWhenNoHumansAlive || !this.matchHadHumans) return;
    if (alive.some((p) => !p.isBot)) {
      this.noHumansSince = null;
      return;
    }
    if (this.noHumansSince === null) this.noHumansSince = this._timeMs;
    if (this._timeMs - this.noHumansSince < m.lastHumanDeathDelaySeconds * 1000) return;
    // Rank remaining bots by hp + armor durability, then kills, then id. Top bot wins.
    const ranked = [...alive].sort((a, b) => hpPlusArmor(b) - hpPlusArmor(a) || b.kills - a.kills || a.id - b.id);
    ranked.forEach((p, i) => (p.placement = i + 1));
    this.endMatch(ranked[0] ?? null);
  }

  // -------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------

  private simulatePlaying(dt: number, prevMs: number, now: number): void {
    const b = this.balance;
    const players = [...this.participants.values()];
    for (const p of players) p.tickStartHpArmor = hpPlusArmor(p);
    // Bots decide every ceil(decisionIntervalMs / tick) ticks; keep a shot for one whole decision cycle (+ half a tick
    // of float slack) so a shot fired on a bot's decision tick is still heard at its next decision.
    const tickMs = SIM_DT * 1000;
    const shotWindow = Math.ceil(b.bots.decisionIntervalMs / tickMs - 1e-9) * tickMs + tickMs / 2;
    if (this.recentShots.length > 0) this.recentShots = this.recentShots.filter((s) => now - s.at <= shotWindow);

    // Bots produce inputs through the same queue as humans.
    const env: BotEnv = {
      now,
      balance: b,
      map: this.map,
      ctx: this.ctx,
      players,
      loot: this.loot,
      zone: this.zone ? this.zone.state : null,
      recentShots: this.recentShots,
      // grenadeDanger: frags only (smoke canisters never threaten).
      grenades: this.grenades.filter((g) => g.kind === 'grenade').map((g): BotGrenadeInfo => ({ id: g.id, ownerId: g.ownerId, pos: g.body.pos })),
      smokes: this.clouds,
      route: this.route,
      nav: this.nav,
      pathCache: this.pathCache,
      navBudget: this.navBudget,
    };
    for (const p of players) {
      if (!p.isBot || !p.alive || !p.brain) continue;
      const input = botThink(p.brain, p, env, this.botRng, dt || SIM_DT);
      input.seq = p.lastProcessedInputSeq + 1;
      this.enqueue(p, this.sanitize(input, p));
    }

    for (const p of players) {
      if (!p.alive || p.left) continue;
      this.processPlayer(p, dt, prevMs, now);
    }
    this.stepProjectiles(dt, now);

    if (this.zone) {
      updateZone(this.zone, b, this.map, this.zoneRng, now);
      this.applyZoneDamage(now);
    }

    const placed = this.resolveDeaths();
    this.checkMatchEnd(placed);
  }

  private simulateResults(dt: number): void {
    // Movement only (no combat, pickups or zone) so nobody hangs mid-air; humans can wander.
    for (const p of this.participants.values()) {
      if (!p.alive || p.left || p.aboard) continue;
      const input = this.dequeue(p);
      p.yaw = input.yaw;
      p.pitch = input.pitch;
      const status = { alive: true, healing: false, reloading: false, held: activeHeld(p.inv), swapping: false, fireSlowed: false };
      p.move = stepMovement(p.move, toMovementInput(input, status, this.balance), dt, this.ctx).state;
    }
  }

  private enqueue(p: SimPlayer, input: PlayerInput): void {
    p.queue.push(input);
    while (p.queue.length > MAX_QUEUED_INPUTS) p.queue.shift();
  }

  /**
   * Next input for a player. With an empty queue the last input's held fields repeat for at most
   * MAX_INPUT_REPEAT_TICKS ticks (jitter), then held movement/sprint/fire are released (yaw/pitch kept), so a stalled
   * or hidden tab cannot run or fire forever. BUG-010: that neutral input sets `p.stalled`, so it is not treated as a
   * trigger or ADS release (see actions.ts and processPlayer).
   */
  private dequeue(p: SimPlayer): PlayerInput {
    p.stalled = false;
    const next = p.queue.shift();
    if (next) {
      p.lastInput = next;
      p.lastProcessedInputSeq = next.seq;
      p.inputRepeatTicks = 0;
      return next;
    }
    p.inputRepeatTicks++;
    const last = p.lastInput;
    if (last && p.inputRepeatTicks > MAX_INPUT_REPEAT_TICKS) {
      p.stalled = true;
      return { ...last, moveForward: 0, moveRight: 0, sprint: false, fire: false, ads: false, ...NEUTRAL_EDGES };
    }
    if (!last) {
      return {
        seq: p.lastProcessedInputSeq,
        dt: SIM_DT,
        moveForward: 0,
        moveRight: 0,
        yaw: p.yaw,
        pitch: p.pitch,
        sprint: false,
        fire: false,
        ads: false,
        ...NEUTRAL_EDGES,
      };
    }
    return { ...last, ...NEUTRAL_EDGES };
  }

  private sanitize(input: PlayerInput, p: SimPlayer): PlayerInput {
    const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    let f = clamp(num(input.moveForward, 0), -1, 1);
    let r = clamp(num(input.moveRight, 0), -1, 1);
    const len = Math.hypot(f, r);
    if (len > MAX_MOVE_INPUT_LEN) {
      f /= len;
      r /= len;
    }
    const slot = input.selectSlot;
    // M2b (ADR 0005 §9): prone narrows the pitch range (the same pitchLimits the client look clamp and bots use).
    const pl = pitchLimits(p.move, this.balance);
    return {
      seq: Math.floor(num(input.seq, p.lastProcessedInputSeq)),
      dt: clamp(num(input.dt, SIM_DT), 0, SIM_DT),
      moveForward: f,
      moveRight: r,
      yaw: wrapAngle(num(input.yaw, p.yaw)),
      pitch: clamp(num(input.pitch, 0), pl.min, pl.max),
      sprint: input.sprint === true,
      fire: input.fire === true,
      jump: input.jump === true,
      reload: input.reload === true,
      interact: input.interact === true,
      useHeal: input.useHeal === true,
      selectSlot: slot === 0 || slot === 1 || slot === 2 || slot === 3 ? slot : -1,
      ads: input.ads === true,
      stanceToggle: input.stanceToggle === 'crouch' || input.stanceToggle === 'prone' ? input.stanceToggle : null,
      cycleScope: input.cycleScope === true,
    };
  }

  /**
   * drop.md "Aboard": position = the carrier; only look and the jump edge count. A jump edge at or after noJumpUntil
   * leaves the carrier (freefall at the carrier position, zero velocity, no movement step this tick); at ejectAt
   * everyone still aboard jumps (`auto`). Manual jumps on the eject tick stay manual.
   */
  private processAboard(p: SimPlayer, now: number): void {
    const route = this.route;
    const input = this.dequeue(p);
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    if (!route) {
      p.aboard = false;
      return;
    }
    const c = carrierPosAt(route, now);
    p.move = this.aboardMove(c);
    const manual = input.jump && now >= route.noJumpUntil - TIMER_EPSILON_MS;
    if (!manual && now < route.ejectAt - TIMER_EPSILON_MS) return;
    p.aboard = false;
    p.move = initialMovementState({ x: c.x, y: route.altitude, z: c.z }, true, 'freefall');
    this.emit({ type: 'dropJump', playerId: p.id, pos: { ...p.move.pos }, auto: !manual });
  }

  /** Action hooks for one player: events with the player id, refusals, shots, grenade release and cook-out. */
  private actionHooks(p: SimPlayer): ActionHooks {
    return {
      event: (e: ActionEvent) => {
        if (e.type === 'grenadeCook') {
          this.events.push({ type: 'grenadeCook', playerId: p.id, pos: this.eyeOf(p), explodesAt: e.explodesAt, kind: 'grenade' });
        } else if (e.type === 'meleeSwing') {
          this.events.push({ type: 'meleeSwing', playerId: p.id, weapon: e.weapon, level: e.level, pos: { ...p.move.pos }, hitAt: e.hitAt, cycleMs: e.cycleMs });
        } else this.events.push({ ...e, playerId: p.id });
      },
      failed: (action, reason) => this.actionFailed(p, action, reason),
      fire: (weapon) => this.fireShot(p, weapon),
      release: (how, explodesAt, kind) => this.spawnCookEntity(p, how, explodesAt, kind),
      cookOut: () => this.explodeFrag(this.nextGrenadeId++, p.id, this.eyeOf(p), true),
      interact: () => this.tryPickup(p),
      meleeHit: (sw) => this.meleeHit(p, sw),
      scopeChanged: (slot, gun, from, to) =>
        this.events.push({ type: 'scopeChanged', playerId: p.id, slot, gun, from, to, auto: false, pos: { ...p.move.pos } }),
    };
  }

  private processPlayer(p: SimPlayer, dt: number, prevMs: number, now: number): void {
    if (p.aboard) {
      this.processAboard(p, now);
      return;
    }
    const b = this.balance;
    const input = this.dequeue(p);
    p.yaw = input.yaw;
    p.pitch = input.pitch;
    const hooks = this.actionHooks(p);

    // 1. Action timers (shared step, actions.ts).
    advanceActionTimers(p, dt * 1000, b, hooks);

    // 2. Movement: stance, ADS and motion (stance.md per-tick order).
    const wasDropping = p.move.dropping;
    const held = activeHeld(p.inv);
    const status = {
      alive: true,
      healing: p.heal !== null,
      reloading: p.reload !== null,
      held,
      swapping: isSwapping(p),
      fireSlowed: fireSlowedOf(p, now, b),
      scope: activeSlotState(p.inv)?.scope ?? null,
    };
    const adsBefore = p.move.adsMs;
    const res = stepMovement(p.move, toMovementInput(input, status, b), dt, this.ctx);
    p.move = res.state;
    // BUG-012: clamp the pitch with the post-request stance, so entering prone clamps on the transition's first tick.
    const pl = pitchLimits(p.move, b);
    p.pitch = clamp(p.pitch, pl.min, pl.max);
    // BUG-010: a stall-neutral input freezes ADS instead of releasing it (the client still holds RMB).
    if (p.stalled && adsBefore > 0 && p.move.adsMs === 0) p.move = { ...p.move, adsMs: adsBefore };
    if (res.stanceChanged) {
      const c = res.stanceChanged;
      this.events.push({ type: 'stanceChange', playerId: p.id, from: c.from, to: c.to, forced: c.forced, durationMs: c.durationMs });
    }
    if (res.stanceRefused) this.actionFailed(p, 'stance', res.stanceRefused);
    if (res.chuteOpened) this.emit({ type: 'chuteOpen', playerId: p.id, pos: { ...p.move.pos }, manual: res.chuteOpened === 'manual' });
    if (res.landed && !wasDropping && res.landingSpeed > b.movement.fallDamageMinSpeed) {
      const dmg = (res.landingSpeed - b.movement.fallDamageMinSpeed) * b.movement.fallDamagePerMs;
      this.applyEnvDamage(p, dmg, 'fall', { ...p.move.pos });
    }

    // 3. Edges and the trigger (shared step): slot, reload, heal, pickup (hook), fire / grenade.
    const r = applyActionEdges(p, input, { now, prevMs, after: p.move, stalled: p.stalled }, b, hooks);
    if (r.endAds) this.endAds(p);
  }

  // -------------------------------------------------------------------------------------------
  // Weapons, reload, heal, pickup
  // -------------------------------------------------------------------------------------------

  /** Ends ADS (combat.md: swap, reload start, heal start set adsMs = 0). */
  private endAds(p: SimPlayer): void {
    if (p.move.adsMs !== 0) p.move = { ...p.move, adsMs: 0 };
  }

  private cancelActions(p: SimPlayer): void {
    cancelActionTimers(p, this.balance, this.actionHooks(p));
  }

  private tryPickup(p: SimPlayer): void {
    const range = this.balance.player.pickupRange;
    let best: LootEntity | null = null;
    let bestD = range * range;
    const pos = p.move.pos;
    for (const l of this.loot) {
      const d = (l.pos.x - pos.x) ** 2 + (l.pos.y - pos.y) ** 2 + (l.pos.z - pos.z) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = l;
      }
    }
    if (!best) return;
    const ground: GroundItem = { item: best.item, qty: best.qty, mag: best.mag, durability: best.durability, level: best.level ?? null, scope: best.scope ?? null };
    const o = applyPickup(p.inv, p, ground, this.balance);
    if (o.kind === 'refused') {
      this.actionFailed(p, 'pickup', o.reason);
      return;
    }
    if (o.remaining > 0) best.qty = o.remaining;
    else this.loot = this.loot.filter((l) => l !== best);
    this.lootVersion++;
    const ev: SimEvent = { type: 'pickup', playerId: p.id, lootId: best.id, item: best.item, qty: o.taken, pos: { ...best.pos } };
    if (o.durability !== undefined) ev.durability = o.durability;
    if (isM2cGunId(best.item) || isMeleeId(best.item)) ev.level = best.level ?? 1;
    if (isM2cGunId(best.item)) ev.scope = best.scope ?? null;
    this.events.push(ev);
    if (o.dropped) {
      const d = o.dropped;
      this.spawnLootAt({ item: d.weapon, qty: 1, mag: d.mag, level: d.level ?? 1, scope: d.scope ?? null }, pos.x, pos.z, pos.y);
    }
    if (o.droppedMelee) this.spawnLootAt({ item: o.droppedMelee.weapon, qty: 1, mag: null, level: o.droppedMelee.level }, pos.x, pos.z, pos.y);
    if (o.droppedScope) this.spawnLootAt({ item: o.droppedScope, qty: 1, mag: null }, pos.x, pos.z, pos.y);
    if (o.droppedArmor) {
      this.spawnLootAt({ item: o.droppedArmor.item, qty: 1, mag: null, durability: o.droppedArmor.durability }, pos.x, pos.z, pos.y);
    }
    if (o.scopeMount) {
      const m = o.scopeMount;
      this.events.push({ type: 'scopeChanged', playerId: p.id, slot: m.slot, gun: m.gun, from: m.from, to: m.to, auto: true, pos: { ...p.move.pos } });
    }
    if (o.upgradedSlot !== null && slotUpgradedByPickup(p, o.upgradedSlot, this.balance, this.actionHooks(p))) this.endAds(p);
    if (o.activeChanged && activeChangedByPickup(p, this.balance, this.actionHooks(p))) this.endAds(p);
  }

  private spawnLootAt(g: GroundItem, x: number, z: number, feetY: number): LootId {
    const id = this.nextLootId++;
    const y = groundHeightAt(this.ctx, x, z, feetY);
    this.loot.push({
      id,
      item: g.item,
      qty: g.qty,
      mag: g.mag,
      pos: { x, y, z },
      tier: dropTierOf(g.item),
      durability: g.durability ?? null,
      level: g.level ?? null,
      scope: g.scope ?? null,
    });
    this.lootVersion++;
    return id;
  }

  private dropInventory(p: SimPlayer): void {
    const pos = p.move.pos;
    for (const g of deathDrops(p.inv, p, this.balance)) {
      const s = scatterInDisc(pos.x, pos.z, this.balance.combat.deathDropScatter, this.matchRng);
      this.spawnLootAt(g, s.x, s.z, pos.y);
    }
    p.inv = createInventory();
    p.vest = null;
    p.helmet = null;
  }

  // -------------------------------------------------------------------------------------------
  // Grenades (grenades.md)
  // -------------------------------------------------------------------------------------------

  private eyeOf(p: SimPlayer): Vec3 {
    return eyePoint(p.move.pos, p.move, this.balance);
  }

  /** Death or disconnect while cooking: the grenade drops at the eye with zero velocity and keeps its fuse. */
  private releaseCook(p: SimPlayer, how: 'death'): void {
    const cook = p.cook;
    if (!cook) return;
    p.cook = null;
    this.spawnCookEntity(p, how, cook.explodesAt);
  }

  /**
   * The throwable in hand becomes an entity: 'throw' (LMB release), 'switch' (short drop on a slot change), 'death'
   * (drop at the eye with zero velocity). Keeps the remaining fuse. Recovery and the auto-switch are the action step's.
   * M2c: `kind` 'smoke' uses items.smoke throw and physics keys; its fuse end deploys a cloud.
   */
  private spawnCookEntity(p: SimPlayer, how: 'throw' | 'switch' | 'death', explodesAt: number, kind: M2cThrowableId = 'grenade'): void {
    const eye = this.eyeOf(p);
    let launch: { pos: Vec3; vel: Vec3 };
    if (how === 'throw') {
      const proneSettled = p.move.stance === 'prone' && isStanceSettled(p.move);
      launch = throwLaunch(eye, p.yaw, p.pitch, proneSettled, this.ctx, kind);
    } else if (how === 'switch') launch = dropLaunch(eye, p.yaw, this.ctx, kind);
    else launch = { pos: eye, vel: { x: 0, y: 0, z: 0 } };
    const id = this.nextGrenadeId++;
    this.grenades.push({
      id,
      ownerId: p.id,
      body: { pos: { ...launch.pos }, vel: { ...launch.vel }, inWater: false },
      explodesAt,
      spawnTick: this._tick,
      kind,
    });
    this.events.push({
      type: 'grenadeThrown',
      id,
      ownerId: p.id,
      pos: { ...launch.pos },
      vel: { ...launch.vel },
      explodesAt,
      dropped: how !== 'throw',
      kind,
    });
  }

  /**
   * Moves every live grenade and rocket, then resolves this tick's fuse ends and rocket contacts in entity id order
   * (one id space, rpg.md edge cases). Frags explode, smoke canisters deploy a cloud. Clouds past their fade are
   * removed. New grenades and rockets first move on the next tick.
   */
  private stepProjectiles(dt: number, now: number): void {
    const b = this.balance;
    const due: { id: number; run: () => void }[] = [];
    if (this.grenades.length > 0) {
      const keep: GrenadeEntity[] = [];
      for (const e of this.grenades) {
        if (e.spawnTick === this._tick) {
          keep.push(e);
          continue;
        }
        const r = stepGrenade(e.body, dt, this.ctx, e.kind);
        e.body = r.body;
        const c = r.contact;
        const tb = e.kind === 'smoke' ? b.items.smoke : b.items.grenade;
        if (c && (c.surface === 'water' || c.speed >= tb.bounceEventMinSpeed)) {
          this.events.push({ type: 'grenadeBounce', id: e.id, pos: { ...c.pos }, surface: c.surface, speed: c.speed, kind: e.kind });
        }
        if (now >= e.explodesAt - TIMER_EPSILON_MS) {
          due.push({
            id: e.id,
            run: () => (e.kind === 'smoke' ? this.deploySmoke(e, now) : this.explodeFrag(e.id, e.ownerId, e.body.pos, false)),
          });
        } else keep.push(e);
      }
      this.grenades = keep;
    }
    if (this.rockets.length > 0) {
      const rb = b.weapons.rpg.rocket;
      const range = b.weapons.rpg.range;
      const keep: RocketEntity[] = [];
      for (const r of this.rockets) {
        if (r.state.firedAt >= now) {
          keep.push(r);
          continue;
        }
        const contact = stepRocket(r, now, rb, range, this.ctx.colliders, this.map, this.rocketTargets(r.state.ownerId), b);
        if (contact) due.push({ id: r.state.id, run: () => this.endRocket(r, contact) });
        else keep.push(r);
      }
      this.rockets = keep;
    }
    due.sort((x, y) => x.id - y.id);
    for (const d of due) d.run();
    if (this.clouds.length > 0) this.clouds = liveClouds(this.clouds, now, b.items.smoke.cloud);
  }

  /** M2c (smoke.md "The cloud"): a canister's fuse ended: a cloud keeps its id; maxActive forces the oldest to fade. */
  private deploySmoke(e: GrenadeEntity, now: number): void {
    const cfg = this.balance.items.smoke.cloud;
    const cloud = deployCloud(e.id, e.ownerId, e.body.pos, e.body.inWater, now, cfg);
    addCloud(this.clouds, cloud, now, cfg);
    this.events.push({ type: 'smokeDeployed', ...cloud, pos: { ...cloud.pos } });
  }

  /**
   * Frag blast (grenades.md "Explosion"): explosion event, then one damage event per victim in range with line of sight
   * from pos + losHeightOffset to the stance chest point (props, terrain and intact glass block; players and smoke do
   * not). Vest only.
   */
  private explodeFrag(id: GrenadeId, ownerId: PlayerId, pos: Vec3, inHand: boolean): void {
    const g = this.balance.items.grenade;
    const at = { x: pos.x, y: pos.y, z: pos.z };
    this.events.push({ type: 'explosion', id, ownerId, pos: at, radius: g.radius, inHand, source: 'grenade' });
    for (const h of blastHits(at, g, g.maxDamage, this.blastTargets(ownerId, g.selfDamage), this.ctx.colliders, this.map)) {
      this.applyExplosionDamage(h.target, ownerId, h.damage, at, id, { weapon: 'grenade', weaponLevel: null });
    }
  }

  /** Alive, damageable participants as blast targets (chest points). */
  private blastTargets(ownerId: PlayerId, selfDamage: boolean): { target: SimPlayer; chest: Vec3 }[] {
    const out: { target: SimPlayer; chest: Vec3 }[] = [];
    for (const v of this.participants.values()) {
      if (!v.alive || v.left || v.dying || v.aboard || v.move.dropping) continue;
      if (v.id === ownerId && !selfDamage) continue;
      out.push({ target: v, chest: chestPoint(v.move.pos, v.move, this.balance) });
    }
    return out;
  }

  /** Hitbox candidates for melee and rockets: alive, non-dropping, not aboard, not `exceptId`. */
  private hitCandidates(exceptId: PlayerId): MeleeCandidate[] {
    const out: MeleeCandidate[] = [];
    for (const o of this.participants.values()) {
      if (o.id === exceptId || !o.alive || o.left || o.dying || o.aboard || o.move.dropping) continue;
      out.push({ id: o.id, feet: o.move.pos, yaw: o.yaw, move: o.move });
    }
    return out;
  }

  private rocketTargets(ownerId: PlayerId): MeleeCandidate[] {
    return this.hitCandidates(ownerId);
  }

  /** M2c (melee.md "Glass", rpg.md): a pane breaks for the rest of the match (colliders skip it from now on). */
  private breakPane(pane: PaneId, pos: Vec3, byId: PlayerId | null, cause: 'melee' | 'rocket'): void {
    if (this.broken.has(pane)) return;
    this.broken.add(pane);
    this.events.push({ type: 'glassBroken', paneId: pane, pos: { ...pos }, byId, cause });
  }

  // -------------------------------------------------------------------------------------------
  // Rockets (rpg.md)
  // -------------------------------------------------------------------------------------------

  /**
   * Fires one rocket: origin = eye + aim (in the launch cone) x originForward; a collider between the eye and the origin
   * makes it a dud at that point. rocketFired = the launch record.
   */
  private fireRocket(p: SimPlayer, level: ItemLevel, scope: ScopeId | null): void {
    const b = this.balance;
    const rb = b.weapons.rpg.rocket;
    const eye = this.eyeOf(p);
    const half = spreadRad(
      effectiveSpreadDeg('rpg', b, {
        horizontalSpeed: horizontalSpeed(p.move),
        airborne: !p.move.grounded,
        adsProgress: adsProgressOf(p.move, 'rpg', b, scope),
        stance: p.move.stance,
        stanceSettled: isStanceSettled(p.move),
      }, { level, scope }),
    );
    const d = sampleCone(aimDirection(p.yaw, p.pitch), half, this.combatRng);
    const id = this.nextGrenadeId++;
    const now = this._timeMs;
    this.recentShots.push({ shooterId: p.id, origin: eye, at: now });
    const block = raycastStatic(this.ctx.colliders, this.map, eye, d, rb.originForward);
    const state = {
      id,
      ownerId: p.id,
      level,
      pos: { x: eye.x + d.x * rb.originForward, y: eye.y + d.y * rb.originForward, z: eye.z + d.z * rb.originForward },
      vel: { x: d.x * rb.speed, y: d.y * rb.speed, z: d.z * rb.speed },
      firedAt: now,
    };
    this.events.push({ type: 'rocketFired', ...cloneRocketState(state) });
    if (block) {
      const at = { x: eye.x + d.x * block.t, y: eye.y + d.y * block.t, z: eye.z + d.z * block.t };
      const surface = block.kind === 'water' ? 'terrain' : block.kind;
      this.endRocket(createRocket(state), { pos: at, surface, travelled: 0, dir: d, victimId: null, pane: block.pane ?? null });
      return;
    }
    this.rockets.push(createRocket(state));
  }

  /**
   * A rocket ended (rpg.md "Contact or range"). Under armDistance: dud (impact damage only on a struck player, a struck
   * pane breaks, rocketDud). Else: glassBroken, impact damage (cause rocket, body, vest), explosion (source rocket) at
   * the contact pulled back collisionRadius, blast damage with rocketBlastMaxDamage(level). Kill credit: the owner.
   */
  private endRocket(r: RocketEntity, c: RocketContact): void {
    const b = this.balance;
    const rpg = b.weapons.rpg;
    const rb = rpg.rocket;
    const st = r.state;
    const victim = c.victimId !== null ? (this.participants.get(c.victimId) ?? null) : null;
    const impact = effWeapon(b, 'rpg', st.level).damage;
    const weaponFields = { weapon: 'rpg' as const, weaponLevel: st.level };
    if (c.travelled < rb.armDistance) {
      if (c.pane !== null) this.breakPane(c.pane, c.pos, st.ownerId, 'rocket');
      if (victim) this.applyRocketImpact(victim, st.ownerId, impact, st.pos, st.id, st.level);
      this.events.push({ type: 'rocketDud', id: st.id, ownerId: st.ownerId, pos: { ...c.pos }, surface: c.surface, victimId: c.victimId });
      return;
    }
    if (c.pane !== null) this.breakPane(c.pane, c.pos, st.ownerId, 'rocket');
    if (victim) this.applyRocketImpact(victim, st.ownerId, impact, st.pos, st.id, st.level);
    const at = { x: c.pos.x - c.dir.x * rb.collisionRadius, y: c.pos.y - c.dir.y * rb.collisionRadius, z: c.pos.z - c.dir.z * rb.collisionRadius };
    const ev: SimEvent = { type: 'explosion', id: st.id, ownerId: st.ownerId, pos: at, radius: rb.blast.radius, inHand: false, source: 'rocket' };
    if (victim) ev.direct = true;
    if (c.surface === 'range') ev.airburst = true;
    this.events.push(ev);
    const maxDamage = rocketBlastMaxDamage(b, st.level);
    for (const h of blastHits(at, rb.blast, maxDamage, this.blastTargets(st.ownerId, rb.blast.selfDamage), this.ctx.colliders, this.map)) {
      this.applyExplosionDamage(h.target, st.ownerId, h.damage, at, st.id, { ...weaponFields, direct: h.target === victim });
    }
  }

  /** Rocket impact: body zone through the vest, cause 'rocket', weapon rpg at the rocket's level. */
  private applyRocketImpact(v: SimPlayer, ownerId: PlayerId, amount: number, src: Vec3, rocketId: number, level: ItemLevel): void {
    if (!v.alive || v.dying || v.left || v.aboard || v.move.dropping || amount <= 0) return;
    const before = v.vest;
    const r = before ? applyArmorPiece(before, amount, armorBalance(this.balance, 'vest', before.tier).absorbFraction) : null;
    v.vest = r ? r.piece : null;
    v.hp -= r ? r.hpLoss : amount;
    if (ownerId !== v.id) v.lastDamagedBy = { id: ownerId, at: this._timeMs };
    v.lastHurtAt = this._timeMs;
    const lethal = v.hp <= 0;
    if (lethal) v.hp = 0;
    this.events.push({
      type: 'damage',
      victimId: v.id,
      attackerId: ownerId,
      amount,
      headshot: false,
      cause: 'rocket',
      sourcePos: { ...src },
      hpAfter: v.hp,
      vest: r ? armorHit(before, r.absorbed, r.broken) : null,
      helmet: null,
      grenadeId: rocketId,
      weapon: 'rpg',
      weaponLevel: level,
    });
    if (lethal) this.setDying(v, ownerId, { weapon: 'rpg', cause: 'rocket', headshot: false, weaponLevel: level, direct: true });
  }

  /** Kill bookkeeping for owner-attributed damage (rockets, blasts): a self-kill credits the last enemy damager. */
  private setDying(v: SimPlayer, ownerId: PlayerId, d: Omit<NonNullable<SimPlayer['dying']>, 'killerId'>): void {
    let killer: SimPlayer | null;
    if (ownerId === v.id) killer = this.creditFor(v);
    else killer = this.participants.get(ownerId) ?? null;
    if (killer) killer.kills++;
    v.dying = { killerId: killer ? killer.id : ownerId === v.id ? null : ownerId, ...d };
  }

  // -------------------------------------------------------------------------------------------
  // Melee (melee.md)
  // -------------------------------------------------------------------------------------------

  /**
   * The hit frame of a swing (melee.md "Swing" 3-5): centre ray, else sweep, from this tick's eye and aim. A glass pane
   * on the centre ray breaks (no damage). A player hit takes damage (cause melee; head through the helmet, body through
   * the vest) and, with the paddle, knockback.
   */
  private meleeHit(p: SimPlayer, sw: SwingState): void {
    // A dying attacker still lands (melee.md: two players swinging on the same tick can both hit).
    if (!p.alive || p.move.dropping) return;
    const b = this.balance;
    const ew = effWeapon(b, sw.weapon, sw.level);
    const mb = b.weapons[sw.weapon];
    const eye = this.eyeOf(p);
    const aim = aimDirection(p.yaw, p.pitch);
    const res = meleeHitCheck(eye, aim, ew.range, mb.sweepRadius, this.hitCandidates(p.id), this.ctx.colliders, this.map, b);
    if (!res) return;
    const base = { type: 'meleeHit' as const, attackerId: p.id, weapon: sw.weapon, level: sw.level, pos: { ...res.point } };
    if (res.kind === 'glass') {
      this.events.push({ ...base, surface: 'glass', victimId: null, headshot: false, knockback: false });
      this.breakPane(res.pane, res.point, p.id, 'melee');
      return;
    }
    if (res.kind === 'static') {
      const surface: ImpactSurface = res.surface;
      this.events.push({ ...base, surface, victimId: null, headshot: false, knockback: false });
      return;
    }
    const v = this.participants.get(res.id);
    if (!v) return;
    const knock = mb.knockbackSpeed > 0 || mb.knockbackLift > 0;
    this.events.push({ ...base, surface: 'player', victimId: v.id, headshot: res.headshot, knockback: knock });
    const dmg = ew.damage * (res.headshot ? ew.headshotMultiplier : 1);
    this.applyWeaponDamage(v, p, res.headshot ? dmg : 0, res.headshot ? 0 : dmg, sw.weapon, eye, { cause: 'melee', weaponLevel: sw.level });
    if (knock && v.alive && !v.dying) {
      // Paddle knockback: horizontal knockbackSpeed along the attacker's yaw; lift unless the target is settled prone.
      const fx = -Math.sin(p.yaw);
      const fz = -Math.cos(p.yaw);
      const prone = v.move.stance === 'prone' && isStanceSettled(v.move);
      const vy = prone ? v.move.vel.y : Math.max(v.move.vel.y, mb.knockbackLift);
      v.move = {
        ...v.move,
        vel: { x: v.move.vel.x + fx * mb.knockbackSpeed, y: vy, z: v.move.vel.z + fz * mb.knockbackSpeed },
        grounded: prone ? v.move.grounded : false,
      };
    }
  }

  private applyExplosionDamage(
    v: SimPlayer,
    ownerId: PlayerId,
    amount: number,
    src: Vec3,
    grenadeId: GrenadeId,
    w: { weapon: 'grenade' | 'rpg'; weaponLevel: ItemLevel | null; direct?: boolean },
  ): void {
    const before = v.vest;
    const r = before ? applyArmorPiece(before, amount, armorBalance(this.balance, 'vest', before.tier).absorbFraction) : null;
    v.vest = r ? r.piece : null;
    v.hp -= r ? r.hpLoss : amount;
    if (ownerId !== v.id) v.lastDamagedBy = { id: ownerId, at: this._timeMs };
    v.lastHurtAt = this._timeMs;
    const lethal = v.hp <= 0;
    if (lethal) v.hp = 0;
    this.events.push({
      type: 'damage',
      victimId: v.id,
      attackerId: ownerId,
      amount,
      headshot: false,
      cause: 'explosion',
      sourcePos: { ...src },
      hpAfter: v.hp,
      vest: r ? armorHit(before, r.absorbed, r.broken) : null,
      helmet: null,
      grenadeId,
      weapon: w.weapon,
      weaponLevel: w.weaponLevel,
    });
    if (!lethal) return;
    const d: Omit<NonNullable<SimPlayer['dying']>, 'killerId'> = { weapon: w.weapon, cause: 'explosion', headshot: false, weaponLevel: w.weaponLevel };
    if (w.direct) d.direct = true;
    this.setDying(v, ownerId, d);
  }

  private fireShot(p: SimPlayer, weapon: WeaponId): void {
    const b = this.balance;
    const slot = activeSlotState(p.inv);
    const level: ItemLevel = slot ? (slot.level ?? 1) : 1;
    const scope: ScopeId | null = slot ? (slot.scope ?? null) : null;
    if (weapon === 'rpg') {
      this.fireRocket(p, level, scope);
      return;
    }
    // levels.md / scopes.md: damage, spread and ADS numbers of this instance (effectiveWeapon).
    const wb = slot ? slotWeapon(b, slot) : effWeapon(b, weapon);
    const weaponLevel: ItemLevel | null = slot ? level : null;
    const eye = this.eyeOf(p);
    const aim = aimDirection(p.yaw, p.pitch);
    const half = spreadRad(
      effectiveSpreadDeg(weapon, b, {
        horizontalSpeed: horizontalSpeed(p.move),
        airborne: !p.move.grounded,
        adsProgress: adsProgressOf(p.move, weapon, b, scope),
        stance: p.move.stance,
        stanceSettled: isStanceSettled(p.move),
      }, { level, scope }),
    );
    const impacts: ShotImpact[] = [];
    const hits = new Map<PlayerId, { head: number; body: number }>();
    const pellets = Math.max(1, Math.floor(wb.pellets));
    for (let i = 0; i < pellets; i++) {
      const d = sampleCone(aim, half, this.combatRng);
      const stat = raycastStatic(this.ctx.colliders, this.map, eye, d, wb.range);
      let maxT = stat ? stat.t : wb.range;
      let victim: SimPlayer | null = null;
      let headshot = false;
      for (const o of this.participants.values()) {
        if (o === p || !o.alive || o.left || o.dying || o.aboard || o.move.dropping) continue;
        const h = rayHitbox(eye, d, maxT, o.move.pos, o.yaw, o.move, b);
        if (h && h.t <= maxT) {
          maxT = h.t;
          victim = o;
          headshot = h.headshot;
        }
      }
      const point = { x: eye.x + d.x * maxT, y: eye.y + d.y * maxT, z: eye.z + d.z * maxT };
      if (victim) {
        const dmg = pelletDamage(wb, maxT, headshot);
        const acc = hits.get(victim.id) ?? { head: 0, body: 0 };
        if (headshot) acc.head += dmg;
        else acc.body += dmg;
        hits.set(victim.id, acc);
        impacts.push({ point, surface: 'player', playerId: victim.id, headshot });
      } else if (stat) {
        if (stat.kind === 'water' && d.y < 0 && eye.y > 0) {
          // Report where the ray enters the water (splash), not the sea floor.
          const tw = -eye.y / d.y;
          impacts.push({ point: { x: eye.x + d.x * tw, y: 0, z: eye.z + d.z * tw }, surface: 'water', playerId: null, headshot: false });
        } else {
          impacts.push({ point, surface: stat.kind, playerId: null, headshot: false });
        }
      } else {
        impacts.push({ point, surface: 'none', playerId: null, headshot: false });
      }
    }
    this.events.push({ type: 'shot', shooterId: p.id, weapon, origin: eye, impacts });
    this.recentShots.push({ shooterId: p.id, origin: eye, at: this._timeMs });
    for (const [vid, h] of hits) {
      const v = this.participants.get(vid);
      if (v) this.applyWeaponDamage(v, p, h.head, h.body, weapon, eye, { cause: 'weapon', weaponLevel });
    }
  }

  /** Contract revision 1: a human's edge action (heal / pickup / reload press) was refused. Never for bots or fire. */
  private actionFailed(p: SimPlayer, action: FailedAction, reason: ActionFailReason): void {
    if (p.isBot) return;
    const e: ActionFailedSimEvent = { type: 'actionFailed', playerId: p.id, action, reason };
    this.actionFailures.push(e);
    this.events.push(e);
  }

  // -------------------------------------------------------------------------------------------
  // Damage and death
  // -------------------------------------------------------------------------------------------

  /**
   * One shot's damage on one victim (combat.md "Shot resolution" 6-7): the head sum goes through the helmet, the body
   * sum through the vest, one damage event.
   */
  private applyWeaponDamage(
    v: SimPlayer,
    attacker: SimPlayer,
    head: number,
    body: number,
    weapon: WeaponId,
    src: Vec3,
    o: { cause: 'weapon' | 'melee'; weaponLevel: ItemLevel | null },
  ): void {
    const amount = head + body;
    if (!v.alive || v.dying || v.left || v.aboard || v.move.dropping || amount <= 0) return;
    const b = this.balance;
    const hb = v.helmet;
    const vb = v.vest;
    const hr = head > 0 && hb ? applyArmorPiece(hb, head, armorBalance(b, 'helmet', hb.tier).absorbFraction) : null;
    const vr = body > 0 && vb ? applyArmorPiece(vb, body, armorBalance(b, 'vest', vb.tier).absorbFraction) : null;
    if (hr) v.helmet = hr.piece;
    if (vr) v.vest = vr.piece;
    // combat.md "Sniper rules": a helmet turns a capped weapon's headshot into a heavy hit instead of a one-shot.
    const cap = b.combat.helmetHeadshotCap;
    const headLoss = hr ? (cap.weapons.includes(weapon) ? Math.min(hr.hpLoss, cap.maxHpLoss) : hr.hpLoss) : head;
    v.hp -= headLoss + (vr ? vr.hpLoss : body);
    const headshot = head > 0;
    if (attacker.id !== v.id) v.lastDamagedBy = { id: attacker.id, at: this._timeMs };
    v.lastHurtAt = this._timeMs;
    const lethal = v.hp <= 0;
    if (lethal) v.hp = 0;
    this.events.push({
      type: 'damage',
      victimId: v.id,
      attackerId: attacker.id,
      amount,
      headshot,
      cause: o.cause,
      sourcePos: { ...src },
      hpAfter: v.hp,
      vest: vr ? armorHit(vb, vr.absorbed, vr.broken) : null,
      helmet: hr ? armorHit(hb, hr.absorbed, hr.broken) : null,
      weapon,
      weaponLevel: o.weaponLevel,
    });
    if (lethal) {
      v.dying = { killerId: attacker.id, weapon, cause: o.cause, headshot, weaponLevel: o.weaponLevel };
      if (attacker.id !== v.id) attacker.kills++;
    }
  }

  /** Last enemy who damaged `v` within match.killCreditWindowSeconds. */
  private creditFor(v: SimPlayer): SimPlayer | null {
    const d = v.lastDamagedBy;
    if (!d || this._timeMs - d.at > this.balance.match.killCreditWindowSeconds * 1000) return null;
    const k = this.participants.get(d.id);
    return k && k.id !== v.id ? k : null;
  }

  /** Zone / fall damage. Fall ignores armor; zone uses the vest only when zone.ignoresArmor is false. */
  private applyEnvDamage(v: SimPlayer, amount: number, cause: DeathCause, src: Vec3): void {
    if (!v.alive || v.dying || v.left || amount <= 0) return;
    const useVest = cause === 'zone' && !this.balance.zone.ignoresArmor && v.vest !== null;
    const before = v.vest;
    const r =
      useVest && before ? applyArmorPiece(before, amount, armorBalance(this.balance, 'vest', before.tier).absorbFraction) : null;
    if (r) v.vest = r.piece;
    v.hp -= r ? r.hpLoss : amount;
    v.lastHurtAt = this._timeMs;
    const lethal = v.hp <= 0;
    if (lethal) v.hp = 0;
    this.events.push({
      type: 'damage',
      victimId: v.id,
      attackerId: null,
      amount,
      headshot: false,
      cause,
      sourcePos: src,
      hpAfter: v.hp,
      vest: r ? armorHit(before, r.absorbed, r.broken) : null,
      helmet: null,
      weapon: null,
      weaponLevel: null,
    });
    if (lethal) {
      const credit = this.creditFor(v);
      if (credit) credit.kills++;
      v.dying = { killerId: credit ? credit.id : null, weapon: null, cause, headshot: false, weaponLevel: null };
    }
  }

  private applyZoneDamage(now: number): void {
    const z = this.zone;
    if (!z) return;
    const tickMs = this.balance.zone.damageTickMs;
    if (tickMs <= 0) return;
    while (now >= this.nextZoneDamageAt) {
      this.nextZoneDamageAt += tickMs;
      const s = z.state;
      const amount = (s.dps * tickMs) / 1000;
      if (amount <= 0) continue;
      for (const p of this.participants.values()) {
        // drop.md: aboard players are immune; freefall and parachute players are not.
        if (!p.alive || p.left || p.dying || p.aboard) continue;
        if (!isOutsideZone(s, p.move.pos.x, p.move.pos.z)) continue;
        const e = nearestEdgePoint(s, p.move.pos.x, p.move.pos.z);
        this.applyEnvDamage(p, amount, 'zone', { x: e.x, y: p.move.pos.y + this.balance.player.eyeHeight, z: e.z });
      }
    }
  }

  /** Resolves this tick's deaths: ordering, placements, drops, kill events. Returns the players placed. */
  private resolveDeaths(): SimPlayer[] {
    const dying: SimPlayer[] = [];
    for (const p of this.participants.values()) if (p.alive && p.dying) dying.push(p);
    if (dying.length === 0) return dying;
    dying.sort((a, b) => b.tickStartHpArmor - a.tickStartHpArmor || b.kills - a.kills || a.id - b.id);
    let aliveAfter = 0;
    for (const p of this.participants.values()) if (p.alive && !p.left && !p.dying) aliveAfter++;
    dying.forEach((p, i) => {
      const d = p.dying!;
      p.placement = aliveAfter + 1 + i;
      this.cancelActions(p);
      this.releaseCook(p, 'death');
      this.dropInventory(p);
      p.alive = false;
      p.hp = 0;
      p.dying = null;
      p.queue = [];
      this.events.push({
        type: 'kill',
        victimId: p.id,
        killerId: d.killerId,
        weapon: d.weapon,
        cause: d.cause,
        placement: p.placement,
        headshot: d.headshot === true,
        weaponLevel: d.weaponLevel !== undefined ? d.weaponLevel : d.weapon !== null && isM2cGunId(d.weapon) ? 1 : null,
        ...(d.direct ? { direct: true } : {}),
      });
    });
    return dying;
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private toPlayerState(p: SimPlayer): PlayerState {
    const b = this.balance;
    const speed = horizontalSpeed(p.move);
    const moving = speed > ANIM_MOVING_SPEED;
    const li = p.lastInput;
    const standing = p.move.stance === 'stand' && isStanceSettled(p.move);
    const sprinting =
      p.alive &&
      moving &&
      standing &&
      p.move.grounded &&
      !!li &&
      li.sprint &&
      !li.ads &&
      li.moveForward > 0 &&
      !li.fire &&
      p.heal === null;
    const held = activeHeld(p.inv);
    const slot = activeSlotState(p.inv);
    const out: PlayerState & PlayerM2cFields = {
      id: p.id,
      name: p.name,
      pos: { ...p.move.pos },
      velY: p.move.vel.y,
      yaw: p.yaw,
      pitch: p.pitch,
      hp: p.hp,
      vestTier: p.vest ? p.vest.tier : 0,
      helmetTier: p.helmet ? p.helmet.tier : 0,
      alive: p.alive,
      weapon: held as HeldId,
      stance: p.move.stance,
      stanceFrom: p.move.stanceFrom,
      stanceProgress: stanceProgress(p.move, b),
      anim: {
        moving: p.alive && moving,
        sprinting,
        airborne: !p.move.grounded,
        dropping: p.move.dropping,
        inWater: isInWater(p.move, b),
        firing: p.alive && this._timeMs < p.firingUntil,
        reloading: p.reload !== null,
        healing: p.heal !== null,
        ads: p.alive && p.move.adsMs > 0,
        cooking: p.cook !== null,
      },
      appearance: { ...p.appearance },
      isBot: p.isBot,
      kills: p.kills,
      aboard: p.aboard,
      dropPhase: p.move.dropping ? p.move.dropPhase : null,
      // M2c (levels.md, scopes.md): the held weapon's level; null for fists and throwables. Effective sight.
      weaponLevel: activeLevel(p.inv),
      sight: effectiveSight(b, held, slot?.scope ?? null),
    };
    return out;
  }

  private toLocal(p: SimPlayer): LocalPlayerState {
    const inv = p.inv;
    const m = p.move;
    const out: LocalPlayerState & LocalM2cFields = {
      id: p.id,
      lastProcessedInputSeq: p.lastProcessedInputSeq,
      movement: {
        pos: { ...m.pos },
        vel: { ...m.vel },
        grounded: m.grounded,
        dropping: m.dropping,
        stance: m.stance,
        stanceFrom: m.stanceFrom,
        stanceMs: m.stanceMs,
        adsMs: m.adsMs,
        dropPhase: m.dropPhase,
        dropMs: m.dropMs,
      },
      slots: [localSlot(inv.slots[0]), localSlot(inv.slots[1])],
      activeSlot: inv.activeSlot,
      ammo: { ...inv.ammo },
      heals: { ...inv.heals },
      vest: p.vest ? { ...p.vest } : null,
      helmet: p.helmet ? { ...p.helmet } : null,
      grenades: inv.grenades,
      cookExplodesAt: p.cook ? p.cook.explodesAt : null,
      throwRecoveryMs: p.throwRecoveryMs,
      reloadRemainingMs: p.reload ? Math.max(0, p.reload.remainingMs) : 0,
      reloadTotalMs: p.reload ? p.reload.totalMs : 0,
      healRemainingMs: p.heal ? Math.max(0, p.heal.remainingMs) : 0,
      healTotalMs: p.heal ? p.heal.totalMs : 0,
      healItem: p.heal ? p.heal.item : null,
      swapRemainingMs: p.swapRemainingMs,
      aboard: p.aboard,
      melee: inv.melee ? { ...inv.melee } : null,
      smokes: inv.smokes,
      selectedThrowable: inv.selectedThrowable,
      spareScope: inv.spareScope,
      scopeSwapRemainingMs: p.scopeSwap ? Math.max(0, p.scopeSwap.remainingMs) : 0,
    };
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Test / tooling hooks (not part of the network contract)
  // -------------------------------------------------------------------------------------------

  /** Internal player record (tests and tools only). */
  debugPlayer(id: PlayerId): SimPlayer | undefined {
    return this.participants.get(id);
  }

  debugLoot(): LootEntity[] {
    return this.loot;
  }

  /** Refused human edge actions during the last step (contract revision 1 `actionFailed`). */
  debugActionFailures(): readonly ActionFailedSimEvent[] {
    return this.actionFailures;
  }

  debugZone(): ZoneRuntime | null {
    return this.zone;
  }

  debugContext(): MovementContext {
    return this.ctx;
  }

  /** Live grenade entities (tests and tools only). */
  debugGrenades(): readonly GrenadeEntity[] {
    return this.grenades;
  }

  /** Places a live grenade (tests only): first moves next tick, explodes fuseMs from now. */
  debugSpawnGrenade(ownerId: PlayerId, pos: Vec3, vel: Vec3, fuseMs: number, kind: M2cThrowableId = 'grenade'): GrenadeId {
    const id = this.nextGrenadeId++;
    this.grenades.push({
      id,
      ownerId,
      body: { pos: { ...pos }, vel: { ...vel }, inWater: false },
      explodesAt: this._timeMs + fuseMs,
      spawnTick: this._tick,
      kind,
    });
    return id;
  }

  /** M2c tests: live rockets, clouds and broken panes. */
  debugRockets(): readonly RocketEntity[] {
    return this.rockets;
  }

  debugClouds(): SmokeCloudState[] {
    return this.clouds;
  }

  debugBrokenPanes(): ReadonlySet<PaneId> {
    return this.broken;
  }
}

/** Gun slot for the snapshot: level and scope always written (absent level = L1). */
const localSlot = (s: Inventory['slots'][number]): Inventory['slots'][number] =>
  s ? { weapon: s.weapon, mag: s.mag, level: s.level ?? 1, scope: s.scope ?? null } : null;

const cloneRocketState = (r: RocketState): RocketState => ({ ...r, pos: { ...r.pos }, vel: { ...r.vel } });

const toGrenadeState = (g: GrenadeEntity): GrenadeState => ({
  id: g.id,
  ownerId: g.ownerId,
  pos: { ...g.body.pos },
  vel: { ...g.body.vel },
  explodesAt: g.explodesAt,
  inWater: g.body.inWater,
  kind: g.kind,
});

/** Fisher-Yates shuffle in place with the given Rng. */
function shuffle<T>(arr: T[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

/** Debug-capable World (tests). `createWorld` returns this at runtime. */
export interface DebugWorld extends World {
  debugPlayer(id: PlayerId): SimPlayer | undefined;
  debugLoot(): LootEntity[];
  debugActionFailures(): readonly ActionFailedSimEvent[];
  debugZone(): ZoneRuntime | null;
  debugContext(): MovementContext;
  debugGrenades(): readonly GrenadeEntity[];
  debugSpawnGrenade(ownerId: PlayerId, pos: Vec3, vel: Vec3, fuseMs: number, kind?: M2cThrowableId): GrenadeId;
  /** M2c: live rockets, smoke clouds (mutable for tests) and broken panes. */
  debugRockets(): readonly RocketEntity[];
  debugClouds(): SmokeCloudState[];
  debugBrokenPanes(): ReadonlySet<PaneId>;
}

/** Same as createWorld, typed with the test/tool hooks. */
export function createDebugWorld(opts: WorldOptions): DebugWorld {
  return new SimWorld(opts);
}
