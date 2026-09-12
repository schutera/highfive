# 7. Deployment View

How HiveHive runs in practice. The server stack runs as one Docker Compose
project for development. In production the live host runs the bare-metal
**Nginx + PM2** path; the Docker Compose topology is the **supported
target, not yet deployed** — [what-is-live.md](what-is-live.md) is the
one-page answer to "which runtime is live?" and how to verify it on the
host. Each ESP32-CAM module is flashed once over USB and then operates
autonomously.

- [what-is-live.md](what-is-live.md) — **which runtime is live in production** (PM2 path today; Docker target) — the runtime matrix and the env-var matrix
- [docker-compose.md](docker-compose.md) — dev server stack via `docker compose up`
- [production-runbook.md](production-runbook.md) — **the path live in production today**: Nginx + PM2 on bare metal (no Docker) — backend, static frontend, ESP/OTA Nginx ingress, and the environment the two Python services need (initial pm2 provisioning of those two is the operator's step)
- [production-deployment.md](production-deployment.md) — **supported production target, not yet deployed**: `docker-compose.prod.yml` (all four services: backend + frontend + image-service + duckdb-service, with `duckdb_data` volume) behind a host-Nginx terminator that handles TLS for `highfive.schutera.com` + `api.highfive.schutera.com` via Let's Encrypt
- [esp-flashing.md](esp-flashing.md) — ESP32-CAM firmware flashing & onboarding (incl. `ESP32-CAM/build.sh` and `ESP32-CAM/VERSION`)
- [firmware-release.md](firmware-release.md) — **how to cut an OTA firmware release**: the end-to-end runbook (bump `VERSION`+`SEQUENCE` → `build.sh` → republish frontend → commit + promote to `production` + `prod-<codename>` tag), the gated `production` release-branch model (services + firmware, promoted from `main` — #152 / [ADR-030](../09-architecture-decisions/adr-030-production-as-gated-release-branch.md)), and where each OTA mechanism is defined
