import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches.
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

describe('PATCH /api/modules/:id/name', () => {
  it('returns 401 without X-API-Key', async () => {
    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .send({ display_name: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('returns 403 when X-Admin-Key is missing', async () => {
    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .send({ display_name: 'whatever' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin key required/i);
  });

  it('returns 403 when X-Admin-Key is wrong', async () => {
    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', 'not-the-key')
      .send({ display_name: 'whatever' });
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid module id shape', async () => {
    const res = await request(app)
      .patch('/api/modules/hive-001/name')
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ display_name: 'whatever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid module id/i);
  });

  it('returns 400 when body lacks display_name', async () => {
    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/display_name/);
  });

  it('proxies to duckdb-service and forwards the 200 response on success', async () => {
    const payload = { id: VALID_ID, display_name: 'Garden Bee', message: 'display_name updated' };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => payload,
    });

    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ display_name: 'Garden Bee' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(payload);

    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    const [calledUrl, opts] = calls[0] as [string, RequestInit];
    expect(calledUrl).toContain(`/modules/${VALID_ID}/display_name`);
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body as string)).toEqual({ display_name: 'Garden Bee' });
  });

  it('accepts display_name: null and forwards it (clear-the-override path)', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: VALID_ID, display_name: null, message: 'display_name updated' }),
    });

    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ display_name: null });

    expect(res.status).toBe(200);
    const [, opts] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(opts.body as string)).toEqual({ display_name: null });
  });

  it('forwards the 409 status and body on display-name collision', async () => {
    // Pin the wire-shape pass-through: the homepage will render an inline
    // error using the body fields, so dropping fields here silently
    // breaks the UX exactly as PR-42's "Telemetry sidecar envelope
    // drift" lesson warns. See chapter 11.
    const upstream409 = {
      error: 'display_name already in use',
      display_name: 'Garden Bee',
      conflicting_module_id: '001122334455',
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => upstream409,
    });

    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ display_name: 'Garden Bee' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(upstream409);
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );

    const res = await request(app)
      .patch(`/api/modules/${VALID_ID}/name`)
      .set('X-API-Key', KEY)
      .set('X-Admin-Key', KEY)
      .send({ display_name: 'Garden Bee' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/duckdb-service unreachable/);
  });
});
