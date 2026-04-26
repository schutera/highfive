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
