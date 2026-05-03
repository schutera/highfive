# 7. Deployment View

How HiveHive runs in practice. The server stack runs as one Docker
Compose project for development and as either a Docker Compose or
Nginx + PM2 setup in production. Each ESP32-CAM module is flashed once
over USB and then operates autonomously.

- [docker-compose.md](docker-compose.md) — dev server stack via `docker compose up`
- [production-deployment.md](production-deployment.md) — production via `docker-compose.production.yml` + Nginx reverse proxy + Let's Encrypt
- [production-runbook.md](production-runbook.md) — alternative production via PM2 + Nginx (bare-metal Node.js, no Docker)
- [esp-flashing.md](esp-flashing.md) — ESP32-CAM firmware flashing & onboarding (incl. `ESP32-CAM/build.sh` and `ESP32-CAM/VERSION`)
