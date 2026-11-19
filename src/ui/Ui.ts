/**
 * DOM UI root. Implements IUi (src/shared/contracts.ts).
 *
 * - Reads continuous state from HudView every frame (diffed writes only).
 * - Reads discrete moments from the bus (never emits).
 * - Sends intents back only through UiCallbacks. Never requests pointer lock itself.
 * - Persists Settings (SETTINGS_STORAGE_KEY) and UI-only prefs (scale, reduced motion, head bob), plus the last name.
 * - M2b: the room browser, create dialog and waiting room (HudView.rooms; intents through UiCallbacks.on*Room*), the
 *   `?room=` / `?map=` deep links and the `?room=` URL sync, the drop HUD and flight announcer, zone strings by theme,
 *   first-person settings (Settings.fovDeg plus the EFFECTIVE headBob / reducedMotion).
 * - M2c (docs/ui/M2c.md): levels in the feed, prompt and toasts; hit markers hidden through smoke (kills still show);
 *   rocket / melee feed routing; the throwable cycle and scope events; the M2c one-time hints; sight-chip taps.
 *
 * Owner: ui-ux-designer. Design spec: docs/ui/UI.md.
 */
import './ui.css';
import { coastlineRadius } from '../shared/sim/terrain';
import type {
  GraphicsStatus,
  HudDropView,
  HudView,
  IUi,
  RoomLimitsView,
  RoomSettingsInput,
  Settings,
  UiCallbacks,
  UiSoundId,
} from '../shared/contracts';
import type { ZoneTheme } from '../shared/balance';
import type { EventBus, GameEvents } from '../shared/events';
import { isMeleeId, type ItemLevel, type M2cHeldId, type M2cItemId, type MapId, type MatchPhase, type PlayerId } from '../shared/types';
import { ScopeOverlay } from './ads';
import { h } from './dom';
import { KillFeed, MessageSlot, type Message } from './feed';
import { Hud } from './hud';
import {
  actionFailedKey,
  aliveAnnouncement,
  connectionErrorKey,
  flightCue,
  graphicsStatusView,
  hitMarkerVisible,
  hitVariant,
  isBlastCause,
  isSelfBlastKill,
  itemCategory,
  pouchModel,
  roomInResults,
  selectScreen,
  zoneKey,
  type ScreenId,
} from './logic';
import { MenuToasts, RoomBrowser, RoomDialog, WaitingRoom } from './rooms';
import {
  createFailedKey,
  deepLinkVote,
  joinFailedKey,
  mapNameKey,
  MemberToastThrottle,
  parseDeepLink,
  withRoomParam,
  type DeepLink,
} from './roomLogic';
import {
  controlsList,
  ConnectScreen,
  DeathCard,
  GraphicsOverlay,
  LobbyScreen,
  PlayOverlay,
  ResultsScreen,
  SettingsPanel,
  TitleScreen,
} from './screens';
import {
  effectiveSettings,
  getStorage,
  HINTS_STORAGE_KEY,
  loadSettings,
  loadUiPrefs,
  NAME_STORAGE_KEY,
  normalizeSettings,
  normalizeUiPrefs,
  parseHintSet,
  readItem,
  saveSettings,
  saveUiPrefs,
  settingsEqual,
  writeItem,
  type UiPrefs,
} from './settings';
import { hasKey, t } from '../content/strings';

const BANNER_MS = 2600;
/** UI sound throttles: hover sweeps across a row of buttons and slider drags fire many events. */
const HOVER_SOUND_GAP_MS = 45;
const SLIDER_SOUND_GAP_MS = 70;
/** Elements that make a click / hover sound. Labels are excluded: a label click re-dispatches to its input. */
const CLICKABLE = 'button, input[type="checkbox"], input[type="radio"]';
const HOVERABLE = 'button, .ui-seg__opt, .ui-field--check, input[type="range"]';
const HINT_MS = 5000;

type HintId =
  | 'hint.drop'
  | 'hint.loot'
  | 'hint.reload'
  | 'hint.heal'
  | 'hint.tide'
  | 'hint.switch'
  // M2a
  | 'hint.ads'
  | 'hint.crouch'
  | 'hint.prone'
  | 'hint.grenade'
  // M2b
  | 'hint.lightsOut'
  | 'hint.sprinklers'
  | 'hint.spectateView'
  // M2c (narrative M2c §6, §8)
  | 'hint.level'
  | 'hint.melee'
  | 'hint.smoke'
  | 'hint.throwableCycle'
  | 'hint.rocket'
  | 'hint.scope';

export class Ui implements IUi {
  private readonly el: HTMLDivElement;
  private readonly storage = getStorage();
  /** Stored settings with the effective headBob / reducedMotion folded in (what ClientGame gets). */
  private settings: Settings;
  private prefs: UiPrefs;
  private readonly unsubs: (() => void)[] = [];
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotionChange = (): void => {
    this.applyPrefs();
    this.settingsPanel.refreshMotion();
  };
  private readonly onResize = (): void => {
    this.viewportW = window.innerWidth;
    this.viewportH = window.innerHeight;
  };
  private viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280;
  private viewportH = typeof window !== 'undefined' ? window.innerHeight : 720;

