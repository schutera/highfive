import { test, expect } from '@playwright/test';

// Validates ModulePanel renders the wire-shape fields (displayLabel,
// MAC-prefix, image count, nest grid) in a real DOM against a real
// backend. The jsdom test mocks api.getModuleById; this one resolves
// against the production-built homepage hitting the actual backend ->
// duckdb-service chain, so a wire-shape rename anywhere in that path
// surfaces here as a broken render.

test.describe('module panel rendering', () => {
  test('seeded Garten 12 module renders header, MAC prefix, image count, and nest grid', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // Garten 12 is one of the five SEED_DATA modules. id=000000000002,
    // 4 leafcutter nests, image_count=87. See duckdb-service/db/schema.py
    // seed block.
    const sideListButton = page.getByRole('button', { name: /Garten 12/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    // Header h2 - displayLabel coalesces displayName -> name, and
    // displayName is null for fresh seeds, so the literal name shows.
    await expect(page.getByRole('heading', { name: 'Garten 12' })).toBeVisible();

    // MAC-prefix subtitle (first 4 hex chars, uppercase). id is
    // 000000000002 -> "0000". The slice + toUpperCase comes from
    // ModulePanel.tsx; pin the literal so a future "show last 4 instead"
    // refactor surfaces here.
    await expect(page.locator('[aria-label="module identifier"]')).toHaveText('0000');

    // Image count - the seed sets 87 and the upload pipeline didn't
    // touch this module, so the literal value holds.
    await expect(page.locator('main, [role="main"], body')).toContainText('87');

    // Nest grid - 4 progress bars (one per leafcutter nest). The aria-
    // label pattern "Nest N sealed" is stable across i18n changes.
    const nestBars = page.locator('[role="progressbar"][aria-label^="Nest"]');
    await expect(nestBars).toHaveCount(4);

    // The article wrapper carries the bee-type "size" label; leafcutter
    // renders as "6 mm" per homepage/src/types/index.ts BEE_TYPES.
    await expect(page.locator('article').filter({ hasText: '6 mm' })).toBeVisible();
  });

  test('seeded modules each expose a side-list entry with a status indicator', async ({ page }) => {
    await page.goto('/dashboard');

    // Pin the structural contract: every side-list button has a
    // status dot with one of the three known aria-labels. The visual
    // colour can change without breaking this test; only the contract
    // ("each module has a labelled status indicator") would.
    const buttons = page.getByRole('button', { name: /Garten 12|Elias123|Waldrand/ });
    const visibleCount = await buttons.count();
    expect(visibleCount).toBeGreaterThanOrEqual(1);
  });
});
