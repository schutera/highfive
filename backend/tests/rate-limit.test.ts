// SlidingWindowLimiter + waitlist rate limit (2026-07 audit, for #206).

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { SlidingWindowLimiter } from '../src/rateLimit';
import { app } from '../src/app';

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
  it('429s the 4th submission in the window from one IP', async () => {
    // The limiter runs before validation and before the Discord-webhook
    // check, so budget is consumed even though DISCORD_WEBHOOK_URL is
    // unset in tests (those submissions get 503).
    const payload = { name: 'Test Bee', email: 'bee@example.com' };
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/waitlist').send(payload);
      expect(res.status).toBe(503); // webhook unset — but budget consumed
    }
    const limited = await request(app).post('/api/waitlist').send(payload);
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/too many signups/i);
  });
});
