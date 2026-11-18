/**
 * M2b rooms screens (docs/ui/UI.md §12): the room browser, the create / room-settings dialog, the waiting room (members,
 * host crown, ready ticks, code with Copy and invite link, map card or vote, host controls, auto-start, countdown with
 * the flight-route preview) and the menu toasts. They read HudView.rooms (RoomsView) and send intents through the
 * callbacks only; they never change game state. Every per-frame write is diffed.
 * Owner: ui-ux-designer.
 */
import { hasKey, t, type StringVars } from '../content/strings';
import type {
  HudView,
  RoomBrowserView,
  RoomLimitsView,
  RoomListEntryView,
  RoomMemberView,
  RoomSettingsInput,
  RoomView,
} from '../shared/contracts';
import type { MapId, MapVoteOption, MemberId, RoomMapMode } from '../shared/types';
import { Flags, h, retrigger, Shown, TextSlot } from './dom';
import { Minimap, type CoastlineFn } from './minimap';
import {
  checkRoomCode,
  codeErrorKey,
  CONFIRM_MS,
  COUNTDOWN_ANNOUNCE,
  formatCodeTyping,
  inviteLink,
  isRoomFull,
  mapCardTitle,
  mapGlyph,
  mapModeKey,
  mapNameKey,
  maxHumansRange,
  memberStatus,
  readySummary,
  ROOM_COUNT_ANNOUNCE_MS,
  roomNameToSend,
  roomStatusText,
  showVotePanel,
  startButtonState,
  voteOptionKey,
} from './roomLogic';

type Pending = 'create' | 'join' | 'leave' | 'start' | 'cancel' | 'settings' | null;

