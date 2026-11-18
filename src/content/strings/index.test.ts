import { describe, expect, it } from 'vitest';
import en from './en.json';
import { format, hasKey, keysWithPrefix, t, tCount, tIndex, tRandom } from './index';

const table = en as Record<string, string>;

describe('t()', () => {
  it('returns the plain string for a known key', () => {
    expect(t('menu.play')).toBe('Play');
  });

  it('interpolates {vars}', () => {
    expect(t('hud.alive', { count: 12 })).toBe('12 alive');
    expect(t('hud.pickup', { item: 'Conch Pistol' })).toBe('[E] Pick up Conch Pistol');
    expect(t('death.placement', { place: 3 })).toBe('#3');
  });

  it('interpolates multiple vars and repeats', () => {
    expect(format('{a}-{b}-{a}', { a: 1, b: 'x' })).toBe('1-x-1');
  });

  it('leaves unknown placeholders intact', () => {
    expect(t('hud.alive')).toBe('{count} alive');
    expect(t('results.placement', { place: 2 })).toBe('#2 of {total}');
  });

  it('falls back to the key when missing', () => {
    expect(t('nope.missing.key')).toBe('nope.missing.key');
    expect(hasKey('nope.missing.key')).toBe(false);
    expect(hasKey('menu.play')).toBe(true);
  });

  it('accepts zero and empty-string values', () => {
    expect(t('hud.kills', { count: 0 })).toBe('Kills 0');
    expect(format('[{x}]', { x: '' })).toBe('[]');
  });
});

describe('variants', () => {
  it('lists numbered keys in numeric order, with or without trailing dot', () => {
    const keys = keysWithPrefix('bot.name');
    expect(keys[0]).toBe('bot.name.0');
    expect(keys[10]).toBe('bot.name.10');
    expect(keysWithPrefix('bot.name.')).toEqual(keys);
  });

  it('counts variants', () => {
    expect(tCount('bot.name')).toBe(24);
    expect(tCount('results.win')).toBeGreaterThanOrEqual(2);
    expect(tCount('does.not.exist')).toBe(0);
  });

  it('picks with injected rng and stays in range', () => {
    expect(tRandom('feed.zone', { victim: 'Gus' }, () => 0)).toBe(t('feed.zone.0', { victim: 'Gus' }));
    const zoneKeys = keysWithPrefix('feed.zone');
    const last = zoneKeys[zoneKeys.length - 1]!;
    expect(tRandom('feed.zone', { victim: 'Gus' }, () => 0.999999)).toBe(t(last, { victim: 'Gus' }));
    expect(tRandom('none.here')).toBe('none.here');
  });

  it('indexes with wrap-around', () => {
    expect(tIndex('bot.name', 24)).toBe(t('bot.name.0'));
    expect(tIndex('bot.name', -1)).toBe(t('bot.name.23'));
  });
});

describe('en.json content', () => {
  it('has only non-empty string values', () => {
    for (const [k, v] of Object.entries(table)) {
      expect(typeof v, k).toBe('string');
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });

  it('numbered variant groups have no gaps', () => {
    const groups = new Set<string>();
    for (const k of Object.keys(table)) {
      const m = /^(.*)\.(\d+)$/.exec(k);
      if (m) groups.add(m[1]!);
    }
    for (const g of groups) {
      const keys = keysWithPrefix(g);
      keys.forEach((key, i) => expect(key).toBe(`${g}.${i}`));
    }
  });

  it('names every item id', () => {
    const ids = ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'ammo_light', 'ammo_heavy', 'ammo_shell', 'bandage', 'medkit', 'vest'];
    for (const id of ids) {
      expect(hasKey(`item.${id}.name`), id).toBe(true);
      expect(hasKey(`item.${id}.desc`), id).toBe(true);
    }
  });

  it('names every POI and the map', () => {
    expect(hasKey('map.island01.name')).toBe(true);
    for (const id of ['dock', 'village', 'wreck', 'rocks', 'grove', 'tikibar', 'summit']) {
      expect(hasKey(`poi.${id}`), id).toBe(true);
    }
  });

  it('bot names are unique and short', () => {
    const names = keysWithPrefix('bot.name').map((k) => t(k));
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length, n).toBeLessThanOrEqual(16);
  });

  it('kill feed variants carry the right placeholders', () => {
    for (const k of [...keysWithPrefix('feed.kill'), ...keysWithPrefix('feed.headshot')]) {
      expect(table[k], k).toContain('{killer}');
      expect(table[k], k).toContain('{victim}');
      expect(table[k], k).toContain('{weapon}');
    }
    for (const k of keysWithPrefix('feed.melee')) {
      expect(table[k], k).toContain('{killer}');
      expect(table[k], k).toContain('{victim}');
    }
    for (const k of [...keysWithPrefix('feed.zone'), ...keysWithPrefix('feed.fall'), ...keysWithPrefix('feed.generic')]) {
      expect(table[k], k).toContain('{victim}');
      expect(table[k], k).not.toContain('{killer}');
    }
  });
});
