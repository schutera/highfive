# HighFive Production Deployment Guide

Deploy HighFive directly on Linux server using Node.js and Nginx. No Docker required.

## Prerequisites

- **Server**: Ubuntu 20.04+ with Node.js 18+
- **Domain**: highfive.schutera.com pointing to server IP
- **API subdomain**: api.highfive.schutera.com pointing to server IP
- **Nginx**: For reverse proxy and SSL
- **Certbot**: For SSL certificates

## Quick Deploy (10 minutes)

```bash
ssh user@your-server-ip

# Clone repository
git clone https://github.com/mrkschtr/highfive.git /opt/highfive
cd /opt/highfive

# Build and start backend
cd backend
npm install --production
npm run build

# Create systemd service for auto-start
sudo tee /etc/systemd/system/highfive-backend.service > /dev/null <<'EOF'
[Unit]
Description=HighFive Backend API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/highfive/backend
ExecStart=/usr/bin/npm start
Restart=unless-stopped
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable highfive-backend
sudo systemctl start highfive-backend

# Build frontend
cd /opt/highfive/homepage
npm install --production
npm run build

# Deploy frontend to web server
sudo cp -r dist/* /var/www/html/
sudo chown -R www-data:www-data /var/www/html

# Configure Nginx and SSL (see detailed steps below)
```

## Detailed Steps

### Step 1: Clone and Build Backend

```bash
cd /opt/highfive/backend

# Install production dependencies only
npm install --production

# Build TypeScript
npm run build

# Test it runs (should print "API running on port 3008")
npm start
# Press Ctrl+C to stop
```

### Step 2: Setup Backend as System Service

Create systemd service so backend auto-restarts:

```bash
sudo tee /etc/systemd/system/highfive-backend.service > /dev/null <<'EOF'
[Unit]
Description=HighFive Backend API
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/highfive/backend
ExecStart=/usr/bin/npm start
Restart=unless-stopped
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable highfive-backend
sudo systemctl start highfive-backend

# Verify running
sudo systemctl status highfive-backend

# View logs
sudo journalctl -u highfive-backend -f
```

### Step 3: Build and Deploy Frontend

```bash
cd /opt/highfive/homepage

# Install production dependencies
npm install --production

# Build static files
npm run build

# Copy to web server
sudo cp -r dist/* /var/www/html/
sudo chown -R www-data:www-data /var/www/html

# Verify
ls /var/www/html/
```

### Step 4: Configure Nginx Proxies

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
    root /var/www/html;
    index index.html;

    # SPA routing - always serve index.html for unknown routes
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css text/javascript application/javascript application/json;
}
EOF
```

Enable sites and reload:

```bash
sudo ln -sf /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/highfive-frontend /etc/nginx/sites-enabled/

# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# Test configuration
sudo nginx -t

# Reload
sudo systemctl reload nginx
```

### Step 5: Setup SSL with Certbot

Verify DNS first:

```bash
nslookup api.highfive.schutera.com
nslookup highfive.schutera.com
```

Both should return your server IP. Then get SSL:

```bash
sudo certbot --nginx \
  -d api.highfive.schutera.com \
  -d highfive.schutera.com

# Select option 2: Redirect HTTP to HTTPS
# Certificate auto-renews
```

### Step 6: Verify Deployment

```bash
# Test API
curl https://api.highfive.schutera.com/api/health

# Test frontend
curl -L https://highfive.schutera.com | head -20

# Check backend service
sudo systemctl status highfive-backend

# View backend logs
sudo journalctl -u highfive-backend -n 50
```

## Managing Services

### View Backend Logs

```bash
# Real-time logs
sudo journalctl -u highfive-backend -f

# Last 50 lines
sudo journalctl -u highfive-backend -n 50

# Logs since last boot
sudo journalctl -u highfive-backend -b
```

### Restart Backend

```bash
sudo systemctl restart highfive-backend
```

### Stop Backend

```bash
sudo systemctl stop highfive-backend
```

### Start Backend

```bash
sudo systemctl start highfive-backend
```

### Check Backend Status

```bash
sudo systemctl status highfive-backend
```

## Update to Latest Code

```bash
cd /opt/highfive

# Pull latest
git pull origin main

# Rebuild backend
cd backend
npm install --production
npm run build

# Restart backend service
sudo systemctl restart highfive-backend

# Rebuild frontend
cd /opt/highfive/homepage
npm install --production
npm run build
sudo cp -r dist/* /var/www/html/

# Reload Nginx
sudo systemctl reload nginx
```

## Troubleshooting

### Backend Won't Start

```bash
# Check if port 3008 is in use
sudo netstat -tulpn | grep 3008

# If in use, kill the process
sudo lsof -ti:3008 | xargs kill -9

# Restart service
sudo systemctl restart highfive-backend

# Check logs
sudo journalctl -u highfive-backend -n 50
```

### Certbot DNS Error

If DNS lookup fails:

```bash
# Verify DNS is configured
nslookup api.highfive.schutera.com

# If NXDOMAIN, add DNS records to your provider:
# A record: api.highfive → your-server-ip
# A record: highfive → your-server-ip

# Wait 5-10 minutes for propagation, then retry
sudo certbot --nginx -d api.highfive.schutera.com -d highfive.schutera.com
```

### Nginx Configuration Error

```bash
# Test Nginx config
sudo nginx -t

# View Nginx logs
sudo tail -f /var/log/nginx/error.log

# Reload Nginx
sudo systemctl reload nginx
```

### High Memory Usage

Check what's using memory:

```bash
# Overall memory
free -h

# Process memory
ps aux --sort=-%mem | head -10

# Node.js memory
ps aux | grep node
```

## Access Application

Once deployed:

- **Frontend**: https://highfive.schutera.com
- **API**: https://api.highfive.schutera.com/api/modules
- **Health Check**: https://api.highfive.schutera.com/api/health

## Architecture

```
Internet
   |
   v (HTTPS)
Nginx (ports 80/443)
   |
   +---> https://highfive.schutera.com → /var/www/html (React static)
   |
   +---> https://api.highfive.schutera.com → localhost:3008 (Node.js backend)
```

Backend runs as systemd service, auto-restarts on crash or reboot. Frontend served as static files with SPA routing support.