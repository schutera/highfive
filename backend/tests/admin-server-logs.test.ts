import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so the app import doesn't trigger real fetches.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

// Control the backend's own ring without touching real stdout.
vi.mock('../src/logRing', () => ({
  installLogRing: vi.fn(),
  getRecentLogLines: vi.fn(() => ({
    lines: ['backend line 1', 'backend line 2'],
    truncated: false,
  })),
}));

import { app } from '../src/app';
import { getRecentLogLines } from '../src/logRing';

const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GET /api/admin/logs (#171)', () => {
  it('returns 401 without an admin credential', async () => {
    const res = await request(app).get('/api/admin/logs?service=backend');
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on a missing service and does not call upstream', async () => {
    const res = await request(app).get('/api/admin/logs').set('X-Admin-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid service/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-allow-listed service (e.g. nginx)', async () => {
    const res = await request(app).get('/api/admin/logs?service=nginx').set('X-Admin-Key', KEY);
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('serves the backend ring directly (no upstream fetch)', async () => {
    const res = await request(app).get('/api/admin/logs?service=backend').set('X-Admin-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      service: 'backend',
      lines: ['backend line 1', 'backend line 2'],
      truncated: false,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('proxies duckdb-service logs, forwarding X-Admin-Key and the lines param', async () => {
    const payload = { service: 'duckdb-service', lines: ['db line'], truncated: false };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const res = await request(app)
      .get('/api/admin/logs?service=duckdb-service&lines=50')
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
    const [url, opts] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/logs\?lines=50$/);
    expect((opts as { headers: Record<string, string> }).headers['X-Admin-Key']).toBe(KEY);
  });

  it('clamps lines above the cap to 1000 and a non-numeric value to the default 200', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ service: 'image-service', lines: [], truncated: false }),
    });

    await request(app)
      .get('/api/admin/logs?service=image-service&lines=99999')
      .set('X-Admin-Key', KEY);
    await request(app)
      .get('/api/admin/logs?service=image-service&lines=abc')
      .set('X-Admin-Key', KEY);

    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(calls[0][0])).toMatch(/lines=1000$/);
    expect(String(calls[1][0])).toMatch(/lines=200$/);
  });

  it('returns 502 when the upstream service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );
    const res = await request(app)
      .get('/api/admin/logs?service=duckdb-service')
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('returns 502 when the upstream responds non-2xx', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    const res = await request(app)
      .get('/api/admin/logs?service=image-service')
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
    // The backend ring mock should not have been consulted for a proxied service.
    expect(getRecentLogLines).not.toHaveBeenCalled();
  });
});