  // Screens
  private readonly title: TitleScreen;
  private readonly connect: ConnectScreen;
  private readonly lobby: LobbyScreen;
  private readonly hud: Hud;
  private readonly scope: ScopeOverlay;
  private readonly play: PlayOverlay;
  private readonly death: DeathCard;
  private readonly results: ResultsScreen;
  private readonly settingsPanel: SettingsPanel;
  private readonly gfx: GraphicsOverlay;
  private readonly feed: KillFeed;
  private readonly banner: MessageSlot;
  private readonly hint: MessageSlot;
  private readonly waitingChip: HTMLDivElement;
  // M2b rooms
  private readonly browser: RoomBrowser;
  private readonly dialog: RoomDialog;
  private readonly room: WaitingRoom;
  private readonly menuToasts: MenuToasts;
  private readonly deepLink: DeepLink;
  /** A room code to join as soon as the server puts us in the browser (deep link, Rejoin). */
  private pendingCode: string | null = null;
  /** The last room we were in (Rejoin after a lost connection). */
  private lastRoomCode: string | null = null;
  /** The `?room=` value this Ui last wrote to the URL. */
  private urlRoom: string | null = null;
  private limits: RoomLimitsView | null = null;
  private readonly memberToasts = new MemberToastThrottle();
  /** The room id whose `?map=` vote was already sent. */
  private mapVoteSentFor: string | null = null;
  private deepLinkInvalidShown = false;
  private inRoom = false;
  private isHost = false;
  private lastHud: HudView | null = null;
  private currentMapId: MapId | null = null;
  private prevDrop: HudDropView | null = null;
  /** M2c: last melee-slot item (the "Fists are back" toast). */
  private prevMelee: M2cHeldId | null = null;

  // Flow state
  private joinRequested = false;
  private lastName = '';
  private wasJoined = false;
  private connReason: string | undefined;
  private resultsDismissed = false;
  private screen: ScreenId | null = null;
  private phase: MatchPhase | null = null;
  private lockedThisMatch = false;
  private deathOpen = false;
  private deathAt = 0;
  private localId: PlayerId | null = null;
  private lastMatchEnded: GameEvents['matchEnded'] | null = null;

  // Match bookkeeping
  private prevAlive: number | null = null;
  private firstBloodDone = false;
  private zonePhaseSeen = -2;
  private zoneShrinkingSeen = false;
  private readonly lastHeadshot = new Map<PlayerId, boolean>();
  /** M2a: attacker of each victim's latest explosion damage (self-grenade detection, logic.isSelfGrenadeKill). */
  private readonly lastBlastAttacker = new Map<PlayerId, PlayerId | null>();
  private readonly hintsSeen: Set<string>;
  private msgSeq = 0;
  private lastHoverSoundAt = -Infinity;
  private lastSliderSoundAt = -Infinity;

