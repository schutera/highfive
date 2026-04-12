# ESP32-CAM Reliability & Telemetry

This document describes the reliability strategy, telemetry channel, and admin log-viewing flow introduced in **v1.0.0**.

---

## Motivation

An earlier firmware revision ran for 8–10 days and then went silent in the field. The root cause was never proven because no diagnostics existed outside the Serial Monitor. v1.0.0 fixes the most likely culprits and adds just enough telemetry to diagnose future failures after the fact.

---

## Reliability layers

The firmware now has four independent safety nets, each handling a different failure mode.

### 1. WiFi watchdog

[ESP32-CAM/esp_init.cpp](../ESP32-CAM/esp_init.cpp) — `reconnectWifi()`

At the top of `loop()`, firmware checks `WiFi.status()`. If disconnected, it tries to reconnect for up to 15 seconds. If five consecutive reconnect attempts fail (~1 minute), the device reboots.

Covers: router reboots, DHCP lease expiry, AP channel changes.

### 2. Task watchdog

Initialised in `setup()` via `esp_task_wdt_init(30, true)` and `esp_task_wdt_add(NULL)`. Reset at the top of `loop()`. Any hang longer than 30 seconds triggers an automatic reboot with `reset_reason = TASK_WDT`.

Covers: stuck sockets in `client.readStringUntil`, camera driver hangs, any other deadlock.

### 3. Daily reboot

```c
if (millis() > 24UL*60*60*1000UL) ESP.restart();
```

A crude but effective reliability trick. Clears heap fragmentation, stale TCP state, and anything else that degrades over time.

### 4. Boot-time recovery

- `initEspCamera()` no longer has a `while(true)` hard-lock on camera init failure. It now calls `ESP.restart()` after logging the error.
- `setupWifiConnection()` now has a 30-second initial-connect timeout that also triggers a restart.

Together these ensure no failure mode can leave the device stuck indefinitely.

---

## Telemetry

The ESP piggybacks a JSON telemetry payload onto every image upload as an additional multipart form field called `logs`. The image-service stores it as a sidecar file next to the image. The admin UI fetches it via the backend.

### Payload format

```json
{
  "fw": "1.0.0",
  "uptime_s": 72145,
  "last_reset_reason": "TASK_WDT",
  "free_heap": 124352,
  "min_free_heap": 98211,
  "rssi": -67,
  "wifi_reconnects": 2,
  "last_http_codes": [200, 200, 500, 200, 200],
  "log": "[BOOT] fw=1.0.0 reset_reason=1 boot_count=3\n[WIFI] disconnected — attempting reconnect\n..."
}
```

| Field | Source | Meaning |
|---|---|---|
| `fw` | `FIRMWARE_VERSION` macro | Firmware version string |
| `uptime_s` | `millis()/1000` | Seconds since last boot |
| `last_reset_reason` | `esp_reset_reason()` | `POWERON`, `BROWNOUT`, `TASK_WDT`, `PANIC`, etc. |
| `free_heap` | `ESP.getFreeHeap()` | Current free heap in bytes |
| `min_free_heap` | `ESP.getMinFreeHeap()` | Low-water mark over this boot session |
| `rssi` | `WiFi.RSSI()` | WiFi signal strength in dBm |
| `wifi_reconnects` | logbuf counter | Count of `reconnectWifi()` fires since boot |
| `last_http_codes` | logbuf ring | Last 8 HTTP status codes from `postImage()` |
| `log` | logbuf ring | Last ~2 KB of `logf()` output, oldest→newest |

### Circular log buffer

[ESP32-CAM/logbuf.cpp](../ESP32-CAM/logbuf.cpp) — `logf(fmt, ...)`

A fixed 2 KB ring buffer. `logf()` works like `Serial.printf()` but also appends to the ring. Only events worth sending home go through `logf()`; noisy per-frame traces keep using `Serial.print*`. When the ring wraps, `buildTelemetryJson()` serializes it oldest→newest.

No heap allocation per entry, no dynamic growth — safe to call from anywhere including error paths.

---

## Data flow

