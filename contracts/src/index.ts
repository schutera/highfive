// Canonical wire-shape contracts shared between `backend` and `homepage`.
//
// Both consumers import from `@highfive/contracts` (npm workspace), so any
// drift between the two TypeScript sources becomes a compile-time error
// instead of a silent field mismatch on the wire.
//
// The shapes here mirror what `backend/src/database.ts` returns to the
// homepage; that file remains the source of truth for the wire contract.
// Field-name drift (e.g. `progess`/`hatched`) is called out in
// `docs/12-glossary/README.md`.

// ---- ModuleId branded type ----
//
// Canonical form is exactly 12 lowercase hex characters with no separators,
// e.g. `"aabbccddeeff"`. Mirrors `duckdb-service/models/module_id.py` and
// the ESP-firmware MAC normalisation; see those for the full rationale.
//
// The brand is a TypeScript-only fiction; at runtime a `ModuleId` is just a
// string. Use `parseModuleId` at every boundary that accepts unverified
// input so the rest of the code can rely on the type.

export type ModuleId = string & { readonly __brand: unique symbol };

const MODULE_ID = /^[0-9a-f]{12}$/;
const LEGACY_DECIMAL_MAC = /^[0-9]+$/;

// Max value of a 48-bit MAC = 2^48 - 1. Used to clamp legacy decimal input
// so we don't silently accept overflowing strings that just happen to be
// all digits (e.g. an oversized opaque ID).
const MAX_MAC = 0xffffffffffffn;

/** Canonicalize and validate. Throws on invalid input. */
export const parseModuleId = (input: string): ModuleId => {
  const c = input.replace(/[:\-\s]/g, '').toLowerCase();
  if (MODULE_ID.test(c)) {
    return c as ModuleId;
  }
  // Legacy compatibility: ESP firmware on prod-carpenter sent the MAC as a
  // decimal integer string (e.g. "273227831496128" → "f89180d71400"). The
  // duckdb-service stored it verbatim, so existing rows still come through
  // in that shape. Convert here at the boundary; the rest of the system
  // continues to see the canonical 12-char hex form.
  if (LEGACY_DECIMAL_MAC.test(c)) {
    const n = BigInt(c);
    if (n <= MAX_MAC) {
      return n.toString(16).padStart(12, '0') as ModuleId;
    }
  }
  throw new Error(`invalid ModuleId: ${input}`);
};

/** Non-throwing variant for boundary code that wants to surface a 400. */
export const tryParseModuleId = (input: string): ModuleId | null => {
  try {
    return parseModuleId(input);
  } catch {
    return null;
  }
};

// ---- Coordinate generalization (issue #145, ADR-020) ----
//
// Module coordinates are a privacy/safety concern: read endpoints went public
// in #142 / ADR-019, so exact nest locations would otherwise be readable by
// anyone (vandalism, disturbance, collection). We generalize every served
// coordinate to 2 decimal places (~1.1 km grid cells). The transform is a
// *constant, irreversibly lossy* round — it cannot be statistically averaged
// back to the true point (unlike re-randomized per-request jitter) and cannot
// be reversed even if this code leaks.
//
// "Coarsen for everyone": admins receive the same 2 dp as anonymous callers —
// the exact value is never served and (after the duckdb-service round-on-write
// + migration) never persisted. This TS constant is the canonical declaration
// for the JS/TS layers; `duckdb-service` and the ESP firmware hardcode the same
// `2` with a cross-reference comment ("one rule, mirrored at three layers",
// the same pattern as `isPlausibleFix`). See ADR-020.
export const PUBLIC_COORD_DECIMALS = 2;

/**
 * Round a single coordinate to `PUBLIC_COORD_DECIMALS`. Preserves the `(0,0)`
 * "no fix yet" sentinel (rounding 0 stays 0). `NaN`/`Infinity` pass through
 * unchanged so a malformed upstream value surfaces rather than becoming `0`.
 */
export function coarsenCoord(value: number): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** PUBLIC_COORD_DECIMALS;
  return Math.round(value * factor) / factor;
}

/** Coarsen both axes of a location to the public precision. Pure; no mutation. */
export function coarsenLocation(loc: { lat: number; lng: number }): { lat: number; lng: number } {
  return { lat: coarsenCoord(loc.lat), lng: coarsenCoord(loc.lng) };
}

