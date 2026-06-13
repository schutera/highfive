import { test, expect } from '@playwright/test';
import type { ImageUploadsPage } from '@highfive/contracts';

// "Latest captures" gallery in the public ModulePanel (#154) —
// CLAUDE.md rule #4: a view rendering wire-shape data gets a Playwright
// spec against the production-built homepage + real backend. The jsdom
// suite (LatestCaptures.test.tsx) pins the component against a mocked
// ImageUploadsPage; only this layer proves the real chain —
// duckdb-service uploaded_at → image-service bytes → backend proxy →
// nginx → <img> pixels — actually renders, which jsdom can never do.
//
// Reuses the admin-gallery seed: seed_ui_fixtures.py uploads 6 images
// for GALLERY_MAC ("UI Test Gallery") — more than the two cards the
// carousel shows at once, so the scroll arrows must appear. The expected
// newest filename is derived from the live API, not from seed timing, so
// same-second upload collisions can't flake it.

const GALLERY_MAC = 'ff2222222222';

test.describe('module panel latest captures', () => {
  test('renders the newest upload, shows scroll arrows, opens a delete-free lightbox', async ({
    page,
  }) => {
    // 1) Wire round-trip: ask the backend which upload is newest. If the
    //    {images,total} envelope drifts, this fails before any DOM work.
    const resp = await page.request.get(
      `http://localhost:4002/api/images?module_id=${GALLERY_MAC}&limit=1&offset=0`,
    );
    expect(resp.ok()).toBeTruthy();
    const pageJson = (await resp.json()) as ImageUploadsPage;
    expect(pageJson.images.length).toBe(1);
    const newest = pageJson.images[0];
    expect(newest.module_id).toBe(GALLERY_MAC);

    // 2) Open the gallery module's panel on the public dashboard.
    await page.goto('/dashboard');
    const sideListButton = page.getByRole('button', { name: /UI Test Gallery/ });
    await expect(sideListButton).toBeVisible();
    await sideListButton.click();

    // Scope to the desktop aside — DashboardPage also mounts a hidden
    // mobile sheet with the same content (strict-mode trap documented in
    // module-panel-rendering.spec.ts).
    const panel = page.getByRole('complementary', { name: /Module Details|Moduldetails/ });
    await expect(panel).toBeVisible();

    // 3) The card heading and the newest image render. Pin the src to
    //    the API-derived filename — the card must show the NEWEST
    //    upload, not just any of the six.
    await expect(panel.getByText(/Latest captures|Neueste Aufnahmen/)).toBeVisible();
    const img = panel.locator(`img[src*="${encodeURIComponent(newest.filename)}"]`);
    await expect(img).toBeVisible();

    // The image must have actually loaded pixels through nginx → backend
    // → image-service — the proof jsdom structurally cannot give.
    await expect
      .poll(async () => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);

    // The seed has 6 images > the two visible cards, so the carousel's
    // scroll arrows must be present.
    await expect(panel.getByRole('button', { name: /More images|Weitere Bilder/ })).toBeVisible();

    // 4) Click → lightbox dialog with the full-size image, and — public
    //    surface — no Delete affordance anywhere inside it.
    await img.click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(
      lightbox.locator(`img[src*="${encodeURIComponent(newest.filename)}"]`),
    ).toBeVisible();
    await expect(lightbox.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // 5) Escape closes it.
    await page.keyboard.press('Escape');
    await expect(lightbox).not.toBeVisible();
  });
});
