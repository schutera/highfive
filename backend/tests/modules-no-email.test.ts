import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { parseModuleId } from '@highfive/contracts';
import { ModuleReadModel } from '../src/database';
import { app } from '../src/app';

/**
 * Issue #235 — the operator email the firmware reports is PII with no
 * public consumer, so the read model must not republish it: even when
 * the upstream duckdb payload carries a non-null `email`, neither the
 * list nor the detail shape may contain an `email` key.
 *
 * The fixtures below deliberately carry `email: 'owner@example.com'`
 * upstream — every pre-existing fixture used `null`, which is exactly
 * why the leak was never caught.
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
    email: 'owner@example.com',
    updated_at: null,
    last_seen_at: null,
    ...overrides,
  };
}

function mockFetch(modules: unknown[]) {
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/modules')) {
      return new Response(JSON.stringify({ modules }), { status: 200 });
    }
    if (url.endsWith('/nests')) {
      return new Response(JSON.stringify({ nests: [] }), { status: 200 });
    }
    if (url.includes('/progress')) {
      return new Response(JSON.stringify({ progress: [] }), { status: 200 });
    }
    if (url.includes('/heartbeats_summary')) {
      return new Response(JSON.stringify({ summary: {} }), { status: 200 });
    }
    throw new Error(`unmocked fetch: ${url}`);
  }) as typeof fetch;
}

describe('ModuleReadModel — owner email stripped from the public wire (#235)', () => {
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

  it('listModules() emits no email key', async () => {
    mockFetch([fakeModule()]);
    const db = new ModuleReadModel();

    const { modules } = await db.listModules();

    expect(modules).toHaveLength(1);
    expect(modules[0]).not.toHaveProperty('email');
  });

  it('getModuleDetail() emits no email key', async () => {
    mockFetch([fakeModule()]);
    const db = new ModuleReadModel();

    const { detail } = await db.getModuleDetail(parseModuleId('aabbccddeeff'));

    expect(detail).not.toBeNull();
    expect(detail).not.toHaveProperty('email');
  });

  it('GET /api/modules and /:id carry no email end to end', async () => {
    // Real read model + real routes, only fetch mocked: pins the
    // contract a dashboard visitor actually observes.
    mockFetch([fakeModule()]);
    const list = await request(app).get('/api/modules');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).not.toHaveProperty('email');

    const detail = await request(app).get('/api/modules/aabbccddeeff');
    expect(detail.status).toBe(200);
    expect(detail.body).not.toHaveProperty('email');
  });
});
