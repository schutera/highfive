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
`window.prompt()` and stored in `sessionStorage['hf_admin_key']` —
never persisted in code.

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
