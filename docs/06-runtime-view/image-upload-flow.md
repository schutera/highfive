# Image upload flow

The end-to-end path of a single image from an ESP32-CAM module to the
dashboard. This is HiveHive's primary write flow.

## Sequence

```mermaid
sequenceDiagram
    participant ESP as ESP32-CAM
    participant IMG as image-service
    participant DDB as duckdb-service
    participant BR as browser

    ESP->>ESP: capture, build telemetry
    ESP->>IMG: POST /upload<br/>(multipart: image, mac, battery, logs)
    IMG->>IMG: save image + write &lt;img&gt;.log.json
    IMG->>IMG: stub_classify()
    IMG->>DDB: POST /add_progress_for_module
    DDB->>DDB: insert/replace daily_progress row
    IMG->>DDB: POST /modules/&lt;mac&gt;/heartbeat
    DDB->>DDB: update battery, image_count, first_online
    IMG->>DDB: GET /modules/&lt;mac&gt;/progress_count
    DDB-->>IMG: count (used for first-upload detection)
    IMG-->>ESP: 200 OK

    Note over BR,DDB: later, on dashboard poll
    BR->>DDB: GET /modules /nests /progress<br/>(via backend, normalised)
    DDB-->>BR: normalised DTOs → render
```

## Step-by-step

0. **Capture.** ESP32-CAM captures an image on its configured
   interval (typically every few minutes). Builds a JSON telemetry
   payload: firmware version, uptime, free heap, RSSI, last reset
   reason, last HTTP codes, the last ~2 KB of the on-device circular
   log buffer.

1. **Upload.** Device sends multipart `POST /upload` to
   `image-service` with form fields `image` (the JPEG), `mac` (the
   module identifier), `battery` (0–100), and optional `logs`
   (telemetry JSON).

2. **Image-service ingestion.**
   - Saves the JPEG to the shared `duckdb_data` volume.
   - If `logs` is parseable, writes a `<image>.log.json` sidecar next
     to the image with three appended envelope fields: `_mac`,
     `_received_at`, `_image`. Unparseable logs are dropped (the image
     itself still persists).
   - Runs `stub_classify()` — returns random 0/1 per (bee_type, nest
     index). This is a placeholder; the contract shape is what
     MaskRCNN will fill.

3. **Persistence write-back.**
   `image-service` calls `duckdb-service` over HTTP (never opens its
   own DuckDB connection — see
   [ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md)):
   - `POST /add_progress_for_module` — inserts or replaces a
     `daily_progress` row for today. Missing nests are auto-created.
   - `POST /modules/<mac>/heartbeat` — updates `battery_level`,
     `image_count`, and `first_online`.
   - `GET /modules/<mac>/progress_count` — used to detect first-upload
     events for new modules.

4. **Read.** A browser polling `/api/modules` from the dashboard
   picks up the new row on its next request via the
   [dashboard read flow](README.md#dashboard-read-flow).

## Persistence invariant

All DuckDB writes flow through `duckdb-service`. `image-service` no
longer opens its own DuckDB connection and has no `DUCKDB_PATH` env
var — battery / `image_count` / `first_online` updates go through
`POST /modules/<mac>/heartbeat`, and first-upload detection uses
`GET /modules/<mac>/progress_count`. `image-service` still writes
images and `.log.json` sidecars to the shared volume locally; only the
DB writes are HTTP. See
[ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).

## Field-name drift to watch

The `POST /add_progress_for_module` payload carries `modul_id` (typo,
kept on the wire for compatibility), not `module_id`. Don't "fix" it
without updating both ends in lockstep. See
[08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).
