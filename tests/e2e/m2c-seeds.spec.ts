/**
 * M2c layout visual sanity and render budget (qa-tester, Phase 3): 3 pinned layout seeds per map. For each, a solo
 * private room: canvas screenshots aboard (carrier overview), during the drop and on foot looking around, and the
 * renderer's draw calls / triangles (window.__render) sampled through all of it. Budget (variety.md §7, LV13b): office
 * <= 150 calls at the default (medium) quality; island <= 250 calls, <= 600k triangles.
 * Screenshots: test-results/shots/m2c-seed-<map>-<seed>-*.png.
 */
import { expect, test } from '@playwright/test';
import { game, jumpAndLand, lockPointer, newPlayer, openTitle, renderStats, SHOTS, soloMatch, unexpectedErrors } from './support/game';
import { look } from './support/drive';
import { startStack } from './support/stack';

const CASES: { map: 'island01' | 'office'; seed: number }[] = [
  { map: 'island01', seed: 17 },
  { map: 'island01', seed: 0xc0ffee },
  { map: 'island01', seed: 3000000001 },
  { map: 'office', seed: 23 },
  { map: 'office', seed: 0xbadcafe },
  { map: 'office', seed: 4000000003 },
];
const BUDGET = { island01: { calls: 250, tris: 600_000 }, office: { calls: 150, tris: 600_000 } };
const summary: string[] = [];

test.afterAll(() => console.log(summary.join('\n')));

for (const c of CASES) {
  test(`${c.map} layout seed ${c.seed}: screenshots aboard / drop / on foot; draw calls within budget; no console errors`, async ({ browser }) => {
    test.setTimeout(180_000);
    const stack = await startStack({
      label: `m2c-seed-${c.map}-${c.seed}`,
      layoutSeed: c.seed,
      balance: { match: { countdownSeconds: 4, targetPlayers: 12 }, bots: { reactionMs: 600_000 } },
    });
    const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
    try {
      await openTitle(page);
      await soloMatch(page, `Seed ${c.seed % 1000}`, { map: c.map });
      expect(await game(page, (g) => g.mapId)).toBe(c.map);
      expect(await lockPointer(page)).toBe(true);
      let maxCalls = 0;
      let maxTris = 0;
      const sample = async (): Promise<void> => {
        const rs = await renderStats(page);
        if (rs) {
          maxCalls = Math.max(maxCalls, rs.calls);
          maxTris = Math.max(maxTris, rs.triangles);
        }
      };
      const tag = `${SHOTS}/m2c-seed-${c.map}-${c.seed}`;
      await page.waitForTimeout(1500);
      await sample();
      await page.locator('#app canvas').screenshot({ path: `${tag}-aboard.png` });
      await jumpAndLand(page, 90_000);
      await sample();
      await page.locator('#app canvas').screenshot({ path: `${tag}-landed.png` });
      for (let i = 0; i < 4; i++) {
        await look(page, 300);
        await page.waitForTimeout(500);
        await sample();
      }
      await page.locator('#app canvas').screenshot({ path: `${tag}-look.png` });
      const quality = await page.evaluate(() => (JSON.parse(localStorage.getItem('bsp.settings.v1') ?? '{}') as { quality?: string }).quality ?? 'default');
      summary.push(`${c.map} seed ${c.seed} (0x${c.seed.toString(16)}): max draw calls ${maxCalls}, max triangles ${maxTris}, quality ${quality}`);
      expect(maxCalls).toBeGreaterThan(0);
      expect(maxCalls, `${c.map} draw calls`).toBeLessThanOrEqual(BUDGET[c.map].calls);
      expect(maxTris, `${c.map} triangles`).toBeLessThanOrEqual(BUDGET[c.map].tris);
      expect(log.all.filter((l) => /layout mismatch/i.test(l))).toEqual([]);
      expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
    } finally {
      await ctx.close();
      await stack.stop();
    }
  });
}