  constructor(
    root: HTMLElement,
    bus: EventBus<GameEvents>,
    private readonly callbacks: UiCallbacks,
  ) {
    this.prefs = loadUiPrefs(this.storage);
    this.motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    this.settings = effectiveSettings(loadSettings(this.storage), this.prefs, this.motionQuery?.matches === true);
    this.deepLink = parseDeepLink(typeof location !== 'undefined' ? location.search : '');
    this.lastName = readItem(this.storage, NAME_STORAGE_KEY) ?? '';
    this.hintsSeen = parseHintSet(readItem(this.storage, HINTS_STORAGE_KEY));

    const openSettings = (): void => this.settingsPanel.show(true);
    this.title = new TitleScreen(
      this.lastName,
      (name) => {
        // M2b: a valid ?room= link joins straight after the name (UI.md §12.9).
        if (this.deepLink.room) this.pendingCode = this.deepLink.room;
        this.join(name);
      },
      openSettings,
      () => {
        this.deepLink.room = null;
        this.pendingCode = null;
      },
    );
    this.title.setDeepLink(this.deepLink.room);
    this.connect = new ConnectScreen(() => {
      // Rejoin returns to the same room when it still exists (else the browser shows why).
      if (this.lastRoomCode) this.pendingCode = this.lastRoomCode;
      if (this.lastName) this.join(this.lastName);
      else this.joinRequested = false;
    });
    this.lobby = new LobbyScreen(openSettings);
    this.hud = new Hud(coastlineRadius);
    // M2c (UI M2c §16.4): sight-chip tap / click does what T does.
    this.hud.onCycleScope = () => this.callbacks.onCycleScope?.();
    this.scope = new ScopeOverlay();
    this.play = new PlayOverlay(
      () => this.callbacks.onResume(),
      openSettings,
      () => this.callbacks.onLeaveRoom?.(),
    );
    this.menuToasts = new MenuToasts();
    this.browser = new RoomBrowser({
      refresh: () => this.callbacks.onRefreshRooms?.(),
      create: () => this.openCreateDialog(),
      join: (target) => this.callbacks.onJoinRoom?.(target),
      back: () => {
        // Back to the title to change the name. There is no disconnect intent yet; Play sends onJoin again.
        this.joinRequested = false;
        this.pendingCode = null;
      },
      full: () => this.menuToasts.push('browser.error.full', {}, true, performance.now()),
    });
    this.dialog = new RoomDialog((mode, settings, patch) => this.submitRoomDialog(mode, settings, patch));
    this.room = new WaitingRoom(
      {
        leave: () => this.callbacks.onLeaveRoom?.(),
        openRoomSettings: () => this.openEditDialog(),
        openSettings,
        start: () => this.callbacks.onStartMatch?.(),
        cancel: () => this.callbacks.onCancelCountdown?.(),
        setReady: (ready) => this.callbacks.onSetReady?.(ready),
        vote: (option) => this.callbacks.onVote?.(option),
        kick: (id) => this.callbacks.onKick?.(id),
      },
      coastlineRadius,
      controlsList(true),
    );
    this.death = new DeathCard(() => {
      this.closeDeath();
      // BUG-001: start spectating now instead of waiting out match.deathScreenSeconds.
      this.callbacks.onSpectate?.();
    });
    this.results = new ResultsScreen(() => {
      this.resultsDismissed = true;
      this.callbacks.onPlayAgain();
    });
    this.settingsPanel = new SettingsPanel(
      this.settings,
      this.prefs,
      () => this.motionQuery?.matches === true,
      (s) => this.setSettings(s),
      (p) => {
        this.prefs = normalizeUiPrefs(p);
        saveUiPrefs(this.storage, this.prefs);
        this.applyPrefs();
      },
    );
    this.gfx = new GraphicsOverlay(() => location.reload());
    this.feed = new KillFeed();
    this.banner = new MessageSlot('ui-banner', BANNER_MS, 'alert');
    this.hint = new MessageSlot('ui-hint ui-chip', HINT_MS);
    this.hud.feedSlot.appendChild(this.feed.el);
    this.hud.bannerSlot.appendChild(this.banner.el);
    this.hud.hintSlot.appendChild(this.hint.el);
    this.waitingChip = h('div', 'ui-waiting ui-chip', { role: 'status' }, t('lobby.matchInProgress'));

    this.el = h(
      'div',
      'ui',
      null,
      this.scope.el,
      this.hud.el,
      this.waitingChip,
      this.lobby.el,
      this.browser.el,
      this.room.el,
      this.menuToasts.el,
      this.death.el,
      this.results.el,
      this.play.el,
      this.connect.el,
      this.title.el,
      this.dialog.el,
      this.settingsPanel.el,
      this.gfx.noteEl,
      this.gfx.el,
    );
    for (const s of [this.title, this.connect, this.lobby, this.play, this.death, this.results]) s.show(false);
    this.hud.el.hidden = true;
    this.waitingChip.hidden = true;
    root.appendChild(this.el);
    this.bindUiSounds();
    if (typeof document !== 'undefined') document.title = t('game.title');

    this.applyPrefs();
    this.motionQuery?.addEventListener('change', this.onMotionChange);
    window.addEventListener('resize', this.onResize);
    this.subscribe(bus);

    // Contract: fire once right after construction with the loaded settings.
    this.callbacks.onSettingsChanged(this.settings);
  }

  // ------------------------------------------------------------------------------------------
  // IUi
  // ------------------------------------------------------------------------------------------
  getSettings(): Settings {
    return { ...this.settings };
  }

  update(hud: HudView): void {
    const now = performance.now();
    const rooms = hud.rooms ?? null;
    const roomView = rooms?.room ?? null;
    if (hud.joined || (rooms !== null && rooms.location !== 'none')) this.wasJoined = true;
    this.localId = hud.local?.id ?? this.localId;
    if (rooms?.browser) this.limits = rooms.browser.limits;
    if (hud.zoneTheme) this.hud.zoneTheme = hud.zoneTheme;
    const inResults = rooms ? roomInResults(hud.phase, roomView?.phase ?? null) : hud.phase === 'results';
    if (!inResults) this.resultsDismissed = false;
    if (hud.pointerLocked) this.lockedThisMatch = true;
    this.inRoom = rooms?.location === 'room';
    this.isHost = roomView?.isLocalHost === true;

    const screen = selectScreen({
      joinRequested: this.joinRequested,
      connection: hud.connection,
      joined: hud.joined,
      phase: hud.phase,
      resultsDismissed: this.resultsDismissed,
      rooms: rooms
        ? { location: rooms.location, roomPhase: roomView?.phase ?? null, localSpectating: roomView?.localSpectating === true }
        : null,
      hasLocal: hud.local !== null,
      spectating: hud.spectate !== null,
    });
    this.setScreen(screen);
    this.updateRooms(hud, screen, now);

    switch (screen) {
      case 'connecting':
        this.connect.update('connecting', 'menu.connecting', false);
        break;
      case 'connectionLost':
        this.connect.update('lost', connectionErrorKey(this.connReason, this.wasJoined), this.wasJoined);
        break;
      case 'lobby':
        this.lobby.update(hud);
        break;
      case 'browser':
        if (rooms?.browser) this.browser.update(rooms.browser, rooms.pending, now);
        break;
      case 'room':
        if (roomView) this.room.update(hud, roomView, this.limits, this.resultsDismissed, now);
        break;
      case 'results':
        this.results.update(hud);
        break;
      case 'match':
        this.updateMatch(hud, now);
        break;
      case 'title':
        break;
    }

    const showPlay = this.shouldShowPlayOverlay(screen, hud);
    this.play.show(showPlay);
    if (showPlay) this.play.update(!this.lockedThisMatch, this.inRoom, hud);
    this.menuToasts.update(now);
    this.lastHud = hud;
  }

