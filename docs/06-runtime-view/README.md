# 6. Runtime View

How HiveHive behaves while it's running. The two primary scenarios are
the upload pipeline (edge → server) and the dashboard read flow.

## Scenarios

| Scenario                                                         | Document                                     |
| ---------------------------------------------------------------- | -------------------------------------------- |
| **Image upload, classification, persistence** (the main flow)    | [image-upload-flow.md](image-upload-flow.md) |
| **Dashboard read** (browser → backend → duckdb-service)          | covered inline below                         |
| **Admin telemetry inspection** (admin gate, log sidecars)        | covered inline below                         |
| **ESP firmware reliability** (watchdogs, recovery, daily reboot) | [esp-reliability.md](esp-reliability.md)     |
| **OTA firmware updates** (LAN push + boot-time HTTP pull)        | [ota-update-flow.md](ota-update-flow.md)     |

## Dashboard read flow

1. Browser loads `homepage`.
2. Frontend calls `backend` (`GET /api/modules`, `GET /api/modules/:id`)
   with `X-API-Key`.
3. `backend.ModuleReadModel` fans out to `duckdb-service` via
   `Promise.allSettled`:
   - `GET /modules`, `GET /nests`, `GET /progress`
4. `backend` normalises rows into `@highfive/contracts` DTOs and
   serves them.
5. Frontend renders the map, module list, status, battery and nest
   progress.

No caching layer; each browser poll re-fetches. Partial failures
degrade gracefully (some fields empty) rather than 500ing.

## Admin telemetry read flow

1. Operator opens the dashboard with `?admin=1`. The flag is stored in
   `sessionStorage['hf_admin']`.
2. Telemetry section in the module panel becomes visible. On open, the
   frontend prompts for the admin key via `window.prompt()` and stores
   it in `sessionStorage['hf_admin_key']`.
3. Frontend calls `GET /api/modules/:id/logs` with both `X-API-Key`
   and `X-Admin-Key`.
4. `backend` checks `X-Admin-Key` against `HIGHFIVE_API_KEY` (same
   secret as the API key — see
   [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md))
   and proxies to `image-service /modules/<mac>/logs?limit=N`.
5. `image-service` globs `*.log.json` sidecars on disk, filters by
   `_mac`, returns the newest N entries.
