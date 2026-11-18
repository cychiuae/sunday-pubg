import { describe, expect, it } from 'vitest';
import { SpectateController, spectateOrder } from './spectate';
import { makePlayer } from './testFixtures';

const players = [
  makePlayer(5, { isBot: true }),
  makePlayer(1), // local
  makePlayer(3),
  makePlayer(4, { alive: false }),
  makePlayer(2, { isBot: true }),
  makePlayer(7),
];

describe('spectateOrder', () => {
  it('lists alive non-local players, humans first, then by id', () => {
    expect(spectateOrder(players, 1).map((p) => p.id)).toEqual([3, 7, 2, 5]);
  });
});

describe('SpectateController', () => {
  it('follows the killer of the local player when alive', () => {
    const s = new SpectateController();
    s.onKill(1, 5, 1);
    expect(s.update(spectateOrder(players, 1))).toBe(true);
    expect(s.targetId).toBe(5);
  });

  it('falls back to the first candidate (humans first) when the killer is dead or unknown', () => {
    const s = new SpectateController();
    s.onKill(1, 4, 1); // killer 4 is dead
    s.update(spectateOrder(players, 1));
    expect(s.targetId).toBe(3);

    const z = new SpectateController();
    z.onKill(1, null, 1); // zone death
    z.update(spectateOrder(players, 1));
    expect(z.targetId).toBe(3);
  });

  it('cycles through alive players and wraps', () => {
    const s = new SpectateController();
    const c = spectateOrder(players, 1);
    s.update(c);
    const seen = [s.targetId];
    for (let i = 0; i < 4; i++) {
      s.next(c);
      seen.push(s.targetId);
    }
    expect(seen).toEqual([3, 7, 2, 5, 3]);
  });

  it('when the target dies, follows their killer if alive', () => {
    const s = new SpectateController();
    s.update(spectateOrder(players, 1));
    expect(s.targetId).toBe(3);
    s.onKill(3, 2, 1);
    const after = players.map((p) => (p.id === 3 ? { ...p, alive: false } : p));
    expect(s.update(spectateOrder(after, 1))).toBe(true);
    expect(s.targetId).toBe(2);
  });

  it('keeps a valid target and reports no change', () => {
    const s = new SpectateController();
    const c = spectateOrder(players, 1);
    s.update(c);
    expect(s.update(c)).toBe(false);
  });

  it('update(null) stops spectating; empty candidates => null target', () => {
    const s = new SpectateController();
    s.update(spectateOrder(players, 1));
    expect(s.update(null)).toBe(true);
    expect(s.targetId).toBeNull();
    expect(s.update([])).toBe(false);
    expect(s.targetId).toBeNull();
    expect(s.next([])).toBe(false);
  });
});
