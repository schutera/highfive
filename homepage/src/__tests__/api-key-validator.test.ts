import { describe, it, expect } from 'vitest';
import { validateBuildTimeApiKey } from '../services/api';

// Pure-function tests for the build-time API-key validator. Vite's
// import.meta.env.PROD is set at bundle-build time, not at module-import
// time, so testing the validator via vi.stubEnv + module-reset would
// exercise the loader plumbing rather than the decision logic. Testing
// the pure function directly is cleaner.
//
// Mirrors backend/tests/auth-prod-guard.test.ts in shape: each test
// pins one branch of the validator's truth table, regex matches on the
// throw message keep the "which guard fired" distinction sharp.

describe('validateBuildTimeApiKey', () => {
  // ----- dev mode (isProd=false): never throws, regardless of key -----

  it('does not throw in dev mode with an undefined key', () => {
    expect(() => validateBuildTimeApiKey(undefined, false)).not.toThrow();
  });

  it('does not throw in dev mode with the dev fallback key', () => {
    expect(() => validateBuildTimeApiKey('hf_dev_key_2026', false)).not.toThrow();
  });

  it('does not throw in dev mode with a strong key', () => {
    expect(() =>
      validateBuildTimeApiKey('a-strong-32-byte-random-value-here', false),
    ).not.toThrow();
  });

  // ----- prod + unset: must throw with the unset-path message -----

  it('throws in prod mode when the key is undefined', () => {
    expect(() => validateBuildTimeApiKey(undefined, true)).toThrow(/VITE_API_KEY must be set/);
  });

  it('throws in prod mode when the key is the empty string', () => {
    expect(() => validateBuildTimeApiKey('', true)).toThrow(/VITE_API_KEY must be set/);
  });

  it('throws in prod mode when the key is whitespace-only', () => {
    // Senior-review (PR-86/87 round 1) caught the symmetric drift:
    // backend's `process.env.HIGHFIVE_API_KEY?.trim() || undefined`
    // already coerces whitespace-only to undefined and trips the
    // production guard. Without the matching `.trim().length === 0`
    // check on the frontend, a `VITE_API_KEY='   '` slipped through
    // both branches (whitespace is truthy in JS) and shipped a bundle
    // whose API_KEY local resolved to '   '. Pin all three common
    // whitespace shapes — spaces, tabs, newlines — so a future
    // refactor of the reduction cannot quietly regress this.
    expect(() => validateBuildTimeApiKey('   ', true)).toThrow(/VITE_API_KEY must be set/);
    expect(() => validateBuildTimeApiKey('\t\t', true)).toThrow(/VITE_API_KEY must be set/);
    expect(() => validateBuildTimeApiKey('\n\n', true)).toThrow(/VITE_API_KEY must be set/);
  });

  // ----- prod + dev fallback (any casing): must throw with the dev-fallback message -----
  //
  // Regex pins the dev-fallback throw path specifically so a regression
  // that flipped which guard fires would be visible. The pattern
  // `/is set \(case-insensitively\) to the public dev fallback/` matches
  // the literal substring in the error message and excludes the unset-path
  // message above.

  it('throws in prod mode for the literal dev fallback (lowercase)', () => {
    expect(() => validateBuildTimeApiKey('hf_dev_key_2026', true)).toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  it('throws in prod mode for the dev fallback uppercased', () => {
    // Copy-paste mishaps and shell-history edits commonly mutate casing.
    // If the validator only catches one casing, an operator who pastes
    // the uppercase variant ships the public string into the bundle.
    expect(() => validateBuildTimeApiKey('HF_DEV_KEY_2026', true)).toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  it('throws in prod mode for the dev fallback mixed-case', () => {
    expect(() => validateBuildTimeApiKey('Hf_Dev_Key_2026', true)).toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  it('throws in prod mode for the dev fallback with whitespace padding', () => {
    // Hand-edited .env files (vim with autoindent, Windows line-endings)
    // can plant leading/trailing whitespace around values. The validator's
    // .trim() handles all ASCII whitespace; this test pins the contract.
    expect(() => validateBuildTimeApiKey('  hf_dev_key_2026  ', true)).toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  // ----- prod + strong key: must not throw (happy path) -----

  it('does not throw in prod mode with a strong key', () => {
    expect(() => validateBuildTimeApiKey('a-strong-32-byte-random-value-here', true)).not.toThrow();
  });

  // ----- regression pin: prod + dev-fallback-like-but-not-equal -----

  it('does not throw in prod mode for a key that contains but is not the dev fallback', () => {
    // The check is `.trim().toLowerCase() === DEV_FALLBACK_KEY` (full
    // string equality, not substring). A key that happens to contain
    // 'hf_dev_key_2026' as a prefix or suffix is treated as a custom
    // value. This pins that distinction so a future refactor to
    // .includes() doesn't sneak in.
    expect(() => validateBuildTimeApiKey('hf_dev_key_2026_with_suffix', true)).not.toThrow();
  });
});
