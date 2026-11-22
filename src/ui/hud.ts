/**
 * In-match HUD: vitals (HP, M2a vest + helmet pieces, stance), weapon slots (M2a: 4, slot 4 = grenades), ammo + heals,
 * crosshair (M2a: ADS dot / red dot; the scope frame is ads.ts) + progress ring + grenade cook ring, hit marker
 * (M2a armor variants), damage direction, grenade danger icons, alive/kills, tide status, minimap, pickup prompt
 * (M2a armor tier + durability), toasts, outside-zone warning, spectate bar.
 * M2b: first-person layout (UI.md §13.2: slots above the ammo panel, hints above the vitals), the centre reticle by
 * camera case (logic.reticleMode), the aboard / freefall HUD (drop.ts), zone strings by HudView.zoneTheme, the
 * spectate view chip ([V] first person / chase), the ADS-blocked hint and the danger blink by fuse time.
 * M2c (docs/ui/M2c.md): level badges (slots, prompt, armor 4 pips), the melee slot, the throwable slot (selected type +
 * mini chip + cycle hint), sight chips and the spare-scope pouch (tap / click = T), level / swap / scope prompts, the
 * melee recovery ring, hidden hit markers through smoke, the in-smoke crosshair outline, smoke's cook ring and the
 * "Sight: …" chip on a T switch. Every M2c field is optional until the C-gate; absent = M2b behaviour.
 * Every per-frame write goes through a diffing helper (TextSlot / Flags / Shown / StyleVar).
 * Owner: ui-ux-designer.
 */
import { t } from '../content/strings';
import { scopeFits, type Balance, type ZoneTheme } from '../shared/balance';
import type { HudArmorView, HudLocalView, HudSlotView, HudView } from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import {
  isMeleeId,
  M2C_GUN_IDS,
  type ArmorSlot,
  type HealId,
  type ItemLevel,
  type M2cActionFailReason,
  type M2cArmorTier,
  type M2cHeldId,
  type M2cItemId,
  type M2cThrowableId,
  type ScopeId,
  type SlotIndex,
  type Vec3,
} from '../shared/types';
import { SightReticle } from './ads';
import { DataSlot, Flags, h, Shown, StyleVar, svg, TextSlot, retrigger } from './dom';
import { DropHud } from './drop';
import { icon, levelBadge, setIcon, setLevelBadge, type IconId } from './icons';
import {
  adsReticle,
  armorPromptDetail,
  cookView,
  dangerBlink,
  dangerPlacement,
  dangerScale,
  gearView,
  hitVignetteStrength,
  isHeavyHit,
  isLowHp,
  lowHpThresholdOf,
  levelLabel,
  pickupPromptModel,
  pouchModel,
  ratio,
  scopeSight,
  sightChipModel,
  throwableSlotModel,
  relativeBearingDeg,
  reticleMode,
  spreadToPx,
  stanceView,
  tidePhaseNumbers,
  tideStatus,
  zoneKey,
  type AdsReticle,
  type HitVariant,
  type PromptInput,
} from './logic';
import { Minimap, type CoastlineFn } from './minimap';

const DAMAGE_ARC_MS = 1100;
const TOAST_MS = 2400;
/** Refusal toasts (actionFailed) are shorter: they answer a key press, they do not report news. */
const FAIL_TOAST_MS = 1600;
const MAX_TOASTS = 3;
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;
/** M2c melee swing-recovery ring (inside the reload ring, UI M2c §4). */
const MELEE_R = 14;
const MELEE_C = 2 * Math.PI * MELEE_R;
/** M2c: "Sight: 2x scope" chip after a T switch (UI M2c §16.4). */
const SIGHT_NOW_MS = 1200;
/** M2c: spare-scope chips drawn at most (UI M2c §16.2). */
const MAX_POUCH = 4;
/** Cook ring sits just outside the reload/heal ring radius. */
const COOK_R = 26;
const COOK_C = 2 * Math.PI * COOK_R;
/** A broken piece stays crossed out this long before the slot goes back to the empty outline. */
const BROKEN_SHOW_MS = 2500;
/** Danger icons stay this far (CSS px) inside the HUD box edge. */
const DANGER_MARGIN_PX = 64;
const MAX_DANGER = 4;
const SLOT_COUNT = 4;
const decimal1 = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** Fraction of the magazine at or below which the ammo counter shows the "low" treatment. */
const LOW_MAG = 0.25;

type DamagePayload = GameEvents['playerDamaged'];

interface Bar {
  root: HTMLDivElement;
  fill: StyleVar;
  ghost: StyleVar;
  value: TextSlot;
  flags: Flags;
  last: number;
}

interface SlotUi {
  el: HTMLElement;
  flags: Flags;
  icon: HTMLSpanElement;
  name: TextSlot;
  mag: TextSlot;
  /** M2c level badge (guns, melee). */
  badge: HTMLSpanElement;
  /** M2c sight chip (guns): tap / click = T. */
  sight: HTMLButtonElement;
  sightFlags: Flags;
  sightText: TextSlot;
  sightShown: Shown;
  /** M2c throwable slot: the other type (mini chip). */
  mini: HTMLSpanElement;
  miniIcon: HTMLSpanElement;
  miniCount: TextSlot;
  miniShown: Shown;
  /** M2c throwable slot: "[4] Swap" while active with both types. */
  cycle: Shown;
  sr: TextSlot;
  /** Last weapon + sight seen (pop on change). */
  lastKey: string;
  lastSight: string;
}

interface PouchChipUi {
  el: HTMLElement;
  icon: HTMLSpanElement;
  flags: Flags;
  shown: Shown;
}

interface DamageArc {
  el: HTMLDivElement;
  angle: StyleVar;
  source: Vec3;
  until: number;
  shown: Shown;
}

interface Toast {
  el: HTMLDivElement;
  until: number;
  /** String key for refusal toasts, so a repeated press refreshes one toast instead of stacking copies. */
  failKey: string | null;
}

interface GearUi {
  slot: ArmorSlot;
  el: HTMLElement;
  flags: Flags;
  icon: HTMLSpanElement;
  pips: DataSlot;
  fill: StyleVar;
  text: TextSlot;
  sr: TextSlot;
  /** Tier that broke, shown crossed out until brokenUntil. */
  brokenTier: 0 | M2cArmorTier;
  brokenUntil: number;
  /** Last durability seen (a drop retriggers the hit flash). */
  last: number;
}

interface DangerUi {
  el: HTMLDivElement;
  shown: Shown;
  flags: Flags;
  pos: StyleVar;
  scale: StyleVar;
  arrow: StyleVar;
  blink: StyleVar;
}

function makeGear(slot: ArmorSlot): { el: HTMLElement; ui: GearUi } {
  const ic = icon(null, 'ui-gear__icon');
  const pipsEl = h(
    'span',
    'ui-gear__pips',
    { 'aria-hidden': 'true' },
    h('span', 'ui-gear__pip'),
    h('span', 'ui-gear__pip'),
    h('span', 'ui-gear__pip'),
    h('span', 'ui-gear__pip'),
  );
  const fill = h('div', 'ui-gear__fill');
  const text = h('span', 'ui-gear__text ui-num', { 'aria-hidden': 'true' });
  const sr = h('span', 'ui-sr');
  const el = h(
    'div',
    `ui-gear ui-gear--${slot}`,
    { role: 'group' },
    h('div', 'ui-gear__badge', null, ic, pipsEl),
    h('div', 'ui-gear__info', null, text, h('div', 'ui-gear__track', { 'aria-hidden': 'true' }, fill)),
    sr,
  );
  return {
    el,
    ui: {
      slot,
      el,
      flags: new Flags(el),
      icon: ic,
      pips: new DataSlot(pipsEl, 'tier'),
      fill: new StyleVar(fill, '--r'),
      text: new TextSlot(text),
      sr: new TextSlot(sr),
      brokenTier: 0,
      brokenUntil: 0,
      last: -1,
    },
  };
}

/** "DMR, Sniper": gun types (item.<id>.type) that take this scope (balance scopes.compatible, via mapChanged). */
function fitNames(balance: Balance | null, scope: ScopeId): string {
  if (!balance) return '';
  return M2C_GUN_IDS.filter((gun) => scopeFits(balance, gun, scope))
    .map((gun) => t(`item.${gun}.type`))
    .join(', ');
}

function makeBar(kind: 'hp', labelKey: string): Bar {
  const fill = h('div', 'ui-bar__fill');
  const ghost = h('div', 'ui-bar__ghost');
  const value = h('span', 'ui-bar__value ui-num');
  const root = h(
    'div',
    `ui-bar ui-bar--${kind}`,
    null,
    h('span', `ui-bar__glyph ui-bar__glyph--${kind}`, { 'aria-hidden': 'true' }),
    h('span', 'ui-bar__label', null, t(labelKey)),
    h('div', 'ui-bar__track', null, ghost, fill),
    value,
  );
  return {
    root,
    fill: new StyleVar(fill, '--r'),
    ghost: new StyleVar(ghost, '--r'),
    value: new TextSlot(value),
    flags: new Flags(root),
    last: -1,
  };
}

