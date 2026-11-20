import { describe, expect, it } from 'vitest';
import balanceJson from '../../docs/design/balance.json';
import { balanceForMap, deepMergeBalance, validateBalance, zoneThemeOf } from './balance';
import { ARMOR_IDS } from './types';

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(balanceJson)) as Record<string, unknown>;
/**
 * The shipped balance without its `maps` block. For tests that delete optional base sections: a `maps.<id>` override
 * of a deleted path is (correctly) rejected, which is not what those tests are about.
 */
const cloneBase = (): Record<string, unknown> => {
  const raw = clone();
  delete raw['maps'];
  return raw;
};

describe('validateBalance', () => {
  it('accepts the shipped balance.json', () => {
    expect(() => validateBalance(clone())).not.toThrow();
  });

  it('lists every missing required key', () => {
    const raw = clone();
    delete (raw['player'] as Record<string, unknown>)['maxHp'];
    delete (raw['net'] as Record<string, unknown>)['simHz'];
    expect(() => validateBalance(raw)).toThrow(/player\.maxHp[\s\S]*net\.simHz/);
  });

  // Contract revision 1: optional sections.
  it('accepts absent or partial optional sections', () => {
    const raw = cloneBase();
    delete raw['clientFeel'];
    expect(() => validateBalance(raw)).not.toThrow();
    raw['clientFeel'] = { cameraFovDeg: 75 };
    (raw['bots'] as Record<string, unknown>)['ai'] = { detourMs: 900 };
    ((raw['items'] as Record<string, Record<string, unknown>>)['medkit'])['preferAtOrBelowHp'] = 50;
    expect(validateBalance(raw).clientFeel?.cameraFovDeg).toBe(75);
  });

  it('rejects mistyped optional keys', () => {
    const raw = clone();
    raw['clientFeel'] = { cameraFovDeg: '75' };
    (raw['bots'] as Record<string, unknown>)['ai'] = 3;
    ((raw['items'] as Record<string, Record<string, unknown>>)['medkit'])['preferAtOrBelowHp'] = Number.NaN;
    expect(() => validateBalance(raw)).toThrow(/clientFeel\.cameraFovDeg[\s\S]*bots\.ai[\s\S]*items\.medkit\.preferAtOrBelowHp/);
  });

  // Revision 1b: bot pacing keys, personalities, loot scores, player.lowHpThreshold.
  it('accepts absent or partial revision 1b keys and types them', () => {
    const raw = cloneBase();
    const bots = raw['bots'] as Record<string, unknown>;
    for (const k of ['lootPhaseSeconds', 'avoidRange', 'personalities']) delete bots[k];
    delete (raw['player'] as Record<string, unknown>)['lowHpThreshold'];
    expect(() => validateBalance(raw)).not.toThrow();
    bots['lootPhaseSeconds'] = 60;
    bots['personalities'] = { cautious: { retreatBelowHp: 33 }, _note: 'comment keys are allowed' };
    bots['ai'] = { lootScoreVest: 12 };
    (raw['player'] as Record<string, unknown>)['lowHpThreshold'] = 25;
    const b = validateBalance(raw);
    expect(b.bots.lootPhaseSeconds).toBe(60);
    expect(b.bots.personalities?.cautious?.retreatBelowHp).toBe(33);
    expect(b.bots.ai?.lootScoreVest).toBe(12);
    expect(b.player.lowHpThreshold).toBe(25);
  });

  it('rejects mistyped revision 1b keys and unknown personalities', () => {
    const raw = clone();
    const bots = raw['bots'] as Record<string, unknown>;
    bots['retaliateMs'] = '4000';
    bots['personalities'] = { agressive: { share: 0.3 }, balanced: { share: null } };
    bots['ai'] = { lootDistanceFalloff: Number.POSITIVE_INFINITY };
    (raw['player'] as Record<string, unknown>)['lowHpThreshold'] = '30';
    expect(() => validateBalance(raw)).toThrow(
      /bots\.ai\.lootDistanceFalloff[\s\S]*bots\.retaliateMs[\s\S]*bots\.personalities\.agressive[\s\S]*bots\.personalities\.balanced\.share[\s\S]*player\.lowHpThreshold/,
    );
    bots['personalities'] = 5;
    expect(() => validateBalance(raw)).toThrow(/bots\.personalities must be an object/);
  });

  // M2a (ADR 0004): structure checks.
  it('rejects every missing M2a key', () => {
    const raw = clone();
    const w = (raw['weapons'] as Record<string, Record<string, unknown>>)['sniper'];
    delete w['adsTimeMs'];
    delete ((raw['items'] as Record<string, Record<string, unknown>>)['helmet_2'])['absorbFraction'];
    delete ((raw['items'] as Record<string, Record<string, unknown>>)['grenade'])['selfDamage'];
    const stances = (raw['movement'] as Record<string, Record<string, Record<string, unknown>>>)['stances'];
    delete stances['transitionMs']['prone_crouch'];
    delete ((raw['combat'] as Record<string, Record<string, unknown>>)['hitbox'])['proneLength'];
    delete (raw['armor'] as Record<string, unknown>)['dropOnDeath'];
    expect(() => validateBalance(raw)).toThrow(
      /armor\.dropOnDeath[\s\S]*weapons\.sniper\.adsTimeMs[\s\S]*items\.helmet_2\.absorbFraction[\s\S]*items\.grenade\.selfDamage[\s\S]*transitionMs\.prone_crouch[\s\S]*combat\.hitbox\.proneLength/,
    );
  });

  it('checks sights: fists none, guns not none, known values only', () => {
    const raw = clone();
    const weapons = raw['weapons'] as Record<string, Record<string, unknown>>;
    weapons['fists']['sight'] = 'iron';
    weapons['pistol']['sight'] = 'none';
    weapons['dmr']['sight'] = 'scope_6x';
    expect(() => validateBalance(raw)).toThrow(/weapons\.fists\.sight[\s\S]*weapons\.pistol\.sight[\s\S]*weapons\.dmr\.sight/);
  });

  it('checks armor slot, tier and ranges, and rejects the M1 vest', () => {
    const raw = clone();
    const items = raw['items'] as Record<string, Record<string, unknown>>;
    items['vest_2']['tier'] = 3;
    items['helmet_1']['slot'] = 'vest';
    items['helmet_3']['absorbFraction'] = 1;
    items['vest'] = { armor: 50 };
    expect(() => validateBalance(raw)).toThrow(/vest_2\.tier[\s\S]*helmet_1\.slot[\s\S]*helmet_3\.absorbFraction[\s\S]*items\.vest was removed/);
  });

  it('checks grenade radii and throw speeds, and stand height/eye against player', () => {
    const raw = clone();
    const g = (raw['items'] as Record<string, Record<string, unknown>>)['grenade'];
    g['innerRadius'] = 7;
    g['throwSpeedMin'] = 30;
    const stand = (raw['movement'] as Record<string, Record<string, Record<string, unknown>>>)['stances']['stand'];
    stand['eyeHeight'] = 1.1;
    expect(() => validateBalance(raw)).toThrow(/innerRadius[\s\S]*throwSpeedMin[\s\S]*stances\.stand\.eyeHeight must equal player\.eyeHeight/);
  });

  it('rejects unknown loot ids and unknown weaponPrefs keys, skipping _ keys', () => {
    const raw = clone();
    const tiers = (raw['loot'] as Record<string, Record<string, Record<string, unknown>>>)['tiers'];
    tiers['rare']['vest'] = 5;
    tiers['epic']['_comment'] = 'ignored';
    const bots = raw['bots'] as Record<string, Record<string, unknown>>;
    bots['weaponPrefs']['snipr'] = { minRange: 1, maxRange: 2, lootValue: 3 };
    bots['weaponPrefs']['_note2'] = 'ignored';
    bots['weaponPrefs']['dmr'] = { minRange: 90, maxRange: 80, lootValue: 3 };
    expect(() => validateBalance(raw)).toThrow(/loot\.tiers\.rare\.vest is not an ItemId[\s\S]*weaponPrefs\.dmr\.minRange[\s\S]*weaponPrefs\.snipr/);
  });

  it('accepts absent optional M2a bot blocks and types present ones', () => {
    const raw = cloneBase();
    const bots = raw['bots'] as Record<string, unknown>;
    for (const k of ['weaponPrefs', 'stance', 'grenade']) delete bots[k];
    // REVIEW-M2b M1: bots.ads stays, with only its required key.
    bots['ads'] = { scopedFireMinProgress: 0.9 };
    expect(() => validateBalance(raw)).not.toThrow();
    bots['grenade'] = { cookMs: 900 };
    bots['ads'] = { scopedFireMinProgress: 0.9, scopedVisionRange: 'far' };
    expect(() => validateBalance(raw)).toThrow(/bots\.ads\.scopedVisionRange/);
    bots['ads'] = { scopedFireMinProgress: 0.9 };
    expect(validateBalance(raw).bots.grenade?.cookMs).toBe(900);
  });

  it('REVIEW-M2b M1: bots.drop and bots.ads.scopedFireMinProgress are required', () => {
    const raw = cloneBase();
    const bots = raw['bots'] as Record<string, unknown>;
    delete bots['drop'];
    bots['ads'] = { minRange: 15 };
    expect(() => validateBalance(raw)).toThrow(/bots\.ads\.scopedFireMinProgress must be a number[\s\S]*bots\.drop must be an object/);
  });

  // M2a design invariants (systems/armor.md, combat.md "Sniper rules"). Tuning must keep these true.
  it('every armor piece keeps durability < maxHp x f / (1 - f)', () => {
    const b = validateBalance(clone());
    for (const id of ARMOR_IDS) {
      const { durability, absorbFraction: f } = b.items[id];
      expect(durability, id).toBeLessThan((b.player.maxHp * f) / (1 - f));
    }
  });

  it('sniper: body never kills, a bare head kills, a helmeted head is capped below maxHp', () => {
    const b = validateBalance(clone());
    const s = b.weapons.sniper;
    expect(s.damage).toBeLessThan(b.player.maxHp);
    expect(s.damage * s.headshotMultiplier).toBeGreaterThanOrEqual(b.player.maxHp);
    expect(b.combat.helmetHeadshotCap.weapons).toContain('sniper');
    expect(b.combat.helmetHeadshotCap.maxHpLoss).toBeLessThan(b.player.maxHp);
  });

  it('combat.helmetHeadshotCap is required and checked', () => {
    const raw = cloneBase() as Record<string, Record<string, unknown>>;
    raw['combat']!['helmetHeadshotCap'] = { weapons: ['laser'], maxHpLoss: -1 };
    expect(() => validateBalance(raw)).toThrow(/helmetHeadshotCap\.weapons[\s\S]*helmetHeadshotCap\.maxHpLoss/);
    const gone = cloneBase() as Record<string, Record<string, unknown>>;
    delete gone['combat']!['helmetHeadshotCap'];
    expect(() => validateBalance(gone)).toThrow(/combat\.helmetHeadshotCap/);
  });
});

