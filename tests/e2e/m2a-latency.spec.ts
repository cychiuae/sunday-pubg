/**
 * 2a-C5 acceptance through the browser: at LATENCY_MS 100 (+20 ms jitter), crouch/prone and ADS while moving show
 * no rubber-banding. Measured as the client's reconciliation corrections (window.__game.lastCorrection, sampled every
 * ~250 ms) while walking forward and changing stance, then while walking scoped with a sniper.
 */
import { expect, test } from '@playwright/test';
import { calibrateLook, fetchLoot, hook, me } from './support/drive';
import { jumpAndLand, lockPointer, newPlayer, openTitle, soloMatch, unexpectedErrors, zeroLoot } from './support/game';
import { Observer } from './support/observer';
import { startStack, type Stack } from './support/stack';

const NAME = 'QA Lag';
const ZERO = zeroLoot(); // every loot id (M2c included)
const ONLY_SNIPERS = { ...ZERO, sniper: 1 };
// Same bar as M1 B6 (netcode.spec.ts): plain walking at 100 ms + 20 ms jitter already shows corrections of
// 0.28-0.33 m (M1-test-report.md), so stance and ADS must not push them past 0.5 m.
const SNAP_M = 0.5;

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({
    label: 'm2a-latency', layoutSeed: 'baseline', // M2c: pinned layout (seed 0 = the M2b props and loot) so paths are reproducible
    seed: 31337,
    latencyMs: 100,
    jitterMs: 20,
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 2 },
      bots: { reactionMs: 600_000, grenade: { throwChancePerDecision: 0 } },
      loot: { spawnChance: 1, tiers: { common: ONLY_SNIPERS, rare: ONLY_SNIPERS, epic: ONLY_SNIPERS } },
      zone: { phases: [{ waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.5, dps: 1 }] },
    },
  });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('100 ms RTT: walking while C/Z/Space and while scoped never snaps the local player', async ({ browser }) => {
  test.setTimeout(420_000); // walking to a sniper with 100 ms of lag takes 1-3 min under SwiftShader
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  const code = await soloMatch(page, NAME, { map: 'island01' });
  const obs = await Observer.connect(stack.serverPort, code);
  const notes: string[] = [];
  try {
    expect(await lockPointer(page)).toBe(true);
    await jumpAndLand(page, 90_000);
    await expect.poll(async () => (await me(obs, NAME)).anim.dropping, { timeout: 20_000 }).toBe(false);
    const radPerPx = await calibrateLook(page, obs, NAME);

    /** Hold W for `ms` while running `act`, sampling lastCorrection; returns the max correction seen. */
    const sampleWhile = async (ms: number, act: (i: number) => Promise<void>): Promise<number[]> => {
      const seen: number[] = [];
      const end = Date.now() + ms;
      let i = 0;
      while (Date.now() < end) {
        await act(i++);
        await page.waitForTimeout(250);
        seen.push(await hook(page, (g) => g.lastCorrection));
      }
      return seen;
    };

    const c0 = await hook(page, (g) => g.lastCorrection);
    await page.keyboard.down('w');
    const stanceRun = await sampleWhile(9000, async (i) => {
      const k = ['c', 'z', 'Space', 'Space', 'z', 'z'][i % 6]!;
      if (i % 3 === 0) await page.keyboard.press(k);
    });
    await page.keyboard.up('w');
    const changed = stanceRun.filter((c, i) => c !== (i === 0 ? c0 : stanceRun[i - 1]));
    notes.push(`stance walk: lastCorrection samples ${stanceRun.map((c) => c.toFixed(3)).join(' ')}`);
    expect(Math.max(...stanceRun), 'no snap while walking through stance changes').toBeLessThan(SNAP_M);
    notes.push(`stance walk: ${changed.length} new corrections`);

    // Settle standing, then fetch a sniper and walk scoped (ADS move multiplier is predicted).
    await page.keyboard.press('Space');
    await page.waitForTimeout(1500);
    const s = await hook(page, (g) => g.stance);
    if (s !== 'stand') {
      await page.keyboard.press(s === 'prone' ? 'z' : 'c');
      await page.waitForTimeout(1500);
    }
    const got = await fetchLoot(page, obs, NAME, (l) => l.item === 'sniper', radPerPx, notes);
    expect(got).not.toBeNull();
    await expect.poll(() => hook(page, (g) => g.localWeapon), { timeout: 5000 }).toBe('sniper');
    await page.mouse.down({ button: 'right' });
    await page.keyboard.down('w');
    const adsRun = await sampleWhile(6000, async (i) => {
      if (i === 8) await page.keyboard.down('Shift'); // sprint pressed while aiming must not sprint
    });
    await page.keyboard.up('Shift');
    await page.keyboard.up('w');
    await page.mouse.up({ button: 'right' });
    notes.push(`scoped walk: lastCorrection samples ${adsRun.map((c) => c.toFixed(3)).join(' ')}`);
    expect(Math.max(...adsRun), 'no snap while walking scoped').toBeLessThan(SNAP_M);
    expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  } finally {
    console.log(notes.join('\n'));
    test.info().annotations.push({ type: 'notes', description: notes.join('\n') });
    obs.close();
    await ctx.close();
  }
});
