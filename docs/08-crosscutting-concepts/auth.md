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
`hf_dev_key_2026` (defined in `backend/src/auth.ts:4` and
`homepage/src/services/`). This must be overridden for any non-local
deploy.

The frontend reads the key from `VITE_API_KEY` at build time.

## API-key middleware

Defined in [`backend/src/auth.ts`](../../backend/src/auth.ts).

Accepted in any of these forms:

- `X-API-Key: <key>` (preferred)
- `Authorization: Bearer <key>`
- `?api_key=<key>` (not recommended; for testing only)

Applied to all `/api/modules*` routes.

## Admin gate

Defined inline in [`backend/src/app.ts`](../../backend/src/app.ts)
around line 50. Layered on top of the API-key middleware:

- Requires header `X-Admin-Key: <same-key-as-HIGHFIVE_API_KEY>`.
- Applied to `GET /api/modules/:id/logs` (telemetry proxy).

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
exactly as in a local build. Three behaviours, one workflow:

| Trigger                                               | Secret available? | Behaviour                                                                                                                                                 |
| ----------------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push` to `main`                                      | required          | A pre-build guard step fails the job loudly if the secret is missing. This catches "secret accidentally deleted" before a release artefact ships broken.  |
| `push` to other branches / `pull_request` (same repo) | yes               | Build proceeds with the real key baked in; pre-build guard is skipped.                                                                                    |
| `pull_request` from a fork                            | no (by GitHub)    | Build proceeds with empty key; the firmware's runtime guard skips the Google call. Fork PRs cannot be regression-tested against geolocation; that's fine. |

To store or rotate the secret:

```bash
gh secret set GEO_API_KEY --repo schutera/highfive
# or via the web UI:
# https://github.com/schutera/highfive/settings/secrets/actions
```

**Rotation procedure** (operator-side):

1. Revoke the current key in Google Cloud Console
   (`APIs & Services → Credentials`).
2. Create a new key, restricted to **Geolocation API** only.
   Restrict by HTTP referrer / Android-iOS fingerprint where
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
