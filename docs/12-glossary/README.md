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

| Term            | Definition                                                                                                                                 | Aliases to avoid                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **MAC**         | The ESP32-CAM's WiFi MAC address; the canonical, immutable identifier of a **Module**. Sent as the multipart `mac` field on `/upload`.     | esp_id, device id (in prose)                     |
| **module_id**   | The string used as `module_configs.id` and as the foreign key on `nest_data`. Equal in value to **MAC**; this is the DB-facing name.       | id (bare), modul_id (typo), hive id              |
| **nest_id**     | The string PK of `nest_data`; format `nest-NNN`. Used identically across backend, frontend, and DB (`nestId` synonym resolved 2026-04-26). | nestId (resolved — homepage now uses snake_case) |
| **progress_id** | The string PK of `daily_progress`. UUID for new rows, `prog-NNN` for seed data.                                                            | progess_id (typo, fixed in 778c9b1)              |

## Module state and telemetry

| Term               | Definition                                                                                                                                              | Aliases to avoid                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Status**         | The Module's reachability flag, `online` or `offline`. Persisted on `module_configs.status`. Module-only — not used on nests or progress.               | state                                             |
| **Battery Level**  | Module's last reported battery percentage (0-100). Persisted on `module_configs.battery_level`; surfaced as `batteryLevel` in the frontend DTO.         | battery (in DTO field names; allowed in payloads) |
| **First Online**   | Calendar date the module was first registered (and currently also bumped on each heartbeat — see Flagged ambiguities). `module_configs.first_online`.   | registered_at, registration_date                  |
| **Last API Call**  | Timestamp of the module's most recent contact with the backend / image-service. Surfaced as `lastApiCall` on the frontend `Module` DTO.                 | last_seen, lastSeen                               |
| **Image Count**    | Total accepted uploads for a module. Maintained by the heartbeat endpoint on `module_configs.image_count`. Surfaced as `imageCount`.                    | upload_count, total_images                        |
| **Heartbeat**      | The `POST /modules/<module_id>/heartbeat` write that runs after every accepted upload. Updates **Battery Level**, **First Online** and **Image Count**. | keepalive, ping                                   |
| **Progress Count** | Number of `daily_progress` rows for a given module, returned by `GET /modules/<module_id>/progress_count`. Used to detect first-upload events.          | progress_total                                    |

## Daily progress lifecycle

| Term               | Definition                                                                                                                              | Aliases to avoid                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Daily Progress** | One row in `daily_progress`: a (nest, date) snapshot with cell counts. The atomic record that drives every dashboard chart.             | progress entry, daily entry                                           |
| **Empty**          | Count of empty cells in the nest on that date. `daily_progress.empty`.                                                                  | open                                                                  |
| **Sealed**         | Percentage (0-100) of sealed cells in the nest on that date. _Stored as a percentage, not a count, despite sitting next to two counts._ | filled (avoid; "filled" is used loosely in image-service for raw 1/0) |
| **Hatched**        | Count of hatched cells in the nest on that date. `daily_progress.hatched`.                                                              | hateched (typo, fixed in 778c9b1)                                     |
| **Total Hatches**  | Module-level rollup: sum of `hatched` over all nests, surfaced as `totalHatches` on the `Module` DTO.                                   | total_hatched                                                         |

## Classification

| Term                      | Definition                                                                                                                                       | Aliases to avoid                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **Classification**        | The act (and result) of converting an uploaded image into per-nest cell-state values. Currently produced by `stub_classify()`; MaskRCNN planned. | inference, prediction (free prose only) |
| **Classification Output** | The JSON payload the image-service POSTs to `/add_progress_for_module`. Pydantic model `ClassificationOutput`.                                   | progress payload                        |
| **Stub Classifier**       | The placeholder `stub_classify()` returning random 0/1 per (bee_type, nest index). Stand-in for MaskRCNN.                                        | dummy classifier                        |

## Telemetry and admin

