import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';

/**
 * Issue #235 — the waitlist relay interpolates raw user input into the
 * operator's Discord alert channel, so the webhook payload must carry
 * `allowed_mentions: { parse: [] }`: a signup named `@everyone` must
 * not ping the channel that also carries silence-watcher alerts.
 *
 * The app is imported DYNAMICALLY so DISCORD_WEBHOOK_URL can be set
 * first (app.ts reads it at module load) — same pattern as
 * rate-limit.test.ts.
 */

describe('POST /api/waitlist allowed_mentions (#235)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  it('relays with allowed_mentions.parse: [] even for an @everyone name', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.example.invalid/webhook';
    const relay = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', relay);
    const { app } = await import('../src/app.js');

    const res = await request(app)
      .post('/api/waitlist')
      .send({ name: '@everyone look here', email: 'ping@example.com' });

    expect(res.status).toBe(200);
    expect(relay).toHaveBeenCalledTimes(1);
    const body = JSON.parse(relay.mock.calls[0][1].body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    // The hostile name still ships (it is the signup's content) — it
    // just can't mention anyone.
    expect(body.content).toContain('@everyone');
  });
});
