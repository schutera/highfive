// SlidingWindowLimiter + waitlist rate limit (2026-07 audit, for #206).
//
// The app is imported DYNAMICALLY in the route tests so
// DISCORD_WEBHOOK_URL can be set first — app.ts reads it at module load,
// and the limiter deliberately consumes budget only for submissions that
// reach the Discord relay.

import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { SlidingWindowLimiter } from '../src/rateLimit';

describe('SlidingWindowLimiter', () => {
  it('allows under budget, blocks over, and slides the window', () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.allow('ip-a', 0)).toBe(true);
    expect(limiter.allow('ip-a', 100)).toBe(true);
    expect(limiter.allow('ip-a', 200)).toBe(false);
    // First event (t=0) leaves the window after 1000ms → budget frees.
    expect(limiter.allow('ip-a', 1001)).toBe(true);
  });

  it('keeps keys independent', () => {
    const limiter = new SlidingWindowLimiter(1, 1000);
    expect(limiter.allow('ip-a', 0)).toBe(true);
    expect(limiter.allow('ip-a', 1)).toBe(false);
    expect(limiter.allow('ip-b', 1)).toBe(true);
  });

  it('bounds the tracked-key map under an address-diverse flood', () => {
    const limiter = new SlidingWindowLimiter(5, 60_000, 50);
    for (let i = 0; i < 500; i++) {
      limiter.allow(`ip-${i}`, i);
    }
    // Private field, but the bound is the entire point of the test.
    expect(
      (limiter as unknown as { events: Map<string, number[]> })['events'].size,
    ).toBeLessThanOrEqual(50);
  });
});

describe('POST /api/waitlist rate limit', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  it('429s the 4th relayed submission; failures do not burn budget', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example.invalid/webhook';
    const relay = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', relay);
    const { app } = await import('../src/app');

    const valid = { name: 'Test Bee', email: 'bee@example.com' };

    // Validation failures must NOT consume budget (review-caught: three
    // email typos used to lock a legitimate signer out for an hour).
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/api/waitlist').send({ name: 'X', email: 'nope' });
      expect(res.status).toBe(400);
    }

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/waitlist').send(valid);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    expect(relay).toHaveBeenCalledTimes(3);

    const limited = await request(app).post('/api/waitlist').send(valid);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/too many signups/i);
    // The throttled submission never reached Discord.
    expect(relay).toHaveBeenCalledTimes(3);
  });
});
