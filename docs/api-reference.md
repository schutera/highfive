# HiveHive API Documentation

This document describes the HTTP APIs exposed by the HiveHive services.
The system has four services and three callable APIs:

| Service        | Host port | Container port | Description                          |
| -------------- | --------- | -------------- | ------------------------------------ |
| Homepage       | `5173`    | `5173`         | React + Vite frontend                |
| Backend        | `3002`    | `3002`         | Express API consumed by the homepage |
| Image Service  | `8000`    | `4444`         | ESP upload + telemetry sidecar       |
| DuckDB Service | `8002`    | `8000`         | Persistent storage API               |

The homepage itself is at <http://localhost:5173>. The canonical wire shapes
shared between backend and homepage live in `contracts/src/index.ts`.

The three APIs documented below are:

- **Backend API** (`http://localhost:3002`) — auth-gated, consumed by the homepage.
- **Image Service API** (`http://localhost:8000`) — image ingestion + telemetry.
- **DuckDB Service API** (`http://localhost:8002`) — persistent storage.

<br>

# 1. Backend API

Base URL: `http://localhost:3002`

The backend (`backend/src/app.ts`) is an Express + TypeScript service that
the homepage talks to. It refreshes an in-memory cache from the DuckDB
service and shapes the response for the frontend.

## 1.0 Authentication

All `/api/*` routes — except `GET /api/health` — require an API key.
Three transports are accepted (see `backend/src/auth.ts`):

- Header: `X-API-Key: <key>`
- Header: `Authorization: Bearer <key>`
- Query: `?api_key=<key>` (not recommended, dev only)

The dev default key is `hf_dev_key_2026`. Override via the
`HIGHFIVE_API_KEY` env var in production. The frontend reads its key
from the build-time `VITE_API_KEY`.

`GET /api/modules/:id/logs` requires an **additional** `X-Admin-Key`
header that must also match `HIGHFIVE_API_KEY`. The same key is reused
on purpose so there is no second secret to rotate.

## 1.1 Health

```
GET /api/health
```

Public, no auth. Liveness probe.

```json
{
  "status": "ok",
  "timestamp": "2026-04-25T12:34:56.000Z"
}
```

## 1.2 List modules

```
GET /api/modules
Headers: X-API-Key: <key>
```

Returns an array of `Module` objects shaped for the dashboard:

```json
[
  {
    "id": "aabbccddeeff",
    "name": "fierce-apricot-specht",
    "displayName": "Klostergarten",
    "location": { "lat": 47.8086, "lng": 9.6433 },
    "status": "online",
    "lastApiCall": "2026-04-25T12:34:56.000Z",
    "batteryLevel": 85,
    "firstOnline": "2023-04-15T00:00:00.000Z",
    "totalHatches": 450,
    "imageCount": 142
  }
]
```

`name` is the firmware-reported value (mutable on every UPSERT; same-batch
collisions auto-suffixed by `duckdb-service` `add_module`). `displayName`
is an optional admin-settable override; null when the operator has not
renamed the module. Frontend surfaces resolve the operator-visible label
via the shared helper
[`homepage/src/lib/displayLabel.ts`](../homepage/src/lib/displayLabel.ts),
which trims `displayName` and falls back to `name` on null / empty /
whitespace-only. The **leading** 4 hex chars of `id` ride along as a
visual subtitle (the trailing octets are shared by same-batch hardware
— see ADR-011 for the rationale). See
[ADR-011](09-architecture-decisions/adr-011-module-display-name-override.md).

`status` is one of `'online' | 'offline' | 'unknown'` and is computed
in `backend/src/database.ts's fetchAndAssemble`. A module is `'online'`
when any liveness signal (last image upload, registration timestamp, or
heartbeat) is fresher than 2 h. A module that would otherwise have been
classified as `'offline'` is reported as `'unknown'` (gray) instead
when the duckdb `/heartbeats_summary` fetch failed — we can't rule out
that a heartbeat from the last few minutes would have flipped it to
`'online'`, so we admit uncertainty rather than misleading the
on-call. See #31.