describe('validateBalance: ADR 0004 addendum', () => {
  type Obj = Record<string, Record<string, Record<string, unknown>>>;
  it('requires adsTimeMs > 0 for sighted weapons (fists may keep 0)', () => {
    const raw = clone() as Obj;
    raw['weapons']!['rifle']!['adsTimeMs'] = 0;
    expect(() => validateBalance(raw)).toThrow(/weapons\.rifle\.adsTimeMs must be > 0/);
    const ok = clone() as Obj;
    expect(ok['weapons']!['fists']!['adsTimeMs']).toBe(0);
    expect(() => validateBalance(ok)).not.toThrow();
  });

  it('checks the optional items.grenade.dangerMargin and bots.ads.scopedFireMinProgress', () => {
    const raw = cloneBase() as Obj;
    raw['items']!['grenade']!['dangerMargin'] = -1;
    raw['bots']!['ads'] = { scopedFireMinProgress: 1.5 };
    expect(() => validateBalance(raw)).toThrow(/items\.grenade\.dangerMargin[\s\S]*bots\.ads\.scopedFireMinProgress/);
    const ok = cloneBase() as Obj;
    delete ok['items']!['grenade']!['dangerMargin'];
    ok['bots']!['ads'] = { scopedFireMinProgress: 0.9 };
    expect(validateBalance(ok).bots.ads?.scopedFireMinProgress).toBe(0.9);
  });
});

