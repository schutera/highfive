#pragma once

namespace hf {

// Reject a geolocation reading that looks like the (0,0,0) "no fix"
// sentinel set in `esp_init.cpp`'s `loadConfig` (the three
// `esp_config->geolocation.{latitude,longitude,accuracy} = 0.0f`
// lines), an out-of-range value (a parser glitch on the Google
// response), or NaN. The accuracy check (acc <= 0) covers the
// Google API's own "no fix" signal — the service emits an HTTP 200
// with `accuracy: 0` when the WiFi-BSSID signature couldn't be
// matched, and the old single-shot path stored that response
// verbatim. Returning true means the caller should treat the fix as
// usable; false means "treat as no fix yet, try again later or fall
// back to the (0,0) sentinel".
//
// Pure C++17, no Arduino deps, host-testable. Same pattern as
// lib/module_name/ from PR I — the helper exists outside the firmware
// so the Unity host suite can pin every edge case (Null Island,
// equator-but-not-Null-Island, lat=91, lng=181, NaN, zero accuracy)
// without having to flash hardware.
bool isPlausibleFix(float lat, float lng, float acc);

// Number of decimal places a served/stored coordinate is generalized to
// (~1.1 km grid). Keep in sync with `PUBLIC_COORD_DECIMALS` in
// `contracts/src/index.ts` and `duckdb-service/models/geo.py` — "one rule,
// mirrored at three layers", the same pattern as `isPlausibleFix`.
constexpr int kPublicCoordDecimals = 2;

// Generalize a single coordinate to `kPublicCoordDecimals` decimal places
// before it ever leaves the device — data minimization at source (issue
// #145, ADR-020). The server still rounds on write because it cannot trust
// the client (old firmware, spoofed upload), but rounding here means the
// precise fix never even traverses the network. Preserves the (0,0)
// sentinel (rounding 0 stays 0) and passes NaN/Inf through unchanged so a
// parser glitch surfaces to `isPlausibleFix` rather than becoming 0. Pure
// C++17, no Arduino deps, host-testable.
float roundCoord(float value);

}  // namespace hf