export interface HeartbeatSnapshot {
  receivedAt: string; // ISO timestamp
  battery: number | null;
  rssi: number | null;
  uptimeMs: number | null;
  freeHeap: number | null;
  fwVersion: string | null;
  // Diagnostic fields (#148). A crash-looping or hung module never reaches
  // the daily image upload that carries the telemetry sidecar, so these are
  // lifted onto the hourly heartbeat — the very next heartbeat after a reset
  // reports *why* it reset. Null when the emitting firmware predates #148.
  // `resetReason` is the device reset-reason string ("POWERON"/"BROWNOUT"/
  // "TASK_WDT"/…); `bootCount` is the NVS-backed monotonic reboot counter —
  // climbing without `uptimeMs` growing is the boot-loop signature.
  resetReason: string | null;
  minFreeHeap: number | null;
  bootCount: number | null;
  // Steady-state heartbeat-failure diagnostics (#172). The hourly (between-
  // boot) heartbeats fail invisibly — a failed heartbeat never reaches the
  // server, so the reset_reason/bootCount fields above only ever describe the
  // BOOT call. These two carry the previous failure streak forward on the
  // next 2xx heartbeat (typically the boot heartbeat after a `livenessReboot`):
  // `lastHbFailCount` is how many consecutive heartbeats failed before that
  // 2xx, `lastHbFailCode` the most recent failure's return value: `-2` =
  // connect/WiFi-down, `-4` = unparseable status line (`kInvalidStatus` in
  // ESP32-CAM/lib/http_status), otherwise the raw non-2xx HTTP code; `0` when
  // there is no current streak. A non-zero count on an otherwise-online module
  // is the #170 reboot-loop signature made remotely visible.
  // Three-valued: a positive count is a live/just-ended streak; `0` is a
  // healthy module that actively reported "no failures"; `null` is firmware
  // predating #172. The firmware emits these on EVERY heartbeat (0 when
  // healthy), not just when a streak exists, so the backend's
  // `ARG_MAX(last_hb_fail_count, received_at)` fold — which ignores NULL rows —
  // reflects the latest heartbeat instead of latching a stale streak after
  // recovery. So `0` (cleared) and `null` (legacy) are genuinely distinct here.
  lastHbFailCode: number | null;
  lastHbFailCount: number | null;
  // Stage breadcrumb on the heartbeat (#172, option 2). The device's RTC_NOINIT
  // breadcrumb recovered at boot — which long-running stage was active when the
  // previous run died (e.g. `loop:livenessReboot`, `setup:getGeolocation`). It
  // previously rode ONLY the per-upload telemetry sidecar (the noon image; see
  // `TelemetryPayload.lastStageBeforeReboot` — note the snake_case there is the
  // raw ESP JSON), so after a watchdog reboot it could wait up to 24 h to
  // surface. Lifting it onto the boot heartbeat gets it to the server
  // immediately. Three-valued: a non-empty string is the recovered stage; `''`
  // is a healthy module reporting "no breadcrumb survived" (dense send, like
  // `resetReason`); `null` is firmware predating option 2.
  lastStageBeforeReboot: string | null;
}

// Derived, server-side heartbeat gap (#172, option 3). One interval between
// two consecutive heartbeats that is wider than the server's gap threshold
// (~90 min — one missed hourly ping plus margin). Surfaces the silent windows
// the device itself could NOT report — a failed/timed-out heartbeat never
// reaches the server, so `HeartbeatSnapshot.lastHbFailCount` only covers
// streaks the device lived through and recovered from. Read-only and derived
// from `module_heartbeats.received_at` (no table, no writer — see ADR-005),
// returned by `backend GET /api/modules/:id/heartbeat-gaps` (admin-gated,
// proxying duckdb-service `GET /heartbeats/<id>/gaps`). Newest gap first.
export interface HeartbeatGap {
  gapStart: string; // ISO timestamp — last heartbeat before the silence
  gapEnd: string; // ISO timestamp — first heartbeat after the silence
  gapSeconds: number; // wall-clock width of the gap, in seconds
}

