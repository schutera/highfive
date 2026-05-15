import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Re-import auth.ts fresh under each scenario by clearing the module cache
// and toggling process.env. The guards in auth.ts fire at module load time
// — they have to, because the goal is "refuse to start the backend at all"
// — so we cannot test them by calling a function after import.

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  delete process.env.HIGHFIVE_API_KEY;
  delete process.env.NODE_ENV;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('auth.ts startup guard', () => {
  it('refuses to load when HIGHFIVE_API_KEY is the literal dev fallback', async () => {
    process.env.HIGHFIVE_API_KEY = 'hf_dev_key_2026';

    await expect(import('../src/auth')).rejects.toThrow(/dev fallback/i);
  });

  // Case-insensitive dev-key check: copy-paste mishaps and shell-history
  // edits commonly mutate casing. The PR #84 senior-review flagged this
  // as a P0 — if we harden one casing only, the operator who pastes the
  // uppercase variant still ships the public string as the admin gate.
  it('refuses to load when HIGHFIVE_API_KEY is the dev fallback uppercased', async () => {
    process.env.HIGHFIVE_API_KEY = 'HF_DEV_KEY_2026';

    await expect(import('../src/auth')).rejects.toThrow(/dev fallback/i);
  });

  it('refuses to load when HIGHFIVE_API_KEY is the dev fallback mixed-case', async () => {
    process.env.HIGHFIVE_API_KEY = 'Hf_Dev_Key_2026';

    await expect(import('../src/auth')).rejects.toThrow(/dev fallback/i);
  });

  it('refuses to load when NODE_ENV=production and HIGHFIVE_API_KEY is unset', async () => {
    process.env.NODE_ENV = 'production';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV=production and HIGHFIVE_API_KEY is whitespace-only', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HIGHFIVE_API_KEY = '   ';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  // NODE_ENV typos: PR #84 senior-review caught that strict-equality on
  // NODE_ENV silently bypassed the guard for "Production", "PRODUCTION",
  // "production " (trailing space — easy in a hand-edited compose
  // env-file), and "prod" (operator abbreviation). The first three now
  // route through `isProduction()` which normalises trim + lowercase
  // against the canonical token 'production'. "prod" is intentionally
  // NOT treated as production — it's an unrecognised value, and the
  // safer interpretation of "deployment author wrote something other
  // than the canonical token" is the operator-asked-for-something-
  // unusual interpretation rather than silently activating the guard
  // on a value the operator may have meant differently. The test pins
  // that distinction so the next person who "improves" the helper
  // doesn't quietly change either decision.
  it('refuses to load when NODE_ENV is Production (capital P) and no key', async () => {
    process.env.NODE_ENV = 'Production';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV is PRODUCTION (all caps) and no key', async () => {
    process.env.NODE_ENV = 'PRODUCTION';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV has trailing whitespace and no key', async () => {
    process.env.NODE_ENV = 'production ';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV="prod" and no key (unrecognised value, treated as prod)', async () => {
    process.env.NODE_ENV = 'prod';

    // `isProduction()` treats any non-empty NODE_ENV outside the dev
    // safelist as production. "prod" is the documented operator-typo
    // case from the PR #84 senior-review — silently routing it to the
    // dev fallback is the exact failure shape the guard exists to close.
    // Regex pins the production-guard throw path rather than just any
    // throw containing "NODE_ENV"; the dev-fallback guard also mentions
    // NODE_ENV in its message, and a regression that flipped which path
    // fires would be invisible to a looser matcher.
    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load when NODE_ENV="staging" and no key (parallel-to-prod env)', async () => {
    process.env.NODE_ENV = 'staging';

    // Staging environments run with separate-from-prod secrets but
    // those secrets are still secrets. Routing staging to the public
    // dev fallback is no safer than routing production to it.
    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  // Exotic whitespace: vim-with-autoindent and Windows-line-ending env
  // files can plant `\t` or `\r\n` into a NODE_ENV value. `.trim()`
  // handles all ASCII whitespace, so behaviour is correct — but a
  // future refactor of the helper that replaced `.trim()` with a
  // hand-rolled space-only stripper would silently regress. This pins
  // the contract.
  it('refuses to load with NODE_ENV containing tab/newline whitespace and no key', async () => {
    process.env.NODE_ENV = '\tproduction\n';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('loads cleanly with no env (dev fallback active)', async () => {
    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV=test (matches vitest default)', async () => {
    process.env.NODE_ENV = 'test';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV=production and a strong key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HIGHFIVE_API_KEY = 'a-strong-32-byte-random-value-here';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });
});
