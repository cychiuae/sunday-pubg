/**
 * M2b carrier drop and first-person camera through the real browser client (qa-tester, Phase D).
 *
 * One player in a private island room (bots filled, passive): aboard = carrier orbit; Space at the door ->
 * freefall -> chute -> on foot, with the drop HUD and no prediction correction; on foot = first person at the stance
 * eye with the viewmodel; the FOV setting changes the camera FOV (Hor+, camera.md QA 4) but not the ADS FOV
 * (QA 5); rifle ADS = red dot (no scope overlay, viewmodel stays, 1.6x magnification). A second browser joins the
 * running match by code, spectates in first person, and V toggles the 3P chase view and back.
 *
 * Canvas screenshots: test-results/shots/m2b-fp-*.png.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { calibrateLook, fetchLoot, hook, me, waitHook } from './support/drive';
import { game, joinByCode, lockPointer, newPlayer, openTitle, SHOTS, soloMatch, toBrowser, ui, unexpectedErrors, type ConsoleLog, zeroLoot } from './support/game';
import { Observer } from './support/observer';
import { startStack, type Stack } from './support/stack';

const NAME = 'QA First';
const ZERO_ALL = zeroLoot(); // every loot id (M2c included)
const RIFLES = { ...ZERO_ALL, rifle: 1 };
const deg = (r: number): number => (r * 180) / Math.PI;
const rad = (d: number): number => (d * Math.PI) / 180;
/** camera.md "Field of view": horizontal at 16:9 -> vertical. */
const vFov = (hDeg: number): number => deg(2 * Math.atan(Math.tan(rad(hDeg) / 2) / (16 / 9)));
const adsFov = (vDeg: number, zoom: number): number => deg(2 * Math.atan(Math.tan(rad(vDeg) / 2) / zoom));

let stack: Stack;
let ctx: BrowserContext;
let page: Page;
let log: ConsoleLog;
let obs: Observer;
let code = '';
let radPerPx = 0.0022;
const notes: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  stack = await startStack({
    label: 'm2b-fp', layoutSeed: 'baseline', // M2c: pinned layout (seed 0 = the M2b props and loot) so paths are reproducible
    seed: 9090,
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 3 },
      bots: { reactionMs: 600_000, grenade: { throwChancePerDecision: 0 } },
      loot: { spawnChance: 1, tiers: { common: RIFLES, rare: RIFLES, epic: RIFLES } },
      zone: { phases: [{ waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.5, dps: 1 }] },
    },
  });
  ({ ctx, page, log } = await newPlayer(browser, stack.baseURL));
  await openTitle(page);
  code = await soloMatch(page, NAME, { map: 'island01' });
  obs = await Observer.connect(stack.serverPort, code);
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  obs?.close();
  await ctx?.close();
  await stack?.stop();
});

async function shot(label: string, p: Page = page): Promise<void> {
  await p.locator('#app canvas').screenshot({ path: `${SHOTS}/m2b-fp-${label}.png` });
}

async function ensureLocked(): Promise<void> {
  if (!(await page.evaluate(() => document.pointerLockElement !== null))) expect(await lockPointer(page)).toBe(true);
}

