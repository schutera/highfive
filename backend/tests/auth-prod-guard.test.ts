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

    // Regex pins the dev-fallback-guard throw path specifically; the
    // production-guard error message also contains "dev fallback" as
    // a substring, so a looser matcher would pass even if a regression
    // flipped which guard fires.
    await expect(import('../src/auth')).rejects.toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  // Case-insensitive dev-key check: copy-paste mishaps and shell-history
  // edits commonly mutate casing. The PR #84 senior-review flagged this
  // as a P0 — if we harden one casing only, the operator who pastes the
  // uppercase variant still ships the public string as the admin gate.
  it('refuses to load when HIGHFIVE_API_KEY is the dev fallback uppercased', async () => {
    process.env.HIGHFIVE_API_KEY = 'HF_DEV_KEY_2026';

    await expect(import('../src/auth')).rejects.toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
  });

  it('refuses to load when HIGHFIVE_API_KEY is the dev fallback mixed-case', async () => {
    process.env.HIGHFIVE_API_KEY = 'Hf_Dev_Key_2026';

    await expect(import('../src/auth')).rejects.toThrow(
      /is set \(case-insensitively\) to the public dev fallback/,
    );
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

  // Positive coverage for each entry in `env.ts`'s `DEV_ENV_TOKENS`
  // safelist. The next maintainer who adds (or removes) a safelist
  // entry must also touch this section — that's the contract that
  // keeps the safelist's documented owners and its actual contents
  // from drifting. Round-3 review caught the drift in the opposite
  // direction (comment claimed owners that didn't exist); these
  // tests close it in both directions.

  it('loads cleanly with NODE_ENV unset (safelist entry `""`)', async () => {
    // process.env.NODE_ENV not set in beforeEach already.
    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV="development" (safelist entry; docker-compose.yml sets this)', async () => {
    process.env.NODE_ENV = 'development';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  it('loads cleanly with NODE_ENV="test" (safelist entry; vitest default)', async () => {
    process.env.NODE_ENV = 'test';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });

  // Negative pin: `'dev'` and `'testing'` were in the safelist through
  // round 2 with imagined-not-verified citations. Round 3 cut them.
  // Both now refuse to load when no key is set, which is the conservative
  // interpretation — anything outside the verified safelist requires the
  // strong key. If you ever re-add either to the safelist, update the
  // env.ts comment with a real caller citation AND flip this test from
  // refuses-to-loads. Asymmetric edit is the gate.
  it('refuses to load with NODE_ENV="dev" (not in safelist — was a round-3 cut)', async () => {
    process.env.NODE_ENV = 'dev';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('refuses to load with NODE_ENV="testing" (not in safelist — was a round-3 cut)', async () => {
    process.env.NODE_ENV = 'testing';

    await expect(import('../src/auth')).rejects.toThrow(/NODE_ENV=production/);
  });

  it('loads cleanly with NODE_ENV=production and a strong key', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HIGHFIVE_API_KEY = 'a-strong-32-byte-random-value-here';

    await expect(import('../src/auth')).resolves.toBeDefined();
  });
});