export interface Module {
  id: ModuleId;
  // Firmware-reported name. Mutates on every registration / UPSERT
  // (duckdb-service `add_module` writes whatever the ESP posted in
  // `module_name`). Same-batch ESPs used to collide here — issue #92
  // fixed the entropy and #94's auto-suffix in `add_module` keeps
  // collisions from reaching this field. Used as the *fallback* label
  // when `displayName` is null / empty / whitespace-only; resolution
  // happens in `homepage/src/lib/displayLabel.ts`.
  name: string;
  // Admin-settable override (see ADR-011). Server-side UNIQUE so two
  // modules cannot share a display label. The wire shape permits null
  // OR the empty string; resolution to the operator-visible label
  // happens client-side via `homepage/src/lib/displayLabel.ts`.
  displayName: string | null;
  // Generalized to `PUBLIC_COORD_DECIMALS` (~1.1 km) as a privacy control —
  // NOT a precision bug. The exact fix is never served to any caller (admin
  // included) and, after the duckdb-service round-on-write + migration, never
  // persisted. See `coarsenLocation`, issue #145, and ADR-020.
  location: {
    lat: number;
    lng: number;
  };
  // 'unknown' is set when we cannot confidently tell — e.g. the heartbeat
  // service was unreachable AND no other liveness signal exists. The
  // dashboard renders a third (gray) badge for this state instead of a
  // misleading red 'offline'. See backend/src/database.ts and #31.
  status: 'online' | 'offline' | 'unknown';
  lastApiCall: string; // ISO date string
  batteryLevel: number;
  firstOnline: string; // ISO date string
  totalHatches: number; // Sum of all hatches across all nests
  imageCount: number; // Total images uploaded by this module
  email: string | null;
  // ISO timestamp — row-metadata; bumped on every UPDATE to
  // `module_configs` (registration, display-name rename, legacy
  // heartbeat row-update, heartbeat-side geo-patch). Use `lastSeenAt`
  // for device-liveness, NOT this — the split shipped in PR B / issue
  // #97. See chapter 11 "updated_at semantic overload" for why.
  updatedAt?: string;
  // Liveness — derived from max(last_seen_at, lastApiCall,
  // latestHeartbeat.receivedAt). `last_seen_at` is bumped only on
  // per-boot registration in duckdb-service `add_module`; metadata
  // writes (rename, geo-patch, legacy heartbeat) do NOT corrupt it
  // (post-#97 split). If null, the module has never phoned home.
  lastSeenAt: string | null;
  latestHeartbeat: HeartbeatSnapshot | null;
}

export interface NestData {
  nest_id: string;
  module_id: ModuleId;
  beeType: 'blackmasked' | 'resin' | 'leafcutter' | 'orchard';
  dailyProgress: DailyProgress[];
}

export interface DailyProgress {
  progress_id: string;
  nest_id: string;
  date: string; // ISO date string
  empty: number;
  sealed: number;
  hatched: number;
}

export interface ModuleDetail extends Module {
  nests: NestData[];
}

// ---- Image uploads ----
//
// Wire-shape returned by `GET /api/images` (backend proxies
// `image-service GET /images`, which proxies `duckdb-service GET
// /image_uploads`). Newest-first. Lives here, not in
// `homepage/src/services/api.ts`, per ADR-004 — any DTO crossing the
// backend↔homepage boundary belongs in the shared workspace package.

export interface ImageUpload {
  module_id: string;
  filename: string;
  // UTC, NOT full ISO-8601 (no 'T'/'Z'). In practice "YYYY-MM-DD
  // HH:MM:SS" because `record_image` writes it at second resolution,
  // but the reader (`list_image_uploads`) emits `str()` of a DuckDB
  // TIMESTAMP and does not re-format — a row written with sub-second
  // precision would surface fractional seconds. Treat as an opaque
  // sortable string; parse defensively if you ever need a Date.
  uploaded_at: string;
}

// Paginated envelope. `total` is the full count matching the filter,
// ignoring limit/offset — the admin UI uses it to decide whether to
// render a "Load more" button.
export interface ImageUploadsPage {
  images: ImageUpload[];
  total: number;
}

// ---- Per-nest hole-detection snips (issue #165) ----
//
// Wire-shape returned by `backend GET /api/modules/:id/snips`, which proxies
// `duckdb-service GET /detections?module_id=`. One entry per nest hole — the
// latest detection per (beeType, nestIndex). The crop is the privacy mechanism
// (issue #154): a snip frames only the hole, so it is served without auth via
// `GET /api/snips/:filename`. Consumers build the image URL from `snipFilename`
// with `api.getSnipUrl(...)`, mirroring `ImageUpload.filename`/`getImageUrl`.
//
// Lives here, not in `homepage/src/services/api.ts`, per ADR-004 — any DTO
// crossing the backend↔homepage boundary belongs in the shared package.