  // ------------------------------------------------------------------------------------------
  // M2b rooms
  // ------------------------------------------------------------------------------------------
  private updateRooms(hud: HudView, screen: ScreenId, now: number): void {
    const rooms = hud.rooms ?? null;
    if (!rooms) return;
    const room = rooms.room;

    // Deep link / Rejoin: join by code as soon as the server has us in the browser.
    if (rooms.location === 'browser' && this.pendingCode) {
      const code = this.pendingCode;
      this.pendingCode = null;
      this.browser.prefillCode(code);
      this.callbacks.onJoinRoom?.({ code });
    }
    if (screen === 'browser' && this.deepLink.roomInvalid && !this.deepLinkInvalidShown) {
      this.deepLinkInvalidShown = true;
      this.browser.showError('browser.deepLink.invalid');
    }

    // ?map= pre-selects your vote once per room joined (maps.md rule 2).
    if (room?.vote && !room.vote.locked && !room.vote.pinned && room.vote.mine === null && this.mapVoteSentFor !== room.id) {
      this.mapVoteSentFor = room.id;
      const offered = room.vote.options.map((o) => o.option).filter((o) => o !== 'random');
      const option = deepLinkVote(this.deepLink.map, offered);
      if (option) this.callbacks.onVote?.(option);
    }

    // Keep ?room= in the URL while in a room, so a reload rejoins it (UI.md §12.9).
    const code = rooms.location === 'room' && room ? room.code : null;
    if (code !== this.urlRoom && (code !== null || this.urlRoom !== null)) {
      this.urlRoom = code;
      try {
        history.replaceState(history.state, '', withRoomParam(location.href, code));
      } catch {
        // Sandboxed frames may refuse; the room still works.
      }
    }

    // Dialog spinner and the folded join/leave toasts.
    if (this.dialog.mode === 'create') this.dialog.setPending(rooms.pending === 'create');
    const more = this.memberToasts.flush(now);
    if (more > 0 && screen === 'room') this.menuToasts.push('room.toast.more', { count: more }, false, now);
  }

  private renderedDefaultName(): string {
    return t(hasKey('room.create.nameDefault') ? 'room.create.nameDefault' : 'room.create.name.default', { name: this.lastName });
  }

  private openCreateDialog(): void {
    const limits = this.limits;
    if (!limits) return;
    const def = this.renderedDefaultName();
    this.dialog.open({
      mode: 'create',
      name: def,
      renderedDefault: def,
      isPublic: true,
      mapMode: limits.pinnedMapId ?? 'vote',
      maxHumans: limits.maxHumansDefault,
      fillBots: limits.fillBotsDefault,
      limits,
      members: 0,
    });
  }

  private openEditDialog(): void {
    const room = this.lastHud?.rooms?.room;
    const limits = this.limits;
    if (!room || !limits || !room.isLocalHost || room.phase !== 'waiting') return;
    const host = room.members.find((m) => m.isHost);
    const def = t(hasKey('room.create.nameDefault') ? 'room.create.nameDefault' : 'room.create.name.default', { name: host?.name ?? this.lastName });
    this.dialog.open({
      mode: 'edit',
      name: room.settings.name ?? def,
      renderedDefault: def,
      isPublic: room.settings.visibility === 'public',
      mapMode: room.settings.mapMode,
      maxHumans: room.settings.maxHumans,
      fillBots: room.settings.fillBots,
      limits,
      members: room.members.length,
    });
  }

  private submitRoomDialog(mode: 'create' | 'edit', settings: RoomSettingsInput, patch: Partial<RoomSettingsInput>): void {
    if (mode === 'create') {
      this.callbacks.onCreateRoom?.(settings);
      return;
    }
    // Settings are applied by the next room update; there is no per-request failure event, so close now.
    this.callbacks.onSetRoomSettings?.(patch);
    this.dialog.close();
  }

