import type { Module } from '@highfive/contracts';

// Single source of truth for "the operator-visible label for a module".
// Every surface that shows a module name MUST go through this helper —
// dashboard side-list, module-detail panel, admin table + dropdowns,
// setup-wizard step 5, rename modal.
//
// Defense:
//   - `displayName === null`  → fall back to firmware-reported `name`.
//   - `displayName === ''`    → also fall back. The wire contract permits
//     the empty string; `duckdb-service`'s `set_display_name` normalises
//     empty-after-strip to NULL server-side, but the type system doesn't
//     enforce it, so a third-party writer or a future write path could
//     leak `""` through. Without the trim, the side-list would render a
//     blank `<h3>` "ghost row" (defended against by the empty-string
//     regression tests in `DashboardPage.test.tsx` and
//     `ModulePanel.test.tsx`).
//   - `displayName === "  "`  → whitespace-only also falls back, by the
//     same logic; `.trim()` collapses it.
//
// Splitting the defense across surfaces would reproduce the
// "Three layers, one rule was actually four surfaces" failure pattern
// recorded in `docs/11-risks-and-technical-debt/README.md`. A prose
// invariant ("the UI coalesces displayName over name") that lives in
// six docs but is enforced inconsistently at six render sites is
// exactly the shape that bit us. Make the rule structural: one helper,
// one defense, every render site calls it.
//
// Per ADR-011: see `docs/09-architecture-decisions/adr-011-module-display-name-override.md`.
export function displayLabel(m: Pick<Module, 'name' | 'displayName'>): string {
  return m.displayName?.trim() || m.name;
}
