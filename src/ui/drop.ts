/**
 * M2b drop HUD (drop.md "What the UI must show", UI.md §13.3), driven by HudView.drop through logic.dropHudModel:
 * - Aboard: the jump prompt under the centre ("[Space/F] Jump", dimmed + dashed while the doors are shut), a top-centre
 *   timer chip (doors open in / auto-eject in; striped when urgent) and the "N still aboard" chip.
 * - Freefall / chute: the steer prompt, "[Space] Open chute" while a manual deploy is possible, and a vertical altitude
 *   bar on the right with the auto-deploy height marked.
 * Every write is diffed. Owner: ui-ux-designer.
 */
import { hasKey, t } from '../content/strings';
import type { HudDropView } from '../shared/contracts';
import { Flags, h, Shown, StyleVar, TextSlot } from './dom';
import { dropHudModel } from './logic';

export class DropHud {
  readonly el: HTMLDivElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  private readonly timerShown: Shown;
  private readonly timerFlags: Flags;
  private readonly timerText: TextSlot;
  private readonly aboardShown: Shown;
  private readonly aboardText: TextSlot;
  private readonly prompt: TextSlot;
  private readonly promptFlags: Flags;
  private readonly second: TextSlot;
  private readonly secondShown: Shown;
  private readonly altShown: Shown;
  private readonly altFill: StyleVar;
  private readonly altMark: StyleVar;
  private readonly altValue: TextSlot;
  private readonly altLabel: TextSlot;
  /** Highest altitude seen this drop (the bar's top). */
  private maxAltitude = 0;

  constructor() {
    const timerText = h('span', 'ui-num');
    const timer = h('div', 'ui-chip ui-drop__timer', { role: 'timer' }, h('span', 'ui-glyph ui-glyph--clock', { 'aria-hidden': 'true' }), timerText);
    const aboardText = h('span', null);
    const aboard = h('div', 'ui-chip ui-drop__aboard', null, h('span', 'ui-glyph ui-glyph--person', { 'aria-hidden': 'true' }), aboardText);
    const promptEl = h('div', 'ui-chip ui-drop__prompt', { role: 'status' });
    const secondEl = h('div', 'ui-chip ui-drop__prompt ui-drop__prompt--second');
    const fill = h('div', 'ui-alt__fill');
    const mark = h('div', 'ui-alt__mark', null, h('span', 'ui-alt__label'));
    const value = h('span', 'ui-alt__value ui-num');
    const alt = h('div', 'ui-alt', { 'aria-hidden': 'true' }, h('div', 'ui-alt__track', null, fill, mark), value);
    this.el = h(
      'div',
      'ui-drop',
      null,
      h('div', 'ui-drop__top', null, timer, aboard),
      h('div', 'ui-drop__prompts', null, promptEl, secondEl),
      alt,
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.timerShown = new Shown(timer);
    this.timerFlags = new Flags(timer);
    this.timerText = new TextSlot(timerText);
    this.aboardShown = new Shown(aboard);
    this.aboardText = new TextSlot(aboardText);
    this.prompt = new TextSlot(promptEl);
    this.promptFlags = new Flags(promptEl);
    this.second = new TextSlot(secondEl);
    this.secondShown = new Shown(secondEl);
    this.altShown = new Shown(alt);
    this.altFill = new StyleVar(fill, '--r');
    this.altMark = new StyleVar(mark, '--m');
    this.altValue = new TextSlot(value);
    this.altLabel = new TextSlot(mark.firstElementChild as HTMLElement);
    this.shown.set(false);
  }

  /** `hideCentrePrompt`: the one-time drop hint is up (it says the same thing). */
  update(drop: HudDropView | null, hideCentrePrompt: boolean): void {
    this.shown.set(drop !== null);
    if (!drop) {
      this.maxAltitude = 0;
      return;
    }
    if (drop.stage === 'aboard') this.maxAltitude = 0;
    else this.maxAltitude = Math.max(this.maxAltitude, drop.altitude);
    const m = dropHudModel(drop, this.maxAltitude);
    this.flags.set('is-aboard', m.stage === 'aboard');
    this.flags.set('is-falling', m.stage !== 'aboard');
    this.flags.set('is-hint', hideCentrePrompt && m.stage !== 'aboard');

    this.timerShown.set(m.timer !== null);
    if (m.timer) {
      this.timerText.set(t(m.timer.key, { time: m.timer.time }));
      this.timerFlags.set('is-urgent', m.timer.urgent);
    }
    this.aboardShown.set(m.aboardCount !== null);
    if (m.aboardCount !== null) this.aboardText.set(t('hud.carrier.aboard', { count: m.aboardCount }));

    this.prompt.set(t(m.promptKey));
    this.promptFlags.set('is-blocked', m.promptBlocked);
    this.secondShown.set(m.secondKey !== null);
    if (m.secondKey) this.second.set(t(m.secondKey));

    this.altShown.set(m.altitude !== null);
    if (m.altitude) {
      this.altFill.set(m.altitude.ratio.toFixed(3));
      this.altMark.set(m.altitude.deployRatio.toFixed(3));
      this.altLabel.set(t('hud.chute.auto', { height: m.altitude.deployMetres }));
      // The number needs a unit string; it shows once narrative adds `hud.drop.altitude` ("{height} m").
      this.altValue.set(hasKey('hud.drop.altitude') ? t('hud.drop.altitude', { height: m.altitude.metres }) : '');
    }
  }
}
