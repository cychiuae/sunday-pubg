/**
 * Test fixtures for protocol/net/server tests (not used by runtime code).
 */
import type { LocalPlayerState, MatchState, PlayerInput, PlayerState, WorldSnapshot } from '../types';

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
    jump: false,
    reload: false,
    interact: false,
    useHeal: false,
    selectSlot: -1,
    ...over,
  };
}

export function makePlayer(id: number, over: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: `P${id}`,
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
    appearance: { skin: 0, outfit: 1, hair: 2 },
    isBot: false,
    kills: 0,
    ...over,
  };
}

export function makeMatch(over: Partial<MatchState> = {}): MatchState {
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
    ...over,
  };
}

export function makeLocal(id: number, over: Partial<LocalPlayerState> = {}): LocalPlayerState {
  return {
    id,
    lastProcessedInputSeq: 0,
    movement: { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, grounded: true, dropping: false },
    slots: [{ weapon: 'pistol', mag: 12 }, null],
    activeSlot: 0,
    ammo: { ammo_light: 30, ammo_heavy: 0, ammo_shell: 0 },
    heals: { bandage: 1, medkit: 0 },
    reloadRemainingMs: 0,
    reloadTotalMs: 0,
    healRemainingMs: 0,
    healTotalMs: 0,
    healItem: null,
    swapRemainingMs: 0,
    ...over,
  };
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
    local: null,
    ...over,
  };
}
