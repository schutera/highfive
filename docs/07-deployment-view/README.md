# 7. Deployment View

How HiveHive runs in practice. The server stack runs as one Docker
Compose project for development and as either a Docker Compose or
Nginx + PM2 setup in production. Each ESP32-CAM module is flashed once
over USB and then operates autonomously.

- [docker-compose.md](docker-compose.md) — dev server stack via `docker compose up`
- [production-deployment.md](production-deployment.md) — **supported production path**: `docker-compose.prod.yml` (all four services: backend + frontend + image-service + duckdb-service, with `duckdb_data` volume) behind a host-Nginx terminator that handles TLS for `highfive.schutera.com` + `api.highfive.schutera.com` via Let's Encrypt
- [production-runbook.md](production-runbook.md) — non-recommended legacy bare-metal path (PM2 + Nginx, no Docker, Node backend only — upload pipeline not covered)
- [esp-flashing.md](esp-flashing.md) — ESP32-CAM firmware flashing & onboarding (incl. `ESP32-CAM/build.sh` and `ESP32-CAM/VERSION`)
