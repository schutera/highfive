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
// #172 failure-streak fields seeded alongside the #148 ones.
const LAST_FAIL_CODE = -2;
const LAST_FAIL_COUNT = 2;
// #172 opt 2: stage breadcrumb carried on the heartbeat (was sidecar-only).
const LAST_STAGE = 'loop:livenessReboot';

test.describe('module heartbeat diagnostics (#148, #172)', () => {
  test('HeartbeatDiagnostics renders the seeded reset_reason / boot_count / hb-fail streak', async ({
    page,
  }) => {
    // 1) Wire-shape round-trip: fetch the module detail the UI consumes and
    //    assert the diagnostic fields survived duckdb -> /heartbeats_summary
    //    -> backend HeartbeatSnapshot. If a rename drifts the boundary this
    //    fails before we touch the DOM.
    const response = await page.request.get(`http://localhost:4002/api/modules/${HEARTBEAT_MAC}`);
    expect(response.ok()).toBeTruthy();
    const detail = (await response.json()) as ModuleDetail;
    expect(detail.latestHeartbeat).not.toBeNull();
    expect(detail.latestHeartbeat?.resetReason).toBe(RESET_REASON);
    expect(detail.latestHeartbeat?.bootCount).toBe(BOOT_COUNT);
    expect(detail.latestHeartbeat?.minFreeHeap).toBe(51234);
    // #172: the failure streak survived the same boundary.
    expect(detail.latestHeartbeat?.lastHbFailCode).toBe(LAST_FAIL_CODE);
    expect(detail.latestHeartbeat?.lastHbFailCount).toBe(LAST_FAIL_COUNT);
    // #172 opt 2: the stage breadcrumb survived the same boundary — proving it
    // now rides the heartbeat (previously sidecar-only, up to 24 h late).
    expect(detail.latestHeartbeat?.lastStageBeforeReboot).toBe(LAST_STAGE);

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
    // #172: the prior heartbeat-failure streak surfaces both as the grid
    // count and the "possible reboot loop" banner — the remote-visibility
    // signal that, in #170, needed a physical serial capture to see.
    await expect(telemetryBody).toContainText('hb fails');
    await expect(telemetryBody).toContainText(
      /2 heartbeats failed before last contact \(connect\/WiFi\)/,
    );
    // #172 opt 2: the stage breadcrumb renders on the heartbeat card.
    await expect(telemetryBody).toContainText('stage at previous reboot');
    await expect(telemetryBody).toContainText(LAST_STAGE);
  });
});
