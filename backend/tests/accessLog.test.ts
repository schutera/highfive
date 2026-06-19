import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Mock db so the app import doesn't trigger real fetches.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

// Use the REAL logRing so access entries actually land in the ring; we read it
// back via getRecentEntries to assert behaviour (CLAUDE.md rule #5 — assert the
// request lands as an entry, not just envelope shape).
import { app } from '../src/app';
import { getRecentEntries, __resetLogRingForTest } from '../src/logRing';

const KEY = 'hf_dev_key_2026';

const msgs = () => getRecentEntries(2000).entries.map((e) => e.msg);
const find = (re: RegExp) => getRecentEntries(2000).entries.find((e) => re.test(e.msg));

beforeEach(() => {
  __resetLogRingForTest();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('access logging (#178)', () => {
  it('emits one info entry for a 2xx request: method path status ms', async () => {
    await request(app).get('/api/health');
    const entry = find(/^GET \/api\/health 200 /);
    expect(entry).toBeTruthy();
    expect(entry?.level).toBe('info');
    expect(entry?.msg).toMatch(/^GET \/api\/health 200 \d+(\.\d+)?ms$/);
    // Exactly one access entry for the single request.
    expect(msgs().filter((m) => /^GET \/api\/health 200 /.test(m))).toHaveLength(1);
  });

  it('logs a 4xx as warn', async () => {
    // Missing admin credential → 401 from requireAdmin.
    await request(app).get('/api/admin/logs?service=backend');
    const entry = find(/^GET \/api\/admin\/logs 401 /);
    expect(entry?.level).toBe('warn');
  });

  it('logs an unmatched route (404) as warn', async () => {
    await request(app).get('/api/does-not-exist');
    const entry = find(/^GET \/api\/does-not-exist 404 /);
    expect(entry?.level).toBe('warn');
  });

  it('never logs the query string, admin key, or header names', async () => {
    // Path carries a token-ish query param; the entry must not include it.
    await request(app)
      .get('/api/admin/logs?service=backend&token=topsecret123')
      .set('X-Admin-Key', KEY);
    const all = msgs().join('\n');
    expect(all).not.toContain('topsecret123');
    expect(all).not.toContain('?'); // no query string at all
    expect(all).not.toContain(KEY);
    expect(all).not.toContain('X-Admin-Key');
    // The path itself is still logged (without the query).
    expect(find(/^GET \/api\/admin\/logs 200 /)).toBeTruthy();
  });

  it('never logs the admin login password from the request body', async () => {
    await request(app)
      .post('/api/admin/login')
      .send({ password: 'hunter2-should-never-appear' });
    const all = msgs().join('\n');
    expect(all).not.toContain('hunter2-should-never-appear');
    // The login attempt is still logged as an access entry (path + status only).
    expect(find(/^POST \/api\/admin\/login \d{3} /)).toBeTruthy();
  });
});
