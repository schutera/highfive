import { test, expect } from '@playwright/test';

// Pins the chapter-11 "Three layers, one rule was actually four surfaces"
// regression. PR II's contract was prose-only: "(0,0) modules still
// appear in the side-list with a 'Location pending' pill". The actual
// code derived the side-list from MapView's fuzzedModules, which
// pre-filtered them. AdminPage rendered the pill; the dashboard side-
// list silently dropped the module. Two senior-review rounds missed
// it; a chapter-11 lessons-learned entry asked for a mount-and-render
// integration test. This is that test.
//
// seed_ui_fixtures.py registers a Null-Island module ("UI Test Null
// Island" at 0,0). The seeded baseline modules sit at real lat/lng
// near the lake, so this is the only pending module in the listing.

const NULL_ISLAND_LABEL = 'UI Test Null Island';

test.describe('dashboard side-list pending modules', () => {
  test('Null-Island module appears with the "Location pending" pill', async ({ page }) => {
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

  test('side-list count includes the Null-Island module', async ({ page }) => {
    await page.goto('/dashboard');

    // SEED_DATA produces 5 baseline modules. seed_ui_fixtures.py adds 2
    // more (Null Island + the telemetry-bearing module). The header
    // counter uses i18n's plural form so we match digits anywhere in
    // the line; the literal value must be >= 6 to prove that at least
    // one of the seeded fixtures is in the list (the bug filtered all
    // pending modules out, so a count of 6 with the Null-Island row
    // visible is the union of two checks the regression broke).
    const heading = page.getByRole('heading', { name: /Hive\s?Modul/i });
    await expect(heading).toBeVisible();

    // Module visible to ensure the side-list rendered (not just heading).
    await expect(page.getByRole('button', { name: new RegExp(NULL_ISLAND_LABEL) })).toBeVisible();

    // At least one of the baseline seeded modules should also be there.
    await expect(page.getByText(/Garten 12|Elias123|Waldrand/i).first()).toBeVisible();
  });
});
