import { describe, expect, it } from 'vitest';
import { hasKey, keysWithPrefix, t } from '../content/strings';
import type { AdsView, HudArmorView, HudZoneView } from '../shared/contracts';
import { MAX_NAME_LENGTH } from '../shared/constants';
import {
  actionFailedKey,
  adsReticle,
  aliveAnnouncement,
  armorPromptDetail,
  armorRefused,
  cookView,
  dangerPlacement,
  dangerScale,
  deathCauseKey,
  gearView,
  hitVariant,
  isGrenadeFeedPrefix,
  isSelfGrenadeKill,
  stanceView,
  connectionErrorKey,
  fitProjection,
  formatClock,
  graphicsStatusView,
  hitVignetteStrength,
  isHeavyHit,
  isLowHp,
  itemCategory,
  killFeedPrefix,
  layoutMapLabels,
  LOW_HP_THRESHOLD,
  lowHpThresholdOf,
  minimapPoiLabel,
  MessageQueue,
  minimapArrowRotation,
  pickupPromptChoice,
  pickVariantKey,
  projectXZ,
  ratio,
  relativeBearingDeg,
  sanitizeName,
  selectScreen,
  splitTemplate,
  spreadToPx,
  tidePhaseNumbers,
  tideStatus,
  validateName,
  wrapLabel,
  type ScreenInputs,
} from './logic';

describe('names', () => {
  it('trims, strips control chars and caps length', () => {
    expect(sanitizeName('  Pat  ')).toBe('Pat');
    expect(sanitizeName('a\u0000b\u001fc\u007f')).toBe('abc');
    expect(sanitizeName('x'.repeat(40))).toHaveLength(MAX_NAME_LENGTH);
  });

  it('caps by code point so emoji are not split', () => {
    const name = sanitizeName('🌴'.repeat(20));
    expect(Array.from(name)).toHaveLength(MAX_NAME_LENGTH);
    expect(name).not.toMatch(/\uD83C$/);
  });

  it('rejects empty / whitespace names', () => {
    expect(validateName('')).toBeNull();
    expect(validateName('   \t ')).toBeNull();
    expect(validateName(' Mango ')).toBe('Mango');
  });
});

describe('formatClock', () => {
  it('formats m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(600)).toBe('10:00');
  });
  it('clamps junk', () => {
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(9.9)).toBe('0:09');
  });
});

describe('ratio', () => {
  it('clamps to 0..1 and handles max 0', () => {
    expect(ratio(50, 100)).toBe(0.5);
    expect(ratio(150, 100)).toBe(1);
    expect(ratio(-1, 100)).toBe(0);
    expect(ratio(10, 0)).toBe(0);
  });
});

describe('relativeBearingDeg', () => {
  const at = { x: 0, z: 0 };
  it('yaw 0 looks toward -Z', () => {
    expect(relativeBearingDeg(at, 0, { x: 0, z: -10 })).toBeCloseTo(0);
    expect(relativeBearingDeg(at, 0, { x: 10, z: 0 })).toBeCloseTo(90);
    expect(relativeBearingDeg(at, 0, { x: -10, z: 0 })).toBeCloseTo(-90);
    expect(Math.abs(relativeBearingDeg(at, 0, { x: 0, z: 10 }) ?? 0)).toBeCloseTo(180);
  });

  it('accounts for the viewer yaw (yaw +90deg looks toward -X)', () => {
    const yaw = Math.PI / 2;
    expect(relativeBearingDeg(at, yaw, { x: -10, z: 0 })).toBeCloseTo(0);
    // Right vector at yaw 90deg = (cos, -sin) = (0, -1) → -Z is to the right.
    expect(relativeBearingDeg(at, yaw, { x: 0, z: -10 })).toBeCloseTo(90);
  });

  it('is relative to the viewer position', () => {
    expect(relativeBearingDeg({ x: 5, z: 5 }, 0, { x: 5, z: 0 })).toBeCloseTo(0);
  });

  it('returns a value in (-180, 180] and null for coincident points', () => {
    expect(relativeBearingDeg(at, 0, at)).toBeNull();
    for (let i = 0; i < 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const d = relativeBearingDeg(at, 1.234, { x: Math.cos(a), z: Math.sin(a) }) ?? 0;
      expect(d).toBeGreaterThan(-180);
      expect(d).toBeLessThanOrEqual(180);
    }
  });

  it('agrees with the minimap arrow rotation (north-up, clockwise canvas rotation)', () => {
    // An arrow drawn pointing up, rotated by θ clockwise, points along (sin θ, -cos θ) in canvas px (x right, y = +Z down).
    for (const yaw of [0, 0.5, Math.PI / 2, -2]) {
      const th = minimapArrowRotation(yaw);
      const dir = { x: Math.sin(th), z: -Math.cos(th) };
      expect(relativeBearingDeg(at, yaw, dir)).toBeCloseTo(0);
    }
  });
});

