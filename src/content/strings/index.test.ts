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
    const ids = [
      'fists', 'pistol', 'smg', 'shotgun', 'rifle', 'dmr', 'sniper', 'lmg',
      'ammo_light', 'ammo_heavy', 'ammo_shell', 'ammo_sniper', 'bandage', 'medkit',
      'vest_1', 'vest_2', 'vest_3', 'helmet_1', 'helmet_2', 'helmet_3', 'grenade',
      // M2c
      'knife', 'machete', 'paddle', 'dbshotgun', 'revolver', 'rpg', 'ammo_rocket', 'smoke', 'vest_4', 'helmet_4',
      'scope_red_dot', 'scope_2x', 'scope_4x', 'scope_8x',
    ];
    for (const id of ids) {
      expect(hasKey(`item.${id}.name`), id).toBe(true);
      expect(hasKey(`item.${id}.type`), id).toBe(true);
      expect(hasKey(`item.${id}.desc`), id).toBe(true);
    }
  });

  it('labels every gear tier, 0 (none) to 4', () => {
    expect(keysWithPrefix('gear.tier')).toEqual(['gear.tier.0', 'gear.tier.1', 'gear.tier.2', 'gear.tier.3', 'gear.tier.4']);
  });

  it('M2c: names every item level 1-4 with a short HUD-sized name and a numeral label', () => {
    for (const n of [1, 2, 3, 4]) {
      expect(hasKey(`level.${n}.name`), `level.${n}.name`).toBe(true);
      expect(t(`level.${n}.name`).length, `level.${n}.name`).toBeLessThanOrEqual(10);
      expect(t(`level.${n}.short`)).toContain(String(n));
      expect(t(`level.${n}.short`)).toBe(t(`gear.tier.${n}`));
    }
    const names = [1, 2, 3, 4].map((n) => t(`level.${n}.name`));
    expect(new Set(names).size).toBe(4);
  });

  it('weapon names start with a consonant sound (feed and death card say "with a {weapon}")', () => {
    const weapons = [
      'fists', 'pistol', 'smg', 'shotgun', 'rifle', 'dmr', 'sniper', 'lmg', 'grenade',
      'knife', 'machete', 'paddle', 'dbshotgun', 'revolver', 'rpg', 'smoke',
    ];
    for (const id of weapons) expect(t(`item.${id}.name`), id).not.toMatch(/^[AEIOU]/i);
  });

  it('M2c: scope keys exist, the zoom is in every scope name, and every sight type is named', () => {
    for (const [id, zoom] of [['scope_2x', '2x'], ['scope_4x', '4x'], ['scope_8x', '8x']] as const) {
      expect(t(`item.${id}.name`)).toContain(zoom);
    }
    for (const s of ['iron', 'red_dot', 'scope_2x', 'scope_4x', 'scope_8x']) expect(hasKey(`sight.${s}`), s).toBe(true);
    for (const k of [
      'mountsOn', 'toPouch', 'stashFull', 'pouchFull', 'fits', 'mounted', 'stashed', 'now', 'mounting', 'cantFit',
      'noneFits', 'builtIn', 'mountedOn', 'inPouch', 'cycle', 'sr', 'srBuiltIn', 'stash',
    ]) {
      expect(hasKey(`hud.scope.${k}`), k).toBe(true);
    }
    expect(t('hud.scope.pouchFull')).toBe('Scope pouch full!');
    expect(hasKey('hint.scope') && hasKey('menu.controls.scope.key') && hasKey('menu.controls.scope.label')).toBe(true);
  });

  it('M2c: names every look preset, with a loading line', () => {
    const looks = [
      'island01.morning', 'island01.noon', 'island01.golden', 'island01.overcast',
      'office.day', 'office.evening', 'office.afterHours',
    ];
    for (const id of looks) {
      expect(hasKey(`look.${id}`), id).toBe(true);
      expect(hasKey(`look.${id}.line`), id).toBe(true);
    }
  });

  it('M2c: new kill feed groups carry the right placeholders', () => {
    for (const p of ['feed.meleeWeapon', 'feed.meleeHeadshot']) {
      expect(tCount(p), p).toBeGreaterThan(0);
      for (const k of keysWithPrefix(p)) {
        for (const v of ['{killer}', '{victim}', '{weapon}']) expect(table[k], k).toContain(v);
      }
    }
    for (const p of ['feed.knife', 'feed.machete', 'feed.paddle', 'feed.rocket', 'feed.rocketDirect', 'feed.smoke']) {
      expect(tCount(p), p).toBeGreaterThan(0);
      for (const k of keysWithPrefix(p)) {
        expect(table[k], k).toContain('{killer}');
        expect(table[k], k).toContain('{victim}');
      }
    }
    expect(tCount('feed.rocketSelf')).toBeGreaterThan(0);
    for (const k of keysWithPrefix('feed.rocketSelf')) {
      expect(table[k], k).toContain('{victim}');
      expect(table[k], k).not.toContain('{killer}');
    }
  });

  it('names every POI and the map', () => {
    expect(hasKey('map.island01.name')).toBe(true);
    for (const id of ['dock', 'village', 'wreck', 'rocks', 'grove', 'tikibar', 'summit']) {
      expect(hasKey(`poi.${id}`), id).toBe(true);
    }
  });

  it('names the office map and every office POI, with a short label', () => {
    expect(hasKey('map.office.name')).toBe(true);
    expect(hasKey('map.office.tagline')).toBe(true);
    const ids = [
      'meeting', 'phone', 'corner', 'blue', 'yellow', 'pantry', 'admin', 'gym', 'games', 'tea', 'entrance',
      'sales', 'design', 'eng', 'project',
    ];
    for (const id of ids) {
      expect(hasKey(`poi.office_${id}`), id).toBe(true);
      expect(hasKey(`poi.office_${id}.short`), id).toBe(true);
    }
  });

  it('each zone theme mirrors the tide keys', () => {
    for (const theme of ['tide', 'lightsOut', 'sprinklers']) {
      for (const f of ['phase', 'wait', 'shrinking', 'final', 'outside']) {
        expect(hasKey(`hud.${theme}.${f}`), `hud.${theme}.${f}`).toBe(true);
      }
      for (const f of ['warning', 'rising', 'final']) {
        expect(hasKey(`announcer.${theme}.${f}`), `announcer.${theme}.${f}`).toBe(true);
      }
      expect(hasKey(`hint.${theme}`), theme).toBe(true);
    }
    expect(tCount('feed.lightsOut')).toBeGreaterThan(0);
    expect(tCount('feed.sprinklers')).toBeGreaterThan(0);
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
    for (const k of [...keysWithPrefix('feed.melee'), ...keysWithPrefix('feed.grenade')]) {
      expect(table[k], k).toContain('{killer}');
      expect(table[k], k).toContain('{victim}');
    }
    expect(tCount('feed.grenade')).toBeGreaterThan(0);
    expect(tCount('feed.grenadeSelf')).toBeGreaterThan(0);
    for (const k of [
      ...keysWithPrefix('feed.zone'),
      ...keysWithPrefix('feed.fall'),
      ...keysWithPrefix('feed.generic'),
      ...keysWithPrefix('feed.grenadeSelf'),
      ...keysWithPrefix('feed.lightsOut'),
      ...keysWithPrefix('feed.sprinklers'),
    ]) {
      expect(table[k], k).toContain('{victim}');
      expect(table[k], k).not.toContain('{killer}');
    }
  });
});
