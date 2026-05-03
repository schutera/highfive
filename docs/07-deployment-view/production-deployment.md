# Production Deployment (Docker Compose + Nginx)

Deploy HighFive to production from the `production` branch using
`docker-compose.prod.yml`, with Nginx as the public reverse
proxy and Let's Encrypt for TLS.

For a non-Docker production option (Nginx + PM2 on bare metal),
see [production-runbook.md](production-runbook.md). For dev-laptop
setup, see [docker-compose.md](docker-compose.md).

## Prerequisites

- Server: Ubuntu 20.04+ with 7.7GB+ RAM
- Domain: highfive.schutera.com pointing to server IP
- API subdomain: api.highfive.schutera.com pointing to server IP
- Root/sudo access

## Quick Deploy (5 minutes)

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

# 3. Build Docker images
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml build frontend

# 4. Start services
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps

# 5. Configure host-Nginx for the API (the frontend container binds
#    80/443 directly — see Step 5 below for the topology note)
sudo tee /etc/nginx/sites-available/highfive-api > /dev/null <<'EOF'
server {
    listen 8080;  # NOT 80 — port 80 is bound by the frontend container
    server_name api.highfive.schutera.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF

# NOTE: The frontend does NOT need a host-Nginx proxy. The homepage
# container ships its own Nginx (homepage/nginx.conf) and binds host
# ports 80:80 + 443:443 directly (docker-compose.prod.yml lines 27-29).
# A second host-Nginx listener on :80 would conflict with that bind.

# 6. Enable site and reload Nginx
sudo ln -sf /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 7. Get SSL certificate (frontend cert is handled separately —
# either inside the frontend container's Nginx, or via DNS-01)
sudo certbot --nginx \
  -d api.highfive.schutera.com

# 8. Verify deployment
curl https://api.highfive.schutera.com/api/health
curl https://highfive.schutera.com
```

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

### Step 5: Configure Nginx Reverse Proxy (API only)

Topology — what `docker-compose.prod.yml` actually maps:

| Service                                                | Container port | Host port      | Notes |
|--------------------------------------------------------|----------------|----------------|-------|
| `backend` (Express)                                    | 3001           | **3001**       | bound on host; host-Nginx proxies here |
| `frontend` (Nginx-in-container, serving Vite build)    | 80 / 443       | **80 / 443**   | binds the host's 80/443 directly via `homepage/Dockerfile` + `homepage/nginx.conf` |

So host-Nginx (`/etc/nginx/`) is **only** needed for the API
subdomain. A second host-Nginx listener on `:80` would conflict with
the frontend container's bind. The frontend gets its TLS cert either
inside the container's nginx or via certbot's DNS-01 challenge.

Create the API proxy on a free host port (e.g. `8080`) — let the
frontend container own `80/443`:

```bash
sudo tee /etc/nginx/sites-available/highfive-api > /dev/null <<'EOF'
server {
    listen 8080;  # NOT 80 — frontend container holds 80
    server_name api.highfive.schutera.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
EOF
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/

sudo nginx -t
sudo systemctl reload nginx
```

If you want host-Nginx on `:443` for both, you'll need to either run
host-Nginx in front of the entire stack (and rebind the frontend
container off 80/443 — diverges from `docker-compose.prod.yml` as it
ships) or add a dedicated reverse-proxy container in compose. Both are
out of scope here.

### Step 6: Setup SSL with Certbot

```bash
# Verify DNS first
nslookup api.highfive.schutera.com
nslookup highfive.schutera.com

# Both should return your server IP

# Get SSL certificate for the API only — the frontend container
# handles its own TLS (or use certbot DNS-01 separately for it)
sudo certbot --nginx \
  -d api.highfive.schutera.com

# Choose option 2: Redirect HTTP to HTTPS
# Certificate auto-renews
```

### Step 7: Verify Deployment

```bash
# Test API
curl https://api.highfive.schutera.com/api/health

# Test frontend
curl -L https://highfive.schutera.com | head -20

# Check logs
docker compose -f docker-compose.prod.yml logs backend
docker compose -f docker-compose.prod.yml logs frontend
```

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

### Certbot DNS Error

If DNS lookup fails:

```bash
# Verify DNS is configured
nslookup api.highfive.schutera.com

# If NXDOMAIN, add DNS records to your provider:
# A record: api.highfive → your-server-ip
# A record: highfive → your-server-ip

# Wait 5-10 minutes for propagation, then retry certbot
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

Once deployed:

- **Frontend**: https://highfive.schutera.com
- **API**: https://api.highfive.schutera.com/api/modules
- **Health Check**: https://api.highfive.schutera.com/api/health

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
