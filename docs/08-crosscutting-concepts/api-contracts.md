# API contracts and field-name discipline

Frontend and backend share a single source of truth for typed DTOs:

- **`contracts/src/index.ts`** — npm workspace package
  `@highfive/contracts`, imported by both `backend/` and `homepage/`.
  Field-shape drift becomes a TypeScript compile error.

For HTTP shapes (request/response examples), see
[../api-reference.md](../api-reference.md).

## Why the shared package exists

Both `backend` and `homepage` previously declared their own copies of
`Module`, `ModuleDetail`, `NestData`, `DailyProgress`. They drifted
(e.g. `nestId: number` on the homepage vs `nest_id: string` on the
wire — fixed in `ab0ef3d`). Moving the canonical types into a
workspace package made any future drift fail at TypeScript compile.

If you change a wire field, update `contracts/src/index.ts` first
and let the compile errors guide the rest.

## `HeartbeatSnapshot` and the extended `Module`

PR 17 added the **telemetry heartbeat** channel
(`POST /heartbeat` — `heartbeat` route in
`duckdb-service/routes/heartbeats.py`, fired hourly by firmware's
`sendHeartbeat` in `ESP32-CAM/client.cpp`) and
surfaced the most recent snapshot on every `Module`. This is
**distinct from** the post-upload aggregate at
`POST /modules/<mac>/heartbeat`
(`duckdb-service/routes/modules.py`'s `heartbeat`), which is a separate
endpoint with a different body and different side effects — see
[duckdb-service.md](../05-building-block-view/duckdb-service.md)
and the [glossary](../12-glossary/README.md) for the full
disambiguation.

Both heartbeat endpoints canonicalise their `mac` / `<module_id>`
input through `ModuleId.model_validate(...)` before any DB write, so
colon-form, dash-form, and uppercase MACs all collapse onto the same
canonical 12-hex `module_id` PK. This mirrors the `/upload` seam in
`image-service/app.py` — see
[../api-reference.md](../api-reference.md) §3.7 for the wire-level
behaviour.

The wire shape:

```ts
export interface HeartbeatSnapshot {
  receivedAt: string; // ISO timestamp
  battery: number | null;
  rssi: number | null;
  uptimeMs: number | null;
  freeHeap: number | null;
  fwVersion: string | null; // bee-name string, see ADR-006
  resetReason: string | null; // #148 — "POWERON"/"BROWNOUT"/"TASK_WDT"/… ; null on pre-#148 firmware
  minFreeHeap: number | null; // #148 — heap low-water mark since boot (bytes)
  bootCount: number | null; // #148 — NVS-backed monotonic reboot counter
  lastHbFailCode: number | null; // #172 — last failed heartbeat's return value (-2 connect/WiFi, -4 bad response, else HTTP code); null pre-#172
  lastHbFailCount: number | null; // #172 — consecutive heartbeat failures before the last 2xx
  lastStageBeforeReboot: string | null; // #172 opt 2 — RTC breadcrumb on the heartbeat; '' = none survived (dense), null pre-opt-2
}
```

The three `null`-able diagnostic fields (`resetReason`, `minFreeHeap`,
`bootCount`) were added in #148. A crash-looping or hung module never
reaches the daily noon image upload that carries the telemetry sidecar,
so these — which previously lived only in that sidecar
(`ESP32-CAM/logbuf.cpp`'s `buildTelemetryJson`) — are lifted onto the
hourly heartbeat. They are `null` when the latest heartbeat came from
firmware predating #148, so a mixed fleet mid-OTA is type-safe. The
dashboard surfaces them in `HeartbeatDiagnostics`
([`homepage/src/components/ModulePanel.tsx`](../../homepage/src/components/ModulePanel.tsx)),
which flags a **recent fault reset** (latest `resetReason` is a
watchdog/panic/brownout and `uptimeMs` has not recovered) from the single
snapshot. Confirming an actual boot _loop_ — `bootCount` rising while
`uptimeMs` stays flat **across** heartbeats — needs the queryable history
and is deferred to #148 Phase 4 (server-side).

`lastHbFailCode` / `lastHbFailCount` were added in #172 and close a
related blind spot: the diagnostic fields above describe only the **boot**
heartbeat, because a _failed_ hourly heartbeat never reaches the server (no
2xx response). In #170 the boot heartbeat returned `200` while every hourly
heartbeat in the following 2 h failed and tripped the liveness watchdog —
invisible remotely without a physical serial capture. The firmware now
accumulates the failure streak across a session in RTC memory
(`ESP32-CAM/lib/hb_failure`, the same software-reset-surviving storage class
as the `lib/breadcrumb` stage marker) and attaches it to the next 2xx
heartbeat — typically the boot heartbeat after a `livenessReboot`, which then
clears it. A non-zero `lastHbFailCount` on an otherwise-online module is the
reboot-loop / flaky-contact signature; `HeartbeatDiagnostics` renders it as a
**possible reboot loop** banner.

The field is **three-valued and deliberately dense**: a positive count is a
streak, `0` is a healthy module that actively reported "no failures", and
`null` is pre-#172 firmware. The firmware emits the fields on **every**
heartbeat (`0` when healthy), not just when a streak exists — because the
backend folds them via `ARG_MAX(last_hb_fail_count, received_at)` in
`/heartbeats_summary`, and DuckDB's `ARG_MAX` **ignores NULL rows**. A sparse
field (omitted when healthy → NULL) would make the summary skip the recovery
heartbeats and latch the last non-zero streak forever, so the banner would
never clear after a module recovered. Emitting `0` keeps the column dense like
`rssi`/`reset_reason`/`boot_count` so the latest heartbeat always wins. This
is why `0` (cleared) and `null` (legacy) are genuinely distinct on the wire —
the regression is pinned by
`duckdb-service/tests/test_heartbeats_endpoint.py`'s
`test_heartbeats_summary_clears_streak_after_recovery_not_latching`.

`lastStageBeforeReboot` was added in #172 **option 2**. The RTC stage
breadcrumb (`ESP32-CAM/lib/breadcrumb`, recovered at boot) previously rode
**only** the per-upload telemetry sidecar (`TelemetryPayload`, the noon image),
so after a watchdog/liveness reboot it could be up to 24 h late. Carrying it on
the boot heartbeat surfaces it immediately — the device-side complement to the
`lastHbFail*` streak (that says the hourly pings failed; this says which boot
stage was active when the previous run died). Like `resetReason` it is sent
**densely** (`''` when no breadcrumb survived); `null` is firmware predating
option 2. `HeartbeatDiagnostics` renders it as a "stage at previous reboot" line.

`HeartbeatGap` (#172 **option 3**) is a separate, **derived** read — the
server-side complement that surfaces the silent windows the device cannot report
(a failed/timed-out heartbeat never reaches the server):

```ts
export interface HeartbeatGap {
  gapStart: string; // ISO — last heartbeat before the silence
  gapEnd: string; // ISO — first heartbeat after the silence
  gapSeconds: number; // wall-clock width of the gap
}
```

It is computed on demand from the `module_heartbeats.received_at` timeline (a
`LAG` window function over rows wider than ~90 min) by
`duckdb-service GET /heartbeats/<id>/gaps`, proxied admin-gated and camelCased by
`backend GET /api/modules/:id/heartbeat-gaps`. No table, no writer — see
[ADR-025](../09-architecture-decisions/adr-025-heartbeat-gap-derived-read.md).

`Module` gained `displayName`, `email`, `updatedAt`, `lastSeenAt`, and
`latestHeartbeat`. `displayName` is the admin-settable label override
introduced in PR I (ADR-011) — null when no operator has renamed the
module; resolution into the operator-visible label happens client-side
via [`homepage/src/lib/displayLabel.ts`](../../homepage/src/lib/displayLabel.ts)
(trims `displayName`, falls back to `name` on null / empty /
whitespace-only). The shape lives in the shared package by
deliberate decision —
[ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).

The **`POST /heartbeat` request body** (not the `HeartbeatSnapshot`
reply shape above) gained three optional fields in PR II / issue #89:
`latitude`, `longitude`, `accuracy`. The firmware attaches them only
when its deferred-retry path obtained a fix mid-uptime; the server
UPDATEs `module_configs.lat`/`lng` iff the row sits at the `(0,0)`
sentinel. The wire shape of `HeartbeatSnapshot` (the dashboard-
facing reply) is unchanged — those fields drive a side effect, not a
new field on the snapshot. Full wire-level documentation:
[`../api-reference.md` §3.7](../api-reference.md).

## `Module.status` is three-valued

`Module.status` is `'online' | 'offline' | 'unknown'`. The `'unknown'`
value (added 2026-05-07, issue #31) covers the case where the duckdb
`/heartbeats_summary` fetch failed and the module would otherwise have
been classified as `'offline'` — we can't rule out that a heartbeat
from the last few minutes would have flipped it to `'online'`, so we
admit uncertainty rather than misleading the on-call. The header
`X-Highfive-Data-Incomplete: heartbeats` is set on the listing
response (`/api/modules`) whenever the heartbeats fetch failed —
irrespective of whether any module's status actually flipped — so the
dashboard can surface a data-quality banner. The detail route
deliberately omits the header because the user always lands there
from the listing.

The header was chosen over a body-shape change so old clients keep
deserialising the response body unchanged; only the per-module
`status` value differs. Consumers that care about UX degradation read
the header; consumers that only need the array continue working.
Cross-origin readability requires `exposedHeaders` to list the header
in the CORS config — see `backend/src/app.ts`'s `corsOptions`.

`Module.lastSeenAt` is **derived** in the backend, not stored. The
formula in `backend/src/database.ts`'s `fetchAndAssemble` reads three
wire fields off the duckdb response and takes the freshest:

```ts
// pseudocode of backend/src/database.ts's fetchAndAssemble per-module loop
const candidates = [
  m.last_seen_at, // module_configs.last_seen_at (registration UPSERT only — issue #97 split; pre-split this was module_configs.updated_at)
  m.last_image_at, // SELECT MAX(uploaded_at) FROM image_uploads ...
  m.latestHeartbeat?.receivedAt, // SELECT MAX(received_at) FROM module_heartbeats ...
].filter(Boolean);
const lastSeenAt = max(candidates.map(toEpoch));
```

The DTO field that exposes `last_image_at` to the frontend is
`Module.lastApiCall` (set by `database.ts`'s per-module `detail`
construction) — same data, different name on the wire vs. the DTO.
If the Python side renames any of the three source columns, the e2e
test in `tests/e2e/test_upload_pipeline.py` is the canary.

## `UserLocation` — visitor IP-geo hint

Added by issue #14 to centre the dashboard map near the visitor on
first paint (rather than on the default Lake Constance view). The
type lives in `contracts/src/index.ts`'s `UserLocation`; the wire
shape is served by `GET /api/user-location`:

```ts
export interface UserLocation {
  lat: number;
  lng: number;
}
```

Accuracy is implicitly city-level (~10–50 km — the documented IP-geo
band). The wire shape deliberately does not include a precision
field: ipapi.co does not publish a per-IP accuracy number, and no
consumer currently renders one. Add a field when a view actually
needs to surface an explicit "± N km" annotation; don't pre-allocate
constant-shaped metadata.

This is **not** the same concept as `Module.location`:

- `Module.location` is the _module's_ GPS coordinates from Google
  Geolocation API at first boot. Per-module, stored in DuckDB.
  **Generalized to ~1 km (2 dp) for every caller** as a privacy control —
  not displayed at full precision to anyone, admin included. The transform
  is a constant, irreversibly-lossy round applied at three layers (firmware,
  duckdb round-on-write, backend response boundary); the precision constant
  is `PUBLIC_COORD_DECIMALS` in `@highfive/contracts`. See
  [ADR-020](../09-architecture-decisions/adr-020-coordinate-generalization.md)
  and [#145](https://github.com/schutera/highfive/issues/145). (The earlier
  client-side `fuzzLocation` was cosmetic — it shipped exact coords over the
  wire — and is removed.)
- `UserLocation` is the _dashboard visitor's_ approximate position.
  Not stored anywhere, not joined to any module, lives entirely in
  the browser after the fetch resolves.

Why we don't ship the existing `GEO_API_KEY` to the homepage to make
the same call directly: [ADR-012](../09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md).

## `ActivityTimeSeries` — bucketed upload counts

Added for the `ActivityWeatherChart` in the module detail panel.
Served by `GET /api/modules/:id/activity` (backend) which proxies
`GET /modules/<id>/activity_timeseries` (duckdb-service) and renames
the top-level `module_id` to `moduleId` on the way out. The type
lives in `contracts/src/index.ts`:

```ts
export type ActivityInterval = 'hourly' | 'daily';

export interface ActivityBucket {
  timestamp: string; // ISO 8601 (UTC), bucket start
  count: number;
}

export interface ActivityTimeSeries {
  moduleId: ModuleId;
  interval: ActivityInterval;
  start: string;
  end: string;
  buckets: ActivityBucket[];
}
```

Two non-obvious contract details:

- **Dense buckets.** Empty hours/days are emitted with `count: 0`
  rather than omitted. Without this, the chart would silently
  stitch over silent hours and a quiet 02:00–05:00 stretch would
  visually become a flat line connecting 01:00 and 06:00 — a
  misrepresentation. The dense shape is the contract; consumers
  rely on it.
- **UTC timestamps, browser-local rendering.** `start`, `end`, and
  every `bucket.timestamp` are naive UTC ISO 8601. The homepage
  formats to the visitor's browser locale at render time. Daily
  buckets in particular MUST be kept in UTC server-side; resolving
  them to a TZ before the homepage sees them would split a single
  day across midnight for any non-UTC viewer.

Per ADR-004's "shared package, compile-time drift" rule, the type
lives in `@highfive/contracts` and is imported by both the backend
proxy and the homepage chart. A service-local duplicate would be a
smell and is explicitly avoided.

Weather data overlaid on the chart is fetched **direct from the
browser** (Open-Meteo, no API key, CORS open) — it is _not_ a
HiveHive wire shape, so it does not appear here. The Open-Meteo
client is at `homepage/src/services/weather.ts`. Rationale for
browser-direct vs. backend-proxy:
[ADR-015](../09-architecture-decisions/adr-015-weather-correlation.md).

## `MeasurementTimeSeries` — per-module canonical time series

Added for the per-module measurements store (issue #110). Served by
`GET /api/modules/:id/measurements` (backend) which proxies
`GET /modules/<id>/measurements` (duckdb-service). The wire shape:

```ts
export interface MeasurementBucket {
  timestamp: string; // ISO 8601 (UTC), bucket start
  value: number | null;
  sampleCount: number;
}

export interface MeasurementTimeSeries {
  moduleId: ModuleId;
  metric: string;
  interval: ActivityInterval; // reuses 'hourly' | 'daily'
  start: string;
  end: string;
  buckets: MeasurementBucket[];
}
```

A single-row `Measurement` interface is deliberately NOT exported —
the homepage only reads the bucketed shape, the backend forwards the
admin write body untyped. When the first real producer (#111 weather
worker) lands and needs to spell the field-by-field shape, the case
discipline can be pinned by that PR rather than guessed at now.

Three non-obvious contract details:

- **`value: number | null` for buckets, NOT `0`.** This is the most
  important difference from `ActivityBucket`. Activity counts treat
  absence-as-zero (no uploads in an hour IS a zero). A sensor
  measurement does not — a missing battery reading is unknown, not
  0%. The chart renders `null` as a break in the line via recharts'
  `connectNulls={false}` so a silent module reads as silence, not as
  a flat-line discharge. Any future consumer aggregating across
  buckets MUST handle `null` explicitly; `(b.value ?? 0)` is almost
  always wrong.
- **`sampleCount` is the row count behind `AVG(value)`.** Separates
  "no samples here" (`value: null, sampleCount: 0`) from "the
  aggregate happens to be 0.0" (`value: 0, sampleCount > 0`). Pinned
  by the integration test in
  `duckdb-service/tests/test_measurements_endpoints.py`.
- **`metric` and `source` are open strings on the wire.** A producer
  can ship a new metric without a coordinated contracts release.
  The canonical list lives in the glossary
  ([`docs/12-glossary/README.md`](../12-glossary/README.md) under
  "Metric" / "Source"); a typo silently creates a new metric instead
  of failing at write. See [ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md)
  for the rationale.

Known `source` values in the wild (consumers can filter on these to
isolate a producer; aggregates over `metric` collapse them together):

| `source`                 | Producer                                                                                                                                                                   | Metrics emitted                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `esp-heartbeat`          | `duckdb-service/routes/heartbeats.py`'s `post_heartbeat` dual-write — one row per heartbeat carrying `battery`                                                             | `battery_pct`                                       |
| `esp-heartbeat-backfill` | One-time idempotent block in `duckdb-service/db/schema.py`'s `init_db` — replays `module_heartbeats.battery` history on existing volumes                                   | `battery_pct`                                       |
| `open-meteo`             | `duckdb-service/services/weather_worker.py`'s `run_weather_fetch` — hourly APScheduler tick per [ADR-017](../09-architecture-decisions/adr-017-external-weather-source.md) | `temperature_c`, `humidity_pct`, `precipitation_mm` |
| `open-meteo-backfill`    | `duckdb-service/services/weather_worker.py`'s `run_weather_backfill` — operator-triggered one-shot per ADR-017                                                             | `temperature_c`, `humidity_pct`, `precipitation_mm` |

The snake → camel mapping at the backend renames `module_id →
moduleId` and `sample_count → sampleCount`; the rest of the JSON
carries through unchanged. The contracts type and the duckdb-service
wire JSON are deliberately close enough that the proxy is one
`.map((b) => ({ timestamp, value, sampleCount }))` and not a
field-by-field transform.

## `ServerLogsResponse` — admin server-log tail (#171, #178)

Served by `GET /api/admin/logs?service=…&lines=N` (backend). Distinct from the
per-module ESP telemetry (`TelemetryEntry`): this is a service's **own** log
output. The backend reads its own ring directly and proxies to `duckdb-service`
/ `image-service` internal `/logs` (forwarding `X-Admin-Key`). The types live in
`contracts/src/index.ts`:

```ts
export type ServerLogService = 'backend' | 'duckdb-service' | 'image-service';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string; // ISO 8601 (UTC)
  level: LogLevel;
  msg: string;
}

export interface ServerLogsResponse {
  service: ServerLogService;
  entries: LogEntry[]; // structured entries, chronological (oldest→newest)
  truncated: boolean; // ring held more than were returned
}
```

Unlike the other wire shapes here there is **no snake → camel mapping**: the
Flask `/logs` routes emit exactly these keys (`service`/`entries`/`truncated`,
each entry `ts`/`level`/`msg`), so the backend proxies the JSON through verbatim
and only the `backend` branch constructs it locally. The proxy branch rejects a
drifted envelope (no `entries` array) with `502` rather than letting `undefined`
fields reach the UI. `nginx` is intentionally not a `ServerLogService` (no app
ring). Design + caveats: [ADR-021](../09-architecture-decisions/adr-021-admin-server-log-ring.md)
/ [ADR-023](../09-architecture-decisions/adr-023-persistent-structured-server-logs.md).

The live tail `GET /api/admin/logs/stream` (SSE) reuses the **same** `LogEntry`
shape: each `data:` event payload is one `LogEntry` JSON. No separate wire type —
the REST array and the SSE event are the same element, so the panel appends stream
entries to the backfilled list without a transform.

## `ImageUploadsPage` — admin gallery pagination

Served by `GET /api/images` (backend), which proxies
`image-service GET /images` → `duckdb-service GET /image_uploads`.
The admin gallery (`homepage/src/pages/AdminPage.tsx`) loads the
newest `PAGE_SIZE` rows and reveals the rest via a "Load more"
button. The type lives in `contracts/src/index.ts`:

```ts
export interface ImageUpload {
  module_id: string;
  filename: string;
  uploaded_at: string; // UTC, no 'T'/'Z'. "YYYY-MM-DD HH:MM:SS" as record_image writes it (second res); the reader emits str() of a DuckDB TIMESTAMP and does not re-format, so sub-second rows would carry fractional seconds. Treat as opaque + sortable.
}

export interface ImageUploadsPage {
  images: ImageUpload[];
  total: number; // full count matching the filter, IGNORING limit/offset
}
```

Query params forwarded verbatim through every hop: `module_id?` (filter),
`limit?` (1-500, omit for all), `offset?` (≥0). Two non-obvious contract
details:

- **`total` is the un-paged count.** It is the count of all rows
  matching `module_id`, not `images.length`. The UI compares
  `images.length < total` to decide whether to show "Load more", and
  the client falls back to `images.length` if a (pre-pagination) response
  omits `total`. Pinned by `homepage/src/__tests__/api-getImages.test.ts`
  and `duckdb-service/tests/test_module_endpoints.py`.
- **Deterministic capture order.** Rows are ordered
  `uploaded_at DESC, id DESC` — newest capture first, with `id`
  (monotonic insertion sequence) as a stable tiebreaker. Without the
  tiebreaker, two uploads sharing a timestamp (`uploaded_at` is
  second-resolution) sort arbitrarily, so `limit`/`offset` paging could
  duplicate one row and skip another. The total order makes "Load more"
  safe.
- **Bounded by construction.** An un-paged list over a large
  `image_uploads` table is slow; never proxy it across a short timeout.
  See the chapter 11 "failed to load images" incident.

Per ADR-004 the type lives in `@highfive/contracts`; the previous
service-local `interface ImageUpload` in `homepage/src/services/api.ts`
was the exact smell that rule warns against and is now a re-export.

## `NestSnip` — per-nest hole-detection snips (#165)

Served by `GET /api/modules/:id/snips` (backend), which proxies
`duckdb-service GET /detections` and maps the snake_case rows to camelCase.
One entry per nest hole — the latest detection per `(beeType, nestIndex)`.
Rendered by `homepage/src/components/NestSnipGrid.tsx`. The type lives in
`contracts/src/index.ts`:

```ts
export interface NestSnip {
  beeType: 'blackmasked' | 'resin' | 'leafcutter' | 'orchard'; // matches NestData.beeType, NOT the image-service wire key 'leafcutter_bee'
  nestIndex: number; // 1-based
  state: 'empty' | 'sealed';
  confidence: number; // 0-1
  snipFilename: string; // resolve via api.getSnipUrl(...), like ImageUpload.filename
  bbox: [number, number, number, number]; // normalized [x, y, w, h] in [0,1]
  sourceFilename: string;
  detectedAt: string; // UTC "YYYY-MM-DD HH:MM:SS", opaque sortable
}

export interface NestSnipsResponse {
  snips: NestSnip[];
}
```

Two non-obvious contract details:

- **`beeType` is the DB form, not the image-service wire key.** image-service's
  detector emits `leafcutter_bee` in the classification dict (the
  `/add_progress_for_module` contract), but maps to `leafcutter` when writing
  `nest_detections.bee_type`, so `NestSnip.beeType` lines up with
  `NestData.beeType` and the homepage `BEE_TYPES` keys. The backend validates
  the enum and **drops** unknown bee types / states rather than forwarding a
  drifted row as `{beeType: undefined}` (CLAUDE.md wire-shape rule). Pinned by
  `backend/tests/snips-route.test.ts`.
- **`snipFilename`, not a pre-built URL.** Mirrors `ImageUpload.filename` +
  `getImageUrl`: the homepage builds the public URL via `api.getSnipUrl(...)`
  (`/api/snips/:filename`). The crop is the privacy mechanism (#154), so the
  bytes route is public.

## Field-name drift to watch for

These three patterns have caused real bugs. Grep before changing
anything in this neighbourhood.

### `modul_id` (deprecation alias)

`POST /add_progress_for_module` accepts the canonical `module_id` on
the wire as of the cutover. The legacy typo `modul_id` (missing "e")
is still **accepted** by `duckdb-service/models/progress.py`'s
`ClassificationOutput` via Pydantic `AliasChoices`, but `image-service`
emits the canonical name (`image-service/services/upload_pipeline.py`'s
`_record_progress`). Everywhere else (DB column, route param, DTO) the
canonical name is `module_id` and always has been.

**Why the alias exists**: deprecation window for any in-tree or
external caller that still posts the old key. Removable once nothing
in the tree references it; the canonical wire field has been
`module_id` since the cutover.

**Recommendation**: do not regress emitters back to `modul_id`. When
removing the alias, grep for the string in this repo and in any
out-of-tree consumer first, drop the `AliasChoices` validator, and
land both ends in the same PR.

### `progess` / `hateched` (fixed, do not regress)

Backend `database.ts` was reading `p.progess_id` and `p.hateched`
when normalising rows from `duckdb-service /progress`. The DB and
API actually emitted the correctly spelled `progress_id` and
`hatched`. The code worked at runtime because both spellings were
JS object keys — every cached `DailyProgress` had `progress_id` and
`hatched` set to `undefined` for the lifetime of the bug.

Fixed in commit `778c9b1`. Comments in `database.ts`
("Backend name!") had asserted the typos were canonical. No contract
test covered the read.

### TS interface duplication (resolved)

Resolved on 2026-04-26 by introducing the `@highfive/contracts`
workspace package. Don't reintroduce per-service DTO copies.

## image-service → duckdb-service wire shapes (Python ↔ Python)

The `@highfive/contracts` package is TypeScript-only (ADR-004); the
Python ↔ Python boundary between `image-service` and `duckdb-service`
has no shared-types mechanism. Wire shapes on this boundary are
documented here and pinned by tests on both sides.

| Endpoint                                   | Caller                                                  | Payload fields                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /add_progress_for_module`            | `image-service`'s `UploadPipeline._record_progress`     | `module_id` (canonical, `modul_id` alias accepted), `classification`                                                                                                                                                                                                |
| `POST /record_image`                       | `image-service`'s `UploadPipeline._record_image_upload` | `module_id` (canonical), `filename`                                                                                                                                                                                                                                 |
| `POST /modules/<module_id>/heartbeat`      | `image-service`'s `UploadPipeline._record_heartbeat`    | `battery` (int 0-100)                                                                                                                                                                                                                                               |
| `GET  /modules/<module_id>/progress_count` | `image-service`'s `UploadPipeline._check_first_upload`  | (no body)                                                                                                                                                                                                                                                           |
| `GET  /image_uploads`                      | `image-service`'s `list_images` (admin gallery proxy)   | query: `module_id?`, `limit?` (1-500), `offset?` (≥0); response: `{ images: [{module_id, filename, uploaded_at}], total }`, newest-first. `total` ignores the page window. Proxied at a 15s read timeout — never unbounded across a short timeout (see chapter 11). |

Server-side canonicalisation through `ModuleId.model_validate(...)` is
the rule, not the exception — colon-/dash-separated and uppercase
MACs all collapse onto the same canonical 12-hex `module_id` PK before
any DB write, so a direct `curl` with a non-canonical MAC cannot
create an orphaned row joining against zero `module_configs` rows.

Full request/response shape for each endpoint lives in
[`docs/api-reference.md`](../api-reference.md) §3.

## General mitigation

Treat any field whose spelling differs by one letter from a real
English word as a smell. Add a contract-level integration check
(or a Pydantic alias with the correct spelling) before the next
firmware refactor.

Full glossary of field names with aliases-to-avoid:
[../12-glossary/README.md](../12-glossary/README.md).