function updateBar(bar: Bar, value: number, max: number, low: boolean): void {
  const r = ratio(value, max);
  const q = (Math.round(r * 1000) / 1000).toString();
  if (bar.last >= 0 && value < bar.last) {
    bar.flags.set('is-healing', false);
    retrigger(bar.root, 'is-hit');
  } else if (value > bar.last) {
    // Increases snap the ghost so it never trails a heal.
    bar.flags.set('is-healing', true);
  }
  bar.last = value;
  bar.fill.set(q);
  bar.ghost.set(q);
  bar.value.set(String(Math.max(0, Math.ceil(value))));
  bar.flags.set('is-low', low);
  bar.flags.set('is-empty', r <= 0);
}

export class Hud {
  readonly el: HTMLDivElement;
  private readonly rootFlags: Flags;
  readonly feedSlot: HTMLDivElement;
  readonly bannerSlot: HTMLDivElement;
  readonly hintSlot: HTMLDivElement;

  // top right
  private readonly alive: TextSlot;
  private readonly kills: TextSlot;
  private readonly killsShown: Shown;
  private readonly tide: HTMLDivElement;
  private readonly tideShown: Shown;
  private readonly tideFlags: Flags;
  private readonly tidePhase: TextSlot;
  private readonly tideText: TextSlot;
  private readonly tideClock: TextSlot;
  private readonly tideGlyph: DataSlot;
  private readonly minimap: Minimap;
  private readonly drop: DropHud;

  // bottom
  private readonly hp: Bar;
  private readonly gear: Record<ArmorSlot, GearUi>;
  private readonly stanceFlags: Flags;
  private readonly stanceProgress: StyleVar;
  private readonly stanceSr: TextSlot;
  private readonly stanceEl: HTMLElement;
  private readonly slots: SlotUi[];
  /** M2c spare-scope pouch (UI M2c §16.2). */
  private readonly pouchShown: Shown;
  private readonly pouchChips: PouchChipUi[] = [];
  private readonly pouchCount: TextSlot;
  private readonly pouchFlags: Flags;
  /** M2c: screen-reader announcement of the throwable cycle ("Smoke ready"). */
  private readonly liveText: TextSlot;
  /** items.<id>.durability learned from worn pieces (the prompt's "31/55" until the event carries the max). */
  private readonly maxDurability = new Map<M2cItemId, number>();
  private readonly ammo: TextSlot;
  private readonly ammoNote: TextSlot;
  private readonly ammoFlags: Flags;
  private readonly reloadBar: StyleVar;
  private readonly heals: Record<HealId, { count: TextSlot; flags: Flags }>;

  // centre
  private readonly crosshair: HTMLDivElement;
  private readonly crosshairShown: Shown;
  private readonly crosshairFlags: Flags;
  private readonly spread: StyleVar;
  private readonly hipOpacity: StyleVar;
  private readonly sight: SightReticle;
  /** Last ADS reticle state (Ui reads `.scope` for the full-screen overlay). */
  reticle: AdsReticle = adsReticle(null);
  private readonly cook: HTMLDivElement;
  private readonly cookShown: Shown;
  private readonly cookFlags: Flags;
  private readonly cookOffset: StyleVar;
  private readonly cookSecs: TextSlot;
  private readonly cookLabel: TextSlot;
  private readonly dangers: DangerUi[] = [];
  private readonly ring: HTMLDivElement;
  private readonly ringShown: Shown;
  private readonly ringOffset: StyleVar;
  private readonly ringLabel: TextSlot;
  private readonly ringHint: TextSlot;
  /** M2c melee swing-recovery ring. */
  private readonly meleeRing: Shown;
  private readonly meleeOffset: StyleVar;
  /** M2c "Sight: …" chip after a T switch. */
  private readonly sightNow: Shown;
  private readonly sightNowText: TextSlot;
  private sightNowUntil = 0;
  private readonly hitmarker: HTMLDivElement;
  private readonly arcs: DamageArc[] = [];
  private nextArc = 0;
  private readonly pendingDamage: DamagePayload[] = [];
  private readonly vignetteHit: HTMLDivElement;
  private readonly vignetteTide: Shown;
  private readonly outside: Shown;
  private readonly outsideArrow: StyleVar;
  private readonly outsideText: TextSlot;
  private readonly adsBlocked: Shown;
  private readonly adsBlockedText: TextSlot;

  // prompt + toasts
  private readonly prompt: HTMLDivElement;
  private readonly promptShown: Shown;
  private readonly promptText: TextSlot;
  private readonly promptFlags: Flags;
  private readonly promptIcon: HTMLSpanElement;
  private readonly promptDetail: Shown;
  private readonly promptPips: DataSlot;
  private readonly promptTier: TextSlot;
  private readonly promptDur: TextSlot;
  /** M2c prompt parts: level badge + "Lv.3 Hot", the compare tag + old badge, the scope target, a note. */
  private readonly promptLevel: Shown;
  private readonly promptBadge: HTMLSpanElement;
  private readonly promptLevelText: TextSlot;
  private readonly promptCompare: Shown;
  private readonly promptCompareFlags: Flags;
  private readonly promptCompareText: TextSlot;
  private readonly promptOldBadge: HTMLSpanElement;
  private readonly promptExtra: Shown;
  private readonly promptExtraText: TextSlot;
  private readonly promptChip: Shown;
  private readonly promptChipText: TextSlot;
  private readonly promptChipFlags: Flags;
  private readonly promptChipEl: HTMLSpanElement;
  private promptInput: PromptInput | null = null;
  private promptDurability: number | null = null;
  private promptMaxDurability: number | null = null;
  /** M2c: sight-chip tap / click (UiCallbacks.onCycleScope through Ui). */
  onCycleScope: (() => void) | null = null;
  /** M2c: the effective per-map balance from mapChanged (scope compatibility for "Fits: …"). */
  balance: Balance | null = null;
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Toast[] = [];

  // spectate
  private readonly spectate: Shown;
  private readonly spectateFlags: Flags;
  private readonly spectateName: TextSlot;
  private readonly spectateHp: StyleVar;
  private readonly spectateHpText: TextSlot;
  private readonly spectateView: Shown;
  private readonly spectateViewFlags: Flags;
  private readonly spectateViewText: TextSlot;
  /** M2c (P2): the target's held weapon icon + level badge. */
  private readonly spectateWeapon: Shown;
  private readonly spectateWeaponIcon: HTMLSpanElement;
  private readonly spectateWeaponBadge: HTMLSpanElement;

  /** Suppresses the persistent drop prompt while the one-time drop hint is up. */
  dropHintActive = false;
  /** M2b: zone fiction of the current map (HudView.zoneTheme, or mapChanged before the first frame). */
  zoneTheme: ZoneTheme = 'tide';

