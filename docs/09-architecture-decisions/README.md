# 9. Architecture Decisions

Each ADR records one decision that shapes how HiveHive is built —
context, the choice, and the consequences. ADRs are append-only and
immutable; if a decision is overturned, supersede it with a new ADR
and link backwards.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [001](adr-001-duckdb-as-sole-writer.md) | DuckDB-service is the sole writer of `app.duckdb` | Accepted |
| [002](adr-002-esp-host-testable-lib.md) | Pure C++ helpers under `ESP32-CAM/lib/` for host testability | Accepted |
| [003](adr-003-shared-api-key-for-admin.md) | `HIGHFIVE_API_KEY` reused for both API key and admin key | Accepted |

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
