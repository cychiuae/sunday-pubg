import { describe, expect, it } from 'vitest';
import { hasKey, t } from '../content/strings';
import type { HudZoneView } from '../shared/contracts';
import { MAX_NAME_LENGTH } from '../shared/constants';
import {
  actionFailedKey,
  aliveAnnouncement,
  connectionErrorKey,
  fitProjection,
  formatClock,
  graphicsStatusView,
  hitVignetteStrength,
  isHeavyHit,
  isLowHp,
  itemCategory,
  killFeedPrefix,
  LOW_HP_THRESHOLD,
  lowHpThresholdOf,
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

describe('pickup prompt', () => {
  const empty = { weapon: null, mag: null };
  const local = (full: boolean, armor = 0) => ({
    heals: { bandage: 0, medkit: 0 },
    reserve: null,
    slots: [
      { slot: 0 as const, ...(full ? { weapon: 'pistol' as const, mag: 3 } : empty) },
      { slot: 1 as const, ...(full ? { weapon: 'smg' as const, mag: 3 } : empty) },
      { slot: 2 as const, weapon: 'fists' as const, mag: null },
    ] as [never, never, never],
    armor,
    maxArmor: 50,
  });

  it('categorises items', () => {
    expect(itemCategory('rifle')).toBe('gun');
    expect(itemCategory('ammo_shell')).toBe('ammo');
    expect(itemCategory('medkit')).toBe('heal');
    expect(itemCategory('vest')).toBe('armor');
  });

  it('chooses pick up / swap / grab', () => {
    expect(pickupPromptChoice('rifle', 1, local(false)).key).toBe('hud.pickup');
    expect(pickupPromptChoice('rifle', 1, local(true)).key).toBe('hud.pickup.swap');
    expect(pickupPromptChoice('ammo_light', 30, local(false))).toEqual({ key: 'hud.pickup.ammo', usesCount: true, blocked: false });
    expect(pickupPromptChoice('bandage', 3, local(false)).key).toBe('hud.pickup.ammo');
    expect(pickupPromptChoice('bandage', 1, local(false)).key).toBe('hud.pickup');
  });

  it('blocks a vest at full armor', () => {
    expect(pickupPromptChoice('vest', 1, local(false, 50))).toEqual({ key: 'hud.armor.better', usesCount: false, blocked: true });
    expect(pickupPromptChoice('vest', 1, local(false, 20)).blocked).toBe(false);
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
  });

  it('every key it can return exists', () => {
    for (const key of ['hud.pickup', 'hud.pickup.swap', 'hud.pickup.ammo', 'hud.armor.better', 'hud.inventory.full']) {
      expect(hasKey(key)).toBe(true);
    }
  });
});

describe('actionFailed toast', () => {
  it('maps every reason to the ARCHITECTURE §12 key, and stays silent for fire', () => {
    expect(actionFailedKey('heal', 'noHeals')).toBe('hud.heal.none');
    expect(actionFailedKey('heal', 'fullHp')).toBe('hud.heal.full');
    expect(actionFailedKey('pickup', 'inventoryFull')).toBe('hud.inventory.full');
    expect(actionFailedKey('pickup', 'betterArmor')).toBe('hud.armor.better');
    expect(actionFailedKey('reload', 'noAmmo')).toBe('hud.ammo.empty');
    expect(actionFailedKey('fire', 'noAmmo')).toBeNull();
    for (const r of ['noHeals', 'fullHp', 'inventoryFull', 'betterArmor', 'noAmmo'] as const) {
      expect(hasKey(actionFailedKey('heal', r) ?? '')).toBe(true);
    }
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