  constructor(coastline: CoastlineFn | null) {
    // --- top left: kill feed lives here (filled by KillFeed)
    this.feedSlot = h('div', 'ui-hud__feed');

    // --- top right
    const aliveEl = h('span', 'ui-chip__text');
    const killsEl = h('span', 'ui-chip__text');
    const killsChip = h('div', 'ui-chip ui-chip--kills', null, h('span', 'ui-glyph ui-glyph--star', { 'aria-hidden': 'true' }), killsEl);
    this.minimap = new Minimap(coastline);
    const tidePhase = h('span', 'ui-tide__phase');
    const tideText = h('span', 'ui-tide__text');
    const tideClock = h('span', 'ui-tide__clock ui-num');
    const tideGlyph = h('span', 'ui-glyph ui-glyph--zone', { 'aria-hidden': 'true', 'data-theme': 'tide' });
    this.tide = h(
      'div',
      'ui-chip ui-tide',
      { role: 'status' },
      tideGlyph,
      tidePhase,
      tideText,
      tideClock,
    );
    const topRight = h(
      'div',
      'ui-hud__tr',
      null,
      h(
        'div',
        'ui-hud__stats',
        null,
        h('div', 'ui-chip ui-chip--alive', null, h('span', 'ui-glyph ui-glyph--person', { 'aria-hidden': 'true' }), aliveEl),
        killsChip,
      ),
      this.minimap.el,
      this.tide,
    );
    this.alive = new TextSlot(aliveEl);
    this.kills = new TextSlot(killsEl);
    this.killsShown = new Shown(killsChip);
    this.tideShown = new Shown(this.tide);
    this.tideFlags = new Flags(this.tide);
    this.tidePhase = new TextSlot(tidePhase);
    this.tideText = new TextSlot(tideText);
    this.tideClock = new TextSlot(tideClock);
    this.tideGlyph = new DataSlot(tideGlyph, 'theme');

    // --- centre
    const lines = ['n', 'e', 's', 'w'].map((d) => h('span', `ui-crosshair__line ui-crosshair__line--${d}`));
    this.crosshair = h('div', 'ui-crosshair', { 'aria-hidden': 'true' }, ...lines, h('span', 'ui-crosshair__dot'));
    this.crosshairShown = new Shown(this.crosshair);
    this.crosshairFlags = new Flags(this.crosshair);
    this.spread = new StyleVar(this.crosshair, '--spread');
    this.hipOpacity = new StyleVar(this.crosshair, '--hip');
    this.sight = new SightReticle();

    // M2a: grenade cook ring (fuse left) + "[LMB] Hold to cook" when a grenade is in hand.
    const cookCircle = svg('circle', {
      class: 'ui-cook__fg',
      cx: 32,
      cy: 32,
      r: COOK_R,
      'stroke-dasharray': COOK_C.toFixed(2),
    });
    const cookSvg = svg(
      'svg',
      { class: 'ui-cook__svg', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      svg('circle', { class: 'ui-cook__bg', cx: 32, cy: 32, r: COOK_R }),
      cookCircle,
    );
    const cookSecs = h('span', 'ui-cook__secs ui-num');
    const cookLabel = h('span', 'ui-cook__label');
    this.cook = h('div', 'ui-cook', { role: 'status' }, cookSvg, h('div', 'ui-cook__text', null, cookSecs, cookLabel));
    this.cookShown = new Shown(this.cook);
    this.cookFlags = new Flags(this.cook);
    this.cookOffset = new StyleVar(this.cook, '--cook-offset');
    this.cookSecs = new TextSlot(cookSecs);
    this.cookLabel = new TextSlot(cookLabel);

    // M2a: grenade danger icons (on screen or pinned to the edge with a pointer).
    const dangerBox = h('div', 'ui-dangers', { 'aria-hidden': 'true' });
    for (let i = 0; i < MAX_DANGER; i++) {
      const el = h(
        'div',
        'ui-danger',
        null,
        h('span', 'ui-danger__arrow'),
        h('span', 'ui-danger__ring'),
        icon('grenade', 'ui-danger__icon'),
      );
      el.hidden = true;
      dangerBox.appendChild(el);
      this.dangers.push({
        el,
        shown: new Shown(el),
        flags: new Flags(el),
        pos: new StyleVar(el, '--pos'),
        scale: new StyleVar(el, '--s'),
        arrow: new StyleVar(el, '--a'),
        blink: new StyleVar(el, '--blink'),
      });
    }

    const ringCircle = svg('circle', {
      class: 'ui-ring__fg',
      cx: 30,
      cy: 30,
      r: RING_R,
      'stroke-dasharray': RING_C.toFixed(2),
    });
    const ringSvg = svg(
      'svg',
      { class: 'ui-ring__svg', viewBox: '0 0 60 60', 'aria-hidden': 'true' },
      svg('circle', { class: 'ui-ring__bg', cx: 30, cy: 30, r: RING_R }),
      ringCircle,
    );
    const ringLabel = h('span', 'ui-ring__label');
    const ringHint = h('span', 'ui-ring__hint');
    this.ring = h('div', 'ui-ring', { role: 'status' }, ringSvg, h('div', 'ui-ring__text', null, ringLabel, ringHint));
    this.ringShown = new Shown(this.ring);
    this.ringOffset = new StyleVar(this.ring, '--ring-offset');
    this.ringLabel = new TextSlot(ringLabel);
    this.ringHint = new TextSlot(ringHint);

    // M2c: melee swing-recovery ring (thin, inside the reload ring) and the "Sight: …" chip.
    const meleeCircle = svg('circle', { class: 'ui-melee__fg', cx: 20, cy: 20, r: MELEE_R, 'stroke-dasharray': MELEE_C.toFixed(2) });
    const meleeEl = h(
      'div',
      'ui-melee',
      { 'aria-hidden': 'true' },
      svg('svg', { class: 'ui-melee__svg', viewBox: '0 0 40 40' }, svg('circle', { class: 'ui-melee__bg', cx: 20, cy: 20, r: MELEE_R }), meleeCircle),
    );
    this.meleeRing = new Shown(meleeEl);
    this.meleeOffset = new StyleVar(meleeEl, '--melee-offset');
    const sightNowText = h('span', null);
    const sightNowEl = h('div', 'ui-sightnow ui-chip', { role: 'status' }, sightNowText);
    this.sightNow = new Shown(sightNowEl);
    this.sightNowText = new TextSlot(sightNowText);

    this.hitmarker = h(
      'div',
      'ui-hitmarker',
      { 'aria-hidden': 'true' },
      ...['a', 'b', 'c', 'd'].map((d) => h('span', `ui-hitmarker__tick ui-hitmarker__tick--${d}`)),
      h('span', 'ui-hitmarker__crown'),
      h('span', 'ui-hitmarker__vest'),
      h('span', 'ui-hitmarker__helmet'),
      ...['a', 'b', 'c', 'd'].map((d) => h('span', `ui-hitmarker__shard ui-hitmarker__shard--${d}`)),
    );

    const arcBox = h('div', 'ui-dmgarcs', { 'aria-hidden': 'true' });
    for (let i = 0; i < 4; i++) {
      const el = h('div', 'ui-dmgarc', null, h('div', 'ui-dmgarc__shape'));
      el.hidden = true;
      arcBox.appendChild(el);
      this.arcs.push({ el, angle: new StyleVar(el, '--a'), source: { x: 0, y: 0, z: 0 }, until: 0, shown: new Shown(el) });
    }

    const outsideArrow = h('span', 'ui-outside__arrow', { 'aria-hidden': 'true' });
    const outsideText = h('span', null, null, t('hud.tide.outside'));
    const outside = h('div', 'ui-outside', { role: 'alert' }, outsideArrow, outsideText);
    this.outside = new Shown(outside);
    this.outsideArrow = new StyleVar(outsideArrow, '--a');
    this.outsideText = new TextSlot(outsideText);
    // M2a addendum: RMB held but ADS blocked by a reload or a heal (HudView.adsBlocked).
    const adsBlockedText = h('span', null);
    const adsBlockedEl = h(
      'div',
      'ui-adsblock ui-chip',
      { role: 'status' },
      h('span', 'ui-glyph ui-glyph--warn', { 'aria-hidden': 'true' }),
      adsBlockedText,
    );
    this.adsBlocked = new Shown(adsBlockedEl);
    this.adsBlockedText = new TextSlot(adsBlockedText);

    // --- prompt + toasts + message slots
    const promptText = h('span', 'ui-prompt__text');
    this.promptIcon = icon(null, 'ui-prompt__icon');
    const promptPips = h(
      'span',
      'ui-gear__pips ui-gear__pips--row',
      { 'aria-hidden': 'true' },
      h('span', 'ui-gear__pip'),
      h('span', 'ui-gear__pip'),
      h('span', 'ui-gear__pip'),
    );
    const promptTier = h('span', 'ui-prompt__tier');
    const promptDur = h('span', 'ui-prompt__dur ui-num');
    const promptDetail = h('span', 'ui-prompt__detail', null, promptPips, promptTier, promptDur);
    // M2c (UI M2c §3, §16.3)
    this.promptBadge = levelBadge('ui-prompt__badge');
    const promptLevelText = h('span', 'ui-prompt__lvtext');
    this.promptOldBadge = levelBadge('ui-prompt__badge');
    const promptCompareText = h('span', null);
    const promptCompare = h('span', 'ui-prompt__compare', null, promptCompareText, this.promptOldBadge);
    const promptLevel = h('span', 'ui-prompt__detail ui-prompt__level', null, this.promptBadge, promptLevelText, promptCompare);
    const promptChipText = h('span', 'ui-sightchip__text');
    const promptChip = h('span', 'ui-sightchip ui-prompt__chip', { 'aria-hidden': 'true' }, promptChipText);
    const promptExtraText = h('span', null);
    const promptExtra = h('span', 'ui-prompt__detail ui-prompt__extra', null, promptExtraText);
    this.prompt = h(
      'div',
      'ui-prompt ui-chip',
      { role: 'status' },
      this.promptIcon,
      promptText,
      promptChip,
      promptLevel,
      promptDetail,
      promptExtra,
    );
    this.promptLevel = new Shown(promptLevel);
    this.promptLevelText = new TextSlot(promptLevelText);
    this.promptCompare = new Shown(promptCompare);
    this.promptCompareFlags = new Flags(promptCompare);
    this.promptCompareText = new TextSlot(promptCompareText);
    this.promptExtra = new Shown(promptExtra);
    this.promptExtraText = new TextSlot(promptExtraText);
    this.promptChip = new Shown(promptChip);
    this.promptChipText = new TextSlot(promptChipText);
    this.promptChipFlags = new Flags(promptChip);
    this.promptChipEl = promptChip;
    this.promptShown = new Shown(this.prompt);
    this.promptDetail = new Shown(promptDetail);
    this.promptPips = new DataSlot(promptPips, 'tier');
    this.promptTier = new TextSlot(promptTier);
    this.promptDur = new TextSlot(promptDur);
    this.promptText = new TextSlot(promptText);
    this.promptFlags = new Flags(this.prompt);
    this.toastBox = h('div', 'ui-toasts', { 'aria-live': 'polite' });
    this.bannerSlot = h('div', 'ui-hud__banner');
    this.hintSlot = h('div', 'ui-hud__hint');

    // --- bottom left: vitals
    this.hp = makeBar('hp', 'hud.health');
    const vest = makeGear('vest');
    const helmet = makeGear('helmet');
    this.gear = { vest: vest.ui, helmet: helmet.ui };
    const stanceSr = h('span', 'ui-sr');
    this.stanceEl = h(
      'div',
      'ui-stance',
      { role: 'status' },
      h('span', 'ui-stance__glyph', { 'aria-hidden': 'true' }),
      h('span', 'ui-stance__progress', { 'aria-hidden': 'true' }),
      stanceSr,
    );
    this.stanceFlags = new Flags(this.stanceEl);
    this.stanceProgress = new StyleVar(this.stanceEl, '--p');
    this.stanceSr = new TextSlot(stanceSr);
    // Island v2 (systems/grass.md): shown while the local player is hidden in tall grass (HudView.hiddenInGrass).
    const grassBadge = h('div', 'ui-grass', { role: 'status' }, t('hud.grass.hidden'));
    const gearRow = h('div', 'ui-gearrow', null, vest.el, helmet.el, this.stanceEl, grassBadge);
    const vitals = h('div', 'ui-hud__bl ui-panel ui-panel--hud', null, this.hp.root, gearRow);

    // --- bottom centre: slots (M2a: 1-2 guns, 3 fists, 4 grenades)
    this.slots = [];
    const slotEls: HTMLElement[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const ic = icon(null, 'ui-slot__icon');
      const name = h('span', 'ui-slot__name');
      const mag = h('span', 'ui-slot__mag ui-num');
      const badge = levelBadge('ui-slot__badge');
      // M2c sight chip: a real button so touch (tap) and the paused mouse (click) can do what T does.
      const sightText = h('span', 'ui-sightchip__text');
      const sight = h('button', 'ui-sightchip ui-slot__sight', { type: 'button', tabindex: '-1' }, sightText) as HTMLButtonElement;
      // Touch: a long press shows the tooltip instead of switching (UI M2c §16.4).
      let pressTimer: ReturnType<typeof setTimeout> | null = null;
      let longPressed = false;
      sight.addEventListener('pointerdown', (ev) => {
        if (ev.pointerType !== 'touch') return;
        longPressed = false;
        pressTimer = setTimeout(() => {
          longPressed = true;
          sight.classList.add('is-tip');
          setTimeout(() => sight.classList.remove('is-tip'), 2000);
        }, 450);
      });
      const cancelPress = (): void => {
        if (pressTimer !== null) clearTimeout(pressTimer);
        pressTimer = null;
      };
      sight.addEventListener('pointerup', cancelPress);
      sight.addEventListener('pointercancel', cancelPress);
      sight.addEventListener('pointerleave', cancelPress);
      sight.addEventListener('contextmenu', (ev) => ev.preventDefault());
      sight.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (longPressed) {
          longPressed = false;
          return;
        }
        this.onCycleScope?.();
      });
      // M2c throwable slot: the other type as a mini chip, and the "[4] Swap" hint while active.
      const miniIcon = icon(null, 'ui-slot__miniicon');
      const miniCount = h('span', 'ui-num');
      const mini = h('span', 'ui-slot__mini', { 'aria-hidden': 'true' }, miniIcon, miniCount);
      const cycle = h('span', 'ui-slot__cycle', { 'aria-hidden': 'true' }, t('hud.throwable.swap'));
      const sr = h('span', 'ui-sr');
      const el = h(
        'div',
        'ui-slot',
        null,
        h('span', 'ui-slot__key ui-keycap', { 'aria-hidden': 'true' }, String(i + 1)),
        h('span', 'ui-slot__iconbox', null, ic, badge),
        name,
        mag,
        sight,
        mini,
        cycle,
        sr,
      );
      slotEls.push(el);
      this.slots.push({
        el,
        flags: new Flags(el),
        icon: ic,
        name: new TextSlot(name),
        mag: new TextSlot(mag),
        badge,
        sight,
        sightFlags: new Flags(sight),
        sightText: new TextSlot(sightText),
        sightShown: new Shown(sight),
        mini,
        miniIcon,
        miniCount: new TextSlot(miniCount),
        miniShown: new Shown(mini),
        cycle: new Shown(cycle),
        sr: new TextSlot(sr),
        lastKey: '',
        lastSight: '',
      });
    }
    // M2c spare-scope pouch: a lens glyph, then one chip per spare (hidden when empty).
    const pouchCount = h('span', 'ui-pouch__count ui-num');
    const pouchEl = h(
      'div',
      'ui-pouch',
      { role: 'group', 'aria-label': t('hud.scope.stash') },
      h('span', 'ui-glyph ui-pouch__glyph', { 'aria-hidden': 'true' }),
      pouchCount,
    );
    for (let i = 0; i < MAX_POUCH; i++) {
      const chipIcon = icon(null, 'ui-pouch__icon');
      const chip = h('span', 'ui-pouch__chip', null, chipIcon);
      pouchEl.appendChild(chip);
      this.pouchChips.push({ el: chip, icon: chipIcon, flags: new Flags(chip), shown: new Shown(chip) });
    }
    this.pouchShown = new Shown(pouchEl);
    this.pouchFlags = new Flags(pouchEl);
    this.pouchCount = new TextSlot(pouchCount);
    const live = h('span', 'ui-sr', { 'aria-live': 'polite' });
    this.liveText = new TextSlot(live);
    // M2b (UI.md §13.2): the viewmodel owns the lower right quadrant's middle, so the slots sit as a compact row in the
    // bottom-right column, directly above the ammo panel (name only on the active slot).
    const slotsBox = h('div', 'ui-hud__slots', null, pouchEl, ...slotEls, live);