test('carrier drop: carrier view aboard; Space -> freefall -> chute -> on foot; drop HUD; no prediction correction', async () => {
  test.setTimeout(120_000);
  expect(await game(page, (g) => ({ aboard: g.aboard, view: g.cameraView, map: g.mapId }))).toEqual({ aboard: true, view: 'carrier', map: 'island01' });
  await expect(page.locator('.ui-drop')).toHaveClass(/is-aboard/);
  await shot('aboard');
  await ensureLocked();
  // Sample once per rendered frame (the hook changes only per frame) and record the frame gap.
  await page.evaluate(() => {
    const w = window as unknown as { __trace: unknown[]; __game: Record<string, unknown> & { localPos: { y: number } | null } };
    w.__trace = [];
    let last = performance.now();
    const push = (gap: number): void => {
      const g = w.__game;
      const d = document.querySelector('.ui-drop');
      w.__trace.push({
        aboard: g['aboard'], phase: g['dropPhase'], cam: g['cameraView'], corr: g['lastCorrection'], y: g.localPos?.y ?? null,
        hud: d && getComputedStyle(d).display !== 'none' ? d.className : null, gap,
      });
    };
    push(0);
    const frame = (): void => {
      const now = performance.now();
      push(now - last);
      last = now;
      if (w.__trace.length < 5000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  // Space presses before route.noJumpUntil are ignored; keep pressing until the jump happens.
  const t0 = Date.now();
  let presses = 0;
  while ((await game(page, (g) => g.aboard)) && Date.now() - t0 < 30_000) {
    await page.keyboard.press('Space');
    presses++;
    await page.waitForTimeout(200);
  }
  let shotFree = false;
  let shotChute = false;
  while (Date.now() - t0 < 60_000) {
    const ph = await game(page, (g) => g.dropPhase);
    if (ph === 'freefall' && !shotFree) {
      shotFree = true;
      await shot('freefall');
    }
    if (ph === 'chute' && !shotChute) {
      shotChute = true;
      // Look straight up (pitch clamps at +80 deg): the canopy is visible overhead in the chute (camera.md QA 12).
      // Three 300 px moves (one large event would be clipped by the BUG-002 spike filter).
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -300, bubbles: true })));
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(250);
      notes.push(`chute look-up pitch ${(((await game(page, (g) => g.localPitch)) * 180) / Math.PI).toFixed(1)} deg, phase ${await game(page, (g) => g.dropPhase)}`);
      await shot('chute-look-up');
    }
    if (ph === null && !(await game(page, (g) => g.aboard))) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(400);
  type S = { aboard: boolean; phase: string | null; cam: string | null; corr: number; y: number | null; hud: string | null; gap: number };
  const tr = (await page.evaluate(() => (window as unknown as { __trace: unknown[] }).__trace)) as S[];
  const seq: string[] = [];
  for (const s of tr) {
    const k = s.aboard ? 'aboard' : s.phase ?? 'foot';
    if (seq.at(-1) !== k) seq.push(k);
  }
  const maxCorr = Math.max(...tr.map((s) => s.corr));
  notes.push(`drop: ${presses} Space presses; sequence ${seq.join(' > ')}; max lastCorrection ${maxCorr.toFixed(3)} m; ${tr.length} samples`);
  const corrChanges = tr.flatMap((s, i) =>
    i > 0 && s.corr !== tr[i - 1]!.corr ? [`#${i} ${s.aboard ? 'aboard' : s.phase ?? 'foot'} y ${s.y?.toFixed(2)} corr ${s.corr.toFixed(3)} after a ${s.gap.toFixed(0)} ms frame`] : [],
  );
  const gaps = tr.map((s) => s.gap).sort((x, y) => x - y);
  const maxGap = gaps.at(-1) ?? 0;
  notes.push(`  frame gaps: median ${gaps[gaps.length >> 1]?.toFixed(0)} ms, max ${maxGap.toFixed(0)} ms`);
  notes.push(`  correction changes: ${corrChanges.join(' | ') || 'none'}`);
  expect(seq).toEqual(['aboard', 'freefall', 'chute', 'foot']);
  expect(tr.filter((s) => s.aboard).every((s) => s.cam === 'carrier')).toBe(true);
  expect(tr.filter((s) => !s.aboard && s.phase !== null).every((s) => s.cam === 'firstPerson'), 'freefall and chute are FP').toBe(true);
  expect(tr.filter((s) => s.phase === 'freefall').every((s) => s.hud?.includes('is-falling'))).toBe(true);
  expect(tr.filter((s) => s.phase === 'chute').every((s) => s.hud?.includes('is-falling'))).toBe(true);
  // At a steady frame rate the drop must reconcile with no correction (owner: src/game/dropPrediction.test.ts). This
  // headless Chromium renders with SwiftShader at a few fps; a frame stall longer than the server's input repeat
  // budget (200 ms) makes the server run ticks the client never predicted, which shows up as corrections of exactly
  // n ticks of fall (30 m/s -> 1.000 m, 8 m/s -> 0.267 m). Then only that signature is accepted.
  if (maxGap < 150) expect(maxCorr, 'no reconciliation through jump, freefall, chute and landing').toBeLessThan(0.05);
  else {
    // The landing tick is a partial tick (feet clamp to the ground), so it only needs to be under one chute tick.
    for (const s of tr.filter((x) => x.corr > 0.01 && x.phase === null && !x.aboard)) expect(s.corr).toBeLessThan(0.27);
    for (const s of tr.filter((x) => x.corr > 0.01 && x.phase !== null)) {
      const ticks = [s.corr / 1.0, s.corr / (8 / 30), s.corr / (30 / 30 + 8 / 30)];
      expect(ticks.some((n) => Math.abs(n - Math.round(n)) < 0.03), `correction ${s.corr} is a whole number of fall ticks`).toBe(true);
    }
  }
  await expect.poll(async () => (await me(obs, NAME)).anim.dropping, { timeout: 5000 }).toBe(false);
  expect((await me(obs, NAME)).hp).toBe(100);
});

test('on foot: first person at the stance eye, viewmodel visible, FOV setting (Hor+) applies, default 80 = 50.5 vertical', async () => {
  await ensureLocked();
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 400, bubbles: true })));
  await page.waitForTimeout(500);
  const s = await game(page, (g) => ({ view: g.cameraView, fp: g.cameraFirstPerson, eye: g.cameraEyeHeight, fov: g.cameraFovDeg, vm: g.viewmodel }));
  notes.push(`on foot: ${JSON.stringify(s)}`);
  expect(s.view).toBe('firstPerson');
  expect(s.eye!).toBeCloseTo(1.05, 2);
  expect(s.fov).toBeCloseTo(vFov(80), 1);
  expect(s.vm?.visible).toBe(true);
  await shot('onfoot');

  const setFov = async (v: number): Promise<void> => {
    await page.evaluate(() => document.exitPointerLock());
    await expect(ui.play(page)).toBeVisible({ timeout: 5000 });
    await page.locator('.ui-screen--play').getByRole('button', { name: /settings/i }).click();
    await expect(ui.settings(page)).toBeVisible();
    await page.locator('#ui-set-fov').evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.value = String(val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
    await page.keyboard.press('Escape');
    await expect(ui.settings(page)).toBeHidden();
    await ensureLocked();
    await page.waitForTimeout(300);
  };
  await setFov(100);
  const f100 = await game(page, (g) => g.cameraFovDeg);
  await shot('fov100');
  await setFov(70);
  const f70 = await game(page, (g) => g.cameraFovDeg);
  notes.push(`FOV setting 100 -> ${f100.toFixed(2)} (expect ${vFov(100).toFixed(2)}); 70 -> ${f70.toFixed(2)} (expect ${vFov(70).toFixed(2)})`);
  expect(f100).toBeCloseTo(vFov(100), 1);
  expect(f70).toBeCloseTo(vFov(70), 1);
  const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('bsp.settings.v1'))) ?? '{}') as { fovDeg?: number };
  expect(stored.fovDeg).toBe(70);
});

