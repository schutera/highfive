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
                    ▼
          host-Nginx (TLS terminator)
            │ :443                       :443 │
            ▼                                 ▼
   highfive.schutera.com            api.highfive.schutera.com
            │ proxies to                       │ proxies to
            ▼                                  ▼
   127.0.0.1:8081                    127.0.0.1:3001
   (frontend container)              (backend container)
                                              │
                                              ▼
                                     duckdb-service:8000
                                     image-service:4444
                                     (Compose-internal,
                                      via `highfive-network`)
```

ESP32-CAM firmware uploads reach `image-service` directly on
`<server-ip>:8000` over plain HTTP. See "Known gaps" below.

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

`.env.production` is git-ignored (the existing `.env*` rules in the
repo `.gitignore` cover it). Never commit it.

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

The Compose stack binds frontend on `127.0.0.1:8081` and backend on
`127.0.0.1:3001` — both reachable only from the server's loopback. A
host-level Nginx terminates TLS for two subdomains and proxies into
the loopback ports.

#### a. Get certificates

```bash
sudo apt-get update
sudo apt-get install nginx certbot python3-certbot-nginx

sudo certbot certonly --nginx \
    -d highfive.schutera.com \
    -d api.highfive.schutera.com
```

#### b. Configure host-Nginx

Create `/etc/nginx/sites-available/highfive`:

```nginx
# Frontend - SPA at https://highfive.schutera.com
server {
    listen 80;
    server_name highfive.schutera.com;
    return 301 https://$server_name$request_uri;
}

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

# Backend - API at https://api.highfive.schutera.com
server {
    listen 80;
    server_name api.highfive.schutera.com;
    return 301 https://$server_name$request_uri;
}

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
        # X-Highfive-Data-Incomplete is a CORS-exposed header read by
        # the dashboard banner - leave proxy_pass_header on default
        # (passes all). See backend/src/app.ts corsOptions.
    }
}
```

Enable and reload:

```bash
sudo ln -s /etc/nginx/sites-available/highfive /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### c. Smoke-test through TLS

```bash
curl -fsS https://api.highfive.schutera.com/api/health
curl -fsSI https://highfive.schutera.com/ | head -5
```

Both should return 200. The frontend root serves the SPA; the API
health check returns `{ "status": "ok", "timestamp": "..." }`.

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

These are intentional production gaps tracked separately, not breakage:

- **ESP32-CAM uploads are HTTP-only.** Firmware uploads reach
  `image-service` on `<server-ip>:8000` over plain HTTP. Adding TLS
  termination for ESP uploads requires either a public TLS-terminating
  proxy in front of `image-service` (with a third subdomain like
  `images.highfive.schutera.com`) or an MQTT/TLS upload path. Not
  in scope for this runbook.
- **`duckdb-service` is internal-only.** No public URL by design — it
  is reached only by `backend` and `image-service` over the
  Compose-internal `highfive-network` bridge. Per ADR-001 (DuckDB as
  sole writer), the public surface is the backend API.
- **Single shared TLS cert covers both subdomains.** The certbot step
  issues one cert for `highfive.schutera.com` + `api.highfive.schutera.com`
  via SAN. Renewal works the same for both.

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
- Image upload (ESP firmware): `http://<server-ip>:8000/upload`
  (HTTP-only by design — see "Known gaps")

## See also

- [`../api-reference.md`](../api-reference.md) — full HTTP API reference
- [`../08-crosscutting-concepts/auth.md`](../08-crosscutting-concepts/auth.md) — API key handling
- [`../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md`](../09-architecture-decisions/adr-001-duckdb-as-sole-writer.md) — why duckdb-service is internal-only
