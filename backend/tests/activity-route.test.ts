import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches. Mirrors
// admin-delete.test.ts's setup — the activity route does NOT hit the
// db layer (it proxies directly to duckdb-service), but the app import
// must still succeed.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

import { app } from '../src/app';

const KEY = 'hf_dev_key_2026';
const VALID_ID = 'aabbccddeeff';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/modules/:id/activity', () => {
  it('returns 401 without X-API-Key', async () => {
    const res = await request(app).get(`/api/modules/${VALID_ID}/activity`);
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed module id and does not call upstream', async () => {
    const res = await request(app).get('/api/modules/not-a-mac/activity').set('X-API-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid module id format/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps snake_case upstream body to camelCase', async () => {
    const upstreamBody = {
      module_id: VALID_ID,
      interval: 'hourly',
      start: '2026-05-13T00:00:00',
      end: '2026-05-20T00:00:00',
      buckets: [
        { timestamp: '2026-05-13T00:00:00', count: 0 },
        { timestamp: '2026-05-13T01:00:00', count: 3 },
      ],
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => upstreamBody,
    });

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/activity?interval=hourly&days=7`)
      .set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      moduleId: VALID_ID,
      interval: 'hourly',
      start: upstreamBody.start,
      end: upstreamBody.end,
      buckets: upstreamBody.buckets,
    });
  });

  it('forwards interval and days query params to the upstream URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        module_id: VALID_ID,
        interval: 'daily',
        start: 'x',
        end: 'y',
        buckets: [],
      }),
    });

    await request(app)
      .get(`/api/modules/${VALID_ID}/activity?interval=daily&days=30`)
      .set('X-API-Key', KEY);

    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toBe(`/modules/${VALID_ID}/activity_timeseries`);
    expect(u.searchParams.get('interval')).toBe('daily');
    expect(u.searchParams.get('days')).toBe('30');
  });

  it('forwards upstream 404 verbatim', async () => {
    const payload = { error: 'Module not found' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => payload,
    });

    const res = await request(app).get(`/api/modules/${VALID_ID}/activity`).set('X-API-Key', KEY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(payload);
  });

  it('forwards upstream 400 verbatim (e.g. invalid interval)', async () => {
    const payload = { error: 'invalid interval', detail: "must be 'hourly' or 'daily'" };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => payload,
    });

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/activity?interval=weekly`)
      .set('X-API-Key', KEY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(payload);
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const res = await request(app).get(`/api/modules/${VALID_ID}/activity`).set('X-API-Key', KEY);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });
});