function btn(label: string, variant: 'primary' | 'secondary' | 'ghost', onClick: (ev: MouseEvent) => void, cls = ''): HTMLButtonElement {
  const b = h('button', `ui-btn ui-btn--${variant}${cls ? ` ${cls}` : ''}`, { type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function glyph(kind: string): HTMLSpanElement {
  return h('span', `ui-glyph ui-glyph--${kind}`, { 'aria-hidden': 'true' });
}

function mapGlyphEl(v: RoomMapMode | MapVoteOption): HTMLSpanElement {
  return h('span', 'ui-mapglyph', { 'aria-hidden': 'true', 'data-glyph': mapGlyph(v) });
}

/** A button whose first press arms it ("Kick?") for CONFIRM_MS and whose second press acts. */
class ConfirmButton {
  readonly el: HTMLButtonElement;
  private readonly label: TextSlot;
  private armedUntil = 0;

  constructor(
    private readonly normalKey: string,
    private readonly armedKey: string,
    cls: string,
    private readonly action: () => void,
    private readonly needsConfirm: () => boolean = () => true,
    aria?: string,
  ) {
    this.el = h('button', `ui-btn ${cls}`, { type: 'button', 'aria-label': aria ?? null });
    this.label = new TextSlot(this.el);
    this.label.set(t(normalKey));
    this.el.addEventListener('click', () => {
      const now = performance.now();
      if (!this.needsConfirm() || now < this.armedUntil) {
        this.armedUntil = 0;
        this.sync(now);
        this.action();
        return;
      }
      this.armedUntil = now + CONFIRM_MS;
      this.sync(now);
    });
  }

  /** Call each frame to drop the armed state after CONFIRM_MS. */
  sync(now: number): void {
    const armed = now < this.armedUntil;
    this.el.classList.toggle('is-armed', armed);
    this.label.set(t(armed ? this.armedKey : this.normalKey));
  }
}

// ---------------------------------------------------------------------------------------------
// Menu toasts (browser: top centre; waiting room: bottom right)
// ---------------------------------------------------------------------------------------------
const MENU_TOAST_MS = 3200;

export class MenuToasts {
  readonly el: HTMLDivElement;
  private readonly items: { el: HTMLElement; until: number; key: string }[] = [];

  constructor() {
    this.el = h('div', 'ui-menutoasts', { 'aria-live': 'polite' });
  }

  push(key: string, vars: StringVars, warn: boolean, nowMs: number): void {
    const dup = this.items.findIndex((x) => x.key === key && warn);
    if (dup >= 0) this.items.splice(dup, 1)[0]?.el.remove();
    const el = h('div', `ui-toast ui-chip ui-menutoast${warn ? ' ui-toast--fail' : ''}`, warn ? { role: 'alert' } : null);
    if (warn) el.appendChild(glyph('warn'));
    el.appendChild(h('span', null, null, t(key, vars)));
    this.el.appendChild(el);
    this.items.push({ el, until: nowMs + MENU_TOAST_MS, key });
    while (this.items.length > 3) this.items.shift()?.el.remove();
  }

  update(nowMs: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it && it.until <= nowMs) {
        it.el.remove();
        this.items.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const it of this.items) it.el.remove();
    this.items.length = 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Room browser
// ---------------------------------------------------------------------------------------------
export interface BrowserCallbacks {
  refresh(): void;
  create(): void;
  join(target: { roomId: string } | { code: string }): void;
  back(): void;
  /** A full room was clicked. */
  full(): void;
}

interface RowUi {
  li: HTMLLIElement;
  button: HTMLButtonElement;
  flags: Flags;
  name: TextSlot;
  mapGlyph: HTMLSpanElement;
  map: TextSlot;
  players: TextSlot;
  status: TextSlot;
  statusGlyph: HTMLSpanElement;
  entry: RoomListEntryView | null;
}

const REFRESH_SPIN_MS = 400;
const REFRESH_COOLDOWN_MS = 1000;

export class RoomBrowser {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly input: HTMLInputElement;
  private readonly joinBtn: HTMLButtonElement;
  private readonly joinFlags: Flags;
  private readonly error: HTMLParagraphElement;
  private readonly errorText: TextSlot;
  private readonly createBtn: HTMLButtonElement;
  private readonly createNote: Shown;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly listShown: Shown;
  private readonly skeleton: Shown;
  private readonly empty: Shown;
  private readonly emptyCreate: HTMLButtonElement;
  private readonly countLive: TextSlot;
  private readonly rows = new Map<string, RowUi>();
  private order = '';
  private refreshUntil = 0;
  private lastCountAnnounce = -Infinity;
  private lastCount = -1;
  private loaded = false;
  private roomsNow = 0;
  private codeLength = 5;
  private codeAlphabet: string | undefined;

  constructor(private readonly cb: BrowserCallbacks) {
    // Header
    this.refreshBtn = btn(t('browser.refresh'), 'ghost', () => this.refresh(), 'ui-btn--small');
    this.refreshBtn.prepend(glyph('refresh'));
    this.createBtn = btn(t('browser.create'), 'primary', () => cb.create());
    this.createBtn.prepend(glyph('plus'));
    const createNote = h('span', 'ui-subnote', { id: 'ui-browser-create-note' }, t('browser.error.roomLimit'));
    this.createNote = new Shown(createNote);
    this.createNote.set(false);
    const countLive = h('span', 'ui-sr', { 'aria-live': 'polite' });
    this.countLive = new TextSlot(countLive);

    // Join by code
    this.input = h('input', 'ui-input ui-input--code', {
      id: 'ui-room-code',
      type: 'text',
      inputmode: 'text',
      autocapitalize: 'characters',
      autocomplete: 'off',
      spellcheck: 'false',
      maxlength: 7,
      placeholder: t('browser.code.placeholder'),
      'aria-describedby': 'ui-room-code-error',
    });
    this.joinBtn = h('button', 'ui-btn ui-btn--secondary', { type: 'submit' }, h('span', 'ui-btn__spin', { 'aria-hidden': 'true' }), t('browser.code.join'));
    this.joinFlags = new Flags(this.joinBtn);
    const errText = h('span', 'ui-error__text');
    this.error = h('p', 'ui-error', { id: 'ui-room-code-error', role: 'alert' }, glyph('warn'), errText);
    this.errorText = new TextSlot(errText);
    this.error.hidden = true;
    const form = h(
      'form',
      'ui-codeform',
      { novalidate: true },
      h('label', 'ui-label', { for: 'ui-room-code' }, t('browser.code.label')),
      h('div', 'ui-codeform__row', null, this.input, this.joinBtn),
      this.error,
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.submitCode();
    });
    this.input.addEventListener('input', () => {
      const v = formatCodeTyping(this.input.value);
      if (v !== this.input.value) this.input.value = v;
      if (!this.error.hidden) this.clearError();
    });

    // List
    const head = h(
      'div',
      'ui-roomtable__head',
      { 'aria-hidden': 'true' },
      h('span', null, null, t('browser.col.name')),
      h('span', null, null, t('browser.col.map')),
      h('span', null, null, t('browser.col.players')),
      h('span', null, null, t('browser.col.status')),
    );
    this.list = h('ul', 'ui-roomtable__list', { role: 'list', 'aria-labelledby': 'ui-browser-title' });
    this.list.addEventListener('keydown', (ev) => this.onListKey(ev));
    const skel = h(
      'div',
      'ui-roomtable__loading',
      { role: 'status' },
      h('div', 'ui-skel'),
      h('div', 'ui-skel'),
      h('div', 'ui-skel'),
      h('p', 'ui-subtle', null, t('browser.loading')),
    );
    this.skeleton = new Shown(skel);
    this.emptyCreate = btn(t('browser.create'), 'primary', () => cb.create());
    this.emptyCreate.prepend(glyph('plus'));
    const empty = h('div', 'ui-roomtable__empty', null, glyph('umbrella'), h('p', null, null, t('browser.empty')), this.emptyCreate);
    this.empty = new Shown(empty);
    this.empty.set(false);
    const table = h('div', 'ui-roomtable', null, head, this.list, skel, empty);
    this.listShown = new Shown(this.list);

    const back = btn(t('browser.back'), 'ghost', () => cb.back());
    back.prepend(glyph('back'));
    this.el = h(
      'section',
      'ui-screen ui-screen--browser',
      { 'aria-labelledby': 'ui-browser-title' },
      h(
        'div',
        'ui-panel ui-panel--menu ui-panel--browser ui-interactive',
        null,
        h(
          'div',
          'ui-browser__head',
          null,
          h('h2', 'ui-heading', { id: 'ui-browser-title' }, t('browser.title')),
          countLive,
          h('div', 'ui-browser__actions', null, this.refreshBtn, h('div', 'ui-browser__create', null, this.createBtn, createNote)),
        ),
        form,
        table,
        h('div', 'ui-row ui-browser__foot', null, h('p', 'ui-subtle ui-browser__bots', null, h('span', 'ui-seat ui-seat--bot', { 'aria-hidden': 'true' }), t('lobby.botsFill')), back),
      ),
    );
    this.shown = new Shown(this.el);
    this.shown.set(false);
  }

  show(on: boolean): void {
    if (this.shown.set(on) && on) requestAnimationFrame(() => this.focusDefault());
  }

  get visible(): boolean {
    return this.shown.visible;
  }

  focusDefault(): void {
    if (this.loaded && this.roomsNow === 0) this.emptyCreate.focus({ preventScroll: true });
    else this.input.focus({ preventScroll: true });
  }

  focusCode(): void {
    this.input.focus({ preventScroll: true });
  }

  prefillCode(code: string): void {
    this.input.value = code;
  }

  showError(key: string, vars: StringVars = {}): void {
    this.errorText.set(t(key, vars));
    this.error.hidden = false;
    this.input.setAttribute('aria-invalid', 'true');
    retrigger(this.input, 'is-shake');
  }

  clearError(): void {
    this.error.hidden = true;
    this.input.removeAttribute('aria-invalid');
  }

  private submitCode(): void {
    if (this.input.readOnly) return;
    const r = checkRoomCode(this.input.value, this.codeLength, this.codeAlphabet);
    if (!r.ok) {
      if (r.error === 'empty') return;
      this.showError(codeErrorKey(r.error), { length: this.codeLength });
      return;
    }
    this.clearError();
    this.input.value = r.code;
    this.cb.join({ code: r.code });
  }

  private refresh(): void {
    const now = performance.now();
    if (now < this.refreshUntil) return;
    this.refreshUntil = now + REFRESH_COOLDOWN_MS;
    this.refreshBtn.disabled = true;
    this.refreshBtn.classList.add('is-spinning');
    setTimeout(() => this.refreshBtn.classList.remove('is-spinning'), REFRESH_SPIN_MS);
    setTimeout(() => {
      this.refreshBtn.disabled = false;
    }, REFRESH_COOLDOWN_MS);
    this.cb.refresh();
  }

  update(view: RoomBrowserView, pending: Pending, nowMs: number): void {
    this.codeLength = view.limits.codeLength;
    this.codeAlphabet = view.limits.codeAlphabet;
    this.loaded = view.loaded;
    this.roomsNow = view.rooms.length;
    const joining = pending === 'join';
    this.joinFlags.set('is-pending', joining);
    if (this.input.readOnly !== joining) this.input.readOnly = joining;
    this.joinBtn.disabled = joining;
    if (this.createBtn.disabled === view.canCreate) {
      this.createBtn.disabled = !view.canCreate;
      this.emptyCreate.disabled = !view.canCreate;
      if (view.canCreate) this.createBtn.removeAttribute('aria-describedby');
      else this.createBtn.setAttribute('aria-describedby', 'ui-browser-create-note');
    }
    this.createNote.set(!view.canCreate);

    this.skeleton.set(!view.loaded);
    this.empty.set(view.loaded && view.rooms.length === 0);
    this.listShown.set(view.loaded && view.rooms.length > 0);
    if (view.loaded) this.syncRows(view.rooms);

    if (view.loaded && view.rooms.length !== this.lastCount && nowMs - this.lastCountAnnounce >= ROOM_COUNT_ANNOUNCE_MS) {
      this.lastCount = view.rooms.length;
      this.lastCountAnnounce = nowMs;
      this.countLive.set(t('browser.count', { count: view.rooms.length }));
    }
  }

  private syncRows(rooms: readonly RoomListEntryView[]): void {
    const seen = new Set<string>();
    for (const r of rooms) {
      seen.add(r.id);
      let row = this.rows.get(r.id);
      if (!row) {
        row = this.makeRow(r.id);
        this.rows.set(r.id, row);
      }
      this.fillRow(row, r);
    }
    for (const [id, row] of this.rows) {
      if (!seen.has(id)) {
        row.li.remove();
        this.rows.delete(id);
      }
    }
    const order = rooms.map((r) => r.id).join('|');
    if (order !== this.order) {
      this.order = order;
      const focused = document.activeElement;
      for (const r of rooms) {
        const row = this.rows.get(r.id);
        if (row) this.list.appendChild(row.li);
      }
      if (focused instanceof HTMLElement && this.list.contains(focused)) focused.focus({ preventScroll: true });
      this.syncTabStops();
    }
  }

  private makeRow(id: string): RowUi {
    const name = h('span', 'ui-roomrow__name');
    const mg = h('span', 'ui-mapglyph', { 'aria-hidden': 'true' });
    const map = h('span', null);
    const players = h('span', 'ui-roomrow__players ui-num');
    const sg = h('span', 'ui-statusglyph', { 'aria-hidden': 'true' });
    const status = h('span', null);
    const button = h(
      'button',
      'ui-roomrow',
      { type: 'button', tabindex: -1 },
      name,
      h('span', 'ui-roomrow__map', null, mg, map),
      h('span', 'ui-roomrow__playerscell', null, players, h('span', 'ui-tag ui-roomrow__full', null, glyph('lock'), t('browser.full'))),
      h('span', 'ui-roomrow__status', null, sg, status),
      h('span', 'ui-roomrow__notice', null, glyph('eye'), t('browser.notice.inMatch')),
    );
    const li = h('li', 'ui-roomtable__item', null, button);
    const row: RowUi = {
      li,
      button,
      flags: new Flags(button),
      name: new TextSlot(name),
      mapGlyph: mg,
      map: new TextSlot(map),
      players: new TextSlot(players),
      status: new TextSlot(status),
      statusGlyph: sg,
      entry: null,
    };
    button.addEventListener('click', () => {
      const e = row.entry;
      if (!e) return;
      if (isRoomFull(e)) this.cb.full();
      else this.cb.join({ roomId: id });
    });
    button.addEventListener('focus', () => {
      for (const r of this.rows.values()) r.button.tabIndex = r === row ? 0 : -1;
    });
    return row;
  }

  private fillRow(row: RowUi, e: RoomListEntryView): void {
    row.entry = e;
    const mapKey = mapModeKey(e.mapMode === 'vote' && e.mapId ? e.mapId : e.mapMode);
    const status = roomStatusText(e);
    const full = isRoomFull(e);
    row.name.set(e.name);
    row.mapGlyph.dataset['glyph'] = mapGlyph(e.mapMode === 'vote' && e.mapId ? e.mapId : e.mapMode);
    row.map.set(t(mapKey));
    row.players.set(t('browser.players', { count: e.humans, max: e.maxHumans }));
    row.status.set(t(status.key, status.vars));
    row.statusGlyph.dataset['glyph'] = status.glyph;
    row.flags.set('is-full', full);
    row.flags.set('is-playing', e.status === 'playing' || e.status === 'results');
    const aria = t('browser.row.aria', {
      name: e.name,
      map: t(mapKey),
      count: e.humans,
      max: e.maxHumans,
      status: `${t(status.key, status.vars)}${full ? `, ${t('browser.full')}` : ''}`,
    });
    if (row.button.getAttribute('aria-label') !== aria) row.button.setAttribute('aria-label', aria);
    const dis = full ? 'true' : 'false';
    if (row.button.getAttribute('aria-disabled') !== dis) row.button.setAttribute('aria-disabled', dis);
  }

  /** Roving tabindex: one row is in the Tab order (the focused one, else the first). */
  private syncTabStops(): void {
    const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('.ui-roomrow')];
    const active = buttons.findIndex((b) => b === document.activeElement);
    buttons.forEach((b, i) => {
      b.tabIndex = i === (active >= 0 ? active : 0) ? 0 : -1;
    });
  }

  private onListKey(ev: KeyboardEvent): void {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Home' && ev.key !== 'End') return;
    const buttons = [...this.list.querySelectorAll<HTMLButtonElement>('.ui-roomrow')];
    const i = buttons.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    const next =
      ev.key === 'Home' ? 0 : ev.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
    buttons[next]?.focus();
  }
}

// ---------------------------------------------------------------------------------------------
// Create / room settings dialog
// ---------------------------------------------------------------------------------------------
export interface DialogInit {
  mode: 'create' | 'edit';
  /** The name field's starting text (the rendered default for a new room). */
  name: string;
  /** "{name}'s room" as rendered for this player: leaving it untouched sends name null. */
  renderedDefault: string;
  isPublic: boolean;
  mapMode: RoomMapMode;
  maxHumans: number;
  fillBots: boolean;
  limits: RoomLimitsView;
  /** Editing: the slider cannot go below the current member count. */
  members: number;
}

export class RoomDialog {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly panel: HTMLElement;
  private readonly title: TextSlot;
  private readonly nameInput: HTMLInputElement;
  private readonly nameError: HTMLParagraphElement;
  private readonly visPublic: HTMLInputElement;
  private readonly visPrivate: HTMLInputElement;
  private readonly mapSeg: HTMLDivElement;
  private readonly mapPinned: Shown;
  private readonly maxRange: HTMLInputElement;
  private readonly maxOut: HTMLOutputElement;
  private readonly bots: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly submitLabel: TextSlot;
  private readonly submitFlags: Flags;
  private readonly formError: HTMLParagraphElement;
  private readonly formErrorText: TextSlot;
  private mapInputs = new Map<RoomMapMode, HTMLInputElement>();
  private init: DialogInit | null = null;
  private returnFocus: HTMLElement | null = null;
  private readonly onKey: (ev: KeyboardEvent) => void;

  constructor(private readonly onSubmit: (mode: 'create' | 'edit', settings: RoomSettingsInput, patch: Partial<RoomSettingsInput>) => void) {
    const titleEl = h('h2', 'ui-heading', { id: 'ui-roomdlg-title' });
    this.title = new TextSlot(titleEl);
    this.nameInput = h('input', 'ui-input', {
      id: 'ui-roomdlg-name',
      type: 'text',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': 'ui-roomdlg-name-error',
    });
    this.nameError = h(
      'p',
      'ui-error',
      { id: 'ui-roomdlg-name-error', role: 'alert' },
      glyph('warn'),
      h('span', null, null, t('room.create.nameInvalid')),
    );
    this.nameError.hidden = true;
    this.nameInput.addEventListener('input', () => {
      if (!this.nameError.hidden) {
        this.nameError.hidden = true;
        this.nameInput.removeAttribute('aria-invalid');
      }
    });

    const seg = (name: string, value: string, label: string, glyphEl: HTMLElement | null): { opt: HTMLLabelElement; input: HTMLInputElement } => {
      const input = h('input', 'ui-seg__input', { type: 'radio', name, value, id: `${name}-${value}` });
      const opt = h(
        'label',
        'ui-seg__opt',
        { for: `${name}-${value}` },
        input,
        h('span', 'ui-seg__tick', { 'aria-hidden': 'true' }),
        glyphEl,
        h('span', 'ui-seg__text', null, label),
      );
      return { opt, input };
    };
    const pub = seg('ui-roomdlg-vis', 'public', t('room.create.public'), null);
    const priv = seg('ui-roomdlg-vis', 'private', t('room.create.private'), glyph('lock'));
    this.visPublic = pub.input;
    this.visPrivate = priv.input;
    const visRow = h(
      'fieldset',
      'ui-field ui-field--seg',
      null,
      h('legend', 'ui-label', null, t('room.create.visibility')),
      h('div', 'ui-seg ui-seg--2', null, pub.opt, priv.opt),
    );

    this.mapSeg = h('div', 'ui-seg');
    const pinned = h('p', 'ui-subnote', null, glyph('lock'), t('lobby.map.pinned'));
    this.mapPinned = new Shown(pinned);
    const mapRow = h('fieldset', 'ui-field ui-field--seg', null, h('legend', 'ui-label', null, t('room.create.map')), this.mapSeg, pinned);

    this.maxRange = h('input', 'ui-range', { id: 'ui-roomdlg-max', type: 'range', step: 1 });
    this.maxOut = h('output', 'ui-range__value ui-num', { for: 'ui-roomdlg-max' });
    this.maxRange.addEventListener('input', () => {
      this.maxOut.value = this.maxRange.value;
    });
    const maxRow = h('div', 'ui-field', null, h('label', 'ui-label', { for: 'ui-roomdlg-max' }, t('room.create.maxHumans')), this.maxRange, this.maxOut);

    this.bots = h('input', 'ui-check', { id: 'ui-roomdlg-bots', type: 'checkbox' });
    const botsRow = h('div', 'ui-field ui-field--check', null, this.bots, h('label', 'ui-label', { for: 'ui-roomdlg-bots' }, t('room.create.bots')));

    const formErrText = h('span', null);
    this.formError = h('p', 'ui-error', { role: 'alert' }, glyph('warn'), formErrText);
    this.formErrorText = new TextSlot(formErrText);
    this.formError.hidden = true;

    this.submit = h('button', 'ui-btn ui-btn--primary', { type: 'submit' });
    const spin = h('span', 'ui-btn__spin', { 'aria-hidden': 'true' });
    const submitText = h('span', null);
    this.submit.append(spin, submitText);
    this.submitLabel = new TextSlot(submitText);
    this.submitFlags = new Flags(this.submit);
    const cancel = btn(t('room.create.cancel'), 'ghost', () => this.close());

    const form = h(
      'form',
      'ui-roomdlg__form',
      { novalidate: true },
      h('label', 'ui-label', { for: 'ui-roomdlg-name' }, t('room.create.name')),
      this.nameInput,
      this.nameError,
      visRow,
      mapRow,
      maxRow,
      botsRow,
      this.formError,
      h('div', 'ui-row ui-row--end ui-roomdlg__actions', null, cancel, this.submit),
    );
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this.doSubmit();
    });
    this.panel = h(
      'div',
      'ui-panel ui-panel--menu ui-panel--roomdlg',
      { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ui-roomdlg-title' },
      titleEl,
      form,
    );
    this.el = h('section', 'ui-screen ui-screen--roomdlg ui-interactive', null, this.panel);
    this.el.addEventListener('click', (ev) => {
      if (ev.target === this.el) this.close();
    });
    this.onKey = (ev) => {
      if (!this.isOpen) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this.close();
      } else if (ev.key === 'Tab') {
        this.trapTab(ev);
      }
    };
    window.addEventListener('keydown', this.onKey);
    this.shown = new Shown(this.el);
    this.shown.set(false);
  }

  get isOpen(): boolean {
    return this.shown.visible;
  }

  get mode(): 'create' | 'edit' | null {
    return this.isOpen ? (this.init?.mode ?? null) : null;
  }

  open(init: DialogInit): void {
    this.init = init;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.title.set(t(init.mode === 'create' ? 'room.create.title' : 'room.settings.title'));
    this.submitLabel.set(t(init.mode === 'create' ? 'room.create.submit' : 'room.settings.save'));
    this.nameInput.maxLength = Math.max(1, init.limits.roomNameMax);
    this.nameInput.value = init.name;
    this.nameError.hidden = true;
    this.nameInput.removeAttribute('aria-invalid');
    this.formError.hidden = true;
    this.visPublic.checked = init.isPublic;
    this.visPrivate.checked = !init.isPublic;
    // Map options: the server's maps in its order, then Vote.
    const modes: RoomMapMode[] = [...init.limits.maps, 'vote'];
    this.mapInputs = new Map();
    const pinned = init.limits.pinnedMapId !== null;
    const opts = modes.map((m) => {
      const input = h('input', 'ui-seg__input', { type: 'radio', name: 'ui-roomdlg-map', value: m, id: `ui-roomdlg-map-${m}`, disabled: pinned });
      input.checked = m === init.mapMode;
      this.mapInputs.set(m, input);
      return h(
        'label',
        `ui-seg__opt${pinned ? ' is-disabled' : ''}`,
        { for: `ui-roomdlg-map-${m}` },
        input,
        h('span', 'ui-seg__tick', { 'aria-hidden': 'true' }),
        mapGlyphEl(m),
        h('span', 'ui-seg__text', null, t(mapModeKey(m))),
      );
    });
    this.mapSeg.replaceChildren(...opts);
    this.mapSeg.style.setProperty('--n', String(modes.length));
    this.mapPinned.set(pinned);
    const range = maxHumansRange(init.limits, init.mode === 'edit' ? init.members : 0);
    this.maxRange.min = String(range.min);
    this.maxRange.max = String(range.max);
    this.maxRange.value = String(Math.min(range.max, Math.max(range.min, init.maxHumans)));
    this.maxOut.value = this.maxRange.value;
    this.bots.checked = init.fillBots;
    this.setPending(false);
    this.shown.set(true);
    requestAnimationFrame(() => {
      this.nameInput.focus({ preventScroll: true });
      this.nameInput.select();
    });
  }

  close(): void {
    if (!this.shown.set(false)) return;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  setPending(on: boolean): void {
    this.submitFlags.set('is-pending', on);
    this.submit.disabled = on;
  }

  showError(key: string): void {
    this.formErrorText.set(t(key));
    this.formError.hidden = false;
    this.setPending(false);
  }

  private values(): RoomSettingsInput | null {
    const init = this.init;
    if (!init) return null;
    const name = roomNameToSend(this.nameInput.value, init.renderedDefault, init.limits.roomNameMax);
    if (name === undefined) {
      this.nameError.hidden = false;
      this.nameInput.setAttribute('aria-invalid', 'true');
      retrigger(this.nameInput, 'is-shake');
      this.nameInput.focus({ preventScroll: true });
      return null;
    }
    let mapMode: RoomMapMode = init.mapMode;
    for (const [m, input] of this.mapInputs) if (input.checked) mapMode = m;
    return {
      name,
      visibility: this.visPrivate.checked ? 'private' : 'public',
      mapMode,
      maxHumans: Number(this.maxRange.value),
      fillBots: this.bots.checked,
    };
  }

  private doSubmit(): void {
    const init = this.init;
    const v = this.values();
    if (!init || !v) return;
    const patch: Partial<RoomSettingsInput> = {};
    if (init.mode === 'edit') {
      const initialName = roomNameToSend(init.name, init.renderedDefault, init.limits.roomNameMax);
      if (v.name !== initialName) patch.name = v.name;
      if ((v.visibility === 'public') !== init.isPublic) patch.visibility = v.visibility;
      if (v.mapMode !== init.mapMode) patch.mapMode = v.mapMode;
      if (v.maxHumans !== init.maxHumans) patch.maxHumans = v.maxHumans;
      if (v.fillBots !== init.fillBots) patch.fillBots = v.fillBots;
      if (Object.keys(patch).length === 0) {
        this.close();
        return;
      }
    }
    this.formError.hidden = true;
    this.setPending(true);
    this.onSubmit(init.mode, v, patch);
  }

  private trapTab(ev: KeyboardEvent): void {
    const focusables = [...this.panel.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])')].filter(
      (el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
    );
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (!first || !last) return;
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
  }
}

