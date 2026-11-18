/**
 * Authoritative match simulation (docs/tech/ARCHITECTURE.md section 4). Pure and deterministic for a given seed and
 * input sequence: seeded Rng streams, world time only, no globals.
 */
import type { Balance } from '../balance';
import { ammoFor } from '../balance';
import { MAX_INPUT_REPEAT_TICKS, MAX_QUEUED_INPUTS, PITCH_MAX, PITCH_MIN, SIM_DT } from '../constants';
import { aimDirection, clamp, createRng, type Rng, wrapAngle } from '../math';
import type {
  ActionFailedSimEvent,
  ActionFailReason,
  Appearance,
  DeathCause,
  FailedAction,
  GunId,
  HealId,
  LocalPlayerState,
  LootId,
  MapData,
  MatchPhase,
  MatchState,
  PlayerId,
  PlayerInput,
  PlayerState,
  ShotImpact,
  SimEvent,
  SlotIndex,
  Standing,
  Vec3,
  WeaponId,
  WorldSnapshot,
} from '../types';
import { botThink, createBotBrain, rollPersonality, type RecentShot } from './bots';
import { raycastStatic } from './colliders';
import { applyDamage, effectiveSpreadDeg, isHeadshot, pelletDamage, rayCylinder, sampleCone, spreadRad } from './combat';
import {
  activeSlotState,
  activeWeapon,
  applyPickup,
  chooseHeal,
  createInventory,
  deathDrops,
  healedHp,
  reloadAmount,
  type GroundItem,
} from './inventory';
import { scatterInDisc, spawnMatchLoot, toLootState, type LootEntity } from './loot';
import {
  createMovementContext,
  groundHeightAt,
  horizontalSpeed,
  isInWater,
  MAX_MOVE_INPUT_LEN,
  stepMovement,
  toMovementInput,
  type MovementContext,
} from './movement';
import type { SimPlayer } from './state';
import { heightAt } from './terrain';
import { cloneZoneState, createZone, isOutsideZone, nearestEdgePoint, updateZone, type ZoneRuntime } from './zone';

export interface WorldOptions {
  map: MapData;
  balance: Balance;
  seed: number;
  botNames: readonly string[];
}

export interface World {
  readonly tick: number;
  /** Server clock ms (sum of step dt; tick * SIM_DT * 1000 when the server always passes SIM_DT). */
  readonly timeMs: number;
  readonly map: MapData;
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
/**
 * Timers complete when within this many ms of zero (float accumulation of 1000/30 ms steps). Exported so client-side
 * action prediction (src/game/actionPrediction.ts) uses the same completion rule.
 */
export const TIMER_EPSILON_MS = 1e-6;
/** Safety cap on shots resolved for one player in one tick. */
const MAX_SHOTS_PER_TICK = 8;

const RNG_MATCH = 1;
const RNG_ZONE = 2;
const RNG_COMBAT = 3;
const RNG_BOTS = 4;

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

const NEUTRAL_EDGES = { jump: false, reload: false, interact: false, useHeal: false, selectSlot: -1 as const };

export function createWorld(opts: WorldOptions): World {
  return new SimWorld(opts);
}

class SimWorld implements World {
  readonly map: MapData;
  private readonly balance: Balance;
  private readonly seed: number;
  private readonly botNames: readonly string[];
  private readonly ctx: MovementContext;
  private readonly worldRng: Rng;

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
    this.ctx = createMovementContext(opts.map, opts.balance);
    this.worldRng = createRng(mixSeed(this.seed, 0, 0));
    this.matchRng = this.zoneRng = this.combatRng = this.botRng = this.worldRng;
    this.seedMatchRngs();
  }

  get tick(): number {
    return this._tick;
  }

  get timeMs(): number {
    return this._timeMs;
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
    this._tick++;
    const prevMs = this._timeMs;
    // Exactly tick * SIM_DT * 1000 while every step is SIM_DT (the server contract); accumulates otherwise (tests).
    if (d !== SIM_DT) this.uniformDt = false;
    this._timeMs = this.uniformDt ? this._tick * SIM_DT * 1000 : this._timeMs + d * 1000;
    const now = this._timeMs;

    switch (this.phase) {
      case 'lobby':
        this.checkLobby();
        break;
      case 'countdown':
        if (this.queuedCount() < this.balance.match.minHumansToStart) {
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
          this.toLobby();
          this.checkLobby();
        }
        break;
    }
    return this.events;
  }

