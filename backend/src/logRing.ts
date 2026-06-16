// In-memory ring of the backend's own recent stdout/stderr lines (#171).
//
// A stdout/stderr *tee*: every write is recorded into a bounded ring AND
// passed through to the real stream, so `docker logs` / PM2 still see
// everything unchanged. This captures `console.*` (which write to
// stdout/stderr) and any direct `process.stdout.write` — i.e. exactly what an
// operator sees in the container log today. Same idea as the ESP `logbuf`
// ring. `GET /api/admin/logs?service=backend` reads this directly.
//
// Caveats (see ADR-021): in-memory, so it resets on process restart (only
// holds lines since startup) and is per-process (a future multi-worker prod
// would have one ring per worker).

const MAX_RING_LINES = 2000;

const ring: string[] = [];
let installed = false;

// A write may not end on a newline, so hold the trailing fragment per stream
// until the next write completes the line.
const carry: Record<'out' | 'err', string> = { out: '', err: '' };

function pushLine(line: string): void {
  ring.push(line);
  if (ring.length > MAX_RING_LINES) {
    ring.splice(0, ring.length - MAX_RING_LINES);
  }
}

function record(which: 'out' | 'err', chunk: unknown): void {
  const text =
    typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  if (!text) return;
  const combined = carry[which] + text;
  const parts = combined.split('\n');
  // The last element is the (possibly empty) incomplete tail — carry it over.
  carry[which] = parts.pop() ?? '';
  for (const line of parts) pushLine(line);
}

/**
 * Wrap process.stdout/stderr `write` so each completed line is also stored in
 * the ring. Idempotent. Call once, as early as possible at process start.
 */
export function installLogRing(): void {
  if (installed) return;
  installed = true;
  for (const [stream, which] of [
    [process.stdout, 'out'],
    [process.stderr, 'err'],
  ] as const) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...args: unknown[]): boolean => {
      try {
        record(which, chunk);
      } catch {
        // Capture must never break real logging.
      }
      // Preserve the original variadic (chunk, encoding?, cb?) signature.
      return (original as (...a: unknown[]) => boolean)(chunk, ...args);
    }) as typeof stream.write;
  }
}

/**
 * The most recent `n` captured lines, chronological (oldest→newest), and
 * whether the ring held more than were returned.
 */
export function getRecentLogLines(n: number): { lines: string[]; truncated: boolean } {
  const count = Math.max(0, Math.min(n, ring.length));
  const lines = count === 0 ? [] : ring.slice(ring.length - count);
  return { lines, truncated: ring.length > lines.length };
}

/** Test-only: clear the ring and partial-line carry. */
export function __resetLogRingForTest(): void {
  ring.length = 0;
  carry.out = '';
  carry.err = '';
}
