/**
 * REVIEW-M2c MF2 (qa-tester): the per-match layout generator gives bit-identical results in Chromium and in Node.
 * For 12 seeds on both maps (0, 0xFFFFFFFF and others) the browser builds the layout through the Vite dev server
 * (the real client modules) and the spec compares `layoutHash` and a digest of the whole layout (decor, picks, look)
 * with Node (tsx child process) computed in the same run, so golden-value changes upstream do not matter.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { newPlayer, openTitle, unexpectedErrors } from './support/game';
import { startStack, type Stack } from './support/stack';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SEEDS = [0, 0xffffffff, 1, 2, 7, 42, 4821, 65535, 0x7fffffff, 0x80000000, 1234567, 314159265];
type Res = Record<string, { hash: number; digest: number; look: string; props: number; decor: number }>;

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ label: 'm2c-layout' });
});
test.afterAll(async () => {
  await stack?.stop();
});

test('layoutHash and the full layout digest are identical in Chromium and Node for 12 seeds on both maps', async ({ browser }) => {
  test.setTimeout(180_000);
  const node = JSON.parse(
    execFileSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'tests/e2e/support/layout-node.ts'), JSON.stringify(SEEDS)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Res;
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  const web = (await page.evaluate(async (seeds: number[]) => {
    // Module paths as strings so TypeScript does not resolve them; Vite serves /src/* in dev.
    const LEVELS = '/src/game/levels/index.ts';
    const LAYOUT = '/src/game/levels/layout/index.ts';
    const levels = (await import(/* @vite-ignore */ LEVELS)) as { getMap(id: string): unknown };
    const lay = (await import(/* @vite-ignore */ LAYOUT)) as {
      buildMatchLayout(base: unknown, seed: number): { hash: number; look: string; props: unknown[]; decor: unknown[] };
    };
    const fnv = (s: string): number => {
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h >>> 0;
    };
    const out: Record<string, unknown> = {};
    for (const mapId of ['island01', 'office']) {
      const base = levels.getMap(mapId);
      for (const seed of seeds) {
        const l = lay.buildMatchLayout(base, seed);
        out[`${mapId}:${seed}`] = { hash: l.hash, digest: fnv(JSON.stringify(l)), look: l.look, props: l.props.length, decor: l.decor.length };
      }
    }
    return out;
  }, SEEDS)) as Res;
  const rows = Object.keys(node).map((k) => `${k} node ${node[k]!.hash.toString(16)} / ${node[k]!.digest.toString(16)} web ${web[k]?.hash.toString(16)} / ${web[k]?.digest.toString(16)} ${node[k]!.look} props ${node[k]!.props} decor ${node[k]!.decor}`);
  console.log(rows.join('\n'));
  expect(Object.keys(web).sort()).toEqual(Object.keys(node).sort());
  expect(Object.keys(node)).toHaveLength(SEEDS.length * 2);
  for (const k of Object.keys(node)) {
    expect(web[k]!.hash, `${k} layoutHash`).toBe(node[k]!.hash);
    expect(web[k]!.digest, `${k} full layout digest (decor, picks, look)`).toBe(node[k]!.digest);
  }
  // Seeds really vary the layout (not one constant result).
  expect(new Set(Object.values(node).map((r) => r.hash)).size).toBeGreaterThan(SEEDS.length);
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});