describe('spreadToPx', () => {
  it('is 0 for no spread and grows with spread', () => {
    expect(spreadToPx(0, 70, 1080)).toBe(0);
    const a = spreadToPx(1, 70, 1080);
    const b = spreadToPx(4, 70, 1080);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 3.9);
  });
  it('half the FOV maps to half the viewport height', () => {
    expect(spreadToPx(35, 70, 1000)).toBeCloseTo(500);
  });
  it('rejects bad input', () => {
    expect(spreadToPx(2, 0, 1000)).toBe(0);
    expect(spreadToPx(2, 70, 0)).toBe(0);
  });
});

describe('selectScreen', () => {
  const base: ScreenInputs = { joinRequested: true, connection: 'connected', joined: true, phase: 'lobby', resultsDismissed: false };
  it('walks the flow', () => {
    expect(selectScreen({ ...base, joinRequested: false })).toBe('title');
    expect(selectScreen({ ...base, connection: 'connecting', joined: false })).toBe('connecting');
    expect(selectScreen({ ...base, connection: 'idle', joined: false })).toBe('connecting');
    expect(selectScreen({ ...base, joined: false })).toBe('connecting');
    expect(selectScreen(base)).toBe('lobby');
    expect(selectScreen({ ...base, phase: 'countdown' })).toBe('lobby');
    expect(selectScreen({ ...base, phase: 'playing' })).toBe('match');
    expect(selectScreen({ ...base, phase: 'results' })).toBe('results');
    expect(selectScreen({ ...base, phase: 'results', resultsDismissed: true })).toBe('lobby');
  });
  it('connection loss wins over everything after Play', () => {
    expect(selectScreen({ ...base, connection: 'disconnected', phase: 'playing' })).toBe('connectionLost');
    expect(selectScreen({ ...base, connection: 'error', joined: false })).toBe('connectionLost');
    expect(selectScreen({ ...base, connection: 'error', joinRequested: false })).toBe('title');
  });
});

describe('connectionErrorKey', () => {
  it('maps server reasons', () => {
    expect(connectionErrorKey('full', false)).toBe('menu.connection.full');
    expect(connectionErrorKey('bad_version', true)).toBe('menu.connection.version');
    expect(connectionErrorKey('bad_name', false)).toBe('menu.name.invalid');
    expect(connectionErrorKey(undefined, true)).toBe('menu.connection.lost');
    expect(connectionErrorKey('socket closed', false)).toBe('menu.connection.failed');
  });
});

