import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import request from 'supertest';

// Mock db so importing the app doesn't trigger real fetches.
vi.mock('../src/database', () => ({
  db: { listModules: vi.fn().mockResolvedValue([]), getModuleDetail: vi.fn().mockResolvedValue(null) },
}));

import { app } from '../src/app';
import { log } from '../src/log';
import { __resetLogRingForTest } from '../src/logRing';

const KEY = 'hf_dev_key_2026';

beforeEach(() => {
  __resetLogRingForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('GET /api/admin/logs/stream (#178 Phase 4)', () => {
  it('returns 401 without an admin credential', async () => {
    const res = await request(app).get('/api/admin/logs/stream?service=backend');
    expect(res.status).toBe(401);
  });

  it('returns 400 on a non-allow-listed service', async () => {
    const res = await request(app).get('/api/admin/logs/stream?service=nginx').set('X-Admin-Key', KEY);
    expect(res.status).toBe(400);
  });

  it('streams the backend ring as SSE: a new log entry arrives as a data event', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const received = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { port, path: '/api/admin/logs/stream?service=backend', headers: { 'X-Admin-Key': KEY } },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          expect(res.headers['x-accel-buffering']).toBe('no');
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString();
            const line = buf.split('\n').find((l) => l.startsWith('data: '));
            if (line) {
              req.destroy();
              resolve(line.slice('data: '.length));
            }
          });
          // Emit an entry once we're connected.
          setImmediate(() => log.info('sse-backend-entry'));
        },
      );
      req.on('error', (e) => {
        // destroy() triggers ECONNRESET — ignore once we already resolved.
        if (!/aborted|ECONNRESET|socket hang up/i.test(String(e))) reject(e);
      });
      setTimeout(() => reject(new Error('timed out waiting for SSE data')), 4000);
    });

    const entry = JSON.parse(received);
    expect(entry.msg).toBe('sse-backend-entry');
    expect(entry.level).toBe('info');
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('pipes a Flask service SSE stream through to the client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"ts":"2026-06-18T00:00:00.000Z","level":"warn","msg":"db-stream-entry"}\n\n',
              ),
            );
            c.close();
          },
        }),
      }),
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const body = await new Promise<string>((resolve, reject) => {
      http.get(
        {
          port,
          path: '/api/admin/logs/stream?service=duckdb-service',
          headers: { 'X-Admin-Key': KEY },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          let buf = '';
          res.on('data', (c) => (buf += c.toString()));
          res.on('end', () => resolve(buf));
        },
      ).on('error', reject);
      setTimeout(() => reject(new Error('timed out')), 4000);
    });

    expect(body).toContain('db-stream-entry');
    const fetchArg = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(fetchArg[0])).toMatch(/\/logs\/stream$/);
    expect((fetchArg[1] as { headers: Record<string, string> }).headers['X-Admin-Key']).toBe(KEY);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns 502 when the upstream Flask stream cannot be opened', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const res = await request(app)
      .get('/api/admin/logs/stream?service=image-service')
      .set('X-Admin-Key', KEY);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('does not crash when the client disconnects mid-stream (proxy abort path)', async () => {
    // A long-lived upstream that never closes — so the only way the pipe ends
    // is the client aborting, which makes Readable.fromWeb emit an AbortError.
    // With a bare `.pipe()` that unhandled error crashes the process.
    const openStream = new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"ts":"2026-06-18T00:00:00.000Z","level":"info","msg":"keep-open"}\n\n',
          ),
        );
        // intentionally never close
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, body: openStream }),
    );

    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          port,
          path: '/api/admin/logs/stream?service=duckdb-service',
          headers: { 'X-Admin-Key': KEY },
        },
        (res) => {
          res.on('data', () => {
            req.destroy(); // client abort mid-stream — the would-be crash path
            resolve();
          });
        },
      );
      req.on('error', () => resolve()); // ECONNRESET from our own destroy is fine
      setTimeout(() => reject(new Error('no data before timeout')), 4000);
    });

    // Let the abort propagate through pipeline, then prove the process is still
    // alive and serving — an uncaught stream error would have killed the run.
    await new Promise((r) => setTimeout(r, 50));
    await request(app).get('/api/health').expect(200);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
