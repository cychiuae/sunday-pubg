/**
 * M2a "Arsenal & Stance" through the real browser client (2a-D1): HUD gear/slots/stance, C/Z/Space stance flow with
 * the camera eye height, no Ctrl binding, slot 4 / G refused without grenades, RMB ADS (hold and toggle) with the
 * sniper scope view, grenade cook -> throw -> explosion, settings persistence, and a 60 s console-clean match.
 *
 * Getting M2a items without a server test hook: BALANCE_OVERRIDE rewrites the loot tables so every spawn is a sniper,
 * a grenade stack or tier-2 armor, and the player walks to them and presses E (real pickups).
 *
 * Client state comes from `window.__game` (src/game/devHook.ts); authoritative state from the observer socket.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { DevGameState } from '../../src/game/devHook';
import { calibrateLook, fetchLoot, hook, look, me, waitHook } from './support/drive';
import { readFileSync } from 'node:fs';
import { jumpAndLand, lockPointer, newPlayer, openTitle, SHOTS, soloMatch, ui, unexpectedErrors, type ConsoleLog, zeroLoot } from './support/game';
import { Observer } from './support/observer';
import { startStack, type Stack } from './support/stack';

const NAME = 'QA Arsenal';
const ZERO_ALL = zeroLoot(); // every loot id (M2c included)
const M2A_LOOT = { ...ZERO_ALL, sniper: 4, grenade: 4, vest_2: 1, helmet_2: 1 };

// Read from balance.json (the client uses the default file) so stance retunes do not break the spec.
const BAL = JSON.parse(readFileSync('docs/design/balance.json', 'utf8')) as {
  player: { eyeHeight: number };
  movement: { stances: Record<'crouch' | 'prone', { eyeHeight: number }> };
};
const STAND_EYE = BAL.player.eyeHeight;
const CROUCH_EYE = BAL.movement.stances.crouch.eyeHeight;
const PRONE_EYE = BAL.movement.stances.prone.eyeHeight;
/** M2b first person: default 80 deg horizontal at 16:9 = 50.5 deg vertical (camera.md QA 4); measured on foot below. */
let BASE_FOV = 50.5;
/** camera.md "Zoom": true magnification from the default vertical FOV. */
const adsFov = (base: number, zoom: number): number => (2 * Math.atan(Math.tan((base * Math.PI) / 360) / zoom) * 180) / Math.PI;

let stack: Stack;
let ctx: BrowserContext;
let page: Page;
let log: ConsoleLog;
let obs: Observer;
let radPerPx = 0.0022;
const notes: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  stack = await startStack({
    label: 'm2a', layoutSeed: 'baseline', // M2c: pinned layout (seed 0 = the M2b props and loot) so paths are reproducible
    seed: 4242,
    balance: {
      match: { countdownSeconds: 4, resultsSeconds: 5, targetPlayers: 2 },
      bots: { reactionMs: 600_000, grenade: { throwChancePerDecision: 0 } },
      loot: { spawnChance: 1, tiers: { common: M2A_LOOT, rare: M2A_LOOT, epic: M2A_LOOT } },
      zone: {
        phases: [
          { waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.5, dps: 1 },
          { waitSeconds: 900, shrinkSeconds: 10, radiusFraction: 0.2, dps: 1 },
        ],
      },
    },
  });
  ({ ctx, page, log } = await newPlayer(browser, stack.baseURL));
  await page.setViewportSize({ width: 960, height: 540 });
  await openTitle(page);
  // M2b: a private island room, host Start, then the carrier drop (Space at the door, land).
  const code = await soloMatch(page, NAME, { map: 'island01' });
  obs = await Observer.connect(stack.serverPort, code);
  expect(await lockPointer(page), 'pointer lock').toBe(true);
  await jumpAndLand(page, 60_000);
  await expect.poll(async () => (await me(obs, NAME)).anim.dropping, { timeout: 20_000 }).toBe(false);
  BASE_FOV = (await hook(page, (x) => x.cameraFovDeg)) ?? BASE_FOV;
  notes.push(`on-foot FP vertical FOV ${BASE_FOV.toFixed(2)}`);
  radPerPx = await calibrateLook(page, obs, NAME);
  notes.push(`radPerPx ${radPerPx.toFixed(5)}`);
});

