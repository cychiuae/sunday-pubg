import { describe, expect, it } from 'vitest';
import { EventBus, type GameEvents } from '../shared/events';
import type { SimEvent } from '../shared/types';
import { translateSimEvent, type TranslateContext } from './simEvents';

type Emitted = { type: keyof GameEvents; payload: unknown };

function setup(localId: number | null = 1) {
  const bus = new EventBus<GameEvents>();
  const emitted: Emitted[] = [];
  const origEmit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    emitted.push({ type, payload });
    origEmit(type, payload);
  };
  const names: Record<number, string> = { 1: 'Me', 2: 'Crab', 3: 'Gull' };
  const ctx: TranslateContext = {
    localId,
    nameOf: (id) => names[id] ?? null,
    posOf: (id) => ({ x: id, y: 0, z: 0 }),
  };
  return { bus, emitted, run: (ev: SimEvent) => translateSimEvent(ev, ctx, bus) };
}

describe('translateSimEvent', () => {
  it('spawn: only the local player emits localPlayerSpawned', () => {
    const { emitted, run } = setup();
    run({ type: 'spawn', playerId: 2, pos: { x: 0, y: 30, z: 0 } });
    run({ type: 'spawn', playerId: 1, pos: { x: 1, y: 30, z: 2 } });
    expect(emitted).toEqual([{ type: 'localPlayerSpawned', payload: { playerId: 1, pos: { x: 1, y: 30, z: 2 } } }]);
  });

  it('shot -> shotFired with isLocal', () => {
    const { emitted, run } = setup();
    run({ type: 'shot', shooterId: 1, weapon: 'pistol', origin: { x: 0, y: 1, z: 0 }, impacts: [] });
    expect(emitted[0]).toMatchObject({ type: 'shotFired', payload: { shooterId: 1, isLocal: true } });
  });

  it('damage by local -> playerDamaged then localHitConfirmed (killed when hpAfter <= 0)', () => {
    const { emitted, run } = setup();
    run({
      type: 'damage',
      victimId: 2,
      attackerId: 1,
      amount: 30,
      headshot: true,
      cause: 'weapon',
      sourcePos: { x: 0, y: 1, z: 0 },
      hpAfter: 0,
      armorAfter: 0,
    });
    expect(emitted.map((e) => e.type)).toEqual(['playerDamaged', 'localHitConfirmed']);
    expect(emitted[0]!.payload).toMatchObject({ victimPos: { x: 2, y: 0, z: 0 }, isLocalAttacker: true, isLocalVictim: false });
    expect(emitted[1]!.payload).toEqual({ victimId: 2, amount: 30, headshot: true, killed: true });
  });

  it('damage to local from zone -> no hit confirm', () => {
    const { emitted, run } = setup();
    run({
      type: 'damage',
      victimId: 1,
      attackerId: null,
      amount: 2,
      headshot: false,
      cause: 'zone',
      sourcePos: { x: 0, y: 0, z: 0 },
      hpAfter: 90,
      armorAfter: 0,
    });
    expect(emitted.map((e) => e.type)).toEqual(['playerDamaged']);
    expect(emitted[0]!.payload).toMatchObject({ isLocalVictim: true, isLocalAttacker: false });
  });

  it('kill -> playerKilled with names from the snapshot', () => {
    const { emitted, run } = setup();
    run({ type: 'kill', victimId: 1, killerId: 2, weapon: 'smg', cause: 'weapon', placement: 4 });
    expect(emitted[0]).toEqual({
      type: 'playerKilled',
      payload: {
        killerId: 2,
        killerName: 'Crab',
        victimId: 1,
        victimName: 'Me',
        weapon: 'smg',
        cause: 'weapon',
        victimPos: { x: 1, y: 0, z: 0 },
        placement: 4,
        isLocalVictim: true,
        isLocalKiller: false,
      },
    });
  });

  it('reload/heal/switch/pickup get positions and isLocal', () => {
    const { emitted, run } = setup();
    run({ type: 'reloadStart', playerId: 1, weapon: 'smg', durationMs: 2000 });
    run({ type: 'reloadEnd', playerId: 1, weapon: 'smg', completed: false });
    run({ type: 'healStart', playerId: 3, item: 'bandage', durationMs: 2500 });
    run({ type: 'healEnd', playerId: 3, item: 'bandage', completed: true, hpAfter: 60 });
    run({ type: 'healEnd', playerId: 3, item: 'medkit', completed: false, hpAfter: 40 });
    run({ type: 'weaponSwitch', playerId: 1, weapon: 'fists', slot: 2 });
    run({ type: 'pickup', playerId: 2, lootId: 9, item: 'vest', qty: 1, pos: { x: 5, y: 0, z: 5 } });
    expect(emitted.map((e) => e.type)).toEqual([
      'reloadStarted',
      'reloadFinished',
      'healStarted',
      'healFinished',
      'healCancelled',
      'weaponSwitched',
      'itemPickedUp',
    ]);
    expect(emitted[0]!.payload).toMatchObject({ pos: { x: 1, y: 0, z: 0 }, isLocal: true, durationMs: 2000 });
    expect(emitted[1]!.payload).toMatchObject({ completed: false });
    expect(emitted[3]!.payload).toMatchObject({ hpAfter: 60, isLocal: false, pos: { x: 3, y: 0, z: 0 } });
    expect(emitted[6]!.payload).toMatchObject({ isLocal: false, pos: { x: 5, y: 0, z: 5 } });
  });

  it('matchEnded -> local placement and kills from standings, sorted', () => {
    const { emitted, run } = setup();
    run({
      type: 'matchEnded',
      winnerId: 2,
      standings: [
        { id: 1, name: 'Me', isBot: false, kills: 3, placement: 2 },
        { id: 3, name: 'Gull', isBot: true, kills: 0, placement: 3 },
        { id: 2, name: 'Crab', isBot: true, kills: 5, placement: 1 },
      ],
    });
    const p = emitted[0]!.payload as GameEvents['matchEnded'];
    expect(p.winnerName).toBe('Crab');
    expect(p.localPlacement).toBe(2);
    expect(p.localKills).toBe(3);
    expect(p.totalPlayers).toBe(3);
    expect(p.isLocalWinner).toBe(false);
    expect(p.standings.map((s) => s.placement)).toEqual([1, 2, 3]);
  });

  it('damage/kill copy armorBefore and headshot when present, and omit them when absent', () => {
    const { emitted, run } = setup();
    const base = {
      type: 'damage' as const,
      victimId: 2,
      attackerId: 3,
      amount: 20,
      headshot: false,
      cause: 'weapon' as const,
      sourcePos: { x: 0, y: 1, z: 0 },
      hpAfter: 80,
      armorAfter: 0,
    };
    run({ ...base, armorBefore: 15 });
    run(base);
    run({ type: 'kill', victimId: 2, killerId: 3, weapon: 'rifle', cause: 'weapon', placement: 5, headshot: true });
    run({ type: 'kill', victimId: 3, killerId: null, weapon: null, cause: 'zone', placement: 4 });
    expect(emitted[0]!.payload).toMatchObject({ armorBefore: 15, armorAfter: 0 });
    expect(emitted[1]!.payload).not.toHaveProperty('armorBefore');
    expect(emitted[2]!.payload).toMatchObject({ headshot: true });
    expect(emitted[3]!.payload).not.toHaveProperty('headshot');
  });

  it('weaponSwitched carries the player view position', () => {
    const { emitted, run } = setup();
    run({ type: 'weaponSwitch', playerId: 3, weapon: 'smg', slot: 0 });
    expect(emitted[0]).toEqual({
      type: 'weaponSwitched',
      payload: { playerId: 3, weapon: 'smg', slot: 0, isLocal: false, pos: { x: 3, y: 0, z: 0 } },
    });
  });

  it('actionFailed: emitted only for the local player and never for fire', () => {
    const { emitted, run } = setup();
    run({ type: 'actionFailed', playerId: 2, action: 'heal', reason: 'noHeals' });
    run({ type: 'actionFailed', playerId: 1, action: 'fire', reason: 'noAmmo' });
    run({ type: 'actionFailed', playerId: 1, action: 'pickup', reason: 'inventoryFull' });
    run({ type: 'actionFailed', playerId: 1, action: 'reload', reason: 'noAmmo' });
    expect(emitted).toEqual([
      { type: 'actionFailed', payload: { playerId: 1, action: 'pickup', reason: 'inventoryFull', isLocal: true } },
      { type: 'actionFailed', payload: { playerId: 1, action: 'reload', reason: 'noAmmo', isLocal: true } },
    ]);
  });

  it('actionFailed with no local player emits nothing', () => {
    const { emitted, run } = setup(null);
    run({ type: 'actionFailed', playerId: 1, action: 'heal', reason: 'fullHp' });
    expect(emitted).toEqual([]);
  });

  it('matchEnded for a mid-match spectator -> localPlacement null', () => {
    const { emitted, run } = setup(42);
    run({ type: 'matchEnded', winnerId: null, standings: [{ id: 2, name: 'Crab', isBot: true, kills: 0, placement: 1 }] });
    expect(emitted[0]!.payload).toMatchObject({ localPlacement: null, localKills: 0, isLocalWinner: false, winnerName: null });
  });
});