    // --- bottom right: ammo + heals
    const ammoEl = h('span', 'ui-ammo__count ui-num');
    const ammoNote = h('span', 'ui-ammo__note');
    const reloadFill = h('div', 'ui-ammo__reload');
    const ammoBox = h('div', 'ui-ammo', null, ammoEl, ammoNote, reloadFill);
    this.ammo = new TextSlot(ammoEl);
    this.ammoNote = new TextSlot(ammoNote);
    this.ammoFlags = new Flags(ammoBox);
    this.reloadBar = new StyleVar(reloadFill, '--r');
    const healChip = (id: HealId): { el: HTMLElement; count: TextSlot; flags: Flags } => {
      const count = h('span', 'ui-heal__count ui-num');
      const el = h('div', 'ui-heal', null, icon(id), h('span', 'ui-heal__name', null, t(`item.${id}.type`)), count);
      return { el, count: new TextSlot(count), flags: new Flags(el) };
    };
    const bandage = healChip('bandage');
    const medkit = healChip('medkit');
    this.heals = { bandage, medkit };
    const healsBox = h(
      'div',
      'ui-heals',
      null,
      h('span', 'ui-keycap', null, t('menu.controls.heal.key')),
      bandage.el,
      medkit.el,
    );
    const brPanel = h('div', 'ui-panel ui-panel--hud ui-hud__ammo', null, ammoBox, healsBox);
    const br = h('div', 'ui-hud__br', null, slotsBox, brPanel);

