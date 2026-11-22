/**
 * M2c shared contract tests (ADR 0007): the merged balance validates, the validator's M2c rules, the effective-stat
 * helpers against the spec numbers, smoke and rocket geometry, deterministic math and the layout helpers.
 */
import { describe, expect, it } from 'vitest';
import balanceJson from '../../docs/design/balance.json';
import {
  balanceForMap,
  compatibleScopes,
  deepMergeBalance,
  effectiveSight,
  effectiveWeapon,
  hasScopeOverlay,
  levelMultiplier,
  M2C_BALANCE_REQUIRED,
  rocketBlastMaxDamage,
  sightRank,
  validateBalance,
  type Balance,
  type SmokeCloudBalance,
} from './balance';
import { atan2Det, atanDet, cosRad, degToStep, detCos, detSin, fnv1a32, hypot2, mixSeed, radToStep, sinRad, stepToRad, streamSeed, TURN_STEPS } from './detmath';
import { countRepeatedPicks, formatLayoutSeed, layoutHash, layoutSeedFor, parseLayoutSeed } from './layout';
import { glassPanes, wallFrame } from './maps';
import { rocketPosAt, rocketVelAt } from './rocket';
import { pointInSmoke, segmentBlockedBySmoke, smokeGoneAt, smokeRadiusAt } from './smoke';
import type { IndoorMapData, LootSpawn, PropPlacement, RocketState, SmokeCloudState } from './types';

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The live balance.json with `_m2cPending` deep-merged into the root (objects key by key, arrays replace). */
function merged(): Json {
  const raw = clone(balanceJson) as Json;
  const pending = raw['_m2cPending'];
  delete raw['_m2cPending'];
  return (pending === undefined ? raw : deepMergeBalance(raw, pending)) as Json;
}
const errorsOf = (raw: unknown): string => {
  try {
    validateBalance(raw);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
};
const at = (o: Json, path: string): Json => path.split('.').reduce<Json>((a, k) => a[k] as Json, o);

describe('M2c balance: merge of _m2cPending', () => {
  it('the live file validates as is (with or without _m2cPending)', () => {
    expect(errorsOf(clone(balanceJson))).toBe('');
  });

  it('the live file has merge step 1 in (every new block) and _m2cPending holds only the step-2 keys', () => {
    const live = clone(balanceJson) as Json;
    expect(errorsOf(live)).toBe('');
    for (const p of ['levels', 'scopes', 'layout', 'loot.guaranteedWeapon', 'items.smoke', 'items.ammo_rocket',
      'items.vest_4', 'items.helmet_4', 'weapons.knife', 'weapons.machete', 'weapons.paddle', 'weapons.dbshotgun',
      'weapons.revolver', 'weapons.rpg', 'bots.melee', 'bots.rpg', 'bots.smoke', 'bots.scopes']) {
      expect(at(live, p), p).toBeDefined();
    }
    expect(at(live, 'combat').throwableCycleMs).toBeTypeOf('number');
    const pending = live['_m2cPending'] as Json | undefined;
    if (pending !== undefined) {
      const keys = Object.keys(pending).filter((k) => !k.startsWith('_')).sort();
      expect(keys.every((k) => ['bots', 'loot', 'maps'].includes(k)), keys.join(',')).toBe(true);
    }
  });

  it('the live file with _m2cPending deep-merged validates, including every maps.<id> merged balance', () => {
    expect(errorsOf(merged())).toBe('');
  });

  it('the merged file has the M2c blocks the C-gate will require', () => {
    const m = merged();
    for (const p of ['levels', 'scopes', 'layout', 'loot.guaranteedWeapon', 'items.smoke', 'items.ammo_rocket',
      'items.vest_4', 'items.helmet_4', 'weapons.knife', 'weapons.machete', 'weapons.paddle', 'weapons.dbshotgun',
      'weapons.revolver', 'weapons.rpg', 'bots.melee', 'bots.rpg', 'bots.smoke', 'bots.scopes']) {
      expect(at(m, p), p).toBeDefined();
    }
    expect(at(m, 'combat').throwableCycleMs).toBeTypeOf('number');
  });

  it('the C-gate is done: the M2c blocks are required', () => {
    expect(M2C_BALANCE_REQUIRED).toBe(true);
    const m = merged();
    delete m['levels'];
    expect(errorsOf(m)).toContain('levels is required (M2c)');
  });
});

describe('M2c balance: validator rules (levels.md, scopes.md, melee.md, rpg.md, smoke.md)', () => {
  const bad = (mut: (m: Json) => void): string => {
    const m = merged();
    mut(m);
    return errorsOf(m);
  };
  it('levels arrays: length 4, L1 exactly 1, entries in [0.5, 2], no fists override, known fields only', () => {
    expect(bad((m) => (at(m, 'levels.gun').damage = [1, 1.1, 1.2]))).toContain('levels.gun.damage must be an array of 4');
    expect(bad((m) => (at(m, 'levels.gun').damage = [1.1, 1.1, 1.2, 1.3]))).toContain('(L1) must be exactly 1');
    expect(bad((m) => (at(m, 'levels.melee').damage = [1, 1, 1, 2.5]))).toContain('must be in [0.5, 2]');
    expect(bad((m) => (at(m, 'levels.overrides').fists = { damage: [1, 1, 1, 1] }))).toContain('levels.overrides.fists');
    expect(bad((m) => (at(m, 'levels.gun').magSize = [1, 1, 1, 1]))).toContain('is not a level field');
    expect(bad((m) => (at(m, 'levels.lootTiers').epic = [0, 0, 0, 0]))).toContain('positive sum');
  });
  it('melee: sight none, ammo null, magSize 0, 0 < hitFrameMs < fireIntervalMs', () => {
    expect(bad((m) => (at(m, 'weapons.knife').sight = 'iron'))).toContain("weapons.knife.sight must be 'none'");
    expect(bad((m) => (at(m, 'weapons.knife').ammo = 'ammo_light'))).toContain('weapons.knife.ammo must be null');
    expect(bad((m) => (at(m, 'weapons.paddle').hitFrameMs = 1000))).toContain('hitFrameMs must be in (0, fireIntervalMs)');
    expect(bad((m) => (at(m, 'weapons.machete').magSize = 2))).toContain('weapons.machete.magSize must be 0');
    // Guns still may not use 'none'.
    expect(bad((m) => (at(m, 'weapons.revolver').sight = 'none'))).toContain("weapons.revolver.sight must not be 'none'");
  });
  it('rpg: mag 1, rocket speed > 0, blast innerRadius < radius', () => {
    expect(bad((m) => (at(m, 'weapons.rpg').magSize = 2))).toContain('weapons.rpg.magSize must be 1');
    expect(bad((m) => (at(m, 'weapons.rpg.rocket').speed = 0))).toContain('rocket.speed must be > 0');
    expect(bad((m) => (at(m, 'weapons.rpg.rocket.blast').innerRadius = 9))).toContain('rocket.blast.innerRadius');
  });
  it('scopes: compatible lists hold ScopeIds that are not the built-in sight; ranks unique; zoom >= 1', () => {
    expect(bad((m) => (at(m, 'scopes.compatible').rifle = ['scope_red_dot']))).toContain('built-in sight');
    expect(bad((m) => (at(m, 'scopes.compatible').rifle = ['scope_16x']))).toContain('is not a ScopeId');
    expect(bad((m) => (at(m, 'scopes.compatible').knife = ['scope_red_dot']))).toContain('only guns take scopes');
    expect(bad((m) => (at(m, 'scopes.sightFactors.scope_2x').rank = 1))).toContain('is not unique');
    expect(bad((m) => (at(m, 'scopes.scope_2x').zoom = 0.5))).toContain('scopes.scope_2x.zoom must be >= 1');
  });
  it('smoke, armor tier 4, loot ids, guaranteed weapons', () => {
    expect(bad((m) => (at(m, 'items.smoke.cloud').maxActive = 0))).toContain('maxActive must be an integer >= 1');
    expect(bad((m) => (at(m, 'items.vest_4').tier = 3))).toContain('items.vest_4.tier must be 4');
    expect(bad((m) => (at(m, 'loot.tiers.epic').laser = 1))).toContain('loot.tiers.epic.laser is not an ItemId');
    expect(bad((m) => (at(m, 'loot.guaranteedWeapon.weights').knife = 1))).toContain('guaranteedWeapon.weights.knife is not a gun');
  });
});

describe('M2c effective stats (spec acceptance numbers)', () => {
  const b = validateBalance(merged());
  const close = (a: number, e: number, eps = 1e-9): void => expect(Math.abs(a - e)).toBeLessThan(eps);

  it('L1 with no scope equals the base entry exactly (levels.md test 1, scopes.md test 1)', () => {
    for (const id of ['pistol', 'smg', 'rifle', 'lmg', 'dmr', 'sniper', 'shotgun', 'revolver', 'dbshotgun', 'rpg', 'knife'] as const) {
      const e = effectiveWeapon(b, id);
      const w = (b.weapons as unknown as Record<string, Record<string, unknown>>)[id]!;
      for (const k of ['damage', 'reloadMs', 'fireIntervalMs', 'spreadDeg', 'adsZoom', 'adsTimeMs', 'adsSpreadMultiplier', 'adsMoveMultiplier']) {
        expect((e as unknown as Record<string, unknown>)[k], `${id}.${k}`).toBe(w[k]);
      }
      expect(e.sight).toBe(w['sight']);
    }
  });
  it('levels: rifle reload L4 2040; pistol L4 30; shotgun L4 pellet 13, pump 765; DMR L4 50.6; knife L4 51.25 / 280 / 80', () => {
    close(effectiveWeapon(b, 'rifle', 4).reloadMs, 2040);
    close(effectiveWeapon(b, 'pistol', 4).damage, 30);
    close(effectiveWeapon(b, 'shotgun', 4).damage, 13);
    close(effectiveWeapon(b, 'shotgun', 4).fireIntervalMs, 765);
    close(effectiveWeapon(b, 'dmr', 4).damage, b.weapons.dmr.damage * 1.15); // 44 x 1.15 = 50.6 (v9)
    close(effectiveWeapon(b, 'dmr', 4).damage, 50.6);
    const k = effectiveWeapon(b, 'knife', 4);
    close(k.damage, 51.25);
    close(k.fireIntervalMs, 280);
    close(k.hitFrameMs, 80);
    expect(levelMultiplier(b, 'fists', 'damage', 4)).toBe(1);
    close(rocketBlastMaxDamage(b, 4), 151.8);
  });
  it('scopes: rifle + 4x 345 ms, zoom 4, ADS cone 0.674; DMR + red dot 200 ms; sniper + 4x 315.8 ms', () => {
    const r = effectiveWeapon(b, 'rifle', 1, 'scope_4x');
    expect(r.sight).toBe('scope_4x');
    expect(r.adsZoom).toBe(4);
    close(r.adsTimeMs, 345);
    expect(Math.abs(r.spreadDeg * r.adsSpreadMultiplier - 0.674)).toBeLessThan(0.001);
    close(effectiveWeapon(b, 'dmr', 1, 'scope_red_dot').adsTimeMs, 200);
    expect(Math.abs(effectiveWeapon(b, 'sniper', 1, 'scope_4x').adsTimeMs - 315.8)).toBeLessThan(0.1);
    // A scope that does not fit is ignored.
    expect(effectiveWeapon(b, 'pistol', 1, 'scope_8x').sight).toBe('iron');
    expect(effectiveSight(b, 'smoke')).toBe('none');
    expect(effectiveSight(b, 'rifle', 'scope_2x')).toBe('scope_2x');
    expect(compatibleScopes(b, 'knife')).toEqual([]);
    expect(sightRank(b, 'scope_8x')).toBeGreaterThan(sightRank(b, 'red_dot'));
    expect(hasScopeOverlay('scope_2x') && !hasScopeOverlay('red_dot')).toBe(true);
  });
  it('a balance without levels or scopes (an old fixture) resolves to the base numbers', () => {
    // Own fixture: the live file minus the M2c level and scope blocks. Not validated (they are required since the
    // C-gate); the helpers must still degrade to the base numbers for hand-built test balances.
    const raw = clone(balanceJson) as Json;
    delete raw['levels'];
    delete raw['scopes'];
    const pre = raw as unknown as Balance;
    expect(effectiveWeapon(pre, 'rifle', 4, 'scope_4x').damage).toBe(pre.weapons.rifle.damage);
    expect(effectiveWeapon(pre, 'rifle', 4, 'scope_4x').sight).toBe(pre.weapons.rifle.sight);
  });
  it('per-map merged balance keeps the office guaranteed-weapon override', () => {
    const office = balanceForMap(b, 'office');
    expect(office.loot.guaranteedWeapon?.weights.smg).toBe(15);
    expect(office.layout?.lootUsedPerTier.epic).toBe(8);
  });
});

describe('smoke cloud shape and visibility (smoke.md tests 4, 5)', () => {
  const cfg: SmokeCloudBalance = { radius: 6.5, centerHeight: 1.2, growMs: 1500, holdMs: 18000, fadeMs: 3000, closeSightRange: 2, maxActive: 12 };
  const c: SmokeCloudState = { id: 7, ownerId: 1, pos: { x: 0, y: 0, z: 0 }, deployedAt: 1000, fadeAt: 1000 + 1500 + 18000 };
  it('radius over time', () => {
    expect(smokeRadiusAt(c, 1000, cfg)).toBe(0);
    expect(smokeRadiusAt(c, 1750, cfg)).toBeCloseTo(3.25, 9);
    expect(smokeRadiusAt(c, 2500, cfg)).toBe(6.5);
    expect(smokeRadiusAt(c, 20500, cfg)).toBe(6.5);
    expect(smokeRadiusAt(c, 22000, cfg)).toBeCloseTo(3.25, 9);
    expect(smokeRadiusAt(c, 23500, cfg)).toBe(0);
    expect(smokeGoneAt(c, cfg)).toBe(23500);
    // A forced fade (maxActive) during the hold fades from the full radius.
    expect(smokeRadiusAt({ ...c, fadeAt: 5000 }, 6500, cfg)).toBeCloseTo(3.25, 9);
  });
  it('segment vs sphere, closeSightRange, inside test', () => {
    const t = 10_000;
    const a = { x: -10, y: 1.2, z: 0 };
    const b2 = { x: 10, y: 1.2, z: 0 };
    expect(segmentBlockedBySmoke([c], a, b2, t, cfg)).toBe(true);
    const off = { ...c, pos: { x: 0, y: 0, z: 7 } };
    expect(segmentBlockedBySmoke([off], a, b2, t, cfg)).toBe(false);
    expect(segmentBlockedBySmoke([c], { x: 0, y: 1.2, z: 0 }, { x: 1.5, y: 1.2, z: 0 }, t, cfg)).toBe(false);
    expect(segmentBlockedBySmoke([c], { x: 0, y: 1.2, z: 0 }, { x: 3, y: 1.2, z: 0 }, t, cfg)).toBe(true);
    expect(segmentBlockedBySmoke([], a, b2, t, cfg)).toBe(false);
    expect(pointInSmoke([c], { x: 1, y: 1, z: 1 }, t, cfg)).toBe(true);
    expect(pointInSmoke([c], { x: 1, y: 1, z: 1 }, 30_000, cfg)).toBe(false);
  });
});

describe('rocket kinematics (rpg.md test 1)', () => {
  const r: RocketState = { id: 3, ownerId: 1, level: 1, pos: { x: 0, y: 1.05, z: 0 }, vel: { x: 0, y: 0, z: -45 }, firedAt: 5000 };
  it('closed form: falls 1.05 m after sqrt(2 x 1.05 / 1.5) s', () => {
    const tHit = Math.sqrt((2 * 1.05) / 1.5);
    const p = rocketPosAt(r, 5000 + tHit * 1000, 1.5);
    expect(p.y).toBeCloseTo(0, 9);
    expect(p.z).toBeCloseTo(-45 * tHit, 9);
    expect(rocketVelAt(r, 6000, 1.5).y).toBeCloseTo(-1.5, 12);
    expect(rocketPosAt(r, 4000, 1.5)).toEqual(r.pos);
  });
});

describe('deterministic math (ADR 0007 §1.4)', () => {
  it('detSin/detCos match Math.sin/cos to 1e-15 on every step, and the table is exact on the axes', () => {
    for (let k = 0; k < TURN_STEPS; k++) {
      const a = (2 * Math.PI * k) / TURN_STEPS;
      expect(Math.abs(detSin(k) - Math.sin(a))).toBeLessThan(1e-15);
      expect(Math.abs(detCos(k) - Math.cos(a))).toBeLessThan(1e-15);
    }
    expect([detSin(0), detCos(0), detSin(256), detCos(512), detSin(768)]).toEqual([0, 1, 1, -1, -1]);
    expect(detSin(-256)).toBe(detSin(768));
    expect(degToStep(90)).toBe(256);
    expect(radToStep(-Math.PI / 2)).toBe(768);
    expect(stepToRad(512)).toBeCloseTo(Math.PI, 15);
  });
  it('golden values pin the table, the hash and the seed mixer (a change here breaks every layout hash)', () => {
    expect(detSin(100)).toBe(0.5758081914178453);
    expect(detCos(333)).toBe(-0.45508358712634384);
    expect(fnv1a32('arr:summit')).toBe(4160255393);
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(mixSeed(1, 2)).toBe(3877896421);
    expect(layoutSeedFor(0x5eed0001)).toBe(1456380908);
    expect(streamSeed(42, 'loot:beach')).toBe(mixSeed(42, fnv1a32('loot:beach')));
  });
  it('arbitrary-angle helpers: within 2e-16 of Math, Math.atan2 signed zeros, golden values', () => {
    for (let i = -2000; i <= 2000; i++) {
      const a = i * 0.0137;
      expect(Math.abs(sinRad(a) - Math.sin(a))).toBeLessThan(2e-16 * Math.max(1, Math.abs(a)));
      expect(Math.abs(cosRad(a) - Math.cos(a))).toBeLessThan(2e-16 * Math.max(1, Math.abs(a)));
      const y = Math.sin(i) * 37;
      const x = Math.cos(i * 1.3) * 41;
      expect(Math.abs(atan2Det(y, x) - Math.atan2(y, x))).toBeLessThan(1e-15);
      expect(Math.abs(hypot2(x, y) - Math.hypot(x, y))).toBeLessThan(1e-13);
    }
    for (const [y, x] of [[0, 1], [-0, 1], [0, -1], [-0, -1], [1, 0], [-1, 0], [0, 0], [-0, 0], [0, -0], [-0, -0]] as const) {
      expect(Object.is(atan2Det(y, x), Math.atan2(y, x))).toBe(true);
    }
    expect(Object.is(atanDet(-0), -0)).toBe(true);
    expect(hypot2(-3.37, 0)).toBe(3.37);
    // Golden values (a change here can move level data built at module load and therefore layout hashes).
    expect(sinRad(1)).toBe(0.8414709848078965);
    expect(cosRad(2.5)).toBe(-0.8011436155469337);
    expect(atan2Det(1, 3)).toBe(0.32175055439664213);
    expect(atan2Det(-2, -0.5)).toBe(-1.8157749899217608);
  });
  it('wallFrame is deterministic and, for axis-aligned walls, bit-identical to the Math version (signed zeros too)', () => {
    for (const [x1, z1, x2, z2] of [[0, 0, 7.25, 0], [7.25, 0, 0, 0], [3.1, -2, 3.1, 9.45], [3.1, 9.45, 3.1, -2], [-12.34, 5.6, 8.9, 5.6]]) {
      const f = wallFrame({ x1, z1, x2, z2, thickness: 0.2, bottom: 0, top: 3, material: 'solid' });
      expect(Object.is(f.rotY, Math.atan2(-(z2 - z1), x2 - x1))).toBe(true);
      expect(f.halfLength).toBe(Math.hypot(x2 - x1, z2 - z1) / 2);
    }
    const d = wallFrame({ x1: 0, z1: 0, x2: 3, z2: 4, thickness: 0.2, bottom: 0, top: 3, material: 'glass' });
    expect(d.halfLength).toBe(2.5);
    expect(d.rotY).toBe(atan2Det(-4, 3));
  });
});

describe('layout helpers (variety.md §2)', () => {
  it('seed derivation, parsing and display', () => {
    expect(layoutSeedFor(123)).toBe(mixSeed(123, 0x4c41594f));
    expect(layoutSeedFor(123, 1)).not.toBe(layoutSeedFor(123));
    expect(parseLayoutSeed('4821')).toBe(4821);
    expect(parseLayoutSeed('0x3FA2C1D0')).toBe(0x3fa2c1d0);
    expect(parseLayoutSeed('baseline')).toBe(0);
    expect(parseLayoutSeed('')).toBeNull();
    expect(parseLayoutSeed('-1')).toBeNull();
    expect(parseLayoutSeed('4294967296')).toBeNull();
    expect(formatLayoutSeed(0x3fa2c1d0)).toBe('0x3FA2C1D0');
  });
  it('hash: canonical (mm / mrad / cm), order sensitive, ignores render variants', () => {
    const props: PropPlacement[] = [{ kind: 'palm', x: 1.0004, z: -2, rotY: 0.5, scale: 1.2 }];
    const loot: LootSpawn[] = [{ x: 3, z: 4, tier: 'common', guarantee: 'weapon' }];
    const h = layoutHash(props, loot);
    expect(layoutHash([{ ...props[0]!, x: 1.0001, variant: 2 }], loot)).toBe(h);
    expect(layoutHash(props, [{ ...loot[0]!, guarantee: undefined }])).not.toBe(h);
    expect(layoutHash([...props, ...props], loot)).not.toBe(h);
  });
  it('repeat count', () => {
    const a = [{ zone: 'summit', variant: 'beacon' }, { zone: 'dock', variant: 'quay' }];
    expect(countRepeatedPicks(a, [{ zone: 'summit', variant: 'beacon' }, { zone: 'dock', variant: 'stacks' }])).toBe(1);
  });
});

describe('glass panes (ADR 0007 §8)', () => {
  it('glass walls in order, then glass kit parts in prop order', () => {
    const map = {
      kind: 'indoor',
      walls: [
        { x1: 0, z1: 0, x2: 4, z2: 0, thickness: 0.2, bottom: 0, top: 3, material: 'glass' },
        { x1: 0, z1: 0, x2: 0, z2: 4, thickness: 0.2, bottom: 0, top: 3, material: 'solid' },
        { x1: 4, z1: 0, x2: 8, z2: 0, thickness: 0.2, bottom: 0, top: 3, material: 'glass' },
      ],
      props: [{ kind: 'booth', x: 0, y: 0, z: 0, rotY: 0, scale: 1 }],
      kit: { booth: { origin: 'floor', size: [1, 1, 1], colliders: [
        { type: 'box', name: 'a', min: [0, 0, 0], max: [1, 1, 1] },
        { type: 'box', name: 'g', min: [0, 0, 0], max: [1, 1, 1], glass: true },
      ] } },
    } as unknown as IndoorMapData;
    expect(glassPanes(map)).toEqual([{ id: 0, wall: 0 }, { id: 1, wall: 2 }, { id: 2, prop: 0, part: 1 }]);
  });
});