describe('kill feed', () => {
  const k = { killerName: 'Pat', victimName: 'Sue', weapon: 'rifle' as const, cause: 'weapon' as const };

  it('selects the variant group', () => {
    expect(killFeedPrefix(k, false)).toBe('feed.kill');
    expect(killFeedPrefix(k, true)).toBe('feed.headshot');
    expect(killFeedPrefix({ ...k, weapon: 'fists' }, true)).toBe('feed.melee');
    expect(killFeedPrefix({ ...k, cause: 'zone' }, false)).toBe('feed.zone');
    expect(killFeedPrefix({ ...k, cause: 'fall' }, false)).toBe('feed.fall');
    expect(killFeedPrefix({ ...k, killerName: null }, false)).toBe('feed.generic');
    expect(killFeedPrefix({ ...k, weapon: null }, false)).toBe('feed.generic');
    // M2a grenades
    expect(killFeedPrefix({ ...k, weapon: 'grenade', cause: 'explosion' }, false)).toBe('feed.grenade');
    expect(killFeedPrefix({ ...k, weapon: 'grenade', cause: 'explosion', self: true }, false)).toBe('feed.grenadeSelf');
    expect(killFeedPrefix({ ...k, killerName: null, weapon: 'grenade', cause: 'explosion', self: true }, false)).toBe(
      'feed.grenadeSelf',
    );
    expect(isGrenadeFeedPrefix('feed.grenade') && isGrenadeFeedPrefix('feed.grenadeSelf')).toBe(true);
    expect(isGrenadeFeedPrefix('feed.kill')).toBe(false);
    for (const p of ['feed.grenade', 'feed.grenadeSelf']) expect(keysWithPrefix(p).length).toBeGreaterThan(0);
  });

  it('every group used by the feed has at least one string', () => {
    for (const p of ['feed.kill', 'feed.headshot', 'feed.melee', 'feed.zone', 'feed.fall', 'feed.generic']) {
      expect(pickVariantKey(p, () => 0)).not.toBe(p);
    }
  });

  it('picks variants deterministically from the rng, within bounds', () => {
    expect(pickVariantKey('feed.kill', () => 0)).toBe('feed.kill.0');
    expect(pickVariantKey('feed.kill', () => 0.9999)).toMatch(/^feed\.kill\.\d+$/);
    expect(hasKey(pickVariantKey('feed.kill', () => 0.9999))).toBe(true);
    expect(pickVariantKey('nope.missing', () => 0.5)).toBe('nope.missing');
  });

  it('splits templates into literal and variable parts', () => {
    const parts = splitTemplate('{killer} splashed {victim} with a {weapon}', { killer: 'Pat', victim: 'Sue', weapon: 'Rifle' });
    expect(parts).toEqual([
      { text: 'Pat', varName: 'killer' },
      { text: ' splashed ', varName: null },
      { text: 'Sue', varName: 'victim' },
      { text: ' with a ', varName: null },
      { text: 'Rifle', varName: 'weapon' },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe(t('feed.kill.0', { killer: 'Pat', victim: 'Sue', weapon: 'Rifle' }));
  });

  it('keeps unknown placeholders literal and never interprets names as markup', () => {
    const parts = splitTemplate('{victim} met {nobody}', { victim: '<b>x</b>' });
    expect(parts).toEqual([
      { text: '<b>x</b>', varName: 'victim' },
      { text: ' met {nobody}', varName: null },
    ]);
  });
});

describe('M2a: self-grenade kills and the death card', () => {
  it('detects the victim\'s own grenade even when an enemy gets the credit', () => {
    expect(isSelfGrenadeKill('explosion', null, 5, undefined)).toBe(true);
    expect(isSelfGrenadeKill('explosion', 5, 5, undefined)).toBe(true);
    expect(isSelfGrenadeKill('explosion', 7, 5, 5)).toBe(true); // credit to the last enemy, blast was self
    expect(isSelfGrenadeKill('explosion', 7, 5, 7)).toBe(false);
    expect(isSelfGrenadeKill('weapon', null, 5, 5)).toBe(false);
  });

  it('death cause line', () => {
    expect(deathCauseKey('explosion', 'Pat', true)).toBe('death.eliminatedBySelf');
    expect(deathCauseKey('explosion', 'Pat', false)).toBe('death.eliminatedBy');
    expect(deathCauseKey('zone', null, false)).toBe('death.eliminatedByTide');
    expect(deathCauseKey('fall', 'Pat', false)).toBe('death.eliminatedByFall');
    expect(deathCauseKey('weapon', null, false)).toBeNull();
    expect(hasKey('death.eliminatedBySelf')).toBe(true);
  });
});

describe('pickup prompt', () => {
  const empty = { weapon: null, mag: null, count: null };
  const piece = (id: HudArmorView['id'], tier: 1 | 2 | 3, durability: number, maxDurability = 50): HudArmorView => ({
    id,
    tier,
    durability,
    maxDurability,
  });
  const local = (full: boolean, extra: { vest?: HudArmorView | null; helmet?: HudArmorView | null } = {}) => ({
    heals: { bandage: 0, medkit: 0 },
    reserve: null,
    slots: [
      { slot: 0 as const, ...(full ? { weapon: 'pistol' as const, mag: 3, count: null } : empty) },
      { slot: 1 as const, ...(full ? { weapon: 'smg' as const, mag: 3, count: null } : empty) },
      { slot: 2 as const, weapon: 'fists' as const, mag: null, count: null },
      { slot: 3 as const, weapon: 'grenade' as const, mag: null, count: 0 },
    ] as [never, never, never, never],
    vest: extra.vest ?? null,
    helmet: extra.helmet ?? null,
    grenades: 0,
    grenadeMax: 3,
  });

  it('categorises every item id', () => {
    expect(itemCategory('rifle')).toBe('gun');
    expect(itemCategory('sniper')).toBe('gun');
    expect(itemCategory('lmg')).toBe('gun');
    expect(itemCategory('dmr')).toBe('gun');
    expect(itemCategory('ammo_shell')).toBe('ammo');
    expect(itemCategory('ammo_sniper')).toBe('ammo');
    expect(itemCategory('medkit')).toBe('heal');
    expect(itemCategory('vest_2')).toBe('armor');
    expect(itemCategory('helmet_3')).toBe('armor');
    expect(itemCategory('grenade')).toBe('throwable');
  });

  it('chooses pick up / swap / grab', () => {
    expect(pickupPromptChoice('rifle', 1, local(false)).key).toBe('hud.pickup');
    expect(pickupPromptChoice('sniper', 1, local(true)).key).toBe('hud.pickup.swap');
    expect(pickupPromptChoice('ammo_light', 30, local(false))).toEqual({ key: 'hud.pickup.ammo', usesCount: true, blocked: false });
    expect(pickupPromptChoice('bandage', 3, local(false)).key).toBe('hud.pickup.ammo');
    expect(pickupPromptChoice('bandage', 1, local(false)).key).toBe('hud.pickup');
    expect(pickupPromptChoice('grenade', 2, local(false)).key).toBe('hud.pickup.ammo');
    expect(pickupPromptChoice('grenade', 1, local(false)).key).toBe('hud.pickup');
  });

  it('armor: pick up into an empty slot, upgrade a lower tier, refuse same-or-lower by slot', () => {
    expect(pickupPromptChoice('vest_1', 1, local(false)).key).toBe('hud.pickup');
    const worn = local(false, { vest: piece('vest_2', 2, 30), helmet: piece('helmet_1', 1, 10) });
    expect(pickupPromptChoice('vest_3', 1, worn)).toEqual({ key: 'hud.pickup.upgrade', usesCount: false, blocked: false });
    expect(pickupPromptChoice('vest_2', 1, worn)).toEqual({ key: 'hud.vest.better', usesCount: false, blocked: true });
    expect(pickupPromptChoice('vest_1', 1, worn).key).toBe('hud.vest.better');
    expect(pickupPromptChoice('helmet_1', 1, worn)).toEqual({ key: 'hud.helmet.better', usesCount: false, blocked: true });
    expect(pickupPromptChoice('helmet_2', 1, worn).key).toBe('hud.pickup.upgrade');
    expect(armorRefused('vest_2', worn)).toBe(true);
    expect(armorRefused('helmet_3', worn)).toBe(false);
    expect(armorRefused('rifle', worn)).toBe(false);
  });

  it('trusts the predicted refusal from interactPromptChanged', () => {
    expect(pickupPromptChoice('vest_3', 1, local(false), 'betterArmor')).toEqual({
      key: 'hud.vest.better',
      usesCount: false,
      blocked: true,
    });
    expect(pickupPromptChoice('grenade', 1, local(false), 'inventoryFull').key).toBe('hud.grenade.full');
    expect(pickupPromptChoice('ammo_heavy', 30, local(false), 'inventoryFull').key).toBe('hud.inventory.full');
  });

  it('warns before the press when that item is at its carry limit', () => {
    const base = local(false);
    const healMax = { bandage: 5, medkit: 2 };
    expect(pickupPromptChoice('medkit', 1, { ...base, heals: { bandage: 0, medkit: 2 }, healMax })).toEqual({
      key: 'hud.inventory.full',
      usesCount: false,
      blocked: true,
    });
    expect(pickupPromptChoice('bandage', 2, { ...base, heals: { bandage: 4, medkit: 2 }, healMax }).blocked).toBe(false);
    // Limits not filled yet (older producer): never blocks.
    expect(pickupPromptChoice('medkit', 1, { ...base, heals: { bandage: 0, medkit: 9 } }).blocked).toBe(false);
    // Ammo: only the active weapon's ammo type is known.
    const full = { ...base, reserve: 90, reserveMax: 90, ammoType: 'ammo_light' as const };
    expect(pickupPromptChoice('ammo_light', 30, full).key).toBe('hud.inventory.full');
    expect(pickupPromptChoice('ammo_heavy', 30, full).key).toBe('hud.pickup.ammo');
    expect(pickupPromptChoice('ammo_light', 30, { ...full, reserve: 60 }).blocked).toBe(false);
    // Grenades at maxCarry.
    expect(pickupPromptChoice('grenade', 1, { ...base, grenades: 3 })).toEqual({
      key: 'hud.grenade.full',
      usesCount: false,
      blocked: true,
    });
    expect(pickupPromptChoice('grenade', 1, { ...base, grenades: 2 }).blocked).toBe(false);
  });

  it('armor detail shows the tier and "current/max" durability', () => {
    expect(armorPromptDetail('vest_2', 30.2, 55)).toEqual({ tier: 2, tierKey: 'gear.tier.2', durability: '31/55' });
    expect(armorPromptDetail('helmet_3', 12, null)).toEqual({ tier: 3, tierKey: 'gear.tier.3', durability: '12' });
    expect(armorPromptDetail('helmet_1', null, 30)?.durability).toBeNull();
    expect(armorPromptDetail('rifle', 10, 10)).toBeNull();
    expect(hasKey('gear.tier.1') && hasKey('gear.tier.2') && hasKey('gear.tier.3')).toBe(true);
  });

  it('every key it can return exists', () => {
    for (const key of [
      'hud.pickup',
      'hud.pickup.swap',
      'hud.pickup.ammo',
      'hud.pickup.upgrade',
      'hud.armor.better',
      'hud.vest.better',
      'hud.helmet.better',
      'hud.inventory.full',
      'hud.grenade.full',
    ]) {
      expect(hasKey(key)).toBe(true);
    }
  });
});

describe('actionFailed toast', () => {
  it('maps every reason to the ARCHITECTURE §12/§14 key, and stays silent for fire', () => {
    expect(actionFailedKey('heal', 'noHeals')).toBe('hud.heal.none');
    expect(actionFailedKey('heal', 'fullHp')).toBe('hud.heal.full');
    expect(actionFailedKey('pickup', 'inventoryFull')).toBe('hud.inventory.full');
    expect(actionFailedKey('pickup', 'betterArmor')).toBe('hud.armor.better');
    expect(actionFailedKey('reload', 'noAmmo')).toBe('hud.ammo.empty');
    expect(actionFailedKey('fire', 'noAmmo')).toBeNull();
    expect(actionFailedKey('swap', 'noGrenades')).toBe('hud.grenade.none');
    expect(actionFailedKey('stance', 'noHeadroom')).toBe('hud.stance.noRoom');
    expect(actionFailedKey('stance', 'tooDeep')).toBe('hud.stance.tooDeep');
    const reasons = ['noHeals', 'fullHp', 'inventoryFull', 'betterArmor', 'noAmmo', 'noGrenades', 'tooDeep', 'noHeadroom'] as const;
    for (const r of reasons) expect(hasKey(actionFailedKey('heal', r) ?? '')).toBe(true);
  });

  it('picks the vest / helmet / grenade variants from the prompt item', () => {
    expect(actionFailedKey('pickup', 'betterArmor', 'vest_2')).toBe('hud.vest.better');
    expect(actionFailedKey('pickup', 'betterArmor', 'helmet_1')).toBe('hud.helmet.better');
    expect(actionFailedKey('pickup', 'inventoryFull', 'grenade')).toBe('hud.grenade.full');
    expect(actionFailedKey('pickup', 'inventoryFull', 'bandage')).toBe('hud.inventory.full');
  });

  it('falls back to hud.stance.proneWater while hud.stance.tooDeep is missing', () => {
    expect(actionFailedKey('stance', 'tooDeep', null, () => false)).toBe('hud.stance.proneWater');
    expect(hasKey('hud.stance.proneWater')).toBe(true);
  });
});

describe('M2a: ADS reticle', () => {
  const ads = (sight: AdsView['sight'], cameraBlend: number, scoped = false): AdsView => ({
    sight,
    progress: cameraBlend,
    cameraBlend,
    zoom: 1,
    scoped,
  });

  it('hip crosshair without ADS or without a sight', () => {
    expect(adsReticle(null)).toEqual({ hip: 1, gapScale: 1, dot: null, dotOpacity: 0, scope: null });
    expect(adsReticle(ads('none', 1)).hip).toBe(1);
  });

  it('iron / red dot: the crosshair closes into the dot as cameraBlend rises', () => {
    const half = adsReticle(ads('iron', 0.5));
    expect(half).toEqual({ hip: 0.5, gapScale: 0.5, dot: 'iron', dotOpacity: 0.5, scope: null });
    const full = adsReticle(ads('red_dot', 1));
    expect(full.hip).toBe(0);
    expect(full.dot).toBe('red_dot');
    expect(full.dotOpacity).toBe(1);
    expect(adsReticle(ads('red_dot', 0)).dot).toBeNull();
  });

  it('scopes: a small dot while zooming in, then the full-screen frame (hip crosshair hidden)', () => {
    expect(adsReticle(ads('scope_4x', 0.6)).dot).toBe('iron');
    expect(adsReticle(ads('scope_4x', 0.6)).scope).toBeNull();
    expect(adsReticle(ads('scope_4x', 1, true))).toEqual({ hip: 0, gapScale: 0, dot: null, dotOpacity: 0, scope: 'scope_4x' });
    expect(adsReticle(ads('scope_8x', 1, true)).scope).toBe('scope_8x');
  });

  it('quantises so the DOM is not rewritten every frame', () => {
    expect(adsReticle(ads('iron', 0.501)).dotOpacity).toBe(adsReticle(ads('iron', 0.5)).dotOpacity);
    expect(adsReticle(ads('iron', Number.NaN)).hip).toBe(1);
  });
});

describe('M2a: armor pieces', () => {
  it('worn / low / broken / none', () => {
    const worn = gearView({ id: 'vest_2', tier: 2, durability: 30.2, maxDurability: 55 });
    expect(worn).toMatchObject({ state: 'worn', tier: 2, text: t('hud.gear.durability', { current: 31, max: 55 }), low: false });
    expect(worn.ratio).toBeCloseTo(0.55, 2);
    expect(gearView({ id: 'helmet_1', tier: 1, durability: 5, maxDurability: 30 }).low).toBe(true);
    expect(gearView(null, 3)).toEqual({ state: 'broken', tier: 3, ratio: 0, text: t('hud.gear.broken'), low: false });
    expect(gearView(null)).toEqual({ state: 'none', tier: 0, ratio: 0, text: '', low: false });
  });
});

describe('M2a: stance', () => {
  it('shows the target stance and animates only during a transition', () => {
    expect(stanceView('stand', 'stand', 1)).toEqual({ stance: 'stand', moving: false, progress: 1, labelKey: 'hud.stance.stand' });
    expect(stanceView('prone', 'crouch', 0.4)).toMatchObject({ stance: 'prone', moving: true, progress: 0.4 });
    expect(stanceView('crouch', 'stand', 1).moving).toBe(false);
    for (const s of ['stand', 'crouch', 'prone']) expect(hasKey(`hud.stance.${s}`)).toBe(true);
  });
});

describe('M2a: cook ring', () => {
  it('empties over the fuse and turns urgent in the last second', () => {
    expect(cookView(null)).toBeNull();
    expect(cookView({ fuseRemainingMs: 3000, fuseMs: 4000 })).toEqual({ ratio: 0.75, urgent: false, seconds: 3 });
    expect(cookView({ fuseRemainingMs: 1000, fuseMs: 4000 })?.urgent).toBe(true);
    expect(cookView({ fuseRemainingMs: 1001, fuseMs: 4000 })?.urgent).toBe(false);
    expect(cookView({ fuseRemainingMs: 1, fuseMs: 4000 })?.seconds).toBe(0.1);
    expect(cookView({ fuseRemainingMs: -50, fuseMs: 4000 })).toEqual({ ratio: 0, urgent: true, seconds: 0 });
  });
});

describe('M2a: grenade danger', () => {
  it('draws ahead on screen, sides and behind at the edge', () => {
    const ahead = dangerPlacement(0, 70, 1280, 720, 64);
    expect(ahead.edge).toBe(false);
    expect(ahead.x).toBe(0);
    expect(ahead.y).toBe(0);
    expect(dangerPlacement(0.3, 70, 1280, 720, 64).x).toBeGreaterThan(0);
    const right = dangerPlacement(Math.PI / 2, 70, 1280, 720, 64);
    expect(right).toMatchObject({ edge: true, x: 1280 / 2 - 64, y: 0, arrowDeg: 90 });
    const behind = dangerPlacement(Math.PI, 70, 1280, 720, 64);
    expect(behind.edge).toBe(true);
    expect(behind.y).toBe(720 / 2 - 64);
    // No FOV: always pinned to the edge.
    expect(dangerPlacement(0, undefined, 1280, 720, 64)).toMatchObject({ edge: true, x: 0, y: -(720 / 2 - 64) });
  });

  it('keeps edge icons inside the 2.2:1 HUD box on ultrawide', () => {
    const p = dangerPlacement(Math.PI / 2, 70, 3440, 1000, 64);
    expect(p.x).toBe(2200 / 2 - 64);
  });

  it('grows as the grenade gets closer', () => {
    expect(dangerScale(10)).toBe(1);
    expect(dangerScale(0)).toBeCloseTo(1.35);
    expect(dangerScale(3)).toBeGreaterThan(1);
  });
});

describe('M2a: hit marker variants', () => {
  it('vest / helmet / break, with the kill marker winning', () => {
    const base = { headshot: false, killed: false, vest: null, helmet: null };
    expect(hitVariant(base)).toEqual({ head: false, kill: false, vest: false, helmet: false, broke: false });
    expect(hitVariant({ ...base, vest: { broken: false } })).toMatchObject({ vest: true, broke: false });
    expect(hitVariant({ ...base, headshot: true, helmet: { broken: true } })).toMatchObject({ head: true, helmet: true, broke: true });
    expect(hitVariant({ ...base, killed: true, vest: { broken: true } })).toEqual({
      head: false,
      kill: true,
      vest: false,
      helmet: false,
      broke: false,
    });
  });
});

describe('vitals thresholds', () => {
  it('low HP is absolute (matches audio) and excludes 0', () => {
    expect(LOW_HP_THRESHOLD).toBe(30);
    expect(isLowHp(30)).toBe(true);
    expect(isLowHp(31)).toBe(false);
    expect(isLowHp(0)).toBe(false);
  });

  it('uses the HudView threshold when valid, else the default', () => {
    expect(lowHpThresholdOf(undefined)).toBe(LOW_HP_THRESHOLD);
    expect(lowHpThresholdOf(40)).toBe(40);
    expect(lowHpThresholdOf(0)).toBe(LOW_HP_THRESHOLD);
    expect(lowHpThresholdOf(Number.NaN)).toBe(LOW_HP_THRESHOLD);
    expect(isLowHp(35, lowHpThresholdOf(40))).toBe(true);
    expect(isLowHp(35, lowHpThresholdOf(undefined))).toBe(false);
  });

  it('damage feedback scales with max HP', () => {
    expect(isHeavyHit(25, 100)).toBe(true);
    expect(isHeavyHit(24, 100)).toBe(false);
    expect(isHeavyHit(50, 200)).toBe(true);
    expect(isHeavyHit(10, 0)).toBe(false);
    expect(hitVignetteStrength(20, 100)).toBeCloseTo(0.85);
    expect(hitVignetteStrength(40, 200)).toBeCloseTo(0.85);
    expect(hitVignetteStrength(500, 100)).toBe(1);
    expect(hitVignetteStrength(10, 0)).toBe(0.35);
  });
});

describe('tide status', () => {
  const zone = (o: Partial<HudZoneView>): HudZoneView => ({
    phaseIndex: 0,
    phaseCount: 6,
    shrinking: false,
    isFinal: false,
    secondsLeft: 83,
    center: { x: 0, z: 0 },
    radius: 100,
    targetCenter: { x: 0, z: 0 },
    targetRadius: 60,
    dps: 1,
    ...o,
  });

  it('waiting embeds the clock in the label', () => {
    const s = tideStatus(zone({}));
    expect(s).toEqual({ key: 'hud.tide.wait', vars: { time: '1:23' }, urgent: false, clock: '' });
    expect(t(s!.key, s!.vars)).toBe('Tide rising in 1:23');
  });

  it('shrinking / final are urgent with a separate clock', () => {
    expect(tideStatus(zone({ shrinking: true, secondsLeft: 12 }))).toMatchObject({ key: 'hud.tide.shrinking', urgent: true, clock: '0:12' });
    expect(tideStatus(zone({ isFinal: true, phaseIndex: 6 }))).toMatchObject({ key: 'hud.tide.final', urgent: true });
    expect(tideStatus(null)).toBeNull();
  });

  it('phase numbers are 1-based and capped', () => {
    expect(tidePhaseNumbers(zone({ phaseIndex: 0 }))).toEqual({ index: 1, count: 6 });
    expect(tidePhaseNumbers(zone({ phaseIndex: 6 }))).toEqual({ index: 6, count: 6 });
    expect(tidePhaseNumbers(zone({ phaseIndex: -1 }))).toBeNull();
  });
});

describe('aliveAnnouncement', () => {
  it('fires on threshold crossings only', () => {
    expect(aliveAnnouncement(12, 11, 12)).toBeNull();
    expect(aliveAnnouncement(11, 10, 12)).toEqual({ key: 'announcer.remain', vars: { count: 10 } });
    expect(aliveAnnouncement(7, 5, 12)).toEqual({ key: 'announcer.remain', vars: { count: 5 } });
    expect(aliveAnnouncement(4, 3, 12)).toEqual({ key: 'announcer.remain', vars: { count: 3 } });
    expect(aliveAnnouncement(3, 2, 12)).toEqual({ key: 'announcer.finalTwo', vars: {} });
    expect(aliveAnnouncement(2, 1, 12)).toBeNull();
    expect(aliveAnnouncement(5, 5, 12)).toBeNull();
  });
  it('skips thresholds above the match size', () => {
    expect(aliveAnnouncement(10, 9, 10)).toBeNull();
    expect(aliveAnnouncement(6, 5, 10)).toEqual({ key: 'announcer.remain', vars: { count: 5 } });
  });
});

describe('MessageQueue', () => {
  it('shows one at a time for its duration', () => {
    const q = new MessageQueue<string>();
    q.push({ id: 'a', payload: 'A', durationMs: 100 });
    q.push({ id: 'b', payload: 'B', durationMs: 50 });
    expect(q.update(0)?.payload).toBe('A');
    expect(q.update(99)?.payload).toBe('A');
    expect(q.update(100)?.payload).toBe('B');
    expect(q.update(149)?.payload).toBe('B');
    expect(q.update(150)).toBeNull();
  });

  it('dedupes by id and caps the backlog', () => {
    const q = new MessageQueue<number>(2);
    q.push({ id: 'x', payload: 1, durationMs: 10 });
    q.update(0);
    q.push({ id: 'x', payload: 2, durationMs: 10 }); // same as current
    q.push({ id: 'y', payload: 3, durationMs: 10 });
    q.push({ id: 'z', payload: 4, durationMs: 10 });
    q.push({ id: 'w', payload: 5, durationMs: 10 }); // drops oldest queued (y)
    expect(q.update(10)?.payload).toBe(4);
    expect(q.update(20)?.payload).toBe(5);
    expect(q.update(30)).toBeNull();
  });
});

describe('map projection', () => {
  it('fits the world radius inside the square, north (-Z) up', () => {
    const p = fitProjection(135, 200, 4);
    expect(projectXZ(p, 0, 0)).toEqual({ px: 100, py: 100 });
    expect(projectXZ(p, 135, 0).px).toBeCloseTo(196);
    expect(projectXZ(p, 0, -135).py).toBeCloseTo(4);
  });
});

describe('graphics status', () => {
  it('failed blocks, restoring shows the note, ok hides both', () => {
    expect(graphicsStatusView('failed')).toEqual({ blocking: true, note: false });
    expect(graphicsStatusView('restoring')).toEqual({ blocking: false, note: true });
    expect(graphicsStatusView('ok')).toEqual({ blocking: false, note: false });
  });
});

describe('minimap labels', () => {
  const inside = (b: { x: number; y: number; w: number; h: number }, size: number, pad: number): boolean =>
    b.x >= pad - 1e-9 && b.y >= pad - 1e-9 && b.x + b.w <= size - pad + 1e-9 && b.y + b.h <= size - pad + 1e-9;

  it('keeps rim labels fully inside the map (BUG-004)', () => {
    const items = [
      { px: 8, py: 40, w: 90, h: 12 }, // west rim
      { px: 160, py: 80, w: 70, h: 12 }, // east rim
      { px: 80, py: 4, w: 60, h: 12 }, // north rim
    ];
    const placed = layoutMapLabels(items, 168, 6);
    expect(placed).toHaveLength(3);
    for (const p of placed) expect(inside(p.box, 168, 6)).toBe(true);
  });

  it('never overlaps labels or other dots, and drops what does not fit', () => {
    const items = [
      { px: 84, py: 84, w: 60, h: 12 },
      { px: 86, py: 86, w: 60, h: 12 },
      { px: 84, py: 84, w: 500, h: 12 }, // wider than the map
    ];
    const placed = layoutMapLabels(items, 168, 6);
    expect(placed.map((p) => p.index)).not.toContain(2);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i]!.box;
        const b = placed[j]!.box;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    }
  });

  it('wraps long names into two balanced lines', () => {
    const measure = (s: string): number => s.length * 6;
    expect(wrapLabel('Rickety Dock', 100, measure)).toEqual(['Rickety Dock']);
    const two = wrapLabel('Sunny Seconds Wreck', 80, measure);
    expect(two).toHaveLength(2);
    expect(two.join(' ')).toBe('Sunny Seconds Wreck');
    for (const line of two) expect(measure(line)).toBeLessThanOrEqual(80);
    expect(wrapLabel('Supercalifragilistic', 50, measure)).toEqual(['Supercalifragilistic']);
  });
});

describe('minimap POI names', () => {
  it('uses the short label when present, else the full name', () => {
    expect(minimapPoiLabel('poi.wreck')).toBe(t('poi.wreck.short'));
    expect(minimapPoiLabel('poi.wreck').length).toBeLessThan(t('poi.wreck').length);
    expect(minimapPoiLabel('map.island01.name')).toBe(t('map.island01.name'));
  });
});
