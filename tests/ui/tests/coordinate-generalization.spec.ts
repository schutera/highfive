import { test, expect } from '@playwright/test';

// Coordinate generalization (issue #145, ADR-020). The public read API must
// never serve a coordinate finer than ~1 km (2 dp) — for ANY caller. This spec
// proves it end-to-end through the production-built backend image (Express DTO
// boundary → duckdb round-on-write), which vitest + jsdom can't: that layer
// mocks the API and never exercises the real duckdb write path (CLAUDE.md #5).
//
// We hit the BACKEND origin directly, not the homepage origin. In production
// the homepage and API are separate origins (ADR-019) — the homepage nginx
// serves only static assets and falls back to index.html for unknown paths, so
// `GET /api/modules` against :6173 would return the SPA HTML, not JSON. The SPA
// itself calls the backend at `VITE_API_URL` (http://localhost:4002/api in the
// UI stack); we mirror that, defaulting to the docker-compose.ui.yml backend
// port and matching seed_ui_fixtures.py's BACKEND_URL.
//
// seed_ui_fixtures.py registers "UI Test Precise Coords" (ff3333333333) with a
// deliberately precise 6-dp fix (47.808612, 9.643301). add_module rounds it on
// write, so the served value must be exactly (47.81, 9.64).

const BACKEND_URL = process.env.UI_BACKEND_URL ?? 'http://localhost:4002';
const PRECISE_MODULE_NAME = 'UI Test Precise Coords';
const EXPECTED_LAT = 47.81;
const EXPECTED_LNG = 9.64;

// Coordinates carry no more than this many decimal places once served.
const MAX_DECIMALS = 2;

function decimalPlaces(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = String(n);
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

type WireModule = { name: string; location: { lat: number; lng: number } };

async function fetchModules(
  request: import('@playwright/test').APIRequestContext,
): Promise<WireModule[]> {
  const res = await request.get(`${BACKEND_URL}/api/modules`);
  expect(res.ok(), `GET ${BACKEND_URL}/api/modules failed: ${res.status()}`).toBeTruthy();
  return (await res.json()) as WireModule[];
}

test.describe('coordinate generalization', () => {
  test('public /api/modules serves the precise fixture coarsened to 2 dp', async ({ request }) => {
    // The public read — no credential.
    const modules = await fetchModules(request);

    const precise = modules.find((m) => m.name === PRECISE_MODULE_NAME);
    expect(precise, `seed module "${PRECISE_MODULE_NAME}" missing`).toBeTruthy();
    // The precise 6-dp input was generalized server-side to exactly 2 dp.
    expect(precise!.location.lat).toBe(EXPECTED_LAT);
    expect(precise!.location.lng).toBe(EXPECTED_LNG);
  });

  test('no module is served with a coordinate finer than 2 dp', async ({ request }) => {
    // Fleet-wide invariant: the generalization is unconditional, so EVERY
    // module — seed data included — comes back at ≤ 2 dp.
    const modules = await fetchModules(request);
    expect(modules.length).toBeGreaterThan(0);

    for (const m of modules) {
      expect(
        decimalPlaces(m.location.lat),
        `${m.name} lat ${m.location.lat} exceeds ${MAX_DECIMALS} dp`,
      ).toBeLessThanOrEqual(MAX_DECIMALS);
      expect(
        decimalPlaces(m.location.lng),
        `${m.name} lng ${m.location.lng} exceeds ${MAX_DECIMALS} dp`,
      ).toBeLessThanOrEqual(MAX_DECIMALS);
    }
  });
});
