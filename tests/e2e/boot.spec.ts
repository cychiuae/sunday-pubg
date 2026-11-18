/**
 * (a) Boot: the page loads, WebGL draws a real scene behind the title, and the console is clean.
 */
import { expect, test } from '@playwright/test';
import { canvasPixelStats, newPlayer, openTitle, renderStats, SHOTS, ui, unexpectedErrors } from './support/game';
import { CALM_BALANCE, startStack, type Stack } from './support/stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({ label: 'boot', balance: CALM_BALANCE });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('page loads, WebGL canvas has non-blank pixels, no console errors', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);

  // A WebGL2 context exists on the game canvas.
  const gl = await page.evaluate(() => {
    const c = document.querySelector('#app canvas') as HTMLCanvasElement | null;
    if (!c) return null;
    const ctxGl = c.getContext('webgl2');
    return { w: c.width, h: c.height, webgl2: !!ctxGl };
  });
  expect(gl, 'canvas exists').not.toBeNull();
  expect(gl!.webgl2).toBe(true);
  expect(gl!.w).toBeGreaterThan(0);

  // Let a few frames render, then measure the pixels with the DOM UI hidden.
  await page.waitForTimeout(1500);
  const px = await canvasPixelStats(page);
  await page.screenshot({ path: `${SHOTS}/boot-title.png` });
  expect(px.nonBlackFraction, JSON.stringify(px)).toBeGreaterThan(0.9);
  expect(px.distinctColours, 'scene drawn, not a flat clear colour').toBeGreaterThan(50);

  // Dev hook present and the orbit view draws something.
  const rs = await renderStats(page);
  expect(rs, 'window.__render dev hook').not.toBeNull();
  expect(rs!.calls).toBeGreaterThan(0);

  // Title UI: name field focused or at least focusable, Play visible.
  await expect(ui.nameInput(page)).toBeVisible();
  await expect(page.getByRole('button', { name: /play/i })).toBeVisible();

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});

test('title: empty / whitespace name is rejected and does not connect', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  const before = await stack.health();
  await ui.nameInput(page).fill('   ');
  await ui.nameInput(page).press('Enter');
  await expect(page.locator('.ui-error__text').filter({ hasText: /\S/ })).toBeVisible();
  await expect(ui.title(page)).toBeVisible();
  await page.waitForTimeout(500);
  const after = await stack.health();
  // M2b: no hello is sent, so no new session appears on the server.
  expect(after.connections).toBe(before.connections);
  expect(after.rooms).toBe(before.rooms);
  expect(unexpectedErrors(log)).toEqual([]);
  await ctx.close();
});

test('title: overlong name is limited to 16 characters by the input', async ({ browser }) => {
  const { ctx, page } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await ui.nameInput(page).fill('');
  await ui.nameInput(page).pressSequentially('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const v = await ui.nameInput(page).inputValue();
  expect([...v].length).toBeLessThanOrEqual(16);
  await ctx.close();
});
