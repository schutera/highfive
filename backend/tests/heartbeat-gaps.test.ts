import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches (mirrors admin-logs.test).
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

describe('GET /api/modules/:id/heartbeat-gaps (#172 opt 3)', () => {
  it('returns 401 without an admin credential', async () => {
    const res = await request(app).get(`/api/modules/${VALID_ID}/heartbeat-gaps`);
    expect(res.status).toBe(401);
  });

  it('returns 400 on a malformed module id', async () => {
    const res = await request(app)
      .get('/api/modules/not-a-mac/heartbeat-gaps')
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(400);
  });

  it('camelCases the snake_case upstream gap shape (the silent-drift risk)', async () => {
    // The exact failure rule 4 guards: gap_start -> gapStart etc. A drift here
    // renders every gap field as undefined in the UI without any error.
    const upstream = {
      module_id: VALID_ID,
      gaps: [
        { gap_start: '2026-06-01T02:00:00', gap_end: '2026-06-01T06:00:00', gap_seconds: 14400 },
      ],
    };
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => upstream,
    });

    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/heartbeat-gaps`)
      .set('X-Admin-Key', KEY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      gaps: [{ gapStart: '2026-06-01T02:00:00', gapEnd: '2026-06-01T06:00:00', gapSeconds: 14400 }],
    });
    // It must proxy duckdb-service, forwarding the machine credential.
    const [calledUrl, calledInit] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { headers: Record<string, string> }];
    expect(calledUrl).toContain(`/heartbeats/${VALID_ID}/gaps`);
    expect(calledInit.headers['X-Admin-Key']).toBe(KEY);
  });

  it('passes ?limit=N through to the upstream URL', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ module_id: VALID_ID, gaps: [] }),
    });
    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/heartbeat-gaps?limit=7`)
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(200);
    const calledWith = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(calledWith).toContain('limit=7');
  });

  it('returns 502 on a malformed upstream shape rather than forwarding undefined', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ module_id: VALID_ID }), // no `gaps` array
    });
    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/heartbeat-gaps`)
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
  });

  it('returns 502 when a gap element is missing fields (no undefined-pluck to UI)', async () => {
    // `gaps` is an array, but an element lacks gap_start/gap_end/gap_seconds —
    // the per-element guard must reject rather than map it to {gapStart: undefined}.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ module_id: VALID_ID, gaps: [{}] }),
    });
    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/heartbeat-gaps`)
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );
    const res = await request(app)
      .get(`/api/modules/${VALID_ID}/heartbeat-gaps`)
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
  });
});
