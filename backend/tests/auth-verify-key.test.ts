import { describe, it, expect } from 'vitest';
import { verifyApiKey } from '../src/auth';

// Tests run under NODE_ENV=test (vitest default) with HIGHFIVE_API_KEY unset,
// so auth.ts captures the dev fallback 'hf_dev_key_2026' as API_KEY at module
// load. Same convention as auth.test.ts.
const KEY = 'hf_dev_key_2026';

describe('verifyApiKey (constant-time compare)', () => {
  it('returns true when the provided key matches the configured key', () => {
    expect(verifyApiKey(KEY)).toBe(true);
  });

  it('returns false for a same-length but different key', () => {
    // Same byte length as 'hf_dev_key_2026' (15) — exercises the
    // post-length-check timingSafeEqual path, not the length-short-circuit.
    expect(verifyApiKey('xx_xxx_xxx_xxxx')).toBe(false);
  });

  it('returns false for a shorter key (length-mismatch short-circuit)', () => {
    // Without the length guard, Node's timingSafeEqual would throw on a
    // length mismatch. The guard converts that to a clean `false` and
    // keeps the caller's 403 path intact.
    expect(verifyApiKey('hf')).toBe(false);
  });

  it('returns false for a longer key (length-mismatch short-circuit)', () => {
    expect(verifyApiKey(`${KEY}_extra_bytes`)).toBe(false);
  });

  it('returns false for the empty string', () => {
    expect(verifyApiKey('')).toBe(false);
  });

  it('is case-sensitive (the dev-fallback startup guard handles casing; the runtime compare does not)', () => {
    // The case-insensitive logic lives at module load (auth.ts's dev-fallback
    // guard refuses to boot when HIGHFIVE_API_KEY is any-cased dev fallback).
    // At runtime, the compare is strict — an attacker submitting 'HF_DEV_KEY_2026'
    // does not get a free pass.
    expect(verifyApiKey(KEY.toUpperCase())).toBe(false);
  });
});
