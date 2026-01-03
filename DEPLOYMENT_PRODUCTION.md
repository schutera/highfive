# HighFive Production Deployment Guide

Deploy HighFive from the `production` branch on your server.

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
git clone -b production https://github.com/yourusername/highfive.git .

# 3. Build Docker images
docker compose -f docker-compose.production.yml build backend
docker compose -f docker-compose.production.yml build frontend

# 4. Start services
docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml ps

# 5. Configure Nginx proxies
sudo tee /etc/nginx/sites-available/highfive-api > /dev/null <<'EOF'
server {
    listen 80;
    server_name api.highfive.schutera.com;

    location / {
        proxy_pass http://localhost:3008;
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

sudo tee /etc/nginx/sites-available/highfive-frontend > /dev/null <<'EOF'
server {
    listen 80;
    server_name highfive.schutera.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

# 6. Enable sites and reload Nginx
sudo ln -sf /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/highfive-frontend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# 7. Get SSL certificate
sudo certbot --nginx \
  -d api.highfive.schutera.com \
  -d highfive.schutera.com

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
git clone -b production https://github.com/yourusername/highfive.git .
git status  # Should show production branch
```

### Step 3: Build Docker Images

```bash
cd /opt/highfive

# Build backend (takes 2-3 minutes)
docker compose -f docker-compose.production.yml build backend

# Build frontend (takes 3-5 minutes)
docker compose -f docker-compose.production.yml build frontend

# Verify images
docker images | grep highfive
```

### Step 4: Start Services

```bash
# Start containers
docker compose -f docker-compose.production.yml up -d

# Check status
docker compose -f docker-compose.production.yml ps

# View logs
docker compose -f docker-compose.production.yml logs -f
```

Both services should show `Up` status.

### Step 5: Configure Nginx Reverse Proxy

The Dockerfiles expose:
- **Backend**: http://localhost:3008
- **Frontend**: http://localhost:5173

Nginx proxies these to public HTTPS URLs.

Create API proxy:

```bash
sudo tee /etc/nginx/sites-available/highfive-api > /dev/null <<'EOF'
server {
    listen 80;
    server_name api.highfive.schutera.com;

    location / {
        proxy_pass http://localhost:3008;
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

Create frontend proxy:

```bash
sudo tee /etc/nginx/sites-available/highfive-frontend > /dev/null <<'EOF'
server {
    listen 80;
    server_name highfive.schutera.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
```

Enable and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/highfive-frontend /etc/nginx/sites-enabled/

sudo nginx -t
sudo systemctl reload nginx
```

### Step 6: Setup SSL with Certbot

```bash
# Verify DNS first
nslookup api.highfive.schutera.com
nslookup highfive.schutera.com

# Both should return your server IP

# Get SSL certificate
sudo certbot --nginx \
  -d api.highfive.schutera.com \
  -d highfive.schutera.com

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
docker compose -f docker-compose.production.yml logs backend
docker compose -f docker-compose.production.yml logs frontend
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
docker compose -f docker-compose.production.yml build --no-cache
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

If port 3008 or 5173 is already in use:

```bash
# Check what's using the port
sudo netstat -tulpn | grep :3008
sudo netstat -tulpn | grep :5173

# Stop the service and rebuild
docker compose -f docker-compose.production.yml down
docker compose -f docker-compose.production.yml up -d
```

## Running Services

### View Logs

```bash
# All services
docker compose -f docker-compose.production.yml logs -f

# Backend only
docker compose -f docker-compose.production.yml logs -f backend

# Frontend only
docker compose -f docker-compose.production.yml logs -f frontend
```

### Restart Services

```bash
# Restart all
docker compose -f docker-compose.production.yml restart

# Restart specific service
docker compose -f docker-compose.production.yml restart backend
```

### Stop Services

```bash
# Stop all
docker compose -f docker-compose.production.yml down

# Stop without removing volumes
docker compose -f docker-compose.production.yml stop
```

### Update to Latest Code

```bash
cd /opt/highfive
git pull origin production

# Rebuild and restart
docker compose -f docker-compose.production.yml build
docker compose -f docker-compose.production.yml up -d
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
docker compose -f docker-compose.production.yml ps

# View system resources
free -h
df -h

# Check Nginx
sudo nginx -t
sudo systemctl status nginx
```
