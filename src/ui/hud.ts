/**
 * In-match HUD: vitals, weapon slots, ammo + heals, crosshair + progress ring, hit marker, damage direction,
 * alive/kills, tide status, minimap, pickup prompt, pickup toasts, outside-zone warning, spectate bar.
 * Every per-frame write goes through a diffing helper (TextSlot / Flags / Shown / StyleVar).
 * Owner: ui-ux-designer.
 */
import { t } from '../content/strings';
import type { HudLocalView, HudView } from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import type { HealId, ItemId, SlotIndex, Vec3 } from '../shared/types';
import { Flags, h, Shown, StyleVar, svg, TextSlot, retrigger } from './dom';
import { icon, setIcon } from './icons';
import {
  hitVignetteStrength,
  isHeavyHit,
  isLowHp,
  lowHpThresholdOf,
  pickupPromptChoice,
  ratio,
  relativeBearingDeg,
  spreadToPx,
  tidePhaseNumbers,
  tideStatus,
} from './logic';
import { Minimap, type CoastlineFn } from './minimap';

const DAMAGE_ARC_MS = 1100;
const TOAST_MS = 2400;
/** Refusal toasts (actionFailed) are shorter: they answer a key press, they do not report news. */
const FAIL_TOAST_MS = 1600;
const MAX_TOASTS = 3;
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;
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
  flags: Flags;
  icon: HTMLSpanElement;
  name: TextSlot;
  mag: TextSlot;
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

