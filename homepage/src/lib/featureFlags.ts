// Build-time feature flags for the homepage.
//
// These are plain `VITE_*` env vars that Vite inlines into the bundle at
// build time (see homepage/Dockerfile, which bakes them via build ARGs), so
// flipping one is a DEPLOY-time toggle, not a runtime one: changing the value
// requires a fresh `vite build` / homepage image rebuild. That trade-off is
// accepted on purpose — a flag can ship to `main` disabled, avoiding long
// branches and merge conflicts, and be turned on later without re-doing the
// work. A truly runtime-flippable flag would have to be served by the backend.
//
// Convention + the build-time caveat are recorded in ADR-022. Default is OFF
// for every flag: an unset (or non-`'true'`) value reads as disabled.

/**
 * A flag is on ONLY when its env var is exactly the string `'true'`. Empty,
 * undefined, `'TRUE'`, `'1'`, or whitespace all read as OFF — the safe
 * default that backs ADR-022's "off in prod unless explicitly enabled"
 * guarantee. Exported (pure, env-independent) so the semantics can be unit
 * tested without rebuilding with a different `import.meta.env`.
 */
export function flagEnabled(value: string | undefined): boolean {
  return value === 'true';
}

// Public dashboard "Latest captures" gallery in ModulePanel (#154). Off in
// production until segmentation guarantees only bee nests are visible in the
// uploaded photos; the dev and UI-test stacks set it to 'true'.
export const DASHBOARD_IMAGES_ENABLED = flagEnabled(import.meta.env.VITE_ENABLE_DASHBOARD_IMAGES);
