# 6. Runtime View

How HiveHive behaves while it's running. The two primary scenarios are
the upload pipeline (edge → server) and the dashboard read flow.

## Scenarios

| Scenario                                                                            | Document                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Image upload, classification, persistence** (the main flow)                       | [image-upload-flow.md](image-upload-flow.md)           |
| **Dashboard read** (browser → backend → duckdb-service)                             | covered inline below                                   |
| **Admin telemetry inspection** (admin gate, log sidecars)                           | covered inline below                                   |
| **ESP firmware reliability** (watchdogs, recovery, daily reboot)                    | [esp-reliability.md](esp-reliability.md)               |
| **OTA firmware updates** (LAN push + boot-time HTTP pull)                           | [ota-update-flow.md](ota-update-flow.md)               |
| **Per-module measurement write & read** (heartbeat dual-write → bucketed aggregate) | [measurement-write-flow.md](measurement-write-flow.md) |
| **External weather worker** (hourly Open-Meteo fetch → measurements)                | [weather-worker-flow.md](weather-worker-flow.md)       |

## Dashboard read flow

1. Browser loads `homepage`.
2. Frontend calls `backend` (`GET /api/modules`, `GET /api/modules/:id`).
   These reads are public — no credential (#142 / ADR-019).
3. `backend.ModuleReadModel` fans out to `duckdb-service` via
   `Promise.allSettled`:
   - `GET /modules`, `GET /nests`, `GET /progress`
4. `backend` normalises rows into `@highfive/contracts` DTOs and
   serves them.
5. Frontend renders the map, module list, status, battery and nest
   progress.
6. Opening a module's detail panel — **only when the build-time feature flag
   `VITE_ENABLE_DASHBOARD_IMAGES` is `true`** (default off in prod; see
   [ADR-022](../09-architecture-decisions/adr-022-build-time-feature-flags.md))
   — additionally fetches
   `GET /api/images?module_id=<id>&limit=6&offset=0` (public read, proxied
   to `image-service /images`) and renders a newest-first "Latest captures"
   carousel (#154) — two 4:3 cards visible, chevron arrows paging older
   images (further `offset` pages fetched on demand), click for a full-size
   lightbox; bytes come from `GET /api/images/:filename`. A failed image
   fetch degrades to "no gallery" — it never tears down the panel. With the
   flag off, the panel shows nests / status / telemetry only and makes no
   image fetch.

No caching layer; each browser poll re-fetches. Partial failures
degrade gracefully (some fields empty) rather than 500ing.

## Admin telemetry read flow

1. Operator opens the dashboard with `?admin=1`. The flag is stored in
   `sessionStorage['hf_admin']` (reveals the affordance only).
2. Telemetry section in the module panel becomes visible. On open, if there
   is no admin session the frontend renders `AdminKeyForm`, which **logs in**
   via `POST /api/admin/login` (`api.login()`); the server sets an `HttpOnly`
   `hf_admin_session` cookie. The key is never stored client-side (#142).
3. Frontend calls `GET /api/modules/:id/logs` with `credentials: 'include'`,
   so the session cookie rides along (no secret header).
4. `backend`'s `requireAdmin` accepts the cookie (or an `X-Admin-Key`
   machine credential), validating against `HIGHFIVE_API_KEY` — see
   [ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md)
   and [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md))
   and proxies to `image-service /modules/<mac>/logs?limit=N`.
5. `image-service` globs `*.log.json` sidecars on disk, filters by
   `_mac`, returns the newest N entries.