  getMatch(): MatchState {
    const inMatch = this.phase === 'playing' || this.phase === 'results';
    return {
      matchId: this.matchId,
      phase: this.phase,
      phaseEndsAt: this.phaseEndsAt,
      lobbyCount: this.queuedCount(),
      targetPlayers: this.balance.match.targetPlayers,
      aliveCount: inMatch ? this.aliveParticipants().length : 0,
      totalPlayers: inMatch ? this.totalPlayers : 0,
      winnerId: this.winnerId,
      winnerName: this.winnerName,
    };
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
      local: viewer && !viewer.left ? this.toLocal(viewer) : null,
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
      armor: 0,
      kills: 0,
      move: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: false, dropping: true },
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
      queue: [],
      lastInput: null,
      inputRepeatTicks: 0,
      lastProcessedInputSeq: 0,
      lastDamagedBy: null,
      tickStartHpArmor: b.player.maxHp,
      placement: null,
      brain: null,
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

    const humans = [...this.humans.values()].filter((h) => h.queued).slice(0, b.match.maxPlayers);
    const list: SimPlayer[] = [];
    for (const h of humans) {
      h.queued = false;
      list.push(this.newPlayer(h.id, h.name, false, h.appearance));
    }
    const nBots = Math.max(0, b.match.targetPlayers - humans.length);
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

    // Spawns: random rotation offset, then every (S / N)-th spawn; shuffled assignment; jitter; drop height.
    const spawns = this.map.playerSpawns;
    const n = list.length;
    const order = [...list];
    shuffle(order, this.matchRng);
    const S = spawns.length;
    const offset = S > 0 ? this.matchRng.int(S) : 0;
    const stride = S > 0 ? S / Math.max(1, n) : 0;
    order.forEach((p, k) => {
      const sp = S > 0 ? spawns[Math.floor(offset + k * stride) % S]! : { x: 0, z: 0 };
      const j = scatterInDisc(sp.x, sp.z, b.match.spawnJitter, this.matchRng);
      const ground = heightAt(j.x, j.z, this.map);
      p.move = {
        pos: { x: j.x, y: Math.max(ground, 0) + b.match.dropHeight, z: j.z },
        vel: { x: 0, y: 0, z: 0 },
        grounded: false,
        dropping: true,
      };
      p.yaw = Math.atan2(j.x, j.z); // face the island centre (forward = (-sin, -cos))
      p.tickStartHpArmor = p.hp + p.armor;
    });
    for (const p of list) this.events.push({ type: 'spawn', playerId: p.id, pos: { ...p.move.pos } });

