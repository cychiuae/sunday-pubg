/**
 * Test fixtures for protocol/net/server tests (not used by runtime code).
 */
import type {
  DropMovementFields,
  GrenadeState,
  LocalDropFields,
  LocalM2cFields,
  LocalPlayerState,
  M2cThrowableId,
  MatchMapFields,
  MatchState,
  PlayerDropFields,
  PlayerInput,
  PlayerM2cFields,
  PlayerState,
  RocketState,
  SmokeCloudState,
  WelcomeInfo,
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
    cycleScope: false,
    ...over,
  };
}

// M2b: the fixtures carry the C-gate drop fields already (typed through the field blocks so they compile before and
// after the gate merges them into the target types). M2c: likewise the M2c blocks (ADR 0007 §10), at the values the
// gate-prep World writes (fists: weaponLevel null, sight 'none'; empty rockets, smokes and brokenPanes).
export function makePlayer(id: number, over: Partial<PlayerState & PlayerDropFields & PlayerM2cFields> = {}): PlayerState {
  const p: PlayerState & PlayerDropFields & PlayerM2cFields = {
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
    weaponLevel: null,
    sight: 'none',
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

export function makeLocal(
  id: number,
  over: Partial<LocalPlayerState & LocalDropFields & LocalM2cFields> = {},
): LocalPlayerState {
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
  const l: LocalPlayerState & LocalDropFields & LocalM2cFields = {
    id,
    lastProcessedInputSeq: 0,
    movement,
    slots: [{ weapon: 'pistol', mag: 12 }, null],
    activeSlot: 0,
    // M2c ammo_rocket through a spread: a required key after the C-gate, an extra one before it.
    ammo: { ammo_light: 30, ammo_heavy: 0, ammo_shell: 0, ammo_sniper: 0, ...{ ammo_rocket: 0 } },
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
    melee: null,
    smokes: 0,
    selectedThrowable: 'grenade',
    spareScope: null,
    scopeSwapRemainingMs: 0,
    ...over,
  };
  return l;
}

type M2cSnapshotLists = { rockets: RocketState[]; smokes: SmokeCloudState[]; brokenPanes: number[] };
export function makeSnapshot(
  tick: number,
  players: PlayerState[],
  over: Partial<WorldSnapshot & M2cSnapshotLists> = {},
): WorldSnapshot {
  const s: WorldSnapshot & M2cSnapshotLists = {
    tick,
    serverTime: (tick * 1000) / 30,
    match: makeMatch(),
    zone: null,
    players,
    lootVersion: 1,
    loot: [{ id: 1, item: 'pistol', qty: 1, pos: { x: 1, y: 0, z: 2 } }],
    grenades: [],
    rockets: [],
    smokes: [],
    brokenPanes: [],
    local: null,
    ...over,
  };
  return s;
}

export function makeGrenade(id: number, over: Partial<GrenadeState> & { kind?: M2cThrowableId } = {}): GrenadeState {
  const g: GrenadeState & { kind: M2cThrowableId } = {
    id,
    ownerId: 1,
    pos: { x: 10, y: 2, z: -5 },
    vel: { x: 4, y: 3, z: -2 },
    explodesAt: 5000,
    inWater: false,
    kind: 'grenade',
    ...over,
  };
  return g;
}

export function makeRocket(id: number, over: Partial<RocketState> = {}): RocketState {
  return {
    id,
    ownerId: 1,
    level: 1,
    pos: { x: 12.5, y: 3.25, z: -40.125 },
    vel: { x: 30.5, y: 1.25, z: -50.75 },
    firedAt: 120_000.5,
    ...over,
  };
}

export function makeSmoke(id: number, over: Partial<SmokeCloudState> = {}): SmokeCloudState {
  return { id, ownerId: 1, pos: { x: -20.5, y: 1.5, z: 33.25 }, deployedAt: 100_000, fadeAt: 118_000, ...over };
}

/** A welcome with the M2c `layout` ref (required after the C-gate; a baseline ref here). */
export function makeWelcome(over: Partial<WelcomeInfo> = {}): WelcomeInfo {
  return {
    playerId: 1,
    mapId: 'island01',
    serverTime: 0,
    matchId: 1,
    roomId: 'r1',
    layout: { seed: 0, version: 1, hash: 0x1234abcd, look: 'noon' },
    ...over,
  };
}
