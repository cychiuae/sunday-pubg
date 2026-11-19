/**
 * Office nav paths for E2E specs (qa-tester): runs tests/e2e/support/office-path.ts in a tsx child process (so the
 * Playwright loader never imports src/) and walks the result with the observer-driven walker.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { walkTo } from './drive';
import { dist2, type Observer, type Vec3 } from './observer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Nav path points on the office for `layoutSeed` (0 = baseline), or null when unreachable. */
export function officePaths(reqs: { layoutSeed: number; from: Vec3; to: Vec3 }[]): (Vec3[] | null)[] {
  return JSON.parse(
    execFileSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'tests/e2e/support/office-path.ts'), JSON.stringify(reqs)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    }),
  ) as (Vec3[] | null)[];
}

/**
 * Walk a nav path point by point (W pulses + closed-loop turns). Straight segments between nav points are clear for a
 * player-sized agent, so the walker's side-steps rarely trigger. Returns the final distance to the last point.
 */
export async function followPath(page: Page, obs: Observer, name: string, points: Vec3[], radPerPx: number, timeoutMs = 120_000, notes?: string[]): Promise<number> {
  const until = Date.now() + timeoutMs;
  let d = Infinity;
  for (let i = 1; i < points.length && Date.now() < until; i++) {
    const p = points[i]!;
    const last = i === points.length - 1;
    d = await walkTo(page, obs, name, () => p, last ? 0.8 : 1.5, radPerPx, Math.min(45_000, until - Date.now()));
    if (!last && d > 3) notes?.push(`followPath: stalled ${d.toFixed(2)} m before point ${i} (${p.x}, ${p.z})`);
  }
  if (points.length === 1) d = dist2(obs.player(name)?.pos ?? points[0]!, points[0]!);
  return d;
}
