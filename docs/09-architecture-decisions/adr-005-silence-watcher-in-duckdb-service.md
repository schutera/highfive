# ADR-005: Discord silence watcher lives in `duckdb-service`

## Status

Accepted.

## Context

Field-deployed modules sometimes go quiet — router reboot, dead
battery, broken WiFi. Operators want to be told within a few hours
rather than discover it a week later. PR 17 added a Discord webhook
that fires "module X has been silent for Yh" alerts and a recovery
message when the module phones home again
(`duckdb-service/services/silence_watcher.py`).

The watcher needs three things:

1. **Liveness state for every module.** It computes the freshest of
   `module_configs.updated_at`, last API call, and the latest row in
   `module_heartbeats` (`silence_watcher.py:42-65`).
2. **A place to record "we already alerted on this silence so don't
   re-fire for `REALERT_INTERVAL_S` seconds"** — done with a single
   nullable `last_silence_alert_at TIMESTAMP` column on
   `module_configs` (`duckdb-service/db/schema.py:86`). Set on alert
   (`silence_watcher.py:73`), cleared on recovery (`silence_watcher.py:83`).
   No separate alerts table.
3. **A periodic trigger.** It runs as a background thread inside
   `duckdb-service`'s Flask process.

All three are tightly coupled to the database. ADR-001 makes
`duckdb-service` the sole writer of `app.duckdb`; the alert state
is a write the watcher needs to do.

The natural alternative — a separate "watcher" microservice — would
need either a second DB writer (violates ADR-001) or its own HTTP
read of liveness from `duckdb-service`. Either path adds a service,
a deployment unit, and a new failure mode for negligible benefit.

## Decision

The watcher is a function (`check_silence`) inside
`duckdb-service/services/silence_watcher.py`, scheduled by a
threading loop started in `duckdb-service/app.py`. It reads liveness
directly from the local DB and writes alert-suppression state
(`module_configs.last_silence_alert_at`) to the same DB. Discord is
reached via the same `services/discord.py` helper the rest of the
service already uses.

Tunables (`SILENCE_THRESHOLD_S`, `REALERT_INTERVAL_S`) live as
module-level constants in `silence_watcher.py:14-18`.

The schema change is additive: `db/schema.py:84-87` runs an
`ALTER TABLE module_configs ADD COLUMN last_silence_alert_at TIMESTAMP`
guarded by the migration helper, so existing DBs upgrade in place
without a separate table or join.

## Consequences

**Positive**:

- One process, one DB writer, one source of liveness truth.
- Alert state lives **on the row it's about** (not a join, not a
  second table) — no cross-table consistency to worry about.
- Failure mode is simple: if `duckdb-service` is down, alerts pause;
  when it comes back, the watcher re-fires for anything still silent
  (the `REALERT_INTERVAL_S` window will have elapsed).

**Negative**:

- The watcher shares the Flask process and global `lock` with the
  request handlers. A long DB scan would block requests. Mitigated
  by querying only `module_configs` (a few rows) per tick, not the
  per-image tables.
- Discord webhook URL is read from env on each call; if the env is
  missing the watcher silently degrades to logging only.
- Co-locating alert state on `module_configs` means a future
  multi-channel alerter (Slack + Discord + email) would either need
  a column per channel or a separate table after all. Deferred until
  a second channel actually exists.

**Forbidden**:

- Don't introduce a second writer for `module_configs.last_silence_alert_at`.
  Anything that mutates that column goes through `silence_watcher.py`.
- Don't read or write `module_configs.last_silence_alert_at` from
  the backend or image-service — it is internal alert-state plumbing,
  not public liveness data. Use `lastSeenAt` / `latestHeartbeat` for
  liveness on the wire.
