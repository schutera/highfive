import { describe, it, expect, beforeEach } from 'vitest';
import { installLogRing, getRecentLogLines, __resetLogRingForTest } from '../src/logRing';

// installLogRing wraps process.stdout/stderr.write (idempotent) and passes
// every write through, so test output still appears; the ring also records it.
installLogRing();

beforeEach(() => {
  __resetLogRingForTest();
});

describe('logRing (#171)', () => {
  it('captures complete lines written to stdout', () => {
    process.stdout.write('hf-test alpha\n');
    process.stdout.write('hf-test bravo\n');
    const { lines } = getRecentLogLines(10);
    expect(lines).toContain('hf-test alpha');
    expect(lines).toContain('hf-test bravo');
  });

  it('buffers a partial line until the newline arrives', () => {
    process.stdout.write('hf-test par');
    expect(getRecentLogLines(10).lines).not.toContain('hf-test partial');
    process.stdout.write('tial\n');
    expect(getRecentLogLines(10).lines).toContain('hf-test partial');
  });

  it('returns only the most recent n lines and flags truncation', () => {
    for (let i = 0; i < 5; i++) process.stdout.write(`hf-test line ${i}\n`);
    const { lines, truncated } = getRecentLogLines(2);
    expect(lines).toEqual(['hf-test line 3', 'hf-test line 4']);
    expect(truncated).toBe(true);
  });

  it('reports not-truncated when n covers the whole ring', () => {
    process.stdout.write('hf-test only\n');
    const { lines, truncated } = getRecentLogLines(100);
    expect(lines).toEqual(['hf-test only']);
    expect(truncated).toBe(false);
  });

  it('also captures stderr writes', () => {
    process.stderr.write('hf-test err line\n');
    expect(getRecentLogLines(10).lines).toContain('hf-test err line');
  });

  it('passes the write through (returns the underlying write result, not undefined)', () => {
    const ret = process.stdout.write('hf-test passthrough\n');
    expect(typeof ret).toBe('boolean');
  });

  it('evicts the oldest lines once the ring is over its cap', () => {
    const N = 2100; // > MAX_RING_LINES (2000)
    for (let i = 0; i < N; i++) process.stdout.write(`hf-cap ${i}\n`);
    const { lines } = getRecentLogLines(N);
    expect(lines.length).toBeLessThan(N); // bounded — not unbounded growth
    expect(lines).toContain(`hf-cap ${N - 1}`); // newest kept
    expect(lines).not.toContain('hf-cap 0'); // oldest evicted
  });
});
