import { test, expect } from '@playwright/test';
import type { NestSnipHistoryResponse } from '@highfive/contracts';

// Per-nest hole-detection snip grid in the public ModulePanel (#165) —
// CLAUDE.md rule #4: a view rendering wire-shape data gets a Playwright spec
// against the production-built homepage + real backend. NestSnipGrid.test.tsx
// pins the component against a mocked NestSnip[]; only this layer proves the
// real chain — image-service HoleDetector crops a snip on /upload →
// duckdb-service /detections/history → backend /snips/history proxy → nginx →
// <img> pixels — actually renders, which jsdom can never do.
//
// Reuses the admin-gallery seed: seed_ui_fixtures.py uploads a real ESP capture
// (dev-tools/real_captures/block_tungsten_640.jpg) as GALLERY_MAC's newest
// image, which the learned detector (ADR-027) localizes into ~21 `undetermined`
// snips. The model only fires on real captures, not synthetic mocks. The five
// older fake uploads produce no snips (detection degrades to empty), so the grid
// is driven entirely by the one real capture.

const GALLERY_MAC = 'ff2222222222';

test.describe('module panel nest snips', () => {
  test('renders the per-nest snip grid with decoded snip pixels', async ({ page }) => {
    // 1) Wire round-trip against the exact endpoint the grid consumes
    //    (`/snips/history`, every nest of every capture). If the {snips}
    //    envelope or the detection write drifted, this fails before any DOM
    //    work. GALLERY_MAC has a single real capture, so history == the grid's
    //    one frame.
    const resp = await page.request.get(
      `http://localhost:4002/api/modules/${GALLERY_MAC}/snips/history`,
    );
    expect(resp.ok()).toBeTruthy();
    const body = (await resp.json()) as NestSnipHistoryResponse;
    expect(body.snips.length).toBeGreaterThan(0);
    const first = body.snips[0];
    // The learned detector localizes but defers empty/sealed → `undetermined`.
    expect(['empty', 'sealed', 'undetermined']).toContain(first.state);
    expect(first.snipFilename).toBeTruthy();
    // block_tungsten is the irregular 7/5/5/4 block: the smallest-bee row alone
    // has 7 nests. Proves the old 4-per-row cap is gone (it would have silently
    // dropped 3 holes of this row) — the bug the no-cap change fixed.
    const blackmasked = body.snips.filter((s) => s.beeType === 'blackmasked');
    expect(blackmasked.length).toBeGreaterThan(4);

    // 2) Open the gallery module's panel on the public dashboard.
    await page.goto('/dashboard');
    const sideListButton = page.getByRole('button', { name: /UI Test Gallery/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // 3) The snip grid heading and at least one snip image render.
    await expect(panel.getByText(/Nest holes|Nistlöcher/)).toBeVisible();
    const snipImgs = panel.locator(`img[src*="/api/snips/"]`);
    const snipImg = snipImgs.first();
    await expect(snipImg).toBeVisible();
    // The full irregular block renders — not capped at the old 16 (4×4). The
    // <img> elements exist even while lazy-loading, so count() is the cap proof.
    await expect.poll(async () => snipImgs.count()).toBeGreaterThan(16);

    // 4) The snip must have actually loaded pixels through nginx → backend →
    //    image-service — the proof jsdom structurally cannot give.
    await expect
      .poll(async () =>
        snipImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
      )
      .toBe(true);

    // 5) Each snip carries a neutral "Detected" badge — the model localizes but
    //    defers the empty/sealed call (ADR-027), so it never guesses sealed.
    await expect(panel.getByText(/Detected|Erkannt/).first()).toBeVisible();
  });
});
