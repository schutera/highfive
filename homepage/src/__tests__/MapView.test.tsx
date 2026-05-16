import { describe, it, expect } from 'vitest';
import { hasPlausibleLocation } from '../lib/location';

// Pure unit tests for `hasPlausibleLocation`. The helper mirrors the
// `hf::isPlausibleFix` rule on the firmware side (PR II / issue #89)
// and the `_is_plausible_fix` rule on the server side
// (`duckdb-service/routes/heartbeats.py`). Same rule on all three
// layers — a refactor that drifts one without the other is a
// regression these tests catch.
//
// MapView itself is harder to mount under jsdom (react-leaflet
// requires a canvas-capable env). The component-level tests for the
// (0,0)-filter behaviour live in `DashboardPage.test.tsx`, which
// already wires the leaflet-in-jsdom mock pattern.

describe('hasPlausibleLocation', () => {
  // --- rejection cases --------------------------------------------------

  it('rejects Null Island (0,0)', () => {
    expect(hasPlausibleLocation({ lat: 0, lng: 0 })).toBe(false);
  });

  it('rejects NaN lat', () => {
    expect(hasPlausibleLocation({ lat: NaN, lng: 9.61 })).toBe(false);
  });

  it('rejects NaN lng', () => {
    expect(hasPlausibleLocation({ lat: 47.78, lng: NaN })).toBe(false);
  });

  it('rejects out-of-range lat (>90)', () => {
    expect(hasPlausibleLocation({ lat: 91, lng: 9.61 })).toBe(false);
  });

  it('rejects out-of-range lat (<-90)', () => {
    expect(hasPlausibleLocation({ lat: -91, lng: 9.61 })).toBe(false);
  });

  it('rejects out-of-range lng (>180)', () => {
    expect(hasPlausibleLocation({ lat: 47.78, lng: 181 })).toBe(false);
  });

  it('rejects out-of-range lng (<-180)', () => {
    expect(hasPlausibleLocation({ lat: 47.78, lng: -181 })).toBe(false);
  });

  it('rejects null/undefined location', () => {
    expect(hasPlausibleLocation(null)).toBe(false);
    expect(hasPlausibleLocation(undefined)).toBe(false);
  });

  it('rejects Infinity', () => {
    expect(hasPlausibleLocation({ lat: Infinity, lng: 9.61 })).toBe(false);
  });

  // --- acceptance cases -------------------------------------------------

  it('accepts Bodensee coords', () => {
    expect(hasPlausibleLocation({ lat: 47.78, lng: 9.61 })).toBe(true);
  });

  it('accepts near-equator (0.0001, 0.0001)', () => {
    // Guards against an over-eager "near zero" rule. Real points
    // near the Greenwich/equator intersection are valid — only the
    // exact (0,0) sentinel should be rejected.
    expect(hasPlausibleLocation({ lat: 0.0001, lng: 0.0001 })).toBe(true);
  });

  it('accepts lat-only zero (equator, off Greenwich)', () => {
    // Real-world: buoy at (0, 90). The sentinel rule must require
    // BOTH coords zero — same symmetry as the firmware helper.
    expect(hasPlausibleLocation({ lat: 0, lng: 90 })).toBe(true);
  });

  it('accepts lng-only zero (Greenwich meridian, off equator)', () => {
    expect(hasPlausibleLocation({ lat: 51.5, lng: 0 })).toBe(true);
  });

  it('accepts boundary coords', () => {
    expect(hasPlausibleLocation({ lat: 90, lng: 180 })).toBe(true);
    expect(hasPlausibleLocation({ lat: -90, lng: -180 })).toBe(true);
  });
});