    this.loot = spawnMatchLoot(this.map, b, this.matchRng, () => this.nextLootId++, (x, z) =>
      groundHeightAt(this.ctx, x, z, heightAt(x, z, this.map)),
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

  private toLobby(): void {
    this.matchId++;
    this.participants = new Map();
    this.loot = [];
    this.lootVersion++;
    this.zone = null;
    this.recentShots = [];
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
    for (const p of this.participants.values()) this.cancelActions(p);
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
    // Rank remaining bots by hp + armor, then kills, then id. Top bot wins.
    const ranked = [...alive].sort((a, b) => b.hp + b.armor - (a.hp + a.armor) || b.kills - a.kills || a.id - b.id);
    ranked.forEach((p, i) => (p.placement = i + 1));
    this.endMatch(ranked[0] ?? null);
  }

  // -------------------------------------------------------------------------------------------
  // Tick
  // -------------------------------------------------------------------------------------------

  private simulatePlaying(dt: number, prevMs: number, now: number): void {
    const b = this.balance;
    const players = [...this.participants.values()];
    for (const p of players) p.tickStartHpArmor = p.hp + p.armor;
    const shotWindow = b.bots.decisionIntervalMs;
    if (this.recentShots.length > 0) this.recentShots = this.recentShots.filter((s) => now - s.at <= shotWindow);

    // Bots produce inputs through the same queue as humans.
    const env = {
      now,
      balance: b,
      map: this.map,
      ctx: this.ctx,
      players,
      loot: this.loot,
      zone: this.zone ? this.zone.state : null,
      recentShots: this.recentShots,
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
      if (!p.alive || p.left) continue;
      const input = this.dequeue(p);
      p.yaw = input.yaw;
      p.pitch = input.pitch;
      const mi = toMovementInput(input, { alive: true, healing: false, reloading: false }, this.balance);
      p.move = stepMovement(p.move, mi, dt, this.ctx).state;
    }
  }

  private enqueue(p: SimPlayer, input: PlayerInput): void {
    p.queue.push(input);
    while (p.queue.length > MAX_QUEUED_INPUTS) p.queue.shift();
  }

  /**
   * Next input for a player. With an empty queue the last input's held fields repeat for at most
   * MAX_INPUT_REPEAT_TICKS ticks (jitter), then held movement/sprint/fire are released (yaw/pitch kept), so a stalled
   * or hidden tab cannot run or fire forever.
   */
  private dequeue(p: SimPlayer): PlayerInput {
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
      return { ...last, moveForward: 0, moveRight: 0, sprint: false, fire: false, ...NEUTRAL_EDGES };
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
    return {
      seq: Math.floor(num(input.seq, p.lastProcessedInputSeq)),
      dt: clamp(num(input.dt, SIM_DT), 0, SIM_DT),
      moveForward: f,
      moveRight: r,
      yaw: wrapAngle(num(input.yaw, p.yaw)),
      pitch: clamp(num(input.pitch, 0), PITCH_MIN, PITCH_MAX),
      sprint: input.sprint === true,
      fire: input.fire === true,
      jump: input.jump === true,
      reload: input.reload === true,
      interact: input.interact === true,
      useHeal: input.useHeal === true,
      selectSlot: slot === 0 || slot === 1 || slot === 2 ? slot : -1,
    };
  }

  private processPlayer(p: SimPlayer, dt: number, prevMs: number, now: number): void {
    const b = this.balance;
    const dtMs = dt * 1000;
    const input = this.dequeue(p);
    p.yaw = input.yaw;
    p.pitch = input.pitch;

    // Timers.
    if (p.swapRemainingMs > 0) {
      p.swapRemainingMs -= dtMs;
      if (p.swapRemainingMs <= TIMER_EPSILON_MS) p.swapRemainingMs = 0;
    }
    if (p.reload) {
      p.reload.remainingMs -= dtMs;
      if (p.reload.remainingMs <= TIMER_EPSILON_MS) this.finishReload(p);
    }
    if (p.heal) {
      p.heal.remainingMs -= dtMs;
      if (p.heal.remainingMs <= TIMER_EPSILON_MS) this.finishHeal(p);
    }

    const dropping = p.move.dropping;
    if (input.selectSlot !== -1) this.selectSlot(p, input.selectSlot);
    if (input.reload && !this.tryStartReload(p)) {
      const slot = activeSlotState(p.inv);
      if (slot && !p.reload && slot.mag < this.balance.weapons[slot.weapon].magSize && p.inv.ammo[ammoFor(this.balance, slot.weapon)] <= 0) {
        this.actionFailed(p, 'reload', 'noAmmo');
      }
    }
    if (input.useHeal) {
      if (p.heal) this.cancelHeal(p);
      else if (!dropping && !this.tryStartHeal(p)) {
        const any = p.inv.heals.bandage + p.inv.heals.medkit > 0;
        this.actionFailed(p, 'heal', any ? 'fullHp' : 'noHeals');
      }
    }
    if (input.interact && !dropping) this.tryPickup(p);
    this.handleFire(p, input, dropping, prevMs, now);

    // Movement.
    const wasDropping = p.move.dropping;
    const mi = toMovementInput(input, { alive: true, healing: p.heal !== null, reloading: p.reload !== null }, b);
    const res = stepMovement(p.move, mi, dt, this.ctx);
    p.move = res.state;
    if (res.landed && !wasDropping && res.landingSpeed > b.movement.fallDamageMinSpeed) {
      const dmg = (res.landingSpeed - b.movement.fallDamageMinSpeed) * b.movement.fallDamagePerMs;
      this.applyEnvDamage(p, dmg, 'fall', { ...p.move.pos });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Weapons, reload, heal, pickup
  // -------------------------------------------------------------------------------------------

  private selectSlot(p: SimPlayer, slot: SlotIndex): void {
    if (slot === p.inv.activeSlot) return;
    if (slot !== 2 && p.inv.slots[slot] === null) return;
    this.cancelReload(p);
    this.cancelHeal(p);
    p.inv.activeSlot = slot;
    p.swapRemainingMs = this.balance.combat.swapMs;
    p.triggerLatched = false;
    this.events.push({ type: 'weaponSwitch', playerId: p.id, weapon: activeWeapon(p.inv), slot });
  }

  private tryStartReload(p: SimPlayer): boolean {
    if (p.reload || p.swapRemainingMs > 0) return false;
    const slot = activeSlotState(p.inv);
    if (!slot) return false;
    const reserve = p.inv.ammo[ammoFor(this.balance, slot.weapon)];
    if (reloadAmount(slot, reserve, this.balance) <= 0) return false;
    this.cancelHeal(p);
    const ms = this.balance.weapons[slot.weapon].reloadMs;
    p.reload = { slot: p.inv.activeSlot as 0 | 1, weapon: slot.weapon, remainingMs: ms, totalMs: ms };
    this.events.push({ type: 'reloadStart', playerId: p.id, weapon: slot.weapon, durationMs: ms });
    return true;
  }

  private finishReload(p: SimPlayer): void {
    const r = p.reload;
    if (!r) return;
    p.reload = null;
    const slot = p.inv.slots[r.slot];
    if (slot && slot.weapon === r.weapon) {
      const ammo = ammoFor(this.balance, slot.weapon);
      const n = reloadAmount(slot, p.inv.ammo[ammo], this.balance);
      slot.mag += n;
      p.inv.ammo[ammo] -= n;
    }
    this.events.push({ type: 'reloadEnd', playerId: p.id, weapon: r.weapon, completed: true });
  }

  private cancelReload(p: SimPlayer): void {
    if (!p.reload) return;
    const w: GunId = p.reload.weapon;
    p.reload = null;
    this.events.push({ type: 'reloadEnd', playerId: p.id, weapon: w, completed: false });
  }

  private tryStartHeal(p: SimPlayer): boolean {
    const item = chooseHeal(p.hp, p.inv.heals, this.balance);
    if (!item) return false;
    this.cancelReload(p);
    const ms = this.balance.items[item].useMs;
    p.heal = { item, remainingMs: ms, totalMs: ms };
    this.events.push({ type: 'healStart', playerId: p.id, item, durationMs: ms });
    return true;
  }

  private finishHeal(p: SimPlayer): void {
    const h = p.heal;
    if (!h) return;
    p.heal = null;
    if (p.inv.heals[h.item] > 0) {
      p.hp = healedHp(p.hp, h.item, this.balance);
      p.inv.heals[h.item]--;
    }
    this.events.push({ type: 'healEnd', playerId: p.id, item: h.item, completed: true, hpAfter: p.hp });
  }

  private cancelHeal(p: SimPlayer): void {
    if (!p.heal) return;
    const item: HealId = p.heal.item;
    p.heal = null;
    this.events.push({ type: 'healEnd', playerId: p.id, item, completed: false, hpAfter: p.hp });
  }

  private cancelActions(p: SimPlayer): void {
    this.cancelReload(p);
    this.cancelHeal(p);
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
    const res = applyPickup(p.inv, p.armor, { item: best.item, qty: best.qty, mag: best.mag }, this.balance);
    if (res.outcome.kind === 'refused') {
      this.actionFailed(p, 'pickup', best.item === 'vest' ? 'betterArmor' : 'inventoryFull');
      return;
    }
    const o = res.outcome;
    p.armor = res.armor;
    if (o.remaining > 0) best.qty = o.remaining;
    else this.loot = this.loot.filter((l) => l !== best);
    this.lootVersion++;
    this.events.push({ type: 'pickup', playerId: p.id, lootId: best.id, item: best.item, qty: o.taken, pos: { ...best.pos } });
    if (o.dropped) {
      this.spawnLootAt({ item: o.dropped.weapon, qty: 1, mag: o.dropped.mag }, pos.x, pos.z, pos.y);
    }
    if (o.activeChanged) {
      this.cancelActions(p);
      p.swapRemainingMs = this.balance.combat.swapMs;
      p.triggerLatched = false;
      this.events.push({ type: 'weaponSwitch', playerId: p.id, weapon: activeWeapon(p.inv), slot: p.inv.activeSlot });
    }
  }

  private spawnLootAt(g: GroundItem, x: number, z: number, feetY: number): LootId {
    const id = this.nextLootId++;
    const y = groundHeightAt(this.ctx, x, z, feetY);
    this.loot.push({ id, item: g.item, qty: g.qty, mag: g.mag, pos: { x, y, z }, tier: 'common' });
    this.lootVersion++;
    return id;
  }

  private dropInventory(p: SimPlayer): void {
    const pos = p.move.pos;
    for (const g of deathDrops(p.inv)) {
      const s = scatterInDisc(pos.x, pos.z, this.balance.combat.deathDropScatter, this.matchRng);
      this.spawnLootAt(g, s.x, s.z, pos.y);
    }
    p.inv = createInventory();
  }

  private handleFire(p: SimPlayer, input: PlayerInput, dropping: boolean, prevMs: number, now: number): void {
    if (input.fire && !p.prevFire) p.triggerLatched = true;
    if (!input.fire) p.triggerLatched = false;
    p.prevFire = input.fire;
    if (!input.fire) return;
    if (p.heal) this.cancelHeal(p);
    if (dropping) return;
    for (let guard = 0; guard < MAX_SHOTS_PER_TICK; guard++) {
      if (p.nextFireAt > now || p.reload || p.swapRemainingMs > 0) return;
      const weapon = activeWeapon(p.inv);
      const wb = this.balance.weapons[weapon];
      if (!wb.automatic && !p.triggerLatched) return;
      const slot = activeSlotState(p.inv);
      if (slot && slot.mag <= 0) {
        this.tryStartReload(p);
        return;
      }
      const shotAt = Math.max(p.nextFireAt, prevMs);
      this.fireShot(p, weapon);
      p.nextFireAt = shotAt + wb.fireIntervalMs;
      p.firingUntil = now + Math.max(wb.fireIntervalMs, ANIM_FIRING_MIN_MS);
      if (!wb.automatic) p.triggerLatched = false;
      if (slot) {
        slot.mag--;
        if (slot.mag <= 0) {
          this.tryStartReload(p);
          return;
        }
      }
    }
  }

  private fireShot(p: SimPlayer, weapon: WeaponId): void {
    const b = this.balance;
    const wb = b.weapons[weapon];
    const eye: Vec3 = { x: p.move.pos.x, y: p.move.pos.y + b.player.eyeHeight, z: p.move.pos.z };
    const aim = aimDirection(p.yaw, p.pitch);
    const half = spreadRad(
      effectiveSpreadDeg(weapon, b, { horizontalSpeed: horizontalSpeed(p.move), airborne: !p.move.grounded }),
    );
    const impacts: ShotImpact[] = [];
    const hits = new Map<PlayerId, { amount: number; headshot: boolean }>();
    const pellets = Math.max(1, Math.floor(wb.pellets));
    for (let i = 0; i < pellets; i++) {
      const d = sampleCone(aim, half, this.combatRng);
      const stat = raycastStatic(this.ctx.colliders, this.map, eye, d, wb.range);
      let maxT = stat ? stat.t : wb.range;
      let victim: SimPlayer | null = null;
      let hitY = 0;
      for (const o of this.participants.values()) {
        if (o === p || !o.alive || o.left || o.dying || o.move.dropping) continue;
        const h = rayCylinder(eye, d, o.move.pos, b.player.radius, b.player.height, maxT);
        if (h && h.t <= maxT) {
          maxT = h.t;
          victim = o;
          hitY = h.y;
        }
      }
      const point = { x: eye.x + d.x * maxT, y: eye.y + d.y * maxT, z: eye.z + d.z * maxT };
      if (victim) {
        const headshot = isHeadshot(hitY, victim.move.pos.y, b);
        const dmg = pelletDamage(wb, maxT, headshot);
        const acc = hits.get(victim.id);
        if (acc) {
          acc.amount += dmg;
          acc.headshot ||= headshot;
        } else hits.set(victim.id, { amount: dmg, headshot });
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
      if (v) this.applyWeaponDamage(v, p, h.amount, h.headshot, weapon, eye);
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

  private applyWeaponDamage(v: SimPlayer, attacker: SimPlayer, amount: number, headshot: boolean, weapon: WeaponId, src: Vec3): void {
    if (!v.alive || v.dying || v.left || v.move.dropping || amount <= 0) return;
    const armorBefore = v.armor;
    const r = applyDamage(v.hp, v.armor, amount, this.balance.armor.absorbFraction);
    v.hp = r.hp;
    v.armor = r.armor;
    if (attacker.id !== v.id) v.lastDamagedBy = { id: attacker.id, at: this._timeMs };
    const lethal = v.hp <= 0;
    if (lethal) v.hp = 0;
    this.events.push({
      type: 'damage',
      victimId: v.id,
      attackerId: attacker.id,
      amount,
      headshot,
      cause: 'weapon',
      sourcePos: { ...src },
      hpAfter: v.hp,
      armorAfter: v.armor,
      armorBefore,
    });
    if (lethal) {
      v.dying = { killerId: attacker.id, weapon, cause: 'weapon', headshot };
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

  /** Zone / fall damage. Ignores armor for fall; zone follows zone.ignoresArmor. */
  private applyEnvDamage(v: SimPlayer, amount: number, cause: DeathCause, src: Vec3): void {
    if (!v.alive || v.dying || v.left || amount <= 0) return;
    const ignoreArmor = cause === 'fall' ? true : this.balance.zone.ignoresArmor;
    const armorBefore = v.armor;
    const r = applyDamage(v.hp, v.armor, amount, this.balance.armor.absorbFraction, ignoreArmor);
    v.hp = r.hp;
    v.armor = r.armor;
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
      armorAfter: v.armor,
      armorBefore,
    });
    if (lethal) {
      const credit = this.creditFor(v);
      if (credit) credit.kills++;
      v.dying = { killerId: credit ? credit.id : null, weapon: null, cause, headshot: false };
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
        if (!p.alive || p.left || p.dying) continue;
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
    const sprinting =
      p.alive && moving && p.move.grounded && !!li && li.sprint && li.moveForward > 0 && !li.fire && p.heal === null;
    return {
      id: p.id,
      name: p.name,
      pos: { ...p.move.pos },
      velY: p.move.vel.y,
      yaw: p.yaw,
      pitch: p.pitch,
      hp: p.hp,
      armor: p.armor,
      alive: p.alive,
      weapon: activeWeapon(p.inv),
      anim: {
        moving: p.alive && moving,
        sprinting,
        airborne: !p.move.grounded,
        dropping: p.move.dropping,
        inWater: isInWater(p.move, b),
        firing: p.alive && this._timeMs < p.firingUntil,
        reloading: p.reload !== null,
        healing: p.heal !== null,
      },
      appearance: { ...p.appearance },
      isBot: p.isBot,
      kills: p.kills,
    };
  }

  private toLocal(p: SimPlayer): LocalPlayerState {
    const inv = p.inv;
    return {
      id: p.id,
      lastProcessedInputSeq: p.lastProcessedInputSeq,
      movement: {
        pos: { ...p.move.pos },
        vel: { ...p.move.vel },
        grounded: p.move.grounded,
        dropping: p.move.dropping,
      },
      slots: [inv.slots[0] ? { ...inv.slots[0] } : null, inv.slots[1] ? { ...inv.slots[1] } : null],
      activeSlot: inv.activeSlot,
      ammo: { ...inv.ammo },
      heals: { ...inv.heals },
      reloadRemainingMs: p.reload ? Math.max(0, p.reload.remainingMs) : 0,
      reloadTotalMs: p.reload ? p.reload.totalMs : 0,
      healRemainingMs: p.heal ? Math.max(0, p.heal.remainingMs) : 0,
      healTotalMs: p.heal ? p.heal.totalMs : 0,
      healItem: p.heal ? p.heal.item : null,
      swapRemainingMs: p.swapRemainingMs,
    };
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
}

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
}

/** Same as createWorld, typed with the test/tool hooks. */
export function createDebugWorld(opts: WorldOptions): DebugWorld {
  return new SimWorld(opts);
}
