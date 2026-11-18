/**
 * (d) Match completes -> death card -> spectate -> results (placement, kills, standings) -> the same waiting room after
 * match.resultsSeconds (M2b rooms) -> the host starts the next match. Uses a tiny tide so a match resolves in ~30 s.
 * The idle human never jumps: the carrier auto-ejects them (drop.md AT7).
 */
import { expect, test } from '@playwright/test';
import { game, newPlayer, openTitle, SHOTS, soloMatch, startMatch, ui, unexpectedErrors, waitForMatch } from './support/game';
import { FAST_BALANCE, onlyRoom, startStack, waitForHealth, type Stack } from './support/stack';

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
  const code = await soloMatch(page, 'QA Loop', { map: 'island01' });
  const first = onlyRoom(await stack.health());
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
  await page.screenshot({ path: `${SHOTS}/loop-results.png` });
  expect(onlyRoom(await stack.health()).phase).toBe('results');

  // M2b: after resultsSeconds (6) the room returns to waiting with the same code; nothing starts by itself (private).
  const t0 = Date.now();
  await waitForHealth(stack, (h) => onlyRoom(h).phase === 'waiting', 15_000);
  expect(Date.now() - t0).toBeLessThan(6_000 + 3_000);
  await expect(ui.room(page)).toBeVisible({ timeout: 5_000 });
  expect(await game(page, (g) => g.roomCode)).toBe(code);
  await page.screenshot({ path: `${SHOTS}/loop-room-again.png` });

  // The host starts the next match: same human, match serial increments.
  await startMatch(page);
  await waitForMatch(page);
  const second = onlyRoom(await stack.health());
  expect(second.matchId).toBe((first.matchId ?? 0) + 1);
  expect(second.phase).toBe('playing');
  await expect(ui.hpValue(page)).toHaveText('100');
  await page.screenshot({ path: `${SHOTS}/loop-second-match.png` });

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});

test('results: "Play again" returns to the lobby before the server resets', async ({ browser }) => {
  test.setTimeout(180_000);
  await waitForHealth(stack, (h) => h.rooms === 0, 60_000);
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  const code = await soloMatch(page, 'QA Again', { map: 'island01' });
  await expect(ui.results(page)).toBeVisible({ timeout: 120_000 });
  await page.getByRole('button', { name: /play again/i }).click();
  await expect(ui.results(page)).toBeHidden();
  // M2b: Play again goes back to the same waiting room (ui m2b test "Play again back to the same room").
  await expect(ui.room(page)).toBeVisible();
  expect(await game(page, (g) => g.roomCode)).toBe(code);
  await waitForHealth(stack, (h) => onlyRoom(h).phase === 'waiting', 30_000);
  await startMatch(page);
  await waitForMatch(page, 30_000);
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});
