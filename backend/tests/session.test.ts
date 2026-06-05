import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';

// Mock db so importing the app doesn't trigger real fetches. Mirrors
// admin-delete.test.ts.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue({ modules: [], heartbeatsFailed: false }),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

import {
  SESSION_COOKIE,
  issueSessionToken,
  verifySessionToken,
  requireAdmin,
  isRateLimited,
  recordFailedAttempt,
  resetAttempts,
  __resetRateLimiterForTests,
} from '../src/session';
import { app } from '../src/app';

// auth.ts resolves the dev fallback when HIGHFIVE_API_KEY is unset (the
// vitest default), so this is both the login password and the HMAC key.
const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  __resetRateLimiterForTests();
});

describe('session token sign/verify', () => {
  it('round-trips a freshly issued token', () => {
    expect(verifySessionToken(issueSessionToken())).toBe(true);
  });

  it('rejects empty / malformed tokens', () => {
    expect(verifySessionToken(undefined)).toBe(false);
    expect(verifySessionToken('')).toBe(false);
    expect(verifySessionToken('no-dot')).toBe(false);
    expect(verifySessionToken('.sig')).toBe(false);
    expect(verifySessionToken('payload.')).toBe(false);
  });

  it('rejects an expired token', () => {
    const past = Date.now() - 13 * 60 * 60 * 1000; // issued >12h ago
    const token = issueSessionToken(past);
    expect(verifySessionToken(token, past)).toBe(true); // valid at issue time
    expect(verifySessionToken(token)).toBe(false); // expired now
  });

  it('rejects a tampered signature', () => {
    const token = issueSessionToken();
    const [payload] = token.split('.');
    expect(verifySessionToken(`${payload}.deadbeef`)).toBe(false);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = issueSessionToken();
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 1e12 }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifySessionToken(`${forged}.${sig}`)).toBe(false);
  });
});

describe('requireAdmin middleware', () => {
  // A throwaway app that mirrors app.ts's wiring (cookieParser + gate) but
  // whose gated route returns immediately — so the cookie path is exercised
  // without any network hop to a Docker-only upstream hostname.
  const gated = express();
  gated.use(express.json());
  gated.use(cookieParser());
  gated.get('/gated', requireAdmin, (_req, res) => res.json({ ok: true }));

  it('passes with a valid X-Admin-Key header', async () => {
    const res = await request(gated).get('/gated').set('X-Admin-Key', KEY);
    expect(res.status).toBe(200);
  });

  it('401s with no credential', async () => {
    const res = await request(gated).get('/gated');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('401s with a wrong X-Admin-Key', async () => {
    const res = await request(gated).get('/gated').set('X-Admin-Key', 'nope');
    expect(res.status).toBe(401);
  });

  it('passes with a valid session cookie', async () => {
    const res = await request(gated)
      .get('/gated')
      .set('Cookie', `${SESSION_COOKIE}=${issueSessionToken()}`);
    expect(res.status).toBe(200);
  });

  it('401s with a tampered session cookie', async () => {
    const res = await request(gated)
      .get('/gated')
      .set('Cookie', `${SESSION_COOKIE}=not.a.valid.token`);
    expect(res.status).toBe(401);
  });
});

describe('login rate limiting', () => {
  it('blocks after the attempt budget is exhausted', () => {
    const ip = '203.0.113.7';
    expect(isRateLimited(ip)).toBe(false);
    for (let i = 0; i < 10; i++) recordFailedAttempt(ip);
    expect(isRateLimited(ip)).toBe(true);
  });

  it('a successful login clears the counter', () => {
    const ip = '203.0.113.8';
    for (let i = 0; i < 10; i++) recordFailedAttempt(ip);
    expect(isRateLimited(ip)).toBe(true);
    resetAttempts(ip);
    expect(isRateLimited(ip)).toBe(false);
  });
});

describe('POST /api/admin/login', () => {
  it('sets an HttpOnly session cookie on the correct password', async () => {
    const res = await request(app).post('/api/admin/login').send({ password: KEY });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
    const setCookie = res.headers['set-cookie']?.[0] ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
  });

  it('401s on a wrong password and sets no cookie', async () => {
    const res = await request(app).post('/api/admin/login').send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ authenticated: false });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('401s on a missing password body', async () => {
    const res = await request(app).post('/api/admin/login').send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/admin/session', () => {
  it('reports authenticated:false with no cookie', async () => {
    const res = await request(app).get('/api/admin/session');
    expect(res.body).toEqual({ authenticated: false });
  });

  it('reports authenticated:true after login, false after logout', async () => {
    const agent = request.agent(app);
    await agent.post('/api/admin/login').send({ password: KEY });
    const authed = await agent.get('/api/admin/session');
    expect(authed.body).toEqual({ authenticated: true });

    await agent.post('/api/admin/logout');
    const out = await agent.get('/api/admin/session');
    expect(out.body).toEqual({ authenticated: false });
  });
});

afterEach(() => {
  __resetRateLimiterForTests();
});
