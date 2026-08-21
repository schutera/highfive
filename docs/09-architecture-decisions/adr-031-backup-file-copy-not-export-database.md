# ADR-031: Retained backups are gzip'd file copies, not `EXPORT DATABASE`

## Status

Accepted.

## Context

Issue #232 replaced `duckdb-service/services/backup.py`'s `run_backup()`
— previously a weekly, lock-holding, Discord-only, retain-nothing job —
with a real retained/rotated backup. Two ways to produce that backup
artifact from a live DuckDB file were on the table:

1. **File-copy**: force a `CHECKPOINT` (flushes the WAL into the main
   `.duckdb` file), then `shutil.copy2` the file itself, then gzip the
   copy.
2. **`EXPORT DATABASE '<dir>' (FORMAT PARQUET)`**: DuckDB's built-in
   logical export, one Parquet file per table plus a `schema.sql`.

Both can run under the same short lock-hold discipline the issue
requires (`db.connection.lock` held only for the DB-touching step, not
the slow compression). The choice is about what a **restore** looks
like and how much surface the backup path has to get right.

## Decision

`run_backup()` uses **file-copy + gzip** (`services/backup.py`'s
`_checkpoint_and_copy` + `_gzip_and_remove`). The retained artifact is
a single `highfive_backup_<UTC timestamp>.duckdb.gz` with a `.sha256`
sidecar under `BACKUP_DIR` (default `/data/backups`), rotated to the
newest `BACKUP_KEEP` (default `4`).

## Alternatives considered

- **`EXPORT DATABASE ... (FORMAT PARQUET)`.** Rejected for this job.
  Restoring it is `IMPORT DATABASE`, which means recreating an empty
  DuckDB file, running `IMPORT DATABASE` against the export dir, and
  only then having a usable `app.duckdb` — three steps versus
  file-copy's restore, which is "stop the service, replace one file,
  start the service" — the exact drill this issue's acceptance
  criteria ask to perform and time. Note this is **not** a "safer on
  version compatibility" choice either way, and arguably cuts the other
  direction: a physical `.duckdb` file copy is bound to DuckDB's own
  on-disk storage format (a newer DuckDB reads older files; an *older*
  DuckDB restoring a file made by a newer one can fail outright), while
  `EXPORT`/`IMPORT DATABASE` is DuckDB's actual documented mechanism for
  moving data across storage-format versions. The decision here is made
  purely on restore-time-and-complexity (RTO) grounds, not portability —
  see the storage-version-coupling Negative below. Parquet's real
  advantage (columnar compression, portable per-table files for
  downstream analytics) is a different problem than "can I get the
  service back up after volume loss", which is what #232 is about.
  Revisit if a future need (e.g. a data-science export pipeline) wants
  Parquet snapshots alongside — that would be an addition, not a
  replacement.

## Consequences

**Positive**:

- Restore is a file replace: `docker compose stop duckdb-service`,
  gunzip the chosen backup over `duckdb_data`'s `app.duckdb`, restart —
  no intermediate empty-DB-plus-import step, three fewer moving parts
  at the moment recovery matters most. Actually drilled (dev stack,
  `production-deployment.md → Backup & Restore → Restore drill`), not
  just asserted.
- The `.sha256` sidecar is a direct integrity check on the exact bytes
  that get restored — no need to hash a directory of Parquet files.
- Minimal diff from the pre-#232 job: same artifact shape
  (`.duckdb.gz`), just retained, rotated, and produced under a
  short lock instead of the whole gzip running inside it.

**Negative**:

- The gzip'd copy is a full physical snapshot — no per-table
  compression benefit Parquet would give, and no way to restore a
  single table without unpacking the whole file.
- **Bound to DuckDB's on-disk storage-format version** (see the
  alternatives-considered note above) — an older DuckDB cannot open a
  file written by a newer one. `EXPORT DATABASE` would have been the
  safer choice on cross-version portability specifically; this ADR
  trades that away for restore simplicity.
