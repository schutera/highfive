# Authentication and authorisation

HiveHive has two trust boundaries:

1. **Frontend ↔ backend** — gated by an API key.
2. **Admin endpoints (telemetry inspection)** — additionally gated by
   an admin key, which is the **same secret** under a different header
   name (see [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md)).

There is no per-user identity. There is no OAuth. The whole stack
runs against one shared secret.

## The secret

`HIGHFIVE_API_KEY` (env var). The dev-mode fallback is
`hf_dev_key_2026`, defined in
[`backend/src/auth.ts`'s `DEV_FALLBACK_KEY`](../../backend/src/auth.ts)
and surfaced for the homepage via `VITE_API_KEY`. The fallback is a
public string by design — it's documented here, in `CLAUDE.md`, and in
the backend test suite — so it is safe only for local development.

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

The frontend reads the key from `VITE_API_KEY` at build time. The mirror
guard lives in
[`homepage/src/services/api.ts`'s `validateBuildTimeApiKey`](../../homepage/src/services/api.ts):
a production bundle (Vite's `import.meta.env.PROD === true`) refuses to
boot when `VITE_API_KEY` is unset OR (case-insensitively, with
whitespace tolerance) the literal `hf_dev_key_2026`. Tests in
[`homepage/src/__tests__/api-key-validator.test.ts`](../../homepage/src/__tests__/api-key-validator.test.ts)
pin the truth table the same way the backend guard's tests do. The
asymmetry of "build-time vs. module-load-time" is intrinsic to Vite —
the key is inlined into the bundle at build, so a bad value can't be
caught later at runtime; the validator runs once at first import and
fast-crashes the bundle.

## API-key middleware

Defined in [`backend/src/auth.ts`](../../backend/src/auth.ts).

Accepted in any of these forms:

- `X-API-Key: <key>` (preferred)
- `Authorization: Bearer <key>`
- `?api_key=<key>` (not recommended; for testing only)

Applied to all `/api/modules*` routes.

The secret-compare is constant-time:
[`backend/src/auth.ts`'s `verifyApiKey`](../../backend/src/auth.ts) wraps
`crypto.timingSafeEqual` via a private `constantTimeEqual` helper, with
a length-mismatch short-circuit that returns `false` before
`timingSafeEqual` (which throws on length mismatch). `verifyApiKey` is
the **single exported boundary** for the secret-compare — both the
middleware here and the admin gate in `app.ts` (below) route through it,
so changes to the compare semantics propagate to both gates by
construction. Unit tests in
[`backend/tests/auth-verify-key.test.ts`](../../backend/tests/auth-verify-key.test.ts)
pin the match / mismatch / length-short-circuit / empty-string contract.

Since [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md) the ESP32-CAM firmware speaks verified TLS (CA-pinned to ISRG Root X1) to `highfive.schutera.com`. **Per-module migration is gated on the OTA cycle that delivers post-#79 firmware** — pre-`mason` modules in the field continue to POST in clear-text against nginx's still-listening port-80 vhost until they pick up the new firmware on their next daily reboot. The migration is opt-out only via firmware revision; the server-side closure of the legacy HTTP `location` blocks is a future cleanup once telemetry shows the fleet has rotated. The shared-secret authorization model is otherwise unchanged.

## Admin gate

Defined inline in [`backend/src/app.ts`](../../backend/src/app.ts)
on the `GET /api/modules/:id/logs` handler. Layered on top of the
API-key middleware:

- Requires header `X-Admin-Key: <same-key-as-HIGHFIVE_API_KEY>`.
- Applied to `GET /api/modules/:id/logs` (telemetry proxy).
- Uses the same constant-time `verifyApiKey()` helper as the API-key
  middleware above — one boundary, two header names. The asymmetric
  header (`X-Admin-Key` vs. `X-API-Key`) is intentional (see
  [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md)).

The admin UI is gated by `?admin=1` in the URL, stored in
`sessionStorage['hf_admin']`. The admin key itself is collected via
the inline `AdminKeyForm` React component (replaced the legacy
`window.prompt()` flow in PR 17 commit `5b110de`) and stored in
`sessionStorage['hf_admin_key']` — never persisted in code.

The same admin gate protects the `/admin` route in the homepage
(`AdminPage` — telemetry table with the per-module
[`HeartbeatSnapshot`](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md),
the image inspector, and the Discord webhook test surface).

## Third-party API keys: Geolocation

`getGeolocation` in `ESP32-CAM/esp_init.cpp` calls Google's
[Geolocation API v1](https://developers.google.com/maps/documentation/geolocation/overview)
to translate the nearby WiFi-AP fingerprint into a coarse
(latitude, longitude, accuracy) triple at first-boot, so the
admin dashboard can place a fresh module on the map without the
operator typing coordinates. The API key is **not a HiveHive
secret**; it is a Google Cloud Console key tied to a specific
project's billing account.

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
has no `(0, 0)` special-case today, so the module plots at the
Null Island coordinate in the Gulf of Guinea until an operator
manually corrects the location. A release build without
`GEO_API_KEY` therefore produces map-broken modules. `build.sh`
prints `WARNING:` on `stderr` when the key is unset for this
reason — do not suppress it unless you have a `dev` / `test`
build that will never reach the dashboard.

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
`push: [main, 'chore/test-harness']` and `pull_request: [main]` —
no other event triggers it today, so the matrix is:

| Trigger                                                    | Secret available? | Pre-build guard | Build behaviour                                                                                                                                             |
| ---------------------------------------------------------- | ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push` to `main`                                           | required          | **enforced**    | Hard-fail with `::error::` annotation if the secret is missing. Catches "secret accidentally deleted" before a release artefact ships broken.               |
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

## Why one secret, two header names

See [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md).
The short version: a separate admin secret in dev means another env
var to forget. Reusing the same key under a different header name
keeps onboarding to one secret while preserving the gating semantics.

## What is NOT authenticated

- `GET /api/health` — public liveness check.
- `image-service /upload` — accepts uploads from any client that
  knows the URL. Authentication for ESP modules is "you must be on
  the LAN" (the Init/Upload base URL is the host's LAN IP). Not
  defence-in-depth; a compromised LAN device can spoof uploads.
  Acceptable for the current threat model (single-tenant, hobbyist
  deployment); revisit if multi-tenancy is added.
- All `duckdb-service` routes — assumed to be reachable only from
  inside the Docker `net` bridge. Don't expose this port to LAN.

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
