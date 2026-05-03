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
   `module_configs.updated_at`, the latest `image_uploads.uploaded_at`
   per module, and the latest `module_heartbeats.received_at` per
   module. The `SELECT` block is at `silence_watcher.py:38-52`; the
   per-row liveness max is at `silence_watcher.py:60-65`.
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

Tunables live as module-level constants in `silence_watcher.py`:
`SILENCE_THRESHOLD_S` at line 16, `REALERT_INTERVAL_S` at line 19.

The schema change is additive: `db/schema.py:84-87` runs an
`ALTER TABLE module_configs ADD COLUMN last_silence_alert_at TIMESTAMP`
guarded by the migration helper, so existing DBs upgrade in place
without a separate table or join.

## Alternatives considered

- **Separate "watcher" microservice.** Rejected — would either need
  a second writer (violates ADR-001) or a remote HTTP read of liveness
  from `duckdb-service`, adding a service, deployment unit, and new
  failure mode for negligible benefit.
- **Polling cron job outside the stack** (e.g. a host cron + curl).
  Rejected — couldn't observe alert-suppression state without DB
  access; would either re-fire alerts every tick or maintain its own
  state-file with no atomicity guarantee.
- **Push from the data path** (have `routes/heartbeats.py` /
  `routes/upload.py` notify when a recent gap closes). Rejected —
  no event source for "nothing happened for N hours"; the silence
  detection inherently needs a periodic scan.
- **Separate `module_silence_alerts` table.** Rejected — single
  per-module nullable timestamp column is simpler, atomic with the
  existing module write path, and avoids a join on every silence
  scan. Re-evaluate if a multi-channel alerter (Slack + Discord +
  email) lands.

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
