import { test, expect } from '@playwright/test';

// Validates the global per-module time-lapse scrubber (#166 phase 3) end-to-end
// against the production-built homepage + real backend -> duckdb-service chain.
// The seeded `nest_detections` rows (duckdb-service/db/schema.py) give Garten
// 12's leafcutter nest 1 five captures walking empty -> sealed, with snip JPEGs
// image-service copies into the shared volume on boot (image-service/demo_snips/).
// jsdom can't catch a wire-shape break here: every NestSnip TS-optional collapses
// to `undefined` silently under a mocked API, and jsdom never serves the real
// snip bytes. This spec asserts the slider swaps the *real* rendered crop,
// closing both gaps (CLAUDE.md rule 4).
//
// Scoped to the desktop `<aside>` panel via getByRole('complementary', ...) for
// the same reason as module-panel-rendering.spec.ts: DashboardPage renders the
// panel twice (desktop aside + mobile dialog) and the snip grid is in both.

test.describe('global nest time-lapse (#166)', () => {
  test('scrubbing the slider walks the seeded leafcutter nest across captures', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    await page.getByRole('button', { name: /Garten 12/ }).click();
    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // The grid opens on the newest capture (2026-06-26, sealed). Only leafcutter
    // nest 1 is seeded for Garten 12, so one snip cell renders.
    const frame = panel.getByTestId('snip-frame').first();
    await expect(frame).toHaveAttribute('src', /demo-garten12-leaf1-2026-06-26\.jpg/);
    await expect(panel.getByTestId('snip-capture-date')).toContainText('2026');
    // The real bytes load (naturalWidth > 0) — proves image-service served the
    // seeded crop, not a broken-image placeholder.
    await expect
      .poll(async () => frame.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    // Five captures -> slider range 0..4.
    const scrubber = panel.getByTestId('snip-scrubber');
    await expect(scrubber).toHaveAttribute('max', '4');

    // Scrub to the oldest capture; the rendered crop must follow to the first
    // (empty) frame — the behaviour the whole feature exists for.
    await scrubber.focus();
    await page.keyboard.press('Home');
    await expect(frame).toHaveAttribute('src', /demo-garten12-leaf1-2026-06-01\.jpg/);
    await expect(panel.getByTestId('snip-capture-date')).toContainText('2026');
  });
});
