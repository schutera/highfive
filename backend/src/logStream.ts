// SSE helpers for the admin log live-tail (#178 Phase 4).
//
// Two sources feed the `GET /api/admin/logs/stream` route:
//   - the backend's own ring (subscribe to logRing and write each entry), and
//   - a Flask service's internal `/logs/stream` (piped through by the route).
// This module owns the SSE header contract + the backend-ring streamer so the
// route in app.ts stays thin and this stays unit-testable.

import type { Response } from 'express';
import type { LogEntry } from '@highfive/contracts';
import { subscribeEntries } from './logRing';

const KEEPALIVE_MS = 25_000;

/**
 * Write the SSE response headers. `X-Accel-Buffering: no` + `no-transform` stop
 * nginx/proxies from buffering the stream (the host-nginx config also sets
 * `proxy_buffering off` — this header is the safety net). See ADR-022.
 */
export function writeSseHeaders(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

/**
 * Stream the backend's own ring to `res` as SSE until the client disconnects.
 * Subscribes for live entries and sends a periodic keepalive comment. Returns a
 * cleanup function (also wired to `req`'s close); calling it is idempotent.
 */
export function streamBackendRing(res: Response): () => void {
  let cleanup = (): void => {};
  // Guard every write: if the socket died before `req.on('close')` fired, a
  // write-after-end can throw — treat that as a disconnect and tear down.
  const safeWrite = (chunk: string): void => {
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  };
  const unsubscribe = subscribeEntries((entry: LogEntry) => {
    safeWrite(`data: ${JSON.stringify(entry)}\n\n`);
  });
  const keepalive = setInterval(() => safeWrite(': ping\n\n'), KEEPALIVE_MS);
  let done = false;
  cleanup = () => {
    if (done) return;
    done = true;
    clearInterval(keepalive);
    unsubscribe();
    res.end();
  };
  return cleanup;
}
