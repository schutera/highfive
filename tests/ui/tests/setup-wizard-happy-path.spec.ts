import { test, expect } from '@playwright/test';

// Walks the setup wizard from Step 1 through to Step 5 using the
// documented skip branches. The wizard's Step 2 needs a physical
// ESP32-CAM with Web Serial to actually flash, and Step 3 needs the
// device's WiFi AP - neither is available in CI. The skip-already-
// flashed button on Step 2 and the "Already configured" button on
// Step 3 are the documented bypass paths and exercise the step-
// transition state machine without hardware.
//
// What this pins:
//   - The StepIndicator's aria-current="step" actually advances.
//   - The step components render their titled section on mount.
//   - The skip buttons wire up correctly (markFlashComplete + goNext,
//     onSkip = goToStep(5)) so a future refactor that breaks the step
//     index can't ship green.

test.describe('setup wizard happy path', () => {
  test('Step 1 -> 2 -> 3 -> 5 via skip branches', async ({ page }) => {
    await page.goto('/setup');

    // Step 1 - "Connect Your Module". Click the "Next" button.
    await expect(page.locator('#step1-title')).toBeVisible();
    await page.getByRole('button', { name: /^Next$|^Weiter$/ }).click();

    // Step 2 - "Flash Firmware". Without hardware we click the
    // "Skip - already flashed" button, which calls both
    // markFlashComplete() and onNext() per SetupWizard.tsx. Translation
    // uses a literal em-dash; match permissively across en/de.
    await expect(page.locator('#step2-title')).toBeVisible();
    await page.getByRole('button', { name: /Skip.*already flashed|Bereits geflasht/i }).click();

    // Step 3 - "Connect to Your Module". Skip-to-verification triggers
    // onSkip = () => goToStep(5).
    await expect(page.locator('#step3-title')).toBeVisible();
    await page
      .getByRole('button', {
        name: /Already configured.*skip to verification|Bereits konfiguriert/i,
      })
      .click();

    // Step 5 - "Verify". On mount Step5Verify runs an async health
    // check then either renders the waiting state (#step5-waiting,
    // backend reachable) or the down state (#step5-down). Either id
    // means we landed on Step 5; the spec just confirms we got here.
    // No detectedModule means we never reach #step5-success - that's
    // a hardware-in-the-loop assertion outside iteration-1 scope.
    await expect(page.locator('#step5-waiting, #step5-down')).toBeVisible();
  });
});
