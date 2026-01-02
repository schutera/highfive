# Deployment Guide

Complete guide to deploy HighFive on your server.

## Server Requirements

### Minimum Specifications
- **OS**: Ubuntu 20.04+ / Debian 11+ (or any Linux with Docker support)
- **CPU**: 2+ cores
- **RAM**: 2GB minimum (4GB+ recommended)
- **Storage**: 20GB+ (more if storing many images)
- **Network**: Public IP address with ports 80 and 443 available

### Port Usage
- **80**: HTTP (Nginx - reverse proxy)
- **443**: HTTPS/SSL (Nginx - reverse proxy)
- **3008**: Backend API (Docker internal only, not exposed to internet)
- **5173**: Frontend (Docker internal only, not exposed to internet)

Note: Docker internal ports (3008, 5173) do not conflict with other services since they're behind Nginx on ports 80/443

### Software Requirements
- Docker & Docker Compose
- Git
- Nginx (reverse proxy)
- Certbot (for SSL certificates)

## Initial Server Setup

### 1. Update System

```bash
# SSH into your server
ssh user@your-server-ip

# Update package list
sudo apt update && sudo apt upgrade -y
```

### 2. Install Docker

```bash
# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Add your user to docker group (avoid using sudo)
sudo usermod -aG docker $USER

# Install Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Verify installation
docker --version
docker-compose --version

# Log out and back in for group changes to take effect
exit
# SSH back in
```

### 3. Install Nginx

```bash
sudo apt install nginx -y
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 4. Configure Firewall

```bash
# Allow SSH, HTTP, and HTTPS
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## Deploy Application

### 1. Clone Repository

```bash
# Create application directory
sudo mkdir -p /opt/highfive
sudo chown $USER:$USER /opt/highfive
cd /opt/highfive

# Clone repository
git clone https://github.com/yourusername/highfive.git .
```

### 2. Environment Configuration

#### Backend Environment

```bash
# Create backend environment file
cd /opt/highfive/backend
nano .env
```

Add the following:

```env
# Server Configuration
NODE_ENV=production
PORT=3008

# CORS Settings
CORS_ORIGIN=https://highfive.schutera.com

# Image Storage
IMAGE_STORAGE_PATH=/opt/highfive/images
MAX_IMAGE_SIZE_MB=10

# Database (when you migrate from mock to real DB)
# DATABASE_URL=postgresql://user:password@localhost:5432/highfive
```

#### Frontend Environment

```bash
cd /opt/highfive/homepage
nano .env.production
```

Add:

```env
VITE_API_URL=https://api.highfive.schutera.com
```

### 3. Create Docker Compose Configuration

```bash
cd /opt/highfive
nano docker-compose.production.yml
```

```yaml
version: '3.8'

services:
  # Backend API
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    container_name: highfive-backend
    restart: unless-stopped
    ports:
      - "3008:3008"
    environment:
      - NODE_ENV=production
    volumes:
      - ./images:/app/images
      - ./backend/.env:/app/.env
    networks:
      - highfive-network

  # Frontend (optional - can be built and served statically)
  frontend:
    build:
      context: ./homepage
      dockerfile: Dockerfile
      args:
        - VITE_API_URL=https://api.yourdomain.com
    container_name: highfive-frontend
    restart: unless-stopped
    ports:
      - "5173:80"
    networks:
      - highfive-network

networks:
  highfive-network:
    driver: bridge

volumes:
  images:
```

### 4. Create Dockerfiles

#### Backend Dockerfile

```bash
cd /opt/highfive/backend
nano Dockerfile
```

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create images directory
RUN mkdir -p /app/images

# Expose port
EXPOSE 3008

# Start server
CMD ["node", "dist/server.js"]
```

#### Frontend Dockerfile

```bash
cd /opt/highfive/homepage
nano Dockerfile
```

```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build argument for API URL
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Build application
RUN npm run build

# Production stage with Nginx
FROM nginx:alpine

