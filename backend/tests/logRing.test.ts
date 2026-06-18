import { describe, it, expect, beforeEach } from 'vitest';
import {
  installLogRing,
  getRecentEntries,
  pushEntry,
  __resetLogRingForTest,
} from '../src/logRing';

// installLogRing wraps process.stdout/stderr.write (idempotent) and passes
// every write through, so test output still appears; the ring also records it
// as a structured LogEntry (#178).
installLogRing();

beforeEach(() => {
  __resetLogRingForTest();
});

const msgs = (n: number) => getRecentEntries(n).entries.map((e) => e.msg);

describe('logRing (#171/#178)', () => {
  it('captures complete lines written to stdout as info entries', () => {
    process.stdout.write('hf-test alpha\n');
    process.stdout.write('hf-test bravo\n');
    const { entries } = getRecentEntries(10);
    const alpha = entries.find((e) => e.msg === 'hf-test alpha');
    expect(alpha).toBeTruthy();
    expect(alpha?.level).toBe('info');
    expect(alpha?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO 8601 UTC
    expect(msgs(10)).toContain('hf-test bravo');
  });

  it('buffers a partial line until the newline arrives', () => {
    process.stdout.write('hf-test par');
    expect(msgs(10)).not.toContain('hf-test partial');
    process.stdout.write('tial\n');
    expect(msgs(10)).toContain('hf-test partial');
  });

  it('returns only the most recent n entries and flags truncation', () => {
    for (let i = 0; i < 5; i++) process.stdout.write(`hf-test line ${i}\n`);
    const { entries, truncated } = getRecentEntries(2);
    expect(entries.map((e) => e.msg)).toEqual(['hf-test line 3', 'hf-test line 4']);
    expect(truncated).toBe(true);
  });

  it('reports not-truncated when n covers the whole ring', () => {
    process.stdout.write('hf-test only\n');
    const { entries, truncated } = getRecentEntries(100);
    expect(entries.map((e) => e.msg)).toEqual(['hf-test only']);
    expect(truncated).toBe(false);
  });

  it('records stderr writes as error-level entries', () => {
    process.stderr.write('hf-test err line\n');
    const entry = getRecentEntries(10).entries.find((e) => e.msg === 'hf-test err line');
    expect(entry?.level).toBe('error');
  });

  it('passes the write through (returns the underlying write result, not undefined)', () => {
    const ret = process.stdout.write('hf-test passthrough\n');
    expect(typeof ret).toBe('boolean');
  });

  it('pushEntry appends a structured entry directly', () => {
    pushEntry({ ts: '2026-06-18T20:42:55.000Z', level: 'warn', msg: 'hf-direct' });
    const entry = getRecentEntries(10).entries.find((e) => e.msg === 'hf-direct');
    expect(entry).toEqual({ ts: '2026-06-18T20:42:55.000Z', level: 'warn', msg: 'hf-direct' });
  });

  it('evicts the oldest entries once the ring is over its cap', () => {
    const N = 2100; // > MAX_RING_ENTRIES (2000)
    for (let i = 0; i < N; i++) process.stdout.write(`hf-cap ${i}\n`);
    const all = msgs(N);
    expect(all.length).toBeLessThan(N); // bounded — not unbounded growth
    expect(all).toContain(`hf-cap ${N - 1}`); // newest kept
    expect(all).not.toContain('hf-cap 0'); // oldest evicted
  });
});
