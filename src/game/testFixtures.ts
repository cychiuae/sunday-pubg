/**
 * Test-only builders and fakes for src/game unit tests. Not imported by runtime code.
 */
import type { InterpolatedWorld, INetClient, NetHandlers, RoomJoinTarget, RoomSettingsInput, ServerHello } from '../shared/contracts';
import type {
  ConnectionStatus,
  DropStepFields,
  IslandMapData,
  LocalPlayerState,
  MatchState,
  MovementState,
  PlayerId,
  PlayerInput,
  PlayerState,
  SimEvent,
  WelcomeInfo,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import type { InputDriver } from './input/InputController';
import { InputState } from './input/InputState';

/**
 * C-gate: spread into toy MovementStepResult literals (DropStepFields join MovementStepResult at the flip; a spread is not
 * excess-property checked before it).
 */
export const NO_DROP_STEP: DropStepFields = { chuteOpened: null };

/** Drop fields every fixture carries (they become required at the C-gate; Object.assign keeps the pre-gate types). */
const withMoveDrop = (m: Omit<MovementState, 'dropPhase' | 'dropMs'>): MovementState =>
  Object.assign<{ dropPhase: null; dropMs: number }, Omit<MovementState, 'dropPhase' | 'dropMs'>>({ dropPhase: null, dropMs: 0 }, m);

export function makeMovement(overrides: Partial<MovementState> = {}): MovementState {
  return withMoveDrop({
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    grounded: true,
    dropping: false,
    stance: 'stand',
    stanceFrom: 'stand',
    stanceMs: 0,
    adsMs: 0,
    ...overrides,
  });
}

export function makePlayer(id: PlayerId, overrides: Partial<PlayerState> = {}): PlayerState {
  return Object.assign<{ aboard: boolean; dropPhase: null }, Omit<PlayerState, 'aboard' | 'dropPhase'>>({ aboard: false, dropPhase: null }, {
    id,
    name: `p${id}`,
    pos: { x: 0, y: 0, z: 0 },
    velY: 0,
    yaw: 0,
    pitch: 0,
    hp: 100,
    vestTier: 0,
    helmetTier: 0,
    alive: true,
    weapon: 'fists',
    stance: 'stand',
    stanceFrom: 'stand',
    stanceProgress: 1,
    anim: {
      moving: false,
      sprinting: false,
      airborne: false,
      dropping: false,
      inWater: false,
      firing: false,
      reloading: false,
      healing: false,
      ads: false,
      cooking: false,
    },
    appearance: { skin: 0, outfit: 0, hair: 0 },
    isBot: false,
    kills: 0,
    ...overrides,
  });
}

export function makeLocal(id: PlayerId, overrides: Partial<LocalPlayerState> = {}): LocalPlayerState {
  return Object.assign<{ aboard: boolean }, Omit<LocalPlayerState, 'aboard'>>({ aboard: false }, {
    id,
    lastProcessedInputSeq: 0,
    movement: makeMovement(),
    slots: [null, null],
    activeSlot: 2,
    ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0 },
    heals: { bandage: 0, medkit: 0 },
    vest: null,
    helmet: null,
    grenades: 0,
    cookExplodesAt: null,
    throwRecoveryMs: 0,
    reloadRemainingMs: 0,
    reloadTotalMs: 0,
    healRemainingMs: 0,
    healTotalMs: 0,
    healItem: null,
    swapRemainingMs: 0,
    ...overrides,
  });
}

export function makeMatch(overrides: Partial<MatchState> = {}): MatchState {
  return Object.assign<{ mapId: string; route: null; aboardCount: number }, Omit<MatchState, 'mapId' | 'route' | 'aboardCount'>>({ mapId: 'test', route: null, aboardCount: 0 }, {
    matchId: 1,
    phase: 'playing',
    phaseEndsAt: null,
    lobbyCount: 0,
    targetPlayers: 12,
    aliveCount: 2,
    totalPlayers: 2,
    winnerId: null,
    winnerName: null,
    ...overrides,
  });
}

export function makeZone(overrides: Partial<ZoneState> = {}): ZoneState {
  return {
    phaseIndex: 0,
    phaseCount: 6,
    center: { x: 0, z: 0 },
    radius: 100,
    targetCenter: { x: 0, z: 0 },
    targetRadius: 60,
    phaseEndsAt: 60_000,
    shrinking: false,
    dps: 1,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    tick: 1,
    serverTime: 0,
    match: makeMatch(),
    zone: null,
    players: [],
    lootVersion: 1,
    loot: [],
    grenades: [],
    local: null,
    ...overrides,
  };
}

