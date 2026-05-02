# Backend (`backend/`)

Node 20 + Express + TypeScript. Serves the React frontend with a typed,
auth-gated JSON API. Stateless read-through projection on top of
`duckdb-service`; no DB connection of its own.

| Path                                | Role                          |
| ----------------------------------- | ----------------------------- |
| `backend/src/server.ts`             | Express bootstrap, port `3002` |
| `backend/src/app.ts`                | Route handlers                |
| `backend/src/auth.ts`               | API-key + admin-key middleware ([auth](../08-crosscutting-concepts/auth.md)) |
| `backend/src/duckdbClient.ts`       | Typed HTTP client for `duckdb-service` |
| `backend/tests/*.test.ts`           | Vitest + supertest, 17 tests  |

## Endpoints

| Endpoint                              | Auth                  | Purpose                                   |
| ------------------------------------- | --------------------- | ----------------------------------------- |
| `GET /api/health`                     | public                | Liveness check (`{"status":"ok"}`)        |
| `GET /api/modules`                    | `X-API-Key`           | List all modules + their nests + latest progress |
| `GET /api/modules/:id`                | `X-API-Key`           | One module + its detail                   |
| `GET /api/modules/:id/logs`           | `X-API-Key` + `X-Admin-Key` | Proxies to `image-service /modules/<mac>/logs` for admin telemetry inspection |

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

The dev fallback is `HIGHFIVE_API_KEY=hf_dev_key_2026`. The frontend
sends it as `X-API-Key` for all `/api/modules*` calls. Admin-only
endpoints additionally require `X-Admin-Key`, checked against the
**same** secret (see [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md)).
The admin UI is gated by `?admin=1` and stores the prompt-collected
key in `sessionStorage['hf_admin_key']`.

## Operational notes

- `backend` retries `duckdb-service` on startup with exponential
  backoff and starts empty if the DB is unreachable; it does not
  block.
- Internal URL: `http://duckdb-service:8000` (Docker service name,
  never `localhost`).
- Internal URL for the admin proxy:
  `http://image-service:4444/modules/<mac>/logs`.
