# Changelog

All notable changes to this project are documented in this file.

## v1.0.0 — 2026-04-11

First tagged release aimed at keeping deployed modules alive in the field and making failures diagnosable after the fact.

### ESP32-CAM firmware

- **WiFi watchdog.** `loop()` now checks `WiFi.status()` and calls `reconnectWifi()` when disconnected. Five consecutive reconnect failures trigger a device restart. Fixes the single most likely cause of the ~8–10 day field death (router reboot / DHCP lease expiry with no recovery path).
- **Task watchdog.** `esp_task_wdt_init(30, true)` with per-iteration reset. Any 30-second hang now auto-reboots.
- **Daily reboot.** After 24 hours of uptime the device restarts automatically, clearing heap fragmentation and stale TCP state.
- **No more `while(true)` hard-locks.** Camera init failure and WiFi initial-connect timeout now call `ESP.restart()` instead of spinning forever.
- **Circular log buffer.** New `logbuf.{h,cpp}` exposes `logf()` — writes to Serial *and* to a 2 KB in-memory ring buffer.
- **Reset-reason & boot-count persistence.** Reset reason is read from `esp_reset_reason()` at boot and logged. Boot count is incremented in NVS via `Preferences` namespace `"telemetry"`.
- **Keep-alive socket cleanup.** Every error path in `postImage()` now calls `client.stop()` before returning.
- **`FIRMWARE_VERSION` macro** introduced in `esp_init.h` (currently `"1.0.0"`).

### Telemetry channel

- Every image upload now includes an additional multipart form field `logs` containing a compact JSON payload: `fw`, `uptime_s`, `last_reset_reason`, `free_heap`, `min_free_heap`, `rssi`, `wifi_reconnects`, `last_http_codes`, and the last ~2 KB of `logf()` output.
- **image-service** (`/upload`) accepts the optional `logs` field and writes it to `{image_path}.log.json` next to the saved image. Backward compatible — missing field is a no-op.
- **image-service** (`GET /modules/<mac>/logs?limit=N`) returns the most recent N telemetry entries for a module, newest-first, parsed from the sidecar files.
- **backend** (`GET /api/modules/:id/logs`) proxies the image-service endpoint behind the existing `X-API-Key` middleware so the frontend stays on a single origin. Reads `IMAGE_SERVICE_URL` (defaults to `http://image-service:4444`).
- **docker-compose.yml** — the backend service now sets `IMAGE_SERVICE_URL`.

### Admin view

- **ModulePanel** (`homepage/src/components/ModulePanel.tsx`) has a new collapsible **Telemetry** section. Lazy-loads logs on expand, shows uptime, free heap, RSSI, reset reason, reconnect count, last HTTP codes, and an expandable raw log view per entry.
- `api.getModuleLogs(id, limit)` added to `homepage/src/services/api.ts`.
- New `TelemetryEntry` TypeScript type.

### Documentation

- New `documentation/esp-reliability.md` — reliability strategy, telemetry schema, data-flow diagram, how to read logs from the admin view.

### Not in this release

- No refactor of `String` concatenation in `postImage()`. Daily reboot + heap telemetry handle the fragmentation risk for now.
- No OTA update mechanism.
- No central log database.
