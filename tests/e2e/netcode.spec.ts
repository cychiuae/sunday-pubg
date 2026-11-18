/**
 * Netcode through the browser: B6 (prediction under 100 ms RTT + jitter shows no rubber-banding while walking),
 * a mid-match joiner waits/spectates and plays the next match, and a dead server shows "Lost at sea" + Rejoin.
 * Uses the dev/E2E hook `window.__game` (src/game/devHook.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { join, lockPointer, newPlayer, openTitle, SHOTS, ui, unexpectedErrors, waitForMatch } from './support/game';
import { CALM_BALANCE, startStack, waitForHealth, type Stack } from './support/stack';

interface DevState {
  phase: string;
  matchId: number | null;
  localAlive: boolean;
  pendingInputs: number;
  lastCorrection: number;
  localPos: { x: number; y: number; z: number } | null;
  aliveCount: number;
  connection: string;
}
const dev = (page: Page): Promise<DevState> =>
  page.evaluate(() => (window as unknown as { __game: DevState }).__game);

test.describe('under 100 ms RTT + 20 ms jitter', () => {
  let stack: Stack;
  test.beforeAll(async () => {
    stack = await startStack({ label: 'netcode-lag', balance: CALM_BALANCE, latencyMs: 100, jitterMs: 20, seed: 31 });
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  test('B6: walking predicts locally with no rubber-banding (reconciliation corrections stay tiny)', async ({ browser }) => {
    const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
    await page.setViewportSize({ width: 960, height: 540 });
    await openTitle(page);
    await join(page, 'Laggy');
    await waitForMatch(page);
    expect(await lockPointer(page)).toBe(true);
    await expect.poll(async () => (await dev(page)).localPos?.y ?? 99, { timeout: 15_000 }).toBeLessThan(15);
    await page.waitForTimeout(4000); // landed

    const samples: DevState[] = [];
    await page.keyboard.down('w');
    for (let i = 0; i < 25; i++) {
      samples.push(await dev(page));
      await page.waitForTimeout(150);
    }
    await page.keyboard.up('w');
    const maxCorr = Math.max(...samples.map((s) => s.lastCorrection));
    const maxPending = Math.max(...samples.map((s) => s.pendingInputs));
    const p0 = samples[0]!.localPos!;
    const p1 = samples[samples.length - 1]!.localPos!;
    const moved = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    test.info().annotations.push({ type: 'notes', description: `maxCorrection ${maxCorr.toFixed(3)} m, maxPending ${maxPending}, moved ${moved.toFixed(1)} m` });
    console.log(`lag walk: maxCorrection ${maxCorr.toFixed(3)} m, maxPending ${maxPending}, moved ${moved.toFixed(1)} m`);
    expect(moved).toBeGreaterThan(5);
    // Pending inputs ~ RTT / input interval (100-140 ms / 33 ms) plus frame batching; corrections far below 3 m snap.
    expect(maxPending).toBeGreaterThan(0);
    expect(maxCorr).toBeLessThan(0.5);
    expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
    await ctx.close();
  });
});

test.describe('connection edge cases', () => {
  let stack: Stack;
  test.beforeAll(async () => {
    stack = await startStack({ label: 'netcode-edges', balance: CALM_BALANCE, seed: 32 });
  });
  test.afterAll(async () => {
    await stack?.stop();
  });

  test('joining mid-match: waits with "Match underway" and plays the next match', async ({ browser }) => {
    test.setTimeout(150_000);
    const first = await newPlayer(browser, stack.baseURL);
    await openTitle(first.page);
    await join(first.page, 'Early');
    await waitForMatch(first.page);

    const late = await newPlayer(browser, stack.baseURL);
    await openTitle(late.page);
    await join(late.page, 'Late');
    await expect(late.page.locator('.ui-waiting')).toBeVisible({ timeout: 15_000 });
    await late.page.screenshot({ path: `${SHOTS}/netcode-late-join.png` });
    const d = await dev(late.page);
    expect(d.phase).toBe('playing');
    expect(d.localAlive).toBe(false);

    // End the match: the only human leaves (endWhenNoHumansAlive), then the late joiner is in the next match.
    const m0 = (await stack.health()).matchId;
    await first.ctx.close();
    await waitForHealth(stack, (h) => h.matchId > m0, 60_000);
    await waitForMatch(late.page, 60_000);
    await expect.poll(async () => (await dev(late.page)).localAlive, { timeout: 15_000 }).toBe(true);
    expect(unexpectedErrors(late.log), late.log.all.join('\n')).toEqual([]);
    await late.ctx.close();
  });

  test('server dies mid-match: "Lost at sea" with Rejoin', async ({ browser }) => {
    await waitForHealth(stack, (h) => h.joined === 0, 15_000);
    const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
    await openTitle(page);
    await join(page, 'Castaway');
    await expect(ui.lobby(page)).toBeVisible({ timeout: 15_000 });
    await stack.killServer();
    await expect(ui.connect(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ui-connect__msg')).toContainText(/lost at sea/i);
    await expect(page.getByRole('button', { name: /rejoin|retry/i })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/netcode-lost.png` });
    // The only console errors allowed are the browser's own failed-WebSocket/proxy messages.
    expect(unexpectedErrors(log, [/WebSocket/i, /ECONNREFUSED/i, /Failed to load resource/i])).toEqual([]);
    await ctx.close();
  });
});