// ---------------------------------------------------------------------------------------------
// Waiting room
// ---------------------------------------------------------------------------------------------
export interface WaitingRoomCallbacks {
  leave(): void;
  openRoomSettings(): void;
  openSettings(): void;
  start(): void;
  cancel(): void;
  setReady(ready: boolean): void;
  vote(option: MapVoteOption): void;
  kick(id: MemberId): void;
}

const COPIED_MS = 1500;
const MAX_BOT_PIPS = 24;

export class WaitingRoom {
  readonly el: HTMLElement;
  private readonly shown: Shown;
  private readonly flags: Flags;
  // header + code
  private readonly name: TextSlot;
  private readonly visTag: TextSlot;
  private readonly visFlags: Flags;
  private readonly code: TextSlot;
  private readonly codeEl: HTMLElement;
  private readonly copyBtn: HTMLButtonElement;
  private readonly copyLabel: TextSlot;
  private readonly linkBtn: HTMLButtonElement;
  private readonly copyLive: TextSlot;
  private copiedUntil = 0;
  private copiedWhich: 'code' | 'link' | null = null;
  // members
  private readonly counts: TextSlot;
  private readonly list: HTMLUListElement;
  private membersKey = '';
  private readonly kickButtons = new Map<MemberId, ConfirmButton>();
  private readonly bots: HTMLDivElement;
  private readonly botsNote: Shown;
  private botsKey = -1;
  // status + actions
  private readonly status: TextSlot;
  private readonly statusShown: Shown;
  private readonly statusFlags: Flags;
  private readonly big: HTMLDivElement;
  private readonly bigText: TextSlot;
  private lastBig = '';
  private readonly countdownLive: TextSlot;
  private readonly hostRow: Shown;
  private readonly startBtn: HTMLButtonElement;
  private readonly startNote: TextSlot;
  private readonly startNoteShown: Shown;
  private readonly settingsBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly cancelShown: Shown;
  private readonly guestRow: Shown;
  private readonly readyBtn: HTMLButtonElement;
  private readonly readyLabel: TextSlot;
  private readonly readyShown: Shown;
  private readonly waitingHost: Shown;
  private readonly leave: ConfirmButton;
  private countdownActive = false;
  // map panel
  private readonly votePanel: Shown;
  private readonly voteButtons: HTMLDivElement;
  private voteKey = '';
  private readonly voteNote: TextSlot;
  private readonly votePinned: Shown;
  private readonly card: Shown;
  private readonly cardFlags: Flags;
  private readonly cardTitle: TextSlot;
  private readonly cardTagline: TextSlot;
  private readonly cardGlyph: HTMLSpanElement;
  private readonly minimap: Minimap;
  private readonly minimapShown: Shown;
  private readonly routeLegend: Shown;
  private readonly carrierText: TextSlot;
  private readonly loading: Shown;
  private room: RoomView | null = null;

