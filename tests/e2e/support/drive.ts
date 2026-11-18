/**
 * Closed-loop driving helpers for E2E specs (owner: qa-tester): look, turn, walk to a point and pick up loot, using the
 * observer's authoritative snapshots for feedback. Headless Chromium runs at ~9-13 fps and applies key-up late, so
 * walking uses short W pulses with settle time (see TEST_PLAN.md "Known harness limits").
 */
import { expect, type Page } from '@playwright/test';
import type { DevGameState } from '../../../src/game/devHook';
import { dist2, wrap, yawTo, type ObsLoot, type ObsPlayer, type Observer, type Vec3 } from './observer';

/** Synthetic relative mouse move (pointer-locked look input; page.mouse.move nets zero under pointer lock). */
export async function look(page: Page, dx: number, dy = 0): Promise<void> {
  await page.evaluate(
    ([x, y]) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: x, movementY: y, bubbles: true })),
    [dx, dy] as const,
  );
}

export async function me(obs: Observer, name: string): Promise<ObsPlayer> {
  await obs.fresh();
  const p = obs.player(name);
  if (!p) throw new Error(`${name} not in snapshot`);
  return p;
}

/** Measured look gain (rad per px) at the current sensitivity: +100 px right, then back. */
export async function calibrateLook(page: Page, obs: Observer, name: string): Promise<number> {
  const y0 = (await me(obs, name)).yaw;
  await look(page, 100);
  await page.waitForTimeout(500);
  const y1 = (await me(obs, name)).yaw;
  const d = Math.abs(wrap(y1 - y0));
  return d > 1e-4 ? d / 100 : 0.0022;
}

export async function turnTo(page: Page, obs: Observer, name: string, targetYaw: number, radPerPx: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const err = wrap(targetYaw - (await me(obs, name)).yaw);
    if (Math.abs(err) < 0.05) return;
    await look(page, -err / radPerPx);
    await page.waitForTimeout(250);
  }
}

/** Walk (W pulses) until within `radius` m of `target` horizontally, or `timeoutMs`. Returns the final distance. */
export async function walkTo(
  page: Page,
  obs: Observer,
  name: string,
  target: () => Vec3 | null,
  radius: number,
  radPerPx: number,
  timeoutMs = 45_000,
): Promise<number> {
  const until = Date.now() + timeoutMs;
  let d = Infinity;
  let best = Infinity;
  let stuck = 0;
  while (Date.now() < until) {
    const t = target();
    if (!t) return d;
    const p = await me(obs, name);
    d = dist2(p.pos, t);
    if (d < radius) return d;
    // No progress over two pulses: a prop is in the way, so side-step (alternating sides) and try again.
    if (d > best - 0.2) stuck++;
    else stuck = 0;
    best = Math.min(best, d);
    if (stuck >= 2) {
      const side = stuck % 4 < 2 ? 'd' : 'a';
      await page.keyboard.down(side);
      await page.waitForTimeout(500);
      await page.keyboard.up(side);
      await page.waitForTimeout(600);
      best = Infinity;
    }
    await turnTo(page, obs, name, yawTo(p.pos, t), radPerPx);
    await page.keyboard.down('w');
    await page.waitForTimeout(Math.min(450, 40 + d * 45));
    await page.keyboard.up('w');
    await page.waitForTimeout(650);
  }
  return d;
}

/** Nearest ground loot matching `pred` to `from`. */
export function nearestLoot(obs: Observer, from: Vec3, pred: (l: ObsLoot) => boolean): ObsLoot | null {
  return obs.latest!.loot.filter(pred).sort((a, b) => dist2(from, a.pos) - dist2(from, b.pos))[0] ?? null;
}

/**
 * Walk to the nearest loot matching `pred` and press E until it is gone (E takes the nearest item, so nearby ammo may
 * come first). Retries with the next nearest item if a bot takes it. Returns the picked item, or null.
 */
export async function fetchLoot(
  page: Page,
  obs: Observer,
  name: string,
  pred: (l: ObsLoot) => boolean,
  radPerPx: number,
  notes: string[],
  perItemMs = 45_000,
): Promise<ObsLoot | null> {
  // Items we could not reach (e.g. on a prop top or behind a wall) are skipped on the next attempt.
  const skip = new Set<number>();
  for (let attempt = 0; attempt < 4; attempt++) {
    const here = await me(obs, name);
    const t = nearestLoot(obs, here.pos, (l) => pred(l) && !skip.has(l.id));
    if (!t) return null;
    const alive = (): Vec3 | null => obs.latest!.loot.find((l) => l.id === t.id)?.pos ?? null;
    const d = await walkTo(page, obs, name, alive, 1.2, radPerPx, perItemMs);
    notes.push(`fetch ${t.item}#${t.id}: reached ${d.toFixed(2)} m`);
    if (!alive()) continue;
    if (d > 1.6) {
      skip.add(t.id);
      continue;
    }
    for (let i = 0; i < 6 && alive(); i++) {
      await page.keyboard.press('e');
      await page.waitForTimeout(900);
      const p = await me(obs, name);
      const pos = alive();
      if (pos && dist2(p.pos, pos) > 1.6) await walkTo(page, obs, name, alive, 1.0, radPerPx, 8000);
    }
    if (!alive()) return t;
    skip.add(t.id);
  }
  return null;
}

/** Read the dev hook (window.__game). */
export async function hook<T>(page: Page, f: (g: DevGameState) => T): Promise<T> {
  return page.evaluate(`(${f.toString()})(window.__game)`) as Promise<T>;
}

export async function waitHook(page: Page, f: (g: DevGameState) => boolean, timeout = 5000, msg?: string): Promise<void> {
  await expect.poll(() => hook(page, f), { timeout, message: msg }).toBe(true);
}
