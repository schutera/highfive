import { describe, it, expect } from 'vitest';
import { formatUploadedAt } from '../lib/formatUploadedAt';

// `uploaded_at` is "YYYY-MM-DD HH:MM:SS" in UTC (not ISO-8601 — see the
// ImageUpload contract). The helper must parse it as UTC, not local, and
// fall back to the raw string on anything unparseable. Mirrors the
// one-helper-per-wire-field precedent of displayLabel.test.ts.

const OPTS = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
} as const;

describe('formatUploadedAt', () => {
  it('parses the space-separated string as UTC (not local time)', () => {
    // Compare against the same UTC-anchored Date the component should
    // produce, so the assertion is timezone-independent: a regression to
    // a bare `new Date(str)` (local parse) diverges from this in any
    // non-UTC test environment.
    const expected = new Date('2026-06-11T10:30:00Z').toLocaleString('en-US', OPTS);
    expect(formatUploadedAt('2026-06-11 10:30:00', 'en-US')).toBe(expected);
  });

  it('tolerates fractional seconds (the contract-warned edge case)', () => {
    const expected = new Date('2026-06-11T10:30:00.123Z').toLocaleString('en-US', OPTS);
    const out = formatUploadedAt('2026-06-11 10:30:00.123', 'en-US');
    expect(out).toBe(expected);
    expect(out).not.toBe('2026-06-11 10:30:00.123'); // not the raw fallback
  });

  it('uses the runtime-default locale when none is passed', () => {
    const out = formatUploadedAt('2026-06-11 10:30:00');
    // AdminPage has no language context, so it omits the locale. Just
    // assert it formatted (didn't fall through to the raw string).
    expect(out).not.toBe('2026-06-11 10:30:00');
    expect(out.length).toBeGreaterThan(0);
  });

  it('falls back to the raw string when the value is unparseable', () => {
    expect(formatUploadedAt('not-a-date')).toBe('not-a-date');
    expect(formatUploadedAt('')).toBe('');
  });
});