test.afterAll(async () => {
  console.log(notes.join('\n'));
  obs?.close();
  await ctx?.close();
  await stack?.stop();
});

async function g(): Promise<DevGameState> {
  return hook(page, (x) => x);
}

/** Re-take pointer lock if a previous step (or a slow page) lost it. */
async function ensureLocked(): Promise<void> {
  if (!(await page.evaluate(() => document.pointerLockElement !== null))) expect(await lockPointer(page)).toBe(true);
}

test('HUD: vest and helmet cells, four slots and the stance icon', async () => {
  await expect(ui.hud(page)).toBeVisible();
  await expect(page.locator('.ui-gear--vest')).toBeVisible();
  await expect(page.locator('.ui-gear--helmet')).toBeVisible();
  await expect(ui.slots(page)).toHaveCount(4);
  await expect(page.locator('.ui-stance')).toBeVisible();
  await expect(page.locator('.ui-stance')).toHaveAttribute('data-stance', 'stand');
  const s = await g();
  expect(s).toMatchObject({ stance: 'stand', vestTier: 0, helmetTier: 0, grenades: 0, localWeapon: 'fists' });
  await page.screenshot({ path: `${SHOTS}/m2a-hud.png` });
  // BUG-009 (fixed): at 960x540 every gear cell's content fits inside the cell (no text past the right border).
  const overflow = await page.locator('.ui-gear').evaluateAll((cells) =>
    cells.map((c) => {
      const cell = c.getBoundingClientRect();
      const worst = Math.max(...[...c.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right));
      return { cls: c.className, over: Math.round((worst - cell.right) * 10) / 10, scroll: c.scrollWidth - c.clientWidth };
    }),
  );
  notes.push(`gear cells at 960x540: ${JSON.stringify(overflow)}`);
  for (const o of overflow) {
    expect(o.over, `${o.cls} content past the right edge`).toBeLessThanOrEqual(0.5);
    expect(o.scroll, `${o.cls} scroll overflow`).toBeLessThanOrEqual(0);
  }
  await page.locator('.ui-hud__bl').screenshot({ path: `${SHOTS}/m2a-hud-gear-960.png` });
});

test('slot 4 and G with no grenades are refused (weapon stays, "No grenades" toast)', async () => {
  await ensureLocked();
  const before = (await g()).localWeapon;
  // The refusal toast lives about 2 s and appears after a server round trip, so record every toast text instead of
  // polling it (M2c: the throwable slot refusal reads "No throwables", M2C-UI-13).
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    const el = document.querySelector('.ui-toasts')!;
    new MutationObserver(() => w.__toasts.push(el.textContent ?? '')).observe(el, { childList: true, subtree: true, characterData: true });
  });
  await page.keyboard.press('4');
  await page.waitForTimeout(600);
  expect((await g()).localWeapon).toBe(before);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts.some((t) => /no (grenades|throwables)/i.test(t))), { timeout: 5000 })
    .toBe(true);
  await page.keyboard.press('g');
  await page.waitForTimeout(600);
  expect((await g()).localWeapon).toBe(before);
  expect((await me(obs, NAME)).weapon).toBe(before);
});

test('Ctrl is unbound; RMB with fists does not aim', async () => {
  await ensureLocked();
  await page.keyboard.down('Control');
  await page.waitForTimeout(700);
  await page.keyboard.up('Control');
  await page.waitForTimeout(500);
  const s = await g();
  expect(s.stance).toBe('stand');
  expect((await me(obs, NAME)).stance).toBe('stand');
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(900);
  const a = await g();
  await page.mouse.up({ button: 'right' });
  expect(a.adsProgress).toBe(0);
  expect(a.cameraFovDeg).toBeCloseTo(BASE_FOV, 0);
});

