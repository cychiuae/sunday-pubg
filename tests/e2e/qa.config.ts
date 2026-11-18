/**
 * QA Playwright config (owner: qa-tester). Same browser setup as the root playwright.config.ts, but without the
 * shared `npm run dev` webServer: every spec starts its own isolated game server + Vite (tests/e2e/support/stack.ts),
 * so specs can use different BALANCE_OVERRIDE / LATENCY_MS values and never touch ports 5173 / 8797.
 *
 *   npx playwright test -c tests/e2e/qa.config.ts
 *
 * Proposal for build-engineer: point the root config at this file (or drop its webServer) so CI does not start an
 * unused dev server.
 */
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: '../../test-results/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [['list'], ['html', { open: 'never', outputFolder: '../../playwright-report' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
});
