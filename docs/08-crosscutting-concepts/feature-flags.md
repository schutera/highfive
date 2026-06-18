# Feature flags

How HiveHive gates a feature behind an env-var switch — the conventions, the
two flavours, and which one to reach for. The motivating decision (the homepage
build-time flavour) is recorded in
[ADR-022](../09-architecture-decisions/adr-022-build-time-feature-flags.md); this
page is the practical "how do I use flags here" reference that spans services.

## Two flavours — pick by layer and flip-cadence

There is no single flag framework. A flag is a plain environment variable read
through one small helper, and which helper depends on where the gated code runs.

|                            | **Homepage build-time flag**                                                                                                   | **Backend runtime gate**                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Layer                      | Homepage (Vite SPA)                                                                                                            | Any Python/Node service                                                                                                                   |
| Read via                   | `import.meta.env.VITE_*`, through [`homepage/src/lib/featureFlags.ts`](../../homepage/src/lib/featureFlags.ts)'s `flagEnabled` | `os.getenv(...)` / `process.env.*` at request/startup time                                                                                |
| When evaluated             | **Build time** — Vite inlines the value into the bundle                                                                        | **Runtime** — read live from the process env                                                                                              |
| Flip by                    | Fresh `vite build` / homepage image rebuild **+ redeploy**                                                                     | Restart the service with a new env value                                                                                                  |
| Default direction          | **Off** (ship a new feature dark)                                                                                              | Usually **on** (operational kill-switch)                                                                                                  |
| First / canonical instance | `VITE_ENABLE_DASHBOARD_IMAGES` → `LatestCaptures` in `ModulePanel.tsx`                                                         | `WEATHER_WORKER_ENABLED` → the duckdb-service weather worker ([ADR-017](../09-architecture-decisions/adr-017-external-weather-source.md)) |

**Decision rule.** Gating UI on the homepage → build-time `VITE_*` flag. Gating
server-side behaviour (a worker, an endpoint's side effect, a code path in a
service) → runtime env gate. If you need to flip a _homepage_ feature **without
a rebuild** (per-environment, hot toggle), neither fits — that requires a
backend-served runtime config (`GET /api/config`), explicitly the alternative
rejected-for-now in ADR-022; introduce it and supersede ADR-022 for that flag.

## Homepage build-time flags (the `VITE_*` convention)

This is the convention to copy for any new homepage feature flag. It exists
because a single-page app served as a static bundle has **no runtime config
channel** — the only place to inject config is the build.

**The rules:**

1. **One registry module.** Every homepage flag is one `export const` in
   [`homepage/src/lib/featureFlags.ts`](../../homepage/src/lib/featureFlags.ts),
   read through the shared `flagEnabled(value)` helper. That helper returns
   `value === 'true'` — **only the exact lowercase string `true` enables a
   flag.** Unset, empty, `TRUE`, `1`, ` true` (leading space) all read as
   **off**. This is the safe default; it is pinned by
   `homepage/src/__tests__/featureFlags.test.ts` so a future edit that also
   accepts `'1'` has to change that test on purpose.
2. **Default off.** An unset var is off. A homepage feature flag exists to ship
   a feature to `main` _disabled_ and turn it on later — never the reverse.
3. **Gate at the mount site only.** The component the flag controls stays
   flag-unaware; the gating `const && <Component/>` lives where it mounts (e.g.
   `ModulePanel.tsx` gates `<LatestCaptures>`). Do not thread the flag through
   the feature's own code.
4. **The gated code still ships in the bundle.** It is gated, not tree-shaken
   out. That is fine — the homepage holds no secrets
   ([ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md)),
   so dead UI code is not a leak. (Do **not** try to hide a secret behind a
   flag; `VITE_*` is inlined as a public string — see ADR-019.)

**Where the value is set, per context** (every context that sets it uses the same var name):