The header `X-Highfive-Data-Incomplete: heartbeats` is set on the
**listing route** whenever the heartbeats fetch failed (irrespective of
whether any module's status actually flipped — the header surfaces the
_data quality_, not a per-module flag) so the dashboard can render a
"data incomplete" banner. The detail route (`/api/modules/:id`)
deliberately omits the header — its consumer always lands there from
the listing and has already seen the degradation signal. Old clients
that don't read the header still see a structurally valid response;
only the per-module `status` value may differ.

## 1.3 Module detail

```
GET /api/modules/:id
Headers: X-API-Key: <key>
```

Same shape as above, plus a `nests` array of `NestData`. Each nest
carries `dailyProgress[]` with `progress_id`, `nest_id`, `date`,
`empty`, `sealed`, `hatched`. 404 if the module is unknown.

## 1.4 Rename module (admin)

```
PATCH /api/modules/:id/name
Headers:
  X-API-Key:   <key>
  X-Admin-Key: <key>   # must match HIGHFIVE_API_KEY
Body: { "display_name": "Garden Bee" }   # or null to clear
```

Sets or clears the operator-settable `display_name` override (ADR-011).
Backend proxies to `duckdb-service` `PATCH /modules/<id>/display_name`,
which enforces a UNIQUE constraint at the DB layer. Frontend surfaces
resolve the label via
[`homepage/src/lib/displayLabel.ts`](../homepage/src/lib/displayLabel.ts),
so this is the endpoint to call when an operator wants to rename a
module without re-flashing it.

Status codes:

- **200** — success. Body echoes `{ id, display_name, message }` with the
  newly-stored value (or `null` if cleared).
- **400** — body missing the `display_name` key, or value is not a string
  or `null`, or exceeds 100 chars.
- **403** — `X-Admin-Key` missing or wrong.
- **404** — module id is well-formed but not registered.
- **409** — another module already holds this `display_name`. Body:
  `{ error, display_name, conflicting_module_id }`. The homepage's
  `RenameModuleModal` surfaces the conflicting module's leading 4 hex
  inline so the operator can pick a different name.
- **502** — `duckdb-service` unreachable.

Passing an empty/whitespace string is treated as `null` (clears the
override), matching the modal's "leave empty to clear" UX.

## 1.5 Module telemetry logs (admin)

```
GET /api/modules/:id/logs?limit=10
Headers:
  X-API-Key:   <key>
  X-Admin-Key: <key>   # must match HIGHFIVE_API_KEY
```

Proxies `image-service /modules/<mac>/logs` and returns telemetry
sidecar entries newest-first. Returns `403` if `X-Admin-Key` is missing
or wrong, `502` if the image-service is unreachable.

```json
[
  {
    "mac": "aabbccddeeff",
    "received_at": "2026-05-07T12:00:00",
    "image": "esp_capture_20260507_120000.jpg",
    "payload": {
      "fw": "1.0.0",
      "uptime_s": 72145,
      "last_reset_reason": "TASK_WDT",
      "last_stage_before_reboot": "setup:getGeolocation",
      "free_heap": 124352,
      "min_free_heap": 98211,
      "rssi": -67,
      "wifi_reconnects": 2,
      "last_http_codes": [200, 200, 500, 200, 200],
      "log": "[BOOT] fw=1.0.0 ..."
    }
  }
]
```

The shape is the typed envelope dumped from `image-service/services/sidecar.py`'s
`LogSidecarEnvelope`: service-injected metadata at the top level (`mac`,
`received_at`, `image`), the raw ESP telemetry nested under `payload`.
Pre-envelope sidecars on disk are read-compat and reshape into the same
envelope on the way out. The TypeScript contract is `TelemetryEntry` in
[`contracts/src/index.ts`](../contracts/src/index.ts).

