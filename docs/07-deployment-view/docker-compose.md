# Deployment Guide (development)

This guide describes how to run the server-side components of the
HighFive system on a developer laptop using Docker Compose.

For production, see [production-deployment.md](production-deployment.md)
(Docker Compose with `docker-compose.prod.yml` + host-Nginx for the API
subdomain, frontend container handles its own 80/443) or
[production-runbook.md](production-runbook.md) (Nginx + PM2 bare-metal).

The system consists of four services:

- **backend** — Node 22 + Express + TypeScript API
- **homepage** — React 19 + Vite + TypeScript frontend
- **image-service** — Python 3.10 + Flask image ingestion / classification
- **duckdb-service** — Python 3.10 + Flask database service (sole writer of `app.duckdb`)

All services are orchestrated using **Docker Compose** on the shared
bridge network `net`.

<br>

## 1. Requirements

Make sure the following software is installed:

- Docker
- Docker Compose
- Git

Verify installation:

```bash
docker --version
docker compose version
```

## 2. Clone the Repository

```bash
git clone https://github.com/schutera/highfive.git
cd hivehive
```

## 3. Environment Configuration

Create a `.env` file in the root directory.

Example:

```bash
## Debug mode for development
DEBUG=<boolean>

## DuckDB service URL
## (used by the classification backend to connect to the DuckDB service)
## Keep as is then running with docker-compose
DUCKDB_SERVICE_URL="http://duckdb-service:8000"

## Optional: Additional environment variables can be added here as needed
```

The `.env` file is used by the **image service** and the
**DuckDB service**.

## 4. Start the Services

Run the following command in the root directory:

```bash
docker compose up --build
```

Docker will build and start all services defined in the
`docker-compose.yml` file.

## 5. Running Services

After startup the services are available on the following ports:

| Service        | Port   | Description                  |
| -------------- | ------ | ---------------------------- |
| Homepage       | `5173` | React + Vite frontend        |
| Backend API    | `3002` | Express + TS backend         |
| Image Service  | `8000` | Image ingestion and analysis |
| DuckDB Service | `8002` | Database API                 |

The web-interface itself is reachable under: http://localhost:5173

