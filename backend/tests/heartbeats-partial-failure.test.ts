import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModuleReadModel } from '../src/database';

/**
 * Issue #31 — when the duckdb /heartbeats_summary fetch fails, modules
 * whose dominant freshness signal is the heartbeat (most modules — they
 * heartbeat every 60 s but only image on motion) used to silently flip
 * to 'offline'. The read model now classifies them as 'unknown' instead
 * and surfaces a heartbeatsFailed flag the route handler turns into the
 * X-Highfive-Data-Incomplete response header.
 *
 * These tests drive the real ModuleReadModel through a mocked global
 * fetch. We don't go through the express layer because that would mix
 * route + classification concerns; modules.test.ts already covers the
 * header-emission contract via a mocked db.listModules.
 */

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const FRESH = (offsetMs = 0) => new Date(Date.now() - offsetMs).toISOString();

interface UpstreamModule {
  id: string;
  name: string;
  lat: string;
  lng: string;
  status: 'online' | 'offline';
  first_online: string;
  battery_level: number;
  image_count: number;
  real_image_count: number;
  last_image_at: string | null;
  email: string | null;
  updated_at: string | null;
}

function fakeModule(overrides: Partial<UpstreamModule> = {}): UpstreamModule {
  return {
    id: 'aabbccddeeff',
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
    ...overrides,
  };
}

/**
 * Wire fetch to resolve modules/nests/progress with the given payloads
 * and either resolve or reject the heartbeats endpoint.
 */
function mockFetch(opts: {
  modules: UpstreamModule[];
  nests?: unknown[];
  progress?: unknown[];
  heartbeats?: 'reject' | { summary: Record<string, unknown> };
}) {
  const { modules, nests = [], progress = [], heartbeats = { summary: {} } } = opts;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/heartbeats_summary')) {
      if (heartbeats === 'reject') {
        throw new Error('heartbeats endpoint unreachable');
      }
      return new Response(JSON.stringify(heartbeats), { status: 200 });
    }
    if (url.endsWith('/modules')) {
      return new Response(JSON.stringify({ modules }), { status: 200 });
    }
    if (url.endsWith('/nests')) {
      return new Response(JSON.stringify({ nests }), { status: 200 });
    }
    if (url.endsWith('/progress')) {
      return new Response(JSON.stringify({ progress }), { status: 200 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  }) as typeof fetch;
}

describe('ModuleReadModel — heartbeats fetch failure (#31)', () => {
  let originalFetch: typeof fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    warnSpy.mockRestore();
  });

  it('flags heartbeatsFailed=false on the happy path', async () => {
    mockFetch({ modules: [fakeModule()] });
    const db = new ModuleReadModel();

    const { modules, heartbeatsFailed } = await db.listModules();

    expect(heartbeatsFailed).toBe(false);
    expect(modules).toHaveLength(1);
  });

  it('flags heartbeatsFailed=true when /heartbeats_summary rejects', async () => {
    mockFetch({ modules: [fakeModule()], heartbeats: 'reject' });
    const db = new ModuleReadModel();

    const { heartbeatsFailed } = await db.listModules();

    expect(heartbeatsFailed).toBe(true);
    // Existing diagnostic line stays — humans grep for this in the logs.
    expect(warnSpy).toHaveBeenCalledWith(
      '⚠️ Failed to fetch heartbeats:',
      expect.any(Error),
    );
  });

  it("classifies a module with no last_image_at and no updated_at as 'unknown' on heartbeat failure", async () => {
    mockFetch({
      modules: [
        fakeModule({
          id: 'aabbccddeeff',
          last_image_at: null,
          updated_at: null,
        }),
      ],
      heartbeats: 'reject',
    });
    const db = new ModuleReadModel();

    const { modules } = await db.listModules();

    expect(modules[0].status).toBe('unknown');
  });

  it("still classifies a module as 'online' when it has a recent image (heartbeat failure shouldn't lose other signals)", async () => {
    // Module imaged 30 min ago — well within the 2h liveness window.
    mockFetch({
      modules: [
        fakeModule({
          id: 'aabbccddeeff',
          last_image_at: FRESH(30 * 60 * 1000),
        }),
      ],
      heartbeats: 'reject',
    });
    const db = new ModuleReadModel();

    const { modules } = await db.listModules();

    expect(modules[0].status).toBe('online');
  });

  it("classifies a module with stale image and stale updatedAt as 'unknown' on heartbeat failure (the production case)", async () => {
    // The case the fix exists for. `updated_at` is set permanently at
    // registration and is days-to-months stale on every healthy module
    // — gating 'unknown' on `!m.updated_at` (an earlier draft) made the
    // 'unknown' branch unreachable for the exact population #31 was for.
    // The right rule: "would-be-offline AND heartbeats failed →
    // unknown" — we can't rule out the heartbeat from a minute ago that
    // would have flipped this to online.
    mockFetch({
      modules: [
        fakeModule({
          id: 'aabbccddeeff',
          last_image_at: FRESH(3 * TWO_HOURS_MS),
          updated_at: FRESH(2 * TWO_HOURS_MS),
        }),
      ],
      heartbeats: 'reject',
    });
    const db = new ModuleReadModel();

    const { modules } = await db.listModules();

    expect(modules[0].status).toBe('unknown');
  });

  it('falls back to offline (not unknown) when heartbeats succeed but no signal is fresh', async () => {
    // Heartbeats endpoint is up but returned no entry for this module
    // and the image/registration timestamps are stale. The bug we're
    // fixing only kicks in when heartbeats themselves fail; a healthy
    // empty heartbeat summary should still produce 'offline'.
    mockFetch({
      modules: [
        fakeModule({
          id: 'aabbccddeeff',
          last_image_at: null,
          updated_at: null,
        }),
      ],
      heartbeats: { summary: {} },
    });
    const db = new ModuleReadModel();

    const { modules, heartbeatsFailed } = await db.listModules();

    expect(heartbeatsFailed).toBe(false);
    expect(modules[0].status).toBe('offline');
  });

  it('getModuleDetail surfaces heartbeatsFailed alongside the detail', async () => {
    mockFetch({
      modules: [fakeModule({ id: 'aabbccddeeff' })],
      heartbeats: 'reject',
    });
    const db = new ModuleReadModel();

    const { detail, heartbeatsFailed } = await db.getModuleDetail(
      'aabbccddeeff' as never,
    );

    expect(detail).not.toBeNull();
    expect(heartbeatsFailed).toBe(true);
  });
});
