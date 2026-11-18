/**
 * Segmented settings controls (Aim mode, Graphics quality) show exactly one selected option after a change: the
 * checked option has the accent background and the tick, the others have neither. Added in the M2a run after a
 * screenshot taken mid-transition seemed to show two filled options; the computed styles prove it is only the
 * 120 ms hover/transition (not a bug), and this guards the `:has(:checked)` styling against regressions.
 */
import { expect, test, type Page } from '@playwright/test';
import { newPlayer, openTitle, SHOTS, ui } from './support/game';
import { CALM_BALANCE, startStack, type Stack } from './support/stack';

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ label: 'settings-seg', balance: CALM_BALANCE });
});
test.afterAll(async () => {
  await stack?.stop();
});

async function looks(page: Page, name: string, values: string[]): Promise<Record<string, { bg: string; tick: string; checked: boolean }>> {
  const out: Record<string, { bg: string; tick: string; checked: boolean }> = {};
  for (const v of values) {
    out[v] = await page.locator(`label[for="${name}-${v}"]`).evaluate((el) => {
      const input = el.querySelector('input') as HTMLInputElement;
      const tick = el.querySelector('.ui-seg__tick') as HTMLElement;
      return { bg: getComputedStyle(el).backgroundColor, tick: getComputedStyle(tick).display, checked: input.checked };
    });
  }
  return out;
}

for (const [name, from, to, all] of [
  ['ui-set-aim', 'hold', 'toggle', ['hold', 'toggle']],
  ['ui-set-quality', 'medium', 'low', ['low', 'medium', 'high']],
] as const) {
  test(`${name}: ${from} -> ${to} leaves exactly one option styled as selected`, async ({ browser }) => {
    const { ctx, page } = await newPlayer(browser, stack.baseURL);
    await openTitle(page);
    await page.locator('.ui-screen--title').getByRole('button', { name: /settings/i }).click();
    await expect(ui.settings(page)).toBeVisible();
    await page.locator(`label[for="${name}-${to}"]`).click();
    await page.mouse.move(5, 5); // no hover on either option
    await page.waitForTimeout(300);
    const s = await looks(page, name, [...all]);
    await page.screenshot({ path: `${SHOTS}/settings-seg-${name}.png` });
    console.log(name, JSON.stringify(s));
    expect(s[to]!.checked).toBe(true);
    const selectedBg = s[to]!.bg;
    for (const v of all) {
      if (v === to) {
        expect(s[v]!.tick, `${v} tick`).not.toBe('none');
      } else {
        expect(s[v]!.tick, `${v} tick`).toBe('none');
        expect(s[v]!.bg, `${v} must not keep the selected fill`).not.toBe(selectedBg);
      }
    }
    await ctx.close();
  });
}