    // --- spectate bar
    const specName = h('span', 'ui-spectate__name');
    const specFill = h('div', 'ui-bar__fill');
    const specHpText = h('span', 'ui-bar__value ui-num');
    const specEl = h(
      'div',
      'ui-spectate ui-panel',
      { role: 'status' },
      h('span', 'ui-glyph ui-glyph--eye', { 'aria-hidden': 'true' }),
      specName,
      h('div', 'ui-bar ui-bar--hp ui-bar--compact', null, h('div', 'ui-bar__track', null, specFill), specHpText),
      h('span', 'ui-spectate__next', null, t('hud.spectate.next')),
    );
    // M2b: [V] first person / chase cam chip (eye glyph = FP, camera glyph = chase: shape, not colour).
    const specViewText = h('span', null);
    const specView = h(
      'span',
      'ui-spectate__view',
      null,
      h('kbd', 'ui-keycap', null, t('menu.controls.spectateView.key')),
      h('span', 'ui-glyph ui-spectate__viewglyph', { 'aria-hidden': 'true' }),
      specViewText,
    );
    specEl.insertBefore(specView, specEl.lastChild);
    this.spectateWeaponIcon = icon(null, 'ui-spectate__weaponicon');
    this.spectateWeaponBadge = levelBadge('ui-spectate__badge');
    const specWeapon = h('span', 'ui-spectate__weapon', { 'aria-hidden': 'true' }, this.spectateWeaponIcon, this.spectateWeaponBadge);
    specEl.insertBefore(specWeapon, specView);
    this.spectateWeapon = new Shown(specWeapon);
    this.spectateView = new Shown(specView);
    this.spectateViewFlags = new Flags(specView);
    this.spectateViewText = new TextSlot(specViewText);
    this.spectate = new Shown(specEl);
    this.spectateFlags = new Flags(specEl);
    this.spectateName = new TextSlot(specName);
    this.spectateHp = new StyleVar(specFill, '--r');
    this.spectateHpText = new TextSlot(specHpText);

    // --- vignettes (full-screen, behind everything else in the HUD)
    this.vignetteHit = h('div', 'ui-vignette ui-vignette--hit', { 'aria-hidden': 'true' });
    const vTide = h('div', 'ui-vignette ui-vignette--tide', { 'aria-hidden': 'true' });
    this.vignetteTide = new Shown(vTide);

    const centre = h(
      'div',
      'ui-hud__centre',
      null,
      arcBox,
      dangerBox,
      this.crosshair,
      this.sight.el,
      this.hitmarker,
      this.ring,
      meleeEl,
      this.cook,
      adsBlockedEl,
      sightNowEl,
    );
    this.drop = new DropHud();

