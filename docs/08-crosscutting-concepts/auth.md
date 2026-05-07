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
is served from an open WiFi AP — there is no PSK, anyone in RF range
can join. The form is therefore a hostile rendering surface for any
secret it has previously stored.

- **WiFi password is never echoed back into the form.** The
  `<input type="password">` field renders with `value=""` and a
  placeholder hint. Submitting the form with the password field
  blank means "keep the current password"; submitting a non-empty
  value overwrites it. Fixed in issue #46 — previously the saved
  credential was visible via View Source.
- **`Serial.println` of the saved password was redacted in #41.**
  Earlier versions printed the credential to USB serial during boot.

Today only the WiFi password is rendered with this empty-by-default
pattern; module name and the init/upload URL fields still pre-fill,
since they are not secrets in the current threat model. If a future
config field stores another secret (API key, OAuth token, an upload
URL whose query string carries credentials), apply the same pattern:
render with `value=""` and a "keep current" hint; only overwrite on
non-empty submission.
