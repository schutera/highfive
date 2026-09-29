import { test, expect } from '@playwright/test';

// Pin the locale: the banner/503 assertions below match English copy,
// and the app follows the browser locale (default Chromium is en-US,
// but a future `locale` in playwright.config.ts must not silently
// re-point these).
test.use({ locale: 'en' });

// Issue #230 — the dashboard's degraded states against the
// production-built SPA in real Chromium (jsdom covers the units; only
// this layer proves the banner and the 503 state render through real
// fetch + SPA routing). `page.route` interception stands in for the
// failure modes stopping `duckdb-service` would induce — without
// tearing the shared compose stack down for every other spec.

test.describe('dashboard degraded states (#230)', () => {
  test('names the stale legs in one banner on a partial header', async ({ page }) => {
    await page.route('**/api/modules', async (route) => {
      const res = await route.fetch();
      const body = await res.text();
      await route.fulfill({
        status: 200,
        headers: {
          ...res.headers(),
          'X-Highfive-Data-Incomplete': 'nests,progress',
        },
        body,
      });
    });

    await page.goto('/dashboard');

    // Banner under test — the exact backend header string above must
    // surface as leg names, not a generic warning.
    await expect(page.getByText(/Upstream data unavailable \(nests, progress\)/)).toBeVisible();
  });

  test('renders the unavailable state (not backend-down) on 503', async ({ page }) => {
    await page.route('**/api/modules', async (route) => {
      await route.fulfill({
        status: 503,
        headers: { 'Retry-After': '5' },
        contentType: 'application/json',
        body: JSON.stringify({ error: 'upstream module store unavailable' }),
      });
    });

    await page.goto('/dashboard');

    await expect(page.getByText('Module data is temporarily unavailable')).toBeVisible();
    await expect(page.getByText(/Trying again in a moment usually helps/)).toBeVisible();
  });
});
