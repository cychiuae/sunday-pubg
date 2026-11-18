/**
 * (b) Join flow (M2b rooms): name -> room browser -> Create room -> waiting room (count, bots-fill note, Start) ->
 *     countdown -> match HUD (alive count = targetPlayers, health), carrier aboard.
 * (c) Two browser contexts in the same public room: the second one finds it in the browser list and joins it; both
 *     clients agree on the alive count; one leaving mid-match drops it by one.
 */
import { expect, test } from '@playwright/test';
import { aliveCount, createRoom, game, hpValue, newPlayer, openTitle, SHOTS, startMatch, toBrowser, ui, unexpectedErrors, waitForMatch } from './support/game';
import { CALM_BALANCE, onlyRoom, startStack, waitForHealth, type Stack } from './support/stack';

let stack: Stack;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  stack = await startStack({ label: 'join', balance: { ...CALM_BALANCE, match: { ...CALM_BALANCE.match, countdownSeconds: 6 } } });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('(b) name -> browser -> create -> waiting room -> countdown -> match HUD with alive count and health', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await toBrowser(page, 'QA Solo');
  await page.screenshot({ path: `${SHOTS}/join-browser.png` });
  await createRoom(page, { map: 'island01' });
  // Waiting room: one member (the host, crowned), the bots note, Start enabled with fill on.
  await expect(page.locator('.ui-members > li')).toHaveCount(1);
  await expect(ui.room(page).getByText(/bots will fill/i)).toBeVisible();
  await expect(ui.room(page).getByRole('button', { name: /start match/i })).toBeEnabled();
  await page.screenshot({ path: `${SHOTS}/join-room.png` });
  await startMatch(page);
  // The countdown is shown in the waiting room.
  await expect(ui.room(page)).toContainText(/\d/, { timeout: 5000 });

  await waitForMatch(page);
  await expect(ui.alive(page)).toHaveText(/^\d+ alive$/);
  expect(await aliveCount(page), 'bots fill to match.targetPlayers (6 in this balance)').toBe(6);
  await expect(ui.hpValue(page)).toHaveText('100');
  expect(await hpValue(page)).toBe(100);
  expect(await game(page, (g) => g.aboard)).toBe(true);
  await expect(ui.play(page)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/join-hud.png` });

  const r = onlyRoom(await stack.health());
  expect(r).toMatchObject({ phase: 'playing', humans: 1, visibility: 'public' });

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
  // The last human leaving closes the room.
  await waitForHealth(stack, (x) => x.rooms === 0, 10_000);
});

test('(c) a public room is listed; a second context joins it from the list; alive counts agree', async ({ browser }) => {
  const a = await newPlayer(browser, stack.baseURL);
  const b = await newPlayer(browser, stack.baseURL);
  await Promise.all([openTitle(a.page), openTitle(b.page)]);
  await toBrowser(a.page, 'Alpha');
  await createRoom(a.page, { visibility: 'public', map: 'island01' });
  await toBrowser(b.page, 'Bravo');
  const row = ui.roomRows(b.page).filter({ hasText: /alpha/i });
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await b.page.screenshot({ path: `${SHOTS}/join-browser-listed.png` });
  await row.getByRole('button').first().click();
  await expect(ui.room(b.page)).toBeVisible({ timeout: 10_000 });
  await expect(a.page.locator('.ui-members > li')).toHaveCount(2, { timeout: 10_000 });

  await startMatch(a.page);
  await Promise.all([waitForMatch(a.page), waitForMatch(b.page)]);
  expect(onlyRoom(await stack.health())).toMatchObject({ phase: 'playing', humans: 2 });

  for (let i = 0; i < 5; i++) {
    const [ca, cb] = await Promise.all([aliveCount(a.page), aliveCount(b.page)]);
    expect(ca).toBe(6);
    expect(Math.abs(ca - cb), `alive A=${ca} B=${cb}`).toBeLessThanOrEqual(0);
    await a.page.waitForTimeout(400);
  }
  await a.page.screenshot({ path: `${SHOTS}/two-clients-a.png` });

  // B leaves mid-match: A's alive count drops by one (aboard players are removed cleanly).
  await b.ctx.close();
  await expect.poll(() => aliveCount(a.page), { timeout: 8000 }).toBe(5);
  expect(unexpectedErrors(a.log), a.log.all.join('\n')).toEqual([]);
  expect(unexpectedErrors(b.log), b.log.all.join('\n')).toEqual([]);
  await a.ctx.close();
});
