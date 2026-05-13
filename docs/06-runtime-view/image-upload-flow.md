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
    IMG->>DDB: GET /modules/&lt;mac&gt;/progress_count
    DDB-->>IMG: count (used for first-upload detection)
    IMG->>IMG: save image to /data/images
    IMG->>DDB: POST /record_image<br/>(body: {module_id, filename})
    DDB->>DDB: insert image_uploads row (uploaded_at server-stamped)
    IMG->>IMG: write &lt;img&gt;.log.json sidecar (if logs present)
    IMG->>IMG: stub_classify()
    IMG->>DDB: POST /add_progress_for_module
    DDB->>DDB: insert/replace daily_progress row
    IMG->>DDB: POST /modules/&lt;mac&gt;/heartbeat<br/>(post-upload aggregate, body: {battery})
    DDB->>DDB: update battery, image_count, first_online
    IMG-->>ESP: 200 OK

    Note over ESP,DDB: independently, hourly
    ESP->>DDB: POST /heartbeat<br/>(telemetry, body: mac, battery, rssi, uptime_ms, free_heap, fw_version)
    DDB->>DDB: insert row in module_heartbeats

    Note over BR,DDB: later, on dashboard poll
    BR->>DDB: GET /modules /nests /progress<br/>(via backend, normalised)
    DDB-->>BR: normalised DTOs → render
```

> **Two endpoints, both named "heartbeat".** The
> `POST /modules/<mac>/heartbeat` call shown in the upload sequence is
> the **post-upload aggregate** — fired by image-service after every
> accepted upload, body `{battery}` only, updates `module_configs`
> (`duckdb-service/routes/modules.py`'s `heartbeat`,
> `image-service/services/duckdb.py`'s `heartbeat`).
>
> The hourly `POST /heartbeat` fired directly by firmware is the
> **telemetry heartbeat** — body
> `mac/battery/rssi/uptime_ms/free_heap/fw_version`, inserts a row
> into `module_heartbeats` (`heartbeat` route in
> `duckdb-service/routes/heartbeats.py`; `sendHeartbeat` in
> `ESP32-CAM/client.cpp`). It is the source of `latestHeartbeat`
> /`HeartbeatSnapshot` ([ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md)).
>
> See the glossary entries "Heartbeat (telemetry)" and
> "Heartbeat (post-upload aggregate)".

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
   - Records the upload row via duckdb-service (see step 3).
   - If `logs` is parseable, writes a `<image>.log.json` sidecar next
     to the image as a `LogSidecarEnvelope` (`mac`, `received_at`,
     `image`, `payload`). Unparseable logs are preserved with a
     `parse_error: true` marker inside `payload` (the image itself
     still persists).
   - Runs `stub_classify()` — returns random 0/1 per (bee_type, nest
     index). This is a placeholder; the contract shape is what
     MaskRCNN will fill.

3. **Persistence write-back.**
   `image-service` calls `duckdb-service` over HTTP (never opens its
   own DuckDB connection — see
   [ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md)).
   In call order:
   - `GET /modules/<mac>/progress_count` — fires first, before the
     image is even saved. Used to detect first-upload events for new
     modules so the Discord ping only fires once per module's lifetime.
   - `POST /record_image` — inserts an `image_uploads` row tying the
     filename on disk to its `module_id`. The admin page and the
     dashboard's `last_image_at` both join on this table. Failure is
     **non-fatal but logged**: the file is on disk and the rest of
     the pipeline still runs, but without the row the upload is
     invisible to admin and the dashboard. The `[record_image]` log
     line is the on-call's signal that an orphaned file exists.
   - `POST /add_progress_for_module` — inserts or replaces a
     `daily_progress` row for today. Missing nests are auto-created.
   - `POST /modules/<mac>/heartbeat` — **post-upload aggregate**:
     updates `battery_level`, `image_count`, and `first_online` on
     `module_configs`. Body is `{battery}` only.

4. **Read.** A browser polling `/api/modules` from the dashboard
   picks up the new row on its next request via the
   [dashboard read flow](README.md#dashboard-read-flow).

5. **Independent telemetry channel.** Once an hour the firmware fires
   `POST /heartbeat` directly to `duckdb-service` with its own body
   shape (mac, battery, rssi, uptime_ms, free_heap, fw_version). Each
   call inserts a row into `module_heartbeats`; the most recent row is
   surfaced on `Module.latestHeartbeat`
   ([ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md)).
   This path does not run on every upload and is not gated by image
   uploads succeeding. A **boot-time heartbeat** also fires from
   `ESP32-CAM/ESP32-CAM.ino`'s `setup` immediately after
   `initNewModuleOnServer` returns (fail-quiet — fires regardless of
   the registration call's outcome, defence-in-depth for the case
   where registration's HTTP POST failed), before the slow camera
   init — the #15 fix that lets the dashboard reflect a reflashed or
   daily-rebooted module within seconds rather than after the next
   capture.

## Persistence invariant

All DuckDB writes flow through `duckdb-service`. `image-service` no
longer opens its own DuckDB connection and has no `DUCKDB_PATH` env
var — battery / `image_count` / `first_online` updates go through
`POST /modules/<mac>/heartbeat` (the post-upload aggregate), and
first-upload detection uses `GET /modules/<mac>/progress_count`.
`image-service` still writes images and `.log.json` sidecars to the
shared volume locally; only the DB writes are HTTP. See
[ADR-001](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md).

## Field-name drift to watch

The `POST /add_progress_for_module` payload carries the canonical
`module_id` on the wire. The legacy typo `modul_id` (missing "e") is
still accepted by `duckdb-service/models/progress.py`'s
`ClassificationOutput` via Pydantic `AliasChoices` as a deprecation
window for any in-flight callers that still emit the old key; new
emitters must use `module_id`. The alias will be removed once
nothing in the tree references it — see
[08-crosscutting-concepts/api-contracts.md](../08-crosscutting-concepts/api-contracts.md).