test('C crouch, Z prone, Space prone -> crouch -> stand; eye height follows; server agrees; no big corrections', async () => {
  await ensureLocked();
  let lastKey = '';
  const settle = async (stance: string, eye: number): Promise<void> => {
    await waitHook(page, (x) => x.stanceProgress === 1, 6000, `settle ${stance}`);
    // A headless page can drop a key event: one re-press (logged) when the stance did not change at all.
    if ((await g()).stance !== stance && lastKey) {
      notes.push(`stance ${stance}: key ${lastKey} had no effect; pressed again`);
      await page.keyboard.press(lastKey);
      await waitHook(page, (x) => x.stanceProgress === 1 && x.stance !== null, 6000, `settle ${stance} (retry)`);
    }
    const s = await g();
    expect(s.stance).toBe(stance);
    expect(s.cameraEyeHeight!).toBeCloseTo(eye, 1);
    await expect.poll(async () => (await me(obs, NAME)).stance, { timeout: 4000 }).toBe(stance);
    await expect(page.locator('.ui-stance')).toHaveAttribute('data-stance', stance);
    notes.push(`${stance}: eye ${s.cameraEyeHeight?.toFixed(3)}, lastCorrection ${s.lastCorrection.toFixed(3)} m`);
  };
  const c0 = (await g()).lastCorrection;
  await settle('stand', STAND_EYE);
  lastKey = 'c';
  await page.keyboard.press('c');
  await settle('crouch', CROUCH_EYE);
  lastKey = 'z';
  await page.keyboard.press('z');
  await settle('prone', PRONE_EYE);
  await page.screenshot({ path: `${SHOTS}/m2a-prone.png` });
  lastKey = 'Space';
  await page.keyboard.press('Space');
  await settle('crouch', CROUCH_EYE);
  lastKey = 'Space';
  await page.keyboard.press('Space');
  await settle('stand', STAND_EYE);
  // Prone straight to stand with Z, and C toggles back.
  lastKey = 'z';
  await page.keyboard.press('z');
  await settle('prone', PRONE_EYE);
  lastKey = 'z';
  await page.keyboard.press('z');
  await settle('stand', STAND_EYE);
  const c1 = (await g()).lastCorrection;
  notes.push(`lastCorrection before ${c0.toFixed(3)}, after stance flow ${c1.toFixed(3)}`);
  // Standing still through stance changes must not need a visible reconciliation snap.
  expect(c1).toBeLessThan(0.1);
  // Space while standing still jumps (server sees airborne), stance stays stand.
  const t0 = obs.latest!.tick;
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  expect(obs.track(NAME, t0).some((x) => x.p.anim.airborne)).toBe(true);
  expect((await me(obs, NAME)).stance).toBe('stand');
});

test('pick up a sniper (real E pickup) and the HUD shows it with its scope sight', async () => {
  test.setTimeout(150_000);
  await ensureLocked();
  const got = await fetchLoot(page, obs, NAME, (l) => l.item === 'sniper', radPerPx, notes);
  expect(got, 'reached and picked a sniper').not.toBeNull();
  await expect.poll(async () => (await g()).localWeapon, { timeout: 5000 }).toBe('sniper');
  expect((await g()).sight).toBe('scope_8x');
  await expect.poll(async () => (await me(obs, NAME)).weapon, { timeout: 3000 }).toBe('sniper');
});

