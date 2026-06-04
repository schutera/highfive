import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModuleReadModel } from '../src/database';

/**
 * perf/dashboard-load — the read model caches one assembled fleet
 * snapshot for a short TTL so the dominant access pattern (dashboard
 * loads `/api/modules`, operator clicks a module → `/api/modules/:id`
 * fires moments later) doesn't re-run the four-endpoint duckdb fan-out
 * twice. Pre-cache, `getModuleDetail` re-fetched every module, nest,
 * progress row, and heartbeat just to find one module by id.
 *
 * These tests count real upstream `fetch` calls through a mocked global
 * fetch — "envelope right, behaviour wrong" would be a test that only
 * checks the returned data and never proves the second call was served
 * from memory. Four endpoints per fan-out (`/modules`, `/nests`,
 * `/progress`, `/heartbeats_summary`), so one fan-out == 4 fetches.
 */

const FETCHES_PER_FANOUT = 4;
const VALID_ID = 'aabbccddeeff';

function upstreamModule() {
  return {
    id: VALID_ID,
    name: 'Hive 1',
    lat: '47.0',
    lng: '9.0',
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

function installCountingFetch() {
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

describe('ModuleReadModel — short-TTL assembly cache', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('serves a second call from cache (one fan-out for list + immediate detail)', async () => {
    const fetchMock = installCountingFetch();
    const db = new ModuleReadModel();

    await db.listModules();
    const { detail } = await db.getModuleDetail(VALID_ID as never);

    // The detail came back correctly...
    expect(detail).not.toBeNull();
    expect(detail?.id).toBe(VALID_ID);
    // ...without a second four-endpoint fan-out.
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_FANOUT);
  });

  it('dedupes concurrent callers onto a single in-flight fan-out', async () => {
    const fetchMock = installCountingFetch();
    const db = new ModuleReadModel();

    // Fire both before either resolves — they must share one fan-out.
    const [list, detail] = await Promise.all([
      db.listModules(),
      db.getModuleDetail(VALID_ID as never),
    ]);

    expect(list.modules).toHaveLength(1);
    expect(detail.detail).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_FANOUT);
  });

  it('does NOT cache a degraded fan-out (a failed upstream fetch must not pin partial state)', async () => {
    // Heartbeats endpoint rejects → the snapshot is `degraded`, so the
    // second call must re-fetch rather than serve the partial result
    // from cache. Otherwise a transient duckdb outage would freeze a
    // stuck `heartbeatsFailed` / empty fleet for a full TTL after
    // recovery.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/heartbeats_summary')) {
        throw new Error('heartbeats endpoint unreachable');
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
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = new ModuleReadModel();

    const first = await db.listModules();
    const second = await db.listModules();

    expect(first.heartbeatsFailed).toBe(true);
    expect(second.heartbeatsFailed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_FANOUT * 2);
    warnSpy.mockRestore();
  });

  it('re-fetches once the cached snapshot is older than the TTL', async () => {
    vi.useFakeTimers();
    const fetchMock = installCountingFetch();
    const db = new ModuleReadModel();

    await db.listModules();
    // Past the 5 s TTL — the next call must trigger a fresh fan-out.
    vi.advanceTimersByTime(6000);
    await db.listModules();

    expect(fetchMock).toHaveBeenCalledTimes(FETCHES_PER_FANOUT * 2);
  });
});
