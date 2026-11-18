/**
 * Root Playwright config (owner: build-engineer). Used by `npm run e2e`, `npm run e2e:local` and CI.
 *
 * Specs in tests/e2e/ start their own isolated game server + Vite per spec file (tests/e2e/support/stack.ts, owned by
 * qa-tester), each on random ports with its own BALANCE_OVERRIDE / LATENCY_MS / SEED. So by default there is no
 * shared webServer here, and nothing touches the dev ports 5173 / 8797.
 *
 * Opt-in shared stack: set E2E_WEB_SERVER=1 to have Playwright start one game server + Vite before the run, for specs
 * that use the config `baseURL` instead of their own stack. It runs on E2E_CLIENT_PORT / E2E_SERVER_PORT (defaults
 * 5273 / 8897, never the dev ports) and inherits the whole environment, so server variables such as
 * BALANCE_OVERRIDE, LATENCY_MS, JITTER_MS and SEED pass straight through (docs/tech/NETCODE.md "Environment"):
 *
 *   E2E_WEB_SERVER=1 BALANCE_OVERRIDE='{"match":{"countdownSeconds":3}}' npm run e2e
 */
import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
const sharedStack = process.env.E2E_WEB_SERVER === '1';
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? 5273);
const serverPort = Number(process.env.E2E_SERVER_PORT ?? 8897);
const baseURL = `http://127.0.0.1:${clientPort}`;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: 'test-results/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['github']]
    : [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: sharedStack ? baseURL : undefined,
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
          // Software WebGL so Three.js renders in headless CI without a GPU.
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
        },
      },
    },
  ],
  webServer: sharedStack
    ? [
        {
          // Game server. vite.config.ts reads PORT for its /ws proxy target, so both entries share it.
          command: 'node --import tsx server/index.ts',
          url: `http://127.0.0.1:${serverPort}/healthz`,
          env: { ...(process.env as Record<string, string>), PORT: String(serverPort), HOST: '127.0.0.1' },
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
          gracefulShutdown: { signal: 'SIGTERM', timeout: 4_000 },
        },
        {
          command: `npx vite --config tests/e2e/support/vite.e2e.config.ts --port ${clientPort} --strictPort --host 127.0.0.1`,
          url: baseURL,
          env: { ...(process.env as Record<string, string>), PORT: String(serverPort) },
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ]
    : undefined,
});
