# Production Deployment (Docker Compose + Nginx)

> ⚠️ **This runbook is incomplete and deploys a partial stack.**
> `docker-compose.prod.yml` defines only `backend` and `frontend` —
> the upload pipeline (`image-service` + `duckdb-service`) is **not**
> brought up by following the steps below, and the backend is not
> configured to reach them. Following this guide as-shipped gives
> you a dashboard that loads but cannot ingest images, plus a
> frontend container with no TLS path. Tracked as a follow-up
> issue (see chapter 11 for the cross-link). Use this runbook only
> for partial-stack experiments until that issue lands.

Deploy HighFive to production from the `production` branch using
`docker-compose.prod.yml`. The compose file as shipped binds the
backend on host port `3001` and the frontend on host ports `80` and
`443`. The frontend container, however, only listens on port `80`
(`homepage/nginx.conf:1-2`) and only `EXPOSE 80` is declared in
`homepage/Dockerfile:30` — **the `:443` host binding is a no-op and
the frontend has no TLS path inside the container.** Two realistic
topologies are documented below; pick one.

For a non-Docker production option (Nginx + PM2 on bare metal),
see [production-runbook.md](production-runbook.md). For dev-laptop
setup, see [docker-compose.md](docker-compose.md).

## Prerequisites

- Server: Ubuntu 20.04+ with 7.7GB+ RAM
- Domain: highfive.schutera.com pointing to server IP
- API subdomain: api.highfive.schutera.com pointing to server IP
- Root/sudo access

## Topologies

### Topology A — HTTP-only LAN deploy (matches compose as-shipped)

The frontend container binds host port `80` directly and serves the
SPA over HTTP. The backend binds host port `3001` directly. No
host-Nginx, no TLS. Suitable only for trusted networks (lab,
home-LAN, behind a separate VPN/edge).

The `'443:443'` line in `docker-compose.prod.yml:29` does nothing
in this topology — leave it alone or remove it; either is fine.
Browsers hitting `https://highfive.schutera.com` will fail because
nothing is listening on `:443`.

### Topology B — TLS via host-Nginx in front of everything

A host-level Nginx terminates TLS on `:443` for both `*.schutera.com`
and `api.*.schutera.com`, proxying to the backend (`:3001`) and
frontend (some non-80 port like `:8081`). This **requires** changing
the frontend port mapping in `docker-compose.prod.yml` away from
`80:80`/`443:443` (e.g. to `8081:80`) so the host can own `:80` and
`:443`. That edit is infra work and is not part of this PR — it lives
on the GitHub issue tracking the prod-stack rework.

The Quick Deploy below covers Topology A. For Topology B, follow
Quick Deploy steps 1-4, then defer to the issue once it lands.

## Quick Deploy (Topology A — HTTP-only)

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

# 3. Build Docker images (only the two services compose knows about)
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml build frontend

# 4. Start services
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps

# 5. Verify what came up — both containers should be `Up`. Note that
# image-service and duckdb-service are NOT started by this compose
# file; the upload pipeline will not function until the prod-stack
# issue is resolved.
docker ps

# 6. Smoke-test (HTTP only)
curl http://localhost:3001/api/health
curl http://localhost:80/   # SPA index served by frontend container
```

There is no certbot step in Topology A — the frontend container has
no TLS terminator. Anyone browsing to `https://highfive.schutera.com`
will get a connection refused on `:443`.

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

### Step 3: Build Docker Images

```bash
cd /opt/highfive

# Build backend (takes 2-3 minutes)
docker compose -f docker-compose.prod.yml build backend

# Build frontend (takes 3-5 minutes)
docker compose -f docker-compose.prod.yml build frontend

# Verify images
docker images | grep highfive
```

### Step 4: Start Services

```bash
# Start containers
docker compose -f docker-compose.prod.yml up -d

# Check status
docker compose -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.prod.yml logs -f
```