test('RMB hold: FOV narrows to the 8x magnification of the default FOV, then the scope view (first person + overlay); release restores', async () => {
  await ensureLocked();
  expect((await g()).localWeapon).toBe('sniper');
  await page.mouse.down({ button: 'right' });
  await waitHook(page, (x) => x.scoped && x.cameraFirstPerson, 6000, 'scoped');
  const s = await g();
  notes.push(`scoped: fov ${s.cameraFovDeg.toFixed(2)}, adsProgress ${s.adsProgress}, blend ${s.adsCameraBlend}`);
  expect(s.ads).toBe(true);
  expect(s.adsProgress).toBe(1);
  expect(s.cameraFovDeg).toBeCloseTo(adsFov(BASE_FOV, 8), 0);
  await expect(page.locator('.ui-scope')).toHaveClass(/is-in/);
  await expect(page.locator('.ui-scope')).toHaveAttribute('data-sight', 'scope_8x');
  await expect.poll(async () => (await me(obs, NAME)).anim.ads, { timeout: 3000 }).toBe(true);
  await page.screenshot({ path: `${SHOTS}/m2a-scoped.png` });
  await page.mouse.up({ button: 'right' });
  await waitHook(page, (x) => !x.scoped && !x.ads, 5000, 'unscoped');
  await expect.poll(async () => (await g()).cameraFovDeg, { timeout: 4000 }).toBeGreaterThan(BASE_FOV - 1);
  // M2b: on foot is always first person (camera.md); the scope overlay is what goes away.
  expect((await g()).cameraView).toBe('firstPerson');
  await expect(page.locator('.ui-scope')).not.toHaveClass(/is-in/);
});

test('ADS while sprinting: pressing RMB cancels the sprint (server never sprints while aiming)', async () => {
  await ensureLocked();
  await page.keyboard.down('Shift');
  await page.keyboard.down('w');
  await page.waitForTimeout(800);
  await page.mouse.down({ button: 'right' });
  await page.waitForTimeout(1200);
  const t0 = obs.latest!.tick;
  await page.waitForTimeout(800);
  const tr = obs.track(NAME, t0);
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  const both = tr.filter((x) => x.p.anim.ads && x.p.anim.sprinting).length;
  notes.push(`sprint+ADS window: ${tr.length} snapshots, ads ${tr.filter((x) => x.p.anim.ads).length}, ads&sprinting ${both}`);
  expect(tr.some((x) => x.p.anim.ads)).toBe(true);
  expect(both).toBe(0);
  await page.waitForTimeout(800);
});