  constructor(
    private readonly cb: WaitingRoomCallbacks,
    coastline: CoastlineFn | null,
    controls: HTMLElement,
  ) {
    // Header
    const nameEl = h('h2', 'ui-heading ui-room__name', { id: 'ui-room-title' });
    const visEl = h('span', 'ui-tag ui-room__vis');
    this.name = new TextSlot(nameEl);
    this.visTag = new TextSlot(visEl);
    this.visFlags = new Flags(visEl);

    // Code
    this.codeEl = h('span', 'ui-room__code ui-num', { 'aria-describedby': 'ui-room-code-label' });
    this.code = new TextSlot(this.codeEl);
    this.copyBtn = btn('', 'secondary', () => void this.copy('code'), 'ui-btn--small');
    const copyText = h('span', null);
    this.copyBtn.replaceChildren(glyph('copy'), copyText);
    this.copyLabel = new TextSlot(copyText);
    this.linkBtn = btn(t('room.link.copy'), 'ghost', () => void this.copy('link'), 'ui-btn--small');
    this.linkBtn.prepend(glyph('link'));
    const copyLive = h('span', 'ui-room__copied', { role: 'status' });
    this.copyLive = new TextSlot(copyLive);
    const codeBlock = h(
      'div',
      'ui-room__codeblock',
      null,
      h('span', 'ui-label', { id: 'ui-room-code-label' }, t('room.code.label')),
      h('div', 'ui-room__coderow', null, this.codeEl, this.copyBtn, this.linkBtn),
      copyLive,
    );

    // Members
    const countsEl = h('p', 'ui-room__counts');
    this.counts = new TextSlot(countsEl);
    this.list = h('ul', 'ui-members', { 'aria-labelledby': 'ui-room-title' });
    this.bots = h('div', 'ui-seats ui-room__bots', { 'aria-hidden': 'true' });
    const botsNote = h('p', 'ui-lobby__bots', null, h('span', 'ui-seat ui-seat--bot', { 'aria-hidden': 'true' }), t('lobby.botsFill'));
    this.botsNote = new Shown(botsNote);

    // Status + countdown
    const statusEl = h('p', 'ui-room__status', { role: 'status' });
    this.status = new TextSlot(statusEl);
    this.statusShown = new Shown(statusEl);
    this.statusFlags = new Flags(statusEl);
    this.big = h('div', 'ui-lobby__big ui-num', { 'aria-hidden': 'true' });
    this.bigText = new TextSlot(this.big);
    const cdLive = h('span', 'ui-sr', { 'aria-live': 'polite' });
    this.countdownLive = new TextSlot(cdLive);

    // Host controls
    this.settingsBtn = btn(t('room.settings.title'), 'ghost', () => cb.openRoomSettings());
    this.settingsBtn.prepend(glyph('gear'));
    this.startBtn = btn(t('room.start'), 'primary', () => cb.start());
    this.startBtn.prepend(glyph('play'));
    const startNote = h('span', 'ui-subnote', { id: 'ui-room-start-note' });
    this.startNote = new TextSlot(startNote);
    this.startNoteShown = new Shown(startNote);
    this.cancelBtn = btn(hasCancelKey() ? t('room.cancel') : t('room.create.cancel'), 'secondary', () => cb.cancel());
    this.cancelShown = new Shown(this.cancelBtn);
    const hostRow = h('div', 'ui-room__actions', null, this.settingsBtn, h('div', 'ui-room__start', null, this.startBtn, startNote), this.cancelBtn);
    this.hostRow = new Shown(hostRow);

    // Guest controls
    const waitingHost = h('p', 'ui-room__waithost', null, glyph('hourglass'), t('room.waitingHost'));
    this.waitingHost = new Shown(waitingHost);
    this.readyBtn = btn('', 'primary', () => cb.setReady(!(this.room?.localReady ?? false)));
    const readyText = h('span', null);
    this.readyBtn.replaceChildren(h('span', 'ui-ready__box', { 'aria-hidden': 'true' }), readyText);
    this.readyLabel = new TextSlot(readyText);
    this.readyShown = new Shown(this.readyBtn);
    const guestRow = h('div', 'ui-room__actions', null, waitingHost, this.readyBtn);
    this.guestRow = new Shown(guestRow);

    this.leave = new ConfirmButton(
      'room.leave',
      'room.leave.confirm',
      'ui-btn--ghost',
      () => cb.leave(),
      () => this.countdownActive,
    );
    this.leave.el.prepend(glyph('back'));
    const settings = btn(t('menu.settings.open'), 'ghost', (ev) => {
      ev.stopPropagation();
      cb.openSettings();
    });
    settings.prepend(glyph('gear'));

    const left = h(
      'div',
      'ui-panel ui-panel--menu ui-panel--room ui-interactive',
      null,
      h('div', 'ui-room__head', null, nameEl, visEl),
      codeBlock,
      countsEl,
      this.list,
      this.bots,
      botsNote,
      this.big,
      statusEl,
      cdLive,
      hostRow,
      guestRow,
      controls,
      h('div', 'ui-row ui-room__foot', null, this.leave.el, settings),
    );

    // Map panel: vote
    this.voteButtons = h('div', 'ui-vote__options', { role: 'group', 'aria-labelledby': 'ui-vote-title' });
    const voteNote = h('p', 'ui-subtle ui-vote__note');
    this.voteNote = new TextSlot(voteNote);
    const votePinned = h('p', 'ui-subnote', null, glyph('lock'), t('lobby.map.pinned'));
    this.votePinned = new Shown(votePinned);
    const votePanel = h(
      'div',
      'ui-panel ui-panel--menu ui-panel--vote ui-interactive',
      null,
      h('h3', 'ui-heading ui-heading--small', { id: 'ui-vote-title' }, t('lobby.vote.title')),
      this.voteButtons,
      voteNote,
      votePinned,
    );
    this.votePanel = new Shown(votePanel);

    // Map panel: card
    const cardTitle = h('h3', 'ui-heading ui-heading--small ui-mapcard__title');
    const cardTagline = h('p', 'ui-subtle ui-mapcard__tagline');
    this.cardGlyph = h('span', 'ui-mapglyph ui-mapcard__glyph', { 'aria-hidden': 'true' });
    this.minimap = new Minimap(coastline, 'ui-minimap--card');
    this.minimapShown = new Shown(this.minimap.el);
    const carrierText = h('span', null);
    const legend = h(
      'p',
      'ui-mapcard__legend',
      null,
      h('span', 'ui-legend__route', { 'aria-hidden': 'true' }),
      h('span', null, null, t('hud.minimap.route')),
      h('span', 'ui-legend__sep', { 'aria-hidden': 'true' }, '·'),
      h('span', 'ui-legend__plane', { 'aria-hidden': 'true' }),
      carrierText,
    );
    this.carrierText = new TextSlot(carrierText);
    this.routeLegend = new Shown(legend);
    const loading = h('p', 'ui-chip ui-mapcard__loading', { role: 'status' }, h('span', 'ui-spinner ui-spinner--small', { 'aria-hidden': 'true' }), t('lobby.map.loading'));
    this.loading = new Shown(loading);
    const card = h(
      'div',
      'ui-panel ui-panel--menu ui-panel--mapcard',
      null,
      h('div', 'ui-mapcard__head', null, this.cardGlyph, cardTitle),
      cardTagline,
      this.minimap.el,
      legend,
      loading,
    );
    this.card = new Shown(card);
    this.cardFlags = new Flags(card);
    this.cardTitle = new TextSlot(cardTitle);
    this.cardTagline = new TextSlot(cardTagline);

    this.el = h(
      'section',
      'ui-screen ui-screen--room',
      { 'aria-labelledby': 'ui-room-title' },
      left,
      h('div', 'ui-room__side', null, votePanel, card),
    );
    this.shown = new Shown(this.el);
    this.flags = new Flags(this.el);
    this.shown.set(false);
  }

