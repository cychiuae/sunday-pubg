import { describe, expect, it } from 'vitest';
import { DEV_HOOK_KEY, installDevHook, type DevGameState } from './devHook';

function state(over: Partial<DevGameState> = {}): DevGameState {
  return {
    connection: 'connected',
    joined: true,
    phase: 'playing',
    matchId: 1,
    localId: 1,
    localAlive: true,
    localHp: 100,
    localArmor: 0,
    localPos: { x: 1, y: 2, z: 3 },
    localWeapon: 'fists',
    localKills: 0,
    aliveCount: 2,
    totalPlayers: 2,
    lobbyCount: 0,
    spectateTargetId: null,
    pointerLocked: false,
    serverTime: 0,
    pendingInputs: 0,
    lastCorrection: 0,
    lootCount: 0,
    players: [],
    ...over,
  };
}

describe('installDevHook', () => {
  it('defines a getter that returns a fresh copy of the current state each access', () => {
    const target: Record<string, unknown> = {};
    let hp = 100;
    const remove = installDevHook(() => state({ localHp: hp }), { target, enabled: true });
    const a = target[DEV_HOOK_KEY] as DevGameState;
    expect(a.localHp).toBe(100);
    hp = 40;
    expect((target[DEV_HOOK_KEY] as DevGameState).localHp).toBe(40);
    // Mutating a returned snapshot does not leak into the next read; assignment is ignored (getter only).
    a.localPos!.x = 99;
    expect((target[DEV_HOOK_KEY] as DevGameState).localPos!.x).toBe(1);
    expect(() => {
      'use strict';
      target[DEV_HOOK_KEY] = 1;
    }).toThrow();
    remove();
    expect(DEV_HOOK_KEY in target).toBe(false);
  });

  it('does nothing when disabled or outside a browser', () => {
    const target: Record<string, unknown> = {};
    installDevHook(() => state(), { target, enabled: false })();
    expect(DEV_HOOK_KEY in target).toBe(false);
    // Node test environment: no window, so the default target is absent and nothing is installed.
    installDevHook(() => state(), { enabled: true })();
    expect(DEV_HOOK_KEY in globalThis).toBe(false);
  });
});