    this.el = h(
      'div',
      'ui-hud',
      null,
      this.vignetteHit,
      vTide,
      centre,
      this.feedSlot,
      topRight,
      this.bannerSlot,
      outside,
      this.prompt,
      this.drop.el,
      this.hintSlot,
      this.toastBox,
      vitals,
      br,
      specEl,
    );
    this.rootFlags = new Flags(this.el);
    this.promptShown.set(false);
    this.ringShown.set(false);
    this.cookShown.set(false);
    this.outside.set(false);
    this.vignetteTide.set(false);
    this.spectate.set(false);
    this.adsBlocked.set(false);
    this.meleeRing.set(false);
    this.sightNow.set(false);
    this.pouchShown.set(false);
  }

  // ------------------------------------------------------------------------------------------
  // Event inputs (called from Ui bus handlers)
  // ------------------------------------------------------------------------------------------
  /** Queued; resolved in update() against the current local pos/yaw. */
  localDamaged(e: DamagePayload): void {
    if (this.pendingDamage.length < 8) this.pendingDamage.push(e);
  }

  /**
   * M2a variants: vest (dashed ring), helmet (cap arc), break (shards); see logic.hitVariant. M2c: the caller drops
   * obscured non-kill hits (logic.hitMarkerVisible) before calling.
   */
  hitConfirmed(v: HitVariant): void {
    const f = this.hitmarker.classList;
    f.toggle('is-head', v.head);
    f.toggle('is-kill', v.kill);
    f.toggle('is-vest', v.vest);
    f.toggle('is-helmet', v.helmet);
    f.toggle('is-break', v.broke);
    retrigger(this.hitmarker, 'is-on');
  }

  /**
   * M2a: interactPromptChanged durability / refusal (null when the producer does not send them). M2a addendum:
   * `maxDurability` from the event ("31/55" for any armor); without it the Ui falls back to maxima learned from worn pieces.
   */
  setPrompt(
    item: M2cItemId | null,
    qty: number,
    durability: number | null = null,
    refusal: M2cActionFailReason | null = null,
    maxDurability: number | null = null,
    m2c: Pick<PromptInput, 'level' | 'scope' | 'replacesSlot' | 'scopeTarget'> = {},
  ): void {
    this.promptInput = item === null ? null : { item, qty, refusal, ...m2c };
    this.promptDurability = durability;
    this.promptMaxDurability = maxDurability;
  }

  /** The item the pickup prompt points at (chooses the vest/helmet/grenade refusal strings). */
  get currentPromptItem(): M2cItemId | null {
    return this.promptInput?.item ?? null;
  }

  /** M2c: a 4 / G cycle (throwableCycled, predicted): pulse the slot and announce "Smoke ready" to screen readers. */
  throwableCycled(to: M2cThrowableId): void {
    const ui = this.slots[3];
    if (ui) retrigger(ui.el, 'is-cycled');
    this.liveText.set(t('hud.throwable.selected', { item: t(`item.${to}.type`) }));
  }

  /** M2a: the local player's vest or helmet broke: crossed-out icon for a moment plus a warning toast. */
  armorBroken(slot: ArmorSlot, tier: M2cArmorTier, nowMs: number): void {
    const g = this.gear[slot];
    g.brokenTier = tier;
    g.brokenUntil = nowMs + BROKEN_SHOW_MS;
    retrigger(g.el, 'is-breaking');
    this.alertToast(slot === 'vest' ? 'hud.vest.broken' : 'hud.helmet.broken', `${slot}_${tier}` as IconId, nowMs);
  }

  /** Warning toast with an item icon (armor broken). Same replace-not-stack rule as refusals. */
  alertToast(key: string, iconId: IconId | null, nowMs: number): void {
    const i = this.toasts.findIndex((x) => x.failKey === key);
    if (i >= 0) this.toasts.splice(i, 1)[0]?.el.remove();
    const el = h(
      'div',
      'ui-toast ui-toast--fail ui-toast--alert ui-chip',
      { role: 'status' },
      h('span', 'ui-glyph ui-glyph--warn', { 'aria-hidden': 'true' }),
      iconId ? icon(iconId) : null,
      h('span', null, null, t(key)),
    );
    this.pushToast({ el, until: nowMs + TOAST_MS, failKey: key });
  }

  /** M2c: an info toast with an icon and a ready-made line ("Sea Glass 2x Scope on Longshore Rifle"). */
  infoToast(text: string, iconId: IconId | null, nowMs: number): void {
    const el = h('div', 'ui-toast ui-chip', null, iconId ? icon(iconId) : null, h('span', null, null, text));
    this.pushToast({ el, until: nowMs + TOAST_MS, failKey: null });
  }

  pickupToast(item: M2cItemId, qty: number, nowMs: number, level: ItemLevel | null = null): void {
    const badge = levelBadge('ui-toast__badge');
    setLevelBadge(badge, level);
    const el = h(
      'div',
      'ui-toast ui-chip',
      null,
      icon(item),
      h('span', null, null, t(`item.${item}.name`)),
      level !== null ? badge : null,
      qty > 1 ? h('span', 'ui-toast__qty ui-num', null, String(qty)) : null,
    );
    this.pushToast({ el, until: nowMs + TOAST_MS, failKey: null });
  }

  /** Short refusal toast for a GameEvent actionFailed (warn glyph + dashed border, not colour alone). */
  failToast(key: string, nowMs: number): void {
    // A repeated press replaces its own toast (fresh timer and entry animation) instead of stacking copies.
    const i = this.toasts.findIndex((x) => x.failKey === key);
    if (i >= 0) this.toasts.splice(i, 1)[0]?.el.remove();
    const el = h(
      'div',
      'ui-toast ui-toast--fail ui-chip',
      { role: 'status' },
      h('span', 'ui-glyph ui-glyph--warn', { 'aria-hidden': 'true' }),
      h('span', null, null, t(key)),
    );
    this.pushToast({ el, until: nowMs + FAIL_TOAST_MS, failKey: key });
    if (
      key === 'hud.inventory.full' ||
      key === 'hud.grenade.full' ||
      key === 'hud.smoke.full' ||
      key === 'hud.scope.pouchFull' ||
      key === 'hud.armor.better' ||
      key === 'hud.vest.better' ||
      key === 'hud.helmet.better'
    ) {
      retrigger(this.prompt, 'is-shake');
    }
  }

  private pushToast(toast: Toast): void {
    this.toastBox.appendChild(toast.el);
    this.toasts.push(toast);
    while (this.toasts.length > MAX_TOASTS) this.toasts.shift()?.el.remove();
  }

  resetMatch(): void {
    this.pendingDamage.length = 0;
    for (const a of this.arcs) {
      a.until = 0;
      a.shown.set(false);
    }
    for (const toast of this.toasts) toast.el.remove();
    this.toasts.length = 0;
    this.promptInput = null;
    this.promptDurability = null;
    this.promptMaxDurability = null;
    this.sightNowUntil = 0;
    for (const ui of this.slots) {
      ui.lastKey = '';
      ui.lastSight = '';
    }
    this.hp.last = -1;
    for (const g of Object.values(this.gear)) {
      g.brokenTier = 0;
      g.brokenUntil = 0;
      g.last = -1;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------------------------------
  update(hud: HudView, nowMs: number, viewportW: number, viewportH: number): void {
    const local = hud.local;
    const alive = local !== null && local.alive;
    const drop = alive ? (hud.drop ?? null) : null;
    if (hud.zoneTheme) this.zoneTheme = hud.zoneTheme;
    this.rootFlags.set('is-alive', alive);
    this.rootFlags.set('is-aboard', drop?.stage === 'aboard');
    this.rootFlags.set('is-dropping', alive && (local.dropping || (drop !== null && drop.stage !== 'aboard')));
    this.rootFlags.set('is-fp', hud.cameraView === 'firstPerson');
    // M2c: thicker crosshair outline inside smoke (UI M2c §6.1); the paused mouse can reach the sight chips (§16.4).
    this.rootFlags.set('is-in-smoke', alive && hud.inSmoke === true);
    this.rootFlags.set('is-hidden-in-grass', alive && hud.hiddenInGrass === true);
    this.rootFlags.set('is-free', !hud.pointerLocked);

    // Top right
    this.alive.set(t('hud.alive', { count: hud.aliveCount }));
    this.killsShown.set(local !== null);
    if (local) this.kills.set(t('hud.kills', { count: local.kills }));
    this.updateTide(hud);
    this.minimap.update(hud.minimap, hud.zone, nowMs, { theme: this.zoneTheme, preFlight: hud.phase !== 'playing' });
    this.drop.update(drop, this.dropHintActive);

    if (local) {
      this.updateLocal(hud, local, nowMs, viewportW, viewportH);
    } else {
      this.reticle = adsReticle(null);
      this.rootFlags.set('is-scoped', false);
      this.sight.update({ ...this.reticle, dot: null });
      this.ringShown.set(false);
      this.cookShown.set(false);
      this.meleeRing.set(false);
      this.sightNow.set(false);
      for (const d of this.dangers) d.shown.set(false);
      this.promptShown.set(false);
      this.outside.set(false);
      this.vignetteTide.set(false);
      this.adsBlocked.set(false);
    }

    // Spectate bar
    const spec = !alive && hud.spectate !== null ? hud.spectate : null;
    this.spectate.set(spec !== null);
    if (spec) {
      this.spectateName.set(t('hud.spectating', { name: spec.targetName }));
      this.spectateHpText.set(String(Math.max(0, Math.ceil(spec.targetHp))));
      // targetMaxHp is optional in the contract: without it the bar hides and only the number shows.
      const max = spec.targetMaxHp ?? 0;
      this.spectateFlags.set('is-hp-unknown', !(max > 0));
      if (max > 0) this.spectateHp.set(ratio(spec.targetHp, max).toFixed(3));
      // M2c (P2): the target's held weapon + level (only when ClientGame sends it).
      const sw = (spec.weapon ?? null) as M2cHeldId | null;
      this.spectateWeapon.set(sw !== null);
      if (sw !== null) {
        setIcon(this.spectateWeaponIcon, sw);
        setLevelBadge(this.spectateWeaponBadge, spec.weaponLevel ?? null);
      }
      // M2b: the [V] view chip (only once ClientGame reports the view).
      this.spectateView.set(spec.view !== undefined);
      if (spec.view) {
        this.spectateViewFlags.set('is-chase', spec.view === 'chase');
        this.spectateViewText.set(t(spec.view === 'chase' ? 'hud.spectate.chase' : 'hud.spectate.firstPerson'));
      }
    }
    // Spectating has no local player: the FP spectate dot (or nothing) is decided here.
    if (!alive) this.updateReticleMode(hud, null, spec !== null);

    // Toasts expire (they have different lifetimes, so check every one, not just the oldest).
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const toast = this.toasts[i];
      if (toast && toast.until <= nowMs) {
        toast.el.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  private updateTide(hud: HudView): void {
    const status = tideStatus(hud.zone, this.zoneTheme);
    this.tideShown.set(status !== null);
    this.tideGlyph.set(this.zoneTheme);
    if (!status) return;
    const phase = tidePhaseNumbers(hud.zone);
    this.tidePhase.set(phase ? t(zoneKey('hud', this.zoneTheme, 'phase'), phase) : '');
    this.tideText.set(t(status.key, status.vars));
    this.tideClock.set(status.clock);
    this.tideFlags.set('is-urgent', status.urgent);
    this.tideFlags.set('is-final', hud.zone?.isFinal === true);
  }

  private updateLocal(hud: HudView, local: HudLocalView, nowMs: number, viewportW: number, viewportH: number): void {
    updateBar(this.hp, local.hp, local.maxHp, local.alive && isLowHp(local.hp, lowHpThresholdOf(local.lowHpThreshold)));
    this.updateGear(this.gear.vest, local.vest ?? null, nowMs);
    this.updateGear(this.gear.helmet, local.helmet ?? null, nowMs);
    this.updateStance(local);

    // Slots (M2a: four; M2c: index 2 = fists or the melee weapon, index 3 = the selected throwable + the other type)
    const held = local.weapon as M2cHeldId;
    const throwHeld = held === 'grenade' || held === 'smoke';
    const throwable = throwableSlotModel(local);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const s = local.slots[i as SlotIndex] as HudSlotView | undefined;
      const ui = this.slots[i];
      if (!ui) continue;
      const isThrow = i === 3;
      const weapon: M2cHeldId | null = isThrow ? throwable.main : ((s?.weapon as M2cHeldId | null | undefined) ?? null);
      const level = isThrow ? null : (s?.level ?? null);
      const active = local.activeSlot === i;
      ui.flags.set('is-active', active);
      ui.flags.set('is-grenade', isThrow);
      ui.flags.set('is-empty', weapon === null || (isThrow && throwable.empty));
      setIcon(ui.icon, weapon);
      setLevelBadge(ui.badge, weapon === null || weapon === 'fists' ? null : level);
      const nameText = weapon ? t(`item.${weapon}.type`) : t('hud.slot.empty');
      ui.name.set(isThrow && weapon ? t(`item.${weapon}.name`) : nameText);
      ui.mag.set(isThrow ? t('hud.grenade.count', { count: throwable.mainCount }) : s && s.mag !== null ? String(s.mag) : '');
      // Throwable: the other type as a mini chip; the cycle hint only while active with both types.
      ui.miniShown.set(isThrow && throwable.other !== null);
      if (isThrow && throwable.other !== null) {
        setIcon(ui.miniIcon, throwable.other);
        ui.miniCount.set(String(throwable.otherCount));
      }
      ui.cycle.set(isThrow && throwable.cycleHint);
      // Gun slots: the sight chip (mounted = filled, built-in optic = outline; none for iron sights).
      const chip = isThrow || i === 2 ? null : sightChipModel(s);
      const showChip = chip !== null && chip.kind !== 'none';
      ui.sightShown.set(showChip);
      if (chip && showChip) {
        ui.sightFlags.set('is-builtin', chip.kind === 'builtIn');
        ui.sightFlags.set('is-reddot', chip.label === null);
        ui.sightText.set(chip.label ?? '');
        ui.sight.dataset['sight'] = chip.sight;
        const scopeName = s?.scope ? t(`item.${s.scope}.name`) : t(`sight.${chip.sight}`);
        const tip = chip.kind === 'builtIn' ? `${scopeName} · ${t('hud.scope.builtIn')}` : `${scopeName} · ${t('hud.scope.cycle')}`;
        if (ui.sight.title !== tip) {
          ui.sight.title = tip;
          ui.sight.setAttribute('aria-label', tip);
          ui.sight.dataset['tip'] = tip;
        }
      }
      // Pop the chip and show "Sight: …" when the same gun's sight changes (T switch or auto-mount; predicted).
      const key = `${weapon ?? ''}`;
      const sightNow = chip?.sight ?? 'none';
      if (ui.lastKey === key && ui.lastSight !== '' && ui.lastSight !== sightNow && weapon !== null && !isThrow) {
        retrigger(ui.sight, 'is-pop');
        if (active && sightNow !== 'none') {
          this.sightNowText.set(t('hud.scope.now', { sight: t(`sight.${sightNow}`) }));
          this.sightNowUntil = nowMs + SIGHT_NOW_MS;
        }
      }
      ui.lastKey = key;
      ui.lastSight = sightNow;
      // Screen readers: "Slot 1: Longshore Rifle, Lv.3 Hot" / "Slot 4: Smoke, 1 left".
      if (isThrow && weapon) {
        ui.sr.set(t('hud.throwable.sr', { key: i + 1, item: t(`item.${weapon}.name`), count: throwable.mainCount }));
      } else if (weapon) {
        const scope = s?.scope ? `, ${t('hud.scope.sr', { scope: t(`item.${s.scope}.name`) })}` : '';
        ui.sr.set(level !== null ? `${t('hud.slot.sr', { key: i + 1, item: t(`item.${weapon}.name`), level: levelLabel(level) })}${scope}` : t(`item.${weapon}.name`));
      } else ui.sr.set(t('hud.slot.empty'));
    }
    this.sightNow.set(local.alive && nowMs < this.sightNowUntil);
    this.updatePouch(local);

    // Ammo (throwables show their carried count instead of "∞"; melee shows "∞" like fists)
    if (throwHeld) {
      this.ammo.set(t('hud.grenade.count', { count: throwable.mainCount }));
      this.ammoNote.set('');
      this.ammoFlags.set('is-low', false);
      this.ammoFlags.set('is-out', false);
    } else if (local.mag === null) {
      this.ammo.set(t('hud.ammo.infinite'));
      this.ammoNote.set('');
      this.ammoFlags.set('is-low', false);
      this.ammoFlags.set('is-out', false);
    } else {
      const reserve = local.reserve ?? 0;
      this.ammo.set(t('hud.ammo', { mag: local.mag, reserve }));
      const out = local.mag === 0 && reserve === 0;
      // M2c: the RPG says "No rockets".
      this.ammoNote.set(out ? t(held === 'rpg' ? 'hud.rocket.none' : 'hud.ammo.empty') : '');
      this.ammoFlags.set('is-out', out);
      this.ammoFlags.set('is-low', !out && local.magSize !== null && local.mag <= Math.ceil(local.magSize * LOW_MAG));
    }
    // M2c: the RPG's hip dot is hollow while the tube is empty (UI M2c §5).
    this.crosshairFlags.set('is-unloaded', held === 'rpg' && local.mag === 0);
    const reloading = local.reloadProgress !== null;
    this.ammoFlags.set('is-reloading', reloading);
    this.reloadBar.set(reloading ? (local.reloadProgress ?? 0).toFixed(2) : '0');

    for (const id of ['bandage', 'medkit'] as const) {
      const n = local.heals[id] ?? 0;
      this.heals[id].count.set(String(n));
      this.heals[id].flags.set('is-none', n <= 0);
      this.heals[id].flags.set('is-using', local.healItem === id && local.healProgress !== null);
    }

    // Crosshair (hidden while aboard, dropping or dead). M2a: ADS closes it into the sight dot; scoped hides it.
    // M2b first person: the camera is the hitscan origin, so the reticle sits exactly at the screen centre and its gap is
    // the sim cone at the rendered vertical FOV; in ADS it only fades (the viewmodel's own sight is the aim).
    const airborne = local.dropping || hud.drop != null;
    const live = local.alive && !airborne;
    const fp = hud.cameraView === 'firstPerson';
    this.reticle = adsReticle(live ? (hud.ads ?? null) : null, fp);
    this.updateReticleMode(hud, local, false);
    if (this.reticle.hip > 0 && live) {
      // Without the camera FOV (older producer) the crosshair stays at its resting gap rather than guessing.
      const fov = hud.cameraFovDeg;
      const px = fov !== undefined ? Math.min(140, spreadToPx(hud.crosshairSpreadDeg, fov, viewportH)) : 0;
      this.spread.set(`${Math.round(px * this.reticle.gapScale * 2) / 2}px`);
      this.hipOpacity.set(this.reticle.hip.toFixed(2));
    }
    this.sight.update(live ? this.reticle : { ...this.reticle, dot: null });
    this.rootFlags.set('is-scoped', this.reticle.scope !== null);

    // M2a addendum: "Can't aim while reloading / healing" while RMB is held but blocked.
    const blocked = live && !this.reticle.scope ? (hud.adsBlocked ?? null) : null;
    this.adsBlocked.set(blocked !== null);
    if (blocked) this.adsBlockedText.set(t(`hud.ads.${blocked}`));

    // Progress ring: reload, heal or (M2c) a timed sight switch
    const scopeSwap = local.scopeSwapProgress ?? null;
    const p = local.healProgress ?? local.reloadProgress ?? scopeSwap;
    this.ringShown.set(local.alive && p !== null);
    if (p !== null) {
      this.ringOffset.set((RING_C * (1 - Math.min(1, Math.max(0, p)))).toFixed(1));
      const healing = local.healProgress !== null;
      const mounting = !healing && local.reloadProgress === null;
      this.ringLabel.set(healing ? t('hud.healing') : mounting ? t('hud.scope.mounting') : t('hud.reloading'));
      this.ringHint.set(healing ? t('hud.heal.cancel') : '');
    }

    // M2c: melee swing recovery (predicted)
    const rec = live && (held === 'fists' || isMeleeId(held)) ? (local.meleeRecovery ?? null) : null;
    this.meleeRing.set(rec !== null);
    if (rec !== null) this.meleeOffset.set((MELEE_C * Math.min(1, Math.max(0, rec))).toFixed(1));

    // Cook ring (M2a; M2c smoke: cream, never urgent)
    this.updateCook(local, live && throwHeld, held === 'smoke' ? 'smoke' : 'grenade', throwable.mainCount);

    // Danger icons (M2a)
    this.updateDangers(hud, local.alive, viewportW, viewportH);

    // Damage direction arcs
    for (const e of this.pendingDamage) this.spawnArc(e, nowMs, local.maxHp);
    this.pendingDamage.length = 0;
    for (const a of this.arcs) {
      if (a.until <= nowMs) {
        a.shown.set(false);
        continue;
      }
      const deg = relativeBearingDeg(local.pos, local.yaw, a.source);
      if (deg !== null) a.angle.set(`${Math.round(deg)}deg`);
    }

    // Outside zone (M2b: the line follows the map's zone fiction)
    const outside = local.alive && local.outsideZone;
    this.outside.set(outside);
    this.vignetteTide.set(outside);
    if (outside) this.outsideText.set(t(zoneKey('hud', this.zoneTheme, 'outside')));
    if (outside && hud.zone) {
      const deg = relativeBearingDeg(local.pos, local.yaw, hud.zone.center);
      this.outsideArrow.set(`${Math.round(deg ?? 0)}deg`);
    }

    // Prompt: loot in range, or the drop steering reminder
    this.updatePrompt(local, hud.drop != null, hud.inSmoke === true ? null : (hud.lootPeek ?? null));
  }

  /** M2b: full reticle, dot only (fists / grenade), the dim FP spectate dot, or nothing (logic.reticleMode). */
  private updateReticleMode(hud: HudView, local: HudLocalView | null, spectating: boolean): void {
    const mode = reticleMode({
      cameraView: hud.cameraView,
      alive: local !== null && local.alive,
      airborne: local !== null && (local.dropping || hud.drop != null),
      weapon: local ? local.weapon : null,
      spectating,
    });
    const show = mode === 'spectate' || (mode !== 'none' && this.reticle.hip > 0);
    this.crosshairShown.set(show);
    // Before first person (cameraView absent) fists keep the full M1 crosshair, as before.
    this.crosshairFlags.set('is-dot', mode === 'dot' && hud.cameraView !== undefined);
    this.crosshairFlags.set('is-spectate', mode === 'spectate');
  }

  private updateGear(g: GearUi, piece: HudArmorView | null, nowMs: number): void {
    if (piece) {
      this.maxDurability.set(piece.id, piece.maxDurability);
      g.brokenTier = 0;
    }
    if (g.brokenTier > 0 && nowMs >= g.brokenUntil) g.brokenTier = 0;
    const v = gearView(piece, g.brokenTier);
    const dur = piece?.durability ?? 0;
    if (g.last >= 0 && piece && dur < g.last) retrigger(g.el, 'is-hit');
    g.last = piece ? dur : -1;
    g.flags.set('is-none', v.state === 'none');
    g.flags.set('is-broken', v.state === 'broken');
    g.flags.set('is-low', v.low);
    // Empty slot: a dim tier-1 outline of that piece (shape tells vest from helmet).
    setIcon(g.icon, `${g.slot}_${v.tier === 0 ? 1 : v.tier}` as IconId);
    g.pips.set(String(v.tier));
    g.fill.set(v.ratio.toFixed(2));
    const label = t(g.slot === 'vest' ? 'hud.vest' : 'hud.helmet');
    g.text.set(v.state === 'none' ? label : v.text);
    g.sr.set(v.state === 'none' ? `${label}: ${t('gear.tier.0')}` : `${label} ${t(`gear.tier.${v.tier}`)}: ${v.text}`);
  }

  private updateStance(local: HudLocalView): void {
    const v = stanceView(local.stance ?? 'stand', local.stanceFrom ?? local.stance ?? 'stand', local.stanceProgress ?? 1);
    if (this.stanceEl.dataset['stance'] !== v.stance) {
      this.stanceEl.dataset['stance'] = v.stance;
      this.stanceEl.title = t(v.labelKey);
      if (v.moving) retrigger(this.stanceEl, 'is-changed');
    }
    this.stanceFlags.set('is-moving', v.moving);
    this.stanceFlags.set('is-low', v.stance !== 'stand');
    this.stanceProgress.set(v.progress.toFixed(2));
    this.stanceSr.set(t(v.labelKey));
  }

  private updateCook(local: HudLocalView, holding: boolean, kind: M2cThrowableId, count: number): void {
    const cook = local.cook ?? null;
    const smoke = (cook?.throwable ?? kind) === 'smoke';
    const c = holding ? cookView(cook) : null;
    const ready = holding && c === null && count > 0;
    this.cookShown.set(c !== null || ready);
    this.cookFlags.set('is-cooking', c !== null);
    this.cookFlags.set('is-smoke', smoke);
    // Smoke cannot hurt you: no red, no pulse.
    this.cookFlags.set('is-urgent', c?.urgent === true && !smoke);
    if (c) {
      this.cookOffset.set((COOK_C * (1 - c.ratio)).toFixed(1));
      this.cookSecs.set(decimal1.format(c.seconds));
      this.cookLabel.set(t('hud.grenade.throw'));
    } else if (ready) {
      this.cookSecs.set('');
      this.cookLabel.set(t(smoke ? 'hud.smoke.throw' : 'hud.grenade.cook'));
    }
  }

  /** M2c spare-scope pouch: chips that fit the active gun are full; others faded and slashed (UI M2c §16.2). */
  private updatePouch(local: HudLocalView): void {
    const active = local.activeSlot <= 1 ? (local.slots[local.activeSlot] as HudSlotView | undefined) : undefined;
    const chips = pouchModel(local.scopeStash, active ?? null);
    this.pouchShown.set(local.alive && chips.length > 0);
    this.pouchCount.set(`×${chips.length}`);
    this.pouchFlags.set('is-single', chips.length <= 1);
    for (let i = 0; i < this.pouchChips.length; i++) {
      const ui = this.pouchChips[i];
      const c = chips[i];
      if (!ui) continue;
      ui.shown.set(c !== undefined);
      if (!c) continue;
      setIcon(ui.icon, c.scope);
      ui.flags.set('is-nofit', !c.fits);
      const tip = `${t(`item.${c.scope}.name`)} · ${t('hud.scope.inPouch')}`;
      if (ui.el.title !== tip) {
        ui.el.title = tip;
        ui.el.setAttribute('aria-label', tip);
      }
    }
  }

  private updateDangers(hud: HudView, alive: boolean, viewportW: number, viewportH: number): void {
    const list = alive ? (hud.grenadeDanger ?? []) : [];
    for (let i = 0; i < this.dangers.length; i++) {
      const ui = this.dangers[i];
      const d = list[i];
      if (!ui) continue;
      ui.shown.set(d !== undefined);
      if (!d) continue;
      const p = dangerPlacement(d.bearing, hud.cameraFovDeg, viewportW, viewportH, DANGER_MARGIN_PX);
      ui.pos.set(`${p.x}px ${p.y}px`);
      ui.arrow.set(`${p.arrowDeg}deg`);
      ui.scale.set(String(dangerScale(d.distance)));
      // M2a addendum (M6): faster blink as the fuse runs out; the last second also thickens the ring.
      const blink = dangerBlink(d.fuseRemainingMs);
      ui.blink.set(`${blink.periodMs}ms`);
      ui.flags.set('is-urgent', blink.urgent);
      ui.flags.set('is-edge', p.edge);
      ui.flags.set('is-nearest', i === 0);
    }
  }

  private spawnArc(e: DamagePayload, nowMs: number, maxHp: number): void {
    const arc = this.arcs[this.nextArc];
    this.nextArc = (this.nextArc + 1) % this.arcs.length;
    if (!arc) return;
    arc.source = e.sourcePos;
    arc.until = nowMs + DAMAGE_ARC_MS;
    arc.el.classList.toggle('is-zone', e.cause === 'zone');
    arc.el.classList.toggle('is-heavy', isHeavyHit(e.amount, maxHp));
    arc.shown.set(true);
    retrigger(arc.el, 'is-on');
    this.vignetteHit.style.setProperty('--strength', hitVignetteStrength(e.amount, maxHp).toFixed(2));
    retrigger(this.vignetteHit, 'is-on');
  }

  private updatePrompt(local: HudLocalView, dropView: boolean, peek: HudView['lootPeek'] = null): void {
    this.promptFlags.set('is-peek', false);
    if (dropView) {
      // M2b: the drop HUD shows its own prompts.
      this.promptShown.set(false);
      return;
    }
    if (local.alive && local.dropping) {
      this.promptShown.set(!this.dropHintActive);
      setIcon(this.promptIcon, null);
      this.promptText.set(t('hud.drop'));
      this.promptFlags.set('is-blocked', false);
      this.promptDetail.set(false);
      return;
    }
    const input = this.promptInput;
    // M2c (P2) loot peek: the item the crosshair is on, out of reach: dimmed, no key, no verb (UI M2c §3.1).
    if (!input && peek && local.alive) {
      this.promptShown.set(true);
      this.promptFlags.set('is-peek', true);
      this.promptFlags.set('is-blocked', false);
      setIcon(this.promptIcon, peek.item);
      this.promptText.set(peek.qty > 1 ? `${t(`item.${peek.item}.name`)} ×${peek.qty}` : t(`item.${peek.item}.name`));
      this.promptChip.set(false);
      this.promptLevel.set(peek.level !== null);
      setLevelBadge(this.promptBadge, peek.level);
      this.promptLevelText.set('');
      this.promptCompare.set(false);
      this.promptExtra.set(false);
      this.promptDetail.set(false);
      return;
    }
    this.promptShown.set(local.alive && input !== null);
    if (!input || !local.alive) return;
    const item = input.item;
    const m = pickupPromptModel(input, local);
    setIcon(this.promptIcon, item);
    this.promptText.set(t(m.key, m.vars));
    this.promptFlags.set('is-blocked', m.blocked);
    // M2c: the gun's mounted scope as a sight chip (UI M2c §16.3).
    const groundSight = m.groundScope ? scopeSight(m.groundScope) : null;
    this.promptChip.set(!m.blocked && groundSight !== null);
    if (groundSight) {
      this.promptChipFlags.set('is-reddot', groundSight === 'red_dot');
      if (this.promptChipEl.dataset['sight'] !== groundSight) this.promptChipEl.dataset['sight'] = groundSight;
      this.promptChipText.set(groundSight === 'red_dot' ? '' : groundSight.replace('scope_', '').replace('x', '×'));
    }
    // M2c: level badge + "Lv.3 Hot", and on a same-id swap the ▲ / ▼ / = tag with the old level's badge.
    const showLevel = !m.blocked && m.level !== null;
    this.promptLevel.set(showLevel);
    if (showLevel) {
      setLevelBadge(this.promptBadge, m.level);
      this.promptLevelText.set(levelLabel(m.level));
      this.promptCompare.set(m.compare !== null);
      if (m.compare) {
        this.promptCompareFlags.set('is-down', m.compare === 'down');
        this.promptCompareText.set(t(`hud.level.${m.compare}`));
        setLevelBadge(this.promptOldBadge, m.replaced?.level ?? null);
      }
    }
    // M2c extra line: the melee note, or a scope pickup's target ("→ Longshore Rifle" / "→ Pouch" / "Fits: …").
    const extra = m.blocked ? '' : this.promptExtraLine(m);
    this.promptExtra.set(extra !== '');
    this.promptExtraText.set(extra);
    // M2a: armor names its tier (pips + "Lv.2") and the piece's durability ("31/55").
    const detail = armorPromptDetail(item, this.promptDurability, this.promptMaxDurability ?? this.maxDurability.get(item) ?? null);
    this.promptDetail.set(detail !== null);
    if (detail) {
      this.promptPips.set(String(detail.tier));
      this.promptTier.set(t(detail.tierKey));
      this.promptDur.set(detail.durability ?? '');
    }
  }

  private promptExtraLine(m: ReturnType<typeof pickupPromptModel>): string {
    if (m.noteKey) return t(m.noteKey);
    const parts: string[] = [];
    if (m.scopeTarget === 'pouch') parts.push(t('hud.scope.toPouch'));
    else if (m.scopeTarget !== null && m.scopeTarget.weapon !== null) {
      parts.push(t('hud.scope.mountsOn', { weapon: t(`item.${m.scopeTarget.weapon}.name`) }));
    }
    if (m.fitsKey && this.promptInput) {
      const scope = this.promptInput.item as ScopeId;
      const names = fitNames(this.balance, scope);
      if (names !== '') parts.push(t('hud.scope.fits', { weapons: names }));
    }
    return parts.join(' · ');
  }

  dispose(): void {
    this.minimap.dispose();
    this.el.remove();
  }
}
