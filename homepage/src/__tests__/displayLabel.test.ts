import { describe, it, expect } from 'vitest';
import { displayLabel } from '../lib/displayLabel';

// One test per documented branch in `displayLabel.ts`'s header. The
// integration tests at `DashboardPage.test.tsx` and
// `ModulePanel.test.tsx` mount the helper through React, which is the
// regression shape we need for "every render site goes through the
// helper". This file is the structural-contract pin: the helper's
// rule itself, gated at build time, decoupled from any one render
// site so a future caller (a new admin tooltip, a CSV export label,
// whatever) gets a single source of truth to assert against.
describe('displayLabel', () => {
  it('returns name when displayName is null', () => {
    expect(displayLabel({ name: 'firmware-name', displayName: null })).toBe('firmware-name');
  });

  it('returns name when displayName is the empty string', () => {
    // The wire contract permits `""`; duckdb-service's
    // `set_display_name` normalises empty-after-strip to NULL server-
    // side, but the type system doesn't enforce it. Without this
    // defense, a `""` displayName would render as a blank `<h3>`/
    // `<h2>` ghost row. Pinned at every render site too — this is the
    // structural pin.
    expect(displayLabel({ name: 'firmware-name', displayName: '' })).toBe('firmware-name');
  });

  it('returns name when displayName is whitespace-only', () => {
    expect(displayLabel({ name: 'firmware-name', displayName: '   ' })).toBe('firmware-name');
    expect(displayLabel({ name: 'firmware-name', displayName: '\t\n' })).toBe('firmware-name');
  });

  it('returns displayName when set to a non-empty value', () => {
    expect(displayLabel({ name: 'firmware-name', displayName: 'Garden Bee' })).toBe('Garden Bee');
  });

  it('trims surrounding whitespace from a non-whitespace-only displayName', () => {
    // `duckdb-service`'s `set_display_name` strips and then validates
    // 1..100 chars, so the persisted form has no leading/trailing
    // whitespace. But the wire shape doesn't enforce that — if a
    // third-party writer round-trips `"  Garden Bee  "`, the dashboard
    // should render the clean form, not the padded one.
    expect(displayLabel({ name: 'firmware-name', displayName: '  Garden Bee  ' })).toBe(
      'Garden Bee',
    );
  });
});