> **DuckDB Service is LAN-reachable in dev, and loopback-only in prod.**
> It is the sole DB writer and its internal endpoints (`/new_module`,
> `/heartbeat`, `DELETE /modules/:id`, …) are unauthenticated by design,
> so `docker-compose.prod.yml` binds it to `127.0.0.1` and lets host-Nginx
> proxy the only two paths the fleet needs.
>
> **Dev cannot do the same**, because there is no Nginx in the dev stack and
> the ESP talks to this port directly: `ESP32-CAM/extra_scripts.py` bakes
> `HF_INIT_URL_DEFAULT = http://<DEV_SERVER_HOST>:8002/new_module` into every
> LAN-dev build, `esp_init.cpp`'s `initNewModuleOnServer` registers against
> it, and `client.cpp`'s `sendHeartbeat` reuses the same URL "purely as the
> carrier of host+port". A loopback bind here removes the module's only route
> in — registration fails and heartbeats stop, silently.
>
> **So treat the dev stack as trusted-LAN-only.** On café or untrusted office
> Wi-Fi, either don't run it or drop the `8002` port mapping in
> `docker-compose.yml` and accept that no ESP can register while it's gone.
> The 2026-07 audit (#203) originally bound this to loopback in dev too; that
> was reverted because it broke the hardware bench with no replacement path.

> **Backend port — 3002 by default.** `backend/src/server.ts` reads
> the `PORT` env var through `backend/src/port.ts`'s `resolvePort()`,
> which falls back to `3002` when `PORT` is unset, empty, or
> non-numeric. The dev compose stack maps host `3002 → container 3002`
> and the homepage API client targets `:3002`, so the binding lines
> up with the host map even when nobody touches `PORT`. The backend
> service in `docker-compose.yml` still sets `PORT=3002` explicitly —
> it documents the dev-stack intent and silences the unset-fallback
> warning that `server.ts` emits on `npm run dev` workflows. Removing
> it now is a no-op for the dashboard (default matches), but the
> startup warning will fire — that's the signal to ask whether the
> drop was intentional. The earlier `3001` default plus the original
> incident (host port unbound → silent dashboard breakage) is
> captured in chapter 11's lessons-learned register.

## 6. Persistent Storage

The DuckDB database is stored in the Docker volume:

    duckdb_data

This volume is shared between the **image service** and the
**DuckDB service** to persist the database and images across container restarts.

### Startup ordering

`backend` and `image-service` both declare
`depends_on: duckdb-service: {condition: service_healthy}`, so compose holds
them until duckdb-service's healthcheck passes rather than merely until its
container starts. duckdb-service budgets `start_period: 10s` for Flask +
DuckDB's `init_db()`; without the gate the dependants come up alongside it and
their first calls land on a port nothing is listening on yet. For the backend
that surfaced as a spurious `⚠ DuckDB service not reachable` at boot which then
lingered in the admin Server Logs panel (#171), reading like a live outage long
after the service was fine.

The healthcheck runs at `interval: 2s` rather than the usual 15s precisely
because two services now block on it: the first probe's latency is a tax on
every `docker compose up`. `tests/ui/docker-compose.ui.yml` uses the same 2s
for the same reason. `docker-compose.prod.yml` deliberately keeps 15s — prod
boots once and pays the steady-state probe cost forever, the opposite
trade-off to a dev loop.

The backend _also_ retries the probe in-process
(`backend/src/duckdbBootProbe.ts`). That is not redundancy for this file's
benefit — it covers an **off-compose host** (the PM2 runbook), which has no
orchestrator to gate on, so start ordering is whatever the operator arranged.
See [production-runbook.md](production-runbook.md).

**Known trade-off of the gate.** Because `backend` now waits for
duckdb-service to be _healthy_, a duckdb that never becomes healthy means no
backend at all — so `/api/health` and the admin Server Logs panel, the very
surface you would use to diagnose it, are unreachable in that case. Use
`docker compose logs duckdb-service` instead. The alternative (no gate, backend
up but degraded) is what the in-process probe provides on the PM2 path; the two
deployment styles genuinely differ here.

### Server log persistence (#178 / ADR-023)

Each service also persists its admin **Server Logs** ring to disk (JSONL, daily
rotation, retained ≤30 files / ≤100 MB), gated on the `LOG_DIR` env var, and
backfills the ring from disk on restart so the panel shows pre-restart history:

- **backend** → its own `backend_logs` volume at `/var/log/highfive`.
- **duckdb-service** and **image-service** → distinct subdirs of `duckdb_data`
  (`/data/logs/duckdb`, `/data/logs/image`) so the two services sharing that
  volume never collide on one file.

`docker compose down -v` clears these along with `duckdb_data`. Unset `LOG_DIR`
to fall back to the in-memory-only ring (pre-ADR-023 behaviour).

### Backup retention (#232 / ADR-031)

`duckdb-service`'s weekly job (`services/backup.py`'s `run_backup()`, scheduled
Sunday 03:00) writes a gzip'd, sha256'd, rotated snapshot of `app.duckdb` —
never a raw file upload to Discord, which now gets a text-only notification
(size, lock-hold duration, hash, path). It aborts (with a Discord alert,
no partial files left behind) if free disk space on the **same** volume
as the live DB is under 1.5× the live DB's size — headroom on top of the
live file (already-allocated, not new usage) for the raw copy (~1×) plus
the still-growing gzip output briefly coexisting before the raw copy is
removed, not a doubling/tripling of the live file's own footprint — so
this guards against the backup job itself being the thing that fills the
disk. Two optional env vars, both read at call
time — `docker compose up -d duckdb-service` (which recreates the
container so `env_file: .env` is re-read) picks up a change; editing
`.env` alone does **not**, since Compose evaluates `env_file:` at
container-create time, not on a live-reload:

- `BACKUP_DIR` — default `/data/backups`, a subdir of the shared `duckdb_data`
  volume. `docker compose down -v` clears it along with everything else on
  that volume.
- `BACKUP_KEEP` — default `4`, floored at `1` (so `BACKUP_KEEP=0` can't be
  read as "keep nothing" and delete the backup a run just made); older
  `highfive_backup_*.duckdb.gz` files (and their `.sha256` sidecars) are
  deleted beyond this count.

Neither var needs setting for the defaults to work. The "backups are
local-only" boot/post-run warning is gated on a **heartbeat file**
(`BACKUP_DIR/.offhost_sync_ok`, `services/backup.py`'s
`_has_fresh_offhost_sync`), not a static flag — the app can't observe
whether an external rsync/restic unit is actually *running*, only
whether one has touched this file inside the last 48h, so the warning
comes back on its own if the sync stops rather than staying silenced
forever. See
[production-deployment.md → Backup & Restore](production-deployment.md#backup--restore)
for the off-host sync unit template that writes this heartbeat.

### Demo nest snips for the time-lapse (#166)

`SEED_DATA: 'true'` is set on **both** `duckdb-service` (which seeds the
`nest_detections` rows) **and** `image-service` (which, on boot, copies the
bundled `image-service/demo_snips/*.jpg` into the shared snip volume) so the
per-nest time-lapse has real crops to scrub on a fresh dev stack. The copy is
idempotent and skips any snip already on the volume, so it never clobbers real
uploads. `docker-compose.prod.yml` sets `SEED_DATA=false`, so production copies
nothing.

During development it may be necessary to reset the database, for example
when **primary key conflicts** occur due to previously inserted test data.

To reset the database, the Docker volume must be removed.

```bash
# When already stopped
docker volume rm duckdb_data
```

Alternatively, the containers and volumes can be removed together using:

```bash
docker compose down -v
```

## 7. Stopping the System

To stop all running services:

```bash
docker compose down
```
