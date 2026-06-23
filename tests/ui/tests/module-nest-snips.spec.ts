import { test, expect } from '@playwright/test';
import type { NestSnipsResponse } from '@highfive/contracts';

// Per-nest hole-detection snip grid in the public ModulePanel (#165) —
// CLAUDE.md rule #4: a view rendering wire-shape data gets a Playwright spec
// against the production-built homepage + real backend. NestSnipGrid.test.tsx
// pins the component against a mocked NestSnip[]; only this layer proves the
// real chain — image-service HoleDetector crops a snip on /upload →
// duckdb-service /detections → backend /snips proxy → nginx → <img> pixels —
// actually renders, which jsdom can never do.
//
// Reuses the admin-gallery seed: seed_ui_fixtures.py uploads the real
// dev-tools/mock_fully_filled.jpg as GALLERY_MAC's newest capture, which the
// live detector turns into sealed snips. The five older fake uploads produce
// no snips (detection degrades to empty), so the grid is driven entirely by the
// one real capture.

const GALLERY_MAC = 'ff2222222222';

test.describe('module panel nest snips', () => {
  test('renders the per-nest snip grid with decoded snip pixels', async ({ page }) => {
    // 1) Wire round-trip: the backend must return real detections for the
    //    seeded module. If the {snips} envelope or the detection write drifted,
    //    this fails before any DOM work.
    const resp = await page.request.get(`http://localhost:4002/api/modules/${GALLERY_MAC}/snips`);
    expect(resp.ok()).toBeTruthy();
    const body = (await resp.json()) as NestSnipsResponse;
    expect(body.snips.length).toBeGreaterThan(0);
    const first = body.snips[0];
    expect(['empty', 'sealed']).toContain(first.state);
    expect(first.snipFilename).toBeTruthy();

    // 2) Open the gallery module's panel on the public dashboard.
    await page.goto('/dashboard');
    const sideListButton = page.getByRole('button', { name: /UI Test Gallery/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // 3) The snip grid heading and at least one snip image render.
    await expect(panel.getByText(/Nest holes|Nistlöcher/)).toBeVisible();
    const snipImg = panel.locator(`img[src*="/api/snips/"]`).first();
    await expect(snipImg).toBeVisible();

    // 4) The snip must have actually loaded pixels through nginx → backend →
    //    image-service — the proof jsdom structurally cannot give.
    await expect
      .poll(async () =>
        snipImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true);

    // 5) Each snip carries an empty/sealed badge (mock_fully_filled => sealed).
    await expect(panel.getByText(/Sealed|Verschlossen/).first()).toBeVisible();
  });
});
