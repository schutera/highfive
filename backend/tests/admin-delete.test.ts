import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches. Mirrors admin-logs.test.ts.
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

describe('DELETE /api/modules/:id', () => {
  it('returns 401 without X-API-Key', async () => {
    const res = await request(app).delete(`/api/modules/${VALID_ID}`);
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed module id and does not call upstream', async () => {
    const res = await request(app).delete('/api/modules/not-a-mac').set('X-API-Key', KEY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid module id format/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forwards method DELETE to the duckdb-service /modules/:id URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: `Module ${VALID_ID} deleted` }),
    });

    const res = await request(app).delete(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain(`/modules/${VALID_ID}`);
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('forwards upstream 200 body verbatim', async () => {
    const payload = { message: `Module ${VALID_ID} deleted` };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const res = await request(app).delete(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('forwards upstream 404 verbatim', async () => {
    const payload = { error: 'Module not found' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => payload,
    });

    const res = await request(app).delete(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(payload);
  });

  it('forwards upstream 500 verbatim (does not collapse to 502)', async () => {
    const payload = { error: 'boom' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => payload,
    });

    const res = await request(app).delete(`/api/modules/${VALID_ID}`).set('X-API-Key', KEY);

    expect(res.status).toBe(500);
    expect(res.body).toEqual(payload);
  });
});

describe('DELETE /api/images/:filename', () => {
  it('returns 401 without X-API-Key', async () => {
    const res = await request(app).delete('/api/images/foo.jpg');
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('URL-encodes the filename when constructing the upstream URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'Image deleted' }),
    });

    const res = await request(app).delete('/api/images/weird name.jpg').set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    const [url, init] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    // Express decodes the param, then the handler must re-encode it.
    expect(String(url)).toContain('/images/weird%20name.jpg');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('forwards upstream 200 body verbatim', async () => {
    const payload = { message: 'Image deleted' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const res = await request(app).delete('/api/images/foo.jpg').set('X-API-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);
  });

  it('forwards upstream 404 verbatim (idempotent already-gone path)', async () => {
    const payload = { error: 'Image not found' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => payload,
    });

    const res = await request(app).delete('/api/images/foo.jpg').set('X-API-Key', KEY);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(payload);
  });
});
