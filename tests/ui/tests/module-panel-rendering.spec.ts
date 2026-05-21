import { test, expect } from '@playwright/test';

// Validates ModulePanel renders the wire-shape fields (displayLabel,
// MAC-prefix, nest grid, bee-type summary) in a real DOM against a real
// backend. The jsdom test mocks api.getModuleById; this one resolves
// against the production-built homepage hitting the actual backend ->
// duckdb-service chain, so a wire-shape rename anywhere in that path
// surfaces here as a broken render.
//
// DashboardPage.tsx renders BOTH a desktop right-side aside
// (`<aside aria-label="Module Details">` - `hidden md:flex`) AND a
// mobile full-screen sheet (`<div role="dialog">` - `md:hidden`) when
// a module is selected. On the CI viewport (1280x720, desktop) only
// the aside is visible, but the mobile sheet is still in the DOM
// behind `display: none`. Every assertion in this spec scopes to the
// desktop aside via `getByRole('complementary', ...)` so the
// duplicated content doesn't trip Playwright's strict-mode locator
// matching.

test.describe('module panel rendering', () => {
  test('seeded Garten 12 module renders header, MAC prefix, nest grid, and bee-type summary', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // Garten 12 is one of the five SEED_DATA modules. id=000000000002,
    // 4 leafcutter nests (`nest-009..nest-012`) with daily_progress
    // rows whose `hatched` values sum to 64 (22+8+19+15). See
    // duckdb-service/db/schema.py's seed block.
    const sideListButton = page.getByRole('button', { name: /Garten 12/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    // Scope to the desktop panel - the only `<aside>` with aria-label
    // "Module Details" / "Moduldetails". The mobile sheet shares the
    // aria-label on a `<div role="dialog">`, not a complementary, so
    // this filter excludes it cleanly.
    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // Header h2 - displayLabel coalesces displayName -> name, and
    // displayName is null for fresh seeds, so the literal name shows.
    await expect(panel.getByRole('heading', { name: 'Garten 12' })).toBeVisible();

    // MAC-prefix subtitle (first 4 hex chars, uppercase). id is
    // 000000000002 -> "0000". The slice + toUpperCase comes from
    // ModulePanel.tsx; pin the literal so a future "show last 4 instead"
    // refactor surfaces here.
    await expect(panel.locator('[aria-label="module identifier"]')).toHaveText('0000');

    // Nest grid - 4 progress bars (one per leafcutter nest). The aria-
    // label pattern "Nest N sealed" is stable across i18n changes. This
    // pins "the wire-shape returns 4 nests for this module and each
    // renders a progressbar with its sealed value" - exactly the
    // backend <-> homepage contract the seeded fixture certifies.
    await expect(panel.locator('[role="progressbar"][aria-label^="Nest"]')).toHaveCount(4);

    // The article wrapper carries the bee-type "size" label; leafcutter
    // renders as "6 mm" per homepage/src/types/index.ts BEE_TYPES.
    const leafcutterArticle = panel.locator('article').filter({ hasText: '6 mm' });
    await expect(leafcutterArticle).toBeVisible();

    // Total hatches for the leafcutter bee-type summary aggregates the
    // four nests' `hatched` daily_progress entries: 22+8+19+15 = 64.
    // This is the literal-value pin against `daily_progress` plumbing
    // through `getModuleById` -> ModulePanel.beeTypeSummaries.
    // Backend's `image_count=87` seed value is intentionally NOT pinned
    // here - the backend coalesces `real_image_count ?? image_count`
    // and the `??` short-circuits on 0, so seeded modules with no
    // actual uploads render `0 images`. The Garten 12 panel's image
    // count is environment-derived state, not a wire-shape contract.
    await expect(leafcutterArticle).toContainText('64');
  });
});
