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
    IMG->>IMG: HoleDetector.detect() — ONNX model locates holes, crop snips (undetermined)<br/>(classification deferred → stub_classify() drives the progress bars)
    IMG->>DDB: POST /add_progress_for_module (stub values — model localizes only)
    DDB->>DDB: insert/replace daily_progress row
    IMG->>IMG: write per-nest snips to /data/images/snips/
    IMG->>DDB: POST /record_detections<br/>(snips + bboxes + state per hole, #165)
    DDB->>DDB: insert nest_detections rows
    IMG->>DDB: POST /modules/&lt;mac&gt;/heartbeat<br/>(post-upload aggregate, body: {battery})
    DDB->>DDB: update battery, image_count (first_online COALESCE-guarded, #75)
    IMG-->>ESP: 200 OK

    Note over ESP,DDB: independently, hourly
    ESP->>DDB: POST /heartbeat<br/>(telemetry, body: mac, battery, rssi, uptime_ms, free_heap, fw_version,<br/>optional latitude/longitude/accuracy when deferred-retry recovered)
    DDB->>DDB: BEGIN; insert row in module_heartbeats
    DDB->>DDB: if battery is not None: insert measurements(metric=battery_pct, source=esp-heartbeat) (#110)
    DDB->>DDB: if lat/lng/accuracy plausible AND existing config row at (0,0): UPDATE module_configs (#89)
    DDB->>DDB: COMMIT (either all three writes land, or none do)

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
> `mac/battery/rssi/uptime_ms/free_heap/fw_version` plus the optional
> `latitude/longitude/accuracy` triplet attached by `sendHeartbeat`
> only when `hasPendingGeolocationFixToReport()` is true (PR II /
> issue #89: the firmware's deferred-retry path obtained a fix
> mid-uptime after a failed boot getGeolocation). The handler runs
> all its writes inside one explicit BEGIN/COMMIT
> (`db/repository.py`'s `write_transaction`): a row into
> `module_heartbeats`; a sibling row into `measurements` with
> `metric='battery_pct'` and `source='esp-heartbeat'` when the
> heartbeat carries a battery (issue #110 dual-write — see
> [measurement-write-flow.md](measurement-write-flow.md) and
> [ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md));
> and — if the optional lat/lng arrived plausible AND the existing
> `module_configs` row sits at the `(0,0)` sentinel — an UPDATE on
> `module_configs.lat`/`lng`. The "only patch from (0,0)" rule means
> a deliberately-placed module is never clobbered. `heartbeat` route
> in `duckdb-service/routes/heartbeats.py`; `sendHeartbeat` in
> `ESP32-CAM/client.cpp`. It is the source of `latestHeartbeat`
> /`HeartbeatSnapshot` ([ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md)).
>
> See the glossary entries "Heartbeat (telemetry)" and
> "Heartbeat (post-upload aggregate)".

## Step-by-step

0. **Capture.** ESP32-CAM captures an image at **two triggers only**:
   once on boot (the first-capture-on-boot, skipped on the silent
   daily reboot) and once a day at **local noon** — both in
   [`ESP32-CAM/ESP32-CAM.ino`](../../ESP32-CAM/ESP32-CAM.ino)'s `loop`.
   Each builds a JSON telemetry payload: firmware version, uptime,
   free heap, RSSI, last reset reason, last HTTP codes, the last ~2 KB
   of the on-device circular log buffer.

   > **Scheduled capture re-primes the camera (#143).** The boot
   > capture is preceded by the full camera bring-up in `setup()`
   > (PWDN power-cycle → `esp_camera_init` → sensor config → 3-frame
   > auto-exposure warm-up), so a restart reliably yields a
   > well-exposed frame. The **noon** capture used to be a bare single
   > `esp_camera_fb_get()` after ~8 h of sensor idle, and a field
   > module then uploaded near-black noon frames while a restart always
   > produced a good image. `loop()`'s noon branch now calls
   > `primeCameraLikeBoot()` — a PWDN power-cycle + reinit
   > (`recoverCameraSoft()`, the **non-aborting** variant) + 3-frame
   > warm-up, the same cold-start the boot path runs — immediately
   > before the grab, so the daily image takes the proven-good path. It
   > is fail-safe: a reinit failure skips that day's capture and retries
   > next loop rather than `abort()`-ing, so the mitigation can never
   > panic a marginal board at noon. A bench A/B could **not** reproduce
   > the black frame on healthy hardware (neither the missing warm-up
   > nor the VGA/DRAM fallback path), so the root cause is most likely
   > the field board's marginal PSRAM/power and this is an _unvalidated
   > mitigation_ — see [chapter 11 → Lessons
   > learned](../11-risks-and-technical-debt/README.md#lessons-learned).

   > **Onboarding precondition.** Before any of this runs, the module
   > must be onboarded once. The captive portal at `http://192.168.4.1`
   > (setup/AP mode) now asks the operator for **Wi-Fi SSID and password
   > only** — everything else is assigned under the hood: the module
   > name is derived from the MAC (`ESP32-CAM/esp_init.cpp`'s
   > `generateModuleName`), the `INIT_URL` / `UPLOAD_URL` come from the
   > build-time defaults applied in `ESP32-CAM/esp_init.cpp`'s
   > `loadConfig`, and camera settings come from
   > `ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`. Reconfigure
   > is by re-flash (which erases the saved config). See
   > [ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md)
   > and the
   > [onboarding guide](../07-deployment-view/esp-flashing.md).

1. **Upload.** Device sends multipart `POST /upload` to
   `image-service` with form fields `image` (the JPEG), `mac` (the
   module identifier), `battery` (0–100), and optional `logs`
   (telemetry JSON). When `UPLOAD_URL` has scheme `https://`
   (production default since [ADR-010](../09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md)
   on `mason`+), the request travels through a TLS-pinned
   `WiFiClientSecure` reusing a module-level keep-alive socket.
   The first connect after boot pays a ~1–2 s handshake + ~30 KB
   transient heap; subsequent uploads reuse the TLS session.
   LAN-dev topologies (`http://10.0.0.5:8000/upload`) route through
   plain `WiFiClient` because dev-box services do not terminate TLS;
   the scheme of the saved `UPLOAD_URL` drives the dispatch at
   [`ESP32-CAM/client.cpp`'s `postImage`](../../ESP32-CAM/client.cpp).

2. **Image-service ingestion.**
   - Saves the JPEG to the shared `duckdb_data` volume.
   - Records the upload row via duckdb-service (see step 3).
   - If `logs` is parseable, writes a `<image>.log.json` sidecar next
     to the image as a `LogSidecarEnvelope` (`mac`, `received_at`,
     `image`, `payload`). Unparseable logs are preserved with a
     `parse_error: true` marker inside `payload` (the image itself
     still persists).
   - Runs `HoleDetector.detect()` (#165,
     [ADR-027](../09-architecture-decisions/adr-027-hole-detection-model.md)): the
     learned **YOLO26n-seg** model (ONNX via `onnxruntime`) locates every nest
     hole and a per-hole snip is cropped to `/data/images/snips/` with `state =
"undetermined"`. The model only **localizes** — empty-vs-sealed is deferred —
     so `classification` is left empty and the historical `stub_classify()` still
     produces the `{bee_type: {nest: 0|1}}` progress values. If detection finds
     nothing (unreadable image, missing/broken model) it likewise degrades to the
     stub, so a detection miss never blanks the dashboard and `/upload` never 500s.

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
   - `POST /record_detections` — inserts the per-hole snip rows
     (`nest_detections`: bee type, nest index, normalized bbox, state,
     confidence, snip filename). Best-effort and **non-fatal but logged**,
     like `record_image`: snips are written to disk first, so a DB failure
     leaves the JPEGs recoverable. Backs the public snip grid (#165).
   - `POST /modules/<mac>/heartbeat` — **post-upload aggregate**:
     updates `battery_level` and `image_count` on `module_configs`.
     `first_online` is `COALESCE`-guarded (issue
     [#75](https://github.com/schutera/highfive/issues/75)) so the
     heartbeat leaves a set value alone — the column means "date of
     first registration" again, written by `add_module` at
     registration. Body is `{battery}` only.

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
var — battery / `image_count` updates (and the rarely-fired
`first_online` write under the COALESCE guard, #75) go through
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
