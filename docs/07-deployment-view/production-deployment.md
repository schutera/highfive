# Production Deployment (Docker Compose + host-Nginx)

Deploy HiveHive to production from the `production` branch — the gated
release branch, fast-forwarded from `main` when a release is cut (#152) —
using `docker-compose.prod.yml` plus a host-level Nginx that terminates TLS
for both `highfive.schutera.com` (frontend) and
`api.highfive.schutera.com` (backend). All four services
(`backend`, `frontend`, `image-service`, `duckdb-service`) run in a
single Compose project; the `duckdb_data` named volume persists the
DuckDB file across rebuilds.

For a non-Docker production option (Nginx + PM2 on bare metal), see
[production-runbook.md](production-runbook.md). For dev-laptop setup,
see [docker-compose.md](docker-compose.md).

> **This doc covers the web services (Docker Compose path).** Both the web
> services **and** the ESP32-CAM firmware OTA now ship from the `production`
> branch (#152): `main` is the integration line, and a release is a
> fast-forward of `production` onto a chosen `main` commit
> (`git push origin <sha>:production`). On this Docker path the host then
> `git pull`s `production` and re-runs `docker compose -f docker-compose.prod.yml
> up -d --build`. The firmware-specific mechanics (SEQUENCE gate, build,
> manifest) live in [firmware-release.md](firmware-release.md); the
> branch/promotion model is recorded in
> [ADR-030](../09-architecture-decisions/adr-030-production-as-gated-release-branch.md).
>
> ⚠️ **Which runtime is live?** The in-repo on-host automation
> (`scripts/deploy.sh` + the `highfive-deploy` systemd timer) is the
> **bare-metal PM2 path** — it `npm`/`vite`-builds, `pm2 reload`s, and copies
> firmware artifacts into a host directory; it issues **no** `docker` commands.
> So the timer-driven automation belongs to
> [production-runbook.md](production-runbook.md), not this Docker doc. Confirm
> which runtime your host actually runs before relying on either deploy action.

## Topology at a glance

```
                              Internet
                                  │
                ┌─────────────────┼──────────────────┐
                ▼                 ▼                  ▼
      :443 highfive.*    :443 api.highfive.*    :80 highfive.*
      ─────────────────  ──────────────────     ──────────────
            host-Nginx (TLS for browsers, HTTP-passthrough for ESP)
                ▼                 ▼                  ▼
      127.0.0.1:8081     127.0.0.1:3001        /upload       → 127.0.0.1:8000
      (frontend SPA)     (backend API)         /new_module   → 127.0.0.1:8002
                                │               /heartbeat   → 127.0.0.1:8002
                                ▼               (else 301 → HTTPS)
                       duckdb-service:8000
                       image-service:4444
                       (Compose-internal,
                        via `highfive-network`)
```

ESP32-CAM firmware uploads reach `image-service` via the host-Nginx
port-80 server block at `http://highfive.schutera.com/upload` (proxied
to `127.0.0.1:8000`). Module registration and heartbeats hit
`/new_module` and `/heartbeat` on the same port-80 vhost, proxied to
`duckdb-service` on `127.0.0.1:8002`. All firmware traffic is HTTP-only
by design — see "Known gaps" for why and the migration path.

## Prerequisites

- Server: Ubuntu 20.04+ with 7.7 GB+ RAM
- Docker + Docker Compose v2
- Domain: `highfive.schutera.com` pointing to the server IP
- API subdomain: `api.highfive.schutera.com` pointing to the server IP
- Root/sudo access
- Nginx + certbot installed on the host (the host-Nginx terminator)

## Quick Deploy

> **`Permission denied (publickey)`? Do not guess the username.** Guessing
> trips the host's brute-force protection and bans your IP — port 22 goes
> dead while HTTPS keeps serving, which reads as an outage. `ssh -G <host>`
> shows the resolved login offline, without spending an auth attempt. See
> [troubleshooting.md → Production host access (SSH)](../troubleshooting.md#production-host-access-ssh).

```bash
# SSH into server
ssh user@your-server-ip

# 1. Create swap space (prevents OOM during build)
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Clone production branch
sudo mkdir -p /opt/highfive
sudo chown $USER:$USER /opt/highfive
cd /opt/highfive
git clone -b production https://github.com/schutera/highfive.git .

# 3. Set production secrets
cp .env.production.example .env.production
$EDITOR .env.production   # fill HIGHFIVE_API_KEY (no VITE_API_KEY — #142)
# Generate the key with: openssl rand -base64 32

# 4. Build all four services
docker compose -f docker-compose.prod.yml --env-file .env.production build

# 5. Start services (duckdb-service must become healthy before
# image-service and backend start - depends_on conditions handle this)
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml --env-file .env.production ps

# 6. Smoke-test from inside the box (host-Nginx not yet wired)
curl -fsS http://127.0.0.1:3001/api/health     # backend
curl -fsS http://127.0.0.1:8081/ | head -5     # frontend SPA
curl -fsS http://127.0.0.1:8000/health         # image-service (HTTP-only by design)
docker compose -f docker-compose.prod.yml exec duckdb-service \
    python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read())"
```

If `docker compose up` fails fast with
`HIGHFIVE_API_KEY must be set in .env.production`, that is by design — the
compose interpolation rejects a missing or empty secret. Fix
`.env.production` and re-run. (The homepage bundle carries no secret since
#142, so there is no `VITE_API_KEY` to set.)

> **Also set `DISCORD_WEBHOOK_URL`, even though nothing fails without it.**
> It is interpolated as `${DISCORD_WEBHOOK_URL:-}` (blank-tolerant), not
> `:?` — so a stack with it unset boots perfectly and then **runs with the
> ADR-005 silence watcher effectively disabled**: `send_discord_message`
> degrades to a `print()`, and a field module that stops reporting produces
> no alert. That is the operator's primary field-failure signal, so an unset
> webhook is a silent monitoring outage rather than a missing nicety.
>
> The value used to be hardcoded in both Python services and worked with no
> configuration; the 2026-07 audit (#201) removed it because a live webhook
> credential sat in a public repo. Verify after deploy:
>
> ```bash
> docker compose -f docker-compose.prod.yml --env-file .env.production \
>   exec duckdb-service python -c "import os; print('webhook set:', bool(os.getenv('DISCORD_WEBHOOK_URL')))"
> ```

## Detailed Steps

### Step 1: Create Swap Space

Critical to prevent OOM errors during Docker build:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Verify
free -h

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Step 2: Clone Repository

```bash
cd /opt/highfive
git clone -b production https://github.com/schutera/highfive.git .
git status  # Should show production branch
```

### Step 3: Configure Secrets

```bash
cp .env.production.example .env.production

# Generate the admin secret (login password + session-cookie HMAC key).
# Since #142 there is only one secret; the bundle carries none.
openssl rand -base64 32   # → HIGHFIVE_API_KEY

$EDITOR .env.production
chmod 600 .env.production  # operator-managed, never enters git
```

`.env.production` is git-ignored (an explicit `.env.production` entry
lives in the repo `.gitignore`). Never commit it.

### Step 4: Build Docker Images

```bash
cd /opt/highfive

docker compose -f docker-compose.prod.yml --env-file .env.production build

# Verify all four images exist
docker images | grep highfive
```

Expected: `highfive-backend`, `highfive-frontend`, `highfive-image-service`,
`highfive-duckdb-service`.

The two Python images build from `python:3.10-slim` — the floor declared in
`/.python-version` and kept in sync across the Dockerfiles, ruff floor, and CI
matrices by `make check-python-version` (ADR-029, #197). The separate bare-metal
PM2 track documents its matching host `python3` in
[production-runbook.md](production-runbook.md).

### Step 5: Start Services

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# Wait for duckdb-service healthcheck to pass (~10-30 s)
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

All four services should show `running` (or `running (healthy)` for
`duckdb-service`). The `depends_on: condition: service_healthy`
gates ensure `image-service` and `backend` only start after
`duckdb-service` is responsive.

### Step 6: TLS via host-Nginx

The Compose stack binds all four services to the server's loopback only.
A host-level Nginx terminates TLS for two browser subdomains
(`highfive.schutera.com`, `api.highfive.schutera.com`) and additionally
proxies the three firmware paths (`/upload`, `/new_module`, `/heartbeat`)
on plain HTTP because field ESP32-CAM modules ship with
`http://highfive.schutera.com/upload` baked into `ESP32-CAM/config.json`
and would otherwise hit a 301 redirect they can't follow. See "Known gaps".

Loopback port map for host-Nginx:

| Loopback         | Service          | Used by                                           |
| ---------------- | ---------------- | ------------------------------------------------- |
| `127.0.0.1:8081` | `frontend`       | browser via TLS termination                       |
| `127.0.0.1:3001` | `backend`        | browser via TLS termination                       |
| `127.0.0.1:8000` | `image-service`  | ESP firmware via HTTP /upload                     |
| `127.0.0.1:8002` | `duckdb-service` | ESP firmware via HTTP `/new_module`, `/heartbeat` |

#### a. Install Nginx and certbot

```bash
sudo apt-get update
sudo apt-get install nginx certbot python3-certbot-nginx
```

#### b. Get certificates with `certbot --standalone`

`certbot --standalone` runs its own short-lived HTTP server on port 80
for ACME validation; it doesn't need any Nginx vhost in place. Stop
Nginx briefly so port 80 is free:

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone \
    -d highfive.schutera.com \
    -d api.highfive.schutera.com
sudo systemctl start nginx
```

The cert lineage on disk is named after the **first** `-d` argument:
`/etc/letsencrypt/live/highfive.schutera.com/fullchain.pem`. Both
subdomains are covered by the same SAN cert; `certbot renew` (cron
default) handles future renewals — pair it with a `--post-hook
"systemctl reload nginx"` if you switch to webroot in a follow-up.

#### c. Configure host-Nginx

First, install the rate-limit zones for `/new_module` and `/heartbeat`
(2026-08 audit, for #229 — see
[`deploy/nginx/highfive-ingest.conf`](../../deploy/nginx/highfive-ingest.conf)
for the full rationale). `limit_req_zone` must live in the `http {}`
context, so it cannot go inside the `sites-available/highfive` file's
`server {}` block below:

```bash
sudo cp deploy/nginx/highfive-ingest.conf /etc/nginx/conf.d/highfive-ingest.conf
```

> **Retrofitting an already-provisioned host** (this section otherwise
> reads as a fresh-install walkthrough): the `cp` above and the two
> `location` block edits below are the entire change — no service
> restart needed, `nginx -t && systemctl reload nginx` (below, before
> the Step 6 smoke-test) picks it up. Nothing else in this guide needs
> re-running. As of this
> PR nobody has actually applied this to the live host yet. Its syntax
> was verified with `nginx -t` against the merged config shown above
> (`nginx:alpine` in Docker, since this dev environment has no local
> nginx) — but that is a syntax check, not a deployment: it does not
> confirm the zones behave as intended under real traffic, and it has
> not been run against production's actual, possibly-diverged
> `/etc/nginx/sites-available/highfive`. Run `nginx -t` again on the
> real host after applying it, before reloading (see
> [ADR-032](../09-architecture-decisions/adr-032-device-identity-for-ingest.md)
> and the CLAUDE.md priority queue).

Then create `/etc/nginx/sites-available/highfive`:

```nginx
# Port 80, highfive.schutera.com - serves ESP firmware traffic on HTTP
# AND redirects browser traffic to HTTPS. The /upload, /new_module,
# /heartbeat locations exist because field firmware ships with
# http://highfive.schutera.com/upload baked in - moving those to HTTPS
# would require reflashing the fleet (tracked in Known gaps).
server {
    listen 80;
    server_name highfive.schutera.com;

    location = /upload {
        proxy_pass http://127.0.0.1:8000/upload;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;
        client_max_body_size 10M;
        proxy_read_timeout 60s;
    }

    # limit_req + client_max_body_size added 2026-08 (#229) — these two
    # routes previously had NO nginx-level bound at all (unlike /upload's
    # 10M above). Zones defined in highfive-ingest.conf, installed above.
    location = /new_module {
        proxy_pass http://127.0.0.1:8002/new_module;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_new_module burst=20 nodelay;
        client_max_body_size 8k;
    }

    location = /heartbeat {
        proxy_pass http://127.0.0.1:8002/heartbeat;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_heartbeat burst=60 nodelay;
        client_max_body_size 8k;
    }

    # OTA firmware artifacts (#26). The ESP firmware fetches both files
    # over plain HTTP because its WiFiClient does not do TLS. Pinned
    # to exact-match locations (`location =`) so they take precedence
    # over the catch-all 301-to-HTTPS below. Without these, every OTA
    # check would land on the 301 and the device would log
    # `[OTA] manifest HTTP 301` and skip. Tracked in ADR-008.
    location = /firmware.json {
        proxy_pass http://127.0.0.1:8081/firmware.json;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location = /firmware.app.bin {
        proxy_pass http://127.0.0.1:8081/firmware.app.bin;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        # The app-only binary is ~1 MB; a slow LAN client may take a
        # while to drain it, so give nginx enough time to serve the
        # full body without dropping the connection mid-stream.
        proxy_read_timeout 120s;
    }

    # Browser traffic for everything else: redirect to HTTPS.
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# Port 80, api.highfive.schutera.com - browser-only, always 301 to HTTPS.
server {
    listen 80;
    server_name api.highfive.schutera.com;
    return 301 https://$server_name$request_uri;
}

# HTTPS frontend at https://highfive.schutera.com
server {
    listen 443 ssl http2;
    server_name highfive.schutera.com;

    ssl_certificate /etc/letsencrypt/live/highfive.schutera.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/highfive.schutera.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# HTTPS backend at https://api.highfive.schutera.com
server {
    listen 443 ssl http2;
    server_name api.highfive.schutera.com;

    ssl_certificate /etc/letsencrypt/live/highfive.schutera.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/highfive.schutera.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # SSE live tail of the admin Server Logs (#178 / ADR-023). Must come BEFORE
    # the catch-all `location /` so nginx routes it here. Buffering off so events
    # reach the browser as they happen, not in one chunk at disconnect. The
    # backend also sets `X-Accel-Buffering: no` as a safety net, but pin it here.
    location /api/admin/logs/stream {
        proxy_pass http://127.0.0.1:3001/api/admin/logs/stream;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 1h;       # long-lived stream
        proxy_set_header X-Accel-Buffering no;
    }

    location / {
        proxy_pass http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/highfive /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### d. Smoke-test

Browser (TLS):

```bash
curl -fsS https://api.highfive.schutera.com/api/health
curl -fsSI https://highfive.schutera.com/ | head -5
```

Both should return 200. The frontend root serves the SPA; the API
health check returns `{ "status": "ok", "timestamp": "..." }`.

Dashboard fetch path (TLS; public read since #142 — no credential):

```bash
curl -fsS https://api.highfive.schutera.com/api/modules
```

This is the path the SPA actually exercises. A 200 with a JSON array means
the host-Nginx TLS proxy is wired and the dashboard will load data correctly.
(Admin actions instead log in via `POST /api/admin/login`; verify with
`curl -fsS -X POST https://api.highfive.schutera.com/api/admin/login -H 'Content-Type: application/json' -d "{\"password\":\"$HIGHFIVE_API_KEY\"}" -i`
— look for the `Set-Cookie: hf_admin_session=…` header.)

ESP firmware paths (HTTP, no `-f` because /upload returns 405 for HEAD):

```bash
# 405 Method Not Allowed = success: nginx routed to image-service, not
# a 301 to HTTPS. Pipe through grep so the test passes when 405 lands.
curl -sSI http://highfive.schutera.com/upload | head -1
curl -sSI http://highfive.schutera.com/heartbeat | head -1
# OTA artifacts (#26). Both must return HTTP/1.1 200 (NOT 301) — see
# ADR-008. The first time these are deployed, `firmware.app.bin` may
# 404 until ESP32-CAM/build.sh has run; that's fine for the
# infrastructure smoke-test but blocks Phase-2 OTA until the asset is
# in place.
curl -sSI http://highfive.schutera.com/firmware.json    | head -1
curl -sSI http://highfive.schutera.com/firmware.app.bin | head -1
```

If any of these returns `HTTP/1.1 301 Moved Permanently` with a
`Location: https://...` header, the firmware-proxy `location =`
blocks aren't matching — check `nginx -t` and the order of server
blocks.

The cert lineage on disk uses the first `-d` value as the directory
name. Confirm with:

```bash
sudo ls /etc/letsencrypt/live/
# Should list: highfive.schutera.com  (one directory; both subdomains
# share this SAN cert)
```

### Step 7: Operational checks

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=50 backend
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=50 image-service
docker compose -f docker-compose.prod.yml --env-file .env.production logs --tail=50 duckdb-service

# DuckDB volume health
docker volume inspect highfive_duckdb_data
docker compose -f docker-compose.prod.yml exec duckdb-service ls -lah /data
```

## Releasing: the gated `production` branch

`production` is the **single release branch** for both the web services and the
firmware OTA (#152, [ADR-030](../09-architecture-decisions/adr-030-production-as-gated-release-branch.md)).
`main` is the continuous-integration line; nothing deploys directly from it. A
release is a deliberate **fast-forward of `production` onto a chosen `main`
commit** — `main` may run ahead of what is live.

**Cut a release** (from a maintainer's clone, not the host):

```bash
git fetch origin
# promote the latest reviewed main (origin/main, just fetched) to production —
# fast-forward only. Substitute an explicit reviewed SHA for origin/main to gate
# the release to a specific commit.
git push origin origin/main:production
```

Then the host deploys it:

- **Docker path (this doc):** `git pull` on the host and re-run
  `docker compose -f docker-compose.prod.yml up -d --build`.
- **Bare-metal PM2 path:** the `scripts/deploy.sh` systemd timer notices
  `origin/production` advanced, `--ff-only`-pulls it, rebuilds only the changed
  services (`npm`/`vite` + `pm2 reload`), health-checks, and — for
  firmware-source changes — publishes the OTA and cuts the `prod-<codename>`
  tag on `production`. See [production-runbook.md](production-runbook.md) and
  [firmware-release.md](firmware-release.md).

### One-time cutover — ORDER MATTERS

Run once, on the host, when adopting this model (the host previously tracked
`main`).

> ⚠️ **Promote first, check out second.** Doing it the other way round reverts
> production. `origin/production` lags `main`, so
> `git reset --hard origin/production` on a host that is currently serving
> `main` rolls the live services *backwards* to whatever `production` last
> pointed at — and if that predates the switch, the `scripts/deploy.sh` you
> land on still has `BRANCH="main"` while the checkout is `production`, so the
> driver silently no-ops on every tick and the "wrong branch" alert that would
> have told you is itself reverted away. Silent, permanent, and self-concealing.

**Step 1 — promote (from a maintainer clone, not the host).** Pick the `main`
commit you intend to release and fast-forward `production` onto it:

```bash
git fetch origin
git log --oneline origin/production..origin/main      # what you are about to ship
git push origin <chosen-main-sha>:production          # fast-forward; no --force
```

**Step 2 — verify the promotion landed before touching the host.** The single
thing that matters is that the promoted `deploy.sh` tracks `production`:

```bash
git fetch origin
git show origin/production:scripts/deploy.sh | grep '^BRANCH='
# MUST print:  BRANCH="production"
```

If it prints `BRANCH="main"`, stop — step 1 did not include the switch commit.
Continuing from here is what produces the silent-no-deploy state above.

**Step 3 — cut the host over.**

```bash
cd /var/www/highfive            # or /opt/highfive, wherever the live checkout is
git fetch origin
git checkout production
git reset --hard origin/production

# REBUILD — `git reset --hard` restores the SOURCE tree only. backend/dist,
# homepage/dist and node_modules stay at whatever this host last built, and no
# later timer tick will fix that: deploy.sh exits at
# `[ "$PREV_SHA" = "$REMOTE_SHA" ] && exit 0`, so once HEAD matches the remote
# it does nothing. Skip this and the host serves stale artifacts from
# source it no longer has — and every check below still passes.
HUSKY=0 npm ci
npm --prefix backend run build
( cd homepage && VITE_API_URL=https://highfive.schutera.com/api npm run build )
pm2 reload ecosystem.config.js --update-env

# verify services answer
curl -fsS http://127.0.0.1:3001/api/health
curl -fsS https://highfive.schutera.com/firmware.json
# and confirm the driver agrees with the checkout
grep '^BRANCH=' scripts/deploy.sh && git rev-parse --abbrev-ref HEAD
```

> You can skip the rebuild only if step 1 promoted the exact SHA this host was
> already serving. Since the "Cut a release" guidance above deliberately invites
> promoting a *chosen* commit rather than `origin/main`'s tip, assume you cannot.

After the cutover the deploy source is `origin/production`; nothing else
changes. Until step 3 happens the auto-deploy is paused and posts a single
Discord alert saying so (`scripts/deploy.sh`, branch-mismatch guard) — that
alert is the safety net for a half-finished cutover, which is precisely why it
must not be reverted away by doing step 3 first.

## Known gaps

Tracked gaps that this runbook accommodates rather than fixes:

- **ESP firmware traffic stays on HTTP.** Field modules ship with
  `http://highfive.schutera.com/upload` and `/new_module` baked into
  `ESP32-CAM/config.json`. The host-Nginx port-80 server block proxies
  `/upload`, `/new_module`, and `/heartbeat` to the appropriate
  internal services on plain HTTP so the existing fleet keeps working
  without reflashing. Migrating firmware to HTTPS would either require
  reflashing every deployed module or fronting `image-service` with a
  third TLS subdomain (e.g. `images.highfive.schutera.com`). Tracked as
  a follow-up; out of scope for this runbook.
- **Python services run Flask's dev server.** `image-service` and
  `duckdb-service` use the same `Dockerfile.dev` in prod that the dev
  compose uses; both invoke `python app.py` which boots Flask's
  single-threaded dev server. Acceptable at the current request volume
  but a known hardening target (gunicorn / waitress, non-root user,
  separate prod Dockerfile). Tracked as a follow-up.
- **`duckdb-service` is reachable only on loopback.** No public-internet
  binding by design — it is reached over the Compose-internal
  `highfive-network` bridge from peer services, and from host-Nginx via
  `127.0.0.1:8002` for the two ESP firmware paths. Per ADR-001 (DuckDB
  as sole writer), the public-internet surface is the backend API. Note
  that `expose:` in compose is purely cosmetic on a user-defined bridge
  network — what enforces internal-only is the `127.0.0.1:` prefix on
  the `ports:` mapping, not `expose:`.
- **Single shared TLS cert covers both subdomains.** The certbot step
  issues one SAN cert for `highfive.schutera.com` + `api.highfive.schutera.com`.
  The cert lineage on disk uses the first `-d` value as the directory
  name: `/etc/letsencrypt/live/highfive.schutera.com/`.
- **A pre-#228 image volume would have non-`.jpg` served-file gaps.**
  Since the 2026-08 audit (for #228), `GET /images/<name>` and
  `GET /snips/<name>` 404 any name not ending in `.jpg`
  (`image-service/app.py`'s `serve_image`/`serve_snip`); every upload is
  now stored with a forced `.jpg` extension regardless of what the
  client sent. Production currently has no data, so this has no live
  blast radius today — but a future restore from a pre-#228 backup, or a
  volume carrying uploads from before this fix, could contain
  legitimately-stored non-`.jpg` filenames (a hostile pre-fix upload, or
  an edge case the old allowlist let through) that would 404 after this
  change. No migration or backfill exists; if this ever matters, audit
  `IMAGE_STORE_PATH` for non-`.jpg` files before relying on this gap
  being empty.

## Troubleshooting

### `docker compose up` exits with `HIGHFIVE_API_KEY must be set...`

By design — the compose file rejects missing or empty secrets. Set the
keys in `.env.production` and re-run with
`--env-file .env.production`. See Step 3.

### Docker Build OOM (Exit 137)

Swap space is insufficient. Increase the swapfile to 8 GB:

```bash
sudo swapoff /swapfile
sudo dd if=/dev/zero of=/swapfile bs=1M count=8192
sudo mkswap /swapfile
sudo swapon /swapfile
free -h

docker compose -f docker-compose.prod.yml --env-file .env.production build --no-cache
```

### `duckdb-service` healthcheck never passes

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production logs duckdb-service
docker compose -f docker-compose.prod.yml exec duckdb-service \
    python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8000/health').read())"
```

If the volume is corrupt:
`docker compose -f docker-compose.prod.yml down && docker volume rm highfive_duckdb_data`,
then redeploy. **This destroys all stored data** — only do it on a
fresh deploy.

### Port 80, 443, 3001, 8000, or 8081 already in use

```bash
sudo netstat -tulpn | grep -E ':(80|443|3001|8000|8081)\b'
```

Common culprits: another web server on `:80`/`:443`, a leftover dev
backend on `:3001`. Stop the offender or rebind in
`docker-compose.prod.yml`.

## Updates & Redeployment

```bash
cd /opt/highfive
git pull origin production

docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# Verify all services came back healthy
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

The `duckdb_data` named volume persists across rebuilds — schema
migrations and seeded data are not lost. Schema migrations live in
`duckdb-service/db/schema.py`'s `init_db` and run on every container
start. Additive `ADD COLUMN` migrations are gated on
`PRAGMA table_info` so a healthy fresh boot is a clean no-op (no
swallowed exceptions in the duckdb stack); destructive changes
(DROP COLUMN, type changes on FK-referenced tables) use the
transactional table-rebuild pattern described in the callout below.

> **Back up `duckdb_data` before any deploy that ships a schema
> rewrite.** DuckDB v1.4 cannot ALTER a table referenced by a foreign
> key, so destructive schema changes (DROP COLUMN, type changes on
> FK-referenced tables) ship as **transactional table-rebuild
> migrations** that copy data through TEMP tables, drop the FK chain
> in dependency order, recreate each table, and restore data. The
> migration in `init_db` is wrapped in `BEGIN / COMMIT / ROLLBACK` and
> raises `RuntimeError` on failure so the container refuses to start
> rather than serving a half-migrated DB — but a manual backup means a
> recovery path that doesn't depend on the WAL.
>
> Run **Step 0** in [Backup & Restore](#backup--restore) below before
> pulling a schema-change deploy — it forces a `CHECKPOINT` before
> copying (a bare `cp` of the live file, without one, can miss WAL-only
> data), verifies the copy opens read-only, and moves it off-host. The
> weekly in-app retained backup (same section, "Retained backups") is
> not a substitute here — it runs on its own Sunday-03:00 schedule, not
> on-demand right before a risky deploy.
>
> Lessons learned from each migration shipped to date live in
> `docs/11-risks-and-technical-debt/README.md`. The current PR adds
> the [#69](https://github.com/schutera/highfive/issues/69) entry
> (drop `module_configs.status`); its regression test lives at
> `duckdb-service/tests/test_schema_migration.py`.

## Backup & Restore

Covers issue #232 (the weekly job used to hold the sole writer's lock for a
full gzip of the live DB and ship it only to Discord — retaining nothing,
and never touching `/data/images`). See
[ADR-031](../09-architecture-decisions/adr-031-backup-file-copy-not-export-database.md)
for why the retained artifact is a gzip'd file copy, not `EXPORT DATABASE`,
and [docker-compose.md → Backup retention](docker-compose.md#backup-retention-232--adr-031)
for the `BACKUP_DIR` / `BACKUP_KEEP` env vars. (For the PM2 path, adapt the
Docker-flavored commands below per
[production-runbook.md](production-runbook.md) and #242.)

**On the historical "~8 GB DB file" figure cited in
[chapter 11](../11-risks-and-technical-debt/README.md) and this issue:**
that incident was recorded against an earlier PM2-hosted deployment.
**As of 2026-08-22 the current `production` deployment (post
[ADR-030](../09-architecture-decisions/adr-030-production-as-gated-release-branch.md))
has no data yet** — confirmed directly rather than assumed. Treat 8 GB as
a capacity-planning reference for when data volume returns to that scale
(re-time the numbers below then), not a claim about today's file size.
Step 0 below is therefore documented and drilled on the **dev** stack
(see "Restore drill") rather than executed against live prod — there is
nothing there to back up yet. Run it for real before the first
`production` deploy that carries real data, and again before any future
schema-rewrite deploy per the callout above.

### Step 0 — manual backup before a risky prod change

DuckDB's own single-writer protection is a **file-level lock held only
while a connection is open** — it stops two connections from being
open read-write at the same instant, but `db/connection.py`'s
`get_conn()` opens and closes a connection **per call**, so the live
serving process spends most of its time with *no* connection open at
all. A `docker compose exec` process's own `CHECKPOINT` could slot into
one of those gaps and succeed cleanly. The actual danger is the plain
`shutil.copy2`/`cp` step right after: a raw file copy is not a DuckDB
connection, so DuckDB's lock does nothing to stop the live process from
opening its *own* connection and writing **while the copy is reading
the same bytes** — producing a torn file that its own sha256 would
still "verify" correctly, because the hash is computed on the copy
after the fact, not against the live source. **Stop the service
first** — this is a deliberate pre-migration action, not a routine
one, so a brief planned outage is the right tradeoff over a maybe-torn
backup:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production stop duckdb-service

# Confirm the stop actually took effect before touching the file — the
# safety argument above rests entirely on this, not on `run` vs `exec`
# (a `run --rm` container behaves identically whether the named service
# is stopped or still running; nothing about `run` itself is safer).
docker compose -f docker-compose.prod.yml --env-file .env.production ps duckdb-service
# -> must show no running container (or "exited") before proceeding.

docker compose -f docker-compose.prod.yml --env-file .env.production run --rm duckdb-service \
  python -c "import duckdb; c=duckdb.connect('/data/app.duckdb'); c.execute('CHECKPOINT'); c.close()"
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm duckdb-service \
  cp /data/app.duckdb /data/app.duckdb.bak.$(date -u +%Y%m%d)

# Verify the copy opens read-only before trusting it
docker compose -f docker-compose.prod.yml --env-file .env.production run --rm duckdb-service \
  python -c "import duckdb; c=duckdb.connect('/data/app.duckdb.bak.$(date -u +%Y%m%d)', read_only=True); print(c.execute('SELECT COUNT(*) FROM module_configs').fetchone())"

docker compose -f docker-compose.prod.yml --env-file .env.production start duckdb-service

# Then move the DB copy AND /data/images (captures, snips/, *.log.json
# sidecars) off-host — see "Off-host sync" below for a template unit.
```

Record the command output, file size, and wall-clock time actually taken in
this section once this has been run against real prod data.

### Retained backups (in-app, automatic — no operator action needed)

`duckdb-service` already runs a weekly retained backup on its own —
`services/backup.py`'s `run_backup()`, scheduled Sunday 03:00 **inside the
serving Flask process** (so it shares the real `db.connection.lock` with
every request handler; this is why it's safe to run without stopping the
service, unlike a manual on-demand run via Step 0's approach above). It
holds the lock
only for a `CHECKPOINT` + file copy — not the gzip — and aborts with a
Discord alert if free disk space is under 1.5× the live DB size before
even attempting the copy. Files land under `BACKUP_DIR` (default
`/data/backups`, inside the `duckdb_data` volume — the **same** volume as
the live DB, so a volume-level failure takes both out together, which is
exactly why off-host sync below is not optional) as
`highfive_backup_<UTC timestamp>.duckdb.gz` + a `.sha256` sidecar, rotated
to the newest `BACKUP_KEEP` (default `4`, floored at 1 so `BACKUP_KEEP=0`
can never delete the backup it just made). Discord gets a text-only
notification (size, lock-hold duration, hash, path) — never the file
itself.

There is deliberately no documented "trigger it manually against the live
container" command anywhere in this file: doing that via a separate
process has exactly the copy-races-a-live-writer problem explained in
Step 0 above. If an on-demand backup is needed outside the weekly
schedule — including the restore drill below, which triggers this same
`run_backup()` function directly rather than Step 0's raw
`duckdb.connect` + `CHECKPOINT` + `cp` (they're different commands for
different purposes: this one produces the exact retained/rotated/gzip'd
artifact the weekly job would, Step 0 is a one-off pre-migration
snapshot) — always stop the service first, never `exec` into the
running container.

**At prod scale**, both the checkpoint-and-copy lock hold and the restore
below are linear in DB file size — an 8 GB file (see the historical-figure
note above) would hold `db.connection.lock` for **minutes**, not the
milliseconds measured in the dev drill below, and that lock blocks every
route including `/heartbeat` and `/new_module` (the two paths host-nginx
proxies for the ESP fleet). Re-measure and record the real number here
once prod carries data at that scale, and consider whether the weekly
03:00 window needs to move if it collides with fleet activity.

### Off-host sync

Nothing off-host exists in this repo yet — the template below is a
starting point. It targets both `/data/backups` (the retained
`.duckdb.gz` files) and `/data/images` (captures, `snips/`,
`*.log.json` sidecars) from the same `duckdb_data` volume, syncing each
to its **own** destination subdirectory (a single `rsync` with two
trailing-slash sources would flatten both trees into one directory):

```bash
# One-time: provision an SSH key for the sync unit's user and trust it
# on the off-host target (skip if one already exists for this host).
ssh-keygen -t ed25519 -f /root/.ssh/highfive-offhost-sync -N ""
ssh-copy-id -i /root/.ssh/highfive-offhost-sync.pub your-offhost-user@your-offhost-host

# On the prod host — /etc/systemd/system/highfive-offhost-sync.service
sudo tee /etc/systemd/system/highfive-offhost-sync.service > /dev/null << 'EOF'
[Unit]
Description=Sync HighFive backups + images off-host

[Service]
Type=oneshot
# your-offhost-user@your-offhost-host is a placeholder — a second VPS, NAS,
# or any SSH-reachable target with enough disk. -z compresses on the wire;
# --delete is deliberately OMITTED so a bad local rotation can't propagate
# into a silent remote deletion. Two separate rsync calls (not one with
# both sources) so the destination mirrors /data's shape instead of
# flattening backups/ and images/ together. --exclude the in-flight
# markers (services/backup.py's _sweep_stale_tmp_files removes these
# locally after a crash, but a sync mid-write could still ship a partial
# file off-host before that sweep runs, and rsync exits non-zero — code
# 24, "some files vanished" — if a source file disappears mid-transfer,
# which would abort this oneshot unit's remaining ExecStart lines,
# including the heartbeat touch below).
ExecStart=/usr/bin/rsync -az --exclude='.*.duckdb.gz.tmp' --exclude='*.duckdb.gz.inprogress' \
  -e "ssh -i /root/.ssh/highfive-offhost-sync" \
  /var/lib/docker/volumes/highfive_duckdb_data/_data/backups/ \
  your-offhost-user@your-offhost-host:/srv/highfive-offhost-backup/backups/
ExecStart=/usr/bin/rsync -az -e "ssh -i /root/.ssh/highfive-offhost-sync" \
  /var/lib/docker/volumes/highfive_duckdb_data/_data/images/ \
  your-offhost-user@your-offhost-host:/srv/highfive-offhost-backup/images/
# Heartbeat file the app checks (services/backup.py's
# _has_fresh_offhost_sync) so the in-app "local-only" warning reflects
# whether this unit actually ran recently, not just whether it was ever
# set up once.
ExecStart=/usr/bin/touch /var/lib/docker/volumes/highfive_duckdb_data/_data/backups/.offhost_sync_ok
EOF

sudo tee /etc/systemd/system/highfive-offhost-sync.timer > /dev/null << 'EOF'
[Unit]
Description=Run HighFive off-host sync daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now highfive-offhost-sync.timer
sudo systemctl start highfive-offhost-sync.service   # first run, on demand
sudo systemctl status highfive-offhost-sync.service
```

The heartbeat file is read from inside the container at
`BACKUP_DIR/.offhost_sync_ok` (same file, since `BACKUP_DIR` is a path
into this same named volume) — no separate config flag to remember to
flip, and the warning naturally comes back if the timer stops running.

### Restore drill

Performed 2026-08-21 on the **dev** stack (`docker compose`, not prod —
prod has no data yet, see the status note above), using the same
stop-first pattern as Step 0 throughout — including to *produce* the
backup, not just to restore it, so this drill exercises exactly the
procedure documented above rather than a live-container shortcut. Steps
0 and 4 below are read-only `COUNT` verification queries against the
**live, healthy** container (not a data-modifying operation, and not
concurrent with any backup/restore step) — `exec` is fine there. A
`read_only=True` connect can occasionally fail with a transient lock
error if it lands in the same instant the serving process itself holds
a connection open; that's a "retry the query," not a correctness issue,
since nothing here writes. Re-run 2026-08-21 to add step 3's `sha256sum
-c` gate — an earlier pass restored straight from the `.gz` without ever
reading the `.sha256` sidecar the job produces, which meant the drill
never actually exercised the one integrity control ADR-031 lists as a
reason to keep it. Steps and measured timing:

```bash
# 0) Seeded dev stack, 7 modules / 52 nests / 356 daily_progress rows.
docker compose exec duckdb-service python -c "
import duckdb
c = duckdb.connect('/data/app.duckdb', read_only=True)
print(c.execute('SELECT COUNT(*) FROM module_configs').fetchone())
print(c.execute('SELECT COUNT(*) FROM nest_data').fetchone())
print(c.execute('SELECT COUNT(*) FROM daily_progress').fetchone())
"
# -> (7,) (52,) (356,)

# 1) Produce a backup — stopped first, matching Step 0 (not docker compose
#    exec against the live container; `run --rm` on a stopped service is
#    the safe equivalent of the weekly in-process schedule for this drill).
docker compose stop duckdb-service
docker compose run --rm duckdb-service python -c "
import time
from services.backup import run_backup
start = time.monotonic()
run_backup()
print(f'wall clock: {time.monotonic()-start:.2f}s')
"
# -> lock held 0.07s; wall clock 0.97s (checkpoint+copy+gzip+sha256+rotate+notify)
# -> highfive_backup_2026-08-21_235457.duckdb.gz, ~0.7 MB for a ~110 MB DB file
docker compose start duckdb-service

# 2) Simulate the failure: stop the service again.
docker compose stop duckdb-service

# 3) Verify the sha256 sidecar, THEN restore — a throwaway container on
#    the same named volume (no running duckdb-service container needed).
#    The gunzip step is deliberately gated on the sha256sum exiting 0.
docker run --rm -v highfive_duckdb_data:/data alpine sh -c \
  "cd /data/backups && sha256sum -c highfive_backup_2026-08-21_235457.duckdb.gz.sha256 || exit 1; \
   cd /data && gunzip -c backups/highfive_backup_2026-08-21_235457.duckdb.gz > app.duckdb.restored && mv app.duckdb.restored app.duckdb"
# -> highfive_backup_2026-08-21_235457.duckdb.gz: OK

# 4) Bring the service back and verify.
docker compose start duckdb-service
docker compose exec duckdb-service python -c "
import duckdb
c = duckdb.connect('/data/app.duckdb', read_only=True)
print(c.execute('SELECT COUNT(*) FROM module_configs').fetchone())
print(c.execute('SELECT COUNT(*) FROM nest_data').fetchone())
print(c.execute('SELECT COUNT(*) FROM daily_progress').fetchone())
"
# -> (7,) (52,) (356,) — identical to step 0's counts. curl .../health -> {"ok": true}.
```

## Stop / restart

```bash
# Restart one service
docker compose -f docker-compose.prod.yml --env-file .env.production restart backend

# Stop everything (volumes preserved)
docker compose -f docker-compose.prod.yml --env-file .env.production stop

# Tear down (volumes preserved)
docker compose -f docker-compose.prod.yml --env-file .env.production down

# DESTRUCTIVE: tear down and delete the DuckDB volume
docker compose -f docker-compose.prod.yml --env-file .env.production down -v
```

## Access

- Frontend: `https://highfive.schutera.com/`
- API: `https://api.highfive.schutera.com/api/modules`
- API health: `https://api.highfive.schutera.com/api/health`
- ESP firmware (HTTP-only via host-Nginx port-80 vhost — see "Known gaps"):
  - upload: `http://highfive.schutera.com/upload`
  - register: `http://highfive.schutera.com/new_module`
  - heartbeat: `http://highfive.schutera.com/heartbeat`

## See also

- [`../api-reference.md`](../api-reference.md) — full HTTP API reference
- [`../08-crosscutting-concepts/auth.md`](../08-crosscutting-concepts/auth.md) — API key handling
- [`../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md`](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md) — why duckdb-service is internal-only