describe('M2b: maps overrides (ADR 0005 §4)', () => {
  type Obj = Record<string, unknown>;
  const OFFICE = {
    zoneTheme: 'sprinklers',
    match: { dropHeight: 25 },
    movement: { fallDamageMinSpeed: 18 },
    drop: { carrierAltitude: 25, carrierSpeed: 12 },
    zone: { startRadius: 140, phases: [{ waitSeconds: 75, shrinkSeconds: 45, radiusFraction: 0.68, dps: 1 }] },
    loot: { tiers: { common: { grenade: 7 }, epic: { sniper: 6 } } },
    bots: { visionRange: 40, ads: { scopedVisionRange: 60 } },
  };
  const withMaps = (maps: Obj): Obj => ({ ...clone(), maps });

  it('deep-merges objects key by key and replaces arrays and scalars wholesale', () => {
    const b = validateBalance(withMaps({ island01: { zoneTheme: 'tide' }, office: OFFICE }));
    const o = balanceForMap(b, 'office');
    expect(o.movement.fallDamageMinSpeed).toBe(18);
    expect(o.movement.walkSpeed).toBe(b.movement.walkSpeed);
    expect(o.drop.carrierAltitude).toBe(25);
    expect(o.drop.noJumpMs).toBe(b.drop.noJumpMs);
    expect(o.zone.phases).toHaveLength(1);
    expect(o.loot.tiers.common.grenade).toBe(7);
    expect(o.loot.tiers.common.bandage).toBe(b.loot.tiers.common.bandage);
    expect(o.bots.ads?.scopedVisionRange).toBe(60);
    expect(o.bots.ads?.minRange).toBe(b.bots.ads?.minRange);
    expect('maps' in o).toBe(false);
    // The base and the island are unchanged.
    expect(b.movement.fallDamageMinSpeed).not.toBe(18);
    expect(balanceForMap(b, 'island01').movement).toEqual(b.movement);
    expect(balanceForMap(b, 'unknown').zone).toEqual(b.zone);
  });

  it('resolves zone themes, with a kind fallback before the maps block exists', () => {
    const b = validateBalance(withMaps({ island01: { zoneTheme: 'tide' }, office: OFFICE }));
    expect(zoneThemeOf(b, 'office', 'indoor')).toBe('sprinklers');
    expect(zoneThemeOf(b, 'island01', 'island')).toBe('tide');
    const bare = validateBalance(cloneBase());
    expect(zoneThemeOf(bare, 'office', 'indoor')).toBe('sprinklers');
  });

  it('rejects a missing or unknown theme, unknown paths, forbidden paths and type changes', () => {
    const raw = withMaps({
      a: { match: { dropHeight: 25 } },
      b: { zoneTheme: 'fog' },
      c: { zoneTheme: 'tide', movement: { fallDamageMinSpeeed: 18 } },
      d: { zoneTheme: 'tide', net: { simHz: 60 } },
      e: { zoneTheme: 'tide', match: { countdownSeconds: 5 } },
      f: { zoneTheme: 'tide', zone: { phases: { waitSeconds: 1 } } },
      g: { zoneTheme: 'tide', armor: { dropOnDeath: 1 } },
    });
    let msg = '';
    try {
      validateBalance(raw);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/maps\.a\.zoneTheme/);
    expect(msg).toMatch(/maps\.b\.zoneTheme/);
    expect(msg).toMatch(/maps\.c\.movement\.fallDamageMinSpeeed does not exist/);
    expect(msg).toMatch(/maps\.d\.net may not be overridden/);
    expect(msg).toMatch(/maps\.e\.match\.countdownSeconds may not be overridden/);
    expect(msg).toMatch(/maps\.f\.zone\.phases must be an array/);
    expect(msg).toMatch(/maps\.g\.armor\.dropOnDeath must be a boolean/);
  });

  it('validates the merged result (an override can break a cross-key rule)', () => {
    const raw = withMaps({ office: { zoneTheme: 'sprinklers', items: { grenade: { innerRadius: 99 } } } });
    expect(() => validateBalance(raw)).toThrow(/maps\.office \(merged\): items\.grenade\.innerRadius/);
  });

  it('open records accept new ids; values are still checked', () => {
    const ok = withMaps({ office: { zoneTheme: 'sprinklers', loot: { tiers: { epic: { ammo_light: 3 } } } } });
    expect(() => validateBalance(ok)).not.toThrow();
    const bad = withMaps({ office: { zoneTheme: 'sprinklers', loot: { tiers: { epic: { laser: 3 } } } } });
    expect(() => validateBalance(bad)).toThrow(/maps\.office \(merged\): loot\.tiers\.epic\.laser is not an ItemId/);
  });

  it('deepMergeBalance never mutates its inputs and skips _ keys', () => {
    const base = { a: { b: 1, c: [1, 2] }, d: 2 };
    const ov = { a: { b: 5, c: [9] }, _note: 'x' };
    const out = deepMergeBalance(base, ov) as Obj;
    expect(out).toEqual({ a: { b: 5, c: [9] }, d: 2 });
    expect(base).toEqual({ a: { b: 1, c: [1, 2] }, d: 2 });
  });

  it('checks the drop section and the optional M2b blocks', () => {
    const raw = clone() as Record<string, Record<string, unknown>>;
    raw['drop']!['routeLateralFraction'] = 1;
    raw['drop']!['routeMaxTries'] = 0.5;
    (raw['bots'] as Obj)['nav'] = { cellSize: 0 };
    expect(() => validateBalance(raw)).toThrow(/drop\.routeLateralFraction[\s\S]*drop\.routeMaxTries[\s\S]*bots\.nav/);
  });
});

