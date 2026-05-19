# ADR-013: Bespoke autocommit + compensating-restore for UPDATEs that DuckDB FK enforcement blocks

## Status

Accepted

## Context

DuckDB 1.4.4 (and 1.5.2, verified during PR B) over-enforces foreign-key
constraints: any UPDATE on a row whose primary key is referenced by a
child table fails with
`ConstraintException: Violates foreign key constraint because key
"module_id: ..." is still referenced by a foreign key in a different
table` — even when the UPDATE doesn't touch the FK column. The
documented limitation says "updates that affect referenced rows must
be propagated using DELETE-then-INSERT"; the implementation interprets
"affect" as "the row exists and is referenced". The effect is observed
most sharply when the UPDATE touches a UNIQUE-constrained column
(`module_configs.display_name` was the trigger case).

The project has an atomicity primitive,
[`duckdb-service/db/repository.py`](../../duckdb-service/db/repository.py)'s
`write_transaction`, which acquires the global write lock, issues an
explicit `BEGIN`, yields the connection, and `COMMIT`s on clean exit
or `ROLLBACK`s on exception. The vast majority of multi-statement
writers in `duckdb-service` use it. But: **inside an explicit
transaction, DuckDB's FK enforcement uses the transaction-snapshot
view of the data, not the row's current state inside the
transaction.** So the standard "temp-table dance" workaround for the
FK over-enforcement — snapshot child rows, DELETE them in reverse-FK
order, run the UPDATE on the now-unreferenced parent, re-insert the
children — fails inside `write_transaction()`: the UPDATE still sees
the pre-DELETE snapshot of `nest_data` references and trips the same
FK exception that motivated the workaround.

This created a forced trade-off: full transactional atomicity vs.
admit-the-UPDATE-on-FK-referenced-rows.

The alternatives the issue's reporter suggested all turned out to be
inapplicable in DuckDB (empirical results captured at PR B execution,
duckdb-python==1.4.4):

- **`PRAGMA foreign_keys = OFF`** — SQLite pragma, not DuckDB. DuckDB
  returns `Catalog Error: unrecognized configuration parameter
"foreign_keys"`.
- **`ALTER TABLE nest_data DROP CONSTRAINT ...`** — raises
  `NotImplementedException: No support for that ALTER TABLE option
yet`. DuckDB 1.4.4 does not implement that ALTER form.
- **`INSERT ... ON CONFLICT (id) DO UPDATE`** — same FK
  over-enforcement when the SET clause touches a UNIQUE-constrained
  column. The UPSERT branch is treated as a regular UPDATE for FK
  purposes.
- **DuckDB version bump (1.4.4 → 1.5.2)** — 1.5.2 still has the bug.
  Verified by re-running the regression test against 1.5.2; same
  exception.

## Decision

`set_display_name` opts out of `write_transaction()` and runs its
dance in autocommit mode (each `con.execute` commits individually).
The atomicity guarantee is provided at the Python layer:

1. **Snapshot phase.** Read `daily_progress` rows for this module
   (JOINed via `nest_data`) and `nest_data` rows for this module
   into in-memory tuples.
2. **Mutation phase.** DELETE `daily_progress` rows (grandchild),
   DELETE `nest_data` rows (child), UPDATE `module_configs` (parent
   now FK-unreferenced), INSERT `nest_data` rows back, INSERT
   `daily_progress` rows back.
3. **Compensating-restore on exception.** If any mutation raises, an
   inner exception handler calls a `_restore_children()` closure that
   DELETEs any partial inserts then re-INSERTs the full snapshot.
   The handler converges from any intermediate state — DELETE-phase
   partial failures, UPDATE failures, INSERT-phase partial failures.
4. **Restore-failure surface.** If `_restore_children()` itself
   raises, the 500 response body carries
   `{"restore_failed": true, "module_id": <mac>, "message": "...
restore from backup before retrying"}` so the backend can
   distinguish "retry-safe rename failure" from "data lost".

The global `lock` in
[`duckdb-service/db/connection.py`](../../duckdb-service/db/connection.py)
is held for the whole dance, so no concurrent reader or writer
observes the half-deleted state. This is load-bearing: every
duckdb-service read goes through the same lock
([`db/repository.py`](../../duckdb-service/db/repository.py)'s
`query_all` / `query_one` / `query_scalar`).

## When to use this pattern

This pattern is the **opt-out from `write_transaction()`**, not the
default. Reach for it when ALL of the following hold:

1. You need to UPDATE a row whose primary key is referenced by a
   child table, AND
2. The UPDATE touches a UNIQUE-constrained column (DuckDB
   over-enforces FK on these specifically — observed empirically), AND
