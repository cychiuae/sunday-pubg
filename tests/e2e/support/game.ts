/**
 * Page helpers for E2E specs (owner: qa-tester). DOM-only assertions on #ui-root; renderer stats via the dev-only
 * `window.__render` hook. There is no game-state hook yet (see docs/qa/M1-test-report.md "Hooks requested").
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export const SHOTS = 'test-results/shots';

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