  /** ADR 0003: WebGL context health. 'failed' blocks with Reload; 'restoring' shows a small note; 'ok' hides both. */
  setGraphicsStatus(status: GraphicsStatus): void {
    const view = graphicsStatusView(status);
    if (view.blocking) {
      this.settingsPanel.show(false);
      // Releasing (never requesting) the pointer so the Reload button can be clicked.
      if (typeof document !== 'undefined' && document.pointerLockElement) document.exitPointerLock();
    }
    this.gfx.set(view.blocking, view.note);
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.motionQuery?.removeEventListener('change', this.onMotionChange);
    window.removeEventListener('resize', this.onResize);
    this.settingsPanel.dispose();
    this.dialog.dispose();
    this.room.dispose();
    this.scope.dispose();
    this.hud.dispose();
    this.el.remove();
  }

  // ------------------------------------------------------------------------------------------
  // Flow
  // ------------------------------------------------------------------------------------------
  private join(name: string): void {
    this.lastName = name;
    writeItem(this.storage, NAME_STORAGE_KEY, name);
    this.joinRequested = true;
    this.connReason = undefined;
    this.callbacks.onJoin(name);
  }

  private setSettings(s: Settings): void {
    const next = effectiveSettings(normalizeSettings(s), this.prefs, this.motionQuery?.matches === true);
    if (settingsEqual(next, this.settings)) return;
    this.settings = next;
    saveSettings(this.storage, next);
    this.callbacks.onSettingsChanged({ ...next });
  }

  private applyPrefs(): void {
    const next = effectiveSettings(this.settings, this.prefs, this.motionQuery?.matches === true);
    this.el.classList.toggle('is-reduced-motion', next.reducedMotion === true);
    this.el.style.setProperty('--ui-scale', String(this.prefs.uiScale));
    // M2b: reduced motion and head bob are part of Settings now (ClientGame and the renderer act on them).
    if (!settingsEqual(next, this.settings)) {
      this.settings = next;
      saveSettings(this.storage, next);
      this.callbacks.onSettingsChanged({ ...next });
    }
  }

  private setScreen(screen: ScreenId): void {
    if (screen === this.screen) return;
    this.screen = screen;
    this.title.show(screen === 'title');
    this.connect.show(screen === 'connecting' || screen === 'connectionLost');
    this.lobby.show(screen === 'lobby');
    this.browser.show(screen === 'browser');
    this.room.show(screen === 'room');
    this.el.dataset['screen'] = screen;
    if (screen !== 'browser' && screen !== 'room') this.dialog.close();
    this.results.show(screen === 'results');
    this.hud.el.hidden = screen !== 'match';
    if (screen !== 'match') {
      this.scope.update(null);
      this.death.show(false);
      this.waitingChip.hidden = true;
    }
  }

  private shouldShowPlayOverlay(screen: ScreenId, hud: HudView): boolean {
    if (screen !== 'match' || hud.pointerLocked || this.settingsPanel.isOpen || this.deathOpen || this.gfx.blocking) return false;
    return hud.local !== null && hud.local.alive;
  }

  private updateMatch(hud: HudView, now: number): void {
    const local = hud.local;
    this.waitingChip.hidden = local !== null;

    // Death card lifecycle (fallback: open if we see ourselves dead without having received the event).
    if (local && !local.alive && !this.deathOpen && this.deathAt === 0) this.openDeath(now);
    if (this.deathOpen) {
      this.death.update(hud);
      // ClientGame only starts spectating after balance match.deathScreenSeconds, so without the field the spectate
      // target appearing is the cue; with it, also hold the card for that long (covers a fast spectate switch).
      const holdMs = Math.max(0, hud.deathScreenSeconds ?? 0) * 1000;
      if (hud.spectate !== null && now - this.deathAt >= holdMs) this.closeDeath();
    }

    // Alive-count announcer
    if (this.prevAlive !== null) {
      const a = aliveAnnouncement(this.prevAlive, hud.aliveCount, hud.totalPlayers);
      if (a) this.announce(`alive-${hud.aliveCount}`, { ...a, tone: a.key === 'announcer.finalTwo' ? 'big' : 'normal' });
    }
    this.prevAlive = hud.aliveCount;

    // M2b flight announcer: doors open, last call (per map: announcer.flight.<mapId>.*).
    const drop = local?.alive ? (hud.drop ?? null) : null;
    const cue = flightCue(this.prevDrop, drop);
    if (cue) this.announceFlight(cue);
    this.prevDrop = drop;
    if (hud.spectate?.view !== undefined && hud.spectate !== null) this.showHint('hint.spectateView');

    // Contextual hints
    if (local && local.alive) {
      if (local.mag !== null && local.mag === 0 && (local.reserve ?? 0) > 0) this.showHint('hint.reload');
      if (local.outsideZone) this.showHint(this.zoneHint());
      // M2a: first time a gun with a sight is in hand after landing.
      if (!local.dropping && hud.ads && hud.ads.sight !== 'none') this.showHint('hint.ads');
      // M2c: both throwable types carried; a gun in hand with a fitting spare scope in the pouch.
      if ((local.throwables?.grenade ?? 0) > 0 && (local.throwables?.smoke ?? 0) > 0) this.showHint('hint.throwableCycle');
      const active = local.activeSlot <= 1 ? local.slots[local.activeSlot] : null;
      if (active && pouchModel(local.scopeStash, active).some((c) => c.fits)) this.showHint('hint.scope');
      // Melee weapon lost: "Fists are back" (the melee slot went from a melee id to fists).
      const melee = (local.slots[2]?.weapon ?? null) as M2cHeldId | null;
      if (this.prevMelee !== null && isMeleeId(this.prevMelee) && melee === 'fists') {
        this.hud.infoToast(t('hud.melee.dropped'), 'fists', now);
      }
      this.prevMelee = melee;
    } else {
      this.prevMelee = null;
    }

    this.feed.update(now);
    this.banner.update(now);
    this.hud.dropHintActive = this.hint.update(now) === 'hint.drop';
    this.hud.update(hud, now, this.viewportW, this.viewportH);
    // Full-screen scope frame (M2a): only while the local player is scoped and nothing modal covers the match.
    this.scope.update(this.deathOpen ? null : this.hud.reticle.scope);
  }

