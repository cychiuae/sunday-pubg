/**
 * One room (ADR 0006, NETCODE.md "Rooms"): members, host, settings, ready flags and votes, the room-owned countdown
 * and map lock, and during a match one World with its fixed-step tick loop, the per-member input jitter buffer, and
 * the snapshot and event broadcast (the M1 Room match path, moved without behaviour changes).
 *
 * Lifecycle (ADR 0006 §2):
 *   waiting --Start / all ready / public timer--> countdown (no World; vote open)
 *   countdown --host Cancel, or below the start minimum, before the lock--> waiting
 *   countdown --lockAt--> LOCK: resolveMapChoice -> balanceForMap -> prepareMap (cached) -> createWorld(matchStart)
 *             -> addPlayer(each member) -> welcome
 *   World countdown -> playing -> results -> finished --> the room drops the World --> waiting
 */
import type { RoomsBalance } from '../src/shared/balance';
import { createRng, type Rng } from '../src/shared/math';
import { SnapshotDeltaEncoder } from '../src/shared/protocol/delta';
import {
  encodeQuantized as encode,
  privateEventRecipient,
  quantizeDeep,
  type ServerMessage,
} from '../src/shared/protocol/messages';
import type { MapChoice, MapChoiceInput } from '../src/shared/sim/mapVote';
import type { MapRuntime } from '../src/shared/sim/movement';
import { MAX_QUEUED_INPUTS } from '../src/shared/constants';
import type {
  MapId,
  MapVoteOption,
  MatchPhase,
  MemberId,
  PlayerId,
  PlayerInput,
  RejectCode,
  RoomId,
  RoomMember,
  RoomPhase,
  RoomSettings,
  RoomState,
  RoomSummary,
  SimEvent,
} from '../src/shared/types';
import { CLOSE, EDGE, ROOM_TIMING, mixSeed, type Balance, type Logger, type SimMap, type SimWorld, type WorldFactory } from './common';
import type { Session } from './Session';
import { mergeInputs, sanitizeInput, sanitizeRoomName } from './validate';

/** What every room shares (the manager builds it once). */
export interface MatchDeps {
  createWorld: WorldFactory;
  getMap(id: MapId): SimMap;
  /** Every map id, in display and rotation order. */
  maps: readonly MapId[];
  /** Server `MAP` pin (already validated), else null. */
  pin: MapId | null;
  /** Effective balance and cached runtime for a map id (RoomManager caches one per map id). */
  prepared(mapId: MapId): { balance: Balance; runtime?: MapRuntime };
  resolveMapChoice(i: MapChoiceInput): MapChoice;
  botNames: readonly string[];
  /** `WorldOptions.drop` (tests pass false for the M1 spawn). Default: the sim's default (true). */
  worldDrop?: boolean;
}

export interface GameRoomOptions {
  id: RoomId;
  code: string;
  seed: number;
  settings: RoomSettings;
  /** Base balance (the per-map one comes from MatchDeps.prepared). */
  balance: Balance;
  rooms: RoomsBalance;
  /** match.mapVoteLockSeconds (resolved with its fallback). */
  lockSeconds: number;
  deps: MatchDeps;
  simHz: number;
  snapshotHz: number;
  /** Monotonic wall ms (tick loop, rate limits). */
  now: () => number;
  /** Server clock ms (shared by every room; RoomState times, joinedAt, World time origin). */
  clock: () => number;
  log: Logger;
  /** The room asks its owner to remove a member (kick). The owner calls `removeMember` and moves the session. */
  evict(session: Session, reason: 'kicked'): void;
}

interface Seat {
  playerId: PlayerId | null;
  spectator: boolean;
  lastSeq: number;
  /** Validated inputs not yet forwarded to the World (jitter buffer; one per tick). */
  inputQ: PlayerInput[];
  /** Smallest queue depth seen in the current drain window. */
  minDepth: number;
  windowTicks: number;
  /** A drained input whose edge presses are folded into the next arriving input. */
  carry: PlayerInput | null;
  /** Snapshot wire format and delta base (new for every World, so the first snapshot of a match is full). */
  enc: SnapshotDeltaEncoder;
  resyncs: number;
  rejectedInputs: number;
  mergedInputs: number;
  skippedSnapshots: number;
}