test('rifle ADS = red dot: viewmodel stays, no scope overlay, 1.6x of the DEFAULT FOV at any slider value', async () => {
  test.setTimeout(240_000);
  await ensureLocked();
  // Level the view again (the previous test looked down) and measure the look gain.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: -400, bubbles: true })));
  radPerPx = await calibrateLook(page, obs, NAME);
  const got = await fetchLoot(page, obs, NAME, (l) => l.item === 'rifle', radPerPx, notes, 30_000);
  expect(got, 'picked a rifle').not.toBeNull();
  await expect.poll(() => game(page, (g) => g.localWeapon), { timeout: 5000 }).toBe('rifle');
  expect(await game(page, (g) => g.sight)).toBe('red_dot');
  const want = adsFov(vFov(80), 1.6);
  // Slider is at 70 from the previous test: the ADS FOV must still be the magnification of the default (QA 5).
  await page.mouse.down({ button: 'right' });
  await waitHook(page, (x) => x.adsProgress === 1 && x.adsCameraBlend > 0.99, 6000, 'full ADS');
  const a = await game(page, (g) => ({ fov: g.cameraFovDeg, scoped: g.scoped, vm: g.viewmodel, view: g.cameraView }));
  await shot('rifle-reddot');
  await page.mouse.up({ button: 'right' });
  notes.push(`rifle ADS at slider 70: ${JSON.stringify(a)} (expect fov ${want.toFixed(2)})`);
  expect(a.scoped).toBe(false);
  expect(a.view).toBe('firstPerson');
  expect(a.vm?.visible).toBe(true);
  expect(a.fov).toBeCloseTo(want, 0);
  await expect(page.locator('.ui-scope')).not.toHaveClass(/is-in/);
  await expect.poll(async () => (await me(obs, NAME)).weapon, { timeout: 3000 }).toBe('rifle');
});

test('spectating: a mid-match joiner sees first person; V toggles the 3P chase view and back', async ({ browser }) => {
  const spec = await newPlayer(browser, stack.baseURL);
  try {
    await openTitle(spec.page);
    await toBrowser(spec.page, 'QA Watcher');
    await joinByCode(spec.page, code);
    // Joining a running match: you spectate it.
    await expect.poll(() => game(spec.page, (g) => g.spectateTargetId !== null), { timeout: 20_000 }).toBe(true);
    expect(await game(spec.page, (g) => g.localAlive)).toBe(false);
    expect(await game(spec.page, (g) => g.cameraView)).toBe('firstPerson');
    await shot('spectate-fp', spec.page);
    const locked = await lockPointer(spec.page);
    notes.push(`spectator pointer lock: ${locked}`);
    await spec.page.keyboard.press('v');
    await expect.poll(() => game(spec.page, (g) => g.cameraView), { timeout: 5000 }).toBe('chase');
    await expect(spec.page.getByText(/V: /i).first()).toBeVisible().catch(() => notes.push('no "V:" hint text found'));
    await shot('spectate-chase', spec.page);
    await spec.page.keyboard.press('v');
    await expect.poll(() => game(spec.page, (g) => g.cameraView), { timeout: 5000 }).toBe('firstPerson');
    expect(unexpectedErrors(spec.log), spec.log.all.join('\n')).toEqual([]);
  } finally {
    await spec.ctx.close();
  }
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
});
