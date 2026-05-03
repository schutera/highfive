# ADR-004: `HeartbeatSnapshot` lives in `@highfive/contracts`

## Status

Accepted.

## Context

PR 17 added a per-module **telemetry heartbeat** channel. The ESP32-CAM
fires the POST itself, hourly, with `mac`, `battery`, `rssi`, `uptime_ms`,
`free_heap`, `fw_version`. The route that receives it is
`POST /heartbeat` on `duckdb-service` (`duckdb-service/routes/heartbeats.py:17`),
called by the firmware in `ESP32-CAM/client.cpp:260` (path is hardcoded —
see the comment block at `client.cpp:226-230`). Each call inserts a row
into the `module_heartbeats` table (schema in
`duckdb-service/db/schema.py`). The backend exposes the most recent row
as `Module.latestHeartbeat` so the dashboard can show liveness without
requiring a fresh image upload.

> **Not the same endpoint** as the post-upload aggregate at
> `POST /modules/<module_id>/heartbeat` (`duckdb-service/routes/modules.py:266`,
> called by `image-service/services/duckdb.py:53` after every accepted
> upload). That older endpoint takes only `{battery}` and updates
> `module_configs.battery_level/first_online/image_count` — it is **not**
> what this ADR is about. The two paths share a name and a verb but do
> different things; see the glossary entries for "Heartbeat (telemetry)"
> and "Heartbeat (post-upload aggregate)".

That snapshot crosses three layers:

- `duckdb-service` writes the row (Python, via `routes/heartbeats.py`).
- `backend` reads it and shapes the API response (TypeScript).
- `homepage` renders it on the dashboard, the `AdminPage` telemetry
  table, and per-module pages (TypeScript).

ADR-003 (shared API key) and the `@highfive/contracts` package
convention already established that **any wire-shape shared by
`backend` and `homepage`** belongs in the npm workspace package, so
drift becomes a TypeScript compile error. The heartbeat snapshot is
exactly that kind of shape.

## Decision

The shape lives in `contracts/src/index.ts` as `HeartbeatSnapshot`
(`receivedAt`, `battery`, `rssi`, `uptimeMs`, `freeHeap`, `fwVersion`),
plus `latestHeartbeat?: HeartbeatSnapshot | null` on `Module`. Both
`backend` and `homepage` import it from `@highfive/contracts`.
`duckdb-service` does **not** import it (it's Python and lives upstream
of the type boundary), but the JSON keys backend reads from
`duckdb-service` must exactly match the field names defined here.

The wire body that the firmware actually sends is `application/x-www-form-urlencoded`
(`mac=...&battery=...&rssi=...&uptime_ms=...&free_heap=...&fw_version=...`),
parsed by `routes/heartbeats.py:18-30`. The snake-case→camelCase
translation happens in the backend serializer when shaping the
`Module.latestHeartbeat` response.

## Consequences

**Positive**:

- Adding a heartbeat field is a one-line edit in `contracts/src/index.ts`;
  both TS consumers either see it or fail to compile.
- The dashboard, the `AdminPage` telemetry table, and the per-module
  view all read the same shape — no copy-paste interfaces.

**Negative**:

- Python side has no compile-time link to the TS interface. If you add
  a field, also add the column in `module_heartbeats` (schema.py), the
  `data.get(...)` line in `routes/heartbeats.py`, and the body field
  in `client.cpp` — three coordinated edits no compiler will catch.
- The two-endpoint name collision (telemetry heartbeat vs. post-upload
  aggregate) is a known glossary hazard. Don't add a third heartbeat
  endpoint without renaming.

**Forbidden**:

- Don't redeclare `HeartbeatSnapshot` in `backend/src/types.ts` or
  `homepage/src/types/`. Import from `@highfive/contracts` only.