export const TEST_MAP: IslandMapData = {
  kind: 'island',
  carrier: 'seaplane',
  id: 'test',
  nameKey: 'map.test',
  islandRadius: 100,
  worldRadius: 130,
  baseHeight: 2,
  beachWidth: 15,
  shoreNoise: { amplitude: 0, frequency: 1, seed: 1 },
  hills: [],
  props: [],
  playerSpawns: [{ x: 0, z: 0 }],
  lootSpawns: [],
  zoneCenters: [{ x: 0, z: 0 }],
  pois: [],
};

/** Scriptable INetClient: push server messages, inspect sent inputs. */
export class FakeNet implements INetClient {
  handlers: NetHandlers | null = null;
  status: ConnectionStatus = 'idle';
  playerId: PlayerId | null = null;
  rttMs = 0;
  now = 0;
  sent: PlayerInput[] = [];
  connects: { url: string; name: string }[] = [];
  /** Returned by getInterpolated; defaults to the latest snapshot's players. */
  interpolated: PlayerState[] | null = null;
  private latest: WorldSnapshot | null = null;

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers;
  }
  connect(url: string, name: string): void {
    this.connects.push({ url, name });
  }
  disconnect(): void {
    this.status = 'disconnected';
  }
  sendInput(input: PlayerInput): void {
    this.sent.push(input);
  }
  serverNow(): number {
    return this.now;
  }
  getInterpolated(renderTime: number): InterpolatedWorld | null {
    if (!this.latest) return null;
    return { renderTime, players: this.interpolated ?? this.latest.players };
  }
  latestSnapshot(): WorldSnapshot | null {
    return this.latest;
  }

  // Server-side helpers
  pushStatus(status: ConnectionStatus, reason?: string): void {
    this.status = status;
    this.handlers?.onStatus(status, reason);
  }
  pushWelcome(welcome: Partial<WelcomeInfo> & { playerId: PlayerId }): void {
    this.playerId = welcome.playerId;
    this.handlers?.onWelcome({ mapId: TEST_MAP.id, serverTime: this.now, matchId: 1, roomId: 'r1', ...welcome });
  }
  pushSnapshot(snap: WorldSnapshot): void {
    this.latest = snap;
    this.handlers?.onSnapshot(snap);
  }
  pushEvents(events: SimEvent[], serverTime = this.now): void {
    this.handlers?.onEvents(events, serverTime);
  }

  // M2b rooms: every lobby call is recorded as [method, ...args].
  roomCalls: unknown[][] = [];
  listRooms(subscribe: boolean): void {
    this.roomCalls.push(['listRooms', subscribe]);
  }
  createRoom(settings: RoomSettingsInput): void {
    this.roomCalls.push(['createRoom', settings]);
  }
  joinRoom(target: RoomJoinTarget): void {
    this.roomCalls.push(['joinRoom', target]);
  }
  leaveRoom(): void {
    this.roomCalls.push(['leaveRoom']);
  }
  setRoomSettings(patch: Partial<RoomSettingsInput>): void {
    this.roomCalls.push(['setRoomSettings', patch]);
  }
  startMatch(): void {
    this.roomCalls.push(['startMatch']);
  }
  cancelCountdown(): void {
    this.roomCalls.push(['cancelCountdown']);
  }
  setReady(ready: boolean): void {
    this.roomCalls.push(['setReady', ready]);
  }
  vote(option: string | null): void {
    this.roomCalls.push(['vote', option]);
  }
  kick(memberId: number): void {
    this.roomCalls.push(['kick', memberId]);
  }
  pushHello(hello: ServerHello): void {
    this.handlers?.onHello?.(hello);
  }
}

/** Input driver without DOM; `locked` is settable. */
export class FakeInput implements InputDriver {
  locked = true;
  lockRequests = 0;
  disposed = false;
  constructor(readonly state: InputState = new InputState(0.002)) {}
  isLocked(): boolean {
    return this.locked;
  }
  requestLock(): void {
    this.lockRequests++;
  }
  dispose(): void {
    this.disposed = true;
  }
}
