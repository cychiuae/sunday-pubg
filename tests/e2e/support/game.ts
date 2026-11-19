/**
 * Page helpers for E2E specs (owner: qa-tester). DOM assertions on #ui-root; client state via the dev-only
 * `window.__game` hook (src/game/devHook.ts); renderer stats via `window.__render`.
 *
 * M2b flow (rooms.md): title (name, Play) -> room browser -> Create room dialog / Join by code / a listed room ->
 * waiting room (host Start) -> countdown -> carrier (aboard) -> jump -> freefall -> chute -> on foot -> results ->
 * the same waiting room.
 */
import { readFileSync } from 'node:fs';
import { dirname, join as pathJoin, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const SHOTS = 'test-results/shots';

/**
 * Every loot item id in balance.json's loot tables (M2c set). Loot overrides in specs start from `zeroLoot()` so an
 * "only snipers" table really holds only snipers when new item ids are added (read from the file, not hard-coded).
 */
export const LOOT_ITEMS: string[] = (() => {
  const b = JSON.parse(readFileSync(pathJoin(ROOT_DIR, 'docs/design/balance.json'), 'utf8')) as { loot: { tiers: Record<string, Record<string, number>> } };
  const ids = new Set<string>();
  for (const t of Object.values(b.loot.tiers)) for (const k of Object.keys(t)) if (!k.startsWith('_')) ids.add(k);
  return [...ids].sort();
})();
export const zeroLoot = (): Record<string, number> => Object.fromEntries(LOOT_ITEMS.map((i) => [i, 0]));

export interface ConsoleLog {
  errors: string[];
  warnings: string[];
  all: string[];
}

/** Collect console errors and uncaught page errors. Call before page.goto. */
export function watchConsole(page: Page): ConsoleLog {
  const log: ConsoleLog = { errors: [], warnings: [], all: [] };
  page.on('console', (m) => {
    const line = `[${m.type()}] ${m.text()}`;
    log.all.push(line);
    if (m.type() === 'error') log.errors.push(line);
    if (m.type() === 'warning') log.warnings.push(line);
  });
  page.on('pageerror', (e) => {
    const line = `[pageerror] ${e.message}`;
    log.all.push(line);
    log.errors.push(line);
  });
  return log;
}

/**
 * Errors expected in a given scenario (e.g. a deliberately killed server). Everything else fails the test.
 * Chromium logs failed WebSocket handshakes as console errors, which is expected only when the server is down.
 */
export function unexpectedErrors(log: ConsoleLog, allow: RegExp[] = []): string[] {
  return log.errors.filter((e) => !allow.some((re) => re.test(e)));
}

export async function newPlayer(browser: Browser, baseURL: string): Promise<{ ctx: BrowserContext; page: Page; log: ConsoleLog }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL });
  const page = await ctx.newPage();
  const log = watchConsole(page);
  return { ctx, page, log };
}

export const ui = {
  title: (p: Page) => p.locator('.ui-screen--title'),
  connect: (p: Page) => p.locator('.ui-screen--connect'),
  lobby: (p: Page) => p.locator('.ui-screen--lobby'),
  /** M2b */
  browser: (p: Page) => p.locator('.ui-screen--browser'),
  roomDialog: (p: Page) => p.locator('.ui-screen--roomdlg'),
  room: (p: Page) => p.locator('.ui-screen--room'),
  roomCode: (p: Page) => p.locator('.ui-room__code'),
  roomRows: (p: Page) => p.locator('.ui-roomtable__item'),
  hud: (p: Page) => p.locator('.ui-hud'),
  play: (p: Page) => p.locator('.ui-screen--play'),
  death: (p: Page) => p.locator('.ui-screen--death'),
  results: (p: Page) => p.locator('.ui-screen--results'),
  settings: (p: Page) => p.locator('.ui-screen--settings'),
  nameInput: (p: Page) => p.locator('#ui-name'),
  alive: (p: Page) => p.locator('.ui-chip--alive .ui-chip__text'),
  hpValue: (p: Page) => p.locator('.ui-hud__bl .ui-bar__value').first(),
  ammo: (p: Page) => p.locator('.ui-ammo__count'),
  slots: (p: Page) => p.locator('.ui-slot'),
  prompt: (p: Page) => p.locator('.ui-prompt'),
  spectate: (p: Page) => p.locator('.ui-spectate'),
};

export async function openTitle(page: Page): Promise<void> {
  await page.goto('/');
  await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
}

export async function join(page: Page, name: string): Promise<void> {
  await ui.nameInput(page).fill(name);
  await ui.nameInput(page).press('Enter');
}

export interface RoomOptions {
  visibility?: 'public' | 'private';
  map?: 'island01' | 'office' | 'vote';
  bots?: boolean;
}

/** From the title: enter the name and wait for the room browser. */
export async function toBrowser(page: Page, name: string): Promise<void> {
  await join(page, name);
  await expect(ui.browser(page)).toBeVisible({ timeout: 20_000 });
}

/** From the browser: open Create room, set the options, submit, and return the room code from the waiting room. */
export async function createRoom(page: Page, opts: RoomOptions = {}): Promise<string> {
  await ui.browser(page).getByRole('button', { name: /create room/i }).first().click();
  const dlg = ui.roomDialog(page);
  await expect(dlg).toBeVisible();
  if (opts.visibility) await dlg.locator(`#ui-roomdlg-vis-${opts.visibility}`).check({ force: true });
  if (opts.map) await dlg.locator(`#ui-roomdlg-map-${opts.map}`).check({ force: true });
  if (opts.bots !== undefined) await dlg.locator('#ui-roomdlg-bots').setChecked(opts.bots, { force: true });
  await dlg.getByRole('button', { name: /^create$/i }).click();
  await expect(ui.room(page)).toBeVisible({ timeout: 10_000 });
  return ((await ui.roomCode(page).innerText()) ?? '').replace(/\s+/g, '');
}

