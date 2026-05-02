# 7. Deployment View

How HiveHive runs in practice. The server stack is one Docker Compose
project on a developer laptop or self-hosted server; each ESP32-CAM
module is flashed once over USB and then operates autonomously.

- [docker-compose.md](docker-compose.md) — server stack via Docker Compose
- [esp-flashing.md](esp-flashing.md) — ESP32-CAM firmware flashing & onboarding
