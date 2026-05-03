// Canonical wire-shape contracts shared between `backend` and `homepage`.
//
// Both consumers import from `@highfive/contracts` (npm workspace), so any
// drift between the two TypeScript sources becomes a compile-time error
// instead of a silent field mismatch on the wire.
//
// The shapes here mirror what `backend/src/database.ts` returns to the
// homepage; that file remains the source of truth for the wire contract,
// and these declarations are cut-and-pasted from the original
// `backend/src/types.ts`. Field-name drift (e.g. `progess`/`hateched`)
// is called out in `UBIQUITOUS_LANGUAGE.md`.

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
  status: 'online' | 'offline';
  lastApiCall: string; // ISO date string
  batteryLevel: number;
  firstOnline: string; // ISO date string
  totalHatches: number; // Sum of all hatches across all nests
  imageCount: number; // Total images uploaded by this module
  email: string | null;
  updatedAt?: string; // ISO timestamp — set on every registration/UPSERT
  // Liveness — derived from max(updatedAt, lastApiCall, latestHeartbeat.receivedAt).
  // If null, the module has never phoned home.
  lastSeenAt?: string | null;
  latestHeartbeat?: HeartbeatSnapshot | null;
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
