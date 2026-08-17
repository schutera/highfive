# Backend (`backend/`)

Node 22 + Express + TypeScript. Serves the React frontend with a typed,
auth-gated JSON API. Stateless read-through projection on top of
`duckdb-service`; no DB connection of its own.

| Path                             | Role                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `backend/src/server.ts`          | Express bootstrap, port `3002`                                               |
| `backend/src/app.ts`             | Route handlers                                                               |
| `backend/src/auth.ts`            | API-key + admin-key middleware ([auth](../08-crosscutting-concepts/auth.md)) |
| `backend/src/duckdbClient.ts`    | Typed HTTP client for `duckdb-service`                                       |
| `backend/src/duckdbBootProbe.ts` | Advisory boot-time reachability probe (retry loop, deadline-budgeted)        |
| `backend/tests/*.test.ts`        | Vitest + supertest, 242 tests across 30 files                                |

## Endpoints

Auth (since #142 / ADR-019): **public** = no credential; **admin** =
`requireAdmin` (session cookie from `POST /api/admin/login`, or `X-Admin-Key`).

| Endpoint                        | Auth   | Purpose                                                                                                                                                                                                                          |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`               | public | Liveness check (`{"status":"ok"}`)                                                                                                                                                                                               |
| `POST /api/admin/login`         | public | Validates the admin password, sets the `hf_admin_session` cookie                                                                                                                                                                 |
| `GET /api/modules`              | public | List all modules + their nests + latest progress                                                                                                                                                                                 |
| `GET /api/modules/:id`          | public | One module + its detail                                                                                                                                                                                                          |
| `PATCH /api/modules/:id/name`   | admin  | Sets or clears the operator-settable `display_name` override. Proxies to `duckdb-service /modules/<id>/display_name`. 409 on collision                                                                                           |
| `GET /api/modules/:id/logs`     | admin  | Proxies to `image-service /modules/<mac>/logs` for admin telemetry inspection                                                                                                                                                    |
| `GET /api/admin/logs`           | admin  | Tail of a service's own stdout/stderr (#171). Serves the backend's in-process ring; proxies to `duckdb-service` / `image-service` internal `/logs`. See [ADR-021](../09-architecture-decisions/adr-021-admin-server-log-ring.md) |
| `GET /api/modules/:id/activity` | public | Bucketed image-upload counts for the dashboard weather-correlation chart. Proxies `duckdb-service /modules/<id>/activity_timeseries` and maps `module_id` → `moduleId`                                                           |

Full request/response shapes in [docs/api-reference.md](../api-reference.md).

## Read-through projection

Every `/api/modules*` request fans out to `duckdb-service` via
`Promise.allSettled` over `GET /modules`, `GET /nests`, `GET /progress`,
and `GET /heartbeats_summary`, normalises the rows into the shared
`@highfive/contracts` DTOs, and returns them. On partial upstream
failure the response degrades (some fields empty) rather than 500ing.
Acceptable trade-off given the expected read volume (one operator,
polling).

A short-TTL in-memory cache sits in front of the fan-out
(`backend/src/database.ts`'s `ASSEMBLE_CACHE_TTL_MS`, 5 s) and dedupes
concurrent callers. Only a **fully-successful** snapshot is cached — a
degraded one is deliberately not, so a transient upstream failure can't
be served for the rest of the TTL. Pinned by
[`backend/tests/read-model-cache.test.ts`](../../backend/tests/read-model-cache.test.ts).

## Auth flow

Reads are public (#142 / ADR-019); the frontend bundle holds no secret.
Admin/write endpoints are gated by `requireAdmin`
([`backend/src/session.ts`](../../backend/src/session.ts)), which accepts a
valid `hf_admin_session` cookie (minted by `POST /api/admin/login` after a
constant-time check of `HIGHFIVE_API_KEY`) **or** an `X-Admin-Key` header
(server-side machine credential). The dev fallback is
`HIGHFIVE_API_KEY=hf_dev_key_2026`. The admin UI logs in via `api.login()`
and relies on the cookie; nothing privileged is stored client-side. See
[ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md)
and the superseded-in-part
[ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md).

## Operational notes

- `backend` probes `duckdb-service` at startup and retries for up to a
  **15 s wall-clock deadline** (500 ms between attempts, each attempt
  capped by a 2 s fetch timeout). The probe is **advisory** and is fired
  **after** `app.listen`, so it never delays the port binding — the API
  serves regardless of the outcome. The budget is a deadline rather than
  an attempt count because the failure mode is a _refused_ port, where
  each attempt fails in ~1 ms and an attempt cap would silently shrink
  the window to well under duckdb-service's own 10 s healthcheck
  `start_period`. See `backend/src/duckdbBootProbe.ts`'s
  `probeDuckdbHealth`.
- The retry exists for the **PM2 host**, which has no orchestrator and
  starts `highfive-api` and `duckdb-service` within a second of each
  other, so a one-shot probe races the service binding its port. Both
  compose files instead gate the backend declaratively on
  `depends_on: duckdb-service: {condition: service_healthy}`. The
  symptom either way was a spurious `⚠ DuckDB service not reachable`
  that then lingered near the top of the admin Server Logs panel (#171)
  long after the service was fine — it is evicted only once 2000 newer
  entries push it out of the ring (`backend/src/logRing.ts`'s
  `MAX_RING_ENTRIES`), not on recovery.
- Internal URL: `http://duckdb-service:8000` (Docker service name,
  never `localhost`).
- Internal URL for the admin proxy:
  `http://image-service:4444/modules/<mac>/logs`.
