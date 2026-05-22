# ADR-017: Server-side weather worker fetches Open-Meteo into the measurements store

## Status

Accepted.

## Context

Issue [#111](https://github.com/schutera/highfive/issues/111) asks for
server-side weather observations stored as `measurements` per module so
correlations between hive activity and weather are queryable across
arbitrary windows and can be backfilled across each module's full
history. ADR-015 already settled the browser-direct path for the
dashboard's overlay chart; that path is good for "what does it look
like right now in the panel", but it has three limits the per-module
store removes:

- **No persistence.** Every chart mount re-fetches; nothing lands in
  the `measurements` store. Anomaly detection (#116), hatching
  prediction (#117), baselines (#115) cannot query historical
  hive-activity-vs-weather joins because the weather half doesn't
  exist on disk.
- **No backfill.** The 142 image uploads on a seed module from
  2023-04-15 onward have no matching weather rows; an operator who
  asks "why was activity low this week" can't be answered against
  history.
- **No provenance.** A single source per chart mount, no tag in the DB.

Four candidates were considered:

1. **Deutscher Wetterdienst (DWD) Open Data CDC.** German official,
   ~10 km grid for hourly observations, free, keyless. Archive ships
   as ZIPs over an HTTP file tree, indexed by station, not gridded —
   the worker would have to find the nearest station per module, pull
   ZIPs, unpack, parse fixed-width text. Roughly 3× the implementation
   surface of a JSON-over-HTTP source. Germany-only coverage; modules
   deployed outside DE coverage get nothing.
2. **OpenWeatherMap.** Global, free tier 1000 calls/day, JSON API.
   Requires an API key — friction with the G2 "no cloud secrets"
   goal, and any leak of the dev fallback recreates the
   `hf_dev_key_2026` failure mode.
3. **Netatmo public weather map.** Crowdsourced citizen stations,
   very fine-grained where present. API key required, coverage is
   patchy, station quality varies, no archive.
4. **Home Assistant relay.** Per-operator only; useful as an
   integration point if an operator already runs HA but cannot be the
   primary substrate for a stack we ship to everyone.

A fifth option was on the table but was missing from the issue's
list: **Open-Meteo**, already used browser-side per ADR-015. Keyless,
free, CORS-open, single API for both live observations
([Forecast API with `past_days`](https://open-meteo.com/en/docs))
and decades of historical data
([Archive API backed by ERA5](https://open-meteo.com/en/docs/historical-weather-api)),
~9 km grid. Adding it as the server-side source means one external
system on the network instead of two — the system context (chapter 03) keeps a single "Open-Meteo" row.

## Decision

The duckdb-service hosts a periodic worker that fetches Open-Meteo
hourly observations for every module with a plausible
`module_configs.lat`/`lng` and writes rows into the existing
`measurements` table.

### Source: Open-Meteo (the same as ADR-015)

Reusing the source already validated browser-side for ADR-015 keeps
the external-systems surface at one row in chapter 03. The Forecast
endpoint (with `past_days=2`) covers the live worker's "fill the last
two days of hourly samples" need; the Archive endpoint (ERA5, ~5-day
lag) covers the per-module historical backfill. Both return the same
hourly schema, so one parser handles both.

Why not DWD as the primary (the issue's first choice): DWD's archive
is station-based and ZIP-distributed, which would triple the worker's
code surface (station nearest-neighbour, ZIP fetch, fixed-width
parse). The accuracy ceiling is real but the cost is real too, and
the existing seed deployment is in DE coverage where Open-Meteo's
ERA5 grid already pulls from a dense DWD station mesh. Re-evaluate
in a follow-up ADR if a deployment in DE surfaces a microclimate
mismatch Open-Meteo cannot explain.

Why not OWM / Netatmo / HA-relay: API keys (OWM, Netatmo) conflict
with the G2 no-cloud goal; HA-relay is per-operator and cannot be the
default substrate.

### Storage: existing `measurements` table, no schema change

Open-Meteo returns three hourly fields the worker writes as three
separate measurement rows per hour per module:

| Open-Meteo field       | `metric`           | Units |
| ---------------------- | ------------------ | ----- |
| `temperature_2m`       | `temperature_c`    | °C    |
| `relative_humidity_2m` | `humidity_pct`     | %     |
| `precipitation`        | `precipitation_mm` | mm/h  |

Provenance via `source`:

- `open-meteo` — live samples from the hourly scheduler job.
- `open-meteo-backfill` — retroactive samples from the
  one-shot `/admin/weather/backfill` endpoint.

The split mirrors the heartbeat dual-write's
`esp-heartbeat` / `esp-heartbeat-backfill` convention
([ADR-016](adr-016-per-module-measurements-store.md)). Aggregates
over `metric` collapse the two `source` values together; analytics
that want to know "which samples arrived in real time" filter on the
specific source.

### Worker: APScheduler job in duckdb-service, hourly tick

Slots in next to the existing `silence_watcher` and `weekly_backup`
jobs at `duckdb-service/app.py`'s scheduler registration. The
implementation lives at `duckdb-service/services/weather_worker.py`'s
`run_weather_fetch` and mirrors `silence_watcher.py`'s pattern: read
modules under the DB lock, run HTTP and writes outside the lock,
swallow exceptions per-module so a single failing call doesn't
wedge the scheduler thread.

Gap-fill semantics: on every tick, for each module with a plausible
fix, find the latest `ts` for `metric='temperature_c'` with
`source IN ('open-meteo', 'open-meteo-backfill')`. The next fetch
window starts at `latest_ts + 1h` and ends at the most-recently-
completed hour. On a fresh module with no rows the default first
window is the last `WEATHER_DEFAULT_LOOKBACK_DAYS` (default 7) —
operators run the explicit backfill endpoint for longer history.

### Historical backfill: explicit admin endpoint, not auto-on-boot

`POST /admin/weather/backfill?days=N` (forwarded by
`backend POST /api/admin/weather/backfill` under `X-Admin-Key`) calls
`run_weather_backfill(days=N)`. When `days` is omitted, each module's
window starts at its `module_configs.first_online`; with `days=N` it
starts at `now - N days`. The upper bound is always `now - 5 days`
(Archive ERA5 lag). Idempotent across modules: existing
`(module_mac, ts, metric, 'open-meteo-backfill')` rows are queried
and skipped before each chunk is written.

The auto-on-boot path was considered and rejected: `init_db()` runs
synchronously at app import time and triggering Archive HTTP calls
from there would stall every dev rebuild, every test fixture's
`importlib.reload(db.schema)`, and every prod container restart. An
operator-triggered endpoint stays explicit and observable, with the
same idempotency guarantee.

### Attribution: required by Open-Meteo's CC-BY 4.0 licence

The
[Open-Meteo licence](https://open-meteo.com/en/license)
requires attribution. `SiteFooter` gains a "Weather data by
Open-Meteo" link — the first non-Impressum link in the footer.
ADR-015 already required this attribution browser-side; this ADR
extends it to the dashboard footer so the duty is met regardless of
whether the user is on the marketing page or the dashboard.

## Consequences

### Positive

- **Historical correlation becomes a SQL `JOIN`.** With the backfill
  endpoint run once, the canonical `measurements` store holds
  `temperature_c`, `humidity_pct`, `precipitation_mm` next to
  `battery_pct` and the future `activity_score` (#112), all keyed by
  `(module_mac, ts)`. Cross-metric reads stay on one table per
  [ADR-016](adr-016-per-module-measurements-store.md).
- **No new external system.** Chapter 03 keeps one Open-Meteo row,
  amended to describe both the browser-direct call from ADR-015 and
  the server-side worker from this ADR. The system context diagram
  doesn't grow.
- **Zero new secrets.** Same keyless / CORS-open API as ADR-015.
- **Backfill works on existing volumes.** Run the admin endpoint
  once per deployment, all historical image uploads gain a weather
  context retroactively.

### Negative

- **Spatial resolution is ~9 km grid, not micro-climate.** Adequate
  for a normal garden hive where regional weather correlates closely
  with on-module conditions. A deployment in a sharp microclimate
  (south-facing wall, dense forest) may diverge — revisit DWD or an
  on-module BME280 then.
- **Single external dependency for both display and storage.** If
  Open-Meteo goes down for an extended outage, the live worker logs
  warnings and skips that tick. The store gains a gap that the
  dense-fill read endpoint surfaces as `value: null`; no degraded
  fallback. Acceptable given Open-Meteo's free-tier SLA history;
  re-evaluate with a fallback source if it bites.
- **Storage cost grows but stays trivial.** Three metrics × 24 h ×
  365 d × N modules ≈ 26 k rows/year/module. At 5 modules that's
  ~130 k rows/year on top of the ~44 k existing battery rows. DuckDB
  shrugs at this volume; the retention concept
  ([`measurement-retention.md`](../08-crosscutting-concepts/measurement-retention.md))
  applies unchanged.

### Forbidden

- **Do not call Open-Meteo from `image-service`.** ADR-001's
  sole-writer commitment for `duckdb-service` covers the
  `measurements` table; weather fetch belongs alongside the other
  scheduler jobs in `duckdb-service/services/`.
- **Do not drop the `source` tag.** Tagging both live and backfill
  rows is what lets a future "ignore retroactive imports for
  real-time analytics" filter work. A producer that writes
  untagged rows is a bug, not a shortcut.
- **Do not auto-trigger the historical backfill from `init_db()` /
  app boot.** Synchronous HTTP from import-time code blocks dev
  rebuilds, breaks the test fixture's module reload, and stalls
  production restarts. The admin endpoint is the supported entry
  point.

## References

- Issue: [#111](https://github.com/schutera/highfive/issues/111)
- Open-Meteo Forecast API: https://open-meteo.com/en/docs
- Open-Meteo Archive (ERA5): https://open-meteo.com/en/docs/historical-weather-api
- ADR-015 (browser-side weather): [adr-015-weather-correlation.md](adr-015-weather-correlation.md)
- ADR-016 (measurements store): [adr-016-per-module-measurements-store.md](adr-016-per-module-measurements-store.md)
- Worker template: `duckdb-service/services/silence_watcher.py`'s `check_silence`
- Provenance pattern: `duckdb-service/db/schema.py`'s heartbeat backfill block (lines 340-362)
- Plausibility check the worker reuses: `duckdb-service/routes/heartbeats.py`'s `_is_plausible_fix`
