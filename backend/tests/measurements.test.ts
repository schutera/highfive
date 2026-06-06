import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches. Mirrors
// activity-route.test.ts — the measurements routes proxy directly to
// duckdb-service, but the app import must still succeed.
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

describe('GET /api/modules/:id/measurements', () => {
  it('is public — no credential required; reaches the upstream proxy (#142)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'upstream down' }),
    });
    const res = await request(app).get(`/api/modules/${VALID_ID}/measurements?metric=battery_pct`);
    expect(res.status).not.toBe(401);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it('returns 400 on malformed module id and does not call upstream', async () => {
    const res = await request(app)
      .get('/api/modules/not-a-mac/measurements?metric=battery_pct')
      .set('X-API-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid module id format/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps snake_case upstream body to camelCase incl. sample_count → sampleCount', async () => {
    const upstreamBody = {
      module_id: VALID_ID,
      metric: 'battery_pct',
      interval: 'hourly',
      start: '2026-05-13T00:00:00',
      end: '2026-05-20T00:00:00',
      buckets: [
        { timestamp: '2026-05-13T00:00:00', value: null, sample_count: 0 },
        { timestamp: '2026-05-13T01:00:00', value: 87.5, sample_count: 2 },
      ],
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => upstreamBody,
    });

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/measurements?metric=battery_pct&interval=hourly&days=7`)
      .set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      moduleId: VALID_ID,
      metric: 'battery_pct',
      interval: 'hourly',
      start: upstreamBody.start,
      end: upstreamBody.end,
      buckets: [
        { timestamp: '2026-05-13T00:00:00', value: null, sampleCount: 0 },
        { timestamp: '2026-05-13T01:00:00', value: 87.5, sampleCount: 2 },
      ],
    });
  });

  it('forwards metric, interval, and days query params to the upstream URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        module_id: VALID_ID,
        metric: 'battery_pct',
        interval: 'daily',
        start: 'x',
        end: 'y',
        buckets: [],
      }),
    });

    await request(app)
      .get(`/api/modules/${VALID_ID}/measurements?metric=battery_pct&interval=daily&days=30`)
      .set('X-API-Key', KEY);

    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const u = new URL(String(url));
    expect(u.pathname).toBe(`/modules/${VALID_ID}/measurements`);
    expect(u.searchParams.get('metric')).toBe('battery_pct');
    expect(u.searchParams.get('interval')).toBe('daily');
    expect(u.searchParams.get('days')).toBe('30');
  });

  it('forwards upstream 400 (missing metric) verbatim', async () => {
    const payload = { error: "'metric' query parameter is required" };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => payload,
    });

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/measurements`)
      .set('X-API-Key', KEY);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(payload);
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/measurements?metric=battery_pct`)
      .set('X-API-Key', KEY);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });
});

describe('POST /api/modules/:id/measurements', () => {
  const validBody = {
    ts: '2026-05-20T12:00:00Z',
    metric: 'battery_pct',
    value: 87.5,
    source: 'weather-api',
  };

  it('returns 401 without any admin credential', async () => {
    const res = await request(app).post(`/api/modules/${VALID_ID}/measurements`).send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Admin-Key is wrong', async () => {
    const res = await request(app)
      .post(`/api/modules/${VALID_ID}/measurements`)
      .set('X-Admin-Key', 'not-the-key')
      .send(validBody);
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed module id', async () => {
    const res = await request(app)
      .post('/api/modules/not-a-mac/measurements')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send(validBody);
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forwards single measurement with module_mac from the path, not the body', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ inserted: 1 }),
    });

    const res = await request(app)
      .post(`/api/modules/${VALID_ID}/measurements`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ ...validBody, module_mac: '001122334455' }); // bogus override

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ inserted: 1 });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwarded = JSON.parse((init as { body: string }).body);
    expect(forwarded.module_mac).toBe(VALID_ID); // path wins
  });

  it('forwards batch measurements with module_mac stamped on every item', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ inserted: 2 }),
    });

    await request(app)
      .post(`/api/modules/${VALID_ID}/measurements`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({
        measurements: [
          {
            ts: '2026-05-20T12:00:00Z',
            metric: 'temperature_c',
            value: 21.5,
            source: 'weather-api',
          },
          {
            ts: '2026-05-20T13:00:00Z',
            metric: 'temperature_c',
            value: 22.5,
            source: 'weather-api',
          },
        ],
      });

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const forwarded = JSON.parse((init as { body: string }).body);
    expect(forwarded.measurements).toHaveLength(2);
    expect(
      forwarded.measurements.every((m: { module_mac: string }) => m.module_mac === VALID_ID),
    ).toBe(true);
  });

  it('forwards upstream validation error verbatim', async () => {
    const payload = { error: "'value' must be a number" };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => payload,
    });

    const res = await request(app)
      .post(`/api/modules/${VALID_ID}/measurements`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({
        ts: '2026-05-20T12:00:00Z',
        metric: 'battery_pct',
        value: 'not-a-number',
        source: 'x',
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(payload);
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const res = await request(app)
      .post(`/api/modules/${VALID_ID}/measurements`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send(validBody);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });
});
