// Normalised environment-mode predicates.
//
// Centralising `NODE_ENV` interpretation avoids the drift that the
// PR #84 senior-review caught: three call sites (`auth.ts`, `app.ts`,
// `server.ts`) each did `process.env.NODE_ENV === 'production'`, which
// silently fell through to dev behaviour on `"Production"` (uppercase),
// `"production "` (trailing space from hand-edited compose env-files),
// or `"prod"` (operator abbreviation). The auth-guard PR existed
// because that exact failure mode had already happened in production,
// so leaving each call site to re-derive the check would have shipped
// the same bug shape it set out to close.
//
// `isProduction()` uses the conservative interpretation: only an
// explicit, known-safe-for-dev-fallback `NODE_ENV` value escapes
// production handling. Anything else — including unrecognised values
// like `"prod"`, `"staging"`, `"qa"` — is treated as production.
// Rationale: an unrecognised value is almost certainly an operator
// typo for "production" or a parallel-to-production environment
// (staging, QA), both of which should require the strong API key.
// Silently treating them as dev was the exact failure mode this
// helper was extracted to close.
//
// The dev safelist intentionally stays short. New entries should
// require a real use-case and a corresponding test in
// `backend/tests/auth-prod-guard.test.ts` so the next person who
// adds a value to the list can't quietly broaden the dev-fallback
// surface.
//
// `process.env` is read each call rather than captured at module load
// because the test suite manipulates env vars between cases via
// `vi.resetModules()` + dynamic `import()`.

const DEV_ENV_TOKENS: ReadonlySet<string> = new Set([
  '', // empty string = NODE_ENV unset, dev workflow default
  'development',
  'dev',
  'test',
  'testing',
  'local',
]);

export function isProduction(): boolean {
  const normalised = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return !DEV_ENV_TOKENS.has(normalised);
}
