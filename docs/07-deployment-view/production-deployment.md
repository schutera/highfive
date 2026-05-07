# Production Deployment (Docker Compose + host-Nginx)

Deploy HiveHive to production from the `production` branch using
`docker-compose.prod.yml` plus a host-level Nginx that terminates TLS
for both `highfive.schutera.com` (frontend) and
`api.highfive.schutera.com` (backend). All four services
(`backend`, `frontend`, `image-service`, `duckdb-service`) run in a
single Compose project; the `duckdb_data` named volume persists the
DuckDB file across rebuilds.

For a non-Docker production option (Nginx + PM2 on bare metal), see
[production-runbook.md](production-runbook.md). For dev-laptop setup,
see [docker-compose.md](docker-compose.md).

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
$EDITOR .env.production   # fill HIGHFIVE_API_KEY, VITE_API_KEY
# Generate keys with: openssl rand -base64 32

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
`HIGHFIVE_API_KEY must be set in .env.production` or
`VITE_API_KEY must be set in .env.production`, that is by design — the
compose interpolation rejects missing or empty secrets. Fix
`.env.production` and re-run.

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

# Generate two keys (or one shared key for the single-key model in
# ADR-003 - both fields can hold the same value)
openssl rand -base64 32   # → HIGHFIVE_API_KEY
openssl rand -base64 32   # → VITE_API_KEY

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

Create `/etc/nginx/sites-available/highfive`:

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

    location = /new_module {
        proxy_pass http://127.0.0.1:8002/new_module;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location = /heartbeat {
        proxy_pass http://127.0.0.1:8002/heartbeat;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
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

Dashboard fetch path (TLS, X-API-Key required):

```bash
curl -fsS -H "X-API-Key: $HIGHFIVE_API_KEY" \
    https://api.highfive.schutera.com/api/modules
```

This is the path the SPA actually exercises. A 401 means the host-Nginx
TLS proxy is wired but the key is wrong; a 200 with a JSON array means
the dashboard will load data correctly.

ESP firmware paths (HTTP, no `-f` because /upload returns 405 for HEAD):

```bash
# 405 Method Not Allowed = success: nginx routed to image-service, not
# a 301 to HTTPS. Pipe through grep so the test passes when 405 lands.
curl -sSI http://highfive.schutera.com/upload | head -1
curl -sSI http://highfive.schutera.com/heartbeat | head -1
```

If either returns `HTTP/1.1 301 Moved Permanently` with a `Location:
https://...` header, the firmware-proxy `location =` blocks aren't
matching — check `nginx -t` and the order of server blocks.

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
migrations and seeded data are not lost.

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
