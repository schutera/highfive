// In-memory ring of the backend's own recent log entries (#171, #178).
//
// Two ingestion paths feed the same bounded ring of structured `LogEntry`
// values, with no double-capture:
//
//   1. A stdout/stderr *tee*: every write that is NOT produced by the
//      structured logger is recorded as an entry AND passed through to the
//      real stream, so `docker logs` / PM2 still see everything unchanged.
//      This captures stray `console.*` and third-party output. Lines are
//      wrapped as `{ ts: now, level: stream === 'err' ? 'error' : 'info', msg }`.
//   2. The structured logger (`log.ts`) calls `pushEntry()` directly to store
//      a `LogEntry`, then writes its formatted human line to the *saved
//      original* stream reference — bypassing the tee so its own output is not
//      re-captured as a second entry.
//
// `GET /api/admin/logs?service=backend` reads this directly via
// `getRecentEntries`.
//
// Caveats (see ADR-021): in-memory, so it resets on process restart (only
// holds entries since startup) and is per-process (a future multi-worker prod
// would have one ring per worker). On-disk persistence + startup backfill
// (ADR-022) is layered on separately.

import type { LogEntry, LogLevel } from '@highfive/contracts';

const MAX_RING_ENTRIES = 2000;

const ring: LogEntry[] = [];
let installed = false;

// The real stream writers, captured before the tee replaces them. The
// structured logger writes through these so its output reaches the terminal /
// docker logs without being re-captured by the tee.
let originalStdoutWrite: ((...a: unknown[]) => boolean) | null = null;
let originalStderrWrite: ((...a: unknown[]) => boolean) | null = null;

// A write may not end on a newline, so hold the trailing fragment per stream
// until the next write completes the line.
const carry: Record<'out' | 'err', string> = { out: '', err: '' };

function pushEntryInternal(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > MAX_RING_ENTRIES) {
    ring.splice(0, ring.length - MAX_RING_ENTRIES);
  }
}

/**
 * Append a fully-formed structured entry to the ring. Used by the structured
 * logger (`log.ts`); does not touch any stream.
 */
export function pushEntry(entry: LogEntry): void {
  pushEntryInternal(entry);
}

/** The saved real `process.stdout.write`, or the live one if the tee isn't installed yet. */
export function writeStdout(text: string): boolean {
  return (originalStdoutWrite ?? process.stdout.write.bind(process.stdout))(text);
}

/** The saved real `process.stderr.write`, or the live one if the tee isn't installed yet. */
export function writeStderr(text: string): boolean {
  return (originalStderrWrite ?? process.stderr.write.bind(process.stderr))(text);
}

function record(which: 'out' | 'err', chunk: unknown): void {
  const text =
    typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  if (!text) return;
  const combined = carry[which] + text;
  const parts = combined.split('\n');
  // The last element is the (possibly empty) incomplete tail — carry it over.
  carry[which] = parts.pop() ?? '';
  const level: LogLevel = which === 'err' ? 'error' : 'info';
  for (const line of parts) {
    pushEntryInternal({ ts: new Date().toISOString(), level, msg: line });
  }
}

/**
 * Wrap process.stdout/stderr `write` so each completed line printed outside the
 * structured logger is also stored in the ring. Idempotent. Call once, as
 * early as possible at process start.
 */
export function installLogRing(): void {
  if (installed) return;
  installed = true;
  for (const [stream, which] of [
    [process.stdout, 'out'],
    [process.stderr, 'err'],
  ] as const) {
    const original = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    if (which === 'out') originalStdoutWrite = original;
    else originalStderrWrite = original;
    stream.write = ((chunk: unknown, ...args: unknown[]): boolean => {
      try {
        record(which, chunk);
      } catch {
        // Capture must never break real logging.
      }
      // Preserve the original variadic (chunk, encoding?, cb?) signature.
      return original(chunk, ...args);
    }) as typeof stream.write;
  }
}

/**
 * The most recent `n` captured entries, chronological (oldest→newest), and
 * whether the ring held more than were returned.
 */
export function getRecentEntries(n: number): { entries: LogEntry[]; truncated: boolean } {
  const count = Math.max(0, Math.min(n, ring.length));
  const entries = count === 0 ? [] : ring.slice(ring.length - count);
  return { entries, truncated: ring.length > entries.length };
}

/** Test-only: clear the ring and partial-line carry. */
export function __resetLogRingForTest(): void {
  ring.length = 0;
  carry.out = '';
  carry.err = '';
}
