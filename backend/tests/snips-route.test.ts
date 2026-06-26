import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches (mirrors
// activity-route.test.ts). The snip routes proxy directly, not via the db layer.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

import { app } from '../src/app';

const VALID_ID = 'aabbccddeeff';

const detection = (bee_type: string, nest_index: number, state: string) => ({
  module_id: VALID_ID,
  filename: 'cap.jpg',
  bee_type,
  nest_index,
  bbox: [0.1, 0.2, 0.3, 0.3],
  state,
  confidence: 0.8,
  snip_filename: `cap-${bee_type}-${nest_index}.jpg`,
  detected_at: '2026-06-11 10:30:00',
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/modules/:id/snips', () => {
  it('is public and maps snake_case detections to the camelCase NestSnip shape', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        detections: [detection('leafcutter', 1, 'sealed'), detection('orchard', 2, 'empty')],
      }),
    });

    const res = await request(app).get(`/api/modules/${VALID_ID}/snips`);
    expect(res.status).toBe(200);
    expect(res.body.snips).toEqual([
      {
        beeType: 'leafcutter',
        nestIndex: 1,
        state: 'sealed',
        confidence: 0.8,
        snipFilename: 'cap-leafcutter-1.jpg',
        bbox: [0.1, 0.2, 0.3, 0.3],
        sourceFilename: 'cap.jpg',
        detectedAt: '2026-06-11 10:30:00',
      },
      {
        beeType: 'orchard',
        nestIndex: 2,
        state: 'empty',
        confidence: 0.8,
        snipFilename: 'cap-orchard-2.jpg',
        bbox: [0.1, 0.2, 0.3, 0.3],
        sourceFilename: 'cap.jpg',
        detectedAt: '2026-06-11 10:30:00',
      },
    ]);
  });

  it('drops rows with an unknown bee type or state rather than forwarding them', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        detections: [
          detection('leafcutter', 1, 'sealed'),
          detection('wasp', 1, 'sealed'), // bad bee type
          detection('resin', 1, 'molten'), // bad state
        ],
      }),
    });

    const res = await request(app).get(`/api/modules/${VALID_ID}/snips`);
    expect(res.status).toBe(200);
    expect(res.body.snips).toHaveLength(1);
    expect(res.body.snips[0].beeType).toBe('leafcutter');
  });

  it('returns 400 on a malformed module id without calling upstream', async () => {
    const res = await request(app).get('/api/modules/not-a-mac/snips');
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );
    const res = await request(app).get(`/api/modules/${VALID_ID}/snips`);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });
});

describe('GET /api/modules/:id/snips/:beeType/:nestIndex/timeline', () => {
  const TIMELINE = `/api/modules/${VALID_ID}/snips/leafcutter/1/timeline`;

  it('maps the upstream capture history to NestSnip[] oldest-first', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        detections: [
          {
            ...detection('leafcutter', 1, 'empty'),
            filename: 'd1.jpg',
            detected_at: '2026-06-01 10:00:00',
            snip_filename: 'd1-leafcutter-1.jpg',
          },
          {
            ...detection('leafcutter', 1, 'sealed'),
            filename: 'd2.jpg',
            detected_at: '2026-06-03 10:00:00',
            snip_filename: 'd2-leafcutter-1.jpg',
          },
        ],
      }),
    });

    const res = await request(app).get(TIMELINE);
    expect(res.status).toBe(200);
    expect(res.body.snips.map((s: { snipFilename: string }) => s.snipFilename)).toEqual([
      'd1-leafcutter-1.jpg',
      'd2-leafcutter-1.jpg',
    ]);
    // The upstream query is scoped to the requested nest.
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/detections/timeline?');
    expect(String(url)).toContain('bee_type=leafcutter');
    expect(String(url)).toContain('nest_index=1');
  });

  it('returns 400 on an unknown bee type without calling upstream', async () => {
    const res = await request(app).get(`/api/modules/${VALID_ID}/snips/wasp/1/timeline`);
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on a non-positive-integer nest index without calling upstream', async () => {
    for (const bad of ['0', 'x', '-1', '1.5']) {
      const res = await request(app).get(
        `/api/modules/${VALID_ID}/snips/leafcutter/${bad}/timeline`,
      );
      expect(res.status).toBe(400);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 400 on a malformed module id without calling upstream', async () => {
    const res = await request(app).get('/api/modules/not-a-mac/snips/leafcutter/1/timeline');
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 502 when duckdb-service is unreachable', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ECONNREFUSED'),
    );
    const res = await request(app).get(TIMELINE);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });
});

describe('GET /api/snips/:filename', () => {
  it('proxies the snip bytes from image-service with its content type', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => bytes.buffer,
    });

    const res = await request(app).get('/api/snips/cap-leafcutter-1.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/snips/cap-leafcutter-1.jpg');
  });

  it('forwards a 404 when the snip is missing', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Snip not found' }),
    });
    const res = await request(app).get('/api/snips/missing.jpg');
    expect(res.status).toBe(404);
  });
});