```
ESP32-CAM ─── multipart/form-data (mac, battery, logs, image) ──▶  image-service (/upload)
                                                                         │
                                                                         ▼
                                                                   images/<file>.jpg
                                                                   images/<file>.jpg.log.json
                                                                         ▲
                                             GET /modules/<mac>/logs  ◀──┘
                                                     ▲
                              GET /api/modules/:id/logs (proxies, requires X-API-Key)
                                                     ▲
                             HomePage → ModulePanel "Telemetry" collapsible section
```

1. ESP uploads an image. The `logs` part is parsed and written to `{image_path}.log.json`.
2. `GET /modules/<mac>/logs?limit=N` (image-service) globs `*.log.json`, filters by `_mac`, sorts by mtime, returns the newest N entries.
3. `GET /api/modules/:id/logs` (backend) proxies the above behind the existing `X-API-Key` middleware so the frontend can use a single origin.
4. `ModulePanel.tsx` has a collapsible "Telemetry" section that lazy-loads logs when opened.

### Sidecar file contents

Each `.log.json` is the raw telemetry payload plus three fields added by the image-service:

```json
{
  "...telemetry fields...": "...",
  "_mac": "12345678901234",
  "_received_at": "2026-04-11T14:32:17",
  "_image": "esp_capture_20260411_143217.jpg"
}
```

If the ESP ever sends non-JSON, the sidecar still gets written as `{"raw": "...", "parse_error": true, "_mac": ..., ...}` so the admin view can always show *something*.

---

## Reading logs from the admin view

The Telemetry section is **admin-only** and hidden from the normal dashboard. To unlock it:

1. Open the dashboard with `?admin=1` in the URL, e.g. `https://highfive.example.com/dashboard?admin=1`.
2. The admin flag is stored in `sessionStorage` under `hf_admin` and survives navigation within the tab; closing the tab clears it.
3. Click a module pin on the map.
4. In the right-hand **Module Details** panel, expand the **Telemetry** section.
5. The last ten uploads are shown newest-first, with uptime, free heap, WiFi RSSI, last reset reason, WiFi reconnect count, and the last eight HTTP response codes.
6. Expand the **log** dropdown on any entry to see the raw circular-buffer contents from that boot session.

Reading the telemetry is a good first stop whenever a module looks unhealthy: a spike in `wifi_reconnects`, a low `min_free_heap`, or non-2xx `last_http_codes` will usually point at the problem immediately.

### Admin key (backend gate)

On top of the `?admin=1` UI flag, the `GET /api/modules/:id/logs` endpoint is protected by a **separate admin key** layered over the existing `X-API-Key` middleware. The backend requires an `X-Admin-Key` header matching the `ADMIN_API_KEY` environment variable; if the env var is unset, the endpoint fails closed with `503 admin disabled`.

**Deploy:**

1. Generate a random key and put it in the repo root `.env`:
   ```
   ADMIN_API_KEY=replace-with-a-long-random-string
   ```
2. `docker compose up -d --force-recreate backend` — the `docker-compose.yml` forwards `ADMIN_API_KEY` to the backend service automatically.
3. Only people you hand the key to can load telemetry. Everyone else gets a 403 even if they know the `?admin=1` flag.

**Frontend UX:** the admin key is **never** bundled into the JS. The first time a user opens the Telemetry section in a tab, the page prompts for the key via `window.prompt()` and stores it in `sessionStorage['hf_admin_key']` (cleared on tab close). If the backend returns 401/403, the stored key is cleared and re-requested on the next Refresh.

**Scope:** this gate only affects `GET /api/modules/:id/logs`. ESPs post images to `image-service:/upload` directly and are completely unaffected — the upload path has no admin requirement.

---

## Out of scope for v1.0.0

- Refactoring the hot `postImage()` path away from `String` concatenation. The daily reboot + heap telemetry mitigate the fragmentation risk without touching delicate code. Revisit if telemetry shows `min_free_heap` dropping over time.
- Central log database or alerting. Sidecar files on the image-service are enough for a single-operator setup.
- OTA firmware update.