- **The `CHECKPOINT` + copy lock hold is O(DB file size)**, not O(1).
  Dev-scale measurement was ~0.07s; chapter 11's historical ~8 GB figure
  (see `production-deployment.md → Backup & Restore` for why that's a
  capacity-planning reference, not today's prod size) would put the
  hold in the **minutes**, not milliseconds — and that lock blocks every
  route, including `/heartbeat` and `/new_module`. This isn't unique to
  file-copy (a `CHECKPOINT` before `EXPORT DATABASE` would face the same
  scaling), but it means the "short lock hold" framing throughout #232
  is a dev-scale observation that needs re-measuring, not a
  scale-independent guarantee.
- **The raw copy needs up to ~1.5× the live DB's size in *additional*
  free space, on the same volume as the live DB** — headroom on top of
  the live file (already-allocated, not new usage) for the raw copy
  itself (~1×) plus the still-growing gzip output, which briefly
  coexists with the raw copy before it's removed. Not a description of
  the live file's own footprint doubling or tripling — `_check_free_space`
  (called right after `CHECKPOINT`, so it sees the real post-flush size,
  not a possibly-smaller pre-checkpoint reading) aborts rather than risk
  an ENOSPC mid-copy, but that means a backup can legitimately fail-safe
  on a nearly-full volume rather than complete. Off-host sync
  reducing local retention pressure (fewer `BACKUP_KEEP` generations
  needed locally once they're safely elsewhere) is the intended
  long-term mitigation, not a bigger volume.
- A future analytics/export need (e.g. feeding `daily_progress` into
  an external tool) would still want a Parquet or CSV export path;
  this ADR only settles the operational-backup question, not a data
  export feature.

**Forbidden**:

- Don't read the live `DB_PATH` for the slow gzip step — always gzip
  the already-copied file outside `lock`, per `_gzip_and_remove`. The
  entire point of #232 was to stop holding the sole writer's lock for
  the duration of compression.
- Don't trigger `run_backup()` (or an equivalent checkpoint+copy) from a
  **separate OS process** while `duckdb-service` is live and serving.
  DuckDB's own single-writer lock is real and genuinely cross-process,
  but it's held only while a connection is open — `get_conn()` opens and
  closes per call, so the live process spends most of its time with no
  connection open at all, and `shutil.copy2` right after is a plain file
  copy with no DuckDB coordination whatsoever. A second process's own
  `CHECKPOINT` can slot cleanly into one of those gaps; the actual danger
  is the live process opening its own connection and writing *while the
  copy is reading the same bytes*, producing a torn file that still
  hashes "successfully" (the hash is computed on the copy, after the
  fact — it can't detect what a live source diverged into mid-read). The
  weekly scheduled job is safe because it runs *inside* the serving
  Flask process, sharing the real `db.connection.lock` with every
  request handler; any on-demand manual backup must stop the service
  first — see `production-deployment.md → Backup & Restore → Step 0`,
  including its explicit `docker compose ps` check that the stop
  actually took effect before proceeding. Do not add a "just exec into
  the running container" convenience command anywhere in the docs
  without re-reading this paragraph.
- This whole safety argument assumes **one process serving one shared
  `db.connection.lock`** — true today (`Dockerfile.dev`'s `CMD ["python",
  "app.py"]`, no gunicorn/uwsgi/waitress). A future move to a
  multi-worker WSGI server (`app.py`'s own comments already anticipate
  this for request concurrency) would give each worker its own
  `threading.Lock` and its own `scheduler.add_job(run_backup, ...)` —
  N processes independently firing `run_backup` at the same Sunday
  03:00, each believing it holds the only lock. That's this ADR's
  "Forbidden" scenario, self-inflicted by the deployment, not a
  documentation gap. Any such migration must move the scheduled job (and
  its lock) to a single designated worker, or out of the Flask process
  entirely, before switching to multi-worker.
- Don't write the gzip output directly to its final, retained
  `*.duckdb.gz` name. `run_backup` gzips to a `.inprogress` path, writes
  the `.sha256` sidecar, and only then `os.replace`s it into place —
  publishing the complete, verified artifact atomically as the very last
  step. A hard kill (OOM, container stop, host crash — as opposed to a
  caught Python exception, which the existing `except` block already
  cleans up) partway through a direct write to the final name leaves a
  truncated file sitting at the one name `_rotate` and a restore trust;
  reproduced directly in `test_run_backup_hard_kill_during_gzip_does_not_corrupt_existing_backups`
  during review, where it silently evicted a good generation.
