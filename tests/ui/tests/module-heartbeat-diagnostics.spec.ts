import { test, expect } from '@playwright/test';
import type { ModuleDetail } from '@highfive/contracts';

// Pins the #148 heartbeat-diagnostics fields (reset_reason / min_free_heap /
// boot_count) end-to-end in a real browser against the real backend. This
// is the layer CLAUDE.md rule 4 requires for a view that renders wire-shape
// data: vitest + jsdom can't catch a TS-optional wire field collapsing to
// `undefined` (it did exactly that for the telemetry sidecar for weeks —
// chapter 11 "Telemetry sidecar envelope drift"), and only Playwright
// exercises nginx serving + SPA routing.
//
// scripts/seed_ui_fixtures.py::seed_heartbeat_diagnostics sends one
// heartbeat for this MAC with the literal values asserted below.

const HEARTBEAT_MAC = 'ff4444444444';
const RESET_REASON = 'TASK_WDT';
const BOOT_COUNT = 4242;

test.describe('module heartbeat diagnostics (#148)', () => {
  test('HeartbeatDiagnostics renders the seeded reset_reason / boot_count', async ({
    page,
  }) => {
    // 1) Wire-shape round-trip: fetch the module detail the UI consumes and
    //    assert the diagnostic fields survived duckdb -> /heartbeats_summary
    //    -> backend HeartbeatSnapshot. If a rename drifts the boundary this
    //    fails before we touch the DOM.
    const response = await page.request.get(
      `http://localhost:4002/api/modules/${HEARTBEAT_MAC}`,
    );
    expect(response.ok()).toBeTruthy();
    const detail = (await response.json()) as ModuleDetail;
    expect(detail.latestHeartbeat).not.toBeNull();
    expect(detail.latestHeartbeat?.resetReason).toBe(RESET_REASON);
    expect(detail.latestHeartbeat?.bootCount).toBe(BOOT_COUNT);
    expect(detail.latestHeartbeat?.minFreeHeap).toBe(51234);

    // 2) Drive the browser: the card lives in the admin telemetry section
    //    (?admin=1 reveals the toggle). The card itself reads the already-
    //    loaded module payload, so it renders without the admin key.
    await page.goto(`/dashboard?admin=1`);
    await page.getByRole('button', { name: /UI Test Heartbeat/ }).click();

    // Scope to the desktop side panel (ModulePanel renders twice — desktop
    // <aside> + mobile sheet; see dashboard-telemetry.spec.ts for the same
    // strict-mode scoping).
    const panel = page.locator('aside');
    await panel.locator('button[aria-controls="telemetry-content"]').click();
    const telemetryBody = panel.locator('#telemetry-content');
    await expect(telemetryBody).toBeVisible();

    // Load-bearing assertions: literal values, not the silent '—' placeholder.
    await expect(telemetryBody).toContainText('latest heartbeat');
    await expect(telemetryBody).toContainText(RESET_REASON);
    await expect(telemetryBody).toContainText(String(BOOT_COUNT));
    await expect(telemetryBody).toContainText('-58 dBm');
    // min_free_heap 51234 -> Math.round(/1024) = 50 KB
    await expect(telemetryBody).toContainText('50 KB');
    // Seeded with a fault reset (TASK_WDT) at seconds-low uptime → the
    // "recent fault reset" flag must fire (the state the binary
    // online/offline badge keeps misleadingly green).
    await expect(telemetryBody).toContainText(/recent fault reset \(TASK_WDT\)/);
  });
});
