# ADR-019: Admin auth is a server-side session cookie; no secret in the bundle

## Status

Accepted ([#142](https://github.com/schutera/highfive/issues/142)). Partially
supersedes [ADR-003](adr-003-shared-api-key-for-admin.md) (the browser half).

## Context

Before this decision the homepage authenticated to the backend with
`HIGHFIVE_API_KEY`, surfaced to the build as `VITE_API_KEY`. Vite inlines
`import.meta.env.VITE_API_KEY` as a string literal, so the production secret was
recoverable by anyone from `https://highfive.schutera.com/assets/api-*.js`. With
it, an unauthenticated third party could read every module (incl. GPS) and image
**and** call the admin/delete routes — the whole API was effectively open.

Separately, the `/admin` login gate only did `fetch('/api/health', { headers: { 'X-API-Key': password } })`
and treated any `res.ok` as success. `/api/health` is public, so **any string**
logged in; the real calls used the baked key, not the typed password. The gate
authenticated nothing.

The root cause is structural: **a single-page app cannot hold a secret** —
anything bundled ships to every visitor. Rotating `VITE_API_KEY` would just
publish a new public key. Constraints: the dashboard and map are linked from the
public marketing site and must keep working for anonymous visitors; operator
scripts / CI already authenticate with a header and should not need a rewrite;
the homepage and API run on different origins (`highfive.schutera.com` ↔
`api.highfive.schutera.com`) that nonetheless share the registrable domain
`schutera.com`.

## Decision

Remove every secret from the browser bundle and split the API by trust level:

- **Reads are public** — the blanket `X-API-Key` gate is gone. The public
  dashboard already exposed this data, so the gate protected nothing.
- **Admin/write actions sit behind a real session.** `POST /api/admin/login`
  validates the password constant-time and sets an `HttpOnly`, `SameSite=Lax`,
  `Secure`-in-prod cookie whose value is a stateless HMAC-signed token
  (signed with `HIGHFIVE_API_KEY`, ~12 h TTL, rate-limited login). A
  `requireAdmin` middleware gates the write routes, accepting the cookie **or**
  an `X-Admin-Key` header (the server-side machine credential for scripts/CI,
  never shipped to the browser). `SameSite=Lax` suffices because the homepage→API
  request is same-site (shared `schutera.com`); CORS uses `credentials: true`
  with an explicit origin (never `*`). See
  [`backend/src/session.ts`](../../backend/src/session.ts) and
  [chapter 8 → "Admin session"](../08-crosscutting-concepts/auth.md#admin-session-cookie).

## Consequences

**Positive**:

- The acceptance criteria of #142 hold: the bundle contains no long-lived
  secret, `/admin` actually authenticates, admin routes require a credential not
  derivable from anything shipped to the browser, and rotating
  `HIGHFIVE_API_KEY` invalidates outstanding sessions for free (it is the HMAC
  key).
- Operator tooling keeps working unchanged via `X-Admin-Key`.

**Negative**:

- Read endpoints are now openly public, including module GPS at ~11 m precision.
  Generalising coordinates for unauthenticated callers was deferred to
  [#145](https://github.com/schutera/highfive/issues/145) — now **resolved** by
  [ADR-020](adr-020-coordinate-generalization.md) (coordinates are generalized to
  ~1 km for every caller).
- The login rate-limiter is in-memory (per-process) **and** keys on `req.ip`,
  which honours `app.set('trust proxy', 'loopback, linklocal, uniquelocal')`.
  In the single-host nginx topology this is safe (private ranges are
  unreachable from the internet), but a future deployment behind a CDN / mesh
  that forwards client-controlled `X-Forwarded-For` could rotate the keyed IP
  per request and bypass the 10/15-min budget. Revisit the limiter (shared
  store + a trusted-proxy/XFF policy) before going multi-instance or
  behind-a-CDN.
- CORS has only two states: localhost reflect-all (dev/test) or the single
  pinned prod origin. `isProduction()` treats `staging`/`qa`/unrecognised
  `NODE_ENV` as production, so a staging deployment on a different hostname
  would have its session cookie blocked by CORS. Add an explicit origin
  allowlist if staging becomes a real environment.
- The session token has no per-session id/nonce, so individual sessions cannot
  be revoked short of rotating `HIGHFIVE_API_KEY` (which drops all sessions).
  Fine for a single-operator gate; revisit for multi-operator / selective
  revocation.

**Forbidden**:

- **Do not** reintroduce `VITE_API_KEY` or bake any secret into the homepage
  bundle. If the browser needs privileged access, it logs in for a cookie.
- **Do not** set `Access-Control-Allow-Origin: *` while `credentials: true` —
  browsers reject the pair and the cookie silently stops flowing.
