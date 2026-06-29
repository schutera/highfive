# Production Runbook (Nginx + PM2) — non-recommended bare-metal path

> ⚠️ **Non-recommended legacy path.** This runbook covers only the
> Node backend (PM2) and the static frontend (Nginx-served). It does
> **not** cover the _initial_ bare-metal provisioning of `image-service`
> and `duckdb-service` (each needs its own pm2/systemd unit, shared
> filesystem volume, and reverse-proxy plumbing) — though ongoing
> **redeploys** of those Python services (dependency install + reload) are
> covered under [Updates & Redeployment](#updates--redeployment). The supported
> production path is **Docker Compose + host-Nginx**:
> [production-deployment.md](production-deployment.md). Use this PM2
> runbook only if Docker is not an option on the target host; expect
> to fill in the upload-pipeline plumbing yourself.

## Overview

This runbook covers deploying HighFive to production at
`highfive.schutera.com` using Nginx as the public-facing reverse proxy
and PM2 to supervise the Node backend on bare metal — no Docker.

For the supported Docker-Compose-based production deploy, see
[production-deployment.md](production-deployment.md). For dev-laptop
setup, see [docker-compose.md](docker-compose.md).

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

Create `/etc/nginx/sites-available/highfive`:

```bash
sudo cat > /etc/nginx/sites-available/highfive << 'EOF'
# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name highfive.schutera.com;
    return 301 https://$server_name$request_uri;
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

    # Backend API
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

### 6. Create PM2 Ecosystem Config (on server)

Create `ecosystem.config.js` in `/var/www/highfive/`:

```bash
cat > /var/www/highfive/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [
    {
      name: 'highfive-api',
      script: './backend/dist/server.js',
      instances: 'max',
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
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

### 7. Build and Start Application

```bash
cd /var/www/highfive

# Build backend
cd backend
npm run build
cd ..

# Build frontend with API URL
cd homepage
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

> The host normally self-deploys via [`scripts/deploy.sh`](../../scripts/deploy.sh)
> (auto-deploy driver — pulls `main`, installs deps, rebuilds only what changed,
> reloads the affected pm2 apps, health-checks, rolls back on failure; the
> `highfive-deploy.timer` may be inactive). The manual steps below mirror what it
> does — use them for a hand-deploy or to recover. **Caveat:** a rollback restores
> the git tree and Node build artifacts, but a `pip install` that _upgraded_ a
> shared dependency (e.g. `numpy` → 2.x) is **not** reverted — pip upgrades are
> forward-only across a rollback.

The live PM2 stack is **four** apps, not just the backend: `highfive-api`
(Node, cluster), `duckdb-service` and `image-service` (Python, run on the
**system `python3` — no venv**), plus the Nginx-served `homepage/dist`.

```bash
cd /var/www/highfive
git pull --ff-only origin main

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
#    without the hole-detection deps (detection degrades to a no-op, ADR-028),
#    which is why the pip step is non-fatal in scripts/deploy.sh.
python3 -m pip install -r duckdb-service/requirements.txt
python3 -m pip install -r image-service/requirements.txt

# 3) Build the Node side (contracts is source-only — no build step)
npm --prefix backend run build
( cd homepage && VITE_API_URL=https://highfive.schutera.com/api npm run build )

# 4) Reload (zero-downtime for the api cluster) and health-check
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

## Verification

### Check Backend is Running

```bash
pm2 status
pm2 logs highfive-api
```

### Test API

```bash
curl https://highfive.schutera.com/api/modules
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

The `.env.production` file in the repository contains generic production settings:

- `NODE_ENV=production`
- `PORT=3001`

The server-specific `.env` file (created during setup) overrides these and should NOT be committed to git.

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

#### Option 1: Using docker-compose (recommended)

```bash
# Create or edit .env file in project root
HIGHFIVE_API_KEY=your_generated_key_here   # the only secret (#142)

# Deploy with docker-compose
docker-compose up -d
```

#### Option 2: Using PM2

```bash
# In /var/www/highfive/.env
HIGHFIVE_API_KEY=your_generated_key_here

# Backend will read from .env automatically
pm2 start backend/dist/server.js --name "highfive-backend"
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
