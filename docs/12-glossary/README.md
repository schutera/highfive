# 12. Glossary

Domain glossary for the HiveHive bee-monitoring monorepo. Establishes
canonical terms for the four services (`homepage`, `backend`,
`image-service`, `duckdb-service`) plus the `ESP32-CAM` edge firmware,
and flags the synonyms, typos, and overloads that have caused bugs.

## Devices and physical entities

| Term            | Definition                                                                                                         | Aliases to avoid                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Module**      | One ESP32-CAM-equipped HiveHive box deployed in the field; the unit of registration, identification and reporting. | hive, hive-module, hivemodule, ESP, device, esp_id (when meaning the module) |
| **Hive Module** | UI-facing synonym for **Module**; only used in marketing / setup-wizard copy and the `/hive-module` page.          | hivemodule (one word)                                                        |
| **Nest**        | One nesting tube inside a module, owned by exactly one **Module** and tied to exactly one **Bee Type**.            | nesting tube, nesting hole, nesting site, nesting cell, hole                 |
| **Cell**        | A countable observation slot inside a nest's daily snapshot — `empty`, `sealed` or `hatched` are counts of cells.  | hole (when used for the count)                                               |
| **Bee Type**    | The species classification assigned to a nest. One of `blackmasked`, `leafcutter`, `orchard`, `resin`.             | bee species (free prose), beetype, bee_type                                  |

## Identity

| Term                     | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Aliases to avoid                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **MAC**                  | The ESP32-CAM's WiFi MAC address; the canonical, immutable identifier of a **Module**. Sent as the multipart `mac` field on `/upload`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | esp_id, device id (in prose)                        |
| **module_id**            | The string used as `module_configs.id` and as the foreign key on `nest_data`. Equal in value to **MAC**; this is the DB-facing name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | id (bare), modul_id (typo), hive id                 |
| **name** (Module)        | The **firmware-reported** module name. Generated from the ESP MAC by `hf::moduleNameFromMac` (`ESP32-CAM/lib/module_name/`) on first boot or overridden via the captive portal's "Module Name" field. UPSERTed on every registration call. Server-side auto-suffixed (`-2`, `-3`, …) on collision with another module's `name`. NOT user-friendly by default and NOT guaranteed unique long-term — see `displayName` for the operator-stable label. `module_configs.name` / `Module.name`.                                                                                                                     | label (overloaded), display label (use displayName) |
| **displayName** (Module) | The **admin-settable** module label, UNIQUE per module. Null when no operator has renamed the module. Frontend surfaces resolve the operator-visible label via [`homepage/src/lib/displayLabel.ts`](../../homepage/src/lib/displayLabel.ts), which trims and falls back to `name` on null/empty/whitespace-only. Set via `PATCH /api/modules/:id/name`; cleared by sending `null` (or empty string). UNIQUE-enforced at the database (`uq_module_configs_display_name`), 409 on collision. `module_configs.display_name`. See [ADR-011](../09-architecture-decisions/adr-011-module-display-name-override.md). | label, alias (avoid — use displayName)              |
| **nest_id**              | The string PK of `nest_data`; format `nest-NNN`. Used identically across backend, frontend, and DB (`nestId` synonym resolved 2026-04-26).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | nestId (resolved — homepage now uses snake_case)    |
| **progress_id**          | The string PK of `daily_progress`. UUID for new rows, `prog-NNN` for seed data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | progess_id (typo, fixed in 778c9b1)                 |

## Module state and telemetry

