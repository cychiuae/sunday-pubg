/**
 * (b) Join flow: name -> connecting -> lobby (count + countdown + bots-fill note) -> match HUD (alive count, health).
 * (c) Two browser contexts join the same match and agree on the alive count.
 */
import { expect, test } from '@playwright/test';
import { aliveCount, hpValue, join, newPlayer, openTitle, SHOTS, ui, unexpectedErrors, waitForMatch } from './support/game';
import { CALM_BALANCE, startStack, waitForHealth, type Stack } from './support/stack';

let stack: Stack;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  stack = await startStack({ label: 'join', balance: { ...CALM_BALANCE, match: { ...CALM_BALANCE.match, countdownSeconds: 6 } } });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('(b) name -> lobby -> countdown -> match HUD with alive count and health', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await join(page, 'QA Solo');

  // Lobby with the player count, a countdown and the bots note.
  await expect(ui.lobby(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.ui-lobby__bots')).toBeVisible();
  await expect(page.locator('.ui-lobby__count')).toContainText('1');
  await expect(page.locator('.ui-lobby__status')).toContainText(/starts in \d+/i, { timeout: 10_000 });
  await page.screenshot({ path: `${SHOTS}/join-lobby.png` });

  // Countdown ends: the HUD replaces the lobby.
  await waitForMatch(page);
  await expect(ui.lobby(page)).toBeHidden();
  await expect(ui.alive(page)).toHaveText(/^\d+ alive$/);
  const alive = await aliveCount(page);
  expect(alive, 'bots fill to match.targetPlayers (6 in this balance)').toBe(6);
  await expect(ui.hpValue(page)).toHaveText('100');
  expect(await hpValue(page)).toBe(100);

  // Without pointer lock the "click to play" overlay is offered.
  await expect(ui.play(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/join-hud.png` });

  const h = await stack.health();
  expect(h.phase).toBe('playing');
  expect(h.joined).toBe(1);

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
  // Leaving removes the player; wait for the next lobby before the next test.
  await waitForHealth(stack, (x) => x.joined === 0, 10_000);
});

test('(c) two browser contexts join the same match and see a consistent alive count', async ({ browser }) => {
  // Make sure the room is back in lobby (the solo test's match ends when no humans remain).
  await waitForHealth(stack, (x) => x.phase === 'lobby' || x.phase === 'countdown', 30_000);

  const a = await newPlayer(browser, stack.baseURL);
  const b = await newPlayer(browser, stack.baseURL);
  await Promise.all([openTitle(a.page), openTitle(b.page)]);
  await join(a.page, 'Alpha');
  await join(b.page, 'Bravo');

  await expect(a.page.locator('.ui-lobby__count')).toContainText('2', { timeout: 15_000 });
  await expect(b.page.locator('.ui-lobby__count')).toContainText('2', { timeout: 15_000 });

  await Promise.all([waitForMatch(a.page), waitForMatch(b.page)]);
  const h = await stack.health();
  expect(h.joined).toBe(2);
  expect(h.phase).toBe('playing');

  // Sample a few times: both clients must agree (they read the same 20 Hz snapshots, allow one in-flight change).
  for (let i = 0; i < 5; i++) {
    const [ca, cb] = await Promise.all([aliveCount(a.page), aliveCount(b.page)]);
    expect(ca).toBe(6);
    expect(Math.abs(ca - cb), `alive A=${ca} B=${cb}`).toBeLessThanOrEqual(0);
    await a.page.waitForTimeout(400);
  }
  await a.page.screenshot({ path: `${SHOTS}/two-clients-a.png` });
  await b.page.screenshot({ path: `${SHOTS}/two-clients-b.png` });

  // B leaves mid-match: A's alive count drops by one (disconnect removes the player cleanly).
  await b.ctx.close();
  await expect.poll(() => aliveCount(a.page), { timeout: 5000 }).toBe(5);

  expect(unexpectedErrors(a.log), a.log.all.join('\n')).toEqual([]);
  expect(unexpectedErrors(b.log), b.log.all.join('\n')).toEqual([]);
  await a.ctx.close();
});
