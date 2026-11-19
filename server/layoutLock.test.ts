/**
 * M2c layout lock (ADR 0007 §1.3-§1.7, ARCHITECTURE §16.5 N2): seed choice with repeat avoidance, the pin, the LRU of
 * prepared layouts, timing, and the variety.md §2.3 log line. The real generator is used where it matters.
 */
import { describe, expect, it } from 'vitest';
import { getMap } from '../src/game/levels';
import { buildMatchLayout, pickVariants } from '../src/game/levels/layout';
import { BALANCE, balanceForMap } from '../src/shared/balance';
import { LAYOUT_FORMAT_VERSION, LAYOUT_MAX_REROLLS, countRepeatedPicks, layoutSeedFor } from '../src/shared/layout';
import { prepareMap } from '../src/shared/sim/movement';
import type { LayoutPick } from '../src/shared/types';
import { LEVEL_LAYOUTS } from './app';
import type { SimMap } from './common';
import { LAYOUT_CACHE_SIZE, LayoutService, chooseLayoutSeed, formatPicks, layoutLogLine } from './layoutLock';

const picks = (...variants: string[]): LayoutPick[] => variants.map((v, i) => ({ zone: `z${i}`, variant: v }));

describe('chooseLayoutSeed (repeat avoidance)', () => {
  const prev = picks('a', 'a', 'a', 'a');

  it('no previous match on the map: attempt 0', () => {
    const c = chooseLayoutSeed({ worldSeed: 7, pin: null, previous: null, picksOf: () => prev });
    expect(c).toMatchObject({ seed: layoutSeedFor(7, 0), attempt: 0, repeats: 0, pinned: false });
  });

  it('keeps the first attempt with at most half of the zones repeated', () => {
    // Attempt 0 repeats 4/4, attempt 1 repeats 3/4, attempt 2 repeats 2/4 (= half: accepted).
    const bySeed = new Map([0, 1, 2, 3].map((a) => [layoutSeedFor(7, a), a]));
    const of = (seed: number) => {
      const a = bySeed.get(seed) ?? 9;
      return picks(...['a', 'a', 'a', 'a'].map((v, i) => (i < a ? 'b' : v)));
    };
    const c = chooseLayoutSeed({ worldSeed: 7, pin: null, previous: prev, picksOf: of });
    expect(c).toMatchObject({ seed: layoutSeedFor(7, 2), attempt: 2, repeats: 2, zones: 4 });
  });

  it('no attempt qualifies: the fewest repeats, ties to the lowest attempt; at most 8 re-rolls', () => {
    const seen: number[] = [];
    const repeatsAt = [4, 3, 4, 3, 4, 4, 4, 4, 4];
    const bySeed = new Map(repeatsAt.map((_, a) => [layoutSeedFor(9, a), a]));
    const c = chooseLayoutSeed({
      worldSeed: 9,
      pin: null,
      previous: prev,
      picksOf: (seed) => {
        seen.push(seed);
        const a = bySeed.get(seed)!;
        return picks(...['a', 'a', 'a', 'a'].map((v, i) => (i < 4 - repeatsAt[a]! ? 'b' : v)));
      },
    });
    expect(seen).toHaveLength(LAYOUT_MAX_REROLLS + 1);
    expect(c).toMatchObject({ attempt: 1, repeats: 3 });
  });

  it('a pin is never re-rolled (even when every zone repeats)', () => {
    const c = chooseLayoutSeed({ worldSeed: 1, pin: 0x3fa2c1d0, previous: prev, picksOf: () => prev });
    expect(c).toMatchObject({ seed: 0x3fa2c1d0, attempt: 0, repeats: 4, pinned: true });
  });

  it('real island and office picks: two matches in a row repeat at most half the zones whenever an attempt allows it', () => {
    for (const id of ['island01', 'office']) {
      const base = getMap(id);
      let previous: LayoutPick[] | null = null;
      for (let match = 1; match <= 20; match++) {
        const c = chooseLayoutSeed({ worldSeed: 0xabc00 + match, pin: null, previous, picksOf: (s) => pickVariants(base, s) });
        if (previous !== null && c.attempt < LAYOUT_MAX_REROLLS) expect(c.repeats * 2).toBeLessThanOrEqual(c.zones);
        expect(countRepeatedPicks(previous ?? [], c.picks)).toBe(c.repeats);
        previous = c.picks;
      }
    }
  });
});