  show(on: boolean): void {
    if (this.shown.set(on)) {
      if (on) {
        this.minimap.invalidate();
        requestAnimationFrame(() => this.focusPrimary());
      }
    }
  }

  get visible(): boolean {
    return this.shown.visible;
  }

  /** Start for the host, Ready for everyone else (UI.md §12.6). */
  focusPrimary(): void {
    const target = this.room?.isLocalHost ? this.startBtn : this.readyBtn;
    if (target.offsetParent !== null && !target.disabled) target.focus({ preventScroll: true });
    else this.leave.el.focus({ preventScroll: true });
  }

  update(hud: HudView, room: RoomView, limits: RoomLimitsView | null, resultsDismissed: boolean, nowMs: number): void {
    this.room = room;
    const countdown = room.phase === 'countdown';
    const busy = room.phase === 'playing' || room.phase === 'results';
    this.countdownActive = countdown;
    this.flags.set('is-countdown', countdown);
    this.flags.set('is-busy', busy);

    // Header + code
    this.name.set(room.name);
    const isPublic = room.settings.visibility === 'public';
    this.visTag.set(t(isPublic ? 'room.public' : 'room.private'));
    this.visFlags.set('is-private', !isPublic);
    this.code.set(room.code);
    const copied = nowMs < this.copiedUntil;
    this.copyLabel.set(t(copied && this.copiedWhich === 'code' ? 'room.code.copied' : 'room.code.copy'));
    this.copyBtn.classList.toggle('is-done', copied && this.copiedWhich === 'code');
    this.linkBtn.classList.toggle('is-done', copied && this.copiedWhich === 'link');

    // Members
    const sum = readySummary(room.members);
    this.counts.set(
      `${t('room.players', { count: room.members.length, max: room.settings.maxHumans })} · ${t('room.readyCount', sum)}`,
    );
    this.syncMembers(room, busy);
    const seats = Math.min(MAX_BOT_PIPS, Math.max(0, room.botSeats));
    if (seats !== this.botsKey) {
      this.botsKey = seats;
      this.bots.replaceChildren(...Array.from({ length: seats }, () => h('span', 'ui-seat ui-seat--bot')));
    }
    this.botsNote.set(room.settings.fillBots && room.botSeats > 0);

    // Countdown bubble + status line
    let big = '';
    let statusKey: string | null = null;
    let statusVars: StringVars = {};
    if (countdown && room.countdownSecondsLeft !== null) {
      const secs = Math.max(0, room.countdownSecondsLeft);
      big = String(secs);
      statusKey = secs > 0 ? 'lobby.countdown' : 'announcer.matchStart';
      statusVars = { seconds: secs };
      if (COUNTDOWN_ANNOUNCE.includes(secs)) this.countdownLive.set(t('lobby.countdown', { seconds: secs }));
    } else if (room.phase === 'results' && resultsDismissed && hud.resultsSecondsLeft !== null) {
      statusKey = 'results.nextMatch';
      statusVars = { seconds: hud.resultsSecondsLeft };
    } else if (busy) {
      statusKey = 'lobby.matchInProgress';
    } else if (room.autoStart) {
      statusKey = room.autoStart.reason === 'allReady' ? 'room.autoStart.allReady' : 'room.autoStart.timer';
      statusVars = { seconds: Math.max(0, room.autoStart.secondsLeft) };
    }
    this.statusShown.set(statusKey !== null);
    if (statusKey) this.status.set(t(statusKey, statusVars));
    this.statusFlags.set('is-countdown', countdown);
    this.bigText.set(big);
    this.big.hidden = big === '';
    if (big !== this.lastBig) {
      this.lastBig = big;
      if (big) retrigger(this.big, 'is-pop');
    }

    // Host / guest controls
    const start = startButtonState(room);
    const host = room.isLocalHost;
    this.hostRow.set(host && (room.phase === 'waiting' || (countdown && room.canCancel)));
    this.settingsBtn.hidden = room.phase !== 'waiting';
    this.startBtn.parentElement!.hidden = !start.show;
    this.startBtn.disabled = !start.enabled || room.phase !== 'waiting';
    this.startBtn.classList.toggle('is-pending', false);
    this.startNoteShown.set(start.reasonKey !== null);
    if (start.reasonKey) {
      this.startNote.set(t(start.reasonKey));
      this.startBtn.setAttribute('aria-describedby', 'ui-room-start-note');
    } else this.startBtn.removeAttribute('aria-describedby');
    this.cancelShown.set(countdown && room.canCancel);
    this.guestRow.set(!host && room.phase === 'waiting');
    this.waitingHost.set(!host);
    this.readyShown.set(!host && room.phase === 'waiting');
    this.readyLabel.set(t(room.localReady ? 'room.unready' : 'room.readyToggle'));
    const pressed = room.localReady ? 'true' : 'false';
    if (this.readyBtn.getAttribute('aria-pressed') !== pressed) this.readyBtn.setAttribute('aria-pressed', pressed);
    this.readyBtn.classList.toggle('is-on', room.localReady);
    this.leave.sync(nowMs);
    for (const k of this.kickButtons.values()) k.sync(nowMs);

    // Map panel
    this.updateMapPanel(hud, room, limits, nowMs);
  }

