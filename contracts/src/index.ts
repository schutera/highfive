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

export interface Module {
  id: string;
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
  module_id: string;
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
