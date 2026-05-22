# Weather worker flow

Periodic, server-side fetch of Open-Meteo hourly observations into the
per-module `measurements` store (issue #111). Sibling to the
[measurement write flow](measurement-write-flow.md): same destination
table, different producer.

## At a glance

```
┌──────────────────┐    every 60 min     ┌────────────────────────┐
│ APScheduler tick ├────────────────────►│ run_weather_fetch()    │
│ (app.py)         │                     │ (services/             │
└──────────────────┘                     │  weather_worker.py)    │
                                         │                        │
                                         │  for each module       │
                                         │  with plausible        │
                                         │  lat/lng:              │
                                         │  ┌─────────────────┐   │
                                         │  │ SELECT MAX(ts)  │   │
                                         │  │ FROM measure-   │   │
                                         │  │ ments WHERE     │   │
                                         │  │ metric='        │   │
                                         │  │ temperature_c'  │   │
                                         │  │ AND source IN   │   │
                                         │  │ ('open-meteo',  │   │
                                         │  │  'open-meteo-   │   │
                                         │  │   backfill')    │   │
                                         │  └────────┬────────┘   │
                                         │           │            │
                                         │  ┌────────▼────────┐   │
                                         │  │ HTTP GET        │   │
                                         │  │ api.open-meteo. │   │
                                         │  │ com/v1/forecast │   │
                                         │  │ ?past_days=2&   │   │
                                         │  │  forecast_days=0│   │
                                         │  │  &hourly=temp+  │   │
                                         │  │   humidity+prcp │   │
                                         │  └────────┬────────┘   │
                                         │           │            │
                                         │  ┌────────▼────────┐   │
                                         │  │ for each hour > │   │
                                         │  │ last_seen_ts:   │   │
                                         │  │ INSERT INTO     │   │
                                         │  │ measurements    │   │
                                         │  │ source=         │   │
                                         │  │ 'open-meteo'    │   │
                                         │  │ (3 metrics/hr)  │   │
                                         │  └─────────────────┘   │
                                         └────────────────────────┘

┌──────────────────┐    operator command ┌────────────────────────┐
│ Operator         ├────────────────────►│ POST /api/admin/       │
│ (rare, one-shot) │   X-Admin-Key       │ weather/backfill       │
└──────────────────┘                     │ ?days=N (optional)     │
                                         │                        │
                                         │ → POST /admin/weather/ │
                                         │   backfill (duckdb)    │
                                         │                        │
                                         │ → run_weather_backfill │
                                         │   ()                   │
                                         │                        │
                                         │  for each module:      │
                                         │   chunk window into    │
                                         │   30-day spans, fetch  │
                                         │   archive-api...,      │
                                         │   skip rows that       │
                                         │   already exist,       │
                                         │   batch-INSERT with    │
                                         │   source='open-meteo-  │
                                         │           backfill'    │
                                         └────────────────────────┘
```

## 1. Live scheduler tick (`run_weather_fetch`)

Runs every 60 minutes via APScheduler when `WEATHER_WORKER_ENABLED`
is set (default `"true"`; tests and devs flip to `"false"` to silence
it). Shape evolved from `silence_watcher.check_silence`, with one
deliberate variation:

- **`silence_watcher`** holds the DB lock from the initial `SELECT`
  through the `UPDATE module_configs SET last_silence_alert_at = ?`
  statements (Discord HTTP happens after the lock is released, but
  the writes are inside the read lock).
- **The weather worker** snapshots the candidate module list under
  the lock, releases, and re-acquires for each `write_transaction()`
  insert outside the long-running HTTP path. The split is what lets a
  stalled Open-Meteo call leave incoming heartbeat writers (also
  competing for the same lock) untouched.

Per-tick sequence:

1. Acquire the DB lock; `SELECT id, lat, lng FROM module_configs
ORDER BY id`. Drop rows that fail the `_is_plausible_location`
   rule (a pared-down sibling of `routes/heartbeats.py`'s
   `_is_plausible_fix` — same Null Island, NaN, out-of-range checks
   minus the `accuracy` arg, which isn't stored on the row).
2. **Release the lock.** All HTTP runs outside the lock — a stalled
   Open-Meteo call cannot wedge incoming heartbeat writers.
3. For each candidate module:
   - Read the latest existing weather sample's `ts` for
     `metric='temperature_c'` and
     `source IN ('open-meteo', 'open-meteo-backfill')`. This is the
     "we already have data up to here" watermark.
   - Compute the fetch window:
     - `start = watermark + 1h` if a watermark exists.
     - `start = now - WEATHER_DEFAULT_LOOKBACK_DAYS` (default 7d)
       on a fresh module with no prior weather rows.
     - `end = floor(now, 1h)` — the last completed hour.
     - If `start >= end`, this module is up-to-date; skip.
   - GET `https://api.open-meteo.com/v1/forecast?
latitude=...&longitude=...&past_days=2&forecast_days=0&
timezone=UTC&hourly=temperature_2m,relative_humidity_2m,precipitation`.
     5 s timeout, single retry on `requests.RequestException`.
   - Parse the `hourly.time` array (naive UTC ISO strings, paired
     index-wise with `hourly.temperature_2m` etc.); drop hours
     outside `[start, end)` so duplicates can't sneak in if the API
     returns extra rows.
   - Batch-insert all three metrics × N hours via
     `db.repository.write_transaction()` with
     `source='open-meteo'`.
4. Per-module exceptions are caught and logged; the loop continues
   to the next module. A hung Open-Meteo cannot halt the scheduler
   thread.

## 2. One-shot historical backfill (`run_weather_backfill`)

Triggered by `POST /api/admin/weather/backfill` (X-Admin-Key gated by
the backend), proxied to duckdb-service's `POST /admin/weather/backfill`,
which calls `run_weather_backfill(days=N)`. The window:

- `days=None` (default) → start from each module's
  `module_configs.first_online` so the full history covers every
  image upload.
- `days=N` → start from `now - N days` for all modules.
- `end = now - 5 days` for all modules — the Open-Meteo Archive
  endpoint is ERA5-backed and trails real time by ~5 days. Hours
  more recent than that are picked up by the live worker on its
  next tick.

For each module:

1. Fetch the set of existing `(ts)` for
   `source='open-meteo-backfill'` so already-imported hours don't
   re-insert.
2. Chunk the window into 30-day spans (Archive endpoint is happy
   with larger spans but chunking keeps any one HTTP failure local).
3. GET `https://archive-api.open-meteo.com/v1/archive?
latitude=...&longitude=...&start_date=YYYY-MM-DD&
end_date=YYYY-MM-DD&timezone=UTC&
hourly=temperature_2m,relative_humidity_2m,precipitation`.
4. Drop rows whose `ts` already exists for this `source`. Batch the
   remainder via `write_transaction`.
5. Per-module exceptions caught and reported in the response body
   (`{rows_written, modules_touched, errors}`) — admin endpoint, so
   partial success is more informative than 500ing.

## 3. Read path is the same as for any measurement

Consumers (homepage chart, future anomaly/correlation queries) read
via `GET /api/modules/:id/measurements?metric=temperature_c` — the
same endpoint pinned by [ADR-016](../09-architecture-decisions/adr-016-per-module-measurements-store.md)
and described in [measurement-write-flow.md §3](measurement-write-flow.md).
The dense-fill semantics apply: a module that hasn't yet had its
backfill triggered surfaces `value: null` buckets in the historical
window, rather than fake zeros. Once the operator runs
`POST /api/admin/weather/backfill`, those nulls are replaced by real
historical observations on the next read.

## Failure modes

- **Open-Meteo down or rate-limited.** Per-tick catch + log. The live
  worker simply misses that hour; the next tick fills it in (gap-fill
  semantics use `MAX(ts)`, not "fetch the last completed hour and
  give up"). No 500, no Discord alert — chapter 11's experience with
  silence_watcher's per-iteration error handling is the precedent.
- **Module's `lat`/`lng` still at `(0,0)`.** Skipped, same as the
  heartbeat-side geolocation patch's safety rule. Once the firmware
  patches in a plausible fix via the heartbeat path
  (see [image-upload-flow.md](image-upload-flow.md)), the next worker
  tick picks it up.
- **Operator triggers backfill before any modules have a fix.**
  Response body is `{rows_written: 0, modules_touched: 0, errors:
[]}`. Re-run after the first heartbeat with a plausible fix lands.
