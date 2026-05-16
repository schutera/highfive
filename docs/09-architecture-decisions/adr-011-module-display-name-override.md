# ADR-011: Two-column module naming — firmware `name` + admin-settable `display_name`

## Status

Accepted

## Context

A module's user-visible label originates in two places at once and the
two are in tension:

1. **Firmware-reported `module_name`.** Each ESP32 generates a default
   bee-themed name from its MAC ([`ESP32-CAM/lib/module_name/`](../../ESP32-CAM/lib/module_name/module_name.h),
   issue #92) and POSTs it to `/new_module` on every boot. The captive
   portal lets the operator override the default in SPIFFS — but only
   after issue #91's fix actually reads `MODULE_NAME` back from SPIFFS;
   pre-PR-I `loadConfig()` discarded the operator's choice silently.
   Either way, the firmware-reported value churns: every registration
   is a UPSERT, and a re-flashed firmware can re-default the name back
   to the auto-generated form.

2. **Operator's chosen label.** The dashboard surface (`ModulePanel`
   header, `DashboardPage` lists, `AdminPage` table) needs a stable
   human-readable label that the operator can change without
   re-flashing the device. The label has a UNIQUE invariant: two
   modules on the same dashboard with the same label leave the
   operator unable to tell them apart.

Pre-PR-I the schema had one `name VARCHAR(100) NOT NULL` column on
`module_configs` and no UNIQUE constraint, so it tried to be both
things at once and ended up being neither well:

- Same-batch ESP firmwares generated the same default name (#92 —
  `b0:69:6e:f2:3a:08` and `e8:9f:a9:f2:3a:08` both registered as
  `fierce-apricot-specht`), and the server happily stored both rows
  without warning. The dashboard showed two indistinguishable modules
  (#94).
- An operator who wanted to rename a module had no API path; even if
  they edited the captive-portal `MODULE_NAME`, the next firmware
  update could overwrite it (it didn't, pre-PR-I, because `loadConfig`
  was broken in a _helpful_ direction — but that's accidental, not
  designed).

Alternatives considered:

- **Single `name` column, UNIQUE-constrained.** Closes #94 cleanly,
  but the firmware-reported value is _intentionally_ mutable on every
  UPSERT (the registration call is also the firmware's "I'm alive,
  here's my current self-description" handshake). UNIQUE on a column
  that the firmware UPSERTs every boot turns a same-batch collision
  into an outright registration failure — silent loss of telemetry
  rather than a confusing dashboard.
- **Single `name` column, mutable, auto-suffix only.** Closes #94
  half-way (server-side disambiguation works), but there's still no
  way for the operator to set a stable label that survives firmware
  re-flashes. The "rename" UX would have to PATCH the same column
  that the next registration overwrites — race conditions ahead.
- **Firmware-only naming.** Push naming all the way to the device
  (captive portal is the authoritative source). The firmware-fix half
  of #91 already does this, but it leaves the bench-flashing operator
  doing per-device work to disambiguate field collisions; the dashboard
  has the operator's attention more often than the bench does.

## Decision

`module_configs` keeps two columns:

- **`name VARCHAR(100) NOT NULL`** — firmware-reported. No UNIQUE
  constraint. Mutable on every UPSERT. Collisions are handled
  server-side by an auto-suffix in `add_module()`
  ([`duckdb-service/routes/modules.py`](../../duckdb-service/routes/modules.py)
  `_resolve_unique_firmware_name`): if another module already holds
  the requested name, the new registration becomes `<name>-2`, `-3`,
  …, capped at `-99`. The response body echoes the actually-stored
  value so the firmware / operator can observe the disambiguation.

- **`display_name VARCHAR(100) UNIQUE`** — admin-settable override.
  Null by default. Set via `PATCH /api/modules/:id/name` (backend
  proxies to `duckdb-service` `PATCH /modules/<id>/display_name`),
  gated by `X-Admin-Key`. UNIQUE constraint enforced at the database;
  collisions surface as HTTP 409 carrying the conflicting MAC so the
  admin UI can render a useful inline error.

The frontend coalesces — `module.displayName ?? module.name` — in
every label-rendering surface
([`ModulePanel`](../../homepage/src/components/ModulePanel.tsx),
[`DashboardPage`](../../homepage/src/pages/DashboardPage.tsx),
[`AdminPage`](../../homepage/src/pages/AdminPage.tsx)). The MAC's
**leading** four hex chars (uppercased) ride along as a subtitle in
every list and panel so two modules sharing a label remain visually
distinct even before an operator runs the rename flow. The leading
nibbles are the right choice here, not the trailing ones: same-batch
ESP32 hardware shares its _trailing_ MAC octets — the field-incident
MACs `b0:69:6e:f2:3a:08` and `e8:9f:a9:f2:3a:08` share `f2:3a:08`, so
a trailing-4 disambiguator would render `3A08` on both and defeat the
whole purpose. The unique-prefix octets (`B069` vs `E89F`) are what
actually differ.

The DuckDB `ADD COLUMN ... UNIQUE` form is rejected by the v1.4
parser; the additive migration in
[`duckdb-service/db/schema.py`](../../duckdb-service/db/schema.py)
splits into `ADD COLUMN` + `CREATE UNIQUE INDEX`. Fresh-DB DDL keeps
the inline UNIQUE (CREATE TABLE does support it).

## Consequences

**Enables:**

- Same-batch firmwares can register without errors. The auto-suffix
  keeps the dashboard's labels unique even before an operator notices.
- Operators can rename modules from the dashboard's admin surface, and
  the rename survives every subsequent firmware re-registration
  (because the override lives on a different column than the
  firmware-reported value).
- The admin page shows both `name` and `display_name` so an operator
  who wants to know "what is this module _actually_ reporting itself
  as?" still has that information.

**Costs:**

- Two columns means two write paths: `add_module` writes `name`,
  `set_display_name` writes `display_name`. Code that reads the label
  must remember to coalesce; a single test missing the `displayName`
  branch leaves a silent dashboard regression where the override
  doesn't apply. The
  [`homepage/src/__tests__/ModulePanel.test.tsx`](../../homepage/src/__tests__/ModulePanel.test.tsx)
  fixture and the four-branch coverage there is the structural guard.
- The auto-suffix cap (`-99`) is arbitrary. A pathological collision
  rate raises rather than silently storing a 100th lookalike, which
  is the right failure mode but does mean a misbehaving fleet can
  trip an operator-visible error rather than degrade gracefully.

**Forecloses:**

- A future "operator edits the firmware name directly" UX is now
  ambiguous (does it set `name` or `display_name`?). The intended
  answer is `display_name`; the firmware-side captive portal remains
  the only writer of `name`. If we ever want the dashboard to push
  changes back to the device, that's a new endpoint, not an extension
  of this one.

## References

- [Issue #91 — `loadConfig()` never reads MODULE_NAME from SPIFFS](https://github.com/schutera/highfive/issues/91)
- [Issue #92 — `generateModuleName()` seeds from MAC bytes[0..2]](https://github.com/schutera/highfive/issues/92)
- [Issue #93 — server-side unique display-name layer](https://github.com/schutera/highfive/issues/93)
- [Issue #94 — no UNIQUE constraint on `module_configs.name`](https://github.com/schutera/highfive/issues/94)
- [ADR-002 — pure C++ helpers under `ESP32-CAM/lib/`](adr-002-esp-host-testable-lib.md) (the `module_name` lib follows this pattern)
- [ADR-003 — `HIGHFIVE_API_KEY` reused for admin gate](adr-003-shared-api-key-for-admin.md) (the rename endpoint's auth)