/** From the browser: type a code into Join by code. */
export async function joinByCode(page: Page, code: string): Promise<void> {
  await page.locator('#ui-room-code').fill(code);
  await ui.browser(page).getByRole('button', { name: /^join$/i }).click();
  // A room mid-match shows the match (spectating) instead of the waiting room.
  await expect(page.locator('.ui-screen--room:visible, .ui-hud:visible').first()).toBeVisible({ timeout: 10_000 });
}

/** Host: press Start match in the waiting room. */
export async function startMatch(page: Page): Promise<void> {
  await ui.room(page).getByRole('button', { name: /start match/i }).click();
}

/**
 * The M1-style "just play" path used by older specs: name -> create a private room (island unless given) -> Start ->
 * match HUD. Returns the room code (an Observer joins with it).
 */
export async function soloMatch(page: Page, name: string, opts: RoomOptions = {}, timeoutMs = 60_000): Promise<string> {
  await toBrowser(page, name);
  const code = await createRoom(page, { visibility: 'private', map: 'island01', ...opts });
  await startMatch(page);
  await waitForMatch(page, timeoutMs);
  return code;
}

/** Read one field set of the dev hook. */
export async function game<T>(page: Page, f: (g: NonNullable<Window['__game']>) => T): Promise<T> {
  return page.evaluate(`(${f.toString()})(window.__game)`) as Promise<T>;
}

/**
 * Aboard the carrier: press Space until the local player leaves it (the doors open at route.noJumpUntil), then wait
 * until on foot. Needs pointer lock for game input. Returns ms from the first press to the jump.
 */
export async function jumpAndLand(page: Page, timeoutMs = 45_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  // Aboard, or already off the carrier (a slow page can miss the short office flight: auto-eject).
  await expect
    .poll(() => game(page, (g) => g.aboard || g.dropPhase !== null || (g.localAlive && g.phase === 'playing')), { timeout: 20_000 })
    .toBe(true);
  while (Date.now() < until && (await game(page, (g) => g.aboard))) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(250);
  }
  await expect.poll(() => game(page, (g) => g.localAlive && !g.aboard && g.dropPhase === null), { timeout: Math.max(1000, until - Date.now()) }).toBe(true);
}

export async function aliveCount(page: Page): Promise<number> {
  const text = (await ui.alive(page).textContent()) ?? '';
  const m = text.match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

/** Number of the HP bar value (first bar in the vitals panel). */
export async function hpValue(page: Page): Promise<number> {
  const text = (await ui.hpValue(page).textContent()) ?? '';
  return Number(text.trim());
}

/** Wait until the match HUD is visible (local player is in the playing phase). */
export async function waitForMatch(page: Page, timeoutMs = 45_000): Promise<void> {
  await expect(ui.hud(page)).toBeVisible({ timeout: timeoutMs });
}

/**
 * Take pointer lock (needed for any game input) the way a player does: the "Click to play" button when the overlay is
 * up, otherwise a click on the canvas. Returns whether the lock was granted.
 */
export async function lockPointer(page: Page): Promise<boolean> {
  const btn = page.locator('.ui-screen--play').getByRole('button', { name: /click to play|resume/i });
  if (await btn.isVisible()) {
    await btn.click();
  } else {
    const box = await page.locator('#app canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  return page
    .waitForFunction(() => document.pointerLockElement !== null, null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
}

export interface PixelStats {
  width: number;
  height: number;
  nonBlackFraction: number;
  distinctColours: number;
  meanLuma: number;
}

/**
 * Screenshot the canvas with the DOM UI hidden, then decode the PNG in the page and measure it. A blank/black canvas
 * has nonBlackFraction ~0; a cleared-but-not-drawn canvas has distinctColours ~1.
 */
export async function canvasPixelStats(page: Page): Promise<PixelStats> {
  await page.evaluate(() => {
    const r = document.getElementById('ui-root');
    if (r) r.style.visibility = 'hidden';
  });
  const png = await page.locator('#app canvas').screenshot();
  await page.evaluate(() => {
    const r = document.getElementById('ui-root');
    if (r) r.style.visibility = '';
  });
  return page.evaluate(async (b64: string) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    if (!g) throw new Error('no 2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let nonBlack = 0;
    let luma = 0;
    const colours = new Set<number>();
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!;
      const gg = d[i + 1]!;
      const b = d[i + 2]!;
      if (r + gg + b > 30) nonBlack++;
      luma += 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      colours.add(((r >> 3) << 10) | ((gg >> 3) << 5) | (b >> 3));
    }
    return { width: bmp.width, height: bmp.height, nonBlackFraction: nonBlack / n, distinctColours: colours.size, meanLuma: luma / n };
  }, png.toString('base64'));
}

export interface RenderStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

export async function renderStats(page: Page): Promise<RenderStats | null> {
  return page.evaluate(() => {
    const r = (window as unknown as { __render?: { info?: { render?: { calls: number; triangles: number }; memory?: { geometries: number; textures: number } } } }).__render;
    if (!r?.info?.render) return null;
    return {
      calls: r.info.render.calls,
      triangles: r.info.render.triangles,
      geometries: r.info.memory?.geometries ?? -1,
      textures: r.info.memory?.textures ?? -1,
    };
  });
}

/** Hold a key for `ms` milliseconds (game input needs pointer lock first). */
export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}