  private syncMembers(room: RoomView, busy: boolean): void {
    const canKick = room.isLocalHost && room.phase === 'waiting';
    const key = JSON.stringify([canKick, busy, room.members.map((m) => [m.id, m.name, m.isHost, m.isLocal, m.ready, m.inMatch, m.spectating])]);
    if (key === this.membersKey) return;
    this.membersKey = key;
    const keep = new Set<MemberId>();
    const rows = room.members.map((m) => this.memberRow(m, busy, canKick, keep));
    for (const id of [...this.kickButtons.keys()]) if (!keep.has(id)) this.kickButtons.delete(id);
    const focused = document.activeElement;
    this.list.replaceChildren(...rows);
    if (focused instanceof HTMLElement && !focused.isConnected) this.leave.el.focus({ preventScroll: true });
  }

  private memberRow(m: RoomMemberView, busy: boolean, canKick: boolean, keep: Set<MemberId>): HTMLLIElement {
    const st = memberStatus(m, busy);
    const statusLabel =
      st === 'host' ? t('room.host') : st === 'ready' ? t('room.ready') : st === 'notReady' ? t('room.notReady') : st === 'watching' ? t('room.watching') : t('room.ready');
    const chip =
      st === 'host'
        ? null
        : h('span', `ui-member__status is-${st}`, null, h('span', 'ui-member__mark', { 'aria-hidden': 'true' }), statusLabel);
    let kick: HTMLButtonElement | null = null;
    if (canKick && !m.isHost && !m.isLocal) {
      let k = this.kickButtons.get(m.id);
      if (!k) {
        k = new ConfirmButton('room.kick', 'room.kick.confirm', 'ui-btn--ghost ui-btn--small ui-member__kick', () => this.cb.kick(m.id), () => true, t('room.kick.aria', { name: m.name }));
        this.kickButtons.set(m.id, k);
      }
      keep.add(m.id);
      kick = k.el;
    }
    return h(
      'li',
      `ui-member${m.isLocal ? ' is-me' : ''}${m.isHost ? ' is-host' : ''}`,
      null,
      h('span', 'ui-member__crown', { 'aria-hidden': 'true' }),
      m.isHost ? h('span', 'ui-sr', null, `${t('room.host')}: `) : null,
      h('span', 'ui-member__name', null, m.name),
      m.isLocal ? h('span', 'ui-member__you', null, t('room.you')) : null,
      m.isHost ? h('span', 'ui-tag ui-member__hosttag', { 'aria-hidden': 'true' }, t('room.host')) : null,
      chip,
      kick,
    );
  }

