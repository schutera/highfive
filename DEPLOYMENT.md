# HighFive Production Deployment Guide

## Overview
This guide covers deploying HighFive to production at `highfive.schutera.com`.

## Prerequisites
- Linux server (Ubuntu 20.04+ recommended)
- Node.js 18+ installed
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
git clone -b production https://github.com/your-username/highfive.git .
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

To deploy updates from the production branch:

```bash
cd /var/www/highfive

# Pull latest changes
git pull origin production

# Rebuild backend
cd backend
npm install --production
npm run build
cd ..

# Rebuild frontend
cd homepage
npm install --production
VITE_API_URL=https://highfive.schutera.com/api npm run build
cd ..

# Restart backend
pm2 restart highfive-api
```

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
HIGHFIVE_API_KEY=your_generated_key_here
VITE_API_KEY=your_generated_key_here

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
The frontend API key is built into the image during Docker build:
```bash
docker build \
  --build-arg VITE_API_KEY=your_key \
  --build-arg VITE_API_URL=https://api.highfive.schutera.com \
  -t highfive-frontend \
  ./homepage
```

## Security Notes

- Keep `.env` file on server only (add to `.gitignore`)
- Keep `ecosystem.config.js` on server only for production
- Nginx config with SSL is server-specific
- Regularly update Node.js dependencies: `npm audit fix`
- Monitor PM2 logs for errors
- Use strong SSL certificates from Let's Encrypt
