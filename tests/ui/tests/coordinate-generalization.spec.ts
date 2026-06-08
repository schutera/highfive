import { test, expect } from '@playwright/test';

// Coordinate generalization (issue #145, ADR-020). The public read API must
// never serve a coordinate finer than ~1 km (2 dp) — for ANY caller. This is
// the only layer that proves it end-to-end through the production-built stack:
// nginx → backend DTO boundary → duckdb (round-on-write). Vitest + jsdom can't,
// because it mocks the API and never exercises nginx serving or the real
// duckdb write path (CLAUDE.md rule #4).
//
// seed_ui_fixtures.py registers "UI Test Precise Coords" (ff3333333333) with a
// deliberately precise 6-dp fix (47.808612, 9.643301). add_module rounds it on
// write, so the served value must be exactly (47.81, 9.64).

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

test.describe('coordinate generalization', () => {
  test('public /api/modules serves the precise fixture coarsened to 2 dp', async ({ request }) => {
    // Hit the API through the homepage origin (nginx proxies /api → backend),
    // the same path the browser uses — no credential, i.e. the public read.
    const res = await request.get('/api/modules');
    expect(res.ok()).toBeTruthy();
    const modules = (await res.json()) as Array<{
      name: string;
      location: { lat: number; lng: number };
    }>;

    const precise = modules.find((m) => m.name === PRECISE_MODULE_NAME);
    expect(precise, `seed module "${PRECISE_MODULE_NAME}" missing`).toBeTruthy();
    // The precise 6-dp input was generalized server-side to exactly 2 dp.
    expect(precise!.location.lat).toBe(EXPECTED_LAT);
    expect(precise!.location.lng).toBe(EXPECTED_LNG);
  });

  test('no module is served with a coordinate finer than 2 dp', async ({ request }) => {
    // Fleet-wide invariant: the generalization is unconditional, so EVERY
    // module — seed data included — comes back at ≤ 2 dp.
    const res = await request.get('/api/modules');
    expect(res.ok()).toBeTruthy();
    const modules = (await res.json()) as Array<{
      name: string;
      location: { lat: number; lng: number };
    }>;
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
