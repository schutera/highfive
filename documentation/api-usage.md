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
    "id": "hive-001",
    "name": "Klostergarten",
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

`status` is computed from `first_online`: a module is `online` if the
last DB date is within 24 h, else `offline`.

## 1.3 Module detail

```
GET /api/modules/:id
Headers: X-API-Key: <key>
```

Same shape as above, plus a `nests` array of `NestData`. Each nest
carries `dailyProgress[]` with `progress_id`, `nest_id`, `date`,
`empty`, `sealed`, `hatched`. 404 if the module is unknown.

## 1.4 Module telemetry logs (admin)

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
    "fw": "1.0.0",
    "uptime_s": 72145,
    "last_reset_reason": "TASK_WDT",
    "free_heap": 124352,
    "min_free_heap": 98211,
    "rssi": -67,
    "wifi_reconnects": 2,
    "last_http_codes": [200, 200, 500, 200, 200],
    "log": "[BOOT] fw=1.0.0 ...",
    "_mac": "12345678901234",
    "_received_at": "2026-04-11T14:32:17",
    "_image": "esp_capture_20260411_143217.jpg"
  }
]
```

The telemetry section in the dashboard is hidden unless the URL has
`?admin=1`; see [esp-reliability.md](esp-reliability.md) for the
end-to-end admin flow.

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

| Field     | Type | Required | Description                                                        |
| --------- | ---- | -------- | ------------------------------------------------------------------ |
| `image`   | File | Yes      | Captured JPEG                                                      |
| `mac`     | Text | Yes      | Module identifier                                                  |
| `battery` | Text | Yes      | Integer 0–100                                                      |
| `logs`    | Text | No       | JSON telemetry payload (see [esp-reliability](esp-reliability.md)) |

If `logs` is present and parseable, it is written to
`{image_path}.log.json` next to the saved image with three extra
fields appended (`_mac`, `_received_at`, `_image`). Unparseable
payloads are still saved as `{ "raw": ..., "parse_error": true, ... }`.

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

Reads `*.log.json` sidecars on disk, filters by `_mac`, sorts by mtime
descending, and returns the newest N (default 10, max 100). Used by the
backend admin proxy in section 1.5.

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
  "mac": "esp-9081726354",
  "module_name": "Garden-Hive",
  "latitude": 48.52137,
  "longitude": 9.05891,
  "battery": 72
}
```

Returns:

```json
{ "id": "esp-9081726354", "message": "Module added successfully" }
```

A module with the same identifier is replaced.

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
      "name": "Garden-Hive",
      "status": "online"
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
  "modul_id": "esp-9081726354",
  "classification": {
    "black_masked_bee": { "1": 1, "2": 1, "3": 0 },
    "orchard_bee": { "1": 0, "2": 1, "3": 1 }
  }
}
```

Returns `{ "success": true }`. Missing nests are auto-created. Progress
rows are inserted with the current date.

<br>

# 4. Typical Workflow

1. (Once) Seed the DB — set `SEED_DATA=true` on the duckdb-service.
2. Field module boots and calls `POST /new_module` against `duckdb-service`.
3. Module starts uploading via `POST /upload` to `image-service` (with `logs`).
4. `image-service` writes the image + sidecar, classifies (stub), and
   forwards to `duckdb-service /add_progress_for_module`.
5. Frontend reads `GET /api/modules` + `/api/modules/:id` from the
   backend, which reads from `duckdb-service`.
6. Operators inspect telemetry via `?admin=1` on the dashboard, which
   calls `GET /api/modules/:id/logs` with `X-Admin-Key`.
