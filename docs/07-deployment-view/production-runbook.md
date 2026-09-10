# Production Runbook (Nginx + PM2) — the path live in production

> ✅ **This is the path the live host runs today** — see
> [what-is-live.md](what-is-live.md) for the evidence and a 30-second
> verification. The Docker Compose topology
> ([production-deployment.md](production-deployment.md)) is the **supported
> target, not yet deployed**.
>
> **Scope.** This runbook covers the Node backend (PM2), the static
> frontend (Nginx-served), the ESP/OTA Nginx ingress
> ([section 5b](#5b-espota-ingress-both-ports)), and the environment the two
> Python services need. It does **not** cover the _initial_ bare-metal
> provisioning of `image-service` and `duckdb-service` as pm2 apps — the
> template entries are in [section 6](#6-create-pm2-ecosystem-config-on-server);
> registering them on a host is the operator's step — nor the off-host
> backup sync for their data ([Backup & Restore](#backup--restore)).
> Ongoing **redeploys** of those services (dependency install + reload) are
> covered under [Updates & Redeployment](#updates--redeployment). The
> `/new_module` and `/heartbeat` rate/body-size limits in
> [`deploy/nginx/highfive-ingest.conf`](../../deploy/nginx/highfive-ingest.conf)
> (2026-08 audit, for #229) are referenced by the section 5b blocks below
> but have **not** been applied to the live host yet — that is an
> operational follow-up (#229), not something a doc change performs.

## Overview

This runbook covers deploying HighFive to production at
`highfive.schutera.com` using Nginx as the public-facing reverse proxy
and PM2 to supervise the Node backend on bare metal — no Docker.

For the Docker-Compose production deploy — the supported target, not yet
deployed — see [production-deployment.md](production-deployment.md). For
dev-laptop setup, see [docker-compose.md](docker-compose.md).

## Prerequisites

- Linux server (Ubuntu 22.04+ recommended)
- Node.js 22.12+ installed — matches `engines.node` in `backend/package.json` and `homepage/package.json`; Ubuntu 22.04's default-apt `nodejs` is too old, use [NodeSource](https://github.com/nodesource/distributions) or `nvm install 22`
- Python **3.10** floor for the two Python services (run on the system `python3` under PM2) — the single source of truth is `/.python-version` (=`3.10`); CI tests the 3.10–3.14 range and the container path pins `python:3.10-slim`, so host and container agree (ADR-029, #197). Code stays 3.10-compatible (`datetime.now(timezone.utc)`, never the 3.11-only `datetime.UTC` that crashed deploy in #180)
- Nginx installed
- PM2 installed globally: `npm install -g pm2`
- Git access to the repository
- Domain with DNS pointed to your server
- SSH access to the server

## Initial Server Setup

### 1. Clone the Production Branch

> **If this fails with `Permission denied (publickey)`, do NOT guess the
> username.** Guessing trips the host's brute-force protection and bans your
> IP — port 22 goes dead while HTTPS keeps serving, which reads as an outage.
> See [troubleshooting.md → Production host access (SSH)](../troubleshooting.md#production-host-access-ssh).

```bash
# SSH into your server
ssh username@your-server-ip

# Create deployment directory
sudo mkdir -p /var/www/highfive
sudo chown $USER:$USER /var/www/highfive
cd /var/www/highfive

# Clone the production branch
git clone -b production https://github.com/schutera/highfive.git .
```

### 2. Install Dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd ../homepage
npm install
cd ..
```

### 3. Create Environment File (on server)

```bash
# Create .env file with production environment variables
cat > .env << EOF
NODE_ENV=production
PORT=3001
HIGHFIVE_API_KEY=your_secure_production_key_here_change_this
EOF

# ⚠️ IMPORTANT: Generate a secure API key!
# Example using openssl:
# openssl rand -base64 32

# Then update .env with the generated key:
# HIGHFIVE_API_KEY=<generated-key-here>
```

### 4. Get SSL Certificate

```bash
sudo apt-get update
sudo apt-get install certbot python3-certbot-nginx

# Get certificate for your domain
sudo certbot certonly --standalone -d highfive.schutera.com
```

### 5. Create Nginx Configuration (on server)

First install the rate-limit zones for the credential-free `/new_module`
and `/heartbeat` routes (2026-08 audit, for #229 — see
[`deploy/nginx/highfive-ingest.conf`](../../deploy/nginx/highfive-ingest.conf)
for the sizing rationale). `limit_req_zone` must live in the `http {}`
context, so the file goes into `conf.d`, not the site file:

```bash
sudo cp deploy/nginx/highfive-ingest.conf /etc/nginx/conf.d/highfive-ingest.conf
```

Create `/etc/nginx/sites-available/highfive`:

```bash
sudo cat > /etc/nginx/sites-available/highfive << 'EOF'
# Port 80 - ESP ingress for pre-#79 stragglers (their stored SPIFFS URLs
# are still http:// until the first post-#79 boot rewrites them - ADR-010)
# and plain-HTTP LAN-dev builds; the current fleet speaks TLS (https) and
# lands on the matching :443 locations in the block below instead. The
# exact-match locations must stay ABOVE the catch-all, or stray ESP
# requests land on the 301.
server {
    listen 80;
    server_name highfive.schutera.com;

    location = /upload {
        proxy_pass http://127.0.0.1:4444/upload;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;
        client_max_body_size 10M;
        proxy_read_timeout 60s;
    }

    # limit_req + client_max_body_size: zones from highfive-ingest.conf
    # (installed above) - these two routes had NO nginx-level bound
    # before the 2026-08 audit (#229).
    location = /new_module {
        proxy_pass http://127.0.0.1:8000/new_module;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_new_module burst=20 nodelay;
        client_max_body_size 8k;
    }

    location = /heartbeat {
        proxy_pass http://127.0.0.1:8000/heartbeat;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_heartbeat burst=60 nodelay;
        client_max_body_size 8k;
    }

    # OTA artifacts served straight from the live dist - scripts/deploy.sh's
    # publish_firmware() lands them in /var/www/highfive/homepage/dist/.
    location = /firmware.json {
        alias /var/www/highfive/homepage/dist/firmware.json;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    location = /firmware.app.bin {
        alias /var/www/highfive/homepage/dist/firmware.app.bin;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # Everything else (browsers) -> HTTPS.
    location / {
        return 301 https://$server_name$request_uri;
    }
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    server_name highfive.schutera.com;

    # SSL certificates
    ssl_certificate /etc/letsencrypt/live/highfive.schutera.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/highfive.schutera.com/privkey.pem;

    # SSL configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # ESP/OTA ingress (added for #242). Since #79 the fleet's URLs are
    # https:// (ADR-010), so it lands HERE, not on the port-80 block
    # above - that one only serves pre-#79 stragglers and LAN-dev builds.
    # Exact-match locations beat the SPA catch-all below; without them a
    # POST /upload falls through to index.html (200 HTML the firmware
    # cannot parse) and every OTA check 404s.
    location = /upload {
        proxy_pass http://127.0.0.1:4444/upload;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering off;
        client_max_body_size 10M;
        proxy_read_timeout 60s;
    }

    # limit_req + client_max_body_size: zones from highfive-ingest.conf
    # (installed in step 5).
    location = /new_module {
        proxy_pass http://127.0.0.1:8000/new_module;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_new_module burst=20 nodelay;
        client_max_body_size 8k;
    }

    location = /heartbeat {
        proxy_pass http://127.0.0.1:8000/heartbeat;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        limit_req zone=hf_heartbeat burst=60 nodelay;
        client_max_body_size 8k;
    }

    # OTA artifacts from the live dist (deploy.sh's publish_firmware()).
    location = /firmware.json {
        alias /var/www/highfive/homepage/dist/firmware.json;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    location = /firmware.app.bin {
        alias /var/www/highfive/homepage/dist/firmware.app.bin;
        add_header Cache-Control "no-cache, must-revalidate";
    }

    # Frontend (React SPA)
    location / {
        root /var/www/highfive/homepage/dist;
        try_files $uri $uri/ /index.html;

        location = /index.html {
            add_header Cache-Control "no-cache, no-store, must-revalidate";
        }

        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }

    # Backend API.
    # NOTE: a host built from this template serves the API under the main
    # domain's /api/. The live host deviates: its main-domain /api/ falls
    # into the SPA's location / below, and the browser API is served from
    # the api.highfive.schutera.com subdomain behind a Caddy edge — see
    # what-is-live.md ("Nginx vhosts" row).
    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_redirect off;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Deny access to sensitive files
    location ~ /\.git {
        deny all;
    }
    location ~ /\.env {
        deny all;
    }
}
EOF
```

Enable the site:

```bash
sudo ln -s /etc/nginx/sites-available/highfive /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 5b. ESP/OTA Ingress (both ports)

Why ESP ingress at all, and why on **both** ports: since #79 the
firmware's production URLs are `https://` (ADR-010) — registration,
upload, heartbeat and the OTA manifest/binary fetch all verify the
origin against the embedded ISRG Root X1 — so the **TLS vhost carries
the fleet** (the `location =` blocks added to the `:443` server above).
The **port-80** blocks remain for pre-#79 stragglers (their stored
`http://` URLs are only rewritten on the first post-#79 boot, ADR-010)
and for plain-HTTP LAN-dev builds. Two failure modes if the exact-match
locations are missing or outranked by a catch-all: a blanket `301` (the
device logs `[OTA] manifest HTTP 301` and skips), or the SPA `try_files`
catch-all answering `200 index.html` to a POST the firmware cannot
parse — the worse one, because it is silent (retry/circuit-breaker
churn, no log line on the device).

**Port-mirror footgun.** On this PM2 path the Flask services listen on
their native ports — `image-service` on `:4444`, `duckdb-service` on
`:8000` — the *opposite* of the Docker path's host-port mapping (image
`:8000`, duckdb `:8002`). Copying a `proxy_pass` port across the two
topologies points at the wrong service;
[what-is-live.md](what-is-live.md) carries the full matrix.

**Retrofitting an already-provisioned host** (the live vhost predates
these blocks): add the five `location =` blocks to **both** the
`listen 443` and `listen 80` server blocks, each *above* that block's
catch-all, install the `conf.d` zones file shown in step 5, then

```bash
sudo nginx -t && sudo systemctl reload nginx
```

**Live-host divergence (verified 2026-09-06, probe-only — the host's
`/etc/nginx` is not readable):** `/upload`, `/new_module` and
`/heartbeat` answer on **both** ports (405 to a probe GET = routed to
the Flask services), so the live vhost already carries the ingress on
both; but `/firmware.json` and `/firmware.app.bin` **404 on both** —
the artifacts are missing from the live `homepage/dist` ([#275](https://github.com/schutera/highfive/issues/275)). Until
#275 lands, the setup wizard cannot flash a new module from production
and no `SEQUENCE`-bumped OTA release can reach the fleet — including
the #231 fix. The live vhost also diverges from this template in ways
a rebuild from it would not reproduce: a Caddy edge sits in front
(responses carry `Server: Caddy`), and the browser API is reached on
the `api.highfive.schutera.com` subdomain — the main domain's `/api/`
falls into the SPA (both confirmed by probe; see
[what-is-live.md](what-is-live.md)).

**Smoke test** (a `301` means the exact-match blocks are missing or
outranked; on a host that has already shipped firmware a `404` on the
firmware pair is an **outage** — #275 — not an expectation):

```bash
curl -sSI https://highfive.schutera.com/upload          | head -1   # 405 = TLS ingress routed to image-service (the fleet's path since #79)
curl -sSI https://highfive.schutera.com/heartbeat       | head -1   # 405 = TLS ingress routed to duckdb-service
curl -sSI  http://highfive.schutera.com/upload          | head -1   # 405 = pre-#79/HTTP ingress still routed (not 301)
curl -sSI https://highfive.schutera.com/firmware.json   | head -1   # 200 = published; 404 on a live-fleet host = missing from the origin (#275)
curl -sSI https://highfive.schutera.com/firmware.app.bin | head -1  # 200 = published; 404 on a live-fleet host = missing from the origin (#275)
```

### 6. Create PM2 Ecosystem Config (on server)

Create `ecosystem.config.js` in `/var/www/highfive/`:

```bash
cat > /var/www/highfive/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'highfive-api',
      script: './backend/dist/server.js',
      // cluster gives one process per core; the rate limiters, the ADR-023
      // log ring, the SSE tail and the read-model cache are per-process, so
      // an N-core host runs N independent copies (tracked in #248).
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        // Both service URLs MUST be set here, pointing at wherever YOU ran
        // duckdb-service and image-service on this host (this runbook does
        // not deploy them — see the banner at the top). The values below
        // assume each runs natively on its own listen port. Neither backend
        // fallback works off-compose: DUCKDB_SERVICE_URL falls back to
        // 127.0.0.1:8002, which is the *docker host-port mapping* and has
        // nothing listening behind it here, and IMAGE_SERVICE_URL falls back
        // to a Docker service name that does not resolve at all. Omitting
        // IMAGE_SERVICE_URL is a documented outage — see chapter 11, "Admin
        // 'failed to load images'". The backend logs a [startup] warning
        // when DUCKDB_SERVICE_URL falls back; check the boot lines after
        // every deploy, and remember `pm2 restart` ignores edits to this
        // block unless you pass --update-env.
        DUCKDB_SERVICE_URL: 'http://127.0.0.1:8000',
        IMAGE_SERVICE_URL: 'http://127.0.0.1:4444'
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      max_memory_restart: '500M',
      watch: false,
      ignore_watch: ['node_modules', 'logs', 'dist']
    }
  ]
};
EOF
```

#### Required environment for the two Python services

This runbook does not provision `duckdb-service` / `image-service` (see the
banner), but wherever you _did_ define their pm2 apps, these variables are
**not optional** — two security controls are silent no-ops without them, and
nothing fails loudly to tell you:

| Variable                          | Why it must be set                                                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HIGHFIVE_ENV=production`         | The boot guard in `services/prod_guard.py` refuses to start when `HIGHFIVE_API_KEY` is unset, blank, or the public dev fallback — but **only when this marker is present**. There is no `NODE_ENV` for Python and modern Flask dropped `FLASK_ENV`. Omit it and both services will happily serve their admin `/logs` gate behind `hf_dev_key_2026`. |
| `HIGHFIVE_API_KEY`                | Must match the backend's, for the #171 server-logs proxy.                                                                                                                                                                                                     |
| `DISCORD_WEBHOOK_URL`             | The baked-in default was removed in the 2026-07 audit (#201). Unset means `send_discord_message` degrades to a `print()` nobody reads — which silently disables the **ADR-005 silence watcher's** module-down and recovery alerts, i.e. the primary field-failure signal.                                                                     |
| `LOG_DIR`                         | Distinct per service so the two don't collide on one file (ADR-023). On this bare-metal path use a host path such as `/var/www/highfive/logs/duckdb` and `.../logs/image` — **not** `/data`, which is the Docker named-volume mount point and does not exist here.                                                                                                                                                |

**Where the values come from matters.** Neither Python service loads `dotenv`
(the backend does, via `import 'dotenv/config'` in `server.ts`), so they only
see what pm2 hands them. And `process.env.X` inside `ecosystem.config.js` is
evaluated by the **pm2 CLI**, whose environment does _not_ include
`/var/www/highfive/.env` — writing `HIGHFIVE_API_KEY: process.env.HIGHFIVE_API_KEY`
therefore yields `undefined`, the boot guard raises, and both services enter a
pm2 autorestart crash-loop whose only trace is in `pm2 logs`. Load the file
explicitly at the top of the ecosystem config instead:

```js
// /var/www/highfive/ecosystem.config.js — FIRST LINE, before module.exports.
// Reads the same secret file the backend already uses (created in step 3).
// Add DISCORD_WEBHOOK_URL to that .env as well; step 3 only creates
// NODE_ENV / PORT / HIGHFIVE_API_KEY.
require('dotenv').config({ path: '/var/www/highfive/.env' });
```

```js
// …then add these to `apps: [ … ]`. Adjust script/cwd to match how these
// services were actually installed on this host.
{
  name: 'duckdb-service',
  script: 'app.py',
  interpreter: 'python3',      // MUST be the python3 deploy.sh pip-installs into
  cwd: '/var/www/highfive/duckdb-service',
  env: {
    HIGHFIVE_ENV: 'production',
    HIGHFIVE_API_KEY: process.env.HIGHFIVE_API_KEY,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    LOG_DIR: '/var/www/highfive/logs/duckdb'   // NOT /data — that is the Docker volume path
  }
},
{
  name: 'image-service',
  script: 'app.py',
  interpreter: 'python3',
  cwd: '/var/www/highfive/image-service',
  env: {
    HIGHFIVE_ENV: 'production',
    HIGHFIVE_API_KEY: process.env.HIGHFIVE_API_KEY,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    LOG_DIR: '/var/www/highfive/logs/image'
  }
}
```

**Applying an edit to this file is not `pm2 restart <name>`.** `--update-env`
on a process _name_ refreshes the environment from the invoking shell; it does
**not** re-read `ecosystem.config.js`. Target the file:

```bash
cd /var/www/highfive
pm2 reload ecosystem.config.js --update-env     # re-reads the file
pm2 env $(pm2 id duckdb-service | tr -d '[]') | grep -E "HIGHFIVE_ENV|DISCORD_WEBHOOK_URL"
pm2 env $(pm2 id image-service  | tr -d '[]') | grep -E "HIGHFIVE_ENV|DISCORD_WEBHOOK_URL"
```

**And mind the auto-deploy.** `scripts/deploy.sh`'s `reload_services` runs
`pm2 reload <name> --update-env` on every deploy that touches a service, from a
shell whose environment is the systemd unit plus `.deploy.env` — so whatever is
exported there wins over what you set here. Keep `HIGHFIVE_ENV`,
`HIGHFIVE_API_KEY` and `DISCORD_WEBHOOK_URL` in **`.deploy.env` as well**
(see `.deploy.env.example`), or the next automatic tick can quietly strip the
values you just set.

The guard is deliberately opt-in rather than default-on, matching the backend's
`NODE_ENV=development` off-ramp: an explicit operator choice, not a silent
default. That is exactly why it has to be written down here.

### 7. Build and Start Application

```bash
cd /var/www/highfive

# Build backend
cd backend
npm run build
cd ..

# Build frontend with API URL
cd homepage
# The URL above matches this runbook's section-5 vhost, which proxies the
# main domain's /api/ to :3001. The live host diverges: its bundle points
# at https://api.highfive.schutera.com/api (main-domain /api/ falls into
# the SPA there) — see what-is-live.md.
VITE_API_URL=https://highfive.schutera.com/api npm run build
cd ..

# Create logs directory
mkdir -p logs

# Start backend with PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## Updates & Redeployment

The `production` branch is the **gated release branch** (#152): `main` is the
integration line, and a release is a fast-forward of `production` onto a chosen
`main` commit — `git push origin <main-sha>:production` from a maintainer's
clone. The host only ever **pulls** `production`.

> The host normally self-deploys via [`scripts/deploy.sh`](../../scripts/deploy.sh)
> (auto-deploy driver — pulls `production`, installs deps, rebuilds only what changed,
> reloads the affected pm2 apps, health-checks, rolls back on failure; the
> `highfive-deploy.timer` may be inactive). The manual steps below are a
> **simplified hand-deploy**, not a faithful replay — use them for a recovery.
> They differ from the automated path in three ways that matter:
>
> - **The manual homepage build passes `VITE_API_URL` explicitly; `deploy.sh`
>   does not.** The automated build is a bare `npx vite build`, so it depends on
>   a gitignored `homepage/.env.production` existing **on the host** — otherwise
>   `homepage/src/services/api.ts` falls back to `http://localhost:3002/api` and
>   ships a bundle pointing at localhost. `health_ok "$HEALTH_HOMEPAGE"` only
>   checks that the HTML loads, so it cannot detect this. Verify the host file
>   exists before relying on an automated homepage deploy.
> - **`deploy.sh` stages the homepage to `dist.new` and swaps**; the manual step
>   builds straight into the live `dist`, so the site is briefly half-built.
> - **The manual path has no rollback.**
>
> **Caveat:** a rollback restores the git tree and Node build artifacts, and
> reinstalls `node_modules` from the restored lockfile — but a `pip install`
> that _upgraded_ a shared dependency (e.g. `numpy` → 2.x) is **not** reverted;
> pip upgrades are forward-only across a rollback.
>
> When the automated deploy's pip step fails it logs a WARN, continues, and
> sends a **"Deploy DEGRADED"** notification instead of "Deploy OK". The health
> checks deliberately do **not** gate this: `image-service` imports its
> hole-detection deps under a `try/except` and `/health` is a pure liveness
> probe, so a missing optional wheel leaves health green while detection is
> silently dead. **pip's own output is appended to `logs/auto-deploy.log`**, so
> the actual reason — usually `ERROR: No matching distribution found` for a
> wheel that doesn't exist on this interpreter — is in that file next to the
> WARN line:
>
> ```bash
> grep -n -B60 "pip install had failures" /var/www/highfive/logs/auto-deploy.log | tail -40
> ```

The live PM2 stack is **three** apps, not just the backend: `highfive-api`
(Node, cluster), plus `duckdb-service` and `image-service` (Python, run on the
**system `python3` — no venv**, so they share one `site-packages`; keep the
`requests` pin identical in both `requirements.txt` files). A fourth moving
part, the Nginx-served `homepage/dist`, is static files rather than a pm2 app.

```bash
cd /var/www/highfive
git pull --ff-only origin production   # the gated release branch (#152), NOT main

# 1) Node deps — npm WORKSPACES monorepo, so install from the ROOT. A new
#    backend/homepage dep lands in the ROOT package-lock.json; a per-package
#    `npm --prefix <pkg> ci` misses it (that broke a deploy on
#    rotating-file-stream, #178). Safe to skip if no package*.json changed.
npm ci

# 2) Python deps — install into the SAME system python3 pm2 runs the services
#    with (no venv). Native deps whose wheel windows can't span the 3.10–3.14 CI
#    matrix are floated to >= bounds (numpy>=2.0.0, onnxruntime>=1.23.2,
#    pydantic>=2.12.5), so pip resolves a per-interpreter wheel — on this 3.10
#    host that's onnxruntime 1.23.2 / numpy 2.x (ADR-029). image-service BOOTS
#    without the hole-detection deps (detection degrades to a no-op, ADR-027),
#    which is why the pip step is non-fatal in scripts/deploy.sh.
python3 -m pip install -r duckdb-service/requirements.txt
python3 -m pip install -r image-service/requirements.txt

# 3) Build the Node side (contracts is source-only — no build step)
npm --prefix backend run build
# VITE_API_URL above matches a host built from this runbook's section-5
# vhost; the live host's bundle points at
# https://api.highfive.schutera.com/api (see what-is-live.md).
( cd homepage && VITE_API_URL=https://highfive.schutera.com/api npm run build )

# 4) Reload (zero-downtime for the api cluster) and health-check.
#    NOTE: `duckdb-service` and `image-service` must already exist as pm2 apps.
#    The ecosystem.config.js template in section 6 above defines ONLY
#    highfive-api — provisioning the two Python services is out of this
#    runbook's scope (see the banner at the top). If they were never
#    registered, pm2 reports "process or namespace not found" for them and the
#    two curls below connection-refuse. `pm2 list` tells you what exists.
pm2 reload highfive-api duckdb-service image-service
curl -fsS http://127.0.0.1:3001/api/health     # backend
curl -fsS http://127.0.0.1:8000/health         # duckdb-service
curl -fsS http://127.0.0.1:4444/health         # image-service
curl -fsS -o /dev/null https://highfive.schutera.com/ && echo "homepage ok"
```

**Python 3.10 floor (not a pin).** The host's `python3` is 3.10, so the services
must stay 3.10-compatible (no `from datetime import UTC`, which is 3.11+). The CI
matrix runs them across **3.10–3.14**, so native deps whose wheel windows can't
span that range are floated to `>=` lower bounds rather than `==`-pinned —
`numpy>=2.0.0`, `onnxruntime>=1.23.2` (image-service) and `pydantic>=2.12.5` (both
services). pip then resolves the newest interpreter-compatible wheel per host: on
this 3.10 box that's `onnxruntime` 1.23.2 (its highest cp310 wheel) and `numpy`
2.x. Rationale and trade-offs (prod moves to numpy 2.x; looser reproducibility on
the floated deps) are in
[ADR-029](../09-architecture-decisions/adr-029-python-version-matrix-floated-pins.md).
All AI/ML inference is server-side — the ESP runs no models
([ADR-028](../09-architecture-decisions/adr-028-ml-inference-server-side-only.md)).

## Backup & Restore

Full procedure lives in
[production-deployment.md → Backup & Restore](production-deployment.md#backup--restore)
(the Docker path — the supported target; this PM2 path is the one live
today, see [what-is-live.md](what-is-live.md)) — Step 0 (manual pre-migration backup, stop-first
so it's safe), the automatic weekly retained backup (`services/backup.py`,
issue #232,
[ADR-031](../09-architecture-decisions/adr-031-backup-file-copy-not-export-database.md)),
the off-host sync template, and the restore drill actually performed (dev
stack, row counts verified identical pre/post) all live there since every
command in that procedure is Docker-flavored. On this PM2 path, adapt: swap
`docker compose ... exec/run --rm duckdb-service <cmd>` for
`pm2 stop/start duckdb-service` plus running `<cmd>` directly against the
host's `python3` (see [#242](https://github.com/schutera/highfive/issues/242)
for which deployment path is actually live), and the `duckdb_data`-volume
paths (`/var/lib/docker/volumes/highfive_duckdb_data/_data/...`) for whatever
host path this runbook's PM2 services were configured to use instead
(`LOG_DIR` above is the analogous per-service override to look at).

## Verification

### Check Backend is Running

```bash
pm2 status
pm2 logs highfive-api
```

### Test API

```bash
curl https://highfive.schutera.com/api/modules
# On the live host use https://api.highfive.schutera.com/api/modules
# instead - there the main domain's /api/ falls into the SPA and answers
# index.html (2026-09-06 probe); on a fresh host built from section 5
# the main-domain /api/ works, because that vhost proxies it to :3001.
```

### Check Frontend

Visit `https://highfive.schutera.com` in a browser.

## Monitoring

### View Logs

```bash
# Backend logs
pm2 logs highfive-api

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Monitor Resources

```bash
pm2 monit
```

## Troubleshooting

### Port Already in Use

```bash
lsof -i :3001
kill -9 <PID>
```

### SSL Certificate Renewal

```bash
sudo certbot renew --dry-run
sudo certbot renew
sudo systemctl restart nginx
```

### Clear PM2 and Restart

```bash
pm2 delete all
pm2 start ecosystem.config.js
pm2 save
```

## Environment Configuration

The source of truth per variable is the
[Environment variable matrix](what-is-live.md#environment-variable-matrix) —
read that first. In short:

- **Live PM2 host** — values come from the gitignored
  `/var/www/highfive/.env` (backend, via `dotenv`),
  `/var/www/highfive/.deploy.env` (sourced by `scripts/deploy.sh`, exported
  into every `pm2 reload --update-env`) and the `env:` blocks in
  `ecosystem.config.js`.
- **Docker target** — values come from `.env.production`
  (`docker compose --env-file`); the tracked `.env.production.example`
  holds the two secrets the stack fail-fasts on (plus optional
  `BACKUP_DIR`/`BACKUP_KEEP` overrides). `NODE_ENV`, `PORT` and
  `VITE_API_URL` are fixed in `docker-compose.prod.yml` itself, not in that
  file.
- The tracked `.env.example` (generic production values: `NODE_ENV`,
  `PORT`, and `VITE_API_URL` — with the mandatory `/api` suffix) and
  `.env.production.example` are templates only. Host-local env files are
  gitignored and must never be committed.

## Rollback

If something breaks:

```bash
cd /var/www/highfive

# Revert to previous commit
git revert HEAD
git push origin production

# Redeploy as shown in Updates section above
```

## API Key Management

### Generating a Secure API Key

```bash
# Use OpenSSL to generate a 32-byte random key
openssl rand -base64 32

# Example output:
# a7K9mL2pQ8wX5yZ1nB3vC6dE8fG0hI2jK4lM6nO8pQ0rS
```

### Setting API Key in Production

#### Option 1: Docker (the other supported target — not the live path)

The live host runs bare-metal PM2 (Option 2) — see
[what-is-live.md](what-is-live.md). To deploy the Docker target instead:

```bash
# Create or edit .env.production in project root
HIGHFIVE_API_KEY=your_generated_key_here   # the only secret (#142)

# Deploy
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

#### Option 2: Using PM2 (the live path)

```bash
# In /var/www/highfive/.env
HIGHFIVE_API_KEY=your_generated_key_here

# Backend will read from .env automatically.
# (On the live host the app is actually started via ecosystem.config.js —
# `pm2 start ecosystem.config.js` — which names the same app `highfive-api`.)
pm2 start backend/dist/server.js --name "highfive-api"
```

#### Option 3: Environment variables (systemd)

```bash
# Edit /etc/systemd/system/highfive.service
[Service]
Environment="HIGHFIVE_API_KEY=your_generated_key_here"
```

### Frontend Configuration

The frontend bundle carries **no** secret (#142 / ADR-019) — only the API
base URL is baked in. The homepage Dockerfile requires the **repo root** as
build context (so npm workspaces resolve `@highfive/contracts`), and
`VITE_API_URL` must include the `/api` suffix (`homepage/src/services/api.ts`'s
`ApiService` appends resource paths directly to it):

```bash
# From the repo root (NOT from ./homepage - the workspace wouldn't resolve)
docker build \
  -f homepage/Dockerfile \
  --build-arg VITE_API_URL=https://api.highfive.schutera.com/api \
  -t highfive-frontend \
  .
```

## Security Notes

- Keep `.env` file on server only (add to `.gitignore`)
- Keep `ecosystem.config.js` on server only for production
- Nginx config with SSL is server-specific
- Regularly update Node.js dependencies: `npm audit fix`
- Monitor PM2 logs for errors
- Use strong SSL certificates from Let's Encrypt
