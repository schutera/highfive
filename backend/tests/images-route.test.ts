import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

// Mock db so app import doesn't trigger real fetches (mirrors snips-route.test.ts).
// The image routes proxy directly, not via the db layer.
vi.mock('../src/database', () => ({
  db: {
    listModules: vi.fn().mockResolvedValue([]),
    getModuleDetail: vi.fn().mockResolvedValue(null),
  },
}));

import { app } from '../src/app';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/images/:filename', () => {
  it('proxies the image bytes from image-service with a hard-set image/jpeg content type', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => bytes.buffer,
    });

    const res = await request(app).get('/api/images/esp_capture_20260601_120000.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    const [url] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/images/esp_capture_20260601_120000.jpg');
  });

  it('overrides the upstream content type rather than forwarding it (2026-08 audit, #228)', async () => {
    // Belt-and-braces: image-service now only ever stores/serves `.jpg` with
    // mimetype="image/jpeg" (services/paths.py + app.py::serve_image), but
    // this public, unauthenticated proxy must not trust the upstream header
    // either way — see the same test on the /api/snips proxy.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'text/html']]),
      arrayBuffer: async () => bytes.buffer,
    });

    const res = await request(app).get('/api/images/evil.jpg');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
  });

  it('forwards a 404 from image-service verbatim', async () => {
    // This only proves the proxy forwards whatever status image-service
    // returns — it mocks the 404, it doesn't exercise image-service's own
    // .log.json-sidecar-unreachability logic. That behaviour (serve_image
    // 404ing any non-.jpg name, including sidecars) is proven against the
    // real Flask route in image-service/tests/test_upload.py's
    // test_serve_image_404s_log_json_sidecar — this test's job is only the
    // backend proxy's status-forwarding, using a `.log.json`-shaped
    // filename as a realistic example of a name that 404s.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Image not found' }),
    });
    const res = await request(app).get('/api/images/cap.jpg.log.json');
    expect(res.status).toBe(404);
  });
});
