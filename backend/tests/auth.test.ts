import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { apiKeyAuth } from '../src/auth';

// Use the default dev key (auth.ts reads HIGHFIVE_API_KEY at module load and
// falls back to 'hf_dev_key_2026'). We don't override here so we test the
// documented default behaviour.
const KEY = 'hf_dev_key_2026';

describe('apiKeyAuth middleware', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();
    app.get('/protected', apiKeyAuth, (_req, res) => {
      res.json({ ok: true });
    });
  });

  it('returns 401 when no key is provided', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('returns 403 when the key is wrong', async () => {
    const res = await request(app).get('/protected').set('X-API-Key', 'nope');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });

  it('passes when X-API-Key header is correct', async () => {
    const res = await request(app).get('/protected').set('X-API-Key', KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes when Authorization: Bearer <key> is correct', async () => {
    const res = await request(app)
      .get('/protected')
      .set('Authorization', `Bearer ${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('passes when ?api_key= is correct', async () => {
    const res = await request(app).get(`/protected?api_key=${KEY}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
