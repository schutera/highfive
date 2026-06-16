# Backend (`backend/`)

Node 22 + Express + TypeScript. Serves the React frontend with a typed,
auth-gated JSON API. Stateless read-through projection on top of
`duckdb-service`; no DB connection of its own.

| Path                          | Role                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `backend/src/server.ts`       | Express bootstrap, port `3002`                                               |
| `backend/src/app.ts`          | Route handlers                                                               |
| `backend/src/auth.ts`         | API-key + admin-key middleware ([auth](../08-crosscutting-concepts/auth.md)) |
| `backend/src/duckdbClient.ts` | Typed HTTP client for `duckdb-service`                                       |
| `backend/tests/*.test.ts`     | Vitest + supertest, 17 tests                                                 |

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
`Promise.allSettled` over `GET /modules`, `GET /nests`,
`GET /progress`, normalises the rows into the shared
`@highfive/contracts` DTOs, and returns them. There is no caching
layer — on partial upstream failure, the response degrades (some
fields empty) rather than 500ing. Acceptable trade-off given the
expected read volume (one operator, polling).

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

- `backend` retries `duckdb-service` on startup with exponential
  backoff and starts empty if the DB is unreachable; it does not
  block.
- Internal URL: `http://duckdb-service:8000` (Docker service name,
  never `localhost`).
- Internal URL for the admin proxy:
  `http://image-service:4444/modules/<mac>/logs`.
