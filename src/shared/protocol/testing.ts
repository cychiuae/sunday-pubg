/**
 * Test fixtures for protocol/net/server tests (not used by runtime code).
 */
import type {
  DropMovementFields,
  GrenadeState,
  LocalDropFields,
  LocalPlayerState,
  MatchMapFields,
  MatchState,
  PlayerDropFields,
  PlayerInput,
  PlayerState,
  WorldSnapshot,
} from '../types';

export function makeInput(over: Partial<PlayerInput> = {}): PlayerInput {
  return {
    seq: 1,
    dt: 1 / 30,
    moveForward: 0,
    moveRight: 0,
    yaw: 0,
    pitch: 0,
    sprint: false,
    fire: false,
    ads: false,
    jump: false,
    reload: false,
    interact: false,
    useHeal: false,
    selectSlot: -1,
    stanceToggle: null,
    ...over,
  };
}

// M2b: the fixtures carry the C-gate drop fields already (typed through the field blocks so they compile before and
// after the gate merges them into the target types).
export function makePlayer(id: number, over: Partial<PlayerState & PlayerDropFields> = {}): PlayerState {
  const p: PlayerState & PlayerDropFields = {
    id,
    name: `P${id}`,
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
    appearance: { skin: 0, outfit: 1, hair: 2 },
    isBot: false,
    kills: 0,
    aboard: false,
    dropPhase: null,
    ...over,
  };
  return p;
}

export function makeMatch(over: Partial<MatchState & MatchMapFields> = {}): MatchState {
  const m: MatchState & MatchMapFields = {
    matchId: 1,
    phase: 'playing',
    phaseEndsAt: null,
    lobbyCount: 0,
    targetPlayers: 12,
    aliveCount: 2,
    totalPlayers: 2,
    winnerId: null,
    winnerName: null,
    mapId: 'island01',
    route: null,
    aboardCount: 0,
    ...over,
  };
  return m;
}

export function makeLocal(id: number, over: Partial<LocalPlayerState & LocalDropFields> = {}): LocalPlayerState {
  const movement: LocalPlayerState['movement'] & DropMovementFields = {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    grounded: true,
    dropping: false,
    stance: 'stand',
    stanceFrom: 'stand',
    stanceMs: 0,
    adsMs: 0,
    dropPhase: null,
    dropMs: 0,
  };
  const l: LocalPlayerState & LocalDropFields = {
    id,
    lastProcessedInputSeq: 0,
    movement,
    slots: [{ weapon: 'pistol', mag: 12 }, null],
    activeSlot: 0,
    ammo: { ammo_light: 30, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0 },
    heals: { bandage: 1, medkit: 0 },
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
    aboard: false,
    ...over,
  };
  return l;
}

export function makeSnapshot(tick: number, players: PlayerState[], over: Partial<WorldSnapshot> = {}): WorldSnapshot {
  return {
    tick,
    serverTime: (tick * 1000) / 30,
    match: makeMatch(),
    zone: null,
    players,
    lootVersion: 1,
    loot: [{ id: 1, item: 'pistol', qty: 1, pos: { x: 1, y: 0, z: 2 } }],
    grenades: [],
    local: null,
    ...over,
  };
}

export function makeGrenade(id: number, over: Partial<GrenadeState> = {}): GrenadeState {
  return {
    id,
    ownerId: 1,
    pos: { x: 10, y: 2, z: -5 },
    vel: { x: 4, y: 3, z: -2 },
    explodesAt: 5000,
    inWater: false,
    ...over,
  };
}
