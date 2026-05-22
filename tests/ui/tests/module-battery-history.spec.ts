import { test, expect } from '@playwright/test';

// Validates the BatteryHistoryChart (issue #110) renders end-to-end:
// duckdb-service `measurements` table populated by SEED_DATA → backend
// `/api/modules/:id/measurements` proxy (snake → camelCase, including
// `sample_count` → `sampleCount`) → homepage `<BatteryHistoryChart>`
// recharts LineChart in a real browser.
//
// CLAUDE.md rule 4 + ADR-014 mandate this layer for any view rendering
// wire-shape data: vitest+jsdom mocks `api.getMeasurements` and would
// pass even if `sample_count → sampleCount` were silently broken.
//
// Per the schema.py seed block, the five seed modules each get 168
// hourly `battery_pct` measurements in [55, 95] for the trailing 7
// days. Visiting Garten 12 (000000000002) must therefore render the
// chart — NOT the "no battery readings" empty state.
//
// The mobile-sheet vs desktop-aside split documented in
// `module-panel-rendering.spec.ts` applies here too — scope every
// assertion to the desktop `<aside>` complementary landmark.

test.describe('battery history chart (issue #110)', () => {
  test('seeded Garten 12 module renders the BatteryHistoryChart with sampled buckets', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // Open the seeded module's detail panel.
    const sideListButton = page.getByRole('button', { name: /Garten 12/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // The chart section carries `data-testid="battery-history-chart"`
    // so we can scope strictly to it without depending on i18n strings.
    const chart = panel.locator('[data-testid="battery-history-chart"]');
    await expect(chart).toBeVisible();

    // Heading reads either English ("Battery history") or German
    // ("Akku-Verlauf") depending on the test environment locale. Match
    // both — the spec asserts presence, not language.
    await expect(chart.getByRole('heading', { name: /Battery history|Akku-Verlauf/ })).toBeVisible();

    // Seed data populates 168 hourly samples — the empty state must
    // NOT appear. This is the load-bearing assertion: if the
    // backend snake → camel mapping dropped `value` to undefined, or
    // the wire-shape type drifted, every bucket would render as
    // null and the chart would show the empty-state message instead
    // of the canvas. CLAUDE.md rule 5 — assert real data lands.
    await expect(chart).not.toContainText(/No battery readings|Keine Akkudaten/);

    // Canvas wrapper is only mounted after data lands AND the
    // ResizeObserver supplies non-zero chartSize. Recharts emits an
    // <svg> inside it. Presence of either the wrapper or the SVG is
    // the proof that the buckets reached recharts.
    await expect(chart.locator('[data-testid="battery-history-chart-canvas"]')).toBeVisible();
    await expect(chart.locator('svg').first()).toBeVisible();
  });
});
