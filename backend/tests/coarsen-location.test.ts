import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModuleReadModel } from '../src/database';
import { PUBLIC_COORD_DECIMALS } from '@highfive/contracts';

/**
 * Coordinate generalization (issue #145, ADR-020). The duckdb-service rounds
 * on write, but the backend re-rounds at the DTO boundary as defence-in-depth
 * so the public API never emits >`PUBLIC_COORD_DECIMALS` even for a
 * not-yet-migrated row. This test drives the REAL `ModuleReadModel` with a
 * precise upstream `lat`/`lng` (the "stale precise row" case) and asserts the
 * assembled DTO is coarse on both the list and detail paths.
 *
 * "Coarsen for everyone": there is no auth branch in the read model, so the
 * same coarse value is what every caller (anonymous or admin) receives —
 * pinned end-to-end at the route level by `modules.test.ts`.
 */

const VALID_ID = 'aabbccddeeff';

// A precise Google-style fix as duckdb hands it back (stringly-typed lat/lng).
const PRECISE_LAT = '47.808612';
const PRECISE_LNG = '9.643301';
// Rounded to 2 dp.
const COARSE_LAT = 47.81;
const COARSE_LNG = 9.64;

function upstreamModule() {
  return {
    id: VALID_ID,
    name: 'Hive 1',
    lat: PRECISE_LAT,
    lng: PRECISE_LNG,
    status: 'online',
    first_online: '2024-01-01',
    battery_level: 80,
    image_count: 0,
    real_image_count: 0,
    last_image_at: null,
    email: null,
    updated_at: null,
    last_seen_at: null,
  };
}

function installFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/heartbeats_summary')) {
      return new Response(JSON.stringify({ summary: {} }), { status: 200 });
    }
    if (url.endsWith('/modules')) {
      return new Response(JSON.stringify({ modules: [upstreamModule()] }), { status: 200 });
    }
    if (url.endsWith('/nests')) {
      return new Response(JSON.stringify({ nests: [] }), { status: 200 });
    }
    if (url.endsWith('/progress')) {
      return new Response(JSON.stringify({ progress: [] }), { status: 200 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('ModuleReadModel — coordinate generalization', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('pins the public precision contract at 2 dp', () => {
    // Guards against a silent loosening of the privacy control.
    expect(PUBLIC_COORD_DECIMALS).toBe(2);
  });

  it('coarsens a precise upstream coordinate on the list path', async () => {
    installFetch();
    const db = new ModuleReadModel();

    const { modules } = await db.listModules();

    expect(modules).toHaveLength(1);
    expect(modules[0].location).toEqual({ lat: COARSE_LAT, lng: COARSE_LNG });
  });

  it('coarsens a precise upstream coordinate on the detail path', async () => {
    installFetch();
    const db = new ModuleReadModel();

    const { detail } = await db.getModuleDetail(VALID_ID as never);

    expect(detail).not.toBeNull();
    expect(detail?.location).toEqual({ lat: COARSE_LAT, lng: COARSE_LNG });
  });
});
