// Shared geolocation-plausibility helper. Mirrors the firmware
// `hf::isPlausibleFix` rule in `ESP32-CAM/lib/geolocation/` and the
// server `_is_plausible_fix` rule in
// `duckdb-service/routes/heartbeats.py`. Three layers, one rule —
// a refactor that drifts one without the others is a test-suite
// regression on three sides at once (see PR II / issue #89, and
// chapter-11 "First-boot geolocation race").
//
// Lives in `homepage/src/lib/` rather than next to `MapView.tsx`
// because three consumers (AdminPage, DashboardPage, ModulePanel)
// need it and only one of them is map-related — the original PR II
// landing co-located it with MapView and round-1 senior-review
// flagged the import smell.

import type { Module } from '@highfive/contracts';

// Argument is bound to `Pick<Module['location'], 'lat' | 'lng'>` so
// a future contracts rename (e.g. `lat → latitude`) becomes a
// TypeScript compile error at every call site rather than a silent
// `undefined`-pluck. Round-2 senior-review P2 trip-wire — ADR-004's
// "wire-shape drift becomes a compile error" guarantee depends on
// helpers actually consuming the contracts shape, not a structurally
// compatible inline `{lat, lng}`.
export function hasPlausibleLocation(
  loc: Pick<Module['location'], 'lat' | 'lng'> | null | undefined,
): boolean {
  if (!loc) return false;
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return false;
  if (loc.lat === 0 && loc.lng === 0) return false;
  if (Math.abs(loc.lat) > 90 || Math.abs(loc.lng) > 180) return false;
  return true;
}