Both services should show `Up` status.

### Step 5: Topology and TLS — read this before going any further

The compose file as shipped maps:

| Service                                                | Container port | Host port      | Notes |
|--------------------------------------------------------|----------------|----------------|-------|
| `backend` (Express)                                    | 3001           | **3001**       | bound on host                                                                                       |
| `frontend` (Nginx-in-container, serves Vite build)     | 80             | **80**         | binds host `:80` directly via `homepage/Dockerfile:30` (`EXPOSE 80`) and `homepage/nginx.conf:1-2` (`listen 80;`) |
| `frontend` (TLS)                                       | (none)         | (`443:443` no-op) | the container does **not** listen on 443 and ships no certs; the `:443` host binding has nothing to forward to |

Topology A (what this guide deploys) is HTTP-only. There is no
certbot step because there's nothing to terminate TLS on. Anyone
hitting `https://highfive.schutera.com` will see a connection
refused on `:443`.

Topology B requires changing `docker-compose.prod.yml`'s frontend
port mapping (e.g. to `8081:80`) so the host can own `:80` and `:443`,
then setting up a host-Nginx in front of everything. That edit is
infra work tracked in the prod-stack issue (see chapter 11). Do not
attempt it from this runbook in its current form.

### Step 6: Smoke-test (HTTP only)

```bash
# Backend health
curl http://localhost:3001/api/health

# Frontend SPA index
curl -L http://localhost/ | head -20

# Container status
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 backend
docker compose -f docker-compose.prod.yml logs --tail=50 frontend
```

Note that the upload pipeline (`image-service` + `duckdb-service`)
is **not** part of this compose file and the dashboard cannot
ingest images until those services are added. Tracking issue is
the same prod-stack issue referenced in Step 5.

## Troubleshooting

### Docker Build OOM (Exit 137)

If build fails with "exit code 137", swap space is insufficient:

```bash
# Check current swap
free -h

# Add more swap
sudo swapoff /swapfile
sudo dd if=/dev/zero of=/swapfile bs=1M count=8192
sudo mkswap /swapfile
sudo swapon /swapfile
free -h

# Retry build
docker compose -f docker-compose.prod.yml build --no-cache
```

### Port Already in Use

If port 3001, 80 or 443 is already in use:

```bash
# Check what's using the port
sudo netstat -tulpn | grep -E ':(3001|80|443)\b'

# Common culprits:
#   - 80/443: another web server (Apache, host-Nginx default vhost)
#   - 3001: a dev backend you forgot to stop

# Stop the service and rebuild
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

## Running Services

### View Logs

```bash
# All services
docker compose -f docker-compose.prod.yml logs -f

# Backend only
docker compose -f docker-compose.prod.yml logs -f backend

# Frontend only
docker compose -f docker-compose.prod.yml logs -f frontend
```

### Restart Services

```bash
# Restart all
docker compose -f docker-compose.prod.yml restart

# Restart specific service
docker compose -f docker-compose.prod.yml restart backend
```

### Stop Services

```bash
# Stop all
docker compose -f docker-compose.prod.yml down

# Stop without removing volumes
docker compose -f docker-compose.prod.yml stop
```

### Update to Latest Code

```bash
cd /opt/highfive
git pull origin production

# Rebuild and restart
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
```

## Access Application

Once deployed (Topology A — HTTP only):

- **Frontend**: `http://<server-ip>/` (or `http://highfive.schutera.com` if DNS points at the box)
- **API**: `http://<server-ip>:3001/api/modules`
- **Health Check**: `http://<server-ip>:3001/api/health`

`https://` URLs **will not work** in this topology. See Step 5 for
why and the prod-stack issue for the path to TLS.

## Support

For issues:

```bash
# Check Docker status
docker ps
docker compose -f docker-compose.prod.yml ps

# View system resources
free -h
df -h

# Check Nginx
sudo nginx -t
sudo systemctl status nginx
```
