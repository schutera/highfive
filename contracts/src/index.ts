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

/** Canonicalize and validate. Throws on invalid input. */
export const parseModuleId = (input: string): ModuleId => {
  const c = input.replace(/[:\-\s]/g, '').toLowerCase();
  if (!MODULE_ID.test(c)) {
    throw new Error(`invalid ModuleId: ${input}`);
  }
  return c as ModuleId;
};

/** Non-throwing variant for boundary code that wants to surface a 400. */
export const tryParseModuleId = (input: string): ModuleId | null => {
  try {
    return parseModuleId(input);
  } catch {
    return null;
  }
};

export interface HeartbeatSnapshot {
  receivedAt: string; // ISO timestamp
  battery: number | null;
  rssi: number | null;
  uptimeMs: number | null;
  freeHeap: number | null;
  fwVersion: string | null;
}

export interface Module {
  id: ModuleId;
  name: string;
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
  updatedAt?: string; // ISO timestamp — set on every registration/UPSERT
  // Liveness — derived from max(updatedAt, lastApiCall, latestHeartbeat.receivedAt).
  // If null, the module has never phoned home.
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
