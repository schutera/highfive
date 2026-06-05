# Measurement write flow

Canonical time-series store for per-module signals (issue #110).
Producers fan in to one table; consumers read bucketed aggregates.

## At a glance

```
┌──────────┐  POST /heartbeat       ┌────────────────────┐
│ ESP32-CAM├─────────────────────────►  routes/         │
│ (hourly) │  {mac, battery, rssi,  │   heartbeats.py    │
└──────────┘  uptime_ms, free_heap, │   post_heartbeat   │
              fw_version}            │                    │
                                     │  ┌────────────┐   │
                                     │  │ INSERT     │   │
                                     │  │ INTO       │   │
                                     │  │ module_    │   │
                                     │  │ heartbeats │   │
                                     │  └─────┬──────┘   │
                                     │        │ ts capt. │
                                     │  ┌─────▼──────┐   │
                                     │  │ INSERT INTO│   │
                                     │  │ measurements│   │
                                     │  │ metric=    │   │
                                     │  │ battery_pct │  │
                                     │  │ source=    │   │
                                     │  │ esp-heart… │   │
                                     │  └────────────┘   │
                                     └────────────────────┘

┌──────────┐  POST /api/modules/:id/      ┌──────────────────┐    POST /measurements
│ Producer │  measurements (X-Admin-Key) │   backend       ├──────────────────────►┐
│ (weather │─────────────────────────────►  app.ts        │                       │
│ worker,  │  {ts, metric, value,        │  measurements   │   {module_mac,        │
│ ml svc)  │   source}                   │  proxy          │    ts, metric,        │
└──────────┘                              │                 │    value, source}     │
                                          └─────────────────┘                       ▼
                                                                          ┌─────────────────┐
                                                                          │ routes/         │
                                                                          │ measurements.py │
                                                                          │ post_measurements│
                                                                          │                 │
                                                                          │  INSERT INTO    │
                                                                          │  measurements   │
                                                                          └─────────────────┘

┌──────────┐  GET /api/modules/:id/      ┌─────────────────┐  GET /modules/:id/measurements
│ Homepage │  measurements?metric=...   │   backend      ├───────────────────────►┐
│ (Battery │─────────────────────────────►  measurements  │                       │
│ History  │                              │  proxy        │                       │
│ Chart)   │  ◄────────────────────────── │  + snake→     │                       │
└──────────┘   MeasurementTimeSeries     │  camelCase    │                       │
               (dense buckets,           │  remap        │                       │
                value: number | null)    └─────────────────┘                       ▼
                                                                          ┌─────────────────┐
                                                                          │ routes/         │
                                                                          │ measurements.py │
                                                                          │ get_measurements│
                                                                          │  GROUP BY       │
                                                                          │  date_trunc(    │
                                                                          │  …)::TIMESTAMP, │
                                                                          │  AVG(value)     │
                                                                          └─────────────────┘
```

## 1. Producer side — heartbeat dual-write

The first real producer is the ESP heartbeat. `routes/heartbeats.py`'s
`post_heartbeat`:

1. Validates the inbound payload (mac canonicalisation, battery /
   rssi / uptime_ms / free_heap / fw_version coercion to ints, the
   geolocation-fix plausibility check).
2. Captures a single `received_at = datetime.now(timezone.utc)`
   timestamp in Python. The same timestamp is reused for both the
   `module_heartbeats` row and the matching `measurements` row, so
   cross-join queries on the two tables stay byte-aligned.
3. Inserts one row into `module_heartbeats` (id, received_at, battery,
   rssi, uptime_ms, free_heap, fw_version).
4. If `battery is not None`, inserts one row into `measurements` with
   `metric='battery_pct'`, `value=float(battery)`,
   `source='esp-heartbeat'`. Skipping the dual-write on `None`
   matters: a missing reading is unknown, not zero — fabricating a
   `0.0` measurement would mis-render a heartbeat without a battery
   sample as a battery-depleted module.

Both writes happen inside the global `lock` so a concurrent reader sees
either neither row or both.

The dual-write was the architecture choice in
[ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md);
it's the cheapest path to a useful canonical store on day one without
reshaping the existing heartbeat endpoints.

## 2. Producer side — admin POST `/api/modules/:id/measurements`

External in-cluster producers (the future weather worker for #111, the
ML classifier for #112) push samples via the backend's admin-gated
proxy. Wire shape:

```json
{
  "ts": "2026-05-20T12:00:00Z",
  "metric": "temperature_c",
  "value": 18.4,
  "source": "weather-api"
}
```

or batched:

```json
{
  "measurements": [
    {"ts": "...", "metric": "...", "value": 1.0, "source": "..."},
    ...
  ]
}
```

`backend/src/app.ts`'s `POST /api/modules/:id/measurements`:

1. Gated by `requireAdmin` (#142 / ADR-019): a valid `hf_admin_session`
   cookie OR `X-Admin-Key` matching `HIGHFIVE_API_KEY` (mirrors `/logs`
   and `/name`). 401 otherwise.
2. Forces the path's `module_mac` onto each item before forwarding —
   the URL is the authority. A typo in the body cannot smuggle a
   sample onto a different module.
3. Proxies to duckdb-service's `POST /measurements` and returns the
   upstream response verbatim.

`duckdb-service/routes/measurements.py`'s `post_measurements`:

1. Validates each item (canonical mac, non-empty `metric` / `source`
   strings ≤ 40 chars, finite numeric `value`, ISO-8601 `ts`).
2. Rejects batches > 1000 rows so a runaway producer cannot wedge the
   global write lock.
3. INSERTs via `executemany` inside `write_transaction()` — partial
   writes are not a thing; the entire batch lands or none of it does.
4. Returns `{"inserted": N}`.

## 3. One-time backfill at startup

`db/schema.py`'s `init_db()` runs an idempotent backfill on every
boot:

```sql
INSERT INTO measurements (module_mac, ts, metric, value, source)
SELECT module_id, received_at, 'battery_pct',
       CAST(battery AS DOUBLE), 'esp-heartbeat-backfill'
FROM module_heartbeats
WHERE battery IS NOT NULL;
```

Gated on `SELECT COUNT(*) FROM measurements WHERE source =
'esp-heartbeat-backfill' = 0` so it runs once and never again. The
distinct `source` tag lets operators tell backfilled samples from live
ones in ad-hoc queries; aggregates over `metric` collapse them
together so the dashboard reads correctly.

## 4. Consumer side — bucketed read

`GET /api/modules/:id/measurements?metric=battery_pct&interval=hourly&days=7`
proxies `GET /modules/:id/measurements` on duckdb-service:

1. Validates `metric` (required), `interval` ∈ {`hourly`, `daily`},
   `days` ∈ [1, 90]. 404s if the module is unknown.
2. Computes the UTC window `[start, end)` exactly the same way the
   activity_timeseries endpoint does, via the shared
   `routes/_bucketing.py` helpers.
3. SQL:
   ```sql
   SELECT date_trunc('{trunc_unit}', ts)::TIMESTAMP AS bucket,
          AVG(value) AS avg_value,
          COUNT(*) AS sample_count
   FROM measurements
   WHERE module_mac = ? AND metric = ?
     AND ts >= ? AND ts < ?
   GROUP BY bucket
   ORDER BY bucket
   ```
   The `::TIMESTAMP` cast is load-bearing — see the chapter 11 entry
   "`date_trunc('day', ts)` returns DATE not TIMESTAMP" for the
   incident.
4. Dense-fills the response: every interval step in the window emits
   one bucket. Empty buckets carry `value: null` and `sample_count:
0`, NOT `value: 0` — a missing sensor reading is unknown, not
   zero. `MeasurementBucket` in `@highfive/contracts` pins the
   `number | null` shape.

The backend proxy maps `module_id → moduleId` and `sample_count →
sampleCount` per the camelCase wire convention. Recharts on the
homepage renders the line with `connectNulls={false}` so gaps appear
as breaks, not as dips to zero.

## What's NOT in this flow yet

- A "render any metric" dashboard panel — v1 is one chart
  (`BatteryHistoryChart`) for one metric. Adding the next metric
  panel means cloning the file and changing one prop.
- A retention / downsample cron — documented but unimplemented in
  [`docs/08-crosscutting-concepts/measurement-retention.md`](../08-crosscutting-concepts/measurement-retention.md).
- A consumer for non-heartbeat producers — gated on #111 (weather),
  #112 (classifier), #115 (baseline), #116 (anomaly), #117 (hatching).
