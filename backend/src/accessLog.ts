// Express access-log middleware (#178 Phase 2).
//
// Emits exactly one structured entry per handled request through the Phase-1
// structured logger (`log.*`), so the admin Server Logs panel fills with real
// traffic — on success too, not just error branches. Level tracks status:
// >=500 error, >=400 warn, else info.
//
// SECURITY (load-bearing): logs `method path status durationMs` ONLY. It uses
// `req.path` — never `req.originalUrl`/query string, never headers, never the
// body — so the `X-Admin-Key` header, the `POST /api/admin/login` body
// password, and any `?token=`/`?key=` query value cannot reach the
// admin-readable (and, from Phase 3, disk-persisted) ring. "Path only" is the
// redaction mechanism by construction.

import type { Request, Response, NextFunction } from 'express';
import { log } from './log';

function levelFor(status: number): 'info' | 'warn' | 'error' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

export function accessLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  // `finish` fires once when the response has been fully flushed — for normal
  // requests at completion, for a long-lived SSE stream only at disconnect
  // (one entry, large duration; it issues no request, so it cannot loop).
  res.once('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const msg = `${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`;
    log[levelFor(res.statusCode)](msg);
  });
  next();
}
