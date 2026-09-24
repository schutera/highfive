# What Is Live in Production

The one-page answer to "which runtime is actually running at
`highfive.schutera.com`, and where does each setting live?" The two sibling
deployment docs each document one topology; this page says which of the two
the real host runs today and how to verify it. If this page and a sibling
doc ever disagree, the commands below are ground truth.

## TL;DR

- **Live today:** the bare-metal **Nginx + PM2** path — no Docker on the
  host. It self-deploys from the gated `production` branch via
  [`scripts/deploy.sh`](../../scripts/deploy.sh) on a 2-minute
  `highfive-deploy` systemd timer. Documented in
  [production-runbook.md](production-runbook.md).
- **Supported target, not deployed:** the **Docker Compose** production
  topology (`docker-compose.prod.yml` + host-Nginx). Fully specified in
  [production-deployment.md](production-deployment.md); the live host has
  not been cut over.
- The sibling docs are labelled accordingly: the runbook is **the live
  path**, the deployment doc is **the supported target**.

## Verify it on the host

```bash
pm2 list                      # live path: 3 apps (highfive-api, duckdb-service, image-service)
docker ps --filter name=highfive   # target path: 4 containers (empty today)
curl -fsS http://127.0.0.1:3001/api/health   # backend answers on 3001 either way
```

Three pm2 apps and no `highfive-*` containers = this page is current. From
any internet machine (read-only probes, no credentials — the live host's
`/etc/nginx` is not readable, so the probes are the only ground truth):

```bash
curl -sSI https://highfive.schutera.com/firmware.json | head -1   # 200 after a firmware release; 404 = artifacts missing from the live origin (#275)
curl -sSI https://highfive.schutera.com/upload        | head -1   # 405 = TLS ESP ingress routed to image-service (the fleet's path since #79)
curl -sSI  http://highfive.schutera.com/upload        | head -1   # 405 = pre-#79/HTTP ingress still routed
curl -sS  https://api.highfive.schutera.com/api/health   # JSON on the subdomain; the main domain's /api/ answers the SPA's index.html
curl -sSI https://highfive.schutera.com/ | grep -i '^server:'    # live: "Server: Caddy" (a Caddy edge sits in front of nginx)
```

## Runtime matrix

|                              | PM2 path (**live**)                                    | Docker path (supported target)                        |
| ---------------------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| Doc                          | [production-runbook.md](production-runbook.md)         | [production-deployment.md](production-deployment.md)  |
| Supervisor                   | pm2 (3 apps, system `python3` — no venv)               | `docker compose -f docker-compose.prod.yml` (4 services) |
| Auto-deploy                  | `scripts/deploy.sh` + `highfive-deploy` timer (2 min), pulls `production` | none in-repo — host `git pull production` + `up -d --build` (manual, per the deployment doc) |
| backend                      | pm2 `highfive-api` (Node cluster), `:3001`             | container → `127.0.0.1:3001`                          |
| duckdb-service               | pm2 app, `:8000`                                       | container → `127.0.0.1:8002` (container port 8000)    |
| image-service                | pm2 app, `:4444`                                       | container → `127.0.0.1:8000` (container port 4444)    |
| homepage                     | static files `/var/www/highfive/homepage/dist`, served by Nginx `:443` | container → `127.0.0.1:8081`, Nginx `:443` proxies it |
| Nginx vhosts                 | one: `highfive.schutera.com` (`:80` ESP ingress + 301; `:443` SPA — the main-domain `/api/` falls into it, so the main domain carries no API of its own); the browser API is served from the `api.highfive.schutera.com` subdomain — all behind a Caddy edge (`Server: Caddy`; both probe-verified 2026-09-06) | two: `highfive.schutera.com` + `api.highfive.schutera.com` |
| ESP/OTA ingress (`:80` **and** `:443`) | `/upload` → `:4444`; `/new_module`, `/heartbeat` → `:8000`; `/firmware.json`, `/firmware.app.bin` served from `homepage/dist` — the fleet since #79 uses the TLS (`:443`) blocks (ADR-010), `:80` serves pre-#79 stragglers; the artifacts **currently 404 on the live host** (#275) | `/upload` → `:8000`; `/new_module`, `/heartbeat` → `:8002`; firmware artifacts proxied to `:8081` (on both ports, per the vhost template) |
| DuckDB file                  | `./data/app.duckdb` — **relative to the service cwd** (`/var/www/highfive/duckdb-service/data/app.duckdb` per the runbook template); override with `DUCKDB_PATH` | `/data/app.duckdb` on the `duckdb_data` named volume (`Dockerfile.dev` `ENV`) |
| Config sources               | `.env` (backend via `dotenv`; Python via the ecosystem `require('dotenv')` line), `.deploy.env` (deploy.sh, exported into every `pm2 reload --update-env`), `ecosystem.config.js` (gitignored — template in the runbook), `homepage/.env.production` (gitignored, `VITE_API_URL`) | `.env.production` (compose `--env-file`; example `.env.production.example`) |