describe('M2b: rooms block', () => {
  const ROOMS = {
    defaultMaxHumans: 12, minMaxHumans: 1, maxMaxHumans: 16, fillWithBotsDefault: true, minHumansToStartWithBots: 1,
    minHumansToStartWithoutBots: 2, autoStartAllReadyMinHumans: 2, publicAutoStartMinHumans: 2,
    publicAutoStartSeconds: 60, nameMaxLength: 24, kickRejoinBlockSeconds: 120,
  };
  it('accepts the rooms.md proposal and checks the ordering rules', () => {
    expect(() => validateBalance({ ...clone(), rooms: ROOMS })).not.toThrow();
    expect(() => validateBalance({ ...clone(), rooms: { ...ROOMS, maxMaxHumans: 99 } })).toThrow(/rooms: need/);
    expect(() => validateBalance({ ...clone(), rooms: { ...ROOMS, minHumansToStartWithoutBots: 1 } })).toThrow(
      /minHumansToStartWithoutBots/,
    );
  });
  it('rooms may not be overridden per map', () => {
    const raw = { ...clone(), rooms: ROOMS, maps: { office: { zoneTheme: 'sprinklers', rooms: { nameMaxLength: 5 } } } };
    expect(() => validateBalance(raw)).toThrow(/maps\.office\.rooms may not be overridden/);
  });
});

