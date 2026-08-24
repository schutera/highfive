# Authentication and authorisation

HiveHive has two trust boundaries (reshaped by [#142](https://github.com/schutera/highfive/issues/142) / [ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md)):

1. **Public reads** — the dashboard, map, and setup wizard are linked
   from the marketing site and must render for anonymous visitors, so
   the read endpoints (`/api/modules`, `/api/images`, activity,
   measurements, user-location, image bytes) require **no** credential.
2. **Admin / write actions** (delete, rename, append measurements,
   weather backfill, telemetry-log inspection) — gated by a real
   server-side session: an operator logs in with the admin secret, the
   server validates it and sets an **HttpOnly session cookie**. The
   secret never reaches the browser. A server-side `X-Admin-Key` header
   (machine credential) is accepted as an alternative for operator
   scripts / CI.

There is no per-user identity and no OAuth. There is one shared admin
secret (`HIGHFIVE_API_KEY`); it is the login password and the
session-cookie signing key, and it is never shipped to the browser.

> **Historical note.** Before #142 the homepage baked the secret into the
> public JS bundle via `VITE_API_KEY`, and the `/admin` "login" only pinged
> the public `/api/health`, so any string passed. A single-page app cannot
> hold a secret — anything bundled is public — so the fix was architectural,
> not a key rotation. See [ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md) and the
> [chapter-11 lesson](../11-risks-and-technical-debt/README.md).

## The secret

`HIGHFIVE_API_KEY` (env var). The dev-mode fallback is
`hf_dev_key_2026`, defined in
[`backend/src/auth.ts`'s `DEV_FALLBACK_KEY`](../../backend/src/auth.ts).
The fallback is a public string by design — it's documented here, in
`CLAUDE.md`, and in the backend test suite — so it is safe only for
local development. The homepage bundle no longer carries any form of
this secret (there is no `VITE_API_KEY`).

Code-side enforcement: `auth.ts` runs two guards at module load,
keyed on
[`backend/src/env.ts`'s `isProduction()`](../../backend/src/env.ts)
(which normalises `NODE_ENV` for casing + whitespace typos and treats
unknown values as production):

1. If `HIGHFIVE_API_KEY` is set case-insensitively to the dev
   fallback, the backend refuses to boot. A `.env` file copy-paste
   from `.env.example` is the typical trigger.
2. If `isProduction()` is true and `HIGHFIVE_API_KEY` is unset or
   whitespace, the backend refuses to boot. A missing override on
   production is the typical trigger.

Both throws happen before the express app is built, so a
misconfigured deployment fast-crashes with a self-describing error
instead of silently exposing the public dev key as the production
admin gate. Tests in
[`backend/tests/auth-prod-guard.test.ts`](../../backend/tests/auth-prod-guard.test.ts)
pin the two throw paths (with regexes specific to each error
message), positive-case each entry currently in the dev safelist,
and negative-case the two values cut from the safelist during
review (`'dev'`, `'testing'`) so a future re-add must update the
tests in lockstep.

**The Flask services carry the same guard (2026-07 audit, #204).**
Both `duckdb-service` and `image-service` resolve the same
key-or-dev-fallback for their admin-gated `/logs` endpoints, and both
now refuse to boot in production with the fallback: each service's
`services/prod_guard.py` (twin copies, like `log_ring.py`) raises at
app import when production is declared but `HIGHFIVE_API_KEY` is
unset, blank, or the dev fallback in any casing. Because there is no
`NODE_ENV` for Python and modern Flask dropped `FLASK_ENV`,
production is declared explicitly via **`HIGHFIVE_ENV=production`**:

- `docker-compose.prod.yml` sets it for both Flask services (this is
  the supported deploy path — the `:?` interpolation on
  `HIGHFIVE_API_KEY` already fail-fasts there, so the in-service guard
  is the backstop for other permutations).
- **PM2/bare-metal operators must set `HIGHFIVE_ENV=production` in the
  server-side process config** for `duckdb-service` and
  `image-service` (the pm2 apps `scripts/deploy.sh` reloads). Without
  the marker the guard is a no-op — the off-ramp semantics match the
  backend's `NODE_ENV=development` off-ramp: an explicit operator
  choice, not a silent default.

## Admin session (cookie)

Defined in [`backend/src/session.ts`](../../backend/src/session.ts).

**Login.** `POST /api/admin/login` with `{ "password": "<HIGHFIVE_API_KEY>" }`.
The server compares the password constant-time via
[`backend/src/auth.ts`'s `verifyApiKey`](../../backend/src/auth.ts) and, on
success, sets the `hf_admin_session` cookie. Failed attempts are
rate-limited per-IP (in-memory; 10 / 15 min). `POST /api/admin/logout`
clears the cookie; `GET /api/admin/session` returns
`{ authenticated: boolean }` so the SPA can decide whether to show the
login form.

**Token.** The cookie value is a stateless, HMAC-signed token
(`base64url(payload).base64url(HMAC-SHA256(payload, secret))`, payload
`{ v, exp }`, ~12 h TTL). The HMAC key is `HIGHFIVE_API_KEY` itself
([`auth.ts`'s `getApiKey`](../../backend/src/auth.ts)), so **rotating the
secret invalidates every outstanding session** and there is no separate
`SESSION_SECRET` to manage. The signature is verified constant-time before
the payload is trusted.

**Cookie attributes** ([`session.ts`'s `sessionCookieOptions`](../../backend/src/session.ts)):
`HttpOnly` (JS cannot read it), `SameSite=Lax`, `Path=/`, `Secure` **only**
under `isProduction()`. `SameSite=Lax` is sufficient even though the homepage
(`highfive.schutera.com`) and API (`api.highfive.schutera.com`) are different
origins, because they share the registrable domain `schutera.com` — the
request is _same-site_, so a Lax cookie rides along. `Secure` is off in dev/CI
because localhost serves over plain http, where a `Secure` cookie is silently
dropped.

**CORS.** `credentials: true` plus an explicit allowed origin (never `*`,
which browsers reject for credentialed requests):
`https://highfive.schutera.com` in prod, the reflected request origin
(`origin: true`) in dev. The homepage client sends `credentials: 'include'`
on every request so the cookie flows. See
[`backend/src/app.ts`'s `corsOptions`](../../backend/src/app.ts).
There is no middle state: anything `isProduction()` treats as production
(including `staging`/`qa`) is pinned to the one prod origin, so a staging host
on a different domain would have its cookie CORS-blocked — add an explicit
allowlist if staging becomes real (ADR-019 "Consequences").

## Admin gate (`requireAdmin`)

[`backend/src/session.ts`'s `requireAdmin`](../../backend/src/session.ts)
gates the write/admin routes. It passes when **either**:

- a valid `hf_admin_session` cookie is present, **or**
- an `X-Admin-Key: <HIGHFIVE_API_KEY>` header is present (the machine
  credential for operator scripts / CI — never shipped to the browser).

Otherwise it returns `401`. Applied to: `DELETE /api/modules/:id`,
`DELETE /api/images/:filename`, `PATCH /api/modules/:id/name`,
`POST /api/modules/:id/measurements`, `POST /api/admin/weather/backfill`,
and `GET /api/modules/:id/logs`. Both credential checks route through the
constant-time [`verifyApiKey`](../../backend/src/auth.ts) (header) or the
constant-time signature compare (cookie). Unit tests in
[`backend/tests/auth-verify-key.test.ts`](../../backend/tests/auth-verify-key.test.ts)
and [`backend/tests/session.test.ts`](../../backend/tests/session.test.ts)
pin the compare and gate contracts.

The asymmetric machine header (`X-Admin-Key` vs. the old `X-API-Key`)
descends from [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md);
ADR-019 supersedes that ADR's _browser_ half (the homepage no longer holds
the key) while keeping its single-secret server-side model for the machine
credential.

**Homepage admin UI.** `/admin`'s `AdminPage` checks `api.checkSession()` on
mount and renders its `LoginGate` (which calls `api.login()`) when no session
exists. On the dashboard, `?admin=1` reveals the per-module telemetry
affordance, but the actual `/logs` fetch is gated server-side by the cookie;
`AdminKeyForm` now logs in via `api.login()` rather than stashing a key in
`sessionStorage`.

Since [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md) the ESP32-CAM firmware speaks verified TLS (CA-pinned to ISRG Root X1) to `highfive.schutera.com`. **Per-module migration is gated on the OTA cycle that delivers post-#79 firmware** — pre-`mason` modules in the field continue to POST in clear-text against nginx's still-listening port-80 vhost until they pick up the new firmware on their next daily reboot. The migration is opt-out only via firmware revision; the server-side closure of the legacy HTTP `location` blocks is a future cleanup once telemetry shows the fleet has rotated.

## Third-party API keys: Geolocation

`getGeolocation` in `ESP32-CAM/esp_init.cpp` calls Google's
[Geolocation API v1](https://developers.google.com/maps/documentation/geolocation/overview)
to translate the nearby WiFi-AP fingerprint into a coarse
(latitude, longitude, accuracy) triple at first-boot, so the
admin dashboard can place a fresh module on the map without the
operator typing coordinates. The API key is **not a HiveHive
secret**; it is a Google Cloud Console key tied to a specific
project's billing account.

**The call runs roughly once per nest, not once per boot (#148 Phase 3).** A
nest rarely moves, and the geolocation path is a heap-hungry TLS handshake
that re-ran on every boot — a standing contributor to the `longhorn` heap
leak. So the first plausible fix is cached in NVS (namespace `geo`, via
`saveCachedGeolocation`) and `setup()` loads it through `loadCachedGeolocation`
to skip the Google call on most boots. The (0,0) sentinel is never cached, so
a first-ever boot still does the live lookup.

Caching forever would remove the pre-change self-healing property (every boot
used to re-resolve location). To keep a **relocated** module from reporting
stale coordinates indefinitely — duckdb-service only patches a fix _from_
(0,0), so the heartbeat recovery path cannot correct a stale non-(0,0) cache —
the cache carries a **boot-count TTL** (`kGeoCacheMaxBoots`, currently 14): the
fix is re-resolved roughly every 14 boots (~2 weeks given the 24 h daily
reboot), so a relocated-and-power-cycled module self-corrects automatically
within that window without a reflash. A full reflash (`eraseAll`) also wipes
NVS and forces immediate re-resolution.

**Key never lives in source.** The literal previously sat at the
top of `getGeolocation`'s body and ended up public on GitHub
([issue #18](https://github.com/schutera/highfive/issues/18)).
It has since been revoked and re-issued; the new key enters the
binary at build time only.

**Injection mechanism** — two paths, same macro:

| Builder       | How                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| PlatformIO    | `ESP32-CAM/extra_scripts.py`'s pre-build hook appends `-DGEO_API_KEY="<value>"` to `CPPDEFINES`.                         |
| `arduino-cli` | `ESP32-CAM/build.sh` appends `-DGEO_API_KEY="<value>"` to the `--build-property build.extra_flags=...` string.           |
| Arduino IDE   | No injection. The firmware's `#ifndef GEO_API_KEY` fallback defines an empty string and `getGeolocation` skips the call. |

**Source-of-truth order** (both builders agree):

1. `GEO_API_KEY` environment variable — used by CI / production
   builds.
2. `ESP32-CAM/GEO_API_KEY` file — single-line key, trimmed.
   Listed in the repo root `.gitignore` next to `secrets.h`.
3. Empty string — runtime guard in `getGeolocation` prints
   `getGeolocation: GEO_API_KEY not set at build time — skipping
geolocation lookup.` and returns before the HTTPS call. No
   broken request to Google, no false "geolocation OK" telemetry.

**First-boot side effect when no key is set.** `esp_init.cpp`'s
`loadConfig` initialises `esp_config->geolocation` to
`{latitude: 0.0f, longitude: 0.0f, accuracy: 0.0f}`. If
`getGeolocation` skips its lookup, those zeros remain and ship
to the backend on the first heartbeat. The `homepage` map view
filters the `(0, 0)` Null Island sentinel client-side, so the
module plots nowhere — it never appears on the dashboard map
until an operator manually corrects the location. A release build
without `GEO_API_KEY` therefore produces invisible modules.

**`build.sh` hard-requires the key for release builds.** Because
`build.sh` is the path that produces the web-installer `firmware.bin`
an operator actually flashes, a missing `GEO_API_KEY` is now **fatal**
there: the script prints a self-describing `ERROR:` on `stderr` and
exits non-zero rather than emitting a binary that would ship
`(0, 0, 0)` modules. The escape hatch is `HF_ALLOW_NO_GEO_KEY=1`,
which downgrades the failure to a `WARNING:` and builds a keyless
binary on purpose — intended only for a CI compile check that is never
flashed. The `pio run -e esp32cam` smoke env stays keyless without the
flag, because it is a compile-only gate (not a release path): its
firmware's runtime guard skips the Google call and the binary is never
flashed to a real device. Do not suppress the `build.sh` error for any
build that will reach an operator.

Only the **length** of the key is logged at build time
(`[extra_scripts] GEO_API_KEY len=<N>`); the value never appears
in build output. `build.sh` deliberately does not add a
post-compile `grep` for `GEO_API_KEY` in the binary (the
`FIRMWARE_VERSION` post-compile guard does grep, but the version
string is safe to echo in logs — the API key is not).

**GitHub Actions integration.** The `esp-firmware` job in
`.github/workflows/tests.yml` consumes a repository secret named
`GEO_API_KEY` and exposes it to `pio run -e esp32cam` as the
`GEO_API_KEY` env var, where `extra_scripts.py` picks it up
exactly as in a local build. The workflow's `on:` block fires on
`push: [main, production, 'chore/test-harness']` and
`pull_request: [main]` — no other event triggers it today, so the
matrix is:

| Trigger                                                    | Secret available? | Pre-build guard | Build behaviour                                                                                                                                             |
| ---------------------------------------------------------- | ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push` to `main`                                           | required          | **enforced**    | Hard-fail with `::error::` annotation if the secret is missing. Catches "secret accidentally deleted" before a release artefact ships broken.               |
| `push` to `production`                                     | required          | **enforced**    | Same hard-fail as `main`, and it matters more: `production` is the branch firmware OTA ships from, so a missing secret here would publish Null-Island firmware to the fleet. Added with the `repo-guards` job (#210) because `scripts/deploy.sh` pushes to this branch from the live host with `HUSKY=0`, bypassing every pre-push guard. |
| `push` to `chore/test-harness`                             | yes               | skipped         | Real key baked in. Lets the CI gate self-test before being merged to `main`.                                                                                |
| `pull_request` to `main` from same-repo branch             | yes               | skipped         | Real key baked in.                                                                                                                                          |
| `pull_request` to `main` from a fork                       | no (by GitHub)    | skipped         | Build proceeds with empty key; the firmware's runtime guard skips the Google call. Fork PRs cannot be regression-tested against geolocation.                |
| Push to any other branch / `workflow_dispatch` / scheduled | n/a               | n/a             | Workflow doesn't fire at all today. If a `workflow_dispatch` trigger is ever added, revisit the guard's `if:` so manual runs against `main` stay protected. |

To store or rotate the secret:

```bash
gh secret set GEO_API_KEY --repo schutera/highfive
# or via the web UI:
# https://github.com/schutera/highfive/settings/secrets/actions
```

**Rotation procedure** (operator-side). Most security-rotation
playbooks recommend create-new → roll-out → revoke-old to avoid a
quota-less window. Here we revoke first because in-field modules
tolerate a revoked key gracefully (see step 4 below) and it forecloses
the worst case (a leaked key remaining usable while a calmer rotation
is being staged):

1. Revoke the current key in Google Cloud Console
   (`APIs & Services → Credentials`).
2. Create a new key, restricted to **Geolocation API** only.
   Restrict by HTTP referrer / Android / iOS fingerprint where
   feasible.
3. Update every build host that produces release firmware:
   - **GitHub Actions:** `gh secret set GEO_API_KEY --repo schutera/highfive`
     (replaces the previous secret).
   - **Local release builds:** write the new key into
     `ESP32-CAM/GEO_API_KEY` (gitignored) or `export GEO_API_KEY=...`
     in your shell profile.
4. Rebuild firmware and USB-flash deployed modules (OTA is
   tracked in
   [issue #26](https://github.com/schutera/highfive/issues/26)
   and not implemented today). Until then, in-field modules
   continue to hit Google with the now-revoked key — `getGeolocation`
   will log the non-2xx response, but heartbeats, uploads, and the
   map view are unaffected (the saved geolocation from first boot
   persists in module config).

## Third-party credentials: Discord webhook

Both Python services can post operator alerts to Discord —
`duckdb-service/services/discord.py` (module registration, first
image, silence-watcher module-down alerts per ADR-005) and
`image-service/services/discord.py` (its own copy of the notifier).
A Discord webhook URL is a **bearer credential**: anyone holding it
can post arbitrary messages to the channel, so it is handled like a
secret even though it grants no read access.

- **Source of the value:** the `DISCORD_WEBHOOK_URL` env var only,
  wired through `docker-compose.yml` / `docker-compose.prod.yml`
  (optional — empty or unset disables sending; both `send_discord_*`
  helpers skip cleanly and log the skip).
- **Never in source.** A live webhook URL was committed as the
  in-source default of both notifier modules and rotated in the
  2026-07 audit (issue #201; lesson recorded in
  [chapter 11 → "Hardcoded secrets"](../11-risks-and-technical-debt/README.md#hardcoded-secrets)).
  `scripts/check-no-hardcoded-api-keys.sh` (pre-push) now fails on
  any `discord.com/api/webhooks/<id>` literal.
- **Rotation:** Discord → Server Settings → Integrations → Webhooks →
  delete + recreate, then update the env value on the host. Rotation
  is the only real mitigation for a leak — git history keeps the old
  literal forever.

## Server logs: secrets must never be logged (ADR-023)

The admin **Server Logs** panel tails each service's own log ring
(`GET /api/admin/logs`, `requireAdmin`). As of [ADR-023](../09-architecture-decisions/adr-023-persistent-structured-server-logs.md)
that ring is **persisted to disk** (JSONL, 30 days / 100 MB, gated on `LOG_DIR`) and
backfilled on restart — so anything printed to stdout no longer just flashes past in
`docker logs`, it lands on disk for up to a month. That makes "never print secrets"
load-bearing, not advisory. Three controls keep credentials out of the ring:

- **Access logs are path-only.** The per-request access entry is `method path status ms`
  using the request **path only** — never headers, body, or query string — so the
  `X-Admin-Key` header, the `POST /api/admin/login` body password, and any `?token=`/`?key=`
  query value cannot reach the ring. (`accessLog.ts`; Flask `@app.after_request`.)
- **The dev admin-key banner bypasses the ring.** `server.ts` prints the dev key via the
  ring-bypassing `writeStdout`, so it reaches the terminal as a developer convenience but is
  not captured into the ring/disk — and the whole block is suppressed in production by
  `auth.ts`'s boot guards (see [The secret](#the-secret)).
- **The endpoint stays admin-only.** The ring may still capture whatever other code prints,
  so the gate is the backstop — and the reason not to `console.log`/`print` secrets anywhere.

## Why one secret, two header names

See [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md).
The short version: a separate admin secret in dev means another env
var to forget. Reusing the same key under a different header name
keeps onboarding to one secret while preserving the gating semantics.

## What is NOT authenticated

- `GET /api/health` — public liveness check.
- **All read endpoints** — `GET /api/modules`, `GET /api/modules/:id`,
  `GET /api/images` (list) and `GET /api/images/:filename` (bytes),
  `GET /api/modules/:id/activity`, `.../measurements`, and
  `GET /api/user-location`. These feed the public dashboard/map and are
  intentionally credential-free (#142). Module coordinates in these responses
  are **generalized to ~1 km (2 dp) for every caller, admin included** — a
  privacy control for nest sites (ADR-020 / #145). The exact fix is never
  served and (after duckdb round-on-write) never persisted, so making these
  reads public does not expose precise locations.
- `image-service /upload` — accepts uploads from any client that
  knows the URL. Authentication for ESP modules is "you must be on
  the LAN" (the module's upload URL is the host's LAN IP in a dev
  build, or the production origin otherwise). Not
  defence-in-depth; a compromised LAN device can spoof uploads.
  Acceptable for the current threat model (single-tenant, hobbyist
  deployment); revisit if multi-tenancy is added. Since the 2026-07
  audit (for #203) the endpoint carries two bounds: a 5 MB
  request-size ceiling (`MAX_CONTENT_LENGTH`, env-overridable via
  `MAX_UPLOAD_BYTES`) and a **per-module** rate guard
  (`services/upload_throttle.py`, default 30/hour via
  `UPLOAD_THROTTLE_PER_HOUR`, 0 disables). Over-budget uploads are
  **accepted and discarded with a 200**, never a 429 — a non-2xx
  counts toward the firmware's upload-failure circuit breaker and
  would reboot a storming module, amplifying the storm.

  **Since the 2026-08 audit (for #228), two more bounds apply before
  anything is saved or decoded:** the bytes must parse as a JPEG
  (`services/image_guard.py::probe_jpeg` — a magic-byte + header check,
  not a full decode) and the SOF-declared frame must not exceed
  `MAX_IMAGE_DIM` (default 4096px on the long edge, env-overridable). A
  failure on either returns `400` with nothing written to disk. The
  stored filename's extension is now always forced to `.jpg`
  (`services/paths.py::sanitize_upload_filename`) regardless of what the
  client sent, and `GET /images/<name>` / `GET /snips/<name>`
  (image-service) refuse any non-`.jpg` name and pin
  `Content-Type: image/jpeg` rather than guessing it from the extension.
  **Precisely what the backend's `/api/images`/`/api/snips` proxies add
  on top, and what they don't:** they independently hard-set
  `Content-Type: image/jpeg` (belt-and-braces — see `backend/src/app.ts`),
  but they do **not** re-check the filename extension themselves; a
  non-`.jpg` request still ends up `404` because image-service's own
  route already refuses it and the proxy forwards that status verbatim,
  not because the backend enforces the extension a second time. One
  consequence worth stating explicitly: **the `.log.json` telemetry
  sidecars are no longer reachable through the image route at all**
  (they never matched `.jpg` even before the fix, but now the route
  enforces that instead of relying on the extension allowlist happening
  not to produce a collision) — the intended path to a sidecar's
  contents is `GET /modules/:id/logs`, but that image-service route
  itself carries **no credential check** (unlike its sibling `/logs` and
  `/logs/stream`, which do check `X-Admin-Key`) — the gate is one hop up,
  the backend's `requireAdmin` on `GET /api/modules/:id/logs`. Prod binds
  image-service to `127.0.0.1:8000` and nginx proxies only `/upload`
  there, so this is not internet-reachable in prod; dev publishes the
  port more broadly (same "treat a running dev stack as trusted-LAN-only"
  caveat as the duckdb-service routes below).

  **Be precise about what that bounds.** The rate guard keys on the
  client-supplied MAC, which is canonicalized but not authenticated, so
  it bounds a **runaway or looping module** — the threat it was written
  for — and not a hostile client, which can rotate MACs for a fresh
  budget each time. The `_MAX_TRACKED` cap bounds the tracking dict,
  not the writes. So `/upload` is _rate-bounded per claimed identity_,
  not rate-bounded per caller. Closing that would need a budget keyed
  on something a client cannot mint, and an IP-keyed one must be sized
  for a whole site behind a single NAT egress — every module at a
  location shares an address, so a naive per-IP cap throttles
  legitimate ingestion. Tracked in
  [#224](https://github.com/schutera/highfive/issues/224).
- All `duckdb-service` routes — unauthenticated by design, on the
  assumption that only in-bridge callers reach them. **That assumption
  does NOT hold for `/new_module` and `/heartbeat`** — host-nginx
  proxies exactly those two paths to the internet in production
  (`production-deployment.md`), credential-free, so anyone who knows or
  enumerates a 12-hex module id via the public `GET /modules` can call
  them. Every other `duckdb-service` route stays genuinely
  bridge-internal (loopback-bound in prod; see below for dev).

  **Since the 2026-08 audit (for #229), both internet-exposed routes are
  hardened at the handler level** (this bounds the write, not the read —
  neither route requires a credential):
  - `POST /new_module` (`routes/modules.py::add_module`) — a
    re-registration of an **existing** module id no longer overwrites
    `name`/`email`/`lat`/`lng` from the incoming payload. `name`/`email`
    are kept unless the stored value is NULL/empty. `lat`/`lng` cannot be
    SQL NULL (schema: `NOT NULL`), so their "unset" state is the `(0,0)`
    sentinel instead: the incoming fix is written **only when the
    stored row is at `(0,0)`** — gated on the stored value, not the
    incoming one, mirroring `post_heartbeat`'s "only patch from a stored
    (0,0)" rule below. An anonymous re-POST with different real
    coordinates can no longer relocate an already-placed module — a
    first-pass version of this fix inverted the condition and still
    allowed exactly that (caught by senior-review, verified end-to-end
    before landing: one POST moved a module from Germany to Sydney).

    **The only supported relocation (or rename) path today is
    `DELETE /modules/<id>` + re-register — and it is destructive, not a
    lightweight edit** (senior-review round 2 caught an earlier draft of
    this note understating that — "same as a `name` change" was wrong;
    a `name` change has no non-destructive path either, but conflating
    the two undersold what DELETE actually costs). `DELETE` is
    admin-gated (the backend's `requireAdmin` on `DELETE
    /api/modules/:id`, unlike the anonymous `/new_module` POST it
    replaces the effect of), which is the right privilege level — but
    `routes/modules.py::delete_module` wipes `daily_progress`,
    `nest_data`, `image_uploads`, `module_heartbeats`, and
    `measurements` for that module id, not just `module_configs`. A
    relocated module starts its whole observation history over from
    zero; the JPEGs already on disk are orphaned (the DB rows pointing
    at them are gone, the files are not). There is no non-destructive
    way to edit a module's `name`, `email`, or location today — adding
    admin-gated `PATCH` endpoints for those fields (mirroring the
    existing `PATCH /modules/<id>/display_name`) is a reasonable
    follow-up, deliberately not built in this PR — tracked in the
    CLAUDE.md priority queue.

    **Residual gap, by design, not closed here:** `battery_level`,
    `updated_at`, and `last_seen_at` still bump on **every** call
    regardless of whether any protected field changed — this is
    liveness metadata, not identity, and issue #229's own spec (plus the
    #97 invariant that `add_module` is the sole writer of
    `last_seen_at`) requires it. The consequence: an anonymous caller
    who knows or enumerates a module id can still make a dead module
    report as freshly alive (resurrecting `last_seen_at`) and change its
    reported `battery_level`, even though it can no longer move or
    rename it. [ADR-032](../09-architecture-decisions/adr-032-device-identity-for-ingest.md)'s
    device-identity follow-up is the intended closure for this, not a
    handler-level change.

    **Second residual gap the fix itself introduces (round-3
    senior-review): first registration wins, permanently.** Freezing
    `name`/`email`/location on re-registration protects a *placed*
    module — but it also means whoever registers a given MAC **first**
    owns those fields until an admin intervenes. An attacker who
    front-runs a real module's first-ever registration (guessing or
    observing its MAC before the operator powers it on — module ids are
    12-hex MACs, not secrets) could register it at false coordinates or
    with a false name; when the real module then boots and registers
    with its true values, the CASE sees an **existing** (non-`(0,0)`,
    non-empty) row and preserves the attacker's fake data instead.
    Pre-#229 the real module's own next boot would have silently
    corrected this (any non-`(0,0)` incoming value overwrote the row);
    post-#229 nothing does — the only recovery is an admin
    `DELETE /modules/<id>` + re-register. This is a real trust-on-first-use
    trade-off, not a bug: it is the necessary consequence of closing the
    "anyone can overwrite a placed module" hole this PR exists to close,
    and the attack requires guessing an unregistered MAC in advance
    (`GET /modules` only lists already-registered ones). Lower severity
    than the pre-fix hole, not zero.

    The Discord "new module" webhook now fires only on the
    row's first insert, not on every re-POST. The pre-validation
    `print(f"... Received: {json_data}")` — which put the raw body,
    including `email`, into the admin-readable log ring — is gone; the
    replacement line logs only the canonical id, stored name, and
    already-coarsened lat/lng.
  - `POST /heartbeat` (`routes/heartbeats.py::post_heartbeat`) — a MAC
    with no `module_configs` row is dropped (still `200`, nothing
    written to `module_heartbeats`/`measurements`) instead of growing
    those tables and spoofing liveness for a module that was never
    registered. `battery` is clamped to `[0, 100]` rather than stored
    unbounded. The log line no longer prints raw `latitude`/`longitude`
    (it did, pre-fix, **before** `coarsen_coord` ran) — only a
    `geo_present` boolean.
  - **nginx-level rate/body limits** are documented (not yet deployed —
    see below) in
    [`deploy/nginx/highfive-ingest.conf`](../../deploy/nginx/highfive-ingest.conf).
  - Longer-term: [ADR-032](../09-architecture-decisions/adr-032-device-identity-for-ingest.md)
    proposes an actual device credential (a compiled-in fleet key or
    per-device keys) for these two routes; the ADR is Proposed, the code
    is deliberately a separate follow-up.

  **Dev vs. prod bind topology stays as before** (unaffected by the
  handler hardening above — a credential-free write is still a
  credential-free write, just a bounded one):
  - **Prod** (`docker-compose.prod.yml`) binds the host mapping to
    `127.0.0.1:8002`. Host-Nginx proxies exactly the two paths the
    fleet needs (`/new_module`, `/heartbeat`); nothing else is
    reachable off-box.
  - **Dev** (`docker-compose.yml`) publishes `8002` on all interfaces,
    because there is no Nginx in the dev stack and the LAN-dev firmware
    posts registration and heartbeat straight at
    `http://<DEV_SERVER_HOST>:8002` (baked by
    `ESP32-CAM/extra_scripts.py`). A loopback bind there leaves a
    module with no route in at all. The 2026-07 audit (#203) briefly
    matched dev to prod and broke exactly that.

  So **treat a running dev stack as trusted-LAN-only** — it serves
  `DELETE /modules/:id` and friends to anyone on the same network. On
  an untrusted network, drop the `8002` port mapping and accept that no
  ESP can register while it is gone. See
  [docker-compose.md → Startup ordering](../07-deployment-view/docker-compose.md).

## Captive-portal credential handling

The ESP32-CAM captive portal (`ESP32-CAM/host.cpp`'s `sendConfigForm`)
is served from a WiFi AP whose WPA2 PSK is hardcoded in firmware
(`HOST_PASSWORD` at `host.cpp`'s top-of-file constants, passed into
the `WiFi.softAP` call in `setupAccessPoint`). The PSK is committed to
source and reproduced in onboarding docs, so the threat model is
"anyone with knowledge of the hardcoded PSK" — not an open network,
but not far from one either: anyone who has read the codebase, the
wiki, or guessed the default can join. The form is therefore a
hostile rendering surface for any secret it has previously stored.

- **WiFi password is never echoed back into the form.** The
  `<input type="password">` field renders with `value=""` and a
  placeholder hint. When a password is already saved, the field is
  tagged `data-keep-current-on-empty="1"` so client-side
  `validateForm` permits empty submission, and the `/save` handler
  mirrors the contract by assigning `cfg_password` only when the
  submitted value is non-empty. Submitting a non-empty value
  overwrites. Fixed in issue #46 — previously the saved credential
  was visible via View Source, and an earlier draft of the fix
  shipped with a client-side validator that blocked the "keep
  current" path so the placeholder promised a feature unreachable
  through the UI (caught in PR-47 hardware testing — see chapter 11
  lessons learned).
- **The form cannot CLEAR the saved password — only overwrite or
  preserve.** Today there is no UI affordance for "I want this
  device to have no saved WiFi credential." Operators moving between
  an open WiFi and a WPA2 home network would need a factory-reset
  trigger that wipes SPIFFS (the in-firmware long-press path is
  unreliable on standard ESP32-CAM hardware — see issue #56). Worth
  filing as a separate UX issue if hobbyist deployment hits it.
- **`Serial.println` of the saved password was redacted in #41.**
  Earlier versions printed the credential to USB serial during boot.
- **`HOST_PASSWORD` is invisible to the hardcoded-secret guard by
  construction, not oversight — and that's worth understanding, not
  just noting.** `scripts/check-no-hardcoded-api-keys.sh` gained a
  pattern in #227 for a *call-shaped* leak: a literal SSID or
  passphrase passed directly into `WiFi.begin(...)`, the #227 incident
  itself. `HOST_PASSWORD` is a *value-assignment* leak — a literal
  bound to a named constant (`const char *HOST_PASSWORD = "esp-12345";`
  at `host.cpp`'s top-of-file constants) and only later passed by
  identifier into `WiFi.softAP(HOST_SSID, HOST_PASSWORD, 1, 0)`. A
  call-shaped guard cannot see through the indirection to catch that.
  It is intentionally committed and documented here, not a leak to
  catch — but if this file is ever restructured to inline the PSK
  directly into the `WiFi.softAP` call, the guard would need a fourth,
  value-assignment-shaped pattern to notice.

The `data-keep-current-on-empty` attribute is intentionally narrow:
it pairs a JS validator skip with a server-side conditional
assignment, and today only the password field has both halves wired
up. If a future field needs the same "blank means keep current"
semantics (an API key, an OAuth token), copying just the HTML
attribute is not enough — the `/save` handler at
`ESP32-CAM/host.cpp`'s `runAccessPoint` must also gain a matching
`submitted.trim(); if (submitted.length() > 0) cfg_X = submitted;`
branch (the trim guards against whitespace-only submissions from
non-browser clients), or the empty submission will silently wipe the
saved value. Module name and the
init/upload URL fields are not secrets and use the conventional
pre-fill pattern; do not add `data-keep-current-on-empty` to them
without first wiring the server-side mirror.
