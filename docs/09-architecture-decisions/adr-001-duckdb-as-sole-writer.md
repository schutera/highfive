# ADR-001: DuckDB-service is the sole writer of `app.duckdb`

## Status

Accepted.

## Context

HiveHive uses a single-file DuckDB database (`app.duckdb`) for
persistence. The file lives in the named volume `duckdb_data`, mounted
into both `image-service` and `duckdb-service` at `/data`.

An earlier version let `image-service` open its own DuckDB connection
and write directly. This caused several problems:

- **Two writers, one file.** DuckDB single-file mode does not handle
  concurrent writers gracefully. Lock contention and occasional
  corruption.
- **Schema knowledge duplicated.** Both services had to know the
  schema and migrations. Drift was inevitable.
- **Tests required a real DB.** `image-service` tests had to spin up
  a DuckDB fixture or monkey-patch the connection.

## Decision

Only `duckdb-service` opens `app.duckdb`. `image-service` (and any
future writer) goes through `duckdb-service` over HTTP:

- `POST /add_progress_for_module` — write a `daily_progress` row
- `POST /modules/<mac>/heartbeat` — update battery, image_count,
  first_online
- `GET /modules/<mac>/progress_count` — read for first-upload
  detection

`image-service` no longer opens a DuckDB connection and has no
`DUCKDB_PATH` env var. The `duckdb_data` volume is still mounted into
`image-service` because images and `.log.json` sidecars live next to
the DB file on the same volume — but only `duckdb-service` writes
to the `.duckdb` file itself.

## Consequences

**Positive**:

- Single source of schema and migration knowledge.
- `image-service` tests don't need a DB at all (HTTP calls are
  monkey-patched).
- One owner per resource, the standard microservice invariant.

**Negative**:

- Cross-service transactions become impossible without distributed
  coordination. Heartbeat + progress write happen in two HTTP calls;
  partial failure can leave them inconsistent. Acceptable for a
  best-effort, eventually-consistent monitoring pipeline.
- Slightly higher latency for the upload path (extra HTTP hops).

**Forbidden**:

- Don't open a DuckDB connection from `image-service` or any other
  service. This is enforced by review, not by tooling. Adding a
  `duckdb` import outside `duckdb-service/` should be flagged in code
  review.