interface Member {
  readonly memberId: MemberId;
  readonly session: Session;
  readonly name: string;
  readonly token: string;
  readonly joinedAt: number;
  ready: boolean;
  vote: MapVoteOption | null;
  seat: Seat | null;
}

export interface SeatStats {
  memberId: MemberId;
  playerId: PlayerId | null;
  spectator: boolean;
  deltas: boolean;
  resyncs: number;
  queued: number;
  rejectedInputs: number;
  mergedInputs: number;
  skippedSnapshots: number;
}

export interface GameRoomStats {
  id: RoomId;
  phase: RoomPhase;
  humans: number;
  visibility: RoomSettings['visibility'];
  matchId: number | null;
  mapId: MapId | null;
  tick: number;
  /** Tick cost (World step + inputs + snapshot and event encoding) over the room's matches, and its worst. */
  avgTickMs: number;
  maxTickMs: number;
  /** The same over the current (or last) match only. */
  matchAvgTickMs: number;
  matchMaxTickMs: number;
  ticks: number;
  droppedTicks: number;
  bytesOut: number;
}

/** Drops the oldest queued input, folding its edge buttons into the next one. */
function mergeOldest(q: PlayerInput[]): void {
  const oldest = q.shift();
  const next = q[0];
  if (oldest && next) q[0] = mergeInputs(oldest, next);
}

/**
 * Validates a settings patch against `base` (ADR 0006 §6, rooms.md). Returns the new settings, or null for
 * `bad_settings`. `memberCount`: maxHumans may not go below it.
 */
export function applySettings(
  base: RoomSettings,
  patch: Partial<RoomSettings>,
  rooms: RoomsBalance,
  maps: readonly MapId[],
  memberCount: number,
): RoomSettings | null {
  const out: RoomSettings = { ...base };
  if (patch.name !== undefined) out.name = sanitizeRoomName(patch.name, rooms.nameMaxLength);
  if (patch.visibility !== undefined) out.visibility = patch.visibility;
  if (patch.mapMode !== undefined) {
    if (patch.mapMode !== 'vote' && !maps.includes(patch.mapMode)) return null;
    out.mapMode = patch.mapMode;
  }
  if (patch.maxHumans !== undefined) {
    const n = patch.maxHumans;
    if (!Number.isInteger(n) || n < rooms.minMaxHumans || n > rooms.maxMaxHumans || n < memberCount) return null;
    out.maxHumans = n;
  }
  if (patch.fillBots !== undefined) out.fillBots = patch.fillBots;
  return out;
}

export class GameRoom {
  readonly id: RoomId;
  readonly code: string;
  readonly seed: number;
  settings: RoomSettings;
  private readonly members = new Map<MemberId, Member>();
  private nextMemberId = 1;
  hostId: MemberId = 0;
  phase: RoomPhase = 'waiting';
  phaseSince: number;
  private countdownEndsAt: number | null = null;
  private lockAt: number | null = null;
  /** Server ms when the public auto-start timer began (null = not running). */
  private publicTimerSince: number | null = null;
  private pick: { id: MapId; via: MapChoice['via'] } | null = null;
  private previousMap: MapId | null = null;
  private matchSerial = 0;
  private readonly rng: Rng;
  /** client token -> server ms until which it may not rejoin (ADR 0006 §5). */
  private readonly kickBlocks = new Map<string, number>();

  // Match (null between matches).
  world: SimWorld | null = null;
  private sawResults = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private acc = 0;
  private lastLoopWall = 0;
  private lastTickWall = 0;
  private lastSnapIdx = -1;
  private readonly simDt: number;
  private readonly dtMs: number;

  // Broadcast coalescing.
  private dirty = false;
  private lastRoomSendAt = Number.NEGATIVE_INFINITY;

  // Stats.
  private tickMsSum = 0;
  private tickCount = 0;
  private maxTickMs = 0;
  private matchTickMsSum = 0;
  private matchTickCount = 0;
  private matchMaxTickMs = 0;
  private droppedTicks = 0;
  private bytesOut = 0;
  private errorCount = 0;
  closed = false;

