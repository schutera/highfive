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
`if (submitted.length() > 0) cfg_X = submitted;` branch, or the empty
submission will silently wipe the saved value. Module name and the
init/upload URL fields are not secrets and use the conventional
pre-fill pattern; do not add `data-keep-current-on-empty` to them
without first wiring the server-side mirror.