| Context         | File                                                                                   | How it's set                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Production      | [`homepage/Dockerfile`](../../homepage/Dockerfile)                                     | `ARG VITE_ENABLE_DASHBOARD_IMAGES=` (empty default = off). Enable with `docker build --build-arg VITE_ENABLE_DASHBOARD_IMAGES=true`. |
| Dev stack       | [`docker-compose.yml`](../../docker-compose.yml)                                       | `environment: VITE_ENABLE_DASHBOARD_IMAGES: 'true'` (dev Vite reads env at dev-server start)                                         |
| Unit tests      | [`homepage/vitest.config.ts`](../../homepage/vitest.config.ts)                         | `define:` injects `'true'` so jsdom suites exercise the gated path                                                                   |
| UI / Playwright | [`tests/ui/docker-compose.ui.yml`](../../tests/ui/docker-compose.ui.yml)               | build `args:` set `'true'`                                                                                                           |
| Local opt-in    | `homepage/.env` (documented in [`homepage/.env.example`](../../homepage/.env.example)) | `VITE_ENABLE_DASHBOARD_IMAGES=true`                                                                                                  |

**To add a homepage flag:** add one `flagEnabled(import.meta.env.VITE_<NAME>)`
const to `featureFlags.ts`; gate the mount on it; wire the deploy + test
contexts above (default the prod `ARG` empty, set dev/test stacks `'true'`); document it in
`.env.example`; add a one-line `flagEnabled` semantics check if the feature is
risk-bearing.

**The caveat that bites:** flipping a build-time flag in production is a
**deploy-time** action, not a hot switch. Setting the env on a _running_
container does nothing — the value is already baked into `dist/`. You must
rebuild the homepage image and redeploy, then hard-refresh past the cached
bundle.

## Backend runtime gates

Server-side features gate on a plain env var read at runtime. The canonical
example is the weather worker. `duckdb-service/app.py`'s startup gate reads
`os.getenv("WEATHER_WORKER_ENABLED", "true").lower() == "true"` and only then
registers the recurring fetch (an APScheduler `add_job` on the shared
`BackgroundScheduler`); the scheduler itself always starts, so only that one job
is gated. The worker's own `run_weather_fetch` then independently re-checks the
same var through the private `_enabled()` helper in
`duckdb-service/services/weather_worker.py` before doing any work — note the var
is read in two separate inline places, not via one shared helper.

Conventions differ from the homepage flavour on purpose:

- **Default on.** These are operational kill-switches for an existing feature,
  not ship-dark toggles. The default (`"true"`) keeps the feature running if the
  var is absent; an operator sets it `false` to disable.
- **Case-insensitive `"true"`.** The Python pattern is
  `os.getenv(NAME, "true").lower() == "true"` — looser than the homepage's exact
  `=== 'true'` because it is operator-typed, not build-injected.
- **Flip by restart.** Change the env (e.g. in `docker-compose.yml`, where
  `WEATHER_WORKER_ENABLED: 'true'` is set) and restart the service. No rebuild —
  the value is read live.
- **Don't disable the endpoint, only the side effect.** Gating should leave the
  surface reachable where that matters; e.g. the weather endpoints stay up with
  `WEATHER_WORKER_ENABLED=false`, only the background worker stops (see
  [api-reference.md](../api-reference.md) and ADR-017).

## Testing a flag

Whichever flavour, a test should pin the gate's **semantics**, not just the
happy path:

- Homepage: the `flagEnabled` unit test pins "only `'true'` enables"; the
  gated UI is exercised on (vitest `define` + UI-test build arg both set
  `'true'`). The **off** path has no automated proof and rests on the
  `=== 'true'` contract + the empty prod `ARG` — confirm it by serving a
  no-build-arg build (the gate compiles to a constant `false`).
- Backend: gate-on and gate-off both want a test — e.g. the weather-worker
  suite asserts `WEATHER_WORKER_ENABLED=false` short-circuits **before** any
  work runs, not merely that the response shape is unchanged.

## See also

- [ADR-022](../09-architecture-decisions/adr-022-build-time-feature-flags.md) — the build-time `VITE_*` decision and rejected alternatives.
- [ADR-017](../09-architecture-decisions/adr-017-external-weather-source.md) — the `WEATHER_WORKER_ENABLED` runtime gate in context.
- [ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md) / [auth.md](auth.md) — why a flag must never hide a secret in the homepage bundle.
- [Glossary → Feature flag](../12-glossary/README.md#configuration-and-feature-flags) — canonical term and the two-flavour disambiguation.
