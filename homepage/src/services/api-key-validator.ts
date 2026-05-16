// Build-time API-key validator. Lives in its own module so that
// `homepage/src/main.tsx` can eagerly side-effect-import it and the
// throw fires on the FIRST page load, regardless of which route the
// user lands on.
//
// Lesson earned during PR-#86/#87 manual smoke testing: the validator
// previously lived inside api.ts, which Vite code-splits into a
// separate lazy chunk (DashboardPage / AdminPage / TelemetryRow are
// the importers, the marketing-style home page is not). A misconfigured
// production bundle would therefore load the home page cleanly and
// only fast-fail when the user clicked into the dashboard — defeating
// the "fast-fail at first browser load" guarantee the validator is
// supposed to provide.
//
// Pulling the validator into its own module + a side-effect import in
// `main.tsx` puts the call into the entry chunk and the throw fires
// at app bootstrap. The api.ts module then re-exports DEV_FALLBACK_KEY
// + validateBuildTimeApiKey for the unit tests (which exercise the
// pure function directly).

// The dev fallback. Named once so the validator and the api.ts fallback
// expression cannot drift. Public string by design (documented in
// CLAUDE.md "Critical rules" and the symmetric backend constant
// `backend/src/auth.ts`'s `DEV_FALLBACK_KEY`); safe only in dev builds
// where the validator below allows it.
export const DEV_FALLBACK_KEY = 'hf_dev_key_2026';

/**
 * Validator for `VITE_API_KEY`. Throws on prod builds when the key is
 * absent, whitespace-only, OR (case-insensitively, with whitespace
 * tolerance) the public dev fallback.
 *
 * Runs at module-load time in the bundle (i.e. first time the browser
 * imports this file), not at `vite build` time. Vite inlines
 * `import.meta.env.VITE_API_KEY` into the bundle as a string literal
 * during transformation; the throw fires when the bundle is loaded.
 * The bundle artifact therefore still contains the literal string for
 * a bad key — acceptable because the dev fallback is public by design
 * (documented in CLAUDE.md). What this guard buys: a misconfigured
 * production deployment fast-fails with a self-describing error at
 * first browser load, instead of a stream of opaque 403s from the
 * symmetric `verifyApiKey` boundary in `backend/src/auth.ts` rejecting
 * every request.
 *
 * Exported as a pure function so tests can exercise the decision logic
 * directly without Vitest env-stubbing (which can't simulate Vite's
 * build-time env inlining).
 */
export function validateBuildTimeApiKey(key: string | undefined, isProd: boolean): void {
  if (!isProd) return;
  // Whitespace-only also counts as unset: the backend's
  // `process.env.HIGHFIVE_API_KEY?.trim() || undefined` coerces a
  // whitespace-only env value to `undefined` and the production guard
  // fires. Matching that reduction here keeps the two halves of the
  // project symmetric — without the `.trim().length === 0` check, a
  // production build with `VITE_API_KEY='   '` would slip through both
  // branches below (whitespace is truthy in JavaScript) and ship a
  // bundle whose API_KEY local resolves to `'   '`, which the backend
  // then rejects with 403 on every request.
  if (!key || key.trim().length === 0) {
    throw new Error('VITE_API_KEY must be set to a non-empty value for production builds.');
  }
  if (key.trim().toLowerCase() === DEV_FALLBACK_KEY) {
    throw new Error(
      `VITE_API_KEY is set (case-insensitively) to the public dev ` +
        `fallback '${DEV_FALLBACK_KEY}'. Production builds must use a ` +
        `strong secret. See CLAUDE.md "Critical rules" and the symmetric ` +
        `backend guard in backend/src/auth.ts.`,
    );
  }
}

// VITE_API_URL guard stays inline — separate concern, separate throw.
// docker-compose.prod.yml already rejects empty values upstream via
// ${VAR:?msg}, but this guards direct-build paths too (e.g. a standalone
// `docker build` without --build-arg).
if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  throw new Error('VITE_API_URL must be set at build time for production builds.');
}
validateBuildTimeApiKey(import.meta.env.VITE_API_KEY, import.meta.env.PROD);