  private openDeath(now: number): void {
    this.deathOpen = true;
    this.deathAt = now;
    this.death.show(true);
  }

  private closeDeath(): void {
    this.deathOpen = false;
    this.death.show(false);
  }

  private resetMatch(): void {
    this.feed.clear();
    this.banner.clear();
    this.hud.resetMatch();
    this.closeDeath();
    this.deathAt = 0;
    this.lockedThisMatch = false;
    this.prevAlive = null;
    this.firstBloodDone = false;
    this.zonePhaseSeen = -2;
    this.zoneShrinkingSeen = false;
    this.lastHeadshot.clear();
    this.lastBlastAttacker.clear();
    this.lastMatchEnded = null;
    this.prevDrop = null;
  }

  private zoneTheme(): ZoneTheme {
    return this.hud.zoneTheme;
  }

  private zoneHint(): HintId {
    return zoneKey('hint', this.zoneTheme()) as HintId;
  }

  private announceFlight(moment: 'takeoff' | 'doorsOpen' | 'lastCall'): void {
    const mapId = this.currentMapId ?? this.lastHud?.minimap.map.id ?? null;
    const key = mapId ? `announcer.flight.${mapId}.${moment}` : null;
    if (key && hasKey(key)) this.announce(`flight-${moment}`, { key, vars: {}, tone: moment === 'lastCall' ? 'warn' : 'normal' });
  }

  private announce(id: string, msg: Message): void {
    this.banner.push(`${id}#${this.msgSeq++}`, msg);
  }

  private showHint(id: HintId, vars: Message['vars'] = {}): void {
    if (this.hintsSeen.has(id)) return;
    this.hintsSeen.add(id);
    writeItem(this.storage, HINTS_STORAGE_KEY, JSON.stringify([...this.hintsSeen]));
    this.hint.push(id, { key: id, vars, tone: 'normal' });
  }

  // ------------------------------------------------------------------------------------------
  // UI sounds (UiCallbacks.playUiSound; audio no longer listens on document)
  // ------------------------------------------------------------------------------------------
  private bindUiSounds(): void {
    const play = (id: UiSoundId): void => this.callbacks.playUiSound?.(id);
    const enabled = (el: Element | null): el is HTMLElement =>
      el instanceof HTMLElement && !(el as HTMLButtonElement | HTMLInputElement).disabled && el.getAttribute('aria-disabled') !== 'true';

    // Capture phase: some buttons stop propagation (gear, resume) so their clicks never reach the game canvas.
    this.el.addEventListener(
      'click',
      (ev) => {
        const target = ev.target instanceof Element ? ev.target.closest(CLICKABLE) : null;
        if (enabled(target)) play('ui.click');
      },
      { capture: true },
    );
    this.el.addEventListener('pointerover', (ev) => {
      if (ev.pointerType !== 'mouse') return; // touch has no hover; the click sound is enough
      const target = ev.target instanceof Element ? ev.target.closest(HOVERABLE) : null;
      if (!enabled(target)) return;
      // Only on entering the control, not when moving between its children.
      if (ev.relatedTarget instanceof Node && target.contains(ev.relatedTarget)) return;
      const now = performance.now();
      if (now - this.lastHoverSoundAt < HOVER_SOUND_GAP_MS) return;
      this.lastHoverSoundAt = now;
      play('ui.hover');
    });
    this.el.addEventListener('input', (ev) => {
      if (!(ev.target instanceof HTMLInputElement) || ev.target.type !== 'range') return;
      const now = performance.now();
      if (now - this.lastSliderSoundAt < SLIDER_SOUND_GAP_MS) return;
      this.lastSliderSoundAt = now;
      play('ui.slider');
    });
  }