# Copy built files
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
```

#### Frontend Nginx Config

```bash
cd /opt/highfive/homepage
nano nginx.conf
```

```nginx
server {
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # SPA routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### 5. Build and Start Services

```bash
cd /opt/highfive

# Build images
docker-compose -f docker-compose.production.yml build

# Start services
docker-compose -f docker-compose.production.yml up -d

# Check status
docker-compose -f docker-compose.production.yml ps

# View logs
docker-compose -f docker-compose.production.yml logs -f
```

## Nginx Reverse Proxy Setup

### 1. Configure Domain Names

DNS should already point to your server. Configure these subdomains:
- `api.highfive.schutera.com` → Backend API
- `highfive.schutera.com` → Frontend

### 2. Backend API Proxy

```bash
sudo nano /etc/nginx/sites-available/highfive-api
```

```nginx
server {
    listen 80;
    server_name api.highfive.schutera.com;

    # Rate limiting
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
    limit_req zone=api_limit burst=20 nodelay;

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
        
        # Timeouts
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # Image uploads
    client_max_body_size 10M;
}
```

### 3. Frontend Proxy

```bash
sudo nano /etc/nginx/sites-available/highfive-frontend
```

```nginx
server {
    listen 80;
    server_name highfive.schutera.com www.highfive.schutera.com;

    location / {
        proxy_pass http://localhost:5173;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 4. Enable Sites

```bash
# Enable configurations
sudo ln -s /etc/nginx/sites-available/highfive-api /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/highfive-frontend /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## SSL Certificate Setup

### 1. Install Certbot

```bash
sudo apt install certbot python3-certbot-nginx -y
```

### 2. Obtain Certificates

```bash
# For both subdomains
sudo certbot --nginx -d api.highfive.schutera.com -d highfive.schutera.com -d www.highfive.schutera.com
```

Certbot will automatically:
- Obtain SSL certificates
- Configure Nginx for HTTPS
- Set up auto-renewal

### 3. Verify Auto-Renewal

```bash
# Test renewal process
sudo certbot renew --dry-run

# Check renewal timer
sudo systemctl status certbot.timer
```

## Monitoring & Maintenance

### 1. Check Service Status

```bash
# Docker containers
docker-compose -f docker-compose.production.yml ps

# View logs
docker-compose -f docker-compose.production.yml logs backend
docker-compose -f docker-compose.production.yml logs frontend

# Follow logs
docker-compose -f docker-compose.production.yml logs -f
```

### 2. Restart Services

```bash
# Restart all services
docker-compose -f docker-compose.production.yml restart

# Restart specific service
docker-compose -f docker-compose.production.yml restart backend
```

### 3. Update Application

```bash
cd /opt/highfive

# Pull latest changes
git pull origin main

# Rebuild and restart
docker-compose -f docker-compose.production.yml down
docker-compose -f docker-compose.production.yml build
docker-compose -f docker-compose.production.yml up -d
```

### 4. Backup Script

```bash
sudo nano /opt/highfive/backup.sh
```

```bash
#!/bin/bash

BACKUP_DIR="/opt/backups/highfive"
DATE=$(date +%Y%m%d_%H%M%S)

# Create backup directory
mkdir -p $BACKUP_DIR

# Backup images
tar -czf $BACKUP_DIR/images_$DATE.tar.gz /opt/highfive/images

# Backup database (when implemented)
# docker exec highfive-db pg_dump -U postgres highfive > $BACKUP_DIR/db_$DATE.sql

# Keep only last 7 days of backups
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completed: $DATE"
```

```bash
chmod +x /opt/highfive/backup.sh

# Add to crontab (daily at 2 AM)
crontab -e
# Add: 0 2 * * * /opt/highfive/backup.sh
```

### 5. System Monitoring

```bash
# Install monitoring tools
sudo apt install htop netdata -y

# Access Netdata dashboard
# http://your-server-ip:19999
```

### 6. Log Rotation

```bash
sudo nano /etc/logrotate.d/highfive
```

```
/opt/highfive/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    notifempty
    missingok
    copytruncate
}
```

## Security Hardening

### 1. Firewall Rules

```bash
# Only allow necessary ports
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### 2. SSH Hardening

```bash
sudo nano /etc/ssh/sshd_config
```

Change:
```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

```bash
sudo systemctl restart sshd
```

### 3. Fail2Ban (Brute Force Protection)

```bash
sudo apt install fail2ban -y

sudo nano /etc/fail2ban/jail.local
```

```ini
[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 3
bantime = 3600

[nginx-http-auth]
enabled = true
port = http,https
filter = nginx-http-auth
logpath = /var/log/nginx/error.log
maxretry = 5
```

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

## Troubleshooting

### Check Docker Logs
```bash
docker-compose -f docker-compose.production.yml logs backend
```

### Check Nginx Logs
```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### Container Not Starting
```bash
# Check container status
docker ps -a

# Inspect container
docker inspect highfive-backend

# Check for port conflicts
sudo netstat -tulpn | grep :3008
```

### SSL Issues
```bash
# Test SSL configuration
sudo certbot certificates

# Force renewal
sudo certbot renew --force-renewal
```

### Database Connection Issues (Future)
```bash
# Check if database container is running
docker-compose ps

# Access database shell
docker exec -it highfive-db psql -U postgres
```

## Performance Optimization

### 1. Enable HTTP/2

Already enabled with modern Nginx + SSL

### 2. CDN Integration (Optional)

Consider using Cloudflare or similar for:
- DDoS protection
- Global caching
- Analytics

### 3. Database Optimization (Future)

When migrating from mock database:
- Add indexes for frequently queried fields
- Set up connection pooling
- Regular VACUUM operations for PostgreSQL

## Quick Commands Reference

```bash
# Start services
docker-compose -f docker-compose.production.yml up -d

# Stop services
docker-compose -f docker-compose.production.yml down

# View logs
docker-compose -f docker-compose.production.yml logs -f

# Restart service
docker-compose -f docker-compose.production.yml restart backend

# Update application
git pull && docker-compose -f docker-compose.production.yml up -d --build

# Check Nginx config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# SSL renewal
sudo certbot renew
```

## Post-Deployment Checklist

- [ ] Application accessible via HTTPS
- [ ] SSL certificates valid and auto-renewing
- [ ] API endpoints responding correctly
- [ ] Frontend loading and connecting to API
- [ ] Firewall configured correctly
- [ ] Backup script scheduled
- [ ] Monitoring tools installed
- [ ] Domain DNS configured
- [ ] Error pages customized
- [ ] Logs rotating properly
- [ ] SSH hardened
- [ ] Documentation updated with server details

## Support

For issues during deployment:
1. Check Docker logs
2. Verify Nginx configuration
3. Check firewall rules
4. Verify environment variables
5. Review this guide's troubleshooting section