function makeBar(kind: 'hp' | 'armor', labelKey: string): Bar {
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
  private readonly minimap: Minimap;

  // bottom
  private readonly hp: Bar;
  private readonly armor: Bar;
  private readonly slots: SlotUi[];
  private readonly ammo: TextSlot;
  private readonly ammoNote: TextSlot;
  private readonly ammoFlags: Flags;
  private readonly reloadBar: StyleVar;
  private readonly heals: Record<HealId, { count: TextSlot; flags: Flags }>;

  // centre
  private readonly crosshair: HTMLDivElement;
  private readonly crosshairShown: Shown;
  private readonly spread: StyleVar;
  private readonly ring: HTMLDivElement;
  private readonly ringShown: Shown;
  private readonly ringOffset: StyleVar;
  private readonly ringLabel: TextSlot;
  private readonly ringHint: TextSlot;
  private readonly hitmarker: HTMLDivElement;
  private readonly arcs: DamageArc[] = [];
  private nextArc = 0;
  private readonly pendingDamage: DamagePayload[] = [];
  private readonly vignetteHit: HTMLDivElement;
  private readonly vignetteTide: Shown;
  private readonly outside: Shown;
  private readonly outsideArrow: StyleVar;

  // prompt + toasts
  private readonly prompt: HTMLDivElement;
  private readonly promptShown: Shown;
  private readonly promptText: TextSlot;
  private readonly promptFlags: Flags;
  private readonly promptIcon: HTMLSpanElement;
  private promptItem: ItemId | null = null;
  private promptQty = 0;
  private readonly toastBox: HTMLDivElement;
  private readonly toasts: Toast[] = [];

  // spectate
  private readonly spectate: Shown;
  private readonly spectateFlags: Flags;
  private readonly spectateName: TextSlot;
  private readonly spectateHp: StyleVar;
  private readonly spectateHpText: TextSlot;

  /** Suppresses the persistent drop prompt while the one-time drop hint is up. */
  dropHintActive = false;

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
    this.tide = h(
      'div',
      'ui-chip ui-tide',
      { role: 'status' },
      h('span', 'ui-glyph ui-glyph--wave', { 'aria-hidden': 'true' }),
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

    // --- centre
    const lines = ['n', 'e', 's', 'w'].map((d) => h('span', `ui-crosshair__line ui-crosshair__line--${d}`));
    this.crosshair = h('div', 'ui-crosshair', { 'aria-hidden': 'true' }, ...lines, h('span', 'ui-crosshair__dot'));
    this.crosshairShown = new Shown(this.crosshair);
    this.spread = new StyleVar(this.crosshair, '--spread');

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

    this.hitmarker = h(
      'div',
      'ui-hitmarker',
      { 'aria-hidden': 'true' },
      ...['a', 'b', 'c', 'd'].map((d) => h('span', `ui-hitmarker__tick ui-hitmarker__tick--${d}`)),
      h('span', 'ui-hitmarker__crown'),
    );

    const arcBox = h('div', 'ui-dmgarcs', { 'aria-hidden': 'true' });
    for (let i = 0; i < 4; i++) {
      const el = h('div', 'ui-dmgarc', null, h('div', 'ui-dmgarc__shape'));
      el.hidden = true;
      arcBox.appendChild(el);
      this.arcs.push({ el, angle: new StyleVar(el, '--a'), source: { x: 0, y: 0, z: 0 }, until: 0, shown: new Shown(el) });
    }

    const outsideArrow = h('span', 'ui-outside__arrow', { 'aria-hidden': 'true' });
    const outside = h('div', 'ui-outside', { role: 'alert' }, outsideArrow, h('span', null, null, t('hud.tide.outside')));
    this.outside = new Shown(outside);
    this.outsideArrow = new StyleVar(outsideArrow, '--a');

    // --- prompt + toasts + message slots
    const promptText = h('span', 'ui-prompt__text');
    this.promptIcon = icon(null, 'ui-prompt__icon');
    this.prompt = h('div', 'ui-prompt ui-chip', { role: 'status' }, this.promptIcon, promptText);
    this.promptShown = new Shown(this.prompt);
    this.promptText = new TextSlot(promptText);
    this.promptFlags = new Flags(this.prompt);
    this.toastBox = h('div', 'ui-toasts', { 'aria-live': 'polite' });
    this.bannerSlot = h('div', 'ui-hud__banner');
    this.hintSlot = h('div', 'ui-hud__hint');

    // --- bottom left: vitals
    this.hp = makeBar('hp', 'hud.health');
    this.armor = makeBar('armor', 'hud.armor');
    const vitals = h('div', 'ui-hud__bl ui-panel ui-panel--hud', null, this.hp.root, this.armor.root);

    // --- bottom centre: slots
    this.slots = [];
    const slotEls: HTMLElement[] = [];
    for (let i = 0; i < 3; i++) {
      const ic = icon(null, 'ui-slot__icon');
      const name = h('span', 'ui-slot__name');
      const mag = h('span', 'ui-slot__mag ui-num');
      const el = h('div', 'ui-slot', null, h('span', 'ui-slot__key ui-keycap', null, String(i + 1)), ic, name, mag);
      slotEls.push(el);
      this.slots.push({ flags: new Flags(el), icon: ic, name: new TextSlot(name), mag: new TextSlot(mag) });
    }
    const slotsBox = h('div', 'ui-hud__bc', null, ...slotEls);

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
    const br = h('div', 'ui-hud__br ui-panel ui-panel--hud', null, ammoBox, healsBox);

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
    this.spectate = new Shown(specEl);
    this.spectateFlags = new Flags(specEl);
    this.spectateName = new TextSlot(specName);
    this.spectateHp = new StyleVar(specFill, '--r');
    this.spectateHpText = new TextSlot(specHpText);

    // --- vignettes (full-screen, behind everything else in the HUD)
    this.vignetteHit = h('div', 'ui-vignette ui-vignette--hit', { 'aria-hidden': 'true' });
    const vTide = h('div', 'ui-vignette ui-vignette--tide', { 'aria-hidden': 'true' });
    this.vignetteTide = new Shown(vTide);

    const centre = h('div', 'ui-hud__centre', null, arcBox, this.crosshair, this.hitmarker, this.ring);

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
      this.hintSlot,
      this.toastBox,
      vitals,
      slotsBox,
      br,
      specEl,
    );
    this.rootFlags = new Flags(this.el);
    this.promptShown.set(false);
    this.ringShown.set(false);
    this.outside.set(false);
    this.vignetteTide.set(false);
    this.spectate.set(false);
  }

  // ------------------------------------------------------------------------------------------
  // Event inputs (called from Ui bus handlers)
  // ------------------------------------------------------------------------------------------
  /** Queued; resolved in update() against the current local pos/yaw. */
  localDamaged(e: DamagePayload): void {
    if (this.pendingDamage.length < 8) this.pendingDamage.push(e);
  }

  hitConfirmed(headshot: boolean, killed: boolean, armorBroke: boolean): void {
    const f = this.hitmarker.classList;
    f.toggle('is-head', headshot && !killed);
    f.toggle('is-kill', killed);
    f.toggle('is-armor', armorBroke && !killed);
    retrigger(this.hitmarker, 'is-on');
  }

  setPrompt(item: ItemId | null, qty: number): void {
    this.promptItem = item;
    this.promptQty = qty;
  }

  pickupToast(item: ItemId, qty: number, nowMs: number): void {
    const el = h(
      'div',
      'ui-toast ui-chip',
      null,
      icon(item),
      h('span', null, null, t(`item.${item}.name`)),
      qty > 1 ? h('span', 'ui-toast__qty ui-num', null, String(qty)) : null,
    );
    this.toastBox.appendChild(el);
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
    if (key === 'hud.inventory.full' || key === 'hud.armor.better') retrigger(this.prompt, 'is-shake');
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
    this.promptItem = null;
    this.hp.last = -1;
    this.armor.last = -1;
  }

  // ------------------------------------------------------------------------------------------
  // Per frame
  // ------------------------------------------------------------------------------------------
  update(hud: HudView, nowMs: number, viewportH: number): void {
    const local = hud.local;
    const alive = local !== null && local.alive;
    this.rootFlags.set('is-alive', alive);
    this.rootFlags.set('is-dropping', alive && local.dropping);

    // Top right
    this.alive.set(t('hud.alive', { count: hud.aliveCount }));
    this.killsShown.set(local !== null);
    if (local) this.kills.set(t('hud.kills', { count: local.kills }));
    this.updateTide(hud);
    this.minimap.update(hud.minimap, hud.zone, nowMs);

    if (local) {
      this.updateLocal(hud, local, nowMs, viewportH);
    } else {
      this.crosshairShown.set(false);
      this.ringShown.set(false);
      this.promptShown.set(false);
      this.outside.set(false);
      this.vignetteTide.set(false);
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
    }

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
    const status = tideStatus(hud.zone);
    this.tideShown.set(status !== null);
    if (!status) return;
    const phase = tidePhaseNumbers(hud.zone);
    this.tidePhase.set(phase ? t('hud.tide.phase', phase) : '');
    this.tideText.set(t(status.key, status.vars));
    this.tideClock.set(status.clock);
    this.tideFlags.set('is-urgent', status.urgent);
    this.tideFlags.set('is-final', hud.zone?.isFinal === true);
  }

  private updateLocal(hud: HudView, local: HudLocalView, nowMs: number, viewportH: number): void {
    updateBar(this.hp, local.hp, local.maxHp, local.alive && isLowHp(local.hp, lowHpThresholdOf(local.lowHpThreshold)));
    updateBar(this.armor, local.armor, local.maxArmor, false);

    // Slots
    for (let i = 0; i < 3; i++) {
      const s = local.slots[i as SlotIndex];
      const ui = this.slots[i];
      if (!s || !ui) continue;
      ui.flags.set('is-active', local.activeSlot === s.slot);
      ui.flags.set('is-empty', s.weapon === null);
      setIcon(ui.icon, s.weapon);
      ui.name.set(s.weapon ? t(`item.${s.weapon}.type`) : t('hud.slot.empty'));
      ui.mag.set(s.mag !== null ? String(s.mag) : '');
    }

    // Ammo
    if (local.mag === null) {
      this.ammo.set(t('hud.ammo.infinite'));
      this.ammoNote.set('');
      this.ammoFlags.set('is-low', false);
      this.ammoFlags.set('is-out', false);
    } else {
      const reserve = local.reserve ?? 0;
      this.ammo.set(t('hud.ammo', { mag: local.mag, reserve }));
      const out = local.mag === 0 && reserve === 0;
      this.ammoNote.set(out ? t('hud.ammo.empty') : '');
      this.ammoFlags.set('is-out', out);
      this.ammoFlags.set('is-low', !out && local.magSize !== null && local.mag <= Math.ceil(local.magSize * LOW_MAG));
    }
    const reloading = local.reloadProgress !== null;
    this.ammoFlags.set('is-reloading', reloading);
    this.reloadBar.set(reloading ? (local.reloadProgress ?? 0).toFixed(2) : '0');

    for (const id of ['bandage', 'medkit'] as const) {
      const n = local.heals[id] ?? 0;
      this.heals[id].count.set(String(n));
      this.heals[id].flags.set('is-none', n <= 0);
      this.heals[id].flags.set('is-using', local.healItem === id && local.healProgress !== null);
    }

    // Crosshair (hidden while dropping or dead)
    const showCross = local.alive && !local.dropping;
    this.crosshairShown.set(showCross);
    if (showCross) {
      // Without the camera FOV (older producer) the crosshair stays at its resting gap rather than guessing.
      const fov = hud.cameraFovDeg;
      const px = fov !== undefined ? Math.min(140, spreadToPx(hud.crosshairSpreadDeg, fov, viewportH)) : 0;
      this.spread.set(`${Math.round(px * 2) / 2}px`);
    }

    // Progress ring: reload or heal
    const p = local.healProgress ?? local.reloadProgress;
    this.ringShown.set(local.alive && p !== null);
    if (p !== null) {
      this.ringOffset.set((RING_C * (1 - Math.min(1, Math.max(0, p)))).toFixed(1));
      const healing = local.healProgress !== null;
      this.ringLabel.set(healing ? t('hud.healing') : t('hud.reloading'));
      this.ringHint.set(healing ? t('hud.heal.cancel') : '');
    }

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

    // Outside zone
    const outside = local.alive && local.outsideZone;
    this.outside.set(outside);
    this.vignetteTide.set(outside);
    if (outside && hud.zone) {
      const deg = relativeBearingDeg(local.pos, local.yaw, hud.zone.center);
      this.outsideArrow.set(`${Math.round(deg ?? 0)}deg`);
    }

    // Prompt: loot in range, or the drop steering reminder
    this.updatePrompt(local);
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

  private updatePrompt(local: HudLocalView): void {
    if (local.alive && local.dropping) {
      this.promptShown.set(!this.dropHintActive);
      setIcon(this.promptIcon, null);
      this.promptText.set(t('hud.drop'));
      this.promptFlags.set('is-blocked', false);
      return;
    }
    const item = this.promptItem;
    this.promptShown.set(local.alive && item !== null);
    if (!item || !local.alive) return;
    const choice = pickupPromptChoice(item, this.promptQty, local);
    const name = t(`item.${item}.name`);
    setIcon(this.promptIcon, item);
    this.promptText.set(choice.usesCount ? t(choice.key, { count: this.promptQty, item: name }) : t(choice.key, { item: name }));
    this.promptFlags.set('is-blocked', choice.blocked);
  }

  dispose(): void {
    this.minimap.dispose();
    this.el.remove();
  }
}
