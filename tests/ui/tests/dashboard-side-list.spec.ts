import { test, expect } from '@playwright/test';

// The dashboard side-list must include modules whose location is the
// `(0,0)` sentinel, rendered with the "Location pending" pill.
//
// PR-104 ("dashboard side-list rework") moved the side-list source
// from MapView's bounds-filtered `visibleModules` to `sideListModules`
// derived directly from the `/api/modules` response, with pending
// modules sorted to the bottom. The chapter-11 entry that motivates
// this spec describes the pre-104 bug shape (side-list consumed
// MapView's pre-filtered output); after 104 the structural rule the
// side-list must obey is "pending modules appear, sorted to the
// tail, with the pill". This spec pins that rule: it does NOT pin
// the specific pre-104 MapView coupling (which is no longer possible
// to regress without re-architecting `DashboardPage::sideListModules`).
//
// What would fail this spec:
//   - `sideListModules` learns to filter pending modules out.
//   - The `!hasPlausibleLocation(module.location) && <pill>` branch
//     in `DashboardPage`'s side-list JSX gets dropped.
//   - The `/api/modules` response drops the Null-Island row.
//
// seed_ui_fixtures.py registers "UI Test Null Island" at (0,0) so
// this is the only pending module in the listing.

const NULL_ISLAND_LABEL = 'UI Test Null Island';

test.describe('dashboard side-list pending modules', () => {
  test('Null-Island module appears in the side-list with the "Location pending" pill', async ({
    page,
  }) => {
    await page.goto('/dashboard');

    // The seed produces "UI Test Null Island" via add_module's
    // _resolve_unique_firmware_name; assert by literal name.
    const sideListItem = page.getByRole('button', { name: new RegExp(NULL_ISLAND_LABEL) });
    await expect(sideListItem).toBeVisible();

    // The pill copy is i18n-keyed (dashboard.locationPending -
    // "Location pending" in en / "Standort ausstehend" in de). Match
    // both translations so the spec doesn't break on a language flip.
    await expect(sideListItem).toContainText(/Location pending|Standort ausstehend/);
  });
});