export interface NestSnip {
  // Canonical DB bee type, matching `NestData.beeType` (not the image-service
  // wire key `leafcutter_bee`). The backend maps the stored key to this form.
  beeType: 'blackmasked' | 'resin' | 'leafcutter' | 'orchard';
  nestIndex: number; // 1-based replicate within the bee type
  state: 'empty' | 'sealed';
  confidence: number; // 0-1; strength of the empty/sealed call
  // Filename of the cropped snip JPEG; resolve to a URL with `getSnipUrl`.
  snipFilename: string;
  // Normalized [x, y, w, h] in [0,1] of the snip box in the source capture.
  bbox: [number, number, number, number];
  sourceFilename: string; // the full capture this snip was cropped from
  detectedAt: string; // "YYYY-MM-DD HH:MM:SS" UTC, opaque sortable string
}

export interface NestSnipsResponse {
  snips: NestSnip[];
}

// ---- Telemetry sidecar envelope ----
//
// Wire-shape returned by `image-service /modules/<mac>/logs` (proxied
// unchanged by `backend GET /api/modules/:id/logs`). Each entry is the
// dump of `image-service/services/sidecar.py`'s `LogSidecarEnvelope`
// pydantic model. The raw ESP telemetry lives nested inside `payload`;
// service-injected metadata (mac, received_at, image) lives at the
// top level. Pre-envelope sidecars are read-compat: image-service's
// `LogSidecarEnvelope.from_disk` re-shapes them into this same shape
// before responding.
//
// Lives here, not in `homepage/src/services/api.ts`, per ADR-004 —
// any DTO crossing the backend↔homepage boundary belongs in the
// shared workspace package so a wire-shape mismatch is a TypeScript
// compile error, not a silent dashboard `—`.

export interface TelemetryPayload {
  fw?: string;
  uptime_s?: number;
  last_reset_reason?: string;
  // RTC_NOINIT stage breadcrumb recovered on the next boot after a
  // software reset (TASK_WDT, panic, ESP.restart). Names which long-
  // running call was active when the previous run ended. Optional —
  // omitted by firmware when no breadcrumb survived (clean boot or
  // first boot after power-on). Diagnostic for issue #42; see
  // docs/06-runtime-view/esp-reliability.md "8. Stage breadcrumb".
  last_stage_before_reboot?: string;
  free_heap?: number;
  min_free_heap?: number;
  rssi?: number;
  wifi_reconnects?: number;
  last_http_codes?: number[];
  // Last ~2 KB of `logf()` output from the firmware ring buffer, oldest
  // → newest. Cap is `LOGBUF_SIZE` in `ESP32-CAM/logbuf.h`. May contain
  // embedded control chars and (rarely) embedded NULs; the firmware
  // emits them via the JSON `\u00xx` escape so the string is always a
  // valid JSON string. UI consumers should render in a `<pre>` block.
  log?: string;
}

export interface TelemetryEntry {
  mac: string;
  received_at: string; // ISO timestamp, image-service-injected
  image: string; // filename, image-service-injected
  payload: TelemetryPayload;
}

// ---- User-location hint (issue #14) ----
//
// Returned by `backend GET /api/user-location`. Permissionless, IP-based
// guess used solely as a "first paint" centre for the dashboard map so a
// visitor lands roughly near home instead of on the default Lake Constance
// view. Accuracy is city-level (~10–50 km); precise GPS still comes from
// `navigator.geolocation.getCurrentPosition()` triggered by the map's
// locate button.

export interface UserLocation {
  lat: number;
  lng: number;
}

// ---- Activity time series (weather-correlation feature) ----
//
// Returned by `backend GET /api/modules/:id/activity` (camelCase),
// which proxies `duckdb-service /modules/<id>/activity_timeseries`
// (snake_case → camelCase mapping happens in the backend).
//
// `buckets` covers the requested window densely: a bucket with zero
// uploads is emitted with `count: 0` rather than omitted, so the
// homepage chart renders flat regions instead of stitching across
// gaps. Bucket-start timestamps are UTC ISO 8601; the homepage
// converts to the browser's locale at render time.

export type ActivityInterval = 'hourly' | 'daily';

export interface ActivityBucket {
  timestamp: string; // ISO 8601 (UTC), bucket start
  count: number;
}

