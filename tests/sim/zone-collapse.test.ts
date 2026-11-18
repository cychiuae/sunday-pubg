/**
 * zone.md acceptance test 4 (gap: no owner unit test by name): "A player with 100 HP outside during collapse dies
 * within 4 s." Uses the sim testkit on a flat test map so terrain and props play no part.
 */
import { describe, expect, it } from 'vitest';
import { BALANCE } from '../../src/shared/balance';
import { flatMap, land, playingWorld, run } from '../../src/shared/sim/testkit';

describe('zone AT4: final collapse', () => {
  it('a 100 HP player (with full armor) outside during the collapse dies within 4 s', () => {
    const { w, ids } = playingWorld(2, { map: flatMap({ islandRadius: 300, worldRadius: 330 }) });
    const [a, b] = ids as [number, number];
    const z = w.debugZone()!;
    const phases = BALANCE.zone.phases.length;
    // Fast-forward to the final collapse, topping both humans up so nobody dies (and the match keeps running).
    let guard = 0;
    while (z.state.phaseIndex < phases) {
      for (const id of [a, b]) {
        const p = w.debugPlayer(id)!;
        p.hp = BALANCE.player.maxHp;
      }
      run(w, 30);
      expect(++guard, 'reached the collapse').toBeLessThan(60 * 20);
    }
    expect(w.getMatch().phase).toBe('playing');

    land(w, a, 0, 290); // far outside any collapse circle
    const pa = w.debugPlayer(a)!;
    pa.hp = 100;
    pa.vest = { tier: 3, durability: BALANCE.items.vest_3.durability }; // the tide ignores armor (zone.ignoresArmor)
    w.debugPlayer(b)!.hp = BALANCE.player.maxHp;

    let ticks = 0;
    while (pa.alive && ticks < 30 * 4) {
      run(w, 1);
      ticks++;
    }
    expect(pa.alive, `still alive after ${ticks} ticks with hp ${pa.hp}`).toBe(false);
    expect(ticks / 30).toBeLessThanOrEqual(4);
  });
});