Inside `payload`, `last_stage_before_reboot` is **optional**. The firmware
emits it only when the previous boot's RTC_NOINIT breadcrumb survived
(i.e. the previous boot ended in a software reset — TASK_WDT, panic,
ESP.restart — rather than a clean exit or a power-on). Sidecars produced
by firmware that pre-dates the field continue to validate; admin UI
consumers should treat the field as missing when absent, not error.
Diagnostic mechanism for issue #42 — see
[06-runtime-view/esp-reliability.md "Stage breadcrumb"](06-runtime-view/esp-reliability.md#8-stage-breadcrumb-cross-reboot-diagnostic).

The telemetry section in the dashboard is hidden unless the URL has
`?admin=1`; see [06-runtime-view/esp-reliability.md](06-runtime-view/esp-reliability.md) for the
end-to-end admin flow.

## 1.5 User location hint (dashboard map)

```
GET /api/user-location
Headers: X-API-Key: <key>
```

Returns a coarse, IP-based location guess used by the dashboard to
centre the map near the visitor on first load (issue #14). Accuracy is
~10–50 km — city-level, not GPS-precise. Precise location still comes
from the in-map "show my location" button which calls
`navigator.geolocation.getCurrentPosition()` in the browser.

The visitor's IP is resolved from `req.ip`, honouring `X-Forwarded-For`
only when the immediate hop comes from a trusted private network range
(Express `trust proxy = 'loopback, linklocal, uniquelocal'`).

On success:

```json
{ "lat": 52.52, "lng": 13.405 }
```

Accuracy is implicitly city-level (~10–50 km — the documented IP-geo
band). The wire shape deliberately does not include a precision
field: ipapi.co does not publish a per-IP accuracy number, and no
consumer currently renders one. If a future view needs to surface an
explicit "± N km" annotation, add a field then; don't pre-allocate
constant-shaped metadata.

Non-success status codes are part of the contract; the homepage treats
both as "no hint" and falls back to the default centre:

- **204 No Content** — the visitor's IP resolved to a loopback,
  RFC-1918, or IPv6 ULA address. Common in dev. No upstream call was
  made.
- **503 Service Unavailable** — the upstream IP-geolocation provider
  (ipapi.co, free tier) returned a non-2xx or a 200-with-error-flag
  rate-limit response. The endpoint deliberately does NOT swallow the
  failure to a 200-with-null body; see [ADR-012](09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md).

Successful lookups are cached in-process per IP for 1 hour. The cache
is per-replica — multi-replica deployments amortise to one upstream
call per replica per visitor per hour.

Why a backend proxy rather than reusing `GEO_API_KEY` directly:
[ADR-012](09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md).

## 1.6 Module activity timeseries (dashboard chart)

```
GET /api/modules/:id/activity?interval=hourly&days=7
Headers: X-API-Key: <key>
```

Bucketed image-upload counts for a single module, used by the dashboard
`ActivityWeatherChart` to overlay activity against Open-Meteo weather
at the module's lat/lng. Maps to the duckdb-service
`/modules/<id>/activity_timeseries` route (see §3.10) and rewrites the
snake_case wire to the camelCase `ActivityTimeSeries` shape pinned in
[`contracts/src/index.ts`](../contracts/src/index.ts).

Query parameters (both optional, with sensible defaults):

- `interval` — `hourly` (default) or `daily`. Buckets coarser than
  hourly skip the weather overlay client-side (Open-Meteo only
  publishes hourly observations).
- `days` — look-back window. Default `7`, range `[1, 90]`.

Empty buckets are filled server-side with `count: 0`. The chart
renders a continuous timeline rather than stitching across silent
hours, which would visually misrepresent a quiet hive as a spike on
either side of the gap.

```json
{
  "moduleId": "aabbccddeeff",
  "interval": "hourly",
  "start": "2026-05-13T00:00:00",
  "end": "2026-05-20T00:00:00",
  "buckets": [
    { "timestamp": "2026-05-13T00:00:00", "count": 0 },
    { "timestamp": "2026-05-13T01:00:00", "count": 3 }
  ]
}
```

Timestamps are UTC ISO 8601, bucket-start. The homepage formats them to
the visitor's browser locale at render time (see
[`08-crosscutting-concepts/api-contracts.md`](08-crosscutting-concepts/api-contracts.md)
for the timezone reasoning).

Error responses bubble verbatim from duckdb-service:

- `400` — invalid module id, unknown `interval`, or `days` outside
  `[1, 90]`.
- `404` — module unknown.
- `502` — duckdb-service unreachable.

## 1.7 Module measurements timeseries (per-module canonical store)

```
GET  /api/modules/:id/measurements?metric=battery_pct&interval=hourly&days=7
POST /api/modules/:id/measurements
Headers: X-API-Key: <key>            (both)
         X-Admin-Key: <key>          (POST only)
```

Per-module bucketed time-series read against the canonical
`measurements` store (issue #110). Maps to the duckdb-service
`/modules/<id>/measurements` and `/measurements` routes (see §3.11
and §3.12) and rewrites the snake_case wire to the camelCase
`MeasurementTimeSeries` shape pinned in
[`contracts/src/index.ts`](../contracts/src/index.ts).

### GET — bucketed read

Query parameters:

- `metric` — **required**. One of the metric strings the producers
  emit (`battery_pct` today; future: `temperature_c`, `activity_score`,
  `rssi_dbm`, …). See the
  [glossary](12-glossary/README.md) for the canonical list.
- `interval` — `hourly` (default) or `daily`.
- `days` — look-back window. Default `7`, range `[1, 90]`.

Empty buckets carry `value: null` and `sampleCount: 0` — NOT `value:
0`. A missing sensor reading is unknown, not zero; the homepage chart
renders `null` as a break in the line so a silent device doesn't
read as a flat-line discharge.

```json
{
  "moduleId": "aabbccddeeff",
  "metric": "battery_pct",
  "interval": "hourly",
  "start": "2026-05-13T00:00:00",
  "end": "2026-05-20T00:00:00",
  "buckets": [
    { "timestamp": "2026-05-13T00:00:00", "value": null,  "sampleCount": 0 },
    { "timestamp": "2026-05-13T01:00:00", "value": 87.5,  "sampleCount": 2 }
  ]
}
```

Bucket `value` is `AVG(measurements.value)` across all rows landing in
the bucket; `sampleCount` is the row count behind the average.

Errors:

- `400` — invalid module id, missing `metric`, unknown `interval`,
  `days` outside `[1, 90]`.
- `404` — module unknown.
- `502` — duckdb-service unreachable.

### POST — admin-gated append

Body shape — single:

```json
{
  "ts": "2026-05-20T12:00:00Z",
  "metric": "temperature_c",
  "value": 18.4,
  "source": "weather-api"
}
```

Body shape — batched (≤ 1000 rows):

```json
{
  "measurements": [
    {"ts": "...", "metric": "...", "value": 1.0, "source": "..."},
    ...
  ]
}
```

The backend forces `module_mac` to match the path; a body-supplied
`module_mac` is ignored. Returns `{"inserted": N}` on success.

Errors:

- `400` — invalid body, batch > 1000 rows, missing/oversized field,
  non-finite `value`, malformed `ts`.
- `403` — `X-Admin-Key` missing or wrong.
- `502` — duckdb-service unreachable.

Intended producers: weather worker (#111), classifier (#112).
Heartbeat-side battery does NOT go through this proxy — it
dual-writes directly from `duckdb-service/routes/heartbeats.py`.
See [ADR-016](09-architecture-decisions/adr-016-per-module-measurements-store.md)
for the rationale.

<br>

# 2. Image Service API

Base URL: `http://localhost:8000` (container port `4444`).

## 2.1 Health

```
GET /health
```

```json
{ "ok": true, "service": "image-service" }
```

Liveness only — does not verify DuckDB connectivity. Use the
duckdb-service `/health` for that.

## 2.2 Upload image (with optional telemetry)

```
POST /upload
Content-Type: multipart/form-data
```

| Field     | Type | Required | Description                                                                        |
| --------- | ---- | -------- | ---------------------------------------------------------------------------------- |
| `image`   | File | Yes      | Captured JPEG                                                                      |
| `mac`     | Text | Yes      | Module identifier                                                                  |
| `battery` | Text | Yes      | Integer 0–100                                                                      |
| `logs`    | Text | No       | JSON telemetry payload (see [esp-reliability](06-runtime-view/esp-reliability.md)) |

If `logs` is present and parseable, it is saved to `{image_path}.log.json`
in `LogSidecarEnvelope` format: `{mac, received_at, image, payload: {…}}`.
Unparseable payloads are still saved as `{ "raw": ..., "parse_error": true, ... }`.

Response:

```json
{
  "message": "Image hive_image.jpg uploaded successfully",
  "mac": "esp-9081726354",
  "battery": 67,
  "classification": {
    "black_masked_bee": { "1": 1, "2": 0, "3": 1, "4": 0 },
    "leafcutter_bee": { "1": 1, "2": 1, "3": 0, "4": 1 },
    "orchard_bee": { "1": 0, "2": 1, "3": 1, "4": 0 },
    "resin_bee": { "1": 1, "2": 1, "3": 1, "4": 0 }
  }
}
```

The classifier is currently a stub returning random 0/1 values.

## 2.3 Module logs

```
GET /modules/<mac>/logs?limit=N
```

Reads `*.log.json` sidecars on disk, filters by `mac` (envelope field),
sorts by mtime descending, and returns the newest N (default 10, max 100).
Used by the backend admin proxy in section 1.4.

<br>

# 3. DuckDB Service API

Base URL: `http://localhost:8002` (container port `8000`).

## 3.1 Health

```
GET /health
```

```json
{ "ok": true, "db": "/data/app.duckdb" }
```

## 3.2 Register a module

```
POST /new_module
Content-Type: application/json
```

```json
{
  "esp_id": "b0696ef23a08",
  "module_name": "Garden-Hive",
  "latitude": 48.52137,
  "longitude": 9.05891,
  "battery_level": 72
}
```

`esp_id` is the canonical 12-char lowercase-hex form of the eFuse MAC. Legacy colon-separated and uppercase-hex inputs (e.g. `AA:BB:CC:DD:EE:FF`) are accepted and canonicalised; raw uint64 decimal stringification (~15 digits) is rejected with HTTP 400 — see issue #39.

Returns:

```json
{ "id": "b0696ef23a08", "name": "Garden-Hive", "message": "Module added successfully" }
```

The response echoes the actually-stored `name`. If another module
already holds the requested `module_name`, the server auto-suffixes
(`Garden-Hive-2`, `Garden-Hive-3`, …, capped at `-99`) — the echoed
value is the disambiguated form so the firmware can observe it.

A module with the same identifier is replaced.

**Validation errors (HTTP 400):**

- `module_name` longer than 100 chars — bounded by the Pydantic entry-
  point model so a non-colliding 200-char name cannot reach the DB
  (DuckDB does not enforce `VARCHAR(N)` lengths on its own).
- `esp_id` not 12 lowercase hex chars after canonicalisation — see
  issue #39.
- `battery_level` outside `[0, 100]`.

## 3.3 List modules

```
GET /modules
```

Returns the raw DB rows under `modules`:

```json
{
  "modules": [
    {
      "battery_level": 72,
      "first_online": "Wed, 11 Mar 2026 00:00:00 GMT",
      "id": "esp-9081726354",
      "lat": "48.52137",
      "lng": "9.05891",
      "name": "Garden-Hive"
    }
  ]
}
```

## 3.4 List nests

```
GET /nests
```

```json
{
  "nests": [{ "nest_id": "nest-001", "module_id": "hive-001", "beeType": "blackmasked" }]
}
```

## 3.5 List progress

```
GET /progress
```

```json
{
  "progress": [
    {
      "progress_id": "prog-001",
      "nest_id": "nest-001",
      "date": "Sat, 01 Jun 2024 00:00:00 GMT",
      "empty": 5,
      "sealed": 45,
      "hatched": 15
    }
  ]
}
```

`progress_id` and `hatched` are spelled correctly (a recent fix
corrected legacy `progess_id` / `hateched`).

## 3.6 Add classification result

```
POST /add_progress_for_module
Content-Type: application/json
```

```json
{
  "module_id": "aabbccddeeff",
  "classification": {
    "black_masked_bee": { "1": 1, "2": 1, "3": 0 },
    "orchard_bee": { "1": 0, "2": 1, "3": 1 }
  }
}
```

Returns `{ "success": true }`. Missing nests are auto-created. Progress
rows are inserted with the current date. The legacy typo `modul_id` is
still accepted via `AliasChoices` on
`duckdb-service/models/progress.py`'s `ClassificationOutput` as a
deprecation window — see
[08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).

## 3.7 Telemetry heartbeat

```
POST /heartbeat
Content-Type: application/x-www-form-urlencoded
```

Form fields:

| Field        | Type   | Notes                                                                                                                                                                                                          |
| ------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac`        | string | accepted in canonical 12-hex form, colon-separated, or dash-separated; canonicalised on the server (or `esp_id` alias)                                                                                         |
| `battery`    | int    | optional                                                                                                                                                                                                       |
| `rssi`       | int    | optional, dBm                                                                                                                                                                                                  |
| `uptime_ms`  | int    | optional, since last boot                                                                                                                                                                                      |
| `free_heap`  | int    | optional, bytes                                                                                                                                                                                                |
| `fw_version` | string | optional, ≤40 chars (a bee-name from `ESP32-CAM/VERSION`; see ADR-006)                                                                                                                                         |
| `latitude`   | float  | optional — geolocation-recovery field; only sent by firmware when its boot-time `getGeolocation` failed and the deferred retry has since succeeded (PR II / issue #89). Must be in `[-90, 90]` to be accepted. |
| `longitude`  | float  | optional, paired with `latitude`. Must be in `[-180, 180]`.                                                                                                                                                    |
| `accuracy`   | float  | optional, paired with `latitude`/`longitude`. Must be `> 0` (Google's "no fix" response is `accuracy: 0`, which the server treats as not-a-fix).                                                               |

The `mac` field is canonicalised to lowercase 12-hex via
`ModuleId.model_validate(...)` before the `INSERT`, mirroring the
`/upload` seam in `image-service/app.py`. Two clients sending
`AA:BB:CC:DD:EE:FF` and `aabbccddeeff` therefore land on the same
`module_id` PK rather than silently creating parallel rows.

Returns `{ "ok": true }`, `200`. Missing `mac` returns
`{ "error": "missing mac" }`, `400`. A `mac` value that does not
reduce to `[0-9a-f]{12}` returns `{ "error": "invalid mac format" }`,
`400`.

Side effects: a single `INSERT` into `module_heartbeats`. The
handler **also** UPDATEs `module_configs.lat`/`lng` (PR II / issue
#89) — but ONLY when ALL of the following are true:

1. The heartbeat carries plausible `latitude`/`longitude`/`accuracy`
   (the `_is_plausible_fix` rule: not `(0,0)`, not NaN, not out of
   range, `accuracy > 0`).
2. The existing `module_configs` row sits at the `(0,0)` sentinel.
   A deliberately-placed module is **never** clobbered — the rule
   is "only patch from (0,0)".

The handler does **not** touch `module_configs.updated_at` (that
column has dual semantics — see chapter-11 "updated_at semantic
overload" / issue #97). Implementation in the `heartbeat` route of
`duckdb-service/routes/heartbeats.py`.

This is the **telemetry heartbeat** fired hourly by firmware's
`sendHeartbeat` in `ESP32-CAM/client.cpp`. It is distinct from the post-upload
aggregate at `POST /modules/<id>/heartbeat` below — same word, different
endpoint, different body, different table. See
[../12-glossary/README.md](../12-glossary/README.md) "Heartbeat (telemetry)"
vs "Heartbeat (post-upload aggregate)".

## 3.8 Post-upload aggregate heartbeat

```
POST /modules/<module_id>/heartbeat
Content-Type: application/json
```

```json
{ "battery": 87 }
```

| Field     | Type | Notes           |
| --------- | ---- | --------------- |
| `battery` | int  | required, 0-100 |

Returns `{ "ok": true }`, `200`. Missing/invalid `battery` returns
`{ "error": "battery must be an int in [0, 100]" }`, `400`. Unknown
module returns `{ "error": "Module not found" }`, `404`.

Side effect (single `UPDATE` on `module_configs`):

- `battery_level` ← supplied value
- `image_count` ← `image_count + 1`
- `first_online` ← `COALESCE(first_online, today)` — only filled
  on the first call after a NULL; in practice the column is
  written by `add_module` at registration and the heartbeat
  leaves it alone (issue [#75](https://github.com/schutera/highfive/issues/75))

Does **not** insert into `module_heartbeats`. Called by `image-service`
after every accepted upload (`image-service/services/duckdb.py`'s
`heartbeat`). Implementation: `duckdb-service/routes/modules.py`'s
`heartbeat`.

## 3.9 Record image upload

```
POST /record_image
Content-Type: application/json
```

```json
{ "module_id": "aabbccddeeff", "filename": "esp_capture_20260511_143022.jpg" }
```

| Field       | Type   | Notes                                                                                                                    |
| ----------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `module_id` | string | canonicalised on the server via `ModuleId.model_validate(...)`; colon- and dash-separated MACs both accepted             |
| `filename`  | string | filename of the persisted image on the shared `duckdb_data` volume (image-service writes the bytes; this writes the row) |

Returns `{ "message": "Image recorded" }`, `200`. Missing either field
returns `{ "error": "module_id and filename required" }`, `400`. An
invalid `module_id` (does not reduce to `[0-9a-f]{12}` — e.g. raw
uint64 decimal stringification per the §3.2 rule) returns
`{ "error": "invalid module id" }`, `400`.

Side effect: a single `INSERT` into `image_uploads` with `module_id`,
`filename`, and a server-stamped `uploaded_at`. The `admin /api/images`
listing and the dashboard's `last_image_at` column on `/api/modules`
both join on this table.

Called by `image-service` after every successful `_persist_image` step
(`image-service/services/upload_pipeline.py`'s
`_record_image_upload`). The image bytes themselves are written
locally; this endpoint is what makes the upload visible to the rest of
the stack. Implementation: `duckdb-service/routes/modules.py`'s
`record_image`.

## 3.10 Module activity timeseries

```
GET /modules/<module_id>/activity_timeseries?interval=hourly&days=7
```

Bucketed image-upload counts for the dashboard `ActivityWeatherChart`.
The backend's `/api/modules/:id/activity` (§1.6) proxies this route and
renames the top-level `module_id` field to `moduleId` on the way out;
nested fields are camelCase already.

Query parameters:

- `interval` — `hourly` (default) or `daily`. Any other value returns
  `400`.
- `days` — integer in `[1, 90]`, default `7`. Out-of-range or
  non-integer returns `400`.

Empty buckets are filled server-side with `count: 0` so consumers
render a continuous timeline. Bucket-start timestamps are UTC ISO 8601.

```json
{
  "module_id": "aabbccddeeff",
  "interval": "hourly",
  "start": "2026-05-13T00:00:00",
  "end": "2026-05-20T00:00:00",
  "buckets": [
    { "timestamp": "2026-05-13T00:00:00", "count": 0 },
    { "timestamp": "2026-05-13T01:00:00", "count": 3 }
  ]
}
```

Error responses:

- `400` — invalid module id, invalid `interval`, or `days` out of range.
- `404` — module unknown.

Implementation: `duckdb-service/routes/modules.py`'s
`activity_timeseries`. Source table is `image_uploads`, filtered by
`module_id` and aggregated via `date_trunc('hour' | 'day',
uploaded_at)`. Adding a third granularity means a matching entry in
`INTERVAL_STEP` (in `routes/_bucketing.py`) and a new branch in the
`date_trunc` positional argument — both wired by the same `interval`
query param.

## 3.11 Module measurements timeseries

```
GET /modules/<module_id>/measurements?metric=battery_pct&interval=hourly&days=7
```

Bucketed read against the per-module `measurements` table (issue
#110). The backend's `/api/modules/:id/measurements` (§1.7) proxies
this route and rewrites `module_id` → `moduleId`, `sample_count` →
`sampleCount`.

Query parameters:

- `metric` — required.
- `interval` — `hourly` (default) or `daily`.
- `days` — `[1, 90]`, default `7`.

Empty buckets emit `value: null` and `sample_count: 0` (NOT `value:
0`). Bucket value is `AVG(value)`.

```json
{
  "module_id": "aabbccddeeff",
  "metric": "battery_pct",
  "interval": "hourly",
  "start": "2026-05-13T00:00:00",
  "end": "2026-05-20T00:00:00",
  "buckets": [
    { "timestamp": "2026-05-13T00:00:00", "value": null, "sample_count": 0 },
    { "timestamp": "2026-05-13T01:00:00", "value": 87.5, "sample_count": 2 }
  ]
}
```

Implementation: `duckdb-service/routes/measurements.py`'s
`get_measurements`. Shares bucketing helpers with §3.10 via
`routes/_bucketing.py`. Uses the same `::TIMESTAMP` cast on the
`date_trunc` result — see the chapter 11 entry "`date_trunc('day',
ts)` returns DATE not TIMESTAMP" for the incident.

## 3.12 Append measurements

```
POST /measurements
```

Append one or a batch of measurement rows. No service-level auth —
network-internal only (the backend proxy is the public boundary, and
gates with `X-Admin-Key`).

Body — single:

```json
{
  "module_mac": "aabbccddeeff",
  "ts": "2026-05-20T12:00:00Z",
  "metric": "temperature_c",
  "value": 18.4,
  "source": "weather-api"
}
```

Body — batched (≤ 1000):

```json
{
  "measurements": [
    {"module_mac": "...", "ts": "...", "metric": "...", "value": 1.0, "source": "..."},
    ...
  ]
}
```

Response (200 OK):

```json
{ "inserted": 2 }
```

Validation rejects the entire batch on any item failure (400 with
the failing item's `index` in the response body). Implementation:
`duckdb-service/routes/measurements.py`'s `post_measurements`.

<br>

# 4. Firmware artifacts (homepage static)

Served directly from `homepage/public/` by the homepage's static
asset path (Vite dev server in dev, host-nginx in prod). No
authentication — same exposure as any other homepage static.
Consumed by the web installer (merged bin) and by ESP32-CAM modules
running OTA-capable firmware (app-only bin + manifest). All three
artifacts are regenerated by `bash ESP32-CAM/build.sh` from the
current `ESP32-CAM/VERSION` value.

## 4.1 Firmware manifest

```
GET /firmware.json
```

**Response** (200 OK):

```json
{
  "version": "carpenter",
  "md5": "1234567890abcdef1234567890abcdef",
  "built_at": "2026-05-13T10:00:00+00:00",
  "app_md5": "abcdef1234567890abcdef1234567890",
  "app_size": 1048576
}
```

- `version` — bee-species name per
  [ADR-006](09-architecture-decisions/adr-006-bee-name-firmware-versioning.md).
  Used by the OTA fetch path to decide whether to download.
- `md5` — MD5 of the **merged** `firmware.bin` (bootloader +
  partitions + boot_app0 + app). Used by the web installer for
  integrity check before flashing.
- `built_at` — ISO-8601 build timestamp.
- `app_md5` — MD5 of the **app-only** `firmware.app.bin`. Used by
  the OTA fetch path; `Update.setMD5()` verifies this against the
  rolling MD5 computed during flash write. A mismatch leaves the
  inactive slot unbootable, no rollback needed.
- `app_size` — byte length of `firmware.app.bin`. The firmware
  rejects an `app_size` larger than 1.9 MB at parse time as a
  defence against a malformed manifest.

## 4.2 Merged firmware binary (web installer)

```
GET /firmware.bin
```

Bootloader + partitions + boot_app0 + app, merged into one image.
Used by the web installer (`/web-installer`) to flash a blank ESP32-
CAM via the Chrome Web Serial API. Includes the partition table, so
this is the artifact that performs the first-time OTA migration
(default → `min_spiffs` layout) per
[ADR-008](09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md).

## 4.3 App-only firmware binary (HTTP OTA)

```
GET /firmware.app.bin
```

Application image alone (no bootloader, no partitions). Used by the
firmware's boot-time OTA fetch path
([`ESP32-CAM/ota.cpp`](../ESP32-CAM/ota.cpp)'s `httpOtaCheckAndApply`)
via `Update.write()`. Not flashable by the web installer — the web
installer needs the merged `firmware.bin` because a blank module has
no bootloader yet.

# 5. Typical Workflow

1. (Once) Seed the DB — set `SEED_DATA=true` on the duckdb-service.
2. Field module boots and calls `POST /new_module` against `duckdb-service`.
3. Module starts uploading via `POST /upload` to `image-service` (with `logs`).
4. `image-service` writes the image + sidecar, classifies (stub), and
   forwards to `duckdb-service /add_progress_for_module`.
5. Frontend reads `GET /api/modules` + `/api/modules/:id` from the
   backend, which reads from `duckdb-service`.
6. Operators inspect telemetry via `?admin=1` on the dashboard, which
   calls `GET /api/modules/:id/logs` with `X-Admin-Key`.
