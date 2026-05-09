import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Same vi.hoisted pattern as modules.test.ts so the read-model can be
// driven per-test and a thrown rejection lands in the route's catch block.
const mocks = vi.hoisted(() => ({
  listModules: vi.fn(),
  getModuleDetail: vi.fn(),
}));

vi.mock('../src/database', () => ({
  db: {
    listModules: mocks.listModules,
    getModuleDetail: mocks.getModuleDetail,
  },
}));

import { app } from '../src/app';

const KEY = 'hf_dev_key_2026';
const VALID_ID = 'aabbccddeeff';

describe('5xx-returning catch blocks log structured errors (#32)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    mocks.listModules.mockReset();
    mocks.getModuleDetail.mockReset();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    consoleError.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it('GET /api/modules logs and 500s when db.listModules rejects', async () => {
    mocks.listModules.mockRejectedValue(new Error('duckdb gone'));

    const res = await request(app).get('/api/modules').set('X-API-Key', KEY);

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      '[GET /api/modules]',
      expect.objectContaining({ error: expect.stringContaining('duckdb gone') }),
    );
  });

  it('GET /api/modules/:id logs and 500s when db.getModuleDetail rejects', async () => {
    mocks.getModuleDetail.mockRejectedValue(new Error('detail boom'));

    const res = await request(app).get(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(500);
    expect(consoleError).toHaveBeenCalledWith(
      '[GET /api/modules/:id]',
      expect.objectContaining({
        id: VALID_ID,
        error: expect.stringContaining('detail boom'),
      }),
    );
  });

  it('GET /api/images/:filename (public proxy) logs and 502s when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('image-service down')) as typeof fetch;

    const res = await request(app).get('/api/images/foo.jpg');

    expect(res.status).toBe(502);
    expect(consoleError).toHaveBeenCalledWith(
      '[GET /api/images/:filename]',
      expect.objectContaining({
        filename: 'foo.jpg',
        error: expect.stringContaining('image-service down'),
      }),
    );
  });

  it('GET /api/images logs and 502s when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('img-list down')) as typeof fetch;

    const res = await request(app).get('/api/images?module_id=aabbccddeeff').set('X-API-Key', KEY);

    expect(res.status).toBe(502);
    expect(consoleError).toHaveBeenCalledWith(
      '[GET /api/images]',
      expect.objectContaining({
        moduleId: 'aabbccddeeff',
        error: expect.stringContaining('img-list down'),
      }),
    );
  });

  it('DELETE /api/images/:filename logs and 502s when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('delete fetch down')) as typeof fetch;

    const res = await request(app).delete('/api/images/foo.jpg').set('X-API-Key', KEY);

    expect(res.status).toBe(502);
    expect(consoleError).toHaveBeenCalledWith(
      '[DELETE /api/images/:filename]',
      expect.objectContaining({
        filename: 'foo.jpg',
        error: expect.stringContaining('delete fetch down'),
      }),
    );
  });

  it('DELETE /api/modules/:id logs and 502s when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('mod delete down')) as typeof fetch;

    const res = await request(app).delete(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(502);
    expect(consoleError).toHaveBeenCalledWith(
      '[DELETE /api/modules/:id]',
      expect.objectContaining({
        id: VALID_ID,
        error: expect.stringContaining('mod delete down'),
      }),
    );
  });

  it('GET /api/modules/:id/logs logs and 502s when fetch rejects', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('logs proxy down')) as typeof fetch;

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/logs`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(502);
    expect(consoleError).toHaveBeenCalledWith(
      '[GET /api/modules/:id/logs]',
      expect.objectContaining({
        id: VALID_ID,
        error: expect.stringContaining('logs proxy down'),
      }),
    );
  });

  it('does NOT log on the happy path of GET /api/modules', async () => {
    // Belt-and-braces: a future refactor that wraps res.json() in a
    // try/catch with a stray `console.error('[GET /api/modules]', ...)`
    // would silently leak the catch-block tag (and any payload it
    // ships) on every successful request. Pin the absence here.
    mocks.listModules.mockResolvedValue({ modules: [], heartbeatsFailed: false });

    const res = await request(app).get('/api/modules').set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does NOT log on the happy path of GET /api/modules/:id', async () => {
    // Same idea as above for the detail route — guards against an `id`
    // payload accidentally appearing in stdout on every successful
    // module-detail open.
    mocks.getModuleDetail.mockResolvedValue({
      detail: {
        id: VALID_ID,
        name: 'x',
        location: { lat: 0, lng: 0 },
        status: 'online',
        lastApiCall: '',
        batteryLevel: 0,
        firstOnline: '',
        totalHatches: 0,
        imageCount: 0,
        nests: [],
      },
      heartbeatsFailed: false,
    });

    const res = await request(app).get(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
