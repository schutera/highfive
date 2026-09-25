import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModuleReadModel } from '../src/database';

/**
 * Issue #230 — the read-model fan-out must attribute failures per leg:
 * a failed `/modules` leg surfaces as `modules` in `failedLegs` (the
 * route layer turns it into a 503), failed `/nests` / `/progress` legs
 * surface as their names (the route layer joins them into the
 * X-Highfive-Data-Incomplete header), and degraded snapshots are never
 * cached.
 *
 * Each leg is driven through BOTH failure modes — a thrown fetch and a
 * 500 Response (which exercises `fetchJsonOk`'s non-2xx path, not just
 * the network-error path).
 */

function fakeModule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aabbccddeeff',
    name: 'Hive 1',
    display_name: null,
    lat: '47.0',
    lng: '9.0',
    first_online: '2024-01-01',
    battery_level: 80,
    image_count: 0,
    real_image_count: 0,
    last_image_at: null,
    email: null,
    updated_at: null,
    last_seen_at: null,
    ...overrides,
  };
}

type LegMode = 'throw' | 'http500';

function mockFetch(
  failures: Partial<Record<'modules' | 'nests' | 'progress' | 'heartbeats', LegMode>>,
) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const leg: 'modules' | 'nests' | 'progress' | 'heartbeats' | null = url.endsWith('/modules')
      ? 'modules'
      : url.endsWith('/nests')
        ? 'nests'
        : url.includes('/progress')
          ? 'progress'
          : url.includes('/heartbeats_summary')
            ? 'heartbeats'
            : null;
    if (leg === null) {
      throw new Error(`unmocked fetch: ${url}`);
    }
    const mode = failures[leg];
    if (mode === 'throw') {
      throw new Error(`${leg} endpoint unreachable`);
    }
    if (mode === 'http500') {
      return new Response('{"error":"boom"}', { status: 500 });
    }
    if (leg === 'modules') {
      return new Response(JSON.stringify({ modules: [fakeModule()] }), { status: 200 });
    }
    if (leg === 'nests') {
      return new Response(JSON.stringify({ nests: [] }), { status: 200 });
    }
    if (leg === 'progress') {
      return new Response(JSON.stringify({ progress: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ summary: {} }), { status: 200 });
  }) as typeof fetch;
}

describe('ModuleReadModel — per-leg failure attribution (#230)', () => {
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

  it.each([['throw'], ['http500']] as LegMode[][])(
    'reports the modules leg on %s',
    async (mode) => {
      mockFetch({ modules: mode });
      const db = new ModuleReadModel();

      const { modules, failedLegs } = await db.listModules();

      expect(failedLegs).toEqual(['modules']);
      expect(modules).toEqual([]);
    },
  );

  it.each([['throw'], ['http500']] as LegMode[][])(
    'reports the nests leg on %s, modules still listed',
    async (mode) => {
      mockFetch({ nests: mode });
      const db = new ModuleReadModel();

      const { modules, failedLegs } = await db.listModules();

      expect(failedLegs).toEqual(['nests']);
      expect(modules).toHaveLength(1);
    },
  );

  it.each([['throw'], ['http500']] as LegMode[][])(
    'reports the progress leg on %s',
    async (mode) => {
      mockFetch({ progress: mode });
      const db = new ModuleReadModel();

      const { failedLegs } = await db.listModules();

      expect(failedLegs).toEqual(['progress']);
    },
  );

  it('reports multiple legs in stable order', async () => {
    mockFetch({ nests: 'http500', heartbeats: 'throw' });
    const db = new ModuleReadModel();

    const { failedLegs } = await db.listModules();

    expect(failedLegs).toEqual(['nests', 'heartbeats']);
  });

  it('does not cache a snapshot with a failed modules leg', async () => {
    let calls = 0;
    const inner = async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.endsWith('/modules')) {
        throw new Error('modules endpoint unreachable');
      }
      if (url.endsWith('/nests')) {
        return new Response(JSON.stringify({ nests: [] }), { status: 200 });
      }
      if (url.includes('/progress')) {
        return new Response(JSON.stringify({ progress: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ summary: {} }), { status: 200 });
    };
    globalThis.fetch = vi.fn(inner) as typeof fetch;
    const db = new ModuleReadModel();

    await db.listModules();
    await db.listModules();

    // Two full fan-outs (4 fetches each) — the degraded snapshot from
    // the first call was served but never stored.
    expect(calls).toBe(8);
  });
});
