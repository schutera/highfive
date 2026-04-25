# HiveHive Architecture

High-level overview of the HiveHive system. For deep-dive documents see the
[Documentation](#documentation) section at the bottom.

HiveHive monitors wild-bee nesting activity using ESP32-CAM edge modules,
classifies nest images, persists progress in DuckDB, and visualizes module
status and nest progress in a web dashboard.

## Service Topology

```
                         field
            ┌──────────────────────────────┐
            │                              │
            │   ESP32-CAM (firmware v1.x)  │  capture every N min
            │                              │
            └──────────────┬───────────────┘
                           │  POST /upload   (multipart: image, mac, battery, logs)
                           ▼
            ┌──────────────────────────────┐
            │   image-service  (Flask)     │  port 8000  (container :4444)
            │   /upload, /modules/<mac>/   │
            │   logs, /health              │
            │                              │
            │   • saves image to volume    │
            │   • writes <img>.log.json    │
            │   • runs stub classifier     │
            │   • POSTs progress to DB svc │
            │   • UPDATEs module_configs   │
            │     directly (known issue,   │
            │     scheduled for Phase 4)   │
            └────┬─────────────────────────┘
                 │  POST /add_progress_for_module
                 ▼
            ┌──────────────────────────────┐
            │   duckdb-service  (Flask)    │  port 8002  (container :8000)
            │   owns app.duckdb            │
            │   /modules, /nests, /progress│
            │   /new_module, /health       │
            └────────────────┬─────────────┘
                             │  GET /modules /nests /progress
                             ▼
            ┌──────────────────────────────┐
            │   backend  (Express + TS)    │  port 3002
            │   /api/health (public)       │
            │   /api/modules*              │
            │   /api/modules/:id/logs      │
            │     (admin-gated proxy)      │
            └────────────────┬─────────────┘
                             │  fetch (X-API-Key)
                             ▼
            ┌──────────────────────────────┐
            │   homepage  (React + Vite)   │  port 5173
            │   /, /dashboard, /setup,     │
            │   /hive-module, /assembly    │
            └──────────────────────────────┘
```

A shared Docker volume `duckdb_data` is mounted into both `image-service`
and `duckdb-service`. All four services run on the `net` Docker bridge
network and refer to each other by container name.

## Service Responsibilities

| Service          | Stack                             | Port (host:container) | Responsibility                                                                                          |
| ---------------- | --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `homepage`       | React 19 + Vite + TypeScript      | 5173:5173             | Dashboard, map, module detail, setup wizard, assembly guide, hive-module info page.                     |
| `backend`        | Node.js + Express + TypeScript    | 3002:3002             | Authenticated API for the frontend. Aggregates module + nest + progress data. Proxies admin telemetry.  |
| `image-service`  | Python + Flask                    | 8000:4444             | ESP upload endpoint, image storage, telemetry sidecar, stub classification, progress writeback.         |
| `duckdb-service` | Python + Flask + DuckDB           | 8002:8000             | Persistent storage. Owns `app.duckdb`. Exposes `/modules`, `/nests`, `/progress`, `/new_module`, etc.   |
| `ESP32-CAM`      | C++ / Arduino + PlatformIO        | n/a (edge)            | Capture image, build telemetry payload, multipart upload to `image-service`.                            |

## Data Flow Summary

**Ingestion** — ESP captures image, attaches a JSON `logs` part with firmware
version, uptime, free heap, RSSI, last reset reason, last HTTP codes, and the
last ~2 KB of the on-device circular log buffer. `image-service` saves the
image, writes `{image_path}.log.json` next to it, runs the stub classifier,
forwards the result to `duckdb-service`, and updates the module's battery
level + image count directly in DuckDB (the direct-write is the one
remaining persistence-layering wart and is on the Phase 4 roadmap).

**Read** — Browser loads `homepage`; the dashboard calls `backend` with
`X-API-Key`. `backend` refreshes its in-memory cache by reading
`/modules`, `/nests`, `/progress` from `duckdb-service`, normalises into
frontend DTOs, and serves them. The admin Telemetry section (gated by
`?admin=1` UI flag and an `X-Admin-Key` header) calls
`/api/modules/:id/logs`, which proxies to `image-service /modules/<mac>/logs`.

## Test Stack

Three layers of automated testing, all wired into CI
(`.github/workflows/tests.yml`):

- **Service unit tests** — fast, hermetic, no external services:
  - `backend-unit` — vitest + supertest (21 tests) for the Express API layer;
    database is mocked via `vi.mock`.
  - `duckdb-unit` — pytest (15 tests) against an in-memory DuckDB fixture;
    exercises schema, nest creation, progress insertion.
  - `image-unit` — pytest (24 tests); all outbound HTTP and `duckdb.connect`
    calls are monkey-patched.
  - `homepage-unit` — vitest + jsdom (8 smoke tests) rendering key React pages.
- **ESP32-CAM tests** — Unity/PlatformIO host tests under
  `ESP32-CAM/test/test_native_*` (38 tests) for `lib/url`, `lib/ring_buffer`,
  and `lib/telemetry`. Job `esp-native`. Also gated by an `esp-firmware` job
  that cross-compiles the actual Arduino firmware against the ESP32 platform.
- **End-to-end pipeline test** — `tests/e2e/test_upload_pipeline.py` boots
  an isolated docker-compose stack (`tests/e2e/docker-compose.test.yml`,
  ports shifted +1000), drives it with the Python mock ESP
  (`tools/mock_esp.py`), and asserts the full upload chain (image landing,
  sidecar, DuckDB row update, backend admin-proxy). Job `e2e-pipeline`.

Run locally with `make test-esp-native` and `make test-e2e`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites.

## Operational Notes

- DB persistence survives container recreation via the `duckdb_data` volume.
- Internal container requests use Docker service names, not `localhost`.
- `backend` retries `duckdb-service` on startup with backoff and starts
  empty if the DB is unreachable; it does not block.
- The dev API key is `hf_dev_key_2026` (env `HIGHFIVE_API_KEY` /
  frontend `VITE_API_KEY`). Override in production.

## Documentation

| Topic                              | Document                                           |
| ---------------------------------- | -------------------------------------------------- |
| Deploying the stack with Compose   | [service-deployment](documentation/service-deployment.md) |
| Frontend pages and routes          | [homepage](documentation/homepage.md)              |
| ESP32-CAM flashing and setup       | [esp-deployment](documentation/esp-deployment.md)  |
| ESP reliability and telemetry      | [esp-reliability](documentation/esp-reliability.md) |
| Backend API reference              | [api-usage](documentation/api-usage.md)            |
| Original architecture deep-dive    | [architecture](documentation/architecture.md)      |
| Image service                      | [image-service](documentation/image-service.md)    |
| DuckDB schema and design           | [duckDB](documentation/duckDB.md)                  |
| Contributing, branches, tests      | [CONTRIBUTING.md](CONTRIBUTING.md)                 |