**Port-mirror footgun:** the two topologies *swap* the host ports of the
two Flask services (PM2: duckdb `:8000` / image `:4444`; Docker: image
`:8000` / duckdb `:8002`). Never copy a URL from one doc into the other
runtime — both `*_SERVICE_URL` rows in the matrix below are per-topology,
so a cross-doc copy lands on the other topology's ports. The missing-var
half of the same footgun has bitten the live host: ch. 11's "Admin 'failed
to load images'" lesson — a `pm2 restart` without `--update-env` left
`IMAGE_SERVICE_URL` unset, and the backend's fallback (a Docker service
name that does not resolve on bare metal) 502'd every `/api/images`.

## Environment variable matrix

"Where set" is the **in-repo** source of truth; on the live host the
gitignored `.env` / `.deploy.env` / `ecosystem.config.js` can have drifted
— verify with the commands above before relying on any cell.

| Variable | Read by | Where set — PM2 path | Where set — Docker path | Unset / empty means |
| --- | --- | --- | --- | --- |
| `HIGHFIVE_API_KEY` | backend (session admin + `/api/admin/*`), both Flask services (boot guard + internal `/logs` gate) | `.env` (backend); `.deploy.env` + ecosystem block (Flask) | `.env.production` — **fail-fast** (`:?`) in compose | outside production the public dev fallback `hf_dev_key_2026` applies; with the `HIGHFIVE_ENV=production` marker the boot guard refuses to start instead |
| `HIGHFIVE_ENV` | both Flask services (`services/prod_guard.py`) | `.deploy.env` + ecosystem block — **opt-in marker** | fixed to `production` in compose | marker absent → the #204 boot guard is a no-op; the admin `/logs` gate (#171) answers the dev key only when `HIGHFIVE_API_KEY` is also unset/blank (both `/logs` routes resolve `HIGHFIVE_API_KEY or <dev fallback>` first) |
| `DISCORD_WEBHOOK_URL` | deploy.sh (deploy/fleet-OTA notifications); duckdb-service (ADR-005 silence watcher, registration alerts); image-service (first-image alert) | `.deploy.env` (and `.env`, which the ecosystem block reads via `dotenv`) | `.env.production` — optional (`:-`) | deploy notifications go to `logs/auto-deploy.log` only; the **silence watcher degrades to `print()`** — a dead module looks healthy (see `.env.production.example`'s warning) |
| `LOG_DIR` | backend + both Flask services (ADR-023 on-disk log persistence) | `.env` (backend); `.deploy.env` + ecosystem (Flask — runbook uses `/var/www/highfive/logs/{duckdb,image}`, **not** `/data`) | fixed in compose (`/var/log/highfive`, `/data/logs/{image,duckdb}`) | each service's own default location (per ADR-023) |
| `DUCKDB_SERVICE_URL` | backend, image-service | **must** be `http://127.0.0.1:8000` (ecosystem / `.deploy.env`) | fixed to `http://duckdb-service:8000` (service name) | backend falls back to `127.0.0.1:8002` — that is the *Docker* host-port mapping, wrong on bare metal; image-service falls back to the unresolvable `http://duckdb-service:8000` — registration, heartbeat and progress recording all die |
| `IMAGE_SERVICE_URL` | backend (image/snip/logs proxy) | **must** be `http://127.0.0.1:4444` (ecosystem / `.deploy.env`) | fixed to `http://image-service:4444` (service name) | falls back to the unresolvable service name — dashboard "failed to load images" (ch. 11) |
| `SEED_DATA` | duckdb-service (initial sample modules) | not set by the runbook (code default: **off**) | dev compose `true`; prod compose `false` | no seeding — an empty DB stays empty; only matters when provisioning fresh |
| `DUCKDB_PATH` | duckdb-service **only** (`db/connection.py`) | not set by the runbook (code default: `./data/app.duckdb`, cwd-relative) | `Dockerfile.dev` `ENV` → `/data/app.duckdb` | see the DuckDB-file row in the runtime matrix; **image-service does not read it** (a vestigial compose entry was removed in #252) |
| `BACKUP_DIR`, `BACKUP_KEEP` | duckdb-service retained backup job (ADR-031) | code default = `dirname(DUCKDB_PATH)/backups` — with the `./data/app.duckdb` code default that is cwd-relative `./data/backups` under `/var/www/highfive/duckdb-service/`; keep `4` — unless set in `.deploy.env`/ecosystem | `.env.production` optional; compose `:-` defaults → `/data/backups` (from `DUCKDB_PATH=/data/app.duckdb` in `Dockerfile.dev`), `4` | code defaults apply |
| `FIRMWARE_AUTO_OTA` | `scripts/deploy.sh` only | `.deploy.env` — gate is `${FIRMWARE_AUTO_OTA:-0}`: unset = services-only; `1` = test-gated auto OTA (the `.deploy.env.example` ships with `1`) | n/a — the Docker path has no auto-deploy, firmware releases are manual (`firmware-release.md`) | `0` / unset: a firmware-source change on `production` deploys the services but never touches the fleet |
| `GEO_API_KEY` | `ESP32-CAM` **build time only** (`build.sh` / `extra_scripts.py`) | build env, or the gitignored `ESP32-CAM/GEO_API_KEY` file | CI `secrets.GEO_API_KEY` (esp-firmware job) | build fails — or with `HF_ALLOW_NO_GEO_KEY=1` produces a binary that geolocates as `(0, 0, 0)` |
| `VITE_API_URL` | homepage **build time only** (inlined into the bundle) | the gitignored `homepage/.env.production` on the host (or the operator's shell env at build time) — Vite loads it automatically in production mode; `deploy.sh`'s `npx vite build` inlines nothing itself | compose build-arg (`https://api.highfive.schutera.com/api`) | the bundle falls back to `http://localhost:3002/api`; `deploy.sh` greps every built bundle and rolls back if that fallback is baked in |
| `PORT`, `NODE_ENV` | backend | `.env` + ecosystem (`3001`, `production`) | fixed in compose | dev defaults (`:3002`, development off-ramp) |

## Firmware release modes

Both topologies ship firmware from the gated `production` branch, but only
the PM2 path has automation:

- **Manual (both paths):** bump `ESP32-CAM/VERSION` + `ESP32-CAM/SEQUENCE`,
  run `bash ESP32-CAM/build.sh` (needs `GEO_API_KEY`), republish the
  frontend, commit, promote to `production`, tag `prod-<codename>`.
  Full runbook: [firmware-release.md](firmware-release.md).
- **Automated (PM2 path only):** with `FIRMWARE_AUTO_OTA=1` in
  `.deploy.env`, a firmware-source change on `production` makes
  `deploy.sh` run the native test gate, build, publish the three artifacts
  into the live `homepage/dist`, and commit + push the bump + `prod-*` tag
  itself — after the services are already healthy (the OTA is the last,
  irreversible step). Forward-only: no field rollback.

## Known gaps on the live (PM2) host

Tracked on GitHub, not on this page:

- **The firmware origin currently 404s on the live host** (verified
  2026-09-06: `/firmware.json` and `/firmware.app.bin` are missing from
  the live `homepage/dist`, on both ports — [#275](https://github.com/schutera/highfive/issues/275)). Until it lands, the setup wizard cannot
  flash a new module from production and no `SEQUENCE`-bumped OTA release
  can reach the fleet — including the #231 fix. The runbook's smoke test
  (section 5b) checks this with one curl.
- applying `deploy/nginx/highfive-ingest.conf`'s rate limits to the live
  nginx (#229 follow-up), the ADR-032 device-identity fleet key
  (#229 follow-up), and the off-host backup sync for the PM2 DuckDB file
  (#232 follow-up).

This page records *what the in-repo ground truth says*; it does not assert
the live files match it — that is what the verification block above is for.
