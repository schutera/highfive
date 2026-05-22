# ADR-016: Per-module time-series store is one wide `measurements` table

## Status

Accepted.

## Context

Issue #110 calls for a canonical place to store per-module signals over
time — activity scores, battery levels, sensor readings, external
weather data, anomaly inputs. Several downstream features ([#115
baseline](https://github.com/schutera/highfive/issues/115),
[#116 anomaly](https://github.com/schutera/highfive/issues/116),
[#117 hatching](https://github.com/schutera/highfive/issues/117),
[#111 weather](https://github.com/schutera/highfive/issues/111))
all need to read per-module values bucketed by hour or day and
correlate across metrics.

Today those signals are scattered:

- `module_heartbeats.battery` — per-heartbeat integer percentage.
- `image_uploads.uploaded_at` — already projected to hourly/daily
  buckets by ``routes/modules.py``'s `activity_timeseries`.
- `image-service` classifier output (stub today; in flight per
  [#112](https://github.com/schutera/highfive/issues/112)) — no
  canonical store at all.

Without one substrate, every new metric is a new schema migration
and a new bespoke read endpoint. Worse, the cross-metric queries the
downstream features need (e.g. "battery vs temperature at the same
hour") are bolt-on joins across mismatched tables.

Three orthogonal questions had to be settled:

1. **Wide table or per-metric tables?** A single `measurements` row
   with a `metric` column, vs. separate `battery_measurements`,
   `temperature_measurements`, `activity_measurements` tables.
2. **Schema-on-write or schema-on-read?** Pre-declare every metric
   (CHECK constraint) vs. accept any string and let downstream
   consumers know what's valid.
3. **Should existing producers (heartbeat, image-upload) dual-write
   into the new store, or stay where they are?** Migration vs.
   shadow vs. dual-write.

## Decision

### Schema: one wide table

```sql
CREATE TABLE measurements (
    module_mac VARCHAR(20) NOT NULL,
    ts         TIMESTAMP   NOT NULL,
    metric     VARCHAR(40) NOT NULL,
    value      DOUBLE      NOT NULL,
    source     VARCHAR(40) NOT NULL
);
CREATE INDEX idx_measurements_module_metric_ts
    ON measurements(module_mac, metric, ts);
CREATE INDEX idx_measurements_ts ON measurements(ts);
```

DDL lives at `duckdb-service/db/schema.py`'s `_MEASUREMENTS_DDL`.
`init_db()` materialises it via a separate `con.execute(...)` call
(distinct from the multi-statement block that creates `image_uploads`
/ `module_heartbeats`) so the rewrite from `CREATE TABLE` to
`CREATE TABLE IF NOT EXISTS` happens through the same DDL constant
the (future) migration block can reference — mirrors the
FK-chained-table pattern at the top of `init_db`. Indices live in a
sibling `con.execute(...)` so adding a third index doesn't churn the
DDL diff.

Notes on the shape:

- **No primary key.** `(module_mac, ts, metric, source)` is a
  natural soft key but we deliberately do NOT enforce uniqueness —
  a transient duplicate from a producer retry is preferable to a
  silently-dropped sample. `AVG(value)` over the bucket converges on
  the right value either way; `COUNT(*)` becomes `sample_count` in the
  read response so the consumer can see "this bucket had 1 duplicate"
  if it cares.
- **No FK to `module_configs`.** Out-of-order arrival and orphan rows
  (e.g. a deleted module's history) survive a stale parent row; the
  read endpoint already filters by `module_mac` so orphans are invisible
  to the dashboard without taking the table down for FK enforcement.
- **`value DOUBLE` rather than per-metric typed columns.** Discussed
  below.
- **`source` carries provenance.** Live samples from the heartbeat
  dual-write are tagged `esp-heartbeat`; the one-time backfill of
  pre-existing heartbeats is `esp-heartbeat-backfill`; the (future)
  weather worker (#111) will tag `weather-api`; the classifier (#112)
  will tag `image-classifier`. Operators can distinguish
  retroactively-imported samples from live ones without losing
  aggregate fidelity (aggregates over `metric` collapse `source`
  together).

### Wide table > per-metric tables

A single wide `measurements` table with a `metric` string column wins
over per-metric tables (`battery_pct_measurements`,
`temperature_c_measurements`, …) for three reasons:

- **No DDL per metric.** A new producer (anomaly score, humidity,
  CO2, whatever) adds rows without touching the schema. The downstream
  consumers learn the metric name through code, not through migrations
  — which matters because the metric name is the discriminator they
  filter on anyway.
- **Cross-metric reads stay simple.** "Activity vs temperature at the
  same hour" is one `JOIN` on `(module_mac, ts)` against the same
  table; per-metric tables would mean a join across N tables, which
  DuckDB does fine but the SQL becomes write-once-read-never.
- **The wire shape stays single.** `contracts/src/index.ts`'s
  `MeasurementTimeSeries` is one shape; per-metric tables would
  multiply the shape, the route, and the homepage chart code.

The cost is type erasure — `value` is `DOUBLE`, not `INTEGER` for
batteries and `DOUBLE` for temperatures. We accept this. The
consumers that care about display formatting already format on the
client (the battery chart rounds to integer at render time); the
storage-side precision loss for a 0–100 integer percentage stored as
a double is zero.

The alternative we rejected was an "EAV-with-typed-columns"
variant — `value_int`, `value_double`, `value_text` — picked at insert
time by the producer. That trades the type erasure for a per-row
"which column is real?" guessing game and makes aggregates ugly
(`COALESCE(value_int, value_double)`). Not worth it for the small
typing benefit.

### Schema-on-read for metric names

`metric` and `source` are open `VARCHAR(40)` columns, NOT a CHECK
constraint or a foreign-key reference to a `known_metrics` table.

- A new producer can ship without a coordinated DDL release.
- The 40-char ceiling catches typos (`battery_pct_2` smells fine,
  `BATTERY%pct_2_v2_FINAL` does not — the validator at
  `routes/measurements.py`'s `_validate_name` rejects oversize
  strings with a clean 400).
- Known metric/source identifiers live in the glossary
  ([`docs/12-glossary/README.md`](../12-glossary/README.md)) — one
  canonical list to point a new producer at, but not enforced at the
  storage layer.

The trade-off: a typo in a producer (`battry_pct` vs `battery_pct`)
silently creates a new "metric" rather than failing at write time.
The mitigation is the contracts-layer `MeasurementTimeSeries.metric`
docstring listing known values, the glossary entry, and integration
tests at the producer layer — none of which fully prevent the typo
but all of which catch it on the first dashboard view of a new
metric. We judged this acceptable given the velocity benefit of not
needing a coordinated DDL release per producer.

### Heartbeat dual-writes; image-upload stays where it is (for now)

`routes/heartbeats.py`'s `post_heartbeat` writes BOTH a row to
`module_heartbeats` AND a row to `measurements` (when the heartbeat
carries a battery). Both writes share the same `received_at` /
`ts` timestamp (captured once in Python) so cross-join queries on
the two tables stay byte-aligned.

Why dual-write rather than migrate the heartbeat to read from
`measurements`?

- The existing `/heartbeats/<id>` and `/heartbeats_summary` endpoints
  carry RSSI / uptime / heap / fw_version alongside battery. The
  canonical store is one-metric-per-row; reshaping the heartbeat
  endpoints to gather their per-row fields from N JOIN-ed measurements
  rows would balloon the read path. We leave the existing endpoints
  unchanged.
- We do NOT yet have a dashboard consumer for RSSI / uptime / heap as
  time series — when one lands, it'll fan those out via the
  measurements path. Until then, dual-writing only `battery_pct` keeps
  the migration scope tight.

`image_uploads` stays where it is. The `activity_timeseries` endpoint
projects per-upload rows to bucketed counts; surfacing
`metric='activity_score'` rows would either duplicate data or require
a producer that aggregates batches of uploads into one measurement,
neither of which is in scope here. ML pipeline #112 may end up
emitting `metric='activity_score'` rows directly from the classifier;
that's the right time to decide what to do with `image_uploads`.

### One-time backfill of historical heartbeats

`init_db()` does an idempotent one-time backfill on every boot:

```sql
INSERT INTO measurements (module_mac, ts, metric, value, source)
SELECT module_id, received_at, 'battery_pct',
       CAST(battery AS DOUBLE), 'esp-heartbeat-backfill'
FROM module_heartbeats
WHERE battery IS NOT NULL;
```

Gated by `SELECT COUNT(*) FROM measurements WHERE source =
'esp-heartbeat-backfill' = 0` — runs once, never again. The distinct
`source` lets us tell backfilled samples from live ones without an
extra "imported_at" column. Aggregates collapse them together.

Timezone caveat: the backfill copies `module_heartbeats.received_at`
verbatim into `measurements.ts`. Until the dual-write landed in this
PR, `received_at` came from the column's `DEFAULT CURRENT_TIMESTAMP`,
which DuckDB stamps in the container's local TZ. On the
`python:3.x-slim` default that's UTC and matches the new live
writes (`datetime.now(timezone.utc).replace(tzinfo=None)`); on a
container with `TZ=Europe/Berlin`, the backfilled rows would land 1–2
hours offset from live writes — the latent risk
[ADR-015](adr-015-weather-correlation.md)'s lessons-learned entry
flagged for `record_image`. The fix is operator-side: deploy
`duckdb-service` without `TZ=` overrides, as the existing
docker-compose configuration already does.

### Public read path is the same as activity

The bucketed read endpoint
`GET /modules/<id>/measurements?metric=...&interval=...&days=...`
copies the `activity_timeseries` window math, `date_trunc` cast, and
dense-fill loop. The shared `routes/_bucketing.py` module owns
`INTERVAL_STEP` and `floor_to_interval` so a future "add weekly"
change touches one file.

The aggregate is `AVG(value)`, not `COUNT(*)`. Bucket value is
`number | null` (not `0`): a missing battery reading is unknown, not
zero. `sample_count` lives alongside `value` so consumers can see
"this bucket had no samples" without the value-0 / value-null
ambiguity.

## Consequences

### Positive

- **Velocity.** Every downstream feature (#111, #115, #116, #117)
  starts from a stable substrate. Adding a new metric is a
  measurements `INSERT` + a chart prop change; no DDL coordination.
- **Cross-metric correlation is one query.** "What was the battery vs
  the temperature at the same hour" joins one table to itself.
- **Provenance is queryable.** `source` distinguishes backfill from
  live and (later) classifier output from heartbeat.
- **Storage cost is trivial.** 5 modules × 24 h × 1 metric ≈ 120
  rows/day = 44k rows/year. DuckDB swallows this; even at 100×
  the volume there's no scale concern.

### Negative

- **Type erasure on `value`.** Integer-only metrics (battery_pct,
  rssi_dbm) lose their type at the storage layer. Display formatting
  handles it; aggregates don't notice.
- **Open `metric` strings can drift.** A producer typo silently
  creates a new "metric". Glossary + integration tests are the
  mitigation, not the storage layer.
- **No retention/downsample policy in this PR.** Documented in
  [`docs/08-crosscutting-concepts/measurement-retention.md`](../08-crosscutting-concepts/measurement-retention.md);
  a future cron lands when volume warrants it.
- **One more place a column can drift.** ADR-001 already commits
  duckdb-service as the sole writer, but the dual-write path means a
  schema change to `measurements` ripples to `routes/heartbeats.py`
  and (later) other producers.

### Out of scope, tracked elsewhere

- The `random(1, 100)` noise the firmware currently sends as
  `battery` — [#8a](https://github.com/schutera/highfive/issues/8).
  The measurements store records what the firmware sends honestly;
  once #8a lands, the same column starts holding real percentages.
- A measurements writer for the image classifier — gated on the ML
  pipeline work in
  [#112](https://github.com/schutera/highfive/issues/112).
- A "render any metric" dashboard panel — out of v1; the stub
  `BatteryHistoryChart` is one chart for one metric.

## References

- Issue: [#110](https://github.com/schutera/highfive/issues/110)
- Schema: `duckdb-service/db/schema.py`'s `_MEASUREMENTS_DDL` /
  `_MEASUREMENTS_COLUMNS`
- Write path: `routes/heartbeats.py`'s `post_heartbeat` (dual-write),
  `routes/measurements.py`'s `post_measurements` (admin batch)
- Read path: `routes/measurements.py`'s `get_measurements`
- Wire shape: `contracts/src/index.ts`'s `Measurement` /
  `MeasurementBucket` / `MeasurementTimeSeries`
- Chart: `homepage/src/components/BatteryHistoryChart.tsx`
- Sole-writer commitment that this respects: [ADR-001](adr-001-duckdb-as-sole-writer.md)
- Bucketing pattern reused: see `activity_timeseries` in
  [ADR-015 / `routes/modules.py`](adr-015-weather-correlation.md)
- Bucket-cast incident pinned by this design:
  [chapter 11 — "`date_trunc('day', ts)` returns DATE not TIMESTAMP"](../11-risks-and-technical-debt/README.md)
