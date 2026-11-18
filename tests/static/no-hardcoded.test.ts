/**
 * C1 / CLAUDE.md shared rules: gameplay numbers live in docs/design/balance.json and player-facing text in
 * src/content/strings/en.json.
 *
 * 1. No weapon stat is written as a numeric object-literal property in runtime code (balance keys like
 *    `damage: 20` or `magSize: 12` outside balance.json). Ternaries such as `x.magSize : 0` are not object literals.
 * 2. Every literal key passed to t()/tRandom() in runtime code exists in en.json, so no key string leaks to the screen.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const runtimeFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'server'))].filter(
  (f) =>
    f.endsWith('.ts') &&
    !f.endsWith('.test.ts') &&
    !/testkit|testFixtures|testing\.ts$|testClient\.ts$|fakeAudioContext/.test(f) &&
    !f.includes('/tools/'),
);

const WEAPON_KEYS = [
  'damage',
  'headshotMultiplier',
  'fireIntervalMs',
  'magSize',
  'reloadMs',
  'spreadDeg',
  'pellets',
  'falloffStart',
  'falloffEnd',
  'minDamageFactor',
  'moveSpreadMultiplier',
  // M2a (ADS, LMG fire slow, grenade, armor, stances).
  'adsZoom',
  'adsSpreadMultiplier',
  'adsMoveMultiplier',
  'adsTimeMs',
  'fireMoveMultiplier',
  'fuseMs',
  'maxDamage',
  'innerRadius',
  'absorbFraction',
  'throwSpeedMin',
  'throwSpeedMax',
  'proneMaxWaterDepth',
  'crouchMaxWaterDepth',
];

describe('no hard-coded gameplay numbers (C1)', () => {
  it('weapon stats are never numeric object-literal properties outside balance.json', () => {
    const re = new RegExp(`(?:^|[{,])\\s*(${WEAPON_KEYS.join('|')})\\s*:\\s*-?\\d`, 'gm');
    const hits: string[] = [];
    for (const f of runtimeFiles) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const line = src.slice(0, m.index).split('\n').length;
        hits.push(`${relative(ROOT, f)}:${line} ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe('player-facing strings (A5 / C4)', () => {
  it('M2a: every new item id has a name string (item.<id>.name)', () => {
    const en = JSON.parse(readFileSync(join(ROOT, 'src/content/strings/en.json'), 'utf8')) as Record<string, unknown>;
    const ids = ['dmr', 'sniper', 'lmg', 'ammo_sniper', 'grenade', 'vest_1', 'vest_2', 'vest_3', 'helmet_1', 'helmet_2', 'helmet_3'];
    expect(ids.filter((id) => typeof en[`item.${id}.name`] !== 'string')).toEqual([]);
    // BUG-007 (fixed): the stale M1 `item.vest.*` strings are gone.
    expect(Object.keys(en).filter((k) => k.startsWith('item.vest.'))).toEqual([]);
  });

  const en = JSON.parse(readFileSync(join(ROOT, 'src/content/strings/en.json'), 'utf8')) as Record<string, unknown>;
  const keys = new Set(Object.keys(en));

  it('every literal t()/tRandom() key used in runtime code exists in en.json', () => {
    const re = /\bt(?:Random|Index)?\(\s*'([a-zA-Z0-9_.-]+)'/g;
    const missing: string[] = [];
    let used = 0;
    for (const f of runtimeFiles) {
      const src = readFileSync(f, 'utf8');
      for (let m = re.exec(src); m; m = re.exec(src)) {
        used++;
        const k = m[1]!;
        // tRandom/tIndex take a prefix whose variants are `<prefix>.<n>`.
        const ok = keys.has(k) || [...keys].some((x) => x.startsWith(`${k}.`));
        if (!ok) missing.push(`${relative(ROOT, f)}: ${k}`);
      }
    }
    expect(used).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });

  it('en.json values are non-empty strings and {placeholders} are well formed', () => {
    const bad: string[] = [];
    for (const [k, v] of Object.entries(en)) {
      if (k.startsWith('_')) continue;
      if (typeof v !== 'string' || v.trim() === '') bad.push(`${k}: empty or not a string`);
      else if ((v.match(/\{/g) ?? []).length !== (v.match(/\}/g) ?? []).length) bad.push(`${k}: unbalanced braces`);
    }
    expect(bad).toEqual([]);
  });
});
