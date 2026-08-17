# Measurement retention policy

Per-module time-series rows in the `measurements` table (issue #110) have
**no automatic retention or downsample in v1**. This document records why,
when to revisit, and what to do when we do.

## Current policy: keep forever

`duckdb-service/db/schema.py`'s `init_db()` creates the `measurements`
table but no companion cleanup job. The two existing background tasks
(`run_backup`, `check_silence` in `duckdb-service/app.py`) do not touch
this table. New rows arrive via:

- `routes/heartbeats.py`'s `post_heartbeat` dual-write (hourly per
  module, one row per heartbeat when battery is present).
- `routes/measurements.py`'s `post_measurements` admin batch insert
  (no live producers besides heartbeat in v1; future
  `weather-api`, `image-classifier` etc. will land here).

## Why no retention yet

Volume is small.

- 5 modules × 24 measurements/day × 1 metric (`battery_pct`) ≈ 120
  rows/day = ~44k rows/year.
- Each row is `VARCHAR(20) + TIMESTAMP + VARCHAR(40) + DOUBLE +
  VARCHAR(40)` ≈ 110 bytes uncompressed, ≈ 30 bytes after DuckDB's
  columnar dictionary encoding.
- 44k rows/year × ~30 bytes ≈ **1.3 MB/year** per metric on a 5-module
  deployment.

Even at 100× the metric count and 10× the module count, this stays
under 1 GB/decade. The DuckDB file already carries
`module_heartbeats`, `image_uploads`, and `daily_progress` rows in the
same order of magnitude with no retention story — and those have run
for a year without a complaint.

The two indices declared in `_MEASUREMENTS_DDL` keep the read endpoint
fast at scale: `idx_measurements_module_metric_ts` covers
the `WHERE module_mac = ? AND metric = ? AND ts BETWEEN ...` of every
read; `idx_measurements_ts` covers the (future) retention scan
without adding it to the read path's index footprint.

## When to revisit

Trigger a retention or downsample policy when **any one** of:

- The `app.duckdb` file exceeds 500 MB (`du -sh`), AND the
  `measurements` table is the dominant contributor (`SELECT
  table_name, estimated_size FROM duckdb_tables() ORDER BY
  estimated_size DESC`).
- The bucketed read at `interval=hourly` and `days=90` (the maximum
  the API permits) crosses ~200 ms p95 on the production deployment.
  The activity_timeseries endpoint hits a comparable scan and currently
  returns in single-digit ms; orders of magnitude headroom.
- A producer landing post-v1 (anomaly score, per-cell state,
  classifier output) raises the per-module per-day row count above
  ~10k. At that rate the table grows ~18M rows/year on 5 modules and
  the per-query scan times start to matter.

## What to do when we revisit

Two patterns to consider, NOT in this PR:

### Pattern 1: Time-based delete

A weekly cron in `services/` deletes rows older than N days/months:

```sql
DELETE FROM measurements
WHERE ts < NOW() - INTERVAL '90 days'
  AND source != 'esp-heartbeat-backfill';  -- keep imported history
```

Suitable when the downstream consumers only need recent windows
(anomaly detection looks at the last N days; baseline rebuilds from
the last 30). The drawback: irreversible. Once deleted, the row is
gone — the operator cannot ad-hoc query "what was the battery a year
ago".

### Pattern 2: Downsample-to-aggregate

A daily cron summarises old rows into a sibling
`measurements_daily` table (or a `metric=...` rollup row tagged
`source=downsample-day`) and then deletes the per-hour sources past
the retention window:

```sql
INSERT INTO measurements_daily
SELECT module_mac, date_trunc('day', ts)::TIMESTAMP AS day,
       metric, AVG(value), COUNT(*) AS sample_count, source
FROM measurements
WHERE ts < NOW() - INTERVAL '30 days'
GROUP BY module_mac, day, metric, source;

DELETE FROM measurements
WHERE ts < NOW() - INTERVAL '30 days';
```

Keeps long-tail context queryable (year-over-year, season-over-season)
at coarser resolution. The drawback: two tables for the read path to
union, OR a write-side decision that "after 30 days, the bucketed
read endpoint switches granularity". The read endpoint's `interval`
param means we could honour the switch transparently — `daily` reads
always go to `measurements_daily`, `hourly` reads only see the rolling
30-day window.

### Decision matrix

| Trigger                                                    | Recommended pattern |
| ---------------------------------------------------------- | ------------------- |
| File size > 500 MB, no consumer needs >30 days hourly      | Pattern 1, 90 d     |
| File size > 500 MB, consumer needs year-over-year context  | Pattern 2, daily    |
| Read latency, not file size                                | Pattern 2, daily    |
| Producer typo backfilled millions of bad rows              | one-shot `DELETE WHERE source = '...'`, then revisit |

The retention job should NOT touch `source='esp-heartbeat-backfill'`
rows by default — they're the operator's "old data is irreplaceable"
audit trail. An explicit `--include-backfill` flag on the cron lets
operators opt in to the broader sweep when they're confident.

## References

- Issue: [#110](https://github.com/schutera/highfive/issues/110)
- Schema: `duckdb-service/db/schema.py`'s `_MEASUREMENTS_DDL`
- ADR: [ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md)
- Storage envelope: `daily_progress`, `image_uploads`,
  `module_heartbeats` already run uncapped — the canonical example of
  "DuckDB swallows this; revisit when it doesn't".