  constructor(private readonly opts: GameRoomOptions) {
    this.id = opts.id;
    this.code = opts.code;
    this.seed = opts.seed;
    this.settings = { ...opts.settings };
    this.phaseSince = opts.clock();
    this.rng = createRng(opts.seed);
    this.simDt = 1 / opts.simHz;
    this.dtMs = 1000 / opts.simHz;
  }

  // -------------------------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------------------------
  get humans(): number {
    return this.members.size;
  }

  hasMember(session: Session): boolean {
    return session.memberId !== null && this.members.get(session.memberId)?.session === session;
  }

  /** Why `token` may not join now, or null. */
  joinBlock(token: string): RejectCode | null {
    const until = this.kickBlocks.get(token);
    if (until !== undefined) {
      if (this.opts.clock() < until) return 'kicked';
      this.kickBlocks.delete(token);
    }
    if (this.members.size >= this.settings.maxHumans) return 'room_full';
    return null;
  }

  /** Adds a member (the caller checked joinBlock). The first member is the host. Returns the new memberId. */
  addMember(session: Session, rid?: number): MemberId {
    const memberId = this.nextMemberId++;
    const m: Member = {
      memberId,
      session,
      name: session.name,
      token: session.token,
      joinedAt: this.opts.clock(),
      ready: false,
      vote: null,
      seat: null,
    };
    this.members.set(memberId, m);
    if (this.members.size === 1) this.hostId = memberId;
    session.memberId = memberId;
    session.room = this;
    // Mid-match join (ADR 0006 §2): after the lock and before 'playing' they are participants; later they spectate.
    if (this.world) this.seatMember(m);
    session.send({ t: 'roomJoined', ...(rid !== undefined ? { rid } : {}), room: this.buildState(), memberId });
    if (this.world && m.seat) this.sendWelcome(m);
    this.evaluate();
    this.markDirty();
    return memberId;
  }

  /** Removes a member (leave, kick, disconnect). Returns the number of members left (0 = the owner closes the room). */
  removeMember(session: Session): number {
    const id = session.memberId;
    const m = id !== null ? this.members.get(id) : undefined;
    if (!m || m.session !== session) return this.members.size;
    this.members.delete(m.memberId);
    if (m.seat && m.seat.playerId !== null && this.world) {
      const pid = m.seat.playerId;
      this.guard('removePlayer', () => this.world?.removePlayer(pid));
    }
    m.seat = null;
    session.memberId = null;
    session.room = null;
    if (this.members.size === 0) return 0;
    if (this.hostId === m.memberId) this.migrateHost();
    this.evaluate();
    this.markDirty();
    return this.members.size;
  }

  /** Host migration (ADR 0006 §4): the oldest remaining member by joinedAt, ties by the lower memberId. */
  private migrateHost(): void {
    let best: Member | null = null;
    for (const m of this.members.values()) {
      if (!best || m.joinedAt < best.joinedAt || (m.joinedAt === best.joinedAt && m.memberId < best.memberId)) best = m;
    }
    if (best) {
      this.hostId = best.memberId;
      best.ready = false; // the host has no ready tick
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lobby requests (the manager checked rate limits and that the session is a member)
  // -------------------------------------------------------------------------------------------
  private member(session: Session): Member | null {
    const id = session.memberId;
    const m = id !== null ? this.members.get(id) : undefined;
    return m && m.session === session ? m : null;
  }

  setSettings(session: Session, patch: Partial<RoomSettings>): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (m.memberId !== this.hostId) return 'not_host';
    if (this.phase !== 'waiting') return 'bad_state';
    const next = applySettings(this.settings, patch, this.opts.rooms, this.opts.deps.maps, this.members.size);
    if (!next) return 'bad_settings';
    this.settings = next;
    this.evaluate();
    this.markDirty();
    return null;
  }

  startMatch(session: Session): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (m.memberId !== this.hostId) return 'not_host';
    if (this.phase !== 'waiting') return 'bad_state';
    if (this.members.size < this.startMinimum()) return 'too_few_humans';
    this.beginCountdown();
    return null;
  }

