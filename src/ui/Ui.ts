/**
 * DOM UI root. Implements IUi (src/shared/contracts.ts).
 *
 * - Reads continuous state from HudView every frame (diffed writes only).
 * - Reads discrete moments from the bus (never emits).
 * - Sends intents back only through UiCallbacks. Never requests pointer lock itself.
 * - Persists Settings (SETTINGS_STORAGE_KEY) and UI-only prefs (scale, reduced motion), plus the last name.
 *
 * Owner: ui-ux-designer. Design spec: docs/ui/UI.md.
 */
import './ui.css';
import { coastlineRadius } from '../shared/sim/terrain';
import type { GraphicsStatus, HudView, IUi, Settings, UiCallbacks, UiSoundId } from '../shared/contracts';
import type { EventBus, GameEvents } from '../shared/events';
import type { MatchPhase, PlayerId } from '../shared/types';
import { h } from './dom';
import { KillFeed, MessageSlot, type Message } from './feed';
import { Hud } from './hud';
import {
  actionFailedKey,
  aliveAnnouncement,
  connectionErrorKey,
  graphicsStatusView,
  itemCategory,
  selectScreen,
  type ScreenId,
} from './logic';
import {
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
import { t } from '../content/strings';

const BANNER_MS = 2600;
/** UI sound throttles: hover sweeps across a row of buttons and slider drags fire many events. */
const HOVER_SOUND_GAP_MS = 45;
const SLIDER_SOUND_GAP_MS = 70;
/** Elements that make a click / hover sound. Labels are excluded: a label click re-dispatches to its input. */
const CLICKABLE = 'button, input[type="checkbox"], input[type="radio"]';
const HOVERABLE = 'button, .ui-seg__opt, .ui-field--check, input[type="range"]';
const HINT_MS = 5000;

type HintId = 'hint.drop' | 'hint.loot' | 'hint.reload' | 'hint.heal' | 'hint.tide' | 'hint.switch';

export class Ui implements IUi {
  private readonly el: HTMLDivElement;
  private readonly storage = getStorage();
  private settings: Settings;
  private prefs: UiPrefs;
  private readonly unsubs: (() => void)[] = [];
  private readonly motionQuery: MediaQueryList | null;
  private readonly onMotionChange = (): void => this.applyPrefs();
  private readonly onResize = (): void => {
    this.viewportH = window.innerHeight;
  };
  private viewportH = typeof window !== 'undefined' ? window.innerHeight : 720;

  // Screens
  private readonly title: TitleScreen;
  private readonly connect: ConnectScreen;
  private readonly lobby: LobbyScreen;
  private readonly hud: Hud;
  private readonly play: PlayOverlay;
  private readonly death: DeathCard;
  private readonly results: ResultsScreen;
  private readonly settingsPanel: SettingsPanel;
  private readonly gfx: GraphicsOverlay;
  private readonly feed: KillFeed;
  private readonly banner: MessageSlot;
  private readonly hint: MessageSlot;
  private readonly waitingChip: HTMLDivElement;

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
  private readonly lastArmor = new Map<PlayerId, number>();
  private armorBrokeFor: PlayerId | null = null;
  private readonly hintsSeen: Set<string>;
  private msgSeq = 0;
  private lastHoverSoundAt = -Infinity;
  private lastSliderSoundAt = -Infinity;

  constructor(
    root: HTMLElement,
    bus: EventBus<GameEvents>,
    private readonly callbacks: UiCallbacks,
  ) {
    this.settings = loadSettings(this.storage);
    this.prefs = loadUiPrefs(this.storage);
    this.lastName = readItem(this.storage, NAME_STORAGE_KEY) ?? '';
    this.hintsSeen = parseHintSet(readItem(this.storage, HINTS_STORAGE_KEY));
    this.motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

    const openSettings = (): void => this.settingsPanel.show(true);
    this.title = new TitleScreen(this.lastName, (name) => this.join(name), openSettings);
    this.connect = new ConnectScreen(() => {
      if (this.lastName) this.join(this.lastName);
      else this.joinRequested = false;
    });
    this.lobby = new LobbyScreen(openSettings);
    this.hud = new Hud(coastlineRadius);
    this.play = new PlayOverlay(() => this.callbacks.onResume(), openSettings);
    this.death = new DeathCard(() => this.closeDeath());
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
      this.hud.el,
      this.waitingChip,
      this.lobby.el,
      this.death.el,
      this.results.el,
      this.play.el,
      this.connect.el,
      this.title.el,
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
    if (hud.joined) this.wasJoined = true;
    this.localId = hud.local?.id ?? this.localId;
    if (hud.phase !== 'results') this.resultsDismissed = false;
    if (hud.pointerLocked) this.lockedThisMatch = true;

    const screen = selectScreen({
      joinRequested: this.joinRequested,
      connection: hud.connection,
      joined: hud.joined,
      phase: hud.phase,
      resultsDismissed: this.resultsDismissed,
    });
    this.setScreen(screen);

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
    if (showPlay) this.play.update(!this.lockedThisMatch);
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
    const next = normalizeSettings(s);
    if (settingsEqual(next, this.settings)) return;
    this.settings = next;
    saveSettings(this.storage, next);
    this.callbacks.onSettingsChanged({ ...next });
  }

  private applyPrefs(): void {
    const reduced = this.prefs.reducedMotion === 'on' || (this.prefs.reducedMotion === 'system' && this.motionQuery?.matches === true);
    this.el.classList.toggle('is-reduced-motion', reduced);
    this.el.style.setProperty('--ui-scale', String(this.prefs.uiScale));
  }

  private setScreen(screen: ScreenId): void {
    if (screen === this.screen) return;
    this.screen = screen;
    this.title.show(screen === 'title');
    this.connect.show(screen === 'connecting' || screen === 'connectionLost');
    this.lobby.show(screen === 'lobby');
    this.results.show(screen === 'results');
    this.hud.el.hidden = screen !== 'match';
    if (screen !== 'match') {
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

    // Contextual hints
    if (local && local.alive) {
      if (local.mag !== null && local.mag === 0 && (local.reserve ?? 0) > 0) this.showHint('hint.reload');
      if (local.outsideZone) this.showHint('hint.tide');
    }

    this.feed.update(now);
    this.banner.update(now);
    this.hud.dropHintActive = this.hint.update(now) === 'hint.drop';
    this.hud.update(hud, now, this.viewportH);
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
    this.lastArmor.clear();
    this.lastMatchEnded = null;
  }

  private announce(id: string, msg: Message): void {
    this.banner.push(`${id}#${this.msgSeq++}`, msg);
  }

  private showHint(id: HintId): void {
    if (this.hintsSeen.has(id)) return;
    this.hintsSeen.add(id);
    writeItem(this.storage, HINTS_STORAGE_KEY, JSON.stringify([...this.hintsSeen]));
    this.hint.push(id, { key: id, vars: {}, tone: 'normal' });
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
      this.announce('drop', { key: 'announcer.drop', vars: {}, tone: 'normal' });
      this.showHint('hint.drop');
    });

    on('playerDamaged', (e) => {
      this.lastHeadshot.set(e.victimId, e.headshot);
      // armorBefore (M1-fix) when the producer sends it; otherwise the last armor value we saw for that victim.
      const before = e.armorBefore ?? this.lastArmor.get(e.victimId);
      this.armorBrokeFor = e.isLocalAttacker && before !== undefined && before > 0 && e.armorAfter <= 0 ? e.victimId : null;
      this.lastArmor.set(e.victimId, e.armorAfter);
      if (e.isLocalVictim) {
        this.hud.localDamaged(e);
        if (e.cause === 'weapon') this.showHint('hint.heal');
      }
    });

    on('localHitConfirmed', (e) => {
      this.hud.hitConfirmed(e.headshot, e.killed, this.armorBrokeFor === e.victimId);
      this.armorBrokeFor = null;
    });

    on('playerKilled', (e) => {
      const now = performance.now();
      this.feed.add(
        {
          killerName: e.killerName,
          victimName: e.victimName,
          weapon: e.weapon,
          cause: e.cause,
          headshot: e.cause === 'weapon' && (e.headshot ?? this.lastHeadshot.get(e.victimId) === true),
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
        this.death.setDeath(e);
        this.openDeath(now);
      }
    });

    on('itemPickedUp', (e) => {
      if (!e.isLocal) return;
      this.hud.pickupToast(e.item, e.qty, performance.now());
      if (itemCategory(e.item) === 'gun') this.showHint('hint.switch');
    });

    on('actionFailed', (e) => {
      if (!e.isLocal || this.screen !== 'match') return;
      const key = actionFailedKey(e.action, e.reason);
      if (key) this.hud.failToast(key, performance.now());
    });

    on('interactPromptChanged', (e) => {
      this.hud.setPrompt(e.lootId !== null ? e.item : null, e.qty);
      if (e.lootId !== null) this.showHint('hint.loot');
    });

    on('zoneWarning', (e) => {
      this.announce(`tidewarn-${e.phaseIndex}`, {
        key: 'announcer.tide.warning',
        vars: { seconds: e.secondsUntilShrink },
        tone: 'warn',
      });
      this.showHint('hint.tide');
    });

    on('zoneChanged', ({ zone }) => {
      const final = zone.phaseIndex >= zone.phaseCount;
      const phaseChanged = zone.phaseIndex !== this.zonePhaseSeen;
      const startedShrinking = zone.shrinking && (!this.zoneShrinkingSeen || phaseChanged);
      if (final && phaseChanged) {
        this.announce('tide-final', { key: 'announcer.tide.final', vars: {}, tone: 'warn' });
      } else if (!final && startedShrinking) {
        this.announce(`tide-${zone.phaseIndex}`, { key: 'announcer.tide.rising', vars: {}, tone: 'warn' });
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