  // ------------------------------------------------------------------------------------------
  // Bus
  // ------------------------------------------------------------------------------------------
  private subscribe(bus: EventBus<GameEvents>): void {
    const on = <K extends keyof GameEvents>(k: K, fn: (p: GameEvents[K]) => void): void => {
      this.unsubs.push(bus.on(k, fn));
    };

    on('matchPhaseChanged', (e) => {
      const prev = this.phase;
      this.phase = e.phase;
      if (e.phase === 'playing' && prev !== 'playing') {
        this.resetMatch();
        this.announce('start', { key: 'announcer.matchStart', vars: {}, tone: 'big' });
      }
      // matchEnded normally arrives first and already filled the screen; this covers mid-results joiners.
      if (e.phase === 'results' && this.lastMatchEnded === null) this.results.setResults(null, this.localId);
    });

    on('localPlayerSpawned', (e) => {
      this.localId = e.playerId;
      // M2b: with the carrier you spawn aboard; the drop line waits for your jump (playerJumped below).
      if (this.lastHud?.drop !== undefined) return;
      this.announce('drop', { key: 'announcer.drop', vars: {}, tone: 'normal' });
      this.showHint('hint.drop');
    });

    // ---- M2b: maps and the drop
    on('mapChanged', (e) => {
      this.currentMapId = e.mapId;
      this.hud.zoneTheme = e.zoneTheme;
      // M2c: per-map balance (scope compatibility for the prompt's "Fits: …").
      this.hud.balance = e.balance;
    });
    // ---- M2c
    on('throwableCycled', (e) => {
      this.hud.throwableCycled(e.to);
    });
    on('scopeChanged', (e) => {
      // Auto-mount on pickup: "Sea Glass 2x Scope on Longshore Rifle". A T switch already shows "Sight: …" (Hud).
      if (!e.isLocal || !e.auto || e.to === null) return;
      this.hud.infoToast(t('hud.scope.mounted', { scope: t(`item.${e.to}.name`), weapon: t(`item.${e.gun}.name`) }), e.to, performance.now());
    });
    on('carrierDeparted', (e) => {
      this.currentMapId = e.route.mapId;
      this.announceFlight('takeoff');
    });
    on('playerJumped', (e) => {
      if (!e.isLocal) return;
      this.announce('drop', { key: 'announcer.drop', vars: {}, tone: 'normal' });
      this.showHint('hint.drop');
    });

    // ---- M2b: rooms
    on('roomJoined', (e) => {
      this.lastRoomCode = e.code;
      this.pendingCode = null;
      this.dialog.close();
      this.browser.clearError();
      this.memberToasts.reset();
      this.menuToasts.clear();
    });
    on('roomJoinFailed', (e) => {
      if (e.code) this.browser.prefillCode(e.code);
      this.browser.showError(joinFailedKey(e.reason), { code: e.code ?? '', length: this.limits?.codeLength ?? 5 });
      if (e.reason === 'closed' || e.reason === 'notFound') this.lastRoomCode = null;
    });
    on('roomCreateFailed', (e) => {
      const key = createFailedKey(e.reason);
      if (this.dialog.isOpen) this.dialog.showError(key);
      else this.menuToasts.push(key, {}, true, performance.now());
    });
    on('roomLeft', (e) => {
      this.dialog.close();
      this.lastRoomCode = null;
      this.mapVoteSentFor = null;
      const now = performance.now();
      if (e.reason === 'kicked') this.menuToasts.push('room.toast.kicked', {}, true, now);
      else if (e.reason === 'closed') this.menuToasts.push('room.toast.closed', {}, true, now);
      requestAnimationFrame(() => this.browser.focusCode());
    });
    on('roomHostChanged', (e) => {
      const now = performance.now();
      if (e.isLocal) {
        this.menuToasts.push('room.toast.youHost', {}, false, now);
        requestAnimationFrame(() => this.room.focusPrimary());
      } else {
        this.menuToasts.push('room.toast.hostMigrated', { name: e.hostName }, false, now);
      }
    });
    on('roomMemberChanged', (e) => {
      if (this.screen !== 'room') return;
      const now = performance.now();
      if (this.memberToasts.offer(now)) {
        this.menuToasts.push(e.change === 'joined' ? 'room.toast.joined' : 'room.toast.left', { name: e.name }, false, now);
      }
    });
    on('roomSettingsChanged', () => {
      if (!this.isHost) this.menuToasts.push('room.toast.settings', {}, false, performance.now());
    });
    on('mapVoteLocked', (e) => {
      const key = e.via === 'random' ? 'lobby.vote.lockedRandom' : 'lobby.vote.locked';
      this.menuToasts.push(key, { name: t(mapNameKey(e.mapId)) }, false, performance.now());
    });

    on('playerDamaged', (e) => {
      this.lastHeadshot.set(e.victimId, e.headshot);
      // M2c: rocket impacts count as blasts for the self-kill check (isSelfBlastKill).
      if (isBlastCause(e.cause)) this.lastBlastAttacker.set(e.victimId, e.attackerId);
      if (e.isLocalVictim) {
        this.hud.localDamaged(e);
        const now = performance.now();
        // M2a: armor.md "broken" feedback for the wearer (the snapshot tier drops to 0 at the same time).
        if (e.vest?.broken) this.hud.armorBroken('vest', e.vest.tier, now);
        if (e.helmet?.broken) this.hud.armorBroken('helmet', e.helmet.tier, now);
        if (e.cause === 'weapon') this.showHint('hint.heal');
      }
    });

    on('localHitConfirmed', (e) => {
      // M2c (UI M2c §6.2): no body / head / armor marker through smoke; the kill marker always shows.
      if (!hitMarkerVisible(e.obscured, e.killed)) return;
      this.hud.hitConfirmed(hitVariant(e));
    });

    on('shotFired', (e) => {
      // M2a: the first fight is the moment to teach cover.
      if (e.isLocal && this.screen === 'match') this.showHint('hint.crouch');
    });

    on('stanceChanged', (e) => {
      // M2a: once they have crouched, teach prone next.
      if (e.isLocal && e.to === 'crouch' && !e.forced) this.showHint('hint.prone');
    });

    on('playerKilled', (e) => {
      const now = performance.now();
      const self = isSelfBlastKill(e.cause, e.killerId, e.victimId, this.lastBlastAttacker.get(e.victimId));
      const cause: string = e.cause;
      this.feed.add(
        {
          killerName: e.killerName,
          victimName: e.victimName,
          weapon: e.weapon,
          cause: e.cause,
          self,
          direct: e.direct === true,
          throughSmoke: e.throughSmoke === true,
          weaponLevel: e.weaponLevel ?? null,
          headshot: (cause === 'weapon' || cause === 'melee') && (e.headshot ?? this.lastHeadshot.get(e.victimId) === true),
          isLocalKiller: e.isLocalKiller,
          isLocalVictim: e.isLocalVictim,
        },
        now,
      );
      if (!this.firstBloodDone && e.killerId !== null) {
        this.firstBloodDone = true;
        this.announce('firstblood', { key: 'announcer.firstBlood', vars: {}, tone: 'normal' });
      }
      if (e.isLocalVictim) {
        this.death.setDeath(e, self);
        this.openDeath(now);
      }
    });

    on('itemPickedUp', (e) => {
      if (!e.isLocal) return;
      const item = e.item as M2cItemId;
      const level: ItemLevel | null = e.level ?? null;
      this.hud.pickupToast(item, e.qty, performance.now(), level);
      const cat = itemCategory(item);
      if (cat === 'gun') this.showHint('hint.switch');
      if (item === 'grenade') this.showHint('hint.grenade');
      // M2c one-time hints (narrative M2c §6).
      if (item === 'smoke') this.showHint('hint.smoke');
      if (item === 'rpg') this.showHint('hint.rocket');
      if (cat === 'melee') this.showHint('hint.melee', { item: t(`item.${item}.name`) });
    });

    on('actionFailed', (e) => {
      if (!e.isLocal || this.screen !== 'match') return;
      const key = actionFailedKey(e.action, e.reason, this.hud.currentPromptItem);
      if (key) this.hud.failToast(key, performance.now());
    });

    on('interactPromptChanged', (e) => {
      // durability / refusal are M2a fields; `?? null` keeps an older producer working. M2c fields are optional too.
      this.hud.setPrompt(e.lootId !== null ? e.item : null, e.qty, e.durability ?? null, e.refusal ?? null, e.maxDurability ?? null, {
        level: e.level ?? null,
        scope: e.scope ?? null,
        replacesSlot: e.replacesSlot ?? null,
        scopeTarget: e.scopeTarget ?? null,
      });
      if (e.lootId !== null) this.showHint('hint.loot');
      if (e.lootId !== null && (e.level ?? 1) > 1) this.showHint('hint.level');
    });

    on('zoneWarning', (e) => {
      this.announce(`tidewarn-${e.phaseIndex}`, {
        key: zoneKey('announcer', this.zoneTheme(), 'warning'),
        vars: { seconds: e.secondsUntilShrink },
        tone: 'warn',
      });
      this.showHint(this.zoneHint());
    });

    on('zoneChanged', ({ zone }) => {
      const final = zone.phaseIndex >= zone.phaseCount;
      const phaseChanged = zone.phaseIndex !== this.zonePhaseSeen;
      const startedShrinking = zone.shrinking && (!this.zoneShrinkingSeen || phaseChanged);
      if (final && phaseChanged) {
        this.announce('tide-final', { key: zoneKey('announcer', this.zoneTheme(), 'final'), vars: {}, tone: 'warn' });
      } else if (!final && startedShrinking) {
        this.announce(`tide-${zone.phaseIndex}`, { key: zoneKey('announcer', this.zoneTheme(), 'rising'), vars: {}, tone: 'warn' });
      }
      this.zonePhaseSeen = zone.phaseIndex;
      this.zoneShrinkingSeen = zone.shrinking;
    });

    on('matchEnded', (e) => {
      this.lastMatchEnded = e;
      this.results.setResults(e, this.localId);
    });

    on('connectionStatus', (e) => {
      if (e.status === 'disconnected' || e.status === 'error') {
        this.connReason = e.reason;
        if (e.reason === 'bad_name') {
          // Back to the title with the name error instead of a dead-end "lost" screen.
          this.joinRequested = false;
          this.title.showError();
        }
      }
    });
  }
}
