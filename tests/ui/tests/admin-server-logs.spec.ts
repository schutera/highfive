import { test, expect } from '@playwright/test';
import type { ServerLogsResponse } from '@highfive/contracts';

// Pins the #171 admin server-logs view (CLAUDE.md rule #4 / ADR-014): mounts
// the production-built homepage against the real backend, which serves its own
// in-memory ring directly and proxies to the Flask services' internal /logs.
// Vitest+jsdom (ServerLogsPanel.test.tsx) pins the client round-trip, but only
// this layer proves the admin-gated route, the cross-service proxy auth
// (backend forwards X-Admin-Key), and SPA rendering actually work end-to-end.

const ADMIN_PASSWORD = 'hf_test_key'; // matches docker-compose.ui.yml HIGHFIVE_API_KEY
const API = 'http://localhost:4002';

test.describe('admin server logs (#171)', () => {
  test.beforeEach(async ({ page }) => {
    const login = await page.request.post(`${API}/api/admin/login`, {
      data: { password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();
  });

  test('endpoint returns each service ring; UI renders the tail and switches services', async ({
    page,
  }) => {
    // 1) Wire-shape round trip against the real backend for all three
    //    services. `backend` reads its own ring; the other two are proxied
    //    with the forwarded machine credential — a 401 here would mean the
    //    cross-service key wiring is broken.
    for (const service of ['backend', 'duckdb-service', 'image-service'] as const) {
      const resp = await page.request.get(`${API}/api/admin/logs?service=${service}&lines=50`);
      expect(resp.ok()).toBeTruthy();
      const body = (await resp.json()) as ServerLogsResponse;
      expect(body.service).toBe(service);
      expect(Array.isArray(body.lines)).toBeTruthy();
      expect(typeof body.truncated).toBe('boolean');
    }

    // A non-allow-listed service is rejected, not proxied.
    const bad = await page.request.get(`${API}/api/admin/logs?service=nginx`);
    expect(bad.status()).toBe(400);

    // 2) Drive the browser: the panel defaults to `backend` and loads on
    //    mount. The backend logs its startup banner through the ring, so the
    //    output is non-empty.
    await page.goto('/admin');
    const output = page.getByTestId('server-logs-output');
    await expect(output).toBeVisible();
    await expect(output).not.toBeEmpty();

    // 3) Switch to duckdb-service → the panel refetches and renders that
    //    service's ring (proves the proxy path through the UI).
    await page.getByTestId('log-service-select').selectOption('duckdb-service');
    await expect
      .poll(async () => (await output.textContent())?.length ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});
