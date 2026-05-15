# ADR-003: `HIGHFIVE_API_KEY` reused for both API key and admin key

## Status

Accepted (commit `a094792`).

## Context

HiveHive has two trust boundaries:

1. Frontend → backend, gated by an API key (`X-API-Key` header).
2. Admin telemetry endpoint (`/api/modules/:id/logs`), gated by an
   additional admin key (`X-Admin-Key` header) plus the `?admin=1`
   UI flag.

The original design used two separate environment variables — one
secret for the API key, one for the admin key. In dev, this meant
two env vars to remember. Operators who set up a new instance forgot
the admin one routinely; the admin telemetry section silently failed.

## Decision

`HIGHFIVE_API_KEY` is the single secret. The backend checks it
against both headers:

- `X-API-Key` for all `/api/modules*` routes (`backend/src/auth.ts`'s
  `apiKeyAuth`)
- `X-Admin-Key` for the admin telemetry endpoint (the inline check on
  `backend/src/app.ts`'s `GET /api/modules/:id/logs` handler)

Both checks share the
[`verifyApiKey`](../../backend/src/auth.ts) helper, which wraps
`crypto.timingSafeEqual` with a length-mismatch short-circuit. One
boundary, two header names.

The two header names are kept distinct so that:

- A leaked frontend key (in a network trace, a screenshot) doesn't
  accidentally reveal that the same value works for admin operations.
  The header name signals intent.
- A future split into two secrets is a code change in one place
  (the admin-key check); no protocol change required.

The dev fallback is `hf_dev_key_2026` (defined in
[`backend/src/auth.ts`'s `DEV_FALLBACK_KEY`](../../backend/src/auth.ts);
a startup guard in the same file refuses to boot when the env var would
fall back to it under production-mode `NODE_ENV` — see
[chapter 8 → "The secret"](../08-crosscutting-concepts/auth.md#the-secret)).

## Consequences

**Positive**:

- One env var to set in dev. One secret to rotate in production.
- Simpler deploy story.

**Negative**:

- A leak of the API key is also a leak of admin access. Acceptable
  for the current single-tenant threat model; revisit if multi-tenant.
- Both gates share the
  [`verifyApiKey`](../../backend/src/auth.ts) boundary in
  `backend/src/auth.ts`, so changes to the compare semantics propagate
  to both by construction. Earlier wording flagged the admin-key check
  as a one-liner easy to miss in audit; the shared-helper refactor
  closes that audit-surface.

**Forbidden**:

- **Do not** reintroduce a parallel admin secret env var (e.g.
  `HIGHFIVE_ADMIN_KEY`). If admin access needs to be separable, do
  it as a follow-up that splits the value cleanly — not as a
  parallel env var that nobody sets in dev.
