/**
 * Client composition root. Owner: tech-lead. The only client file that imports every module.
 * Frame order (docs/tech/ARCHITECTURE.md "Client frame loop"): game.update -> renderer.render -> audio -> ui.
 */
import { AudioEngine } from './audio/AudioEngine';
import { ClientGame } from './game/ClientGame';
import { DEFAULT_MAP_ID, getMap } from './game/levels';
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
import { Ui } from './ui/Ui';

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el;
}

const serverUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
const initialMap = getMap(DEFAULT_MAP_ID);

const bus = new EventBus<GameEvents>();
const renderer: IRenderer = new Renderer(mustGet('app'), initialMap, bus, BALANCE);
// Low-health heartbeat uses the same balance number as the HUD stripes (ADR 0003). undefined = audio's default.
const audio: IAudio = new AudioEngine(bus, { lowHealthHp: BALANCE.player.lowHpThreshold });
const net: INetClient = new NetClient();
const game: IClientGame = new ClientGame({
  bus,
  net,
  inputTarget: renderer.canvas,
  balance: BALANCE,
  getMap,
  initialMap,
  serverUrl,
});

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
  playUiSound: (id) => audio.playUi?.(id), // M1-fix: UI sounds without document listeners in src/audio
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