describe('LayoutService', () => {
  let t = 0;
  const service = (pin: number | null = null, generator = LEVEL_LAYOUTS) => {
    const balances = new Map<string, ReturnType<typeof balanceForMap>>();
    return new LayoutService({
      generator,
      getMap: (id) => getMap(id) as SimMap,
      balanceFor: (id) => balances.get(id) ?? (balances.set(id, balanceForMap(BALANCE, id)), balances.get(id)!),
      prepareMap: (map, b) => prepareMap(map, b),
      pin,
      now: () => (t += 1),
    });
  };

  it('builds the applied map, the ref the client checks, and a runtime prepared from that map', () => {
    for (const id of ['island01', 'office']) {
      const l = service().lock(id, 42, null);
      const client = buildMatchLayout(getMap(id), l.ref.seed, { decor: true }); // the client builds with decor
      expect(l.ref).toEqual({ seed: layoutSeedFor(42, 0), version: LAYOUT_FORMAT_VERSION, hash: client.hash, look: client.look });
      expect(l.map.props).toEqual(client.props);
      expect(l.map.lootSpawns).toEqual(client.lootSpawns);
      expect(l.runtime?.map).toBe(l.map);
      expect(l.runtime?.balance).toBe(l.balance);
      expect(l.runtime?.nav === null).toBe(id === 'island01'); // nav only indoors
      expect(l).toMatchObject({ cached: false, generated: true, layoutMs: expect.any(Number), navMs: expect.any(Number) });
    }
  });

  it('LRU of 4 by mapId:seed:version; a pin always hits after the first build', () => {
    const s = service();
    for (let w = 1; w <= 5; w++) s.lock('island01', w, null);
    expect(s.cachedKeys()).toEqual([2, 3, 4, 5].map((w) => `island01:${layoutSeedFor(w, 0)}:${LAYOUT_FORMAT_VERSION}`));
    expect(s.cachedKeys()).toHaveLength(LAYOUT_CACHE_SIZE);
    expect(s.lock('island01', 3, null).cached).toBe(true);
    expect(s.cachedKeys().at(-1)).toBe(`island01:${layoutSeedFor(3, 0)}:${LAYOUT_FORMAT_VERSION}`); // moved to newest
    const pinned = service(0x1234);
    expect(pinned.lock('office', 1, null).cached).toBe(false);
    const again = pinned.lock('office', 2, pinned.lock('office', 3, null).choice.picks);
    expect(again).toMatchObject({ cached: true, choice: { seed: 0x1234, pinned: true } });
    expect(pinned.stats).toMatchObject({ builds: 1, hits: 2 });
  });

  it('LAYOUT_SEED=baseline (0) builds the baseline layout', () => {
    const l = service(0).lock('island01', 5, null);
    expect(l.ref.seed).toBe(0);
    expect(l.ref.look).toBe('noon');
  });

  it('without a generator: the base map, seed 0 and its own hash (room tests)', () => {
    const l = service(null, null as never).lock('office', 5, null);
    expect(l.map).toBe(getMap('office'));
    expect(l).toMatchObject({ generated: false, ref: { seed: 0, look: 'day' } });
  });

  it('log line (variety.md §2.3) with the timing, the attempt, repeats and fallbacks', () => {
    expect(formatPicks([{ zone: 'TL', variant: 'pods', params: { column: 3 } }, { zone: 'TR', variant: 'rows' }, { zone: 'BL', variant: 'gaps', params: { removed: 'N2,N3' } }]))
      .toBe('TL=pods(3) TR=rows BL=gaps(N2,N3)');
    const l = service(0x3fa2c1d0).lock('office', 1, null);
    expect(layoutLogLine(12, 'office', l)).toMatch(
      new RegExp(String.raw`^match 12 map office layout 0x3FA2C1D0 v${LAYOUT_FORMAT_VERSION} look \w+ picks TL=\S+ .* \| layoutMs \d+\.\d navMs \d+\.\d, pinned, repeats 0\/12, fallbacks \d+, hash 0x[0-9A-F]{8}$`),
    );
  });
});
