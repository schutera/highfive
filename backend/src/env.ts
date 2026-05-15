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
// The dev safelist intentionally stays short. Each token has a load-
// bearing caller — if you add an entry, point at the Dockerfile,
// compose file, npm script, or framework default that actually sets
// it. Round-2 review caught `'local'` here with no such citation and
// removed it: a safelist entry without an owner is dead code that
// invites the next maintainer to expand the dev-fallback surface
// "because it's already a pattern."
//
// Currently in the safelist:
// * `''` — NODE_ENV unset; the implicit dev workflow `npm run dev`.
// * `'development'` — Node's documented dev sentinel.
// * `'dev'` — convenience alias used by some CI matrices.
// * `'test'` — vitest's default in this repo and in CI.
// * `'testing'` — pytest convention occasionally bridged into Node-side.
//
// `process.env` is read each call rather than captured at module load
// because the test suite manipulates env vars between cases via
// `vi.resetModules()` + dynamic `import()`. Per-call `process.env`
// access is cheap (Node maintains it as a normal object), so calling
// `isProduction()` from a hot path is fine. The asymmetry with
// `auth.ts`'s once-at-load `ENV_KEY` capture is intentional: the
// key value is policy (set once at deploy time), the env-mode is
// runtime context (test suite flips it between cases).

const DEV_ENV_TOKENS: ReadonlySet<string> = new Set(['', 'development', 'dev', 'test', 'testing']);

export function isProduction(): boolean {
  const normalised = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return !DEV_ENV_TOKENS.has(normalised);
}
