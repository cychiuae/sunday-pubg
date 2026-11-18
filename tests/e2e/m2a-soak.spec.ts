/**
 * M2a soak (2a-D1): 60 s of a live match with default loot and active bots while the browser mashes every M2a input
 * (C, Z, Space, RMB, LMB, 4/G, 1/2/3, wheel, WASD, Shift). Pass = no console errors or page errors, the dev hook
 * never reports NaN, the page keeps rendering, and the local stance always settles.
 */
import { expect, test } from '@playwright/test';
import type { DevGameState } from '../../src/game/devHook';
import { hook, look } from './support/drive';
import { canvasPixelStats, jumpAndLand, lockPointer, newPlayer, openTitle, SHOTS, soloMatch, unexpectedErrors } from './support/game';
import { startStack, type Stack } from './support/stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({
    label: 'm2a-soak',
    seed: 99,
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 8 },
      // Bots fight each other normally but take a long time to react to the human, so the soak lasts 60 s.
      bots: { reactionMs: 20_000 },
      loot: { spawnChance: 1 },
      zone: { phases: [{ waitSeconds: 600, shrinkSeconds: 10, radiusFraction: 0.5, dps: 1 }] },
    },
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

function nonFinite(v: unknown, path = '$'): string | null {
  if (typeof v === 'number') return Number.isNaN(v) ? `${path} NaN` : null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const r = nonFinite(v[i], `${path}[${i}]`);
      if (r) return r;
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const r = nonFinite(x, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}

test('60 s of mashed M2a inputs in a live match: no console errors, no NaN, stance settles', async ({ browser }) => {
  test.setTimeout(200_000);
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  await soloMatch(page, 'QA Soak', { map: 'island01' });
  expect(await lockPointer(page)).toBe(true);
  await jumpAndLand(page, 90_000);
  const keys = ['c', 'z', 'Space', '4', 'g', '1', '2', '3', 'e', 'r', 'q'];
  const moves = ['w', 'a', 's', 'd'];
  const start = Date.now();
  let i = 0;
  let maxCorrection = 0;
  let nan: string | null = null;
  const seen = new Set<string>();
  while (Date.now() - start < 60_000) {
    if (!(await page.evaluate(() => document.pointerLockElement !== null))) {
      const alive = await hook(page, (g) => g.localAlive);
      if (!alive) {
        // Died: keep the page running (death card, spectate) until 60 s are up; errors are still collected.
        await page.waitForTimeout(1000);
        continue;
      }
      await lockPointer(page);
    }
    const k = keys[i % keys.length]!;
    const m = moves[i % moves.length]!;
    await page.keyboard.down(m);
    if (i % 3 === 0) await page.keyboard.down('Shift');
    await page.keyboard.press(k);
    if (i % 4 === 0) await page.mouse.down({ button: 'right' });
    if (i % 5 === 0) await page.mouse.down();
    await look(page, ((i * 37) % 200) - 100, ((i * 13) % 40) - 20);
    if (i % 7 === 0) await page.mouse.wheel(0, i % 2 ? 120 : -120);
    await page.waitForTimeout(450);
    await page.mouse.up();
    await page.mouse.up({ button: 'right' });
    await page.keyboard.up('Shift');
    await page.keyboard.up(m);
    const s: DevGameState = await hook(page, (g) => g);
    nan ??= nonFinite({ ...s, players: s.players.map((p) => ({ pos: p.pos, hp: p.hp, sp: p.stanceProgress })) });
    maxCorrection = Math.max(maxCorrection, s.lastCorrection);
    if (s.stance) seen.add(s.stance);
    if (s.localWeapon) seen.add(s.localWeapon);
    i++;
  }
  const secs = (Date.now() - start) / 1000;
  const end = await hook(page, (g) => g);
  // Let the last stance transition settle, then check it is not stuck mid-transition.
  if (end.localAlive) {
    await expect.poll(() => hook(page, (g) => g.stanceProgress), { timeout: 5000 }).toBe(1);
  }
  const px = await canvasPixelStats(page);
  await page.screenshot({ path: `${SHOTS}/m2a-soak-end.png` });
  const summary = `soak ${secs.toFixed(0)} s, ${i} input rounds, seen ${[...seen].join(',')}, max lastCorrection ${maxCorrection.toFixed(3)} m, alive ${end.localAlive}, canvas colours ${px.distinctColours}`;
  console.log(summary);
  test.info().annotations.push({ type: 'notes', description: summary });
  expect(nan).toBeNull();
  expect(px.distinctColours).toBeGreaterThan(20);
  expect(unexpectedErrors(log), log.all.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).join('\n')).toEqual([]);
  await ctx.close();
});
