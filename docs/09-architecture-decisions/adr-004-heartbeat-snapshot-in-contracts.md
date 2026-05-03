# ADR-004: `HeartbeatSnapshot` lives in `@highfive/contracts`

## Status

Accepted.

## Context

PR 17 added a per-module heartbeat channel. The ESP32-CAM fires a
small POST to `duckdb-service` (`/modules/<mac>/heartbeat`) once per
hour with `battery`, `rssi`, `uptime_ms`, `free_heap`, and
`fw_version`. `duckdb-service` persists each one in
`module_heartbeats`, and the backend exposes the most recent row as
`Module.latestHeartbeat` so the dashboard can show liveness without
requiring a fresh image upload.

That snapshot crosses three layers:

- `duckdb-service` writes the row (Python).
- `backend` reads it and shapes the API response (TypeScript).
- `homepage` renders it on the dashboard, the admin telemetry table,
  and per-module pages (TypeScript).

ADR-003 (shared API key) and the unwritten "contracts package"
convention already established that **any wire-shape shared by
`backend` and `homepage`** belongs in the `@highfive/contracts` npm
workspace package, so drift becomes a TypeScript compile error.
The heartbeat snapshot is exactly that kind of shape.

## Decision

The shape lives in `contracts/src/index.ts` as
`HeartbeatSnapshot`, plus a `latestHeartbeat?: HeartbeatSnapshot | null`
field on `Module`. Both `backend` and `homepage` import it from
`@highfive/contracts`. `duckdb-service` does **not** import it (it's
Python and lives upstream of the type boundary), but the JSON keys
backend reads from `duckdb-service` must exactly match the field
names defined here — verified by the e2e test in
`tests/e2e/test_upload_pipeline.py`.

## Consequences

**Positive**:

- Adding a heartbeat field is a one-line edit; both consumers either
  see it or fail to compile.
- The dashboard, the `AdminPage` telemetry table, and the per-module
  view all read the same shape — no copy-paste interfaces.

**Negative**:

- Python side has no compile-time link to the TS interface. The e2e
  test is the only thing keeping `duckdb-service`'s output in sync.
  If you add a field, add an assertion in
  `tests/e2e/test_upload_pipeline.py` for it.

**Forbidden**:

- Don't redeclare `HeartbeatSnapshot` in `backend/src/types.ts` or
  `homepage/src/types/`. Import from `@highfive/contracts` only.