| Term                                  | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Aliases to avoid                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Status**                            | The Module's reachability flag, surfaced on the dashboard as `'online' \| 'offline' \| 'unknown'`. **Derived**, not stored — computed in `backend/src/database.ts`'s `fetchAndAssemble` from the freshest of `image_uploads.uploaded_at`, `module_configs.updated_at`, and `module_heartbeats.received_at` with a 2 h window. (A `module_configs.status` column used to exist but was dead weight; dropped in the PR that closed [#69](https://github.com/schutera/highfive/issues/69).) Module-only — not used on nests or progress. | state                                                              |
| **Battery Level**                     | Module's last reported battery percentage (0-100). Persisted on `module_configs.battery_level`; surfaced as `batteryLevel` in the frontend DTO.                                                                                                                                                                                                                                                                                                                                                                                       | battery (in DTO field names; allowed in payloads)                  |
| **First Online**                      | Calendar date the module was first registered. Set by `add_module` at registration time; `COALESCE`-guarded against rewrites in the per-upload heartbeat handler (fixed in [#75](https://github.com/schutera/highfive/issues/75) — previously the column was clobbered to today on every upload). `module_configs.first_online`.                                                                                                                                                                                                      | registered_at, registration_date                                   |
| **Last API Call**                     | Timestamp of the module's most recent contact with the backend / image-service. Surfaced as `lastApiCall` on the frontend `Module` DTO.                                                                                                                                                                                                                                                                                                                                                                                               | last_seen, lastSeen                                                |
| **Image Count**                       | Total accepted uploads for a module. Maintained by the **post-upload aggregate heartbeat** on `module_configs.image_count`. Surfaced as `imageCount`.                                                                                                                                                                                                                                                                                                                                                                                 | upload_count, total_images                                         |
| **Heartbeat (post-upload aggregate)** | `POST /modules/<module_id>/heartbeat` (`duckdb-service/routes/modules.py`'s `heartbeat`). Fired by `image-service` after every accepted upload (`image-service/services/duckdb.py`'s `heartbeat`). Body: `{battery}` only. Updates `module_configs.battery_level` and increments `image_count`; `first_online` is `COALESCE`-guarded so it is only filled on the first call after a NULL (issue #75). **Not** the same endpoint as the telemetry heartbeat.                                                                           | keepalive, ping (avoid — name-collides with telemetry)             |
| **Heartbeat (telemetry)**             | `POST /heartbeat` (`heartbeat` route in `duckdb-service/routes/heartbeats.py`). Fired hourly by firmware's `sendHeartbeat` (`ESP32-CAM/client.cpp`). Body: `mac/rssi/uptime_ms/free_heap/fw_version` (`carpenter`+ omits `battery` — no ADC sensing; the server still accepts it as optional). Inserts a row in `module_heartbeats`; the most recent row is surfaced on `Module.latestHeartbeat` as a [`HeartbeatSnapshot`](#telemetry-and-admin) — see ADR-004.                                                                      | keepalive, ping (avoid — name-collides with post-upload aggregate) |
| **Progress Count**                    | Number of `daily_progress` rows for a given module, returned by `GET /modules/<module_id>/progress_count`. Used to detect first-upload events.                                                                                                                                                                                                                                                                                                                                                                                        | progress_total                                                     |

## Daily progress lifecycle

| Term               | Definition                                                                                                                              | Aliases to avoid                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Daily Progress** | One row in `daily_progress`: a (nest, date) snapshot with cell counts. The atomic record that drives every dashboard chart.             | progress entry, daily entry                                           |
| **Empty**          | Count of empty cells in the nest on that date. `daily_progress.empty`.                                                                  | open                                                                  |
| **Sealed**         | Percentage (0-100) of sealed cells in the nest on that date. _Stored as a percentage, not a count, despite sitting next to two counts._ | filled (avoid; "filled" is used loosely in image-service for raw 1/0) |
| **Hatched**        | Count of hatched cells in the nest on that date. `daily_progress.hatched`.                                                              | hateched (typo, fixed in 778c9b1)                                     |
| **Total Hatches**  | Module-level rollup: sum of `hatched` over all nests, surfaced as `totalHatches` on the `Module` DTO.                                   | total_hatched                                                         |

## Classification

| Term                      | Definition                                                                                                                                                                                                                                                                                          | Aliases to avoid                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **Classification**        | The act (and result) of converting an uploaded image into per-nest cell-state values. Currently deferred — the learned `HoleDetector` (#165, ADR-027) localizes holes but does not call empty/sealed, so the `stub_classify()` fallback drives the progress bars until a classifier lands.          | inference, prediction (free prose only) |
| **Classification Output** | The JSON payload the image-service POSTs to `/add_progress_for_module`. Pydantic model `ClassificationOutput`.                                                                                                                                                                                      | progress payload                        |
| **Stub Classifier**       | The placeholder `stub_classify()` returning random 0/1 per (bee_type, nest index). Drives the species progress bars whenever the detector returns no classification — currently always, since the learned `HoleDetector` localizes but defers empty/sealed (ADR-027), and also on a detection miss. | dummy classifier                        |
| **Hole detection**        | Locating the nest holes in a capture with the learned YOLO26n-seg model (ONNX via `onnxruntime`) and labelling each by bee type (measured diameter). The user-facing name for what produces a **Snip**. Empty/sealed is deferred (snips are `undetermined`). Issue #165, ADR-027.                   | —                                       |
| **Snip**                  | A cropped image of a single nest hole, stored per upload in `nest_detections` and served publicly at `/api/snips/:filename`. The crop is the privacy mechanism (#154): no garden/house background, so it needs no auth. Wire shape `NestSnip`.                                                      | cutout, thumbnail, crop (in prose OK)   |

## Telemetry and admin

| Term                          | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Aliases to avoid                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Telemetry**                 | Structured device-health JSON (firmware version, uptime, free heap, RSSI, reset reason, last HTTP codes, on-device log tail) the ESP attaches as the `logs` form field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | logs (overloaded — see ambiguities)                    |
| **Log Sidecar**               | The `<image>.log.json` file image-service writes next to each saved image, holding the parsed **Telemetry** plus `_mac`, `_received_at`, `_image`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | log file, telemetry file                               |
| **HeartbeatSnapshot**         | Wire shape (in `@highfive/contracts`) of one **telemetry** heartbeat row — `receivedAt`, `battery`, `rssi`, `uptimeMs`, `freeHeap`, `fwVersion`. Sourced from `module_heartbeats` (written via `POST /heartbeat`). Latest is surfaced on `Module.latestHeartbeat`. See [ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).                                                                                                                                                                                                                                                                                                                                                                                                                      | heartbeat payload                                      |
| **Silence Watcher**           | Background thread inside `duckdb-service` that fires Discord alerts when a module is silent for >3h and a recovery message when it returns. See [ADR-005](../09-architecture-decisions/adr-005-silence-watcher-in-duckdb-service.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | offline watcher                                        |
| **Bee-name version**          | Firmware version identifier of the form `bumblebee` / `honeybee` / `mason` / `carpenter`. **Single writer:** `ESP32-CAM/VERSION`. Both build paths inject its value as `-DFIRMWARE_VERSION=<value>` (`build.sh` → arduino-cli; `pio run -e esp32cam` → PlatformIO via `extra_scripts.py`). The macro is read by `ESP32-CAM.ino` (boot log), `logbuf.cpp` (telemetry sidecar `fw`), and `client.cpp`'s `sendHeartbeat` (heartbeat body); `build.sh` separately writes the same string into `homepage/public/firmware.json` for the OTA manifest. See [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md).                                                                                                                                            | firmware tag                                           |
| **Task Watchdog**             | The `esp_task_wdt_*` timer that reboots the ESP if `loop()` doesn't feed it within `TASK_WDT_TIMEOUT_S` seconds (currently **60 s**, bumped from 30 s in PR-17 review commit `ea7dc73`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | wdt                                                    |
| **Circuit Breaker (ESP)**     | `static uint8_t consecutiveFailures` in `captureAndUpload` (`ESP32-CAM/ESP32-CAM.ino`). Counts consecutive **upload-path** failures of any kind (camera NULL, WiFi down, HTTP non-2xx); at >= 5 it calls `delay(1000); ESP.restart()` immediately. The heartbeat status code is **not** wired in — only upload outcomes are counted. See [ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md).                                                                                                                                                                                                                                                                                                                                           | failure counter                                        |
| **Daily Reboot**              | The 24-hour-uptime auto-restart, with NVS-flagged capture-skip on the wake boot so the daily image cost isn't doubled. Flag lives in NVS namespace `"boot"` key `daily_reboot` — written in `loop()` and read+cleared in `setup()` (both in `ESP32-CAM/ESP32-CAM.ino`; grep for `daily_reboot`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | scheduled reboot                                       |
| **Admin Gate**                | The `requireAdmin` middleware (#142 / ADR-019) on write/admin routes (`DELETE`, `PATCH …/name`, `POST …/measurements`, `POST …/weather/backfill`, `GET …/logs`): a valid `hf_admin_session` cookie OR an `X-Admin-Key` header. The frontend `?admin=1` flag in `sessionStorage['hf_admin']` only reveals the affordance.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | admin auth                                             |
| **AdminKeyForm**              | Inline React form that collects the admin password and logs in via `api.login()` → `POST /api/admin/login` (#142 / ADR-019; originally collected the key for an `X-Admin-Key` header, PR 17 `5b110de`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | admin prompt                                           |
| **AdminPage**                 | The `/admin?admin=1` page with the per-module heartbeat telemetry table, image inspector, and Discord webhook test surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | admin dashboard                                        |
| **API Key / Admin secret**    | `HIGHFIVE_API_KEY` (dev fallback `hf_dev_key_2026`). Since #142 / ADR-019 it is the admin **login password** (`POST /api/admin/login`) and the session-cookie HMAC key — never shipped to the browser (no `VITE_API_KEY`). Reads are public. The legacy `X-API-Key` blanket gate is gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | secret, token                                          |
| **Admin Key (`X-Admin-Key`)** | The same `HIGHFIVE_API_KEY` value sent as the `X-Admin-Key` header — the server-side machine credential for scripts/CI that `requireAdmin` accepts as an alternative to the session cookie (see [ADR-019](../09-architecture-decisions/adr-019-admin-session-no-bundle-secret.md), [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md)).                                                                                                                                                                                                                                                                                                                                                                                                                | admin secret                                           |
| **Admin session cookie**      | `hf_admin_session` — `HttpOnly`, `SameSite=Lax`, HMAC-signed (~12 h) cookie minted by `POST /api/admin/login`. Authorises admin/write routes via `requireAdmin`. The browser-side replacement for the old baked key (#142 / ADR-019).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | session, auth cookie                                   |
| **Activity bucket**           | One row in the `ActivityTimeSeries` returned by `/api/modules/:id/activity`. A bucket is an `(hour or day, count)` pair, where `count` is the number of `image_uploads` rows that fall in the interval. Empty intervals are dense-filled with `count: 0` server-side so the dashboard chart doesn't stitch across silent periods. Used by `ActivityWeatherChart` in `ModulePanel.tsx`. See [ADR-015](../09-architecture-decisions/adr-015-weather-correlation.md).                                                                                                                                                                                                                                                                                                              | activity row, time bucket                              |
| **Measurement**               | One row in the `measurements` table (issue #110, see [ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md)). Five-tuple `(module_mac, ts, metric, value, source)`. The canonical per-module time-series store; downstream baseline (#115), anomaly (#116), and hatching-prediction (#117) features read from this. Append-only, no PK, no FK. **Caveat for `battery_pct`:** there is no real battery ADC yet (#8a/#8b). `carpenter`+ firmware OMITS battery from the heartbeat, so the dual-write skips and the firmware-sourced series is a true gap — not a fabricated reading (older firmware sent `random(1, 100)`); only the dev seed writes a synthetic `battery_pct` (a cosine, see `db/schema.py`). Real percentages land when #8a / #8b do. | metric row, time-series row, measurement record        |
| **Metric**                    | The metric-name string column on a **Measurement**. Open-string, ≤ 40 chars, NOT enforced by a CHECK constraint or FK — producers self-coordinate via the canonical list below. Known metrics: `battery_pct`. Future metrics named in tracked issues: `temperature_c` (#111), `activity_score` (#114), `battery_mv` (#8b).                                                                                                                                                                                                                                                                                                                                                                                                                                                      | metric name, signal type                               |
| **Source**                    | The provenance string column on a **Measurement**. Distinguishes live samples from imports and from different producers writing the same metric. Known sources: `esp-heartbeat` (live, written by `routes/heartbeats.py` dual-write), `esp-heartbeat-backfill` (one-time import on first boot after issue #110 lands). Future sources tracked in issues: `weather-api` (#111), `image-classifier` (#112), `downsample-day` (retention follow-up; see [measurement-retention.md](../08-crosscutting-concepts/measurement-retention.md)).                                                                                                                                                                                                                                         | producer, origin                                       |
| **Measurement bucket**        | One row in the `MeasurementTimeSeries.buckets` array returned by `/api/modules/:id/measurements`. A `(timestamp, value, sampleCount)` triple where `value` is `AVG` across all samples landing in the bucket — or `null` if no samples landed. Critically NOT `0` for empty buckets: a missing sensor reading is unknown, not zero (the chart renders `null` as a break in the line via recharts' `connectNulls={false}`). Pinned by `MeasurementBucket` in `contracts/src/index.ts`.                                                                                                                                                                                                                                                                                           | gap, empty bucket (use sampleCount = 0)                |
| **Open-Meteo**                | Public, key-less hourly-weather API (`api.open-meteo.com/v1/forecast`) called **direct from the browser** by `ActivityWeatherChart` to overlay temperature + precipitation on the activity chart. Not proxied through the HiveHive backend; rationale in [ADR-015](../09-architecture-decisions/adr-015-weather-correlation.md). Sees only the visitor's lat/lng (already a public, ~1 km-generalized module location — ADR-020), not any HiveHive identifier.                                                                                                                                                                                                                                                                                                                  | weather API                                            |
| **Coordinate generalization** | The privacy control that rounds every served/stored `Module.location` to `PUBLIC_COORD_DECIMALS` (2 dp, ~1.1 km) — a constant, irreversibly-lossy transform applied at three layers (ESP firmware `hf::roundCoord`, duckdb-service round-on-write, backend `coarsenLocation`). "Coarsen for everyone": no caller, admin included, receives finer precision, and the exact fix is never persisted. See [ADR-020](../09-architecture-decisions/adr-020-coordinate-generalization.md) / [#145](https://github.com/schutera/highfive/issues/145).                                                                                                                                                                                                                                   | fuzzing (removed cosmetic client-side variant), jitter |

## Configuration and feature flags

| Term                               | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Aliases to avoid                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **Feature flag**                   | An env-var switch that gates a feature on/off. **Two distinct flavours** — do not conflate them. (1) **Homepage build-time flag**: a `VITE_*` var read through `homepage/src/lib/featureFlags.ts`'s `flagEnabled` (`=== 'true'`), **inlined at build time**, default **off**, flipped by a homepage rebuild + redeploy ([ADR-022](../09-architecture-decisions/adr-022-build-time-feature-flags.md)). (2) **Backend runtime gate**: a plain env var read live via `os.getenv` (e.g. `WEATHER_WORKER_ENABLED`, default **on**), flipped by a service restart ([ADR-017](../09-architecture-decisions/adr-017-external-weather-source.md)). Full guidance + which-to-use: [feature-flags.md](../08-crosscutting-concepts/feature-flags.md). | toggle, switch (in prose — say which flavour) |
| **`VITE_ENABLE_DASHBOARD_IMAGES`** | The first homepage build-time feature flag: gates the public per-module imagery in `ModulePanel.tsx` — now the `NestSnipGrid` hole-detection snip grid + time-lapse (#165/#166), originally the since-removed "Latest captures" gallery (#154). Off in production; the dev `docker-compose.yml`, the UI-test stack, and `vitest.config.ts` set it `'true'`.                                                                                                                                                                                                                                                                                                                                                                               | dashboard-images flag (qualify the var name)  |

## Relationships

- A **Module** has zero or more **Nests** (`module_configs.id` ←
  `nest_data.module_id`).
- A **Nest** belongs to exactly one **Module** and has exactly one
  **Bee Type**.
- A **Nest** has zero or more **Daily Progress** rows
  (`nest_data.nest_id` ← `daily_progress.nest_id`).
- A **Daily Progress** row carries three cell counters: **Empty**,
  **Sealed** (percentage), and **Hatched**.
- A **Module** is identified by its **MAC**, which is the value of
  `module_id` everywhere it appears.
- An **Upload** produces one image, optionally one **Log Sidecar**, one
  **Classification Output**, and exactly one **post-upload aggregate
  heartbeat** (the telemetry heartbeat is independent and fires
  hourly regardless of uploads).

## Example dialogue

> **Dev:** "When the image-service receives an `/upload`, what does it
> persist on the **Module**?"

> **Domain expert:** "It calls `/modules/<mac>/heartbeat` on
> duckdb-service — the _post-upload aggregate_, not to be confused
> with the firmware-direct telemetry `POST /heartbeat`. That bumps
> **Battery Level**, **Image Count**, and sets **First Online** to
> today."

> **Dev:** "Wait — every post-upload aggregate resets **First Online**?
> I'd expect that to stick from the first sighting."

> **Domain expert:** "Yes, that's the bug-shaped corner today. The name
> says first, the implementation behaves like last. Use **Last API
> Call** semantics if you want last-seen and only set **First Online**
> when it's NULL."

> **Dev:** "And the **Classification Output** — that's the JSON with
> per-bee-type cell values?"

> **Domain expert:** "Right. Note `ClassificationOutput` accepts both
> the canonical `module_id` and the legacy typo `modul_id` via
> Pydantic `AliasChoices` — image-service emits the canonical name
> today; the alias is a deprecation window for any out-of-tree caller
> still on the old key, and will be removed once nothing references
> it. Worth flagging on any contract refactor that closes the window."

## Flagged ambiguities

### Same concept, two names

- **`modul_id` vs `module_id`** — `ClassificationOutput` (the payload
  on `POST /add_progress_for_module`) carries the canonical
  `module_id` on the wire as of the cutover; the legacy typo
  `modul_id` is still **accepted** via Pydantic `AliasChoices` as a
  deprecation window for any caller still on the old key. Verified in
  `duckdb-service/models/progress.py`'s `ClassificationOutput`
  (`validation_alias=AliasChoices("module_id", "modul_id")`) and
  `image-service/services/upload_pipeline.py`'s `_record_progress`
  (emits `{"module_id": mac, ...}`). DB column, route param, DTO all
  use `module_id`.
  **Recommendation:** do not regress emitters back to `modul_id`. When
  removing the alias, grep the tree (and any out-of-tree consumer)
  for the typo first, drop the `AliasChoices` validator, and land both
  ends in the same PR.
- **`mac` vs `esp_id` vs `module_id` vs `id`** — the same string is
  called `mac` on multipart upload and the ESP firmware,
  `esp_id` as a `validation_alias` on `ModuleData`, `module_id` in
  routes and FK columns, and bare `id` on `module_configs` and the
  frontend `Module` DTO. **Recommendation:** standardise on **MAC**
  in domain prose, **module_id** at the persistence and API layer, and
  retire `esp_id` (the alias is only used for legacy registrations).
- **`hive` / `hive-module` / `hivemodule` / `module`** — used
  interchangeably in docs, copy and seed data (`hive-001` etc.).
  **Recommendation:** **Module** is the canonical term; **Hive
  Module** is acceptable in user-facing UI only.
- **`beeType` (camelCase) vs `bee_type` (snake_case)** — the DB column
  is `beeType` (a casing inconsistency in itself); the
  `ClassificationOutput` keys are `black_masked_bee` etc. and get
  translated through `BEE_TYPE_MAP`. **Recommendation:** keep the map
  but treat `beeType` as the canonical column name; do not introduce
  a third spelling.
- **`battery` vs `battery_level` vs `batteryLevel`** — wire form,
  DB column, frontend DTO. Three layers, three spellings.
  **Recommendation:** acceptable as-is (each layer keeps its native
  casing); document the transformation, don't add a fourth.
- **`nestId` vs `nest_id`** — _Resolved on 2026-04-26._ The homepage
  was updated to use the backend's `nest_id` (snake_case) in its
  `NestData` DTO and `ModulePanel.tsx` rendering, eliminating the
  camelCase variant. Kept here so future readers can trace the
  history; do not reintroduce `nestId`.

### Same name, two concepts

- **`status`** — at the dashboard/contract level it means **Module**
  reachability and is derived as `'online' | 'offline' | 'unknown'`
  by `backend/src/database.ts`'s `fetchAndAssemble` from a 2 h window
  on `lastSeenAt` (see Module-state table above). It is **not** a
  stored column anywhere — the historical `module_configs.status`
  was dropped in [#69](https://github.com/schutera/highfive/issues/69)
  precisely to remove the temptation to "update status" in some new
  code path and discover at integration time that the dashboard
  ignores stored writes. The word is generic enough that it is also
  at risk of being reintroduced for classification state ("sealed
  status") or upload state ("upload status"). **Recommendation:**
  reserve `status` for the derived **Module** reachability enum
  above; use `cell_state` or `nest_progress_state` for any future
  per-cell status.
- **`logs`** — at the wire level it is the multipart form field
  carrying ESP **Telemetry**. At the route level (`/api/modules/:id/logs`,
  `/modules/<mac>/logs`) it refers to the persisted **Log Sidecars**
  served back to admins. The two are related but not identical (the
  endpoint also carries `_mac`, `_received_at`, `_image` envelope
  fields the ESP never sent). **Recommendation:** call the input
  field **Telemetry** in prose, the stored artefact a **Log Sidecar**,
  and reserve "logs" for the HTTP route name only.
- **`first_online`** — semantically "date of first registration".
  Previously the per-upload heartbeat handler unconditionally
  overwrote it on every upload, making it behave like "last contact
  date" — fixed by [#75](https://github.com/schutera/highfive/issues/75)
  via `SET first_online = COALESCE(first_online, ?)` so the column
  is only filled on the first call after a NULL. **Last API Call**
  / `lastSeenAt` remains the proper last-seen field on the dashboard
  (derived); do not rename `first_online`.
- **`sealed`** — on `daily_progress` it is a percentage (0-100). In
  the image-service classifier output and the `image-service.md` doc
  it is "1 = filled/sealed, 0 = empty" (a binary). The conversion
  (`int(sealed * 100)` in `add_progress_for_module`) is the only
  place these meet. **Recommendation:** rename the DB column to
  `sealed_pct` next migration; treat the wire-level binary as
  `cell_filled` to drop the conflict.
- **`count`** — overloaded between `image_count` (lifetime uploads)
  and the response of `/progress_count` (daily_progress rows for a
  module). They are unrelated. **Recommendation:** never use bare
  `count` in domain prose; always qualify (`Image Count`,
  `Progress Count`).
- **`location`** — two **completely different** things on the wire.
  `Module.location` is the _module's_ GPS coordinates, resolved by the
  ESP firmware via Google's Geolocation API from nearby Wi-Fi BSSIDs
  at registration time. It is per-module, stored in DuckDB, and
  **generalized to ~1 km (2 dp) for every caller, admin included** — a
  privacy control, not a precision bug (the exact fix is never served or,
  after duckdb round-on-write, persisted). See **Coordinate generalization**
  below and [ADR-020](../09-architecture-decisions/adr-020-coordinate-generalization.md).
  (The earlier client-side `fuzzLocation` was cosmetic and is removed.) The
  new `UserLocation` (contracts
  `src/index.ts`'s `UserLocation`, served by `GET /api/user-location`)
  is the _dashboard visitor's_ approximate position — IP-derived
  city-level for the first-paint centre, or precise browser
  `navigator.geolocation` data when the user clicks the locate
  button. It is not stored, not joined to any module, and lives
  entirely client-side after retrieval. **Recommendation:** never
  refer to either as just "location" in cross-service prose; say
  **Module Location** or **User Location** to keep the source clear.
  See [ADR-012](../09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md).

### Drift risk — fields that bit us in the past

- **`progess_id` and `hateched`** — backend `database.ts` was reading
  `p.progess_id` and `p.hateched` (typos) when normalising rows from
  duckdb-service `/progress`. The DB and the API actually emit the
  correctly spelled `progress_id` and `hatched`. Fixed in commit
  `778c9b1`; the impact was that every cached `DailyProgress` had
  `progress_id=undefined` and `hatched=undefined` for the lifetime of
  the bug. **Why this happened:** comments in `database.ts`
  ("Backend name!") asserted the typos were the canonical names. No
  contract test covered the read.
- **`modul_id`** — accepted as a deprecation alias for `module_id`
  on `POST /add_progress_for_module` via Pydantic `AliasChoices`.
  Image-service emits the canonical `module_id`; the alias remains
  for any out-of-tree consumer still on the old key, removable once
  nothing references it.
- **TS interface duplication between `backend` and `homepage`**
  — _RESOLVED 2026-04-26_. Both sides used to declare their own
  `Module`, `ModuleDetail`, `NestData`, `DailyProgress`. The homepage
  copy had already drifted (e.g. `nestId: number` vs the wire's
  `nest_id: string`, fixed in `ab0ef3d`) and was missing several
  backend-only fields. Now both consumers import from the
  `@highfive/contracts` npm workspace package
  (`contracts/src/index.ts`); any field-shape drift becomes a
  TypeScript compile error.
- **General mitigation:** treat any field whose spelling differs by
  one letter from a real English word as a smell. Add a
  contract-level integration check (or a Pydantic alias with the
  correct spelling) before the next firmware refactor.
