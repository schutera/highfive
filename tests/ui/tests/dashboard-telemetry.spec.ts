import { test, expect } from '@playwright/test';
import type { TelemetryEntry } from '@highfive/contracts';

// Pins the chapter-11 "Telemetry sidecar envelope drift" regression.
// scripts/seed_ui_fixtures.py uploads one image + sidecar for this MAC
// with the literal values asserted below. If image-service's envelope
// shape drifts again (flat -> nested -> wrapper-renamed), or if the
// homepage reads the wrong level of the JSON, the TelemetryRow renders
// "—" for the affected fields and the test fails on the literal-value
// assertion - exactly the surface that escaped jsdom for weeks.
//
// The TelemetryEntry type is imported from @highfive/contracts so any
// future rename at the wire-shape boundary is a TypeScript compile
// error in this file rather than a silent undefined-pluck at runtime.
// That re-uses ADR-004's "drift becomes a compile error" guarantee.

const TELEMETRY_MAC = 'ff1111111111';

const EXPECTED: TelemetryEntry = {
  mac: TELEMETRY_MAC,
  // server-side stamps - asserted on shape, not value
  received_at: '',
  image: '',
  payload: {
    fw: 'ui-test-1.2.3',
    uptime_s: 3601,
    last_reset_reason: 'UI_TEST_RESET',
    free_heap: 204800,
    rssi: -42,
  },
};

test.describe('dashboard telemetry render', () => {
  test.beforeEach(async ({ page }) => {
    // Establish a real admin session (#142 / ADR-019): POST the key to
    // /api/admin/login so the context cookie jar holds the HttpOnly session
    // cookie. The browser then sends it on the panel's /logs fetch
    // (credentials: 'include'). page.request shares cookies with the page's
    // browser context. The old sessionStorage hf_admin_key seed is gone — the
    // bundle holds no secret and the panel reads the cookie, not storage.
    const login = await page.request.post('http://localhost:4002/api/admin/login', {
      data: { password: 'hf_test_key' },
    });
    expect(login.ok()).toBeTruthy();
  });

  test('TelemetryRow renders literal values from the seeded sidecar', async ({ page }) => {
    // 1) Fetch the sidecar through the same admin endpoint the UI uses,
    //    and assert the wire shape directly. This is the "wire-shape
    //    round-trip" half - if image-service starts wrapping payload
    //    one envelope deeper, this fails before we even look at the DOM.
    const response = await page.request.get(
      `http://localhost:4002/api/modules/${TELEMETRY_MAC}/logs?limit=5`,
      {
        headers: {
          'X-API-Key': 'hf_test_key',
          'X-Admin-Key': 'hf_test_key',
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    const logs = (await response.json()) as TelemetryEntry[];
    expect(logs.length).toBeGreaterThanOrEqual(1);
    const latest = logs[0];
    expect(latest.mac).toBe(TELEMETRY_MAC);
    expect(latest.payload.fw).toBe(EXPECTED.payload.fw);
    expect(latest.payload.uptime_s).toBe(EXPECTED.payload.uptime_s);
    expect(latest.payload.last_reset_reason).toBe(EXPECTED.payload.last_reset_reason);
    expect(latest.payload.free_heap).toBe(EXPECTED.payload.free_heap);
    expect(latest.payload.rssi).toBe(EXPECTED.payload.rssi);

    // 2) Now drive the browser. The chapter-11 bug was that the DOM
    //    surface diverged from the wire surface - the wire shape was
    //    right but the React component read the wrong level. So we
    //    assert both, separately.
    await page.goto(`/dashboard?admin=1`);

    // Open the seeded module's panel. The side-list label is the
    // firmware-reported name (see displayLabel.ts - displayName falls
    // back to name when null/empty, which it is for fresh registrations).
    await page.getByRole('button', { name: /UI Test Telemetry/ }).click();

    // Scope to the desktop side panel: the dashboard renders ModulePanel
    // twice (desktop <aside> + mobile sheet, a div[role=dialog]), so the
    // telemetry toggle/content match two elements globally. <aside> is
    // unique and the one visible at this viewport — scoping avoids the
    // strict-mode violation (and the duplicate-id is a separate #129 issue).
    const panel = page.locator('aside');
    await panel.locator('button[aria-controls="telemetry-content"]').click();
    await expect(panel.locator('#telemetry-content')).toBeVisible();

    // Wait for at least one rendered TelemetryRow. The seed produces one
    // entry; the panel may show extra if re-runs added more.
    const telemetryBody = panel.locator('#telemetry-content');

    // Now the load-bearing assertions: literal values, not the silent
    // "—" placeholder. If the envelope drifts again every one of these
    // becomes "—" and the run goes red - exactly what jsdom missed.
    await expect(telemetryBody).toContainText('UI_TEST_RESET');
    await expect(telemetryBody).toContainText('fw ui-test-1.2.3');
    await expect(telemetryBody).toContainText('-42 dBm');
    // free_heap 204800 -> Math.round(/1024) = 200 KB
    await expect(telemetryBody).toContainText('200 KB');
    // uptime 3601s -> formatUptime: "1h 0m"
    await expect(telemetryBody).toContainText('1h 0m');
  });
});