| Term            | Definition                                                                                                                                                              | Aliases to avoid                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **Telemetry**            | Structured device-health JSON (firmware version, uptime, free heap, RSSI, reset reason, last HTTP codes, on-device log tail) the ESP attaches as the `logs` form field. | logs (overloaded — see ambiguities) |
| **Log Sidecar**          | The `<image>.log.json` file image-service writes next to each saved image, holding the parsed **Telemetry** plus `_mac`, `_received_at`, `_image`.                      | log file, telemetry file            |
| **HeartbeatSnapshot**    | Wire shape (in `@highfive/contracts`) of one heartbeat row — `receivedAt`, `battery`, `rssi`, `uptimeMs`, `freeHeap`, `fwVersion`. Latest is surfaced on `Module.latestHeartbeat`. See [ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md). | heartbeat payload                   |
| **Silence Watcher**      | Background thread inside `duckdb-service` that fires Discord alerts when a module is silent for >3h and a recovery message when it returns. See [ADR-005](../09-architecture-decisions/adr-005-silence-watcher-in-duckdb-service.md). | offline watcher                     |
| **Bee-name version**     | Firmware version identifier of the form `bumblebee` / `honeybee` / `mason` / `carpenter`. Single source of truth: `ESP32-CAM/VERSION`. See [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md). | firmware tag                        |
| **Task Watchdog**        | The `esp_task_wdt_*` timer that reboots the ESP if `loop()` doesn't feed it within `TASK_WDT_TIMEOUT_S` seconds (currently **60 s**, bumped from 30 s in PR 17). | wdt                                 |
| **Circuit Breaker (ESP)**| The static counter of consecutive failures of any kind (camera NULL, WiFi down, HTTP non-2xx) that defers a reboot to the next loop iteration when it trips. See [ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md). | failure counter                     |
| **Daily Reboot**         | The 24-hour-uptime auto-restart, with NVS-flagged capture-skip on the wake boot so the daily image cost isn't doubled. | scheduled reboot                    |
| **Admin Gate**           | The two-key requirement (`X-API-Key` + `X-Admin-Key`) on `/api/modules/:id/logs`, paired with the frontend `?admin=1` flag in `sessionStorage['hf_admin']`.             | admin auth                          |
| **AdminKeyForm**         | Inline React form that collects the admin key (PR 17 `5b110de` — replaced `window.prompt()`).                                                                          | admin prompt                        |
| **AdminPage**            | The `/admin?admin=1` page with the per-module heartbeat telemetry table, image inspector, and Discord webhook test surface.                                            | admin dashboard                     |
| **API Key**              | Shared dev key `hf_dev_key_2026` (`HIGHFIVE_API_KEY` / `VITE_API_KEY`). Sent as `X-API-Key` for all `/api/modules*` calls.                                              | secret, token                       |
| **Admin Key**            | Same secret as **API Key**, but checked under the header name `X-Admin-Key`. Reuse is intentional (see commit a094792 and [ADR-003](../09-architecture-decisions/adr-003-shared-api-key-for-admin.md)). | admin secret                        |

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
  **Classification Output**, and exactly one **Heartbeat**.

## Example dialogue

> **Dev:** "When the image-service receives an `/upload`, what does it
> persist on the **Module**?"

> **Domain expert:** "It calls `/modules/<mac>/heartbeat` on
> duckdb-service. That bumps **Battery Level**, **Image Count**, and
> sets **First Online** to today."

> **Dev:** "Wait — every heartbeat resets **First Online**? I'd expect
> that to stick from the first sighting."

> **Domain expert:** "Yes, that's the bug-shaped corner today. The name
> says first, the implementation behaves like last. Use **Last API
> Call** semantics if you want last-seen and only set **First Online**
> when it's NULL."

> **Dev:** "And the **Classification Output** — that's the JSON with
> per-bee-type cell values?"

> **Domain expert:** "Right. Note the payload field is `modul_id`, not
> `module_id`. It's a typo we've kept on the wire for compatibility
> but it should be flagged in any contract refactor."

## Flagged ambiguities

### Same concept, two names

- **`modul_id` vs `module_id`** — `ClassificationOutput` (the payload
  on `POST /add_progress_for_module`) carries the field `modul_id`.
  Everywhere else (DB column, route param, DTO) the canonical name is
  `module_id`. Still live on the wire as of 2026-04-25; verified in
  `duckdb-service/models/progress.py:6` and `duckdb-service/routes/progress.py`.
  **Recommendation:** keep on the wire for now to avoid breaking
  image-service, but rename to `module_id` next time the contract
  changes; add a Pydantic alias during transition.
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

- **`status`** — on `module_configs` it means reachability (`online`
  / `offline`). It is _not_ used on nests or progress, but the word
  is generic enough that it is at risk of being reintroduced for
  classification state ("sealed status") or upload state ("upload
  status"). **Recommendation:** reserve `status` for **Module**
  reachability; use `cell_state` or `nest_progress_state` for any
  future per-cell status.
- **`logs`** — at the wire level it is the multipart form field
  carrying ESP **Telemetry**. At the route level (`/api/modules/:id/logs`,
  `/modules/<mac>/logs`) it refers to the persisted **Log Sidecars**
  served back to admins. The two are related but not identical (the
  endpoint also carries `_mac`, `_received_at`, `_image` envelope
  fields the ESP never sent). **Recommendation:** call the input
  field **Telemetry** in prose, the stored artefact a **Log Sidecar**,
  and reserve "logs" for the HTTP route name only.
- **`first_online`** — semantically "date of first registration", but
  the heartbeat handler unconditionally overwrites it on every
  upload, making it behave like "last contact date".
  **Recommendation:** fix the handler
  (`SET first_online = COALESCE(first_online, ?)`) and introduce
  **Last API Call** as the proper last-seen field; do not rename
  `first_online`.
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
- **`modul_id`** — same shape of risk as above, currently _live_ on
  the wire between image-service and duckdb-service. Highest-priority
  drift hazard remaining.
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
