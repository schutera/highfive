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
// (ADR-023) is layered on separately.

import fs from 'node:fs';
import path from 'node:path';
import { createStream, type RotatingFileStream } from 'rotating-file-stream';
import type { LogEntry, LogLevel } from '@highfive/contracts';

const MAX_RING_ENTRIES = 2000;

const ring: LogEntry[] = [];
let installed = false;

// On-disk persistence (#178 Phase 3 / ADR-023). Gated on LOG_DIR: when set, each
// entry is also appended as one JSON object per line (JSONL) to a rotating file,
// and the ring is backfilled from that file at startup so history survives a
// restart. When unset (e.g. unit tests), the ring is in-memory only — the
// pre-ADR-023 behaviour. Rotation: daily + 50 MB, retain ≤30 files AND ≤100 MB
// total (rfs prunes oldest past either bound).
let diskStream: RotatingFileStream | null = null;

// The real stream writers, captured before the tee replaces them. The
// structured logger writes through these so its output reaches the terminal /
// docker logs without being re-captured by the tee.
let originalStdoutWrite: ((...a: unknown[]) => boolean) | null = null;
let originalStderrWrite: ((...a: unknown[]) => boolean) | null = null;

// A write may not end on a newline, so hold the trailing fragment per stream
// until the next write completes the line.
const carry: Record<'out' | 'err', string> = { out: '', err: '' };

const LOG_FILENAME = 'backend.log';

// Live subscribers for SSE (#178 Phase 4). Every entry — from the tee or the
// structured logger — flows through pushEntryInternal, so emitting here is the
// single broadcast point. A Set (not EventEmitter) avoids MaxListeners warnings.
const subscribers = new Set<(entry: LogEntry) => void>();

function pushEntryInternal(entry: LogEntry): void {
  ring.push(entry);
  if (ring.length > MAX_RING_ENTRIES) {
    ring.splice(0, ring.length - MAX_RING_ENTRIES);
  }
  if (diskStream) {
    try {
      diskStream.write(`${JSON.stringify(entry)}\n`);
    } catch {
      // Persistence must never break in-memory logging.
    }
  }
  for (const cb of subscribers) {
    try {
      cb(entry);
    } catch {
      // A broken subscriber must never break logging or other subscribers.
    }
  }
}

/**
 * Subscribe to live entries (SSE live tail). The callback fires for every new
 * entry from any ingestion path. Returns an unsubscribe function — call it on
 * client disconnect.
 */
export function subscribeEntries(cb: (entry: LogEntry) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Enable on-disk persistence + startup backfill. Idempotent. Pass the log
 * directory (typically `process.env.LOG_DIR`); a falsy value is a no-op so the
 * ring stays in-memory. Call once, early, before serving traffic.
 */
export function initLogPersistence(dir: string | undefined = process.env.LOG_DIR): void {
  if (!dir || diskStream) return;
  fs.mkdirSync(dir, { recursive: true });
  // Backfill the ring from the active file's tail BEFORE opening the write
  // stream, so a restart shows pre-restart history immediately.
  backfillFromDisk(path.join(dir, LOG_FILENAME));
  diskStream = createStream(LOG_FILENAME, {
    path: dir,
    interval: '1d', // rotate daily
    size: '50M', // …and when a file reaches 50 MB
    maxFiles: 30, // retain ≤30 rotated files
    maxSize: '100M', // …AND ≤100 MB total (prune oldest past either bound)
  });
}

function backfillFromDisk(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no prior file → nothing to backfill
  }
  const lines = raw.split('\n').filter(Boolean);
  for (const line of lines.slice(-MAX_RING_ENTRIES)) {
    try {
      const e = JSON.parse(line) as LogEntry;
      if (
        e &&
        typeof e.ts === 'string' &&
        typeof e.msg === 'string' &&
        (e.level === 'info' || e.level === 'warn' || e.level === 'error')
      ) {
        ring.push(e);
      }
    } catch {
      // Skip malformed/partial trailing lines.
    }
  }
  if (ring.length > MAX_RING_ENTRIES) ring.splice(0, ring.length - MAX_RING_ENTRIES);
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

/** Test-only: clear the ring, partial-line carry, and subscribers (not disk). */
export function __resetLogRingForTest(): void {
  ring.length = 0;
  carry.out = '';
  carry.err = '';
  subscribers.clear();
}

/**
 * Test-only: flush + close the disk stream and resolve once buffered writes
 * have hit the file, so a test can read the file or re-init backfill
 * deterministically. (rfs buffers writes; in production a real restart flushes.)
 */
export function __flushDiskForTest(): Promise<void> {
  return new Promise((resolve) => {
    if (!diskStream) {
      resolve();
      return;
    }
    const s = diskStream;
    diskStream = null;
    s.end(() => resolve());
  });
}
