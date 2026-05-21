import { defineConfig, devices } from '@playwright/test';

// Host port for the homepage container, defined in docker-compose.ui.yml.
// Overridable via UI_BASE_URL for local iteration against a different stack.
const BASE_URL = process.env.UI_BASE_URL ?? 'http://localhost:6173';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Iteration-1 keeps retries at 0 even in CI: the seed-script sets up
  // a single deterministic state, literal-value assertions key on that
  // state, and retries against the same already-mutated stack would
  // hide flake instead of surfacing it. Re-evaluate (see #123) once
  // `ui-playwright` has 5 consecutive green PR runs - if a real
  // transient flake surfaces in that window, lift to `retries: 1`;
  // otherwise leave it at 0.
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
