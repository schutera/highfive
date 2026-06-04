import { test, expect } from '@playwright/test';
import type { ImageUploadsPage } from '@highfive/contracts';

// Pins the admin image-gallery pagination (feat/admin-image-pagination)
// and CLAUDE.md rule #4: a view that renders wire-shape data gets a
// Playwright spec that mounts the production-built homepage against the
// real backend. Vitest+jsdom (api-getImages.test.ts) pins the client
// round-trip, but only this layer proves the gallery actually caps the
// first page at PAGE_SIZE and that "Load more" appends the rest in
// capture order — the silent-undefined / SPA-routing gaps jsdom misses.
//
// seed_ui_fixtures.py uploads GALLERY_IMAGE_COUNT (6) images for this MAC,
// each >1s apart so uploaded_at (second resolution) is strictly
// increasing — i.e. the newest-first order reflects capture order.
// PAGE_SIZE in AdminPage.tsx is 5, so 6 images = one full page + one.

const GALLERY_MAC = 'ff2222222222';
const PAGE_SIZE = 5;
const API_KEY = 'hf_test_key'; // matches docker-compose.ui.yml VITE_API_KEY / HIGHFIVE_API_KEY

test.describe('admin image gallery pagination', () => {
  test.beforeEach(async ({ page }) => {
    // AdminPage gates render on a truthy `highfive_admin_auth` in
    // sessionStorage (the value LoginGate stores is the API key). Set it
    // so the spec lands on the gallery instead of the login form. The
    // gallery's own /api/images fetch authenticates with the build-time
    // VITE_API_KEY, not this value — but the gate still needs it present.
    await page.addInitScript((key) => {
      sessionStorage.setItem('highfive_admin_auth', key);
    }, API_KEY);
  });

  test('first page caps at PAGE_SIZE and "Load more" appends in capture order', async ({
    page,
  }) => {
    // 1) Wire-shape round trip: pull the FULL ordered list straight from
    //    the backend so we know the deterministic capture order the UI
    //    should render. If the envelope drifts ({images,total} → other),
    //    this fails before we touch the DOM.
    const full = await page.request.get(
      `http://localhost:4002/api/images?module_id=${GALLERY_MAC}`,
      { headers: { 'X-API-Key': API_KEY } },
    );
    expect(full.ok()).toBeTruthy();
    const allPage = (await full.json()) as ImageUploadsPage;
    expect(allPage.total).toBe(allPage.images.length);
    expect(allPage.total).toBeGreaterThan(PAGE_SIZE); // seed gives 6 > 5
    const expectedOrder = allPage.images.map((i) => i.filename); // newest-first

    // The first page the gallery requests must be exactly the newest
    // PAGE_SIZE, in the same order — pin that at the API too.
    const firstResp = await page.request.get(
      `http://localhost:4002/api/images?module_id=${GALLERY_MAC}&limit=${PAGE_SIZE}&offset=0`,
      { headers: { 'X-API-Key': API_KEY } },
    );
    const firstJson = (await firstResp.json()) as ImageUploadsPage;
    expect(firstJson.images.map((i) => i.filename)).toEqual(expectedOrder.slice(0, PAGE_SIZE));
    expect(firstJson.total).toBe(allPage.total); // total ignores the page window

    // 2) Drive the browser. Filter to the gallery module so the counts
    //    are deterministic regardless of other seeded modules' uploads.
    await page.goto('/admin');
    await page.getByRole('combobox').selectOption(GALLERY_MAC);

    // The thumbnail grid renders one <img> per loaded row. Initially the
    // first page only: exactly PAGE_SIZE thumbnails, not all `total`.
    const thumbs = page.locator('main img');
    await expect(thumbs).toHaveCount(PAGE_SIZE);

    // The stats line shows "<loaded> of <total> images" while a page is
    // outstanding, and a "Load more (<n> left)" button is present.
    await expect(page.getByText(`${PAGE_SIZE} of ${allPage.total} images`)).toBeVisible();
    const loadMore = page.getByRole('button', {
      name: new RegExp(`Load more \\(${allPage.total - PAGE_SIZE} left\\)`),
    });
    await expect(loadMore).toBeVisible();

    // 3) Click "Load more": the remaining rows append, the button
    //    disappears (all `total` now loaded), and the full rendered
    //    sequence equals the deterministic capture order from step 1.
    await loadMore.click();
    await expect(thumbs).toHaveCount(allPage.total);
    await expect(loadMore).toHaveCount(0);

    const renderedOrder = await thumbs.evaluateAll((imgs) =>
      imgs.map((img) => {
        // src is /api/images/<filename>; compare on the filename tail.
        const src = (img as HTMLImageElement).getAttribute('src') ?? '';
        return decodeURIComponent(src.split('/').pop() ?? '');
      }),
    );
    expect(renderedOrder).toEqual(expectedOrder);
  });
});
