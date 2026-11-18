/**
 * Full-screen and modal screens. Each screen is a plain class with an `el`, a `show(bool)` and, where needed,
 * an `update()` that diffs. Interactive panels add `.ui-interactive` (pointer-events: auto); everything else
 * inherits `pointer-events: none` from #ui-root.
 * Owner: ui-ux-designer.
 */
import { hasKey, t, tRandom } from '../content/strings';
import { MAX_NAME_LENGTH } from '../shared/constants';
import {
  ADS_MODES,
  DEFAULT_ADS_MODE,
  DEFAULT_ADS_SENSITIVITY,
  DEFAULT_FP_FOV_DEG,
  DEFAULT_QUALITY,
  FP_FOV_MAX_DEG,
  FP_FOV_MIN_DEG,
  QUALITY_LEVELS,
  type AdsMode,
  type HudView,
  type QualityLevel,
  type Settings,
} from '../shared/contracts';
import type { GameEvents } from '../shared/events';
import { Flags, h, retrigger, Shown, TextSlot } from './dom';
import { CONFIRM_MS } from './roomLogic';
import { deathCauseKey, validateName } from './logic';
import {
  ADS_SENSITIVITY_MAX,
  ADS_SENSITIVITY_MIN,
  ADS_SENSITIVITY_STEP,
  effectiveHeadBob,
  FOV_STEP,
  headBobChoiceFor,
  isReducedMotion,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  type UiPrefs,
} from './settings';

/**
 * Controls help rows, in reading order (two columns). M2a adds ads (RMB), crouch (C), prone (Z), grenade (4 / G) and
 * throw (hold LMB); `jump` reads "Jump / Stand up" (Space). `cycle` (mouse wheel) shows once narrative-designer adds
 * `menu.controls.cycle.*`; rows whose strings are missing are skipped rather than showing raw keys.
 * M2b: `jumpPlane` (Space / F) and `spectateView` (V).
 */
export const CONTROL_IDS = [
  'move',
  'sprint',
  'jump',
  'aim',
  'fire',
  'ads',
  'crouch',
  'prone',
  'reload',
  'pickup',
  'switch',
  'cycle',
  'grenade',
  'throw',
  'heal',
  'jumpPlane',
  'spectateView',
  'release',
] as const;

export function controlsList(compact = false): HTMLElement {
  const ids = CONTROL_IDS.filter((id) => hasKey(`menu.controls.${id}.key`) && hasKey(`menu.controls.${id}.label`));
  const rows = ids.map((id) =>
    h(
      'div',
      'ui-controls__row',
      null,
      h('dt', null, null, h('kbd', 'ui-keycap', null, t(`menu.controls.${id}.key`))),
      h('dd', null, null, t(`menu.controls.${id}.label`)),
    ),
  );
  return h(
    'section',
    `ui-controls${compact ? ' ui-controls--compact' : ''}`,
    null,
    h('h3', 'ui-controls__title', null, t('menu.controls.title')),
    h('dl', 'ui-controls__list', null, ...rows),
  );
}

