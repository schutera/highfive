import { test, expect, type ConsoleMessage } from '@playwright/test';

// Iteration-1 smoke baseline: every other spec depends on the homepage
// container being reachable and the SPA mounting without runtime
// exceptions. If this spec fails the rest are uninformative.

test.describe('smoke', () => {
  test('homepage / renders without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err: Error) => {
      consoleErrors.push(err.message);
    });

    await page.goto('/');

    // The hero copy varies less than nav structure; pin a stable substring.
    await expect(page.locator('body')).toContainText(/HighFive|HiveHive|Hive/i);

    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('dashboard / mounts and renders the seeded modules', async ({ page }) => {
    await page.goto('/dashboard');

    // "Hive Modules" header on the side-list. Bilingual baseline (de/en);
    // both translations include the word "Modul[e]" so a regex match works.
    await expect(page.getByRole('heading', { name: /Hive\s?Modul/i })).toBeVisible();

    // One of the five seeded modules - any visible label suffices to
    // prove the API client + render path resolved end-to-end.
    await expect(page.getByText(/Garten 12|Elias123|Waldrand/i).first()).toBeVisible();
  });

  test('setup / mounts step 1 of the wizard', async ({ page }) => {
    await page.goto('/setup');

    // Step 1's heading id="step1-title" comes from
    // homepage/src/components/setup/Step1Connect.tsx. Targeting the id
    // gives us a stable hook regardless of i18n.
    await expect(page.locator('#step1-title')).toBeVisible();
  });
});