  cancelCountdown(session: Session): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (m.memberId !== this.hostId) return 'not_host';
    if (this.phase !== 'countdown' || this.world !== null) return 'bad_state';
    this.cancel();
    return null;
  }

  setReady(session: Session, ready: boolean): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (this.phase !== 'waiting') return 'bad_state';
    if (m.memberId === this.hostId) return null; // the host counts as ready and has no tick
    if (m.ready !== ready) {
      m.ready = ready;
      this.evaluate();
      this.markDirty();
    }
    return null;
  }

  /** Votes are accepted in any phase (after the lock they count for the next match, maps.md 1.3). */
  vote(session: Session, choice: MapVoteOption | null): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (!this.voteOpen()) return 'bad_state';
    if (choice !== null && choice !== 'random' && !this.opts.deps.maps.includes(choice)) return 'bad_settings';
    if (m.vote !== choice) {
      m.vote = choice;
      this.markDirty();
    }
    return null;
  }

  kick(session: Session, target: MemberId): RejectCode | null {
    const m = this.member(session);
    if (!m) return 'not_in_room';
    if (m.memberId !== this.hostId) return 'not_host';
    if (target === m.memberId) return 'bad_state';
    const t = this.members.get(target);
    if (!t) return 'bad_state';
    this.kickBlocks.set(t.token, this.opts.clock() + this.opts.rooms.kickRejoinBlockSeconds * 1000);
    this.opts.evict(t.session, 'kicked');
    return null;
  }

  private voteOpen(): boolean {
    return this.settings.mapMode === 'vote' && this.opts.deps.pin === null;
  }

  private startMinimum(): number {
    const r = this.opts.rooms;
    return this.settings.fillBots ? r.minHumansToStartWithBots : r.minHumansToStartWithoutBots;
  }

  // -------------------------------------------------------------------------------------------
  // Countdown, auto-start and the lock
  // -------------------------------------------------------------------------------------------
  private beginCountdown(): void {
    const now = this.opts.clock();
    const total = this.opts.balance.match.countdownSeconds * 1000;
    const lock = Math.min(this.opts.lockSeconds * 1000, total);
    this.phase = 'countdown';
    this.phaseSince = now;
    this.countdownEndsAt = now + total;
    this.lockAt = this.countdownEndsAt - lock;
    this.publicTimerSince = null;
    this.markDirty(true);
    if (now >= this.lockAt) this.lock();
  }

  private cancel(): void {
    this.phase = 'waiting';
    this.phaseSince = this.opts.clock();
    this.countdownEndsAt = null;
    this.lockAt = null;
    this.publicTimerSince = null; // restarts from full on the next evaluation
    this.evaluate();
    this.markDirty(true);
  }

  /**
   * Re-checks the rules that depend on membership and time: the all-ready and public auto-starts in `waiting`,
   * the start minimum and the lock in a pre-lock `countdown`.
   */
  evaluate(): void {
    if (this.closed) return;
    const now = this.opts.clock();
    const r = this.opts.rooms;
    const humans = this.members.size;
    if (this.phase === 'waiting') {
      const enough = humans >= this.startMinimum();
      // 1. All ready (the host counts as ready).
      if (enough && humans >= r.autoStartAllReadyMinHumans) {
        let all = true;
        for (const m of this.members.values()) if (m.memberId !== this.hostId && !m.ready) all = false;
        if (all) {
          this.beginCountdown();
          return;
        }
      }
      // 2. Public timer.
      if (this.settings.visibility === 'public' && humans >= r.publicAutoStartMinHumans) {
        if (this.publicTimerSince === null) {
          this.publicTimerSince = now;
          this.markDirty();
        }
        if (enough && now >= this.publicTimerSince + r.publicAutoStartSeconds * 1000) this.beginCountdown();
      } else if (this.publicTimerSince !== null) {
        this.publicTimerSince = null;
        this.markDirty();
      }
      return;
    }
    if (this.phase === 'countdown' && this.world === null) {
      if (humans < this.startMinimum()) {
        this.cancel();
        return;
      }
      if (this.lockAt !== null && now >= this.lockAt) this.lock();
    }
  }

  /** The map lock (ADR 0006 §2): resolve the map and create this match's World. */
  private lock(): void {
    const deps = this.opts.deps;
    const choice = deps.resolveMapChoice({
      pin: deps.pin,
      mode: this.settings.mapMode,
      votes: [...this.members.values()].map((m) => m.vote),
      maps: deps.maps,
      previous: this.previousMap,
      rng: this.rng,
    });
    const now = this.opts.clock();
    const serial = ++this.matchSerial;
    let world: SimWorld | null = null;
    try {
      const { balance, runtime } = deps.prepared(choice.mapId);
      world = deps.createWorld({
        map: deps.getMap(choice.mapId),
        balance,
        seed: mixSeed(this.seed, serial),
        botNames: deps.botNames,
        ...(runtime ? { runtime } : {}),
        ...(deps.worldDrop !== undefined ? { drop: deps.worldDrop } : {}),
        timeOriginMs: now,
        matchStart: {
          countdownMs: Math.max(0, (this.countdownEndsAt ?? now) - now),
          fillBots: this.settings.fillBots,
          matchId: serial,
        },
      });
    } catch (err) {
      this.opts.log.error(`[room ${this.id}] could not create the World for "${choice.mapId}"; back to waiting`, err);
      this.cancel();
      return;
    }
    this.world = world;
    this.sawResults = false;
    this.pick = { id: choice.mapId, via: choice.via };
    this.previousMap = choice.mapId;
    this.lastSnapIdx = -1;
    this.matchTickMsSum = 0;
    this.matchTickCount = 0;
    this.matchMaxTickMs = 0;
    for (const m of this.members.values()) this.seatMember(m);
    this.opts.log.info(`[room ${this.id}] match ${serial} locked on ${choice.mapId} (${choice.via}), ${this.members.size} humans`);
    this.markDirty(true);
    for (const m of this.members.values()) if (m.seat) this.sendWelcome(m);
    this.startLoop();
  }

  private seatMember(m: Member): void {
    const world = this.world;
    if (!world) return;
    const phase = world.getMatch().phase;
    const id = this.guard('addPlayer', () => world.addPlayer(m.name)) ?? null;
    if (id === null) this.opts.log.warn(`[room ${this.id}] World refused member ${m.memberId}; spectating without an id`);
    m.seat = {
      playerId: id,
      spectator: phase === 'playing' || phase === 'results' || id === null,
      lastSeq: 0,
      inputQ: [],
      minDepth: Number.POSITIVE_INFINITY,
      windowTicks: 0,
      carry: null,
      enc: new SnapshotDeltaEncoder(m.session.deltas),
      resyncs: 0,
      rejectedInputs: 0,
      mergedInputs: 0,
      skippedSnapshots: 0,
    };
  }

  private sendWelcome(m: Member): void {
    const world = this.world;
    if (!world || !m.seat || !this.pick) return;
    m.session.send({
      t: 'welcome',
      welcome: {
        playerId: m.seat.playerId ?? -1,
        mapId: this.pick.id,
        serverTime: this.serverNow(),
        matchId: this.matchSerial,
        roomId: this.id,
      },
    });
  }

  /** The World reported the end of results: drop it and return everyone to the waiting room. */
  private endMatch(): void {
    this.stopLoop();
    this.world = null;
    this.pick = null;
    this.countdownEndsAt = null;
    this.lockAt = null;
    for (const m of this.members.values()) {
      m.seat = null;
      m.ready = false; // ready ticks reset; votes persist (ADR 0006 §4)
    }
    this.phase = 'waiting';
    this.phaseSince = this.opts.clock();
    this.publicTimerSince = null;
    this.opts.log.info(`[room ${this.id}] match ${this.matchSerial} over; back to waiting`);
    this.markDirty(true);
    this.evaluate();
  }

  // -------------------------------------------------------------------------------------------
  // Match traffic
  // -------------------------------------------------------------------------------------------
  /** A rate-limited input from a member. Ignored outside a World (a stale input after the match is not a bad frame). */
  onInput(session: Session, input: PlayerInput): void {
    const m = this.member(session);
    const seat = m?.seat;
    if (!seat || seat.playerId === null || !this.world) return;
    const clean = sanitizeInput(input, seat.lastSeq);
    if (!clean) {
      seat.rejectedInputs++;
      return;
    }
    seat.lastSeq = clean.seq;
    const merged = seat.carry ? mergeInputs(seat.carry, clean) : clean;
    seat.carry = null;
    seat.inputQ.push(merged);
    while (seat.inputQ.length > MAX_QUEUED_INPUTS) {
      mergeOldest(seat.inputQ);
      seat.mergedInputs++;
    }
  }

  /** A delta client could not apply a snapshot: the next one is full. */
  onResync(session: Session): boolean {
    const seat = this.member(session)?.seat;
    if (!seat || !seat.enc.deltas) return false;
    seat.resyncs++;
    seat.enc.reset();
    return true;
  }

  /** Server clock now: during a match, the World's time plus wall time since its last tick; else the shared clock. */
  serverNow(): number {
    if (!this.world) return this.opts.clock();
    const since = Math.min(Math.max(0, this.opts.now() - this.lastTickWall), this.dtMs * EDGE.maxCatchUpTicks);
    return this.world.timeMs + since;
  }

  private startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.acc = 0;
    this.lastLoopWall = this.opts.now();
    this.lastTickWall = this.lastLoopWall;
    this.schedule();
  }

  private stopLoop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(this.loop, Math.max(1, this.dtMs - this.acc));
  }

  /** Self-correcting fixed-step loop (one per room, ADR 0006 §1): at most 4 catch-up ticks, then drop the time. */
  private readonly loop = (): void => {
    const now = this.opts.now();
    this.acc += now - this.lastLoopWall;
    this.lastLoopWall = now;
    let steps = 0;
    while (this.running && this.acc >= this.dtMs && steps < EDGE.maxCatchUpTicks) {
      this.tickOnce();
      this.acc -= this.dtMs;
      steps++;
    }
    if (this.acc >= this.dtMs) {
      this.droppedTicks += Math.floor(this.acc / this.dtMs);
      this.acc = 0;
    }
    if (steps > 0) this.lastTickWall = now - this.acc;
    this.schedule();
  };

  /** One authoritative tick. Public for deterministic tests; the loop calls it at simHz. No-op without a World. */
  tickOnce(): void {
    const world = this.world;
    if (!world) return;
    const t0 = this.opts.now();
    // 1. Forward one validated input per player (the World consumes one per step).
    for (const m of this.members.values()) {
      const c = m.seat;
      if (!c || c.playerId === null) continue;
      const id = c.playerId;
      const q = c.inputQ;
      const input = q.shift();
      if (input) this.guard('applyInput', () => world.applyInput(id, input));
      if (q.length < c.minDepth) c.minDepth = q.length;
      if (++c.windowTicks >= EDGE.inputDrainWindowTicks) {
        for (let i = 0; i < c.minDepth && q.length > 0; i++) {
          if (q.length > 1) mergeOldest(q);
          else {
            const last = q.shift() as PlayerInput;
            c.carry = c.carry ? mergeInputs(c.carry, last) : last;
          }
          c.mergedInputs++;
        }
        c.minDepth = Number.POSITIVE_INFINITY;
        c.windowTicks = 0;
      }
    }
    // 2. Step the world and broadcast this tick's events as one batch.
    const events = this.guard('step', () => world.step(this.simDt)) ?? [];
    if (events.length > 0) this.broadcastEvents(world, events);
    // 3. Snapshots on 2 of every 3 ticks (snapshotHz / simHz).
    const snapIdx = Math.floor((world.tick * this.opts.snapshotHz) / this.opts.simHz);
    if (snapIdx !== this.lastSnapIdx) {
      this.lastSnapIdx = snapIdx;
      for (const m of this.members.values()) if (m.seat) this.sendSnapshot(world, m);
    }
    if (!this.running) this.lastTickWall = this.opts.now();

    const ms = this.opts.now() - t0;
    this.tickMsSum += ms;
    this.tickCount++;
    if (ms > this.maxTickMs) this.maxTickMs = ms;
    this.matchTickMsSum += ms;
    this.matchTickCount++;
    if (ms > this.matchMaxTickMs) this.matchMaxTickMs = ms;

    // 4. Room phase follows the World; drop it once finished.
    this.followWorld(world);
  }

  private followWorld(world: SimWorld): void {
    const wp: MatchPhase = world.getMatch().phase;
    if (wp === 'results') this.sawResults = true;
    // `finished` is the contract; a World back in 'lobby' after results is treated the same (defensive).
    if (world.finished === true || (this.sawResults && wp === 'lobby')) {
      this.endMatch();
      return;
    }
    const next: RoomPhase = wp === 'playing' ? 'playing' : wp === 'results' ? 'results' : 'countdown';
    if (next !== this.phase) {
      this.phase = next;
      this.phaseSince = this.opts.clock();
      if (next === 'playing' || next === 'results') {
        this.countdownEndsAt = null;
        this.lockAt = null;
      }
      this.markDirty(true);
    }
  }

  /**
   * One `events` frame per tick per seated member. Public events are encoded once and shared. Private events
   * (`actionFailed`) go only to their own player, in order, inside that player's frame.
   */
  private broadcastEvents(world: SimWorld, events: SimEvent[]): void {
    const tick = world.tick;
    const serverTime = world.timeMs;
    let owners: Set<PlayerId> | null = null;
    for (const ev of events) {
      const to = privateEventRecipient(ev);
      if (to !== null) (owners ??= new Set()).add(to);
    }
    const publicEvents = owners ? events.filter((ev) => privateEventRecipient(ev) === null) : events;
    const shared = publicEvents.length > 0 ? encode({ t: 'events', tick, serverTime, events: publicEvents }) : null;
    for (const m of this.members.values()) {
      if (!m.seat) continue;
      const id = m.seat.playerId;
      if (id !== null && owners?.has(id)) {
        const own = events.filter((ev) => {
          const to = privateEventRecipient(ev);
          return to === null || to === id;
        });
        this.sendRaw(m, encode({ t: 'events', tick, serverTime, events: own }));
      } else if (shared !== null) {
        this.sendRaw(m, shared);
      }
    }
  }

  private sendSnapshot(world: SimWorld, m: Member): void {
    const s = m.session;
    const seat = m.seat;
    if (!seat || s.closing || s.closed || s.socket.readyState !== 1) return;
    if (s.socket.bufferedAmount > EDGE.terminateBytes) {
      this.opts.log.warn(`[room ${this.id}] ${s.label} stalled (${s.socket.bufferedAmount} B buffered); closing`);
      s.closeConn(CLOSE.policy, 'stalled');
      return;
    }
    if (s.socket.bufferedAmount > EDGE.snapshotSkipBytes) {
      seat.skippedSnapshots++;
      return;
    }
    const id = seat.playerId;
    // Quantize before diffing so the delta base holds exactly what the client decodes.
    const full = this.guard('snapshotFor', () => quantizeDeep(world.snapshotFor(id)));
    if (!full) return;
    this.sendRaw(m, encode({ t: 'snapshot', snap: seat.enc.encode(full) }));
  }

  private sendRaw(m: Member, data: string): void {
    m.session.sendRaw(data);
    this.bytesOut += data.length;
  }

  // -------------------------------------------------------------------------------------------
  // State, broadcast, housekeeping
  // -------------------------------------------------------------------------------------------
  /** Marks the room state changed. `force` sends now (phase changes, the lock); otherwise at most 5/s. */
  markDirty(force = false): void {
    this.dirty = true;
    if (force || this.opts.now() - this.lastRoomSendAt >= ROOM_TIMING.roomBroadcastMinMs) this.flushRoom();
  }

  /** Called by the manager every ROOM_TIMING.pollMs. */
  poll(): void {
    if (this.closed) return;
    this.evaluate();
    if (this.dirty && this.opts.now() - this.lastRoomSendAt >= ROOM_TIMING.roomBroadcastMinMs) this.flushRoom();
  }

  private flushRoom(): void {
    if (this.closed || this.members.size === 0) {
      this.dirty = false;
      return;
    }
    this.dirty = false;
    this.lastRoomSendAt = this.opts.now();
    const data = encode({ t: 'room', room: this.buildState() } satisfies ServerMessage);
    for (const m of this.members.values()) this.sendRaw(m, data);
  }

  private hostName(): string {
    return this.members.get(this.hostId)?.name ?? '';
  }

  buildState(): RoomState {
    const r = this.opts.rooms;
    const members: RoomMember[] = [];
    for (const m of this.members.values()) {
      members.push({
        memberId: m.memberId,
        name: m.name,
        ready: m.memberId === this.hostId ? false : m.ready,
        vote: m.vote,
        status: m.seat ? (m.seat.spectator ? 'spectating' : 'playing') : 'waiting',
        joinedAt: m.joinedAt,
      });
    }
    let votes: RoomState['votes'] = null;
    if (this.voteOpen()) {
      const options: MapVoteOption[] = [...this.opts.deps.maps, 'random'];
      votes = options.map((option) => ({ option, count: 0 }));
      for (const m of this.members.values()) {
        const k = m.vote === null ? -1 : options.indexOf(m.vote);
        if (k >= 0) votes[k]!.count++;
      }
    }
    const timerAt =
      this.phase === 'waiting' && this.publicTimerSince !== null
        ? this.publicTimerSince + r.publicAutoStartSeconds * 1000
        : null;
    return {
      id: this.id,
      code: this.code,
      settings: { ...this.settings },
      hostId: this.hostId,
      hostName: this.hostName(),
      members,
      phase: this.phase,
      phaseSince: this.phaseSince,
      pinnedMap: this.opts.deps.pin,
      map: this.pick ? { ...this.pick } : null,
      countdownEndsAt: this.phase === 'countdown' ? this.countdownEndsAt : null,
      lockAt: this.phase === 'countdown' ? this.lockAt : null,
      autoStart: timerAt !== null ? { reason: 'timer', at: timerAt } : null,
      votes,
      botSeats: this.settings.fillBots ? Math.max(0, this.opts.balance.match.targetPlayers - this.members.size) : 0,
      matchId: this.world ? this.matchSerial : null,
    };
  }

  summary(): RoomSummary {
    return {
      id: this.id,
      name: this.settings.name,
      hostName: this.hostName(),
      mapMode: this.settings.mapMode,
      mapId: this.pick?.id ?? null,
      humans: this.members.size,
      maxHumans: this.settings.maxHumans,
      phase: this.phase,
      phaseSince: this.phaseSince,
    };
  }

  /** Every member's session (shutdown, tests). */
  sessions(): Session[] {
    return [...this.members.values()].map((m) => m.session);
  }

  /** Stops the World and the loop. The owner has already removed (or will drop) the members. */
  dispose(): void {
    this.closed = true;
    this.stopLoop();
    this.world = null;
  }

  seatStats(session: Session): SeatStats | null {
    const m = this.member(session);
    if (!m || !m.seat) return null;
    const s = m.seat;
    return {
      memberId: m.memberId,
      playerId: s.playerId,
      spectator: s.spectator,
      deltas: s.enc.deltas,
      resyncs: s.resyncs,
      queued: s.inputQ.length,
      rejectedInputs: s.rejectedInputs,
      mergedInputs: s.mergedInputs,
      skippedSnapshots: s.skippedSnapshots,
    };
  }

  stats(): GameRoomStats {
    return {
      id: this.id,
      phase: this.phase,
      humans: this.members.size,
      visibility: this.settings.visibility,
      matchId: this.world ? this.matchSerial : null,
      mapId: this.pick?.id ?? null,
      tick: this.world?.tick ?? 0,
      avgTickMs: this.tickCount > 0 ? this.tickMsSum / this.tickCount : 0,
      maxTickMs: this.maxTickMs,
      matchAvgTickMs: this.matchTickCount > 0 ? this.matchTickMsSum / this.matchTickCount : 0,
      matchMaxTickMs: this.matchMaxTickMs,
      ticks: this.tickCount,
      droppedTicks: this.droppedTicks,
      bytesOut: this.bytesOut,
    };
  }

  /** Runs `fn`, logging (rate-limited) instead of throwing. A bad sim tick or handler must not kill the room. */
  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= 20 || this.errorCount % 500 === 0) {
        this.opts.log.error(`[room ${this.id}] ${what} failed (error #${this.errorCount})`, err);
      }
      return undefined;
    }
  }
}