test('Settings in a match: Aim mode Toggle and ADS sensitivity apply; RMB click latches, second click releases', async () => {
  // A real Esc makes the browser release the pointer lock; CDP key events do not reach the browser UI, so the test
  // releases the lock the same way (exitPointerLock) and checks the pause overlay with the settings gear appears.
  await page.evaluate(() => document.exitPointerLock());
  await expect(ui.play(page)).toBeVisible({ timeout: 5000 });
  await page.locator('.ui-screen--play').getByRole('button', { name: /settings/i }).click();
  await expect(ui.settings(page)).toBeVisible();
  await expect(page.locator('#ui-set-aim-hold')).toBeChecked();
  await page.locator('label[for="ui-set-aim-toggle"]').click();
  await expect(page.locator('#ui-set-aim-toggle')).toBeChecked();
  await page.locator('#ui-set-ads-sens').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '0.5';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.screenshot({ path: `${SHOTS}/m2a-settings.png` });
  await page.keyboard.press('Escape');
  await expect(ui.settings(page)).toBeHidden();
  await ensureLocked();
  // Toggle: one click (down + up) keeps ADS on after the button is released.
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await waitHook(page, (x) => x.ads && x.scoped, 6000, 'toggle latched on');
  await page.waitForTimeout(1500);
  expect((await g()).ads, 'still aiming 1.5 s after release').toBe(true);
  // ADS sensitivity 0.5 at 8x: the same mouse move turns 8 x 2 = 16 x less than unscoped.
  // Four 100 px moves (one 400 px event would be clipped to 300 px by the BUG-002 spike filter).
  const y0 = (await me(obs, NAME)).yaw;
  for (let i = 0; i < 4; i++) {
    await look(page, 100);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(700);
  const dScoped = Math.abs((await me(obs, NAME)).yaw - y0);
  const expected = (400 * radPerPx * 0.5) / 8;
  notes.push(`scoped look 4 x 100 px: ${dScoped.toFixed(4)} rad (expected ~${expected.toFixed(4)})`);
  expect(dScoped).toBeGreaterThan(expected * 0.75);
  expect(dScoped).toBeLessThan(expected * 1.33);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await waitHook(page, (x) => !x.ads && !x.scoped, 6000, 'toggle released');
  const stored = JSON.parse((await page.evaluate(() => localStorage.getItem('bsp.settings.v1'))) ?? '{}') as Record<string, unknown>;
  expect(stored).toMatchObject({ adsMode: 'toggle', adsSensitivity: 0.5 });
});

test('grenades: pick up, G equips, LMB hold cooks (arc + fuse), release throws, the server explodes it', async () => {
  test.setTimeout(150_000);
  await ensureLocked();
  const got = await fetchLoot(page, obs, NAME, (l) => l.item === 'grenade', radPerPx, notes);
  expect(got, 'picked a grenade stack').not.toBeNull();
  await expect.poll(async () => (await g()).grenades, { timeout: 5000 }).toBeGreaterThan(0);
  const n0 = (await g()).grenades;
  await page.keyboard.press('g');
  await expect.poll(async () => (await g()).localWeapon, { timeout: 4000 }).toBe('grenade');
  await expect(page.locator('.ui-slot').nth(3)).toHaveClass(/is-active|active/);
  await page.waitForTimeout(600); // swapMs
  const myId = (await me(obs, NAME)).id;
  const thrown0 = obs.eventsOf('grenadeThrown').filter((e) => e.ownerId === myId).length;
  await look(page, 0, -60); // aim a little up
  await page.mouse.down();
  await waitHook(page, (x) => x.cooking, 5000, 'cooking');
  const c = await g();
  notes.push(`cooking: fuse ${c.cookFuseMs} ms, arc ${c.grenadeArc}`);
  expect(c.grenadeArc).toBe(true);
  expect(c.cookFuseMs).not.toBeNull();
  expect(c.cookFuseMs!).toBeLessThanOrEqual(3500);
  await expect(page.locator('.ui-cook')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/m2a-cooking.png` });
  await page.waitForTimeout(500);
  await page.mouse.up();
  await expect.poll(() => obs.eventsOf('grenadeThrown').filter((e) => e.ownerId === myId).length, { timeout: 5000 }).toBeGreaterThan(thrown0);
  const thrown = obs.eventsOf('grenadeThrown').filter((e) => e.ownerId === myId).at(-1)!;
  expect(thrown.dropped).toBe(false);
  await expect.poll(async () => (await g()).liveGrenades.length, { timeout: 3000 }).toBeGreaterThan(0);
  await expect
    .poll(() => obs.eventsOf('explosion').some((e) => e.id === thrown.id), { timeout: 6000, message: 'server explosion for our grenade' })
    .toBe(true);
  expect((await g()).grenades).toBe(n0 - 1);
  await expect.poll(async () => (await g()).liveGrenades.length, { timeout: 3000 }).toBe(0);
  expect((await me(obs, NAME)).alive).toBe(true);
});

test('settings persist across a reload (Aim mode Toggle, ADS sensitivity 0.5)', async () => {
  await page.reload();
  await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
  await page.locator('.ui-screen--title').getByRole('button', { name: /settings/i }).click();
  await expect(page.locator('#ui-set-aim-toggle')).toBeChecked();
  await expect(page.locator('#ui-set-ads-sens')).toHaveValue('0.5');
  await page.keyboard.press('Escape');
  // The session so far must not have logged console errors.
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
});
