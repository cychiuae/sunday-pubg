/**
 * (d) Match completes -> death card -> spectate -> results (placement, kills, standings) -> server resets to lobby
 * after match.resultsSeconds -> the next match starts. Uses a tiny tide so a match resolves in ~30 s.
 */
import { expect, test } from '@playwright/test';
import { join, newPlayer, openTitle, SHOTS, ui, unexpectedErrors, waitForMatch } from './support/game';
import { FAST_BALANCE, startStack, waitForHealth, type Stack } from './support/stack';

let stack: Stack;

test.describe.configure({ mode: 'serial' });

const BALANCE = {
  ...FAST_BALANCE,
  // Keep the match alive a while after the human dies so the death card -> spectate path is observable:
  // phase 1 catches the idle human on the beach, phase 2 waits long enough for the bots to survive a while.
  match: { ...FAST_BALANCE.match, lastHumanDeathDelaySeconds: 12 },
  zone: {
    ...FAST_BALANCE.zone,
    phases: [
      { waitSeconds: 10, shrinkSeconds: 5, radiusFraction: 0.2, dps: 20 },
      { waitSeconds: 15, shrinkSeconds: 4, radiusFraction: 0.03, dps: 40 },
    ],
  },
};

test.beforeAll(async () => {
  stack = await startStack({ label: 'match-loop', balance: BALANCE, seed: 4242 });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('full loop: match -> death -> spectate -> results -> lobby -> next match', async ({ browser }) => {
  test.setTimeout(180_000);
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await join(page, 'QA Loop');
  await waitForMatch(page);
  const first = await stack.health();
  expect(first.phase).toBe('playing');

  // Idle human: the tide (20-100 dps) eliminates them, or they win when the collapse takes the bots first.
  const outcome = await Promise.race([
    ui.death(page).waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'death' as const),
    ui.results(page).waitFor({ state: 'visible', timeout: 90_000 }).then(() => 'results' as const),
  ]);

  if (outcome === 'death') {
    await page.screenshot({ path: `${SHOTS}/loop-death.png` });
    await expect(page.locator('.ui-death__cause')).not.toBeEmpty();
    await expect(page.locator('.ui-death__place')).toHaveText(/#\d+/);
    // Spectate from the death card (button), then the spectate bar shows a name.
    const spectateBtn = page.getByRole('button', { name: /spectate/i });
    let clickedAt = 0;
    if (await spectateBtn.isVisible()) {
      await spectateBtn.click();
      clickedAt = Date.now();
    }
    // Spectating starts only after match.deathScreenSeconds even when the button is clicked (BUG-001), so allow 8 s.
    await expect(ui.spectate(page)).toBeVisible({ timeout: 8_000 });
    if (clickedAt) {
      const gap = Date.now() - clickedAt;
      console.log(`spectate bar appeared ${gap} ms after clicking Spectate (BUG-001)`);
      test.info().annotations.push({ type: 'BUG-001', description: `spectate gap ${gap} ms` });
    }
    await expect(page.locator('.ui-spectate__name')).not.toBeEmpty();
    await page.screenshot({ path: `${SHOTS}/loop-spectate.png` });
  }

  // Results screen with placement, kills and standings.
  await expect(ui.results(page)).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.ui-results__banner')).not.toBeEmpty();
  await expect(page.locator('.ui-results__place')).toHaveText(/#\d+ of 6/);
  await expect(page.locator('.ui-results__kills')).toHaveText(/Kills \d+/);
  const rows = page.locator('.ui-standings > li');
  await expect(rows).toHaveCount(6);
  await expect(page.locator('.ui-standings .ui-tag--bot')).toHaveCount(5);
  await expect(page.locator('.ui-results__next')).toHaveText(/Next match in \d+/);
  await page.screenshot({ path: `${SHOTS}/loop-results.png` });
  const resultsHealth = await stack.health();
  expect(resultsHealth.phase).toBe('results');

  // Server resets to lobby after resultsSeconds (6) and re-queues the human; the countdown runs again.
  const t0 = Date.now();
  await waitForHealth(stack, (h) => h.phase === 'lobby' || h.phase === 'countdown', 15_000);
  const resetMs = Date.now() - t0;
  expect(resetMs).toBeLessThan(6_000 + 3_000);
  await expect(ui.lobby(page)).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: `${SHOTS}/loop-lobby-again.png` });

  // Next match starts with the same human, matchId increments.
  await waitForMatch(page);
  const second = await stack.health();
  expect(second.matchId).toBe(first.matchId + 1);
  expect(second.phase).toBe('playing');
  await expect(ui.hpValue(page)).toHaveText('100');
  await page.screenshot({ path: `${SHOTS}/loop-second-match.png` });

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});

test('results: "Play again" returns to the lobby before the server resets', async ({ browser }) => {
  test.setTimeout(180_000);
  await waitForHealth(stack, (h) => h.phase === 'lobby' || h.phase === 'countdown', 60_000);
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await join(page, 'QA Again');
  await waitForMatch(page);
  await expect(ui.results(page)).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /play again/i }).click();
  await expect(ui.results(page)).toBeHidden();
  await expect(ui.lobby(page)).toBeVisible();
  // Server still in results at this point; the client shows the lobby while it waits.
  await waitForMatch(page, 30_000);
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});
