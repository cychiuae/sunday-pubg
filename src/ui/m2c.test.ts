/**
 * M2c UI pure helpers (docs/ui/M2c.md §13 / §16.10 acceptance criteria that are unit-testable).
 * Owner: ui-ux-designer.
 */
import { describe, expect, it } from 'vitest';
import { hasKey, t } from '../content/strings';
import type { AdsView, HudSlotView } from '../shared/contracts';
import { formatLayoutSeed } from '../shared/layout';
import { ARMOR_TIER_COLOUR, LEVEL_COLOUR, SCOPE_ACCENT } from './icons';
import {
  actionFailedKey,
  adsReticle,
  armorPromptDetail,
  deathCauseKey,
  gearView,
  hitMarkerVisible,
  inventoryFullKey,
  isCarryFull,
  isRocketFeedPrefix,
  isSelfBlastKill,
  itemCategory,
  killFeedPrefix,
  killWeaponTag,
  levelBadgeModel,
  levelCompare,
  levelLabel,
  lookGlyph,
  lookLine,
  pickupPromptChoice,
  pickupPromptModel,
  pouchModel,
  reticleMode,
  scopeSight,
  sightChipModel,
  throwableSlotModel,
  type KillInfo,
  type PromptLocal,
} from './logic';
import { islandPropBlock } from './minimap';
import { CONTROL_IDS } from './screens';

// ---------------------------------------------------------------------------------------------
// Fixtures. Slots are typed loosely: before the C-gate the live unions lack the M2c ids.
// ---------------------------------------------------------------------------------------------
type AnySlot = Partial<Omit<HudSlotView, 'weapon'>> & { slot: 0 | 1 | 2 | 3; weapon: string | null; mag: number | null; count: number | null };
const slot = (i: 0 | 1 | 2 | 3, weapon: string | null, extra: Partial<AnySlot> = {}): AnySlot => ({
  slot: i,
  weapon,
  mag: weapon && i < 2 ? 5 : null,
  count: i === 3 ? 0 : null,
  ...extra,
});
function local(
  slots: [AnySlot, AnySlot, AnySlot, AnySlot],
  extra: Partial<Record<string, unknown>> = {},
): PromptLocal & { activeSlot: 0 | 1 | 2 | 3 } {
  return {
    heals: { bandage: 0, medkit: 0 },
    reserve: null,
    slots: slots as unknown as PromptLocal['slots'],
    vest: null,
    helmet: null,
    grenades: 0,
    grenadeMax: 3,
    activeSlot: 0,
    ...extra,
  } as PromptLocal & { activeSlot: 0 | 1 | 2 | 3 };
}
const noGuns = (): [AnySlot, AnySlot, AnySlot, AnySlot] => [slot(0, null), slot(1, null), slot(2, 'fists'), slot(3, 'grenade')];

