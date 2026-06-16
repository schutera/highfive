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
const ADMIN_PASSWORD = 'hf_test_key'; // matches docker-compose.ui.yml HIGHFIVE_API_KEY

test.describe('admin image gallery pagination', () => {
  test.beforeEach(async ({ page }) => {
    // AdminPage gates render on a real server-side session (#142 / ADR-019):
    // it calls api.checkSession() on mount. Log in via /api/admin/login so the
    // context cookie jar holds the session cookie and the gate lands on the
    // gallery instead of the login form. The gallery's /api/images reads are
    // public now, so they need no credential.
    const login = await page.request.post('http://localhost:4002/api/admin/login', {
      data: { password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
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
    );
    const firstJson = (await firstResp.json()) as ImageUploadsPage;
    expect(firstJson.images.map((i) => i.filename)).toEqual(expectedOrder.slice(0, PAGE_SIZE));
    expect(firstJson.total).toBe(allPage.total); // total ignores the page window

    // 2) Drive the browser. Filter to the gallery module so the counts
    //    are deterministic regardless of other seeded modules' uploads.
    await page.goto('/admin');
    // Scope to the module-filter select by test-id: the admin page now also
    // renders the #171 Server Logs service dropdown, so a bare
    // getByRole('combobox') matches two elements (strict-mode violation).
    await page.getByTestId('module-filter-select').selectOption(GALLERY_MAC);

    // Count the image CELLS (one button per loaded row), not the <img>
    // itself: AdminPage's onError handler replaces a failed thumbnail's
    // parent innerHTML, removing the <img> from the DOM — so an <img>
    // count is load-dependent and flaky in CI. The cell + its
    // data-filename are what the pagination behaviour actually controls.
    const cells = page.locator('[data-testid="admin-image-cell"]');
    await expect(cells).toHaveCount(PAGE_SIZE); // first page only, not all `total`

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
    await expect(cells).toHaveCount(allPage.total);
    await expect(loadMore).toHaveCount(0);

    const renderedOrder = await cells.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-filename') ?? ''),
    );
    expect(renderedOrder).toEqual(expectedOrder);
  });
});