export interface ActivityTimeSeries {
  moduleId: ModuleId;
  interval: ActivityInterval;
  start: string; // ISO 8601 (UTC), inclusive
  end: string; // ISO 8601 (UTC), exclusive
  buckets: ActivityBucket[];
}

// ---- Per-module measurements time series (issue #110) ----
//
// Canonical store for per-module sensor / derived metrics. Returned by
// `backend GET /api/modules/:id/measurements` (camelCase), which proxies
// `duckdb-service /modules/<id>/measurements` (snake_case → camelCase
// mapping in the backend, mirroring the activity-timeseries proxy).
//
// `MeasurementBucket.value` is deliberately `number | null`:
// `ActivityBucket.count` treats absence-as-zero because zero uploads in
// an hour is a meaningful zero, but a missing battery reading is NOT a
// reading of zero — collapsing the gap to 0 would mis-render a silent
// device as a flat-line discharge. `sampleCount` separates "we
// aggregated zero samples here" from "we aggregated samples and the
// average was 0", so a future zero-value reading still distinguishes
// from a gap. The duckdb-service aggregate is `AVG(value)` per bucket.
//
// `metric` and `source` are open strings on the wire so a new producer
// (classifier for #114) can append without requiring a contracts
// release first; the producer's ADR pins the chosen identifier so it
// doesn't drift across services. The canonical, current list of
// known metric / source values lives at
// `docs/08-crosscutting-concepts/api-contracts.md` § "Known `source`
// values in the wild" — keeping it there rather than in this
// comment so a new producer doesn't have to touch this file (and
// so this comment can't go stale without anyone noticing).
//
// A `Measurement` (single-row) shape lived here briefly in the initial
// #110 PR but was unused — the homepage reads `MeasurementTimeSeries`,
// the backend forwards `Record<string, unknown>` on the admin write
// route. The case discipline for a single-row shape (e.g. `moduleMac`
// vs `module_mac` on the wire) should be pinned by the first real
// producer (#111 weather worker) when it lands, not speculated now.

export interface MeasurementBucket {
  timestamp: string; // ISO 8601 (UTC), bucket start
  // `null` when no samples landed in this bucket. NOT zero — see the
  // module docstring above for why this distinction is load-bearing.
  value: number | null;
  sampleCount: number;
}

export interface MeasurementTimeSeries {
  moduleId: ModuleId;
  metric: string;
  interval: ActivityInterval; // reuses the existing 'hourly' | 'daily'
  start: string; // ISO 8601 (UTC), inclusive
  end: string; // ISO 8601 (UTC), exclusive
  buckets: MeasurementBucket[];
}

// Admin-gated server process logs (#171, #178). Each service keeps a bounded
// ring of its own recent log entries (a stdout/stderr tee plus a structured
// logger, same idea as the ESP `logbuf`), exposed for
// `GET /api/admin/logs?service=…&lines=N` and streamed live via
// `GET /api/admin/logs/stream?service=…`.
// `nginx` is deliberately absent — it has no app process to host a ring, so
// its logs stay a host/file concern (out of scope). See ADR-021/ADR-023.
export type ServerLogService = 'backend' | 'duckdb-service' | 'image-service';

// Severity of a single log entry. Drives the panel's color coding and the
// access-log middleware's status→level mapping (>=500 error, >=400 warn, else
// info). Kept deliberately small — this is operational logging, not a
// general-purpose level taxonomy.
export type LogLevel = 'info' | 'warn' | 'error';

// One structured log line. Replaces the former raw `string[]`: every line now
// carries a timestamp and level so the panel can render `ts · level · msg`,
// color-code, filter, and export. The SSE stream emits one `LogEntry` per
// `data:` event; the REST backfill returns an array of them.
export interface LogEntry {
  ts: string; // ISO 8601 (UTC), e.g. '2026-06-18T20:42:55.123Z'
  level: LogLevel;
  msg: string;
}

export interface ServerLogsResponse {
  service: ServerLogService;
  // Captured log entries, chronological (oldest→newest), like `tail`. In-memory
  // in Phase 1 (resets on process restart); on-disk persistence + rotation
  // (survives restart, bounded to 30 days / 100 MB) is ADR-023 / Phase 3.
  entries: LogEntry[];
  // True when the ring held more entries than were returned (clipped to the
  // requested `lines`, itself capped server-side). Lets the UI show a
  // "showing last N" hint without a separate count.
  truncated: boolean;
}