// ---------------------------------------------------------------------------------------------
describe('M2C-UI-01 level badge model and palette', () => {
  it('gives the numeral, the token and the L4 sparkle; null without a level', () => {
    expect(levelBadgeModel(1)).toEqual({ numeral: '1', token: 'lv1', sparkle: false });
    expect(levelBadgeModel(3)).toEqual({ numeral: '3', token: 'lv3', sparkle: false });
    expect(levelBadgeModel(4)).toEqual({ numeral: '4', token: 'lv4', sparkle: true });
    expect(levelBadgeModel(null)).toBeNull();
    expect(levelBadgeModel(undefined)).toBeNull();
  });

  it('uses the final art palette (docs/art/M2c.md §1.1)', () => {
    expect(LEVEL_COLOUR[1].base).toBe('#b8e7ff');
    expect(LEVEL_COLOUR[2].base).toBe('#fff14d');
    expect(LEVEL_COLOUR[3]).toEqual({ base: '#f2590d', text: '#ff7a3d' });
    expect(LEVEL_COLOUR[4]).toEqual({ base: '#b963e3', text: '#d08bf0' });
    expect(ARMOR_TIER_COLOUR[4]).toBe('#b963e3');
    expect(SCOPE_ACCENT.scope_2x).toBe('#ff7a5c');
  });

  it('M2C-UI-05: the ink numeral reaches 4.5:1 on every level fill', () => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const l = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * (l[0] ?? 0) + 0.7152 * (l[1] ?? 0) + 0.0722 * (l[2] ?? 0);
    };
    const ink = lum('#2a1d33');
    for (const lv of [1, 2, 3, 4] as const) {
      const ratio = (lum(LEVEL_COLOUR[lv].base) + 0.05) / (ink + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('labels levels with the narrative names ("Lv.3 Hot")', () => {
    expect(levelLabel(3)).toBe(t('level.label', { short: t('level.3.short'), name: t('level.3.name') }));
    expect(levelLabel(null)).toBe('');
  });
});

describe('M2c item categories and carry limits', () => {
  it('categorises the new ids', () => {
    expect(itemCategory('rpg' as never)).toBe('gun');
    expect(itemCategory('dbshotgun' as never)).toBe('gun');
    expect(itemCategory('revolver' as never)).toBe('gun');
    expect(itemCategory('knife' as never)).toBe('melee');
    expect(itemCategory('paddle' as never)).toBe('melee');
    expect(itemCategory('ammo_rocket' as never)).toBe('ammo');
    expect(itemCategory('smoke' as never)).toBe('throwable');
    expect(itemCategory('vest_4' as never)).toBe('armor');
    expect(itemCategory('scope_2x' as never)).toBe('scope');
  });

  it('smoke has its own pouch (throwables / throwableMax)', () => {
    const l = local(noGuns(), { throwables: { grenade: 1, smoke: 2 }, throwableMax: { grenade: 3, smoke: 2 } });
    expect(isCarryFull('smoke' as never, l)).toBe(true);
    expect(isCarryFull('grenade', l)).toBe(false);
    expect(inventoryFullKey('smoke' as never)).toBe('hud.smoke.full');
    expect(inventoryFullKey('scope_4x' as never)).toBe('hud.scope.stashFull');
    expect(pickupPromptChoice('smoke' as never, 1, l)).toEqual({ key: 'hud.smoke.full', usesCount: false, blocked: true });
  });

  it('level 4 armor: Lv.4 detail and the same-or-lower refusal', () => {
    expect(armorPromptDetail('vest_4' as never, 40, 80)).toEqual({ tier: 4, tierKey: 'gear.tier.4', durability: '40/80' });
    expect(gearView({ id: 'helmet_4' as never, tier: 4 as never, durability: 10, maxDurability: 40 }).tier).toBe(4);
    const worn = local(noGuns(), { vest: { id: 'vest_4', tier: 4, durability: 50, maxDurability: 80 } });
    expect(pickupPromptChoice('vest_3', 1, worn).blocked).toBe(true);
  });
});

describe('M2C-UI-07 / 08 / 10 pickup prompt model', () => {
  const twoGuns = (lvA: number, lvB: number): [AnySlot, AnySlot, AnySlot, AnySlot] => [
    slot(0, 'pistol', { level: lvA as never }),
    slot(1, 'rifle', { level: lvB as never }),
    slot(2, 'fists'),
    slot(3, 'grenade'),
  ];

  it('free slot: plain pick up with the level', () => {
    const m = pickupPromptModel({ item: 'rifle', qty: 1, refusal: null, level: 3 }, local(noGuns()));
    expect(m.key).toBe('hud.pickup');
    expect(m.level).toBe(3);
    expect(m.compare).toBeNull();
  });

  it('different gun replaced: swapFrom names what you give up, no level compare', () => {
    const m = pickupPromptModel({ item: 'smg', qty: 1, refusal: null, level: 2, replacesSlot: 0 }, local(twoGuns(1, 1)));
    expect(m.key).toBe('hud.pickup.swapFrom');
    expect(m.vars['current']).toBe(t('item.pistol.name'));
    expect(m.replaced).toEqual({ item: 'pistol', level: 1 });
    expect(m.compare).toBeNull();
  });

  it('same gun: up uses levelUp; down / same use swapFrom with the tag', () => {
    const up = pickupPromptModel({ item: 'rifle', qty: 1, refusal: null, level: 4, replacesSlot: 1 }, local(twoGuns(1, 2)));
    expect(up.key).toBe('hud.pickup.levelUp');
    expect(up.compare).toBe('up');
    const down = pickupPromptModel({ item: 'rifle', qty: 1, refusal: null, level: 1, replacesSlot: 1 }, local(twoGuns(1, 2)));
    expect(down.key).toBe('hud.pickup.swapFrom');
    expect(down.compare).toBe('down');
    const same = pickupPromptModel({ item: 'rifle', qty: 1, refusal: null, level: 2, replacesSlot: 1 }, local(twoGuns(1, 2)));
    expect(same.compare).toBe('same');
    expect(levelCompare(3, 1)).toBe('up');
    expect(levelCompare(null, 1)).toBeNull();
  });

  it('without replacesSlot (older producer): the M2a swap text', () => {
    const m = pickupPromptModel({ item: 'smg', qty: 1, refusal: null, level: 2 }, local(twoGuns(1, 1)));
    expect(m.key).toBe('hud.pickup.swap');
  });

  it('melee: "Replaces your fists" on fists; swapFrom when a melee weapon is held', () => {
    const onFists = pickupPromptModel({ item: 'machete' as never, qty: 1, refusal: null, level: 2 }, local(noGuns()));
    expect(onFists.key).toBe('hud.pickup');
    expect(onFists.noteKey).toBe('hud.melee.replacesFists');
    const held = local([slot(0, null), slot(1, null), slot(2, 'knife', { level: 1 as never }), slot(3, 'grenade')]);
    const swap = pickupPromptModel({ item: 'machete' as never, qty: 1, refusal: null, level: 2, replacesSlot: 2 }, held);
    expect(swap.key).toBe('hud.pickup.swapFrom');
    expect(swap.noteKey).toBeNull();
  });

  it('M2C-UI-34 scope target and "Fits" only when it fits neither gun', () => {
    const guns = local([
      slot(0, 'rifle', { compatibleScopes: ['scope_red_dot', 'scope_2x', 'scope_4x'] }),
      slot(1, 'pistol', { compatibleScopes: ['scope_red_dot'] }),
      slot(2, 'fists'),
      slot(3, 'grenade'),
    ]);
    const onGun = pickupPromptModel({ item: 'scope_2x' as never, qty: 1, refusal: null, scopeTarget: 0 }, guns);
    expect(onGun.scopeTarget).toEqual({ slot: 0, weapon: 'rifle' });
    expect(onGun.fitsKey).toBe(false);
    const pouch = pickupPromptModel({ item: 'scope_8x' as never, qty: 1, refusal: null, scopeTarget: 'pouch' }, guns);
    expect(pouch.scopeTarget).toBe('pouch');
    expect(pouch.fitsKey).toBe(true);
    const full = pickupPromptModel({ item: 'scope_8x' as never, qty: 1, refusal: 'scopePouchFull' as never, scopeTarget: null }, guns);
    expect(full.blocked).toBe(true);
    expect(full.key).toBe('hud.scope.stashFull');
  });

  it('a ground gun with a scope carries it for the sight chip', () => {
    const m = pickupPromptModel({ item: 'rifle', qty: 1, refusal: null, level: 1, scope: 'scope_4x' }, local(noGuns()));
    expect(m.groundScope).toBe('scope_4x');
    expect(scopeSight('scope_red_dot')).toBe('red_dot');
    expect(scopeSight('scope_8x')).toBe('scope_8x');
  });
});

describe('M2C-UI-11 throwable slot model', () => {
  it('main = selected type, mini chip = the other only when carried, hint only while active with both', () => {
    const both = local(noGuns(), { throwables: { grenade: 2, smoke: 1 }, throwableSelected: 'grenade', activeSlot: 3 });
    expect(throwableSlotModel(both)).toEqual({ main: 'grenade', mainCount: 2, other: 'smoke', otherCount: 1, empty: false, cycleHint: true });
    const inactive = { ...both, activeSlot: 0 as const };
    expect(throwableSlotModel(inactive).cycleHint).toBe(false);
    const onlySmoke = local(noGuns(), { throwables: { grenade: 0, smoke: 1 }, throwableSelected: 'smoke', activeSlot: 3 });
    expect(throwableSlotModel(onlySmoke)).toMatchObject({ main: 'smoke', mainCount: 1, other: null, cycleHint: false });
    const none = local(noGuns(), { throwables: { grenade: 0, smoke: 0 }, throwableSelected: 'grenade' });
    expect(throwableSlotModel(none).empty).toBe(true);
  });

  it('falls back to the M2a grenade fields when the M2c fields are absent', () => {
    const m2a = local(noGuns(), { grenades: 2 });
    expect(throwableSlotModel(m2a)).toMatchObject({ main: 'grenade', mainCount: 2, other: null, empty: false });
  });
});

describe('M2C-UI-33 sight chip and M2C-UI-38 pouch', () => {
  it('none for iron, outline for a built-in optic, filled for a mounted scope, red-dot glyph', () => {
    expect(sightChipModel(slot(0, 'rifle', { sight: 'iron', builtInSight: 'iron', scope: null }) as never).kind).toBe('none');
    expect(sightChipModel(slot(0, 'dmr', { sight: 'scope_4x', builtInSight: 'scope_4x', scope: null }) as never)).toEqual({
      kind: 'builtIn',
      label: '4×',
      sight: 'scope_4x',
    });
    expect(sightChipModel(slot(0, 'rifle', { sight: 'scope_2x' as never, builtInSight: 'iron', scope: 'scope_2x' }) as never)).toEqual({
      kind: 'mounted',
      label: '2×',
      sight: 'scope_2x',
    });
    expect(sightChipModel(slot(0, 'smg', { sight: 'red_dot', builtInSight: 'iron', scope: 'scope_red_dot' }) as never)).toEqual({
      kind: 'mounted',
      label: null,
      sight: 'red_dot',
    });
    expect(sightChipModel(slot(0, null) as never).kind).toBe('none');
    expect(sightChipModel(null).kind).toBe('none');
  });

  it('pouch chips fit / do not fit the active gun', () => {
    const chips = pouchModel(['scope_2x', 'scope_8x'], { compatibleScopes: ['scope_red_dot', 'scope_2x'] });
    expect(chips).toEqual([
      { scope: 'scope_2x', fits: true },
      { scope: 'scope_8x', fits: false },
    ]);
    expect(pouchModel(undefined, null)).toEqual([]);
    expect(pouchModel(['scope_4x'], null)).toEqual([{ scope: 'scope_4x', fits: false }]);
  });
});

describe('M2C-UI-22 smoke hit markers, M2C-UI-16 / 18 reticles, M2C-UI-39 2x overlay', () => {
  it('obscured body / head / armor markers hide; kills always show', () => {
    expect(hitMarkerVisible(true, false)).toBe(false);
    expect(hitMarkerVisible(true, true)).toBe(true);
    expect(hitMarkerVisible(false, false)).toBe(true);
    expect(hitMarkerVisible(undefined, false)).toBe(true);
  });

  it('melee weapons and the smoke can are dot-only', () => {
    const base = { cameraView: 'firstPerson' as const, alive: true, airborne: false, spectating: false };
    expect(reticleMode({ ...base, weapon: 'knife' })).toBe('dot');
    expect(reticleMode({ ...base, weapon: 'paddle' })).toBe('dot');
    expect(reticleMode({ ...base, weapon: 'smoke' })).toBe('dot');
    expect(reticleMode({ ...base, weapon: 'rpg' })).toBe('full');
  });

  it('the 2x scope gets the full-screen overlay once scoped (hasScopeOverlay)', () => {
    const ads = (sight: string, scoped: boolean): AdsView => ({ sight: sight as AdsView['sight'], progress: 1, cameraBlend: 1, zoom: 2, scoped });
    expect(adsReticle(ads('scope_2x', true), true).scope).toBe('scope_2x');
    expect(adsReticle(ads('scope_2x', false), true).scope).toBeNull();
    expect(adsReticle(ads('scope_4x', true), true).scope).toBe('scope_4x');
    expect(adsReticle(ads('red_dot', true), true).scope).toBeNull();
  });
});

describe('M2C-UI-19 kill feed routing (narrative M2c §5)', () => {
  const kill = (p: Partial<KillInfo>): KillInfo => ({ killerName: 'Pat', victimName: 'Sue', weapon: 'rifle', cause: 'weapon', ...p });
  const all = (): boolean => true;
  const none = (): boolean => false;

  it('rockets: self, direct, blast; no killer is generic', () => {
    expect(killFeedPrefix(kill({ weapon: 'rpg', cause: 'explosion' }), false, all)).toBe('feed.rocket');
    expect(killFeedPrefix(kill({ weapon: 'rpg', cause: 'rocket' as never, direct: true }), false, all)).toBe('feed.rocketDirect');
    expect(killFeedPrefix(kill({ weapon: 'rpg', cause: 'explosion', direct: true }), false, none)).toBe('feed.rocket');
    expect(killFeedPrefix(kill({ weapon: 'rpg', cause: 'explosion', self: true }), false, all)).toBe('feed.rocketSelf');
    expect(killFeedPrefix(kill({ weapon: 'rpg', cause: 'explosion', killerName: null }), false, all)).toBe('feed.generic');
    expect(isRocketFeedPrefix('feed.rocketDirect')).toBe(true);
  });

  it('melee: fists keep feed.melee; per-weapon lines, headshots, and the generic fallback', () => {
    expect(killFeedPrefix(kill({ weapon: 'fists' }), false, all)).toBe('feed.melee');
    expect(killFeedPrefix(kill({ weapon: 'paddle' as never, cause: 'melee' as never }), false, all)).toBe('feed.paddle');
    expect(killFeedPrefix(kill({ weapon: 'knife' as never, cause: 'melee' as never }), true, all)).toBe('feed.meleeHeadshot');
    expect(killFeedPrefix(kill({ weapon: 'machete' as never, cause: 'melee' as never }), false, none)).toBe('feed.meleeWeapon');
  });

  it('frags and guns are unchanged; smoke lines only with throughSmoke', () => {
    expect(killFeedPrefix(kill({ weapon: 'grenade', cause: 'explosion' }), false, all)).toBe('feed.grenade');
    expect(killFeedPrefix(kill({}), true, all)).toBe('feed.headshot');
    expect(killFeedPrefix(kill({ throughSmoke: true }), false, all)).toBe('feed.smoke');
    expect(killFeedPrefix(kill({}), false, all)).toBe('feed.kill');
  });

  it('every routed group exists in en.json', () => {
    for (const p of ['feed.rocket', 'feed.rocketDirect', 'feed.rocketSelf', 'feed.meleeWeapon', 'feed.meleeHeadshot', 'feed.knife', 'feed.machete', 'feed.paddle', 'feed.smoke']) {
      expect(hasKey(`${p}.0`), p).toBe(true);
    }
  });

  it('M2C-UI-06 weapon tag: badge for guns, melee and rpg; none for fists, frags, zone, self', () => {
    expect(killWeaponTag(kill({}), 3)).toEqual({ weapon: 'rifle', level: 3 });
    expect(killWeaponTag(kill({ weapon: 'rpg', cause: 'explosion' }), 2)).toEqual({ weapon: 'rpg', level: 2 });
    expect(killWeaponTag(kill({ weapon: 'knife' as never, cause: 'melee' as never }), 1)).toEqual({ weapon: 'knife', level: 1 });
    expect(killWeaponTag(kill({ weapon: 'fists' }), null)).toBeNull();
    expect(killWeaponTag(kill({ weapon: 'grenade', cause: 'explosion' }), null)).toBeNull();
    expect(killWeaponTag(kill({ cause: 'zone', weapon: null }), null)).toBeNull();
    expect(killWeaponTag(kill({ weapon: 'rpg', cause: 'explosion', self: true }), 2)).toBeNull();
  });

  it('death card self-rocket line and blast self-kill detection', () => {
    expect(deathCauseKey('explosion', null, true, 'rpg')).toBe('death.eliminatedBySelfRocket');
    expect(deathCauseKey('rocket' as never, 'Pat', true, 'rpg')).toBe('death.eliminatedBySelfRocket');
    expect(deathCauseKey('explosion', null, true, 'grenade')).toBe('death.eliminatedBySelf');
    expect(isSelfBlastKill('rocket' as never, 5, 5, null)).toBe(true);
    expect(isSelfBlastKill('melee' as never, null, 5, 5)).toBe(false);
  });
});

describe('M2c refusals (actionFailed)', () => {
  it('maps the scope reasons and the throwable slot', () => {
    expect(actionFailedKey('scope' as never, 'scopePouchFull' as never)).toBe('hud.scope.pouchFull');
    expect(actionFailedKey('scope' as never, 'scopeCantFit' as never)).toBe('hud.scope.cantFit');
    expect(actionFailedKey('scope' as never, 'scopeNoneFits' as never)).toBe('hud.scope.noneFits');
    expect(actionFailedKey('swap', 'noGrenades')).toBe('hud.throwable.none');
    expect(actionFailedKey('pickup', 'inventoryFull', 'smoke' as never)).toBe('hud.smoke.full');
  });
});

describe('M2C-UI-25..28 layout: minimap props, look line, layout code', () => {
  it('island blocks: huts yes; crates, palms, bushes, docks and normal rocks no; big rocks yes', () => {
    expect(islandPropBlock('hut', 1)).toEqual({ shape: 'box', hx: 2.05, hz: 2.05 });
    expect(islandPropBlock('crate', 1)).toBeNull();
    expect(islandPropBlock('palm', 1)).toBeNull();
    expect(islandPropBlock('bush', 1)).toBeNull();
    expect(islandPropBlock('dock', 1)).toBeNull();
    expect(islandPropBlock('rock', 1)).toBeNull();
    expect(islandPropBlock('rock', 1.4)).not.toBeNull();
  });

  it('look line from lobby.look.<map> + look.<map>.<id>; glyph family', () => {
    expect(lookLine('island01', 'golden')).toBe(t('lobby.look.island01', { look: t('look.island01.golden') }));
    expect(lookLine('office', 'afterHours')).toBe(t('lobby.look.office', { look: t('look.office.afterHours') }));
    expect(lookLine('office', 'nope')).toBeNull();
    expect(lookLine(null, 'golden')).toBeNull();
    expect(lookGlyph('golden')).toBe('sunset');
    expect(lookGlyph('afterHours')).toBe('moon');
    expect(lookGlyph('overcast')).toBe('cloud');
    expect(lookGlyph('noon')).toBe('sun');
  });

  it('every look id the shared types allow has a name', () => {
    for (const id of ['morning', 'noon', 'golden', 'overcast']) expect(hasKey(`look.island01.${id}`)).toBe(true);
    for (const id of ['day', 'evening', 'afterHours']) expect(hasKey(`look.office.${id}`)).toBe(true);
  });

  it('layout code uses formatLayoutSeed (the LAYOUT_SEED text)', () => {
    expect(t('layout.seed', { seed: formatLayoutSeed(0x1a2b) })).toContain('0x00001A2B');
  });
});

describe('M2C-UI-32 controls rows', () => {
  it('lists melee, throwable, cycle and scope rows with their strings; the grenade row is gone', () => {
    for (const id of ['melee', 'throwable', 'throwableCycle', 'scope'] as const) {
      expect(CONTROL_IDS).toContain(id);
      expect(hasKey(`menu.controls.${id}.key`)).toBe(true);
      expect(hasKey(`menu.controls.${id}.label`)).toBe(true);
    }
    expect(CONTROL_IDS as readonly string[]).not.toContain('grenade');
  });
});

describe('M2c strings used by the HUD exist', () => {
  it('has every key', () => {
    const keys = [
      'hud.pickup.swapFrom',
      'hud.pickup.levelUp',
      'hud.level.up',
      'hud.level.down',
      'hud.level.same',
      'hud.slot.sr',
      'hud.throwable.sr',
      'hud.throwable.swap',
      'hud.throwable.selected',
      'hud.smoke.throw',
      'hud.melee.replacesFists',
      'hud.melee.dropped',
      'hud.rocket.none',
      'hud.scope.mountsOn',
      'hud.scope.toPouch',
      'hud.scope.fits',
      'hud.scope.mounted',
      'hud.scope.now',
      'hud.scope.mounting',
      'hud.scope.builtIn',
      'hud.scope.inPouch',
      'hud.scope.cycle',
      'hud.scope.sr',
      'hud.scope.stash',
      'sight.scope_2x',
      'death.with',
      'layout.seed',
      'level.aria',
      'gear.tier.4',
      'hint.level',
      'hint.melee',
      'hint.smoke',
      'hint.throwableCycle',
      'hint.rocket',
      'hint.scope',
    ];
    for (const k of keys) expect(hasKey(k), k).toBe(true);
  });
});
