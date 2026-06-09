# 9. Architecture Decisions

Each ADR records one decision that shapes how HiveHive is built —
context, the choice, and the consequences. ADRs are append-only and
immutable; if a decision is overturned, supersede it with a new ADR
and link backwards.

## Index

| ADR                                                         | Title                                                                           | Status   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| [001](adr-001-duckdb-as-sole-writer.md)                     | DuckDB-service is the sole writer of `app.duckdb`                               | Accepted |
| [002](adr-002-esp-host-testable-lib.md)                     | Pure C++ helpers under `ESP32-CAM/lib/` for host testability                    | Accepted |
| [003](adr-003-shared-api-key-for-admin.md)                  | `HIGHFIVE_API_KEY` reused for both API key and admin key                        | Accepted |
| [004](adr-004-heartbeat-snapshot-in-contracts.md)           | `HeartbeatSnapshot` lives in `@highfive/contracts`                              | Accepted |
| [005](adr-005-silence-watcher-in-duckdb-service.md)         | Discord silence watcher lives in `duckdb-service`                               | Accepted |
| [006](adr-006-bee-name-firmware-versioning.md)              | ESP firmware uses bee-species names as version identifiers                      | Accepted |
| [007](adr-007-esp-reliability-breaker-and-daily-reboot.md)  | ESP reliability — circuit breaker + daily reboot + camera PWDN recovery         | Accepted |
| [008](adr-008-firmware-ota-partition-and-rollback.md)       | Firmware OTA — partition layout, two-slot rollback, dual-binary publish         | Accepted |
| [009](adr-009-node-22-baseline.md)                          | Node 22.12+ baseline for `backend` and `homepage`, enforced via `engine-strict` | Accepted |
| [010](adr-010-esp-firmware-tls-trust-model.md)              | ESP firmware TLS — CA-pinned trust anchors for highfive.schutera.com            | Accepted |
| [011](adr-011-module-display-name-override.md)              | Two-column module naming — firmware `name` + admin-settable `display_name`      | Accepted |
| [012](adr-012-dashboard-ip-geo-hint.md)                     | Dashboard map IP-geo hint via backend proxy (not `GEO_API_KEY`)                 | Accepted |
| [013](adr-013-compensating-restore-for-duckdb-fk-update.md) | Bespoke autocommit + compensating-restore for DuckDB FK over-enforced UPDATEs   | Accepted |
| [014](adr-014-playwright-ui-tests.md)                       | UI tests run real Chromium against the production-built homepage via Playwright | Accepted |
| [015](adr-015-weather-correlation.md)                       | Activity-vs-weather chart — Open-Meteo browser-direct + Recharts                | Accepted |
| [016](adr-016-per-module-measurements-store.md)             | Per-module time-series store is one wide `measurements` table                   | Accepted |
| [017](adr-017-external-weather-source.md)                   | Server-side weather worker fetches Open-Meteo into the measurements store       | Accepted |
| [018](adr-018-captive-portal-wifi-only.md)                  | Captive portal is Wi-Fi-only; identity / URLs / camera defaulted in firmware    | Accepted |
| [019](adr-019-admin-session-no-bundle-secret.md)            | Admin auth is a server-side session cookie; no secret in the homepage bundle    | Accepted |
| [020](adr-020-coordinate-generalization.md)                 | Module coordinates are generalized to ~1 km (2 dp) for every caller             | Accepted |

## When to create an ADR

Create an ADR when you:

- Introduce a new dependency, framework, or external service
- Choose between two viable approaches and want to record _why_
- Change a pattern that is already in use elsewhere
- Add or remove a non-obvious constraint
- Resolve a recurring question that keeps coming up in code review

If the decision is "pick the obvious thing", you don't need an ADR.
If you find yourself explaining the same trade-off twice, you do.

## Template

```markdown
# ADR-NNN: <decision in one line>

## Status

Accepted | Proposed | Superseded by [ADR-MMM](adr-MMM-...)

## Context

What problem is being solved? What constraints apply? What did we try
or rule out?

## Decision

The choice we made. One paragraph maximum.

## Consequences

What this enables, what it costs, what it forecloses. Both positive
and negative.
```