describe('M2b: prone pitch clamp keys', () => {
  type Obj = Record<string, Record<string, Record<string, unknown>>>;
  it('requires both keys (C-gate) and rejects an out-of-range pair', () => {
    const ok = clone() as Obj;
    Object.assign(ok['movement']!['stances']!, { pronePitchMinDeg: -30, pronePitchMaxDeg: 45 });
    expect(validateBalance(ok).movement.stances.pronePitchMaxDeg).toBe(45);
    const half = clone() as Obj;
    half['movement']!['stances']!['pronePitchMinDeg'] = -30;
    delete half['movement']!['stances']!['pronePitchMaxDeg'];
    expect(() => validateBalance(half)).toThrow(/movement\.stances\.pronePitchMaxDeg must be a number/);
    const wide = clone() as Obj;
    Object.assign(wide['movement']!['stances']!, { pronePitchMinDeg: -90, pronePitchMaxDeg: 45 });
    expect(() => validateBalance(wide)).toThrow(/pronePitchMinDeg\/MaxDeg/);
  });
});

describe('M2b: first-person clientFeel keys', () => {
  it('checks fp numbers and fpRecoil per gun', () => {
    const raw = clone() as Record<string, Record<string, unknown>>;
    raw['clientFeel']!['vmBobFactor'] = 'big';
    raw['clientFeel']!['fpRecoil'] = { laser: {}, rifle: { kickBack: 0.02 } };
    expect(() => validateBalance(raw)).toThrow(/clientFeel\.vmBobFactor[\s\S]*fpRecoil\.laser is not a gun[\s\S]*fpRecoil\.rifle\.kickPitchDeg/);
  });
});
