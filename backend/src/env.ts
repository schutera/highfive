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
// The dev safelist intentionally stays short. Each token must have a
// load-bearing caller in this repo — a Dockerfile, compose file, npm
// script, vitest/Node default, or framework convention that actually
// sets it. If you add an entry, name the caller in the comment below.
// Round 2 cut `'local'` (no caller found); round 3's review cut `'dev'`
// and `'testing'` for the same reason — both had imagined-not-verified
// citations in an earlier comment. A safelist entry without a verified
// caller is dead code that invites the next maintainer to expand the
// dev-fallback surface "because it's already a pattern."
//
// Currently in the safelist:
// * `''` — NODE_ENV unset; the implicit dev workflow when an operator
//   runs `npm run dev` (see `backend/package.json`'s `dev` script:
//   `tsx watch src/server.ts`, no env override).
// * `'development'` — Node's standard sentinel, the value
//   `dotenv/config` and most Node frameworks recognise. Set by
//   `docker-compose.yml`'s `backend` service for the dev compose
//   topology (verified at the time of writing).
// * `'test'` — vitest's default `NODE_ENV` (Vitest documents this:
//   "If NODE_ENV is not set, Vitest sets it to 'test' by default").
//   The backend's entire 60-test suite runs under this value.
//
// `process.env` is read each call rather than captured at module load
// because the test suite manipulates env vars between cases via
// `vi.resetModules()` + dynamic `import()`. Per-call `process.env`
// access is cheap (Node maintains it as a normal object), so calling
// `isProduction()` from a hot path is fine. The asymmetry with
// `auth.ts`'s once-at-load `ENV_KEY` capture is intentional: the
// key value is policy (set once at deploy time), the env-mode is
// runtime context (test suite flips it between cases).

const DEV_ENV_TOKENS: ReadonlySet<string> = new Set(['', 'development', 'test']);

export function isProduction(): boolean {
  const normalised = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return !DEV_ENV_TOKENS.has(normalised);
}
