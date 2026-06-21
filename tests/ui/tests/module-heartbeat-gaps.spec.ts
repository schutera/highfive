import { test, expect } from '@playwright/test';
import type { HeartbeatGap } from '@highfive/contracts';

// Pins the #172-opt-3 heartbeat-gaps feature end-to-end in a real browser
// against the real backend (CLAUDE.md "Verifying UI claims" rule 4 / ADR-014).
// The card's fields cross the backend↔homepage boundary via a hand-written
// snake→camel map in backend/src/app.ts (gap_start→gapStart, …) — exactly the
// drift-renders-undefined path Playwright exists to close, which the isolated
// component test (HeartbeatGaps.test.tsx, hand-built fixture) structurally
// cannot catch.
//
// duckdb-service SEED_DATA seeds two backdated heartbeats ~4 h apart on module
// 000000000005 (Bergblick), bracketing one > 90 min silent window — the gap
// can only be created by backdated DB rows since the /heartbeat ingestion API
// stamps received_at = now(). The HeartbeatGap type is imported from
// @highfive/contracts so a future rename at the wire boundary is a compile
// error here, not a silent undefined-pluck (ADR-004).

const GAP_MODULE = '000000000005';
const ADMIN_PASSWORD = 'hf_test_key'; // matches docker-compose.ui.yml HIGHFIVE_API_KEY
const API = 'http://localhost:4002';

test.describe('module heartbeat gaps (#172 option 3)', () => {
  test.beforeEach(async ({ page }) => {
    // Establish the admin session (#142 / ADR-019): the gaps endpoint is
    // admin-gated, like the telemetry logs.
    const login = await page.request.post(`${API}/api/admin/login`, {
      data: { password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
  });

  test('HeartbeatGaps renders the seeded silent window', async ({ page }) => {
    // 1) Wire-shape round-trip through the same admin endpoint the UI uses. If
    //    the backend's snake→camel map drifts, gapStart/gapEnd/gapSeconds come
    //    back undefined and this fails before we touch the DOM.
    const response = await page.request.get(`${API}/api/modules/${GAP_MODULE}/heartbeat-gaps`, {
      headers: { 'X-Admin-Key': ADMIN_PASSWORD },
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { gaps: HeartbeatGap[] };
    // Exactly one seeded window (two backdated heartbeats ~4 h apart). Asserting
    // `=== 1` rather than `>= 1` so a future SEED_DATA change that injects a
    // third heartbeat inside the window — splitting the gap — fails loudly here.
    expect(body.gaps.length).toBe(1);
    const gap = body.gaps[0];
    // camelCase fields are present and well-formed (not undefined).
    expect(typeof gap.gapStart).toBe('string');
    expect(typeof gap.gapEnd).toBe('string');
    // ~4 h seeded window, comfortably over the 90 min threshold.
    expect(gap.gapSeconds).toBeGreaterThan(90 * 60);
    expect(new Date(gap.gapEnd).getTime()).toBeGreaterThan(new Date(gap.gapStart).getTime());

    // 2) Drive the browser: the card lives in the admin Telemetry section and
    //    only renders once the admin session resolves and gaps load.
    await page.goto(`/dashboard?admin=1`);
    await page.getByRole('button', { name: /Bergblick/ }).click();

    const panel = page.locator('aside');
    await panel.locator('button[aria-controls="telemetry-content"]').click();
    const telemetryBody = panel.locator('#telemetry-content');
    await expect(telemetryBody).toBeVisible();

    // Load-bearing: the card heading and a humanised gap duration render — not
    // a silent absence. The seeded ~4 h window formats via formatUptime as
    // "3h 5..m" / "4h 0m" depending on the seconds boundary, so assert the
    // stable "h " hour marker inside a "gap" line rather than an exact minute.
    await expect(telemetryBody).toContainText('heartbeat gaps');
    await expect(telemetryBody.getByText(/h \d+m gap/)).toBeVisible();
  });
});