function button(label: string, variant: 'primary' | 'secondary' | 'ghost', onClick: (ev: MouseEvent) => void): HTMLButtonElement {
  const b = h('button', `ui-btn ui-btn--${variant}`, { type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function gearButton(onClick: () => void): HTMLButtonElement {
  const b = button(t('menu.settings.open'), 'ghost', (ev) => {
    ev.stopPropagation();
    onClick();
  });
  b.prepend(h('span', 'ui-glyph ui-glyph--gear', { 'aria-hidden': 'true' }));
  return b;
}

// ---------------------------------------------------------------------------------------------
// Title / name entry
// ---------------------------------------------------------------------------------------------
export class TitleScreen {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLParagraphElement;
  private readonly deepLink: HTMLElement;
  private readonly deepLinkText: TextSlot;
  private readonly deepLinkShown: Shown;

  constructor(initialName: string, onPlay: (name: string) => void, onSettings: () => void, onCancelDeepLink: () => void = () => {}) {
    this.input = h('input', 'ui-input', {
      id: 'ui-name',
      type: 'text',
      maxlength: MAX_NAME_LENGTH,
      autocomplete: 'nickname',
      spellcheck: 'false',
      placeholder: t('menu.name.placeholder'),
      'aria-describedby': 'ui-name-error',
    });
    this.input.value = initialName;
    this.error = h(
      'p',
      'ui-error',
      { id: 'ui-name-error', role: 'alert' },
      h('span', 'ui-glyph ui-glyph--warn', { 'aria-hidden': 'true' }),
      h('span', 'ui-error__text', null, t('menu.name.invalid')),
    );
    this.error.hidden = true;
    const play = h('button', 'ui-btn ui-btn--primary ui-btn--big', { type: 'submit' }, t('menu.play'));
    // M2b (UI.md §12.9): "Joining room ABCDE" chip from a ?room= link, with a small × to cancel.
    const dlText = h('span', null);
    const dlCancel = h(
      'button',
      'ui-chip__x',
      { type: 'button', 'aria-label': t('browser.deepLink.cancel'), title: t('browser.deepLink.cancel') },
      h('span', 'ui-glyph ui-glyph--close', { 'aria-hidden': 'true' }),
    );
    dlCancel.addEventListener('click', () => {
      this.setDeepLink(null);
      onCancelDeepLink();
      this.input.focus({ preventScroll: true });
    });
    this.deepLink = h('p', 'ui-chip ui-deeplink', { role: 'status' }, h('span', 'ui-glyph ui-glyph--link', { 'aria-hidden': 'true' }), dlText, dlCancel);
    this.deepLinkText = new TextSlot(dlText);
    this.deepLinkShown = new Shown(this.deepLink);
    this.deepLinkShown.set(false);
    const form = h(
      'form',
      'ui-title__form',
      { novalidate: true },
      h('label', 'ui-label', { for: 'ui-name' }, t('menu.name.prompt')),
      this.input,
      this.error,
      this.deepLink,
      play,
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const name = validateName(this.input.value);
      if (!name) {
        this.showError();
        return;
      }
      this.clearError();
      this.input.value = name;
      onPlay(name);
    });
    this.input.addEventListener('input', () => {
      if (!this.error.hidden && validateName(this.input.value)) this.clearError();
    });
    this.el = h(
      'section',
      'ui-screen ui-screen--title',
      { 'aria-labelledby': 'ui-title-logo' },
      h(
        'div',
        'ui-panel ui-panel--menu ui-interactive',
        null,
        h('h1', 'ui-logo', { id: 'ui-title-logo' }, t('game.title')),
        h('p', 'ui-tagline', null, t('game.tagline')),
        form,
        h('div', 'ui-row ui-row--end', null, gearButton(onSettings)),
      ),
    );
    this.shown = new Shown(this.el);
  }

  show(on: boolean): void {
    if (this.shown.set(on) && on) {
      // Focus after the frame so the element is visible (focus on hidden elements is ignored).
      requestAnimationFrame(() => this.input.focus({ preventScroll: true }));
    }
  }

  /** M2b: show or clear the deep-link chip. */
  setDeepLink(code: string | null): void {
    this.deepLinkShown.set(code !== null);
    if (code) this.deepLinkText.set(t('browser.deepLink', { code }));
  }

  showError(text?: string): void {
    const span = this.error.querySelector('.ui-error__text');
    if (span) span.textContent = text ?? t('menu.name.invalid');
    this.error.hidden = false;
    this.input.setAttribute('aria-invalid', 'true');
    retrigger(this.input, 'is-shake');
  }

  clearError(): void {
    this.error.hidden = true;
    this.input.removeAttribute('aria-invalid');
  }
}

// ---------------------------------------------------------------------------------------------
// Connecting / connection lost
// ---------------------------------------------------------------------------------------------
export class ConnectScreen {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  private readonly message: TextSlot;
  private readonly retry: HTMLButtonElement;
  private readonly retryLabel: TextSlot;
  private readonly retryShown: Shown;

  constructor(onRetry: () => void) {
    const msg = h('p', 'ui-connect__msg', { role: 'status' });
    this.retry = button('', 'primary', () => onRetry());
    this.el = h(
      'section',
      'ui-screen ui-screen--connect',
      null,
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--small ui-interactive',
        null,
        h('div', 'ui-spinner', { 'aria-hidden': 'true' }),
        h('span', 'ui-glyph ui-glyph--lost', { 'aria-hidden': 'true' }),
        msg,
        this.retry,
      ),
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.message = new TextSlot(msg);
    this.retryLabel = new TextSlot(this.retry);
    this.retryShown = new Shown(this.retry);
  }

  update(mode: 'connecting' | 'lost', messageKey: string, rejoin: boolean): void {
    this.flags.set('is-lost', mode === 'lost');
    this.message.set(t(mode === 'connecting' ? 'menu.connecting' : messageKey));
    if (this.retryShown.set(mode === 'lost') && mode === 'lost' && this.shown.visible) {
      requestAnimationFrame(() => this.retry.focus({ preventScroll: true }));
    }
    this.retryLabel.set(t(rejoin ? 'menu.connection.rejoin' : 'menu.connection.retry'));
  }

  show(on: boolean): void {
    if (this.shown.set(on) && on && this.retryShown.visible) requestAnimationFrame(() => this.retry.focus({ preventScroll: true }));
  }
}

// ---------------------------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------------------------
const MAX_SEATS_DRAWN = 24;

export class LobbyScreen {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  private readonly mapName: TextSlot;
  private readonly status: TextSlot;
  private readonly big: HTMLDivElement;
  private readonly bigText: TextSlot;
  private readonly count: TextSlot;
  private readonly seats: HTMLDivElement;
  private seatsKey = '';
  private lastBig = '';

  constructor(onSettings: () => void) {
    const mapName = h('p', 'ui-lobby__map');
    const status = h('p', 'ui-lobby__status', { role: 'status' });
    this.big = h('div', 'ui-lobby__big ui-num', { 'aria-hidden': 'true' });
    const count = h('p', 'ui-lobby__count');
    this.seats = h('div', 'ui-seats', { 'aria-hidden': 'true' });
    this.el = h(
      'section',
      'ui-screen ui-screen--lobby',
      null,
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--lobby ui-interactive',
        null,
        h('h2', 'ui-heading', null, t('lobby.title')),
        mapName,
        this.big,
        status,
        count,
        this.seats,
        h('p', 'ui-lobby__bots', null, h('span', 'ui-seat ui-seat--bot', { 'aria-hidden': 'true' }), t('lobby.botsFill')),
        controlsList(true),
        h('div', 'ui-row ui-row--end', null, gearButton(onSettings)),
      ),
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.mapName = new TextSlot(mapName);
    this.status = new TextSlot(status);
    this.bigText = new TextSlot(this.big);
    this.count = new TextSlot(count);
  }

  show(on: boolean): void {
    this.shown.set(on);
  }

  update(hud: HudView): void {
    this.mapName.set(t(hud.minimap.map.nameKey));
    let big = '';
    if (hud.phase === 'countdown' && hud.countdownSecondsLeft !== null) {
      const secs = Math.max(0, hud.countdownSecondsLeft);
      big = String(secs);
      // The last frames before the phase flips (or a late snapshot) read 0: say "Go!" instead of "starts in 0".
      this.status.set(secs > 0 ? t('lobby.countdown', { seconds: secs }) : t('announcer.matchStart'));
    } else if (hud.phase === 'results' && hud.resultsSecondsLeft !== null) {
      this.status.set(t('results.nextMatch', { seconds: hud.resultsSecondsLeft }));
    } else if (hud.phase === 'playing') {
      this.status.set(t('lobby.matchInProgress'));
    } else {
      this.status.set(t('lobby.waiting'));
    }
    this.flags.set('is-countdown', big !== '');
    this.bigText.set(big);
    if (big !== this.lastBig) {
      this.lastBig = big;
      if (big) retrigger(this.big, 'is-pop');
    }
    this.count.set(t('lobby.players', { count: hud.lobbyCount }));

    // Seats: one pip per target slot; humans filled, the rest outlined "bot" pips (shape differs, not just colour).
    const humans = Math.min(hud.lobbyCount, MAX_SEATS_DRAWN);
    const total = Math.min(Math.max(hud.targetPlayers, hud.lobbyCount), MAX_SEATS_DRAWN);
    const key = `${humans}/${total}`;
    if (key !== this.seatsKey) {
      this.seatsKey = key;
      this.seats.replaceChildren(
        ...Array.from({ length: total }, (_, i) => h('span', `ui-seat ${i < humans ? 'ui-seat--human' : 'ui-seat--bot'}`)),
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Click-to-play / pause overlay
// ---------------------------------------------------------------------------------------------
export class PlayOverlay {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly primary: HTMLButtonElement;
  private readonly primaryLabel: TextSlot;
  private readonly flags: Flags;
  private readonly leave: HTMLButtonElement;
  private readonly leaveLabel: TextSlot;
  private readonly leaveShown: Shown;
  private leaveArmedUntil = 0;

  constructor(onResume: () => void, onSettings: () => void, onLeaveRoom: () => void = () => {}) {
    const resume = (): void => {
      // Drop focus so Space (jump) / Enter never re-press a focused button while playing.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      onResume();
    };
    this.primary = button('', 'primary', (ev) => {
      ev.stopPropagation();
      resume();
    });
    this.primary.classList.add('ui-btn--big');
    // M2b: leave the room from the pause screen (two-step: it forfeits the match).
    this.leave = button('', 'ghost', (ev) => {
      ev.stopPropagation();
      const now = performance.now();
      if (now < this.leaveArmedUntil) {
        this.leaveArmedUntil = 0;
        this.syncLeave(now);
        onLeaveRoom();
        return;
      }
      this.leaveArmedUntil = now + CONFIRM_MS;
      this.syncLeave(now);
    });
    this.leave.prepend(h('span', 'ui-glyph ui-glyph--back', { 'aria-hidden': 'true' }));
    const leaveText = h('span', null);
    this.leave.appendChild(leaveText);
    this.leaveLabel = new TextSlot(leaveText);
    this.leaveShown = new Shown(this.leave);
    this.leaveShown.set(false);
    const panel = h(
      'div',
      'ui-panel ui-panel--menu ui-panel--play',
      null,
      h('span', 'ui-glyph ui-glyph--mouse', { 'aria-hidden': 'true' }),
      this.primary,
      h('p', 'ui-subtle', null, t('menu.pointerLock.hint')),
      controlsList(),
      h('div', 'ui-row ui-row--split', null, this.leave, gearButton(onSettings)),
    );
    // Clicking anywhere on the dimmed backdrop also resumes (big target, still inside a user gesture).
    this.el = h('section', 'ui-screen ui-screen--play ui-interactive', null, panel);
    this.el.addEventListener('click', (ev) => {
      if (ev.target === this.el) resume();
    });
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.primaryLabel = new TextSlot(this.primary);
  }

  update(firstLock: boolean, inRoom = false): void {
    this.primaryLabel.set(t(firstLock ? 'menu.pointerLock.prompt' : 'menu.resume'));
    this.flags.set('is-paused', !firstLock);
    this.leaveShown.set(inRoom);
    this.syncLeave(performance.now());
  }

  private syncLeave(now: number): void {
    const armed = now < this.leaveArmedUntil;
    this.leave.classList.toggle('is-armed', armed);
    this.leaveLabel.set(t(armed ? 'room.leave.confirm' : 'room.leave'));
  }

  show(on: boolean): void {
    if (this.shown.set(on) && on) requestAnimationFrame(() => this.primary.focus({ preventScroll: true }));
  }
}

// ---------------------------------------------------------------------------------------------
// Graphics failure overlay + restoring note (IUi.setGraphicsStatus, ADR 0003)
// ---------------------------------------------------------------------------------------------
export class GraphicsOverlay {
  /** Blocking overlay (sits above every other screen, including Settings). */
  readonly el: HTMLElement;
  /** Small non-blocking status note. */
  readonly noteEl: HTMLElement;
  private readonly shown: Shown;
  private readonly noteShown: Shown;
  private readonly reload: HTMLButtonElement;

  constructor(onReload: () => void) {
    this.reload = button(t('menu.graphics.reload'), 'primary', () => onReload());
    this.reload.classList.add('ui-btn--big');
    this.el = h(
      'section',
      'ui-screen ui-screen--gfx ui-interactive',
      { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ui-gfx-title', 'aria-describedby': 'ui-gfx-body' },
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--small',
        null,
        h('span', 'ui-glyph ui-glyph--warn', { 'aria-hidden': 'true' }),
        h('h2', 'ui-heading', { id: 'ui-gfx-title' }, t('menu.graphics.failed.title')),
        h('p', 'ui-subtle', { id: 'ui-gfx-body' }, t('menu.graphics.failed.body')),
        this.reload,
      ),
    );
    this.noteEl = h(
      'div',
      'ui-gfx-note ui-chip',
      { role: 'status' },
      h('div', 'ui-spinner ui-spinner--small', { 'aria-hidden': 'true' }),
      h('span', null, null, t('menu.graphics.restoring')),
    );
    this.shown = new Shown(this.el);
    this.noteShown = new Shown(this.noteEl);
    this.shown.set(false);
    this.noteShown.set(false);
  }

  get blocking(): boolean {
    return this.shown.visible;
  }

  set(blocking: boolean, note: boolean): void {
    if (this.shown.set(blocking) && blocking) requestAnimationFrame(() => this.reload.focus({ preventScroll: true }));
    this.noteShown.set(note);
  }
}

// ---------------------------------------------------------------------------------------------
// Death card
// ---------------------------------------------------------------------------------------------
export class DeathCard {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  private readonly cause: TextSlot;
  private readonly place: TextSlot;
  private readonly kills: TextSlot;
  private placement = 0;

  constructor(onSpectate: () => void) {
    const cause = h('p', 'ui-death__cause');
    const place = h('p', 'ui-death__place ui-num');
    const kills = h('p', 'ui-death__kills');
    this.el = h(
      'section',
      'ui-screen ui-screen--death',
      { role: 'alertdialog', 'aria-labelledby': 'ui-death-title' },
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--death ui-interactive',
        null,
        h('span', 'ui-glyph ui-glyph--lifebuoy', { 'aria-hidden': 'true' }),
        h('h2', 'ui-heading ui-heading--big', { id: 'ui-death-title' }, t('death.title')),
        cause,
        place,
        kills,
        button(t('death.spectate'), 'primary', () => onSpectate()),
      ),
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.cause = new TextSlot(cause);
    this.place = new TextSlot(place);
    this.kills = new TextSlot(kills);
  }

  /** `self` = the local player's own grenade (logic.isSelfGrenadeKill). */
  setDeath(e: GameEvents['playerKilled'], self = false): void {
    this.placement = e.placement;
    const key = deathCauseKey(e.cause, e.killerName, self);
    this.cause.set(key ? t(key, { name: e.killerName ?? '' }) : '');
  }

  update(hud: HudView): void {
    // M2b (UI.md §13.3): with the first-person camera the death cam orbits the body, so the card sits in the lower third.
    this.flags.set('is-lower', hud.cameraView !== undefined);
    const total = hud.totalPlayers;
    this.place.set(
      this.placement > 0
        ? total > 0
          ? t('death.placementOf', { place: this.placement, total })
          : t('death.placement', { place: this.placement })
        : '',
    );
    this.kills.set(hud.local ? t('hud.kills', { count: hud.local.kills }) : '');
  }

  show(on: boolean): void {
    this.shown.set(on);
  }
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------
export class ResultsScreen {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  private readonly banner: TextSlot;
  private readonly winner: TextSlot;
  private readonly place: TextSlot;
  private readonly kills: TextSlot;
  private readonly next: TextSlot;
  private readonly table: HTMLOListElement;
  private readonly playAgain: HTMLButtonElement;

  constructor(onPlayAgain: () => void) {
    const banner = h('h2', 'ui-results__banner', { id: 'ui-results-title' });
    const winner = h('p', 'ui-results__winner');
    const place = h('p', 'ui-results__place ui-num');
    const kills = h('p', 'ui-results__kills');
    const next = h('p', 'ui-results__next', { role: 'status' });
    this.table = h('ol', 'ui-standings');
    this.playAgain = button(t('results.playAgain'), 'primary', () => onPlayAgain());
    this.playAgain.classList.add('ui-btn--big');
    this.el = h(
      'section',
      'ui-screen ui-screen--results',
      { 'aria-labelledby': 'ui-results-title' },
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--results ui-interactive',
        null,
        h('span', 'ui-glyph ui-glyph--trophy', { 'aria-hidden': 'true' }),
        banner,
        winner,
        h('div', 'ui-results__stats', null, place, kills),
        this.table,
        next,
        this.playAgain,
      ),
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.banner = new TextSlot(banner);
    this.winner = new TextSlot(winner);
    this.place = new TextSlot(place);
    this.kills = new TextSlot(kills);
    this.next = new TextSlot(next);
  }

  /** Called once per match end. Picks the banner variant once so it does not flicker. */
  setResults(e: GameEvents['matchEnded'] | null, localId: number | null, rng: () => number = Math.random): void {
    const participated = e !== null && e.localPlacement !== null;
    const won = e?.isLocalWinner === true;
    this.flags.set('is-win', won);
    this.flags.set('is-loss', participated && !won);
    this.banner.set(won ? tRandom('results.win', undefined, rng) : participated ? tRandom('results.loss', undefined, rng) : '');
    this.winner.set(e?.winnerName ? t('results.winner', { name: e.winnerName }) : '');
    this.place.set(participated && e ? t('results.placement', { place: e.localPlacement ?? 0, total: e.totalPlayers }) : '');
    this.kills.set(participated && e ? t('results.kills', { count: e.localKills }) : '');
    const rows = (e?.standings ?? []).map((s) => {
      const li = h(
        'li',
        `ui-standings__row${s.id === localId ? ' is-me' : ''}${s.placement === 1 ? ' is-first' : ''}`,
        null,
        h('span', 'ui-standings__place ui-num', null, t('death.placement', { place: s.placement })),
        h('span', 'ui-standings__name', null, s.name),
        s.isBot ? h('span', 'ui-tag ui-tag--bot', null, t('results.bot')) : null,
        h(
          'span',
          'ui-standings__kills ui-num',
          null,
          h('span', 'ui-glyph ui-glyph--star', { 'aria-hidden': 'true' }),
          t('hud.kills', { count: s.kills }),
        ),
      );
      return li;
    });
    this.table.replaceChildren(...rows);
    this.table.hidden = rows.length === 0;
  }

  update(hud: HudView): void {
    this.next.set(hud.resultsSecondsLeft !== null ? t('results.nextMatch', { seconds: hud.resultsSecondsLeft }) : '');
  }

  show(on: boolean): void {
    if (this.shown.set(on) && on) requestAnimationFrame(() => this.playAgain.focus({ preventScroll: true }));
  }
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------
interface RangeRow {
  row: HTMLElement;
  input: HTMLInputElement;
  output: HTMLOutputElement;
}

function rangeRow(id: string, labelKey: string, min: number, max: number, step: number): RangeRow {
  const input = h('input', 'ui-range', { id, type: 'range', min, max, step });
  const output = h('output', 'ui-range__value ui-num', { for: id });
  const row = h('div', 'ui-field', null, h('label', 'ui-label', { for: id }, t(labelKey)), input, output);
  return { row, input, output };
}

/** Native radio group styled as a segmented control (arrow keys move between options, as in any radio group). */
function segmentedRow<T extends string>(
  name: string,
  labelKey: string,
  options: readonly T[],
  optionLabelKey: (v: T) => string,
): { row: HTMLElement; inputs: Map<T, HTMLInputElement> } {
  const inputs = new Map<T, HTMLInputElement>();
  const opts = options.map((v) => {
    const input = h('input', 'ui-seg__input', { type: 'radio', name, value: v, id: `${name}-${v}` });
    inputs.set(v, input);
    return h(
      'label',
      'ui-seg__opt',
      { for: `${name}-${v}` },
      input,
      h('span', 'ui-seg__tick', { 'aria-hidden': 'true' }),
      h('span', 'ui-seg__text', null, t(optionLabelKey(v))),
    );
  });
  const row = h(
    'fieldset',
    'ui-field ui-field--seg',
    null,
    h('legend', 'ui-label', null, t(labelKey)),
    h('div', 'ui-seg', null, ...opts),
  );
  return { row, inputs };
}

function checkRow(id: string, labelKey: string): { row: HTMLElement; input: HTMLInputElement } {
  const input = h('input', 'ui-check', { id, type: 'checkbox' });
  const row = h(
    'div',
    'ui-field ui-field--check',
    null,
    input,
    h('label', 'ui-label', { for: id }, t(labelKey)),
  );
  return { row, input };
}

const percent = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export class SettingsPanel {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly sens: RangeRow;
  private readonly fov: RangeRow;
  private readonly bob: HTMLInputElement;
  private readonly bobNote: Shown;
  private readonly adsSens: RangeRow;
  private readonly vol: RangeRow;
  private readonly adsMode: Map<AdsMode, HTMLInputElement>;
  private readonly scale: RangeRow;
  private readonly invert: HTMLInputElement;
  private readonly motion: HTMLInputElement;
  private readonly quality: Map<QualityLevel, HTMLInputElement>;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey: (ev: KeyboardEvent) => void;

  constructor(
    private settings: Settings,
    private prefs: UiPrefs,
    private readonly systemReducedMotion: () => boolean,
    private readonly onSettings: (s: Settings) => void,
    private readonly onPrefs: (p: UiPrefs) => void,
  ) {
    this.sens = rangeRow('ui-set-sens', 'menu.settings.sensitivity', SENSITIVITY_MIN, SENSITIVITY_MAX, SENSITIVITY_STEP);
    // M2b (UI.md §13.4): FOV slider (live while dragging) and head bob (auto / on / off behind one checkbox).
    this.fov = rangeRow('ui-set-fov', 'menu.settings.fov', FP_FOV_MIN_DEG, FP_FOV_MAX_DEG, FOV_STEP);
    this.fov.input.addEventListener('input', () => this.emitSettings({ fovDeg: Number(this.fov.input.value) }));
    const bob = checkRow('ui-set-bob', 'menu.settings.headBob');
    this.bob = bob.input;
    const bobNote = h('p', 'ui-subnote ui-field__note', { id: 'ui-set-bob-note' }, t('menu.settings.headBob.reduced'));
    bob.row.appendChild(bobNote);
    this.bobNote = new Shown(bobNote);
    this.bob.addEventListener('change', () => {
      this.emitPrefs({ headBob: headBobChoiceFor(this.bob.checked, this.reducedNow()) });
      this.syncBob();
    });
    this.adsSens = rangeRow(
      'ui-set-ads-sens',
      'menu.settings.adsSensitivity',
      ADS_SENSITIVITY_MIN,
      ADS_SENSITIVITY_MAX,
      ADS_SENSITIVITY_STEP,
    );
    this.vol = rangeRow('ui-set-vol', 'menu.settings.volume', 0, 1, 0.05);
    this.scale = rangeRow('ui-set-scale', 'menu.settings.uiScale', UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP);
    const inv = checkRow('ui-set-invert', 'menu.settings.invertY');
    const mot = checkRow('ui-set-motion', 'menu.settings.reducedMotion');
    this.invert = inv.input;
    this.motion = mot.input;
    const aim = segmentedRow('ui-set-aim', 'menu.settings.aimMode', ADS_MODES, (m) => `menu.settings.mode.${m}`);
    this.adsMode = aim.inputs;
    for (const [mode, input] of this.adsMode) {
      input.addEventListener('change', () => {
        if (input.checked) this.emitSettings({ adsMode: mode });
      });
    }
    const qual = segmentedRow('ui-set-quality', 'menu.settings.quality', QUALITY_LEVELS, (q) => `menu.settings.quality.${q}`);
    this.quality = qual.inputs;
    for (const [level, input] of this.quality) {
      input.addEventListener('change', () => {
        if (input.checked) this.emitSettings({ quality: level });
      });
    }

    this.sens.input.addEventListener('input', () => this.emitSettings({ mouseSensitivity: Number(this.sens.input.value) }));
    this.adsSens.input.addEventListener('input', () => this.emitSettings({ adsSensitivity: Number(this.adsSens.input.value) }));
    this.vol.input.addEventListener('input', () => this.emitSettings({ masterVolume: Number(this.vol.input.value) }));
    this.invert.addEventListener('change', () => this.emitSettings({ invertY: this.invert.checked }));
    this.scale.input.addEventListener('change', () => this.emitPrefs({ uiScale: Number(this.scale.input.value) }));
    this.scale.input.addEventListener('input', () => {
      this.scale.output.value = percent.format(Number(this.scale.input.value));
    });
    this.motion.addEventListener('change', () => {
      this.emitPrefs({ reducedMotion: this.motion.checked ? 'on' : 'off' });
      this.syncBob();
    });

    const close = button(t('menu.settings.close'), 'primary', () => this.show(false));
    this.el = h(
      'section',
      'ui-screen ui-screen--settings ui-interactive',
      null,
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--settings',
        { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ui-settings-title' },
        h('h2', 'ui-heading', { id: 'ui-settings-title' }, t('menu.settings.title')),
        this.sens.row,
        this.fov.row,
        bob.row,
        inv.row,
        aim.row,
        this.adsSens.row,
        this.vol.row,
        qual.row,
        this.scale.row,
        mot.row,
        h('div', 'ui-row ui-row--end', null, close),
      ),
    );
    this.el.addEventListener('click', (ev) => {
      if (ev.target === this.el) this.show(false);
    });
    this.onKey = (ev) => {
      if (ev.key === 'Escape' && this.isOpen) {
        ev.preventDefault();
        this.show(false);
      }
    };
    window.addEventListener('keydown', this.onKey);
    this.shown = new Shown(this.el);
    this.shown.set(false);
    this.sync();
  }

  get isOpen(): boolean {
    return this.shown.visible;
  }

  show(on: boolean): void {
    if (!this.shown.set(on)) return;
    if (on) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.sync();
      requestAnimationFrame(() => this.sens.input.focus({ preventScroll: true }));
    } else {
      this.returnFocus?.focus({ preventScroll: true });
      this.returnFocus = null;
    }
  }

  private sync(): void {
    this.sens.input.value = String(this.settings.mouseSensitivity);
    this.sens.output.value = decimal.format(this.settings.mouseSensitivity);
    const adsSens = this.settings.adsSensitivity ?? DEFAULT_ADS_SENSITIVITY;
    this.adsSens.input.value = String(adsSens);
    this.adsSens.output.value = decimal.format(adsSens);
    const mode = this.settings.adsMode ?? DEFAULT_ADS_MODE;
    for (const [m, input] of this.adsMode) input.checked = m === mode;
    this.vol.input.value = String(this.settings.masterVolume);
    this.vol.output.value = percent.format(this.settings.masterVolume);
    this.invert.checked = this.settings.invertY;
    const quality = this.settings.quality ?? DEFAULT_QUALITY;
    for (const [level, input] of this.quality) input.checked = level === quality;
    this.scale.input.value = String(this.prefs.uiScale);
    this.scale.output.value = percent.format(this.prefs.uiScale);
    this.motion.checked = this.reducedNow();
    const fov = this.settings.fovDeg ?? DEFAULT_FP_FOV_DEG;
    this.fov.input.value = String(fov);
    this.fov.output.value = t('menu.settings.fov.value', { deg: fov });
    this.syncBob();
  }

  private reducedNow(): boolean {
    return isReducedMotion(this.prefs.reducedMotion, this.systemReducedMotion());
  }

  /** The head-bob checkbox shows the EFFECTIVE value; the sub-label explains an automatic "off". */
  private syncBob(): void {
    const reduced = this.reducedNow();
    this.bob.checked = effectiveHeadBob(this.prefs.headBob, reduced);
    const note = this.prefs.headBob === 'auto' && reduced;
    this.bobNote.set(note);
    if (note) this.bob.setAttribute('aria-describedby', 'ui-set-bob-note');
    else this.bob.removeAttribute('aria-describedby');
  }

  /** Ui calls this when the OS reduced-motion preference changes while the panel may be open. */
  refreshMotion(): void {
    this.motion.checked = this.reducedNow();
    this.syncBob();
  }

  private emitSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    this.onSettings(this.settings);
    this.sens.output.value = decimal.format(this.settings.mouseSensitivity);
    this.adsSens.output.value = decimal.format(this.settings.adsSensitivity ?? DEFAULT_ADS_SENSITIVITY);
    this.vol.output.value = percent.format(this.settings.masterVolume);
    this.fov.output.value = t('menu.settings.fov.value', { deg: this.settings.fovDeg ?? DEFAULT_FP_FOV_DEG });
  }

  private emitPrefs(patch: Partial<UiPrefs>): void {
    this.prefs = { ...this.prefs, ...patch };
    this.onPrefs(this.prefs);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
  }
}

