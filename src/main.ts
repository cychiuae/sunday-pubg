/**
 * Client composition root. Owner: tech-lead. The only client file that imports every module.
 * Frame order (docs/tech/ARCHITECTURE.md "Client frame loop"): game.update -> renderer.render -> audio -> ui.
 */
import { AudioEngine } from './audio/AudioEngine';
import { t } from './content/strings';
import { ClientGame } from './game/ClientGame';
import { DEFAULT_MAP_ID, getMap } from './game/levels';
import { applyLayout, buildMatchLayout } from './game/levels/layout';
import { NetClient } from './net/NetClient';
import { Renderer } from './render/Renderer';
import { BALANCE } from './shared/balance';
import { WS_PATH } from './shared/constants';
import {
  DEFAULT_QUALITY,
  type GraphicsStatus,
  type IAudio,
  type IClientGame,
  type INetClient,
  type IRenderer,
  type IUi,
  type QualityLevel,
  type Settings,
} from './shared/contracts';
import { EventBus, type GameEvents } from './shared/events';
import type { MapData } from './shared/types';
import { Ui } from './ui/Ui';

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
}

const serverUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
// M2b: the title-screen map. Later maps arrive with each welcome; ClientGame emits mapChanged (ADR 0005 §5).
const initialMap: MapData = getMap(DEFAULT_MAP_ID);

const bus = new EventBus<GameEvents>();
const renderer: IRenderer = new Renderer(mustGet('app'), initialMap, bus, BALANCE);
// Low-health heartbeat uses the same balance number as the HUD stripes (ADR 0003). undefined = audio's default.
// M2a/M2b: balance is injected so audio needs no BALANCE fallback (REVIEW-M2a M5); per-map values come in mapChanged.
const audio: IAudio = new AudioEngine(bus, { lowHealthHp: BALANCE.player.lowHpThreshold, balance: BALANCE });
const net: INetClient = new NetClient();
const game: IClientGame = new ClientGame(
  {
    bus,
    net,
    inputTarget: renderer.canvas,
    balance: BALANCE,
    getMap,
    initialMap,
    serverUrl,
    // M2c (ADR 0007 §1.5): the client builds each match's layout from welcome.layout.seed (decor on).
    buildLayout: (base, seed) => {
      const layout = buildMatchLayout(base, seed, { decor: true });
      return { layout, map: applyLayout(base, layout) };
    },
  },
  // ADR 0006 §6 (Q5): a room with name null shows "{name}'s room", rendered on the client.
  { defaultRoomName: (name) => t('room.create.nameDefault', { name }) },
);

let appliedQuality: QualityLevel | null = null;
const applySettings = (s: Settings): void => {
  game.setSettings(s);
  audio.setVolume(s.masterVolume);
  // M1-fix: graphics preset. Only on change (setQuality reallocates shadow maps).
  const quality = s.quality ?? DEFAULT_QUALITY;
  if (quality !== appliedQuality) {
    appliedQuality = quality;
    renderer.setQuality?.(quality);
  }
};

const ui: IUi = new Ui(mustGet('ui-root'), bus, {
  onJoin: (name) => game.join(name),
  onSettingsChanged: applySettings,
  onPlayAgain: () => game.playAgain(),
  onResume: () => game.requestPointerLock(),
  onSpectate: () => game.requestSpectate?.(), // BUG-001: death card "Spectate" starts spectating now
  playUiSound: (id) => audio.playUi?.(id), // M1-fix: UI sounds without document listeners in src/audio
  // M2b rooms (ADR 0006 §7): Ui intents go straight to ClientGame, which validates them against its state.
  onRefreshRooms: () => game.refreshRooms(),
  onCreateRoom: (settings) => game.createRoom(settings),
  onJoinRoom: (target) => game.joinRoom(target),
  onLeaveRoom: () => game.leaveRoom(),
  onSetRoomSettings: (patch) => game.setRoomSettings(patch),
  onStartMatch: () => game.startMatch(),
  onCancelCountdown: () => game.cancelCountdown(),
  onSetReady: (ready) => game.setReady(ready),
  onVote: (option) => game.vote(option),
  onKick: (memberId) => game.kick(memberId),
  onCycleScope: () => game.cycleScope?.(), // M2c (scopes.md): sight-chip click = T
});
applySettings(ui.getSettings());

// Browsers require a user gesture before audio can start. unlock() is idempotent, so every gesture retries it
// (a context can stay suspended after the first attempt, e.g. on iOS or when the gesture was a key repeat).
const unlockAudio = (): void => audio.unlock();
window.addEventListener('pointerdown', unlockAudio, { capture: true });
window.addEventListener('keydown', unlockAudio, { capture: true });
window.addEventListener('resize', () => renderer.resize());

// WebGL context health -> Ui overlay (ADR 0003 §5). Only forwarded on change.
let appliedGraphicsStatus: GraphicsStatus = 'ok';
const syncGraphicsStatus = (): void => {
  const status = renderer.getGraphicsStatus?.() ?? 'ok';
  if (status !== appliedGraphicsStatus) {
    appliedGraphicsStatus = status;
    ui.setGraphicsStatus?.(status);
  }
};

const ERROR_LOG_INTERVAL_MS = 1000;
let lastErrorLogAt = -Infinity;
let last = performance.now();
function frame(now: number): void {
  // Schedule first: one throwing frame must not stop the loop for good.
  requestAnimationFrame(frame);
  const dt = Math.min(Math.max((now - last) / 1000, 0), 0.1);
  last = now;

  try {
    const { frame: view, hud } = game.update(dt); // 1. net messages -> bus events, input, prediction, views
    renderer.render(view, dt); // 2. draw
    syncGraphicsStatus();
    const listener = renderer.getListenerPose(); // 3. audio follows the camera
    audio.setListener(listener.pos, listener.yaw);
    audio.setGrenades?.(view.grenades, view.serverTime); // ADR 0004 A2: fuse tick of nearby grenades
    audio.setRockets?.(view.rockets ?? [], view.serverTime); // M2c (ADR 0007 §8): rocket whistles and fly-bys
    audio.setSmokes?.(view.smokes ?? [], view.serverTime); // M2c: smoke hiss loops (late joiners too)
    audio.update(dt);
    ui.update(hud); // 4. DOM last
  } catch (err) {
    if (now - lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = now;
      console.error('[main] frame failed', err);
    }
  }
}
requestAnimationFrame(frame);
