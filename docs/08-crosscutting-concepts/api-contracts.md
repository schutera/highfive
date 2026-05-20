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
}
```

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
  Geolocation API at first boot. Per-module, stored in DuckDB,
  displayed fuzzed on the map.
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
[ADR-014](../09-architecture-decisions/adr-014-weather-correlation.md).

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

| Endpoint                                   | Caller                                                  | Payload fields                                                       |
| ------------------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /add_progress_for_module`            | `image-service`'s `UploadPipeline._record_progress`     | `module_id` (canonical, `modul_id` alias accepted), `classification` |
| `POST /record_image`                       | `image-service`'s `UploadPipeline._record_image_upload` | `module_id` (canonical), `filename`                                  |
| `POST /modules/<module_id>/heartbeat`      | `image-service`'s `UploadPipeline._record_heartbeat`    | `battery` (int 0-100)                                                |
| `GET  /modules/<module_id>/progress_count` | `image-service`'s `UploadPipeline._check_first_upload`  | (no body)                                                            |

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
