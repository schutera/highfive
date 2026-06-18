# ADR-021: Admin server logs via an in-process stdout/stderr ring, not the Docker socket

## Status

Accepted ([#171](https://github.com/schutera/highfive/issues/171)). Spun out of the
[#170](https://github.com/schutera/highfive/issues/170) investigation, which needed
server-side visibility the per-module telemetry sidecars (`GET /api/modules/:id/logs`)
do not provide.

**Superseded in part by [ADR-022](adr-022-persistent-structured-server-logs.md)
([#178](https://github.com/schutera/highfive/issues/178)):** the ring is no longer
in-memory-only and the wire shape is no longer raw `string[]`. ADR-022 makes entries
structured (`{ ts, level, msg }`), persists them to disk (30 days / 100 MB, surviving
restart), and adds SSE streaming. The endpoint design, the admin gate, the per-service
ring + backend-proxy topology, and the "never `print`/`console.log` secrets" rule below
all carry forward unchanged.

## Context

There was no way to read the services' **own** process logs (backend,
`duckdb-service`, `image-service` stdout/stderr) without shell access to the host.
For a server-side failure — a 5xx spike, a wedged proxy, a duckdb write error, an
image-service stall — that meant flying blind. #171 adds an admin-gated endpoint to
tail recent server logs (`GET /api/admin/logs?service=…&lines=N`) plus an admin UI.

The hard part is **where the logs come from**, and it differs per environment:

- **Dev** runs under `docker compose`: each service logs to its container stdout, and
  the backend container has no Docker socket and no shared log volume.
- **Prod** is documented two ways (drift tracked in chapter 11): full Docker
  (`docker compose logs`) or PM2 (backend → `./logs/*.log`, nginx → `/var/log/nginx`).

No single host-level source works across all of these without new infrastructure.

## Decision

Each service keeps a **bounded in-memory ring of its own recent stdout/stderr lines**
and exposes it; the backend aggregates.

- Capture is a **stdout/stderr tee** installed at process start
  ([`backend/src/logRing.ts`](../../backend/src/logRing.ts),
  [`duckdb-service/services/log_ring.py`](../../duckdb-service/services/log_ring.py),
  [`image-service/services/log_ring.py`](../../image-service/services/log_ring.py)): every
  write is appended to a capped ring **and passed through** to the real stream, so
  `docker logs`/PM2 still see everything. This faithfully captures `print(...)` /
  `console.*` — exactly what an operator sees in the container log today. Same idea as
  the ESP `lib/logbuf` ring.
- The two Flask services expose an internal `GET /logs?lines=N`; the backend serves its
  own ring directly and **proxies** to them for
  `service=duckdb-service`/`image-service`.
- **Auth.** The public `GET /api/admin/logs` is gated by `requireAdmin` (session cookie
  OR `X-Admin-Key`), like `/api/admin/weather/backfill`. The internal Flask `/logs`
  routes additionally require `X-Admin-Key == HIGHFIVE_API_KEY` (constant-time compare),
  forwarded by the backend, because `duckdb-service:8002` and `image-service:8000` are
  published on the dev host and **logs can leak request metadata** — they must not be
  readable unauthenticated. This requires `HIGHFIVE_API_KEY` to resolve to the same value
  in all three services (dev: shared `.env`; UI + prod compose: set explicitly on each).
- **The ring faithfully captures whatever any code prints** — including any credential a log
  line chooses to emit. This is bounded by the admin gate on the endpoint, but it is the
  reason the endpoint must stay admin-only and a reason not to `console.log`/`print` secrets.
  (As of #178 the dev admin-key banner in `server.ts` is written via the ring-bypassing
  `writeStdout`, so the key reaches the terminal but **not** the ring; and the per-request
  access logs added in #178 log `method path status ms` **path-only** — never headers, body,
  or query string — so the `X-Admin-Key` header and login password cannot reach the ring.)

### Alternatives rejected

- **Mount the Docker socket** into the backend and shell out to `docker logs`. Simplest,
  gives full container logs incl. nginx, zero per-service code — but it exposes the Docker
  socket (≈ host root) on an internet-facing service, needs the docker CLI in the image,
  and matches only the Docker prod track, not PM2. The security cost is unacceptable for a
  diagnostic convenience.
- **Shared log-file volume** that every service + nginx writes to. File-based (matches PM2
  `./logs` and nginx `/var/log`), no socket — but it touches every service's logging
  config and compose volume plumbing, and dev/prod paths diverge.

## Consequences

- Portable: identical in dev and prod, app-level, no infra coupling, no socket exposure.
- **In-memory:** the ring resets on process restart, so it only holds lines since the
  process started. Acceptable for a "tail recent activity" diagnostic; not an audit log.
- **Per-process:** a future multi-worker prod (e.g. gunicorn) would return only the
  serving worker's ring. Dev and the current `python app.py` / single-process backend are
  unaffected. Revisit if the services move to multiple workers.
- **nginx is not covered** (no app process to host a ring). Its access/error logs remain a
  host/file concern — a follow-up if needed (e.g. a host-side reader), out of scope here.
- New shared-secret coupling: the Flask services now need `HIGHFIVE_API_KEY`; the UI and
  prod compose files set it on all three services (it was previously backend-only).