3. The standard `write_transaction()` helper would trip the FK
   exception via its `BEGIN` (verifiable by trying it and seeing
   `ConstraintException: ... still referenced` come back).

If condition 2 doesn't hold, the UPDATE inside `write_transaction()`
works fine. If condition 1 doesn't hold (no child references), the
FK over-enforcement doesn't fire at all. Both `add_module`'s UPSERT
and the legacy `/modules/<id>/heartbeat` route are in this safer
zone — they stay on `write_transaction()`.

The pattern must be paired with a fault-injection test
(`test_set_display_name_restores_children_on_mid_dance_failure` is
the prior art) that pins the compensating-restore contract — without
the test, a refactor that drops the restore handler would pass the
happy-path test and silently regress.

## Consequences

**Positive:**

- The user-visible bug (#105 — operators couldn't rename seeded
  modules) is fixed without giving up `write_transaction()`'s
  atomicity for other callers. The four routes that don't have the
  FK over-enforcement constraint (`add_module`, `record_image`,
  `add_progress_for_module`, legacy `heartbeat`) keep their real
  transactional semantics — PR B's senior-review caught that
  `write_transaction` was missing its `BEGIN` and the fix benefits
  all four uniformly.
- The compensating-restore semantics are observable: success returns
  200, retry-safe failures return 500 with the original error, and
  the rare "restore-itself-failed" mode returns 500 with the
  `restore_failed: true` marker so the backend can surface "restore
  from backup" rather than "retry".

**Negative:**

- Two paths now exist for multi-statement atomicity in
  `duckdb-service`: `write_transaction()` for the standard case,
  bespoke autocommit + compensating-restore for the DuckDB-FK-over-
  enforcement case. Future contributors writing a new UPDATE need to
  pick the right one. The chapter 11 entry for #105 documents the
  decision tree, and this ADR is the long-form reference.
- The dance's atomicity is best-effort, not transactional. If the
  Python process dies mid-dance (between `DELETE` and re-`INSERT`),
  the database is left in the half-deleted state. The probability is
  low (one route, lock held, container restart would replay the
  request from the operator's side), but it's strictly weaker than
  the transactional guarantee.
- The compensating-restore handler duplicates the DELETE+INSERT logic
  from the happy path. A future column add to `nest_data` or
  `daily_progress` has to land in both places. Mitigation: the inner
  `_restore_children` closure is a single function, called from the
  one exception path; the duplication is bounded to that one route.

## Alternatives considered

- **DuckDB version bump alone (1.4.4 → 1.5.2).** Tried first per PR
  B's plan. The FK over-enforcement persists in 1.5.2; reverted.
  Worth revisiting if DuckDB ever relaxes the constraint upstream.
- **Drop the `nest_data.module_id` FK constraint entirely.** Loses
  the structural guarantee that every nest row points at a real
  module. The schema's whole point is that the FK enforces "no orphan
  nests"; dropping it transfers the invariant from SQL to
  application code, which the project has historically avoided
  (ADR-001 makes `duckdb-service` the sole writer specifically so
  these invariants can stay in SQL).
- **Switch the column type to remove the UNIQUE constraint.** The
  UNIQUE invariant on `display_name` is load-bearing — two modules
  on the same dashboard with the same label leave the operator
  unable to tell them apart (ADR-011 has the full rationale). Not
  negotiable.
- **A DEFERRED-FK transaction.** DuckDB 1.4.4/1.5.2 has limited
  support for deferred constraints; the FK over-enforcement we hit
  fires at statement time regardless of deferral. Same effect.
- **`write_transaction()` with explicit `BEGIN/COMMIT` and the dance
  inside.** The combination this ADR rules out. The DuckDB
  transaction-snapshot view re-trips the FK exception even after the
  in-transaction DELETE of the children. Verified empirically; would
  require a DuckDB upstream fix.

## References

- [Issue #105](https://github.com/schutera/highfive/issues/105) —
  the operator-side symptom (admin rename failed for all seeded
  modules) and the stacked DuckDB FK + Flask rollback bug.
- [Issue #97](https://github.com/schutera/highfive/issues/97) — the
  column split that surfaced this; pre-#97, `set_display_name` ran a
  plain UPDATE on `display_name` and that already hit the FK
  enforcement (the stacked-rollback bug at the route level just
  masked it).
- [Chapter 11 — "Admin rename failed silently on seeded modules"](../11-risks-and-technical-debt/README.md)
  — the incident write-up, including the workaround discovery path
  (PRAGMA / ALTER / UPSERT all inapplicable).
- [ADR-001](adr-001-duckdb-as-sole-writer.md) — why `duckdb-service`
  is the sole writer (and therefore the only place this pattern
  needs to live).
