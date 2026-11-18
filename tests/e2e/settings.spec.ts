/**
 * (e) Settings persist across reload (localStorage `bsp.settings.v1`), are clamped, and the panel is keyboard
 * operable (Esc closes, focus returns). Also: the last name is pre-filled after reload.
 */
import { expect, test } from '@playwright/test';
import { join, newPlayer, openTitle, SHOTS, ui, unexpectedErrors } from './support/game';
import { CALM_BALANCE, startStack, type Stack } from './support/stack';

let stack: Stack;

test.beforeAll(async () => {
  stack = await startStack({ label: 'settings', balance: CALM_BALANCE });
});
test.afterAll(async () => {
  await stack?.stop();
});

async function setRange(page: import('@playwright/test').Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

test('settings persist across reload', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);

  const gear = page.locator('.ui-screen--title').getByRole('button', { name: /settings/i });
  await gear.click();
  await expect(ui.settings(page)).toBeVisible();

  await setRange(page, 'ui-set-sens', 2.5);
  await setRange(page, 'ui-set-vol', 0.35);
  await page.locator('#ui-set-invert').check();
  await page.screenshot({ path: `${SHOTS}/settings-open.png` });

  const stored = await page.evaluate(() => localStorage.getItem('bsp.settings.v1'));
  expect(stored, 'saved under bsp.settings.v1').not.toBeNull();
  const parsed = JSON.parse(stored!) as { mouseSensitivity: number; masterVolume: number; invertY: boolean };
  expect(parsed.mouseSensitivity).toBeCloseTo(2.5, 5);
  expect(parsed.masterVolume).toBeCloseTo(0.35, 5);
  expect(parsed.invertY).toBe(true);

  // Esc closes the panel and focus returns to the gear button.
  await page.keyboard.press('Escape');
  await expect(ui.settings(page)).toBeHidden();
  await expect(gear).toBeFocused();

  await page.reload();
  await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
  await gear.click();
  await expect(page.locator('#ui-set-sens')).toHaveValue('2.5');
  await expect(page.locator('#ui-set-vol')).toHaveValue('0.35');
  await expect(page.locator('#ui-set-invert')).toBeChecked();

  // Backdrop click closes.
  await page.mouse.click(5, 5);
  await expect(ui.settings(page)).toBeHidden();

  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});

test('corrupt / out-of-range stored settings are clamped, not crashing', async ({ browser }) => {
  const { ctx, page, log } = await newPlayer(browser, stack.baseURL);
  await ctx.addInitScript(() => {
    localStorage.setItem('bsp.settings.v1', JSON.stringify({ mouseSensitivity: 999, masterVolume: -4, invertY: 'yes' }));
  });
  await openTitle(page);
  await page.locator('.ui-screen--title').getByRole('button', { name: /settings/i }).click();
  const sens = Number(await page.locator('#ui-set-sens').inputValue());
  const max = Number(await page.locator('#ui-set-sens').getAttribute('max'));
  expect(sens).toBeLessThanOrEqual(max);
  expect(Number(await page.locator('#ui-set-vol').inputValue())).toBeGreaterThanOrEqual(0);
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);

  // Garbage JSON.
  await page.evaluate(() => localStorage.setItem('bsp.settings.v1', '{not json'));
  await page.reload();
  await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
  expect(unexpectedErrors(log), log.all.join('\n')).toEqual([]);
  await ctx.close();
});

test('last name is pre-filled after reload', async ({ browser }) => {
  const { ctx, page } = await newPlayer(browser, stack.baseURL);
  await openTitle(page);
  await join(page, '  Mango  ');
  await expect(ui.lobby(page)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(ui.title(page)).toBeVisible({ timeout: 30_000 });
  await expect(ui.nameInput(page)).toHaveValue('Mango');
  await ctx.close();
});
