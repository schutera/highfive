// Structured logger for the backend (#178).
//
// Each call pushes a `LogEntry` straight into the in-memory ring AND writes a
// formatted human line to the *saved original* stdout/stderr (via logRing's
// `writeStdout`/`writeStderr`), so:
//   - the admin Server Logs panel sees a structured `{ ts, level, msg }`, and
//   - `docker logs` / PM2 see a readable line, exactly once (the original
//     writer bypasses the tee, so the line is not re-captured as a duplicate
//     entry).
//
// New call sites — the access-log middleware and converted boot banners — use
// this. Stray `console.*` and third-party output still land in the ring via
// the tee fallback (see logRing.ts).
//
// SECURITY: never pass secrets, auth headers, request bodies, or the admin
// password to these functions — entries are admin-readable and (ADR-023)
// persisted to disk. See accessLog.ts for the redaction rules on request data.

import type { LogEntry, LogLevel } from '@highfive/contracts';
import { pushEntry, writeStderr, writeStdout } from './logRing';

function emit(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, msg };
  pushEntry(entry);
  const line = `${entry.ts} ${level.toUpperCase()} ${msg}\n`;
  if (level === 'error') writeStderr(line);
  else writeStdout(line);
}

export const log = {
  info: (msg: string): void => emit('info', msg),
  warn: (msg: string): void => emit('warn', msg),
  error: (msg: string): void => emit('error', msg),
};