  private updateMapPanel(hud: HudView, room: RoomView, limits: RoomLimitsView | null, nowMs: number): void {
    const vote = showVotePanel(room) ? room.vote : null;
    this.votePanel.set(vote !== null);
    if (vote) {
      const pinned = vote.pinned || (limits?.pinnedMapId ?? null) !== null;
      const disabled = pinned || room.phase === 'playing' || room.phase === 'results';
      const key = JSON.stringify([vote.options, vote.mine, disabled]);
      if (key !== this.voteKey) {
        this.voteKey = key;
        this.voteButtons.replaceChildren(
          ...vote.options.map((o) => {
            const mine = vote.mine === o.option;
            const b = h(
              'button',
              `ui-vote__btn${mine ? ' is-mine' : ''}`,
              { type: 'button', 'aria-pressed': mine ? 'true' : 'false', disabled },
              mapGlyphEl(o.option),
              h('span', 'ui-vote__name', null, t(voteOptionKey(o.option))),
              h('span', 'ui-vote__count ui-num', null, t('lobby.vote.count', { count: o.count })),
              h('span', 'ui-vote__yours', null, h('span', 'ui-seg__tick', { 'aria-hidden': 'true' }), t('lobby.vote.yours')),
            );
            b.addEventListener('click', () => {
              if (!mine) this.cb.vote(o.option);
            });
            return b;
          }),
        );
      }
      const total = vote.options.reduce((a, o) => a + o.count, 0);
      this.voteNote.set(total === 0 ? t('lobby.vote.rotate') : '');
      this.votePinned.set(pinned);
    }

    const fixed: MapId | null = room.settings.mapMode !== 'vote' ? room.settings.mapMode : (limits?.pinnedMapId ?? null);
    const title = mapCardTitle(room.map, fixed);
    this.card.set(title !== null && vote === null);
    this.cardFlags.set('is-big', room.phase === 'countdown');
    if (!title || vote !== null) return;
    const id = title.mapId;
    this.cardTitle.set(t(title.key, { name: t(mapNameKey(id)) }));
    this.cardTagline.set(t(`map.${id}.tagline`));
    this.cardGlyph.dataset['glyph'] = mapGlyph(id);
    // The minimap needs the map's data, which the client has only once it is the active map (HudMinimapView.map).
    const haveMap = hud.minimap.map.id === id;
    this.minimapShown.set(haveMap);
    if (haveMap) this.minimap.update({ map: hud.minimap.map, self: null, route: hud.minimap.route ?? null }, null, nowMs, { preFlight: true });
    const route = haveMap ? (hud.minimap.route ?? null) : null;
    this.routeLegend.set(route !== null);
    if (route) this.carrierText.set(`${t(`map.${id}.carrier`)} · ${t(`map.${id}.carrier.type`)}`);
    this.loading.set(room.mapLoading);
  }

  private async copy(which: 'code' | 'link'): Promise<void> {
    const room = this.room;
    if (!room) return;
    const text = which === 'code' ? room.code : inviteLink(location.origin, location.pathname, room.code);
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (ok) {
      this.copiedWhich = which;
      this.copiedUntil = performance.now() + COPIED_MS;
      this.copyLive.set('');
      this.copyLive.set(t('room.code.copied'));
    } else {
      // No clipboard permission: select the code so the player can copy it by hand.
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(this.codeEl);
      sel?.removeAllRanges();
      sel?.addRange(range);
      this.copyLive.set(t('room.code.copyFailed'));
    }
  }

  dispose(): void {
    this.minimap.dispose();
  }
}

/** `room.cancel` ("Cancel start") is not in en.json yet; the dialog's "Cancel" is the fallback. */
function hasCancelKey(): boolean {
  return hasKey('room.cancel');
}
