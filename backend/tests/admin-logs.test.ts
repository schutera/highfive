import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches.
vi.mock('../src/database', () => ({
  db: {
    refresh: vi.fn().mockResolvedValue(undefined),
    getAllModules: vi.fn().mockReturnValue([]),
    getModuleById: vi.fn().mockReturnValue(null),
    updateModuleStatus: vi.fn().mockReturnValue(false),
  },
}));

import { app } from '../src/app';

const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  // Per-test fetch stub so we can vary upstream behaviour cleanly.
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/modules/:id/logs', () => {
  it('returns 401 without X-API-Key', async () => {
    const res = await request(app).get('/api/modules/m1/logs');
    expect(res.status).toBe(401);
  });

  it('returns 403 when X-Admin-Key header is missing', async () => {
    const res = await request(app)
      .get('/api/modules/m1/logs')
      .set('X-API-Key', KEY);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('returns 403 when X-Admin-Key is wrong', async () => {
    const res = await request(app)
      .get('/api/modules/m1/logs')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', 'not-the-key');
    expect(res.status).toBe(403);
  });

  it('returns 200 with parsed JSON when both keys are correct and upstream returns 200', async () => {
    const payload = { logs: [{ ts: 1, msg: 'hello' }] };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const res = await request(app)
      .get('/api/modules/m1/logs')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns 502 when image-service fetch throws', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const res = await request(app)
      .get('/api/modules/m1/logs')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/image-service unreachable/i);
  });

  it('passes ?limit=N through to the upstream URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ logs: [] }),
    });

    const res = await request(app)
      .get('/api/modules/m1/logs?limit=42')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(200);
    const calledWith = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as string;
    expect(calledWith).toContain('/modules/m1/logs');
    expect(calledWith).toContain('limit=42');
  });
});
