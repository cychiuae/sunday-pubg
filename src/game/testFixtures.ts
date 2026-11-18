/**
 * Test-only builders and fakes for src/game unit tests. Not imported by runtime code.
 */
import type { InterpolatedWorld, INetClient, NetHandlers } from '../shared/contracts';
import type {
  ConnectionStatus,
  LocalPlayerState,
  MapData,
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

export function makeMovement(overrides: Partial<MovementState> = {}): MovementState {
  return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true, dropping: false, ...overrides };
}

export function makePlayer(id: PlayerId, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: `p${id}`,
    pos: { x: 0, y: 0, z: 0 },
    velY: 0,
    yaw: 0,
    pitch: 0,
    hp: 100,
    armor: 0,
    alive: true,
    weapon: 'fists',
    anim: {
      moving: false,
      sprinting: false,
      airborne: false,
      dropping: false,
      inWater: false,
      firing: false,
      reloading: false,
      healing: false,
    },
    appearance: { skin: 0, outfit: 0, hair: 0 },
    isBot: false,
    kills: 0,
    ...overrides,
  };
}

export function makeLocal(id: PlayerId, overrides: Partial<LocalPlayerState> = {}): LocalPlayerState {
  return {
    id,
    lastProcessedInputSeq: 0,
    movement: makeMovement(),
    slots: [null, null],
    activeSlot: 2,
    ammo: { ammo_light: 0, ammo_heavy: 0, ammo_shell: 0 },
    heals: { bandage: 0, medkit: 0 },
    reloadRemainingMs: 0,
    reloadTotalMs: 0,
    healRemainingMs: 0,
    healTotalMs: 0,
    healItem: null,
    swapRemainingMs: 0,
    ...overrides,
  };
}

export function makeMatch(overrides: Partial<MatchState> = {}): MatchState {
  return {
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
  };
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
    local: null,
    ...overrides,
  };
}

export const TEST_MAP: MapData = {
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
    this.handlers?.onWelcome({ mapId: TEST_MAP.id, serverTime: this.now, matchId: 1, ...welcome });
  }
  pushSnapshot(snap: WorldSnapshot): void {
    this.latest = snap;
    this.handlers?.onSnapshot(snap);
  }
  pushEvents(events: SimEvent[]): void {
    this.handlers?.onEvents(events, this.now);
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
