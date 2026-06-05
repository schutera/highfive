# HiveHive Troubleshooting Guide

Symptom-based guide covering the most common issues during initial hardware setup and ongoing operation. For the full hardware setup walkthrough see [07-deployment-view/esp-flashing.md](07-deployment-view/esp-flashing.md).

---

## Server stack

### Root URLs return 404 / "Cannot GET /"

**Normal behaviour.** The backend and Flask services have no root route. Use the health endpoints instead:

| Service        | Health check URL                   | Expected          |
| -------------- | ---------------------------------- | ----------------- |
| backend        | `http://localhost:3002/api/health` | `{"status":"ok"}` |
| image-service  | `http://localhost:8000/health`     | `ok`              |
| duckdb-service | `http://localhost:8002/health`     | `ok`              |
| homepage       | `http://localhost:5173`            | Dashboard loads   |

### A service fails to start or exits immediately

```bash
docker compose logs <service-name>   # e.g. duckdb-service
```

The most common cause is a missing or malformed `.env` file at the repo root. It must contain at minimum:

```env
DEBUG=true
DUCKDB_SERVICE_URL=http://duckdb-service:8000
```

### Admin page (`/admin`) shows "Failed to load images. Is the image service running?"

**Symptom.** The admin image gallery renders the error banner even though
`pm2 list` shows `image-service` online. `GET /api/images` returns `502`.

**Likely causes, in order.**

1. **Stale backend env after a PM2 restart without `--update-env`.**
   `pm2 restart`/`reload` does not re-read the `env` block in
   `ecosystem.config.js` unless you pass `--update-env`, so the backend
   can keep an old environment from before `IMAGE_SERVICE_URL` was set —
   falling back to the Docker name `http://image-service:4444`, which
   does not resolve on a PM2 host. Check and fix:

   ```bash
   pm2 env 0 | grep -E "IMAGE_SERVICE_URL|DUCKDB_SERVICE_URL"   # is it set?
   getent hosts image-service || echo "Docker name does not resolve here"
   pm2 reload ecosystem.config.js --update-env                  # re-read env
   ```

2. **A slow, un-paginated image list tripping the proxy timeout.** A
   bare `GET /image_uploads` over a large table can take >5s; the admin
   gallery now paginates (newest-first `limit`/`offset`) and the
   image-service proxy timeout is 15s, but a caller that omits `limit`
   still pays the full cost. Time the hops to locate the slow one:

   ```bash
   curl -s -o /dev/null -w "image:  %{http_code} %{time_total}s\n" http://127.0.0.1:4444/images
   curl -s -o /dev/null -w "duckdb: %{http_code} %{time_total}s\n" http://127.0.0.1:8000/image_uploads
   ```

   "Is the service running?" is usually the wrong question — confirm the
   _path_ end-to-end before concluding a service is down. See chapter 11
   "failed to load images" for the full incident.

### `duckdb-service` exits with `RuntimeError: module_configs status-drop migration failed`

**Symptom.** Container restart loop with a `RuntimeError: module_configs status-drop migration failed: ...` traceback in `docker compose logs duckdb-service`. The transactional rebuild migration (issue #69) refused to mid-state the DB and rolled back; the container is refusing to serve a half-migrated schema.

**Why it happens.** The migration in `duckdb-service/db/schema.py`'s `init_db` rebuilds three tables (`module_configs`, `nest_data`, `daily_progress`) in a single transaction to drop the dead-weight `status` column on existing volumes. If any step inside the transaction raises — disk full, lock contention, an unexpected column type drift — the whole rebuild rolls back to leave the original DB intact. The container then re-raises rather than serving the un-migrated schema (the next `add_module` would 500 on the `NOT NULL CHECK` constraint).

**Fix.**

```bash
# 1. Inspect the rolled-back state — `status` column should still be present.
docker compose -f docker-compose.prod.yml --env-file .env.production exec duckdb-service \
  python -c "from db.connection import lock, get_conn
with lock:
    print([c[1] for c in get_conn().execute('PRAGMA table_info(module_configs)').fetchall()])"

# 2. Back up the volume before any further attempt.
docker compose -f docker-compose.prod.yml --env-file .env.production exec duckdb-service \
  cp /data/app.duckdb /data/app.duckdb.bak.$(date +%Y%m%d-%H%M%S)

# 3. Read the original error from `docker compose logs duckdb-service`,
#    address the root cause (disk space, schema drift, etc.), restart.
```

If the migration repeatedly fails for a reason that isn't immediately obvious, restore from the backup and open an issue with the full traceback — do **not** manually `ALTER TABLE ... DROP COLUMN` in the duckdb CLI; DuckDB v1.4 refuses that operation when a foreign key references the table, which is exactly why the rebuild migration exists.

### Dashboard map opens on Lake Constance instead of near me

**Symptom.** You loaded the dashboard fresh (no module selected) and the map opened on Lake Constance / central Europe rather than around your region. You expected the "first-paint near you" behaviour from [issue #14](https://github.com/schutera/highfive/issues/14).

**Why it happens.** `GET /api/user-location` returned a non-200 — either:

- **204 No Content** — your IP resolved to a loopback or private range. Common when developing against `localhost`, behind a VPN that exits to a private network, or on a corporate NAT that strips X-Forwarded-For.
- **503 Service Unavailable** — the upstream IP-geolocation provider (ipapi.co) was rate-limited or unreachable. Free tier is 30 k requests/month/IP.

The frontend treats both as "no hint" and falls back to the default centre — by design, see [ADR-012](09-architecture-decisions/adr-012-dashboard-ip-geo-hint.md).

**Fix.** Click the GPS-crosshair button in the map's top-right corner. The browser will prompt for location permission; allow once and the map will fly to your precise position. The permission grant is remembered per origin, so subsequent dashboard loads still need an explicit click but skip the prompt.

If you want to verify the backend path:

```powershell
curl.exe -H "X-API-Key: hf_dev_key_2026" http://localhost:3002/api/user-location -i
```

Status `204` confirms private-IP short-circuit; status `503` confirms the upstream is down; status `200` with a JSON body means the hint should be reaching the map — file an issue with the request/response.

---

## ESP32-CAM hardware

### Do I need an FTDI adapter to flash?

Only if you have a **bare ESP32-CAM board** (no USB port). The **ESP32-CAM-MB** variant has a built-in CH340 USB-serial chip and a micro-USB port — plug it directly into your PC. You can identify it by the "ESP32-CAM-MB" label on the board and the micro-USB connector.

### Flash mode — upload hangs at "Connecting…"

The IO0 pin must be grounded **before** the reset signal is sent.

1. Hold **IO0** (BOOT) down.
2. Press and release **RST** while still holding IO0.
3. Release IO0.
4. Start the upload within a few seconds.

If it still hangs, check the USB cable (some cables are charge-only) and the COM port selection.

### Setup wizard step 2 says "/firmware.bin not found" / 404

The wizard pins firmware to a local `homepage/public/firmware.bin`
file (commit `f7300b9`). That file is **not** checked in — it lands
there only after `ESP32-CAM/build.sh` runs:

```bash
cd ESP32-CAM
./build.sh                # writes homepage/public/firmware.bin + firmware.json
```

`build.sh:33-37` writes the manifest and binary together. Without that
build step, step 2 of the wizard 404s on the OTA URL. If you've never
flashed firmware on this checkout, run `build.sh` first; on shared
checkouts, regenerate after every firmware change.

### ArduinoOTA LAN push fails on Windows ("No response from the ESP")

**Symptom.** `pio run -e esp32cam_ota -t upload --upload-port <module-ip>` prints `Sending invitation to <IP> ..........` for ~100 s then exits with `No response from the ESP`. The serial monitor meanwhile shows `[OTA] LAN update start` and then immediately `[OTA] LAN update error 2/3/4` — the ESP received the invitation but the TCP data transfer fails.

**Root cause.** espota picks a random ephemeral port each run (e.g. 10090, 44920, 45064) for its callback TCP server. Windows Firewall blocks these random inbound TCP connections. The ESP connects to the port from the invitation packet, but espota's TCP server is unreachable so the connection drops with 0 bytes transferred.

**Fix — three parts, done once per developer machine.**

**Part 1 — permanent firewall rule** (admin PowerShell, one time):

```powershell
# Remove any previous narrow rule first
Remove-NetFirewallRule -DisplayName "HiveHive ArduinoOTA" -ErrorAction SilentlyContinue

# Allow the fixed espota callback port
New-NetFirewallRule -DisplayName "HiveHive ArduinoOTA" -Direction Inbound -Protocol TCP -LocalPort 55555 -Action Allow -Profile Any
```

**Part 2 — switch the WLAN profile to Private** (admin PowerShell, one time per home network — Public-profile WiFi silently drops inbound TCP from LAN devices even with explicit Allow rules):

```powershell
Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private
```

**Part 3 — platformio.ini** (already committed, no action needed):

`ESP32-CAM/platformio.ini` defines a separate `[env:esp32cam_ota]` that sets `upload_protocol = espota` and `upload_flags = --host_port=55555`. This pins espota to port 55555 on every run, so the single firewall rule above always applies. The default `[env:esp32cam]` deliberately keeps no upload-protocol pin so `pio run -e esp32cam -t upload --upload-port COM9` continues to USB-flash without override — dev iteration over USB stays unaffected.

**Verify the rules are in place:**

```powershell
Get-NetFirewallRule -DisplayName "HiveHive*" | Select-Object DisplayName, Enabled, Action
```

Expected output includes all three HiveHive rules (image-service 8000, duckdb-service 8002, ArduinoOTA 55555) with `Action = Allow`.

### PlatformIO not found / "No module named platformio"

Multiple Python versions on the same machine can cause this. Find where PlatformIO was installed:

```bash
pip show platformio   # shows the Python environment it lives in
```

Then call it with the explicit interpreter:

```bash
# Windows
& "C:\Users\<you>\AppData\Local\Programs\Python\Python311\python.exe" -m platformio run -e esp32cam --target upload --upload-port COM9

# Find your default Python
where python   # Windows
which python3  # Linux/Mac
```

---

## Access point and configuration form

### The Wi-Fi network is named "ESP32-Access-Point", not "HiveHive-Access-Point"

The access point name in the firmware is `ESP32-Access-Point` with password `esp-12345`. The documentation previously had an incorrect name.

### Configuration form reloads blank after clicking Save

**Symptom:** you fill in all fields, click Save Configuration, and the form reappears empty with no confirmation message.

**Cause:** the form uses a session token to prevent stale submissions. Some browsers (including Brave) fail to include this token in the POST request.

**Fix:** use **Chrome or Firefox**. Open a fresh tab to `http://192.168.4.1` — do not use a cached page.

### Config page didn't close itself / wizard didn't advance after saving

**Symptom:** you saved Wi-Fi credentials and saw the "Saved — your
module is connecting" banner, but the config tab stayed open and the
setup wizard did not move to the verification step on its own.

**Cause:** on save, the config page posts a `hivehive-config-saved`
message back to the wizard and calls `window.close()` so the operator
is returned to the wizard automatically. Some in-app and
privacy-hardened browsers block `window.close()` and/or
`postMessage` from a script-opened window, so neither signal lands.

**Fix:** switch back to the HiveHive tab manually, then click the
de-emphasized **"I've finished configuring"** fallback link on wizard
**Step 4** to advance to verification. The save already succeeded — the
module is connecting regardless of whether the page auto-closed.

### Board crashes and reboots every ~44 seconds in AP mode (firmware before fix)

**Symptoms:**

- Serial log shows `task_wdt: Task watchdog got triggered` and `abort()` followed by `Rebooting...`
- `config.json not found, using defaults` appears on every boot despite having saved the config
- `boot_count` in the serial log climbs rapidly

**Cause:** the task watchdog (30 s timeout) was initialised in `setup()`, but `setup()` blocks inside the AP web server loop waiting for user input. The `loop()` function — where the watchdog reset was called — never ran during AP mode.

**Fix:** resolved in `ESP32-CAM/host.cpp` — `esp_task_wdt_reset()` is now called inside `runAccessPoint()`'s loop. Reflash with the latest firmware:

```bash
cd ESP32-CAM
pio run -e esp32cam --target upload --upload-port <port>
```

**Verify the fix:** after booting, the board should remain in AP mode indefinitely. `boot_count` should increment only on intentional resets.

### How to read serial output for diagnosis

```bash
# Interactive (most setups)
pio device monitor --port COM9 --baud 115200
# Press RST on the board after starting the monitor
```

If the monitor connects but shows nothing after RST, use the file-capture method:

```python
import serial, time

s = serial.Serial('COM9', 115200, timeout=0.5, rtscts=False, dsrdtr=False)
s.setRTS(False)
s.setDTR(False)
# Press RST now
deadline = time.time() + 20
buf = b''
while time.time() < deadline:
    data = s.read(256)
    if data:
        buf += data
s.close()
open('esp_log.txt', 'wb').write(buf)
```

---

## Wi-Fi connection

### ESP32 won't join the network

**2.4 GHz only.** The ESP32 does not support 5 GHz. If your router uses the same SSID for both bands (band steering), the ESP32 should be steered to 2.4 GHz automatically — but aggressive band-steering implementations may reject it. Test with a phone hotspot set explicitly to 2.4 GHz to isolate the issue.

**SSID is case-sensitive and special characters matter.** `FRITZ!Box 5590 KN` ≠ `Fritz!box 5590 KN`. Copy-paste the SSID from your device's Wi-Fi settings rather than retyping it.

**Verify the module joined the network:** check your router's admin page (e.g. `192.168.178.1` for FritzBox) for a new device. Its MAC address is printed during the firmware flash:

```
MAC: 08:3a:f2:6e:69:b0
```

Also look at the serial log: a join failure now prints the SSID and the resolved `WL_*` status code (e.g. `WL_NO_SSID_AVAIL` for a typo, `WL_CONNECT_FAILED` for a bad password) alongside the running fail counter.

### LED flashed three times after WiFi config — what now?

Three quick pulses (~450 ms total) means the most recent WiFi join timed out. The board reboots after a 1-second hold and tries again. After **three consecutive failures (~90 s)** the firmware automatically drops back to AP-config mode and the `ESP32-Access-Point` SSID returns on your phone's WiFi list. No manual factory-reset hold needed for a mistyped password.

Note: the LED stays silent in AP mode — the on-board LED is the camera flash, so steady-state signalling would be obnoxious. Use the phone's WiFi list to confirm the captive portal is back, not the LED.

### Reconfigure or reset a module

To put a configured module back into its WiFi-only setup page — new SSID, changed password, or a full wipe — **re-flash it**. Flashing now does a full chip erase, which clears the saved config (the `configured` flag in NVS and `/config.json` in SPIFFS), so the module boots straight back into AP-config mode.

1. Re-flash via the homepage setup wizard **Step 2** (or the standalone web installer). The flash erases the saved config as a side effect.
2. After the flash completes, the module reopens the `ESP32-Access-Point` SSID and serves its WiFi setup page at <http://192.168.4.1>. Reconnect to it and enter the new credentials.

There is no separate in-band reset button anymore — flashing _is_ the reset. The captive portal exposes Wi-Fi configuration only.

**If you only want to move the module to a different network**, you don't even need to re-flash: cause three consecutive WiFi-join failures and the module's auto-fallback re-opens `ESP32-Access-Point` on its own. The least disruptive way: reconnect to `ESP32-Access-Point`, open <http://192.168.4.1>, and save intentionally wrong WiFi credentials — the board fails three times (~90 s total) and reopens the AP automatically.

> The "hold IO0 for 5 seconds" procedure documented in older guides did not work — GPIO0 is a strap pin and holding it LOW at boot puts the ESP32 into UART download mode instead of running the firmware. Removed in #40; see chapter 11 "Lessons learned" for the post-mortem.

---

## Module joins Wi-Fi but never appears on the dashboard

### ESP and server are on different networks

The ESP32 must be able to reach the server's IP. A common mistake is configuring the module to join a phone hotspot while the server runs on the home router — those are separate networks.

**Rule:** the ESP32 must join the **same network** the server is on. Production modules reach `https://highfive.schutera.com` (baked in at build time, no operator action). For a **local dev** stack, the server URL is set from the host's **LAN IP** via the gitignored `ESP32-CAM/DEV_SERVER_HOST` build file — not `localhost`, which would resolve to the ESP32 itself.

Find your LAN IP: `ipconfig` (Windows, look at WLAN/Ethernet adapter), `ip addr` (Linux/Mac).

### Windows Firewall blocking inbound connections

Docker exposes ports 8000 and 8002 on the host, but Windows Firewall may block inbound TCP from LAN devices. Add explicit allow rules once in an **admin PowerShell**:

```powershell
New-NetFirewallRule -DisplayName "HiveHive image-service (8000)" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "HiveHive duckdb-service (8002)" -Direction Inbound -Protocol TCP -LocalPort 8002 -Action Allow -Profile Any
```

### Watch live server traffic to confirm receipt

```bash
docker compose logs -f duckdb-service image-service
```

A successfully registering module produces a `POST /new_module` line in `duckdb-service` logs, followed by `POST /upload` lines in `image-service` logs as images start arriving.

### Confirm registration via API

```bash
curl http://localhost:8002/modules
```

Your module should appear with its MAC-derived ID, name, and battery level. The dashboard-derived `Module.status` (`'online' | 'offline' | 'unknown'`) only exists on the **backend's** `/api/modules` response — duckdb-service's direct `/modules` response does not carry a `status` field after [#69](https://github.com/schutera/highfive/issues/69); status is computed from `lastSeenAt` in `backend/src/database.ts`'s `fetchAndAssemble`.

### Module is registered but never shows up on the dashboard **map**

**Symptom.** `curl http://localhost:8002/modules` lists the module (so
it joined Wi-Fi and registered fine), but it never appears on the
dashboard map — the marker is simply absent.

**Cause.** The firmware was built **without a `GEO_API_KEY`**. A keyless
binary skips the first-boot Google Geolocation lookup, so the module
reports `(latitude=0, longitude=0, accuracy=0)`. The homepage map
filters that `(0, 0)` Null Island sentinel client-side, so the module
plots nowhere. Confirm by checking the module's stored coordinates:

```bash
curl http://localhost:8002/modules   # look for lat/lng both 0
```

**Fix.** Rebuild the firmware **with** the Geolocation API key set, then
re-flash:

```powershell
# Windows / PowerShell — from repo root, key in env or ESP32-CAM\GEO_API_KEY
"AIza<your-google-geolocation-api-key>" | Out-File -NoNewline -Encoding ascii ESP32-CAM\GEO_API_KEY
bash ESP32-CAM/build.sh
```

`build.sh` now **errors and exits** when no key is found, so a keyless
release binary can no longer be produced by accident — this symptom only
occurs with a binary built before that guard, or one built deliberately
with the `HF_ALLOW_NO_GEO_KEY=1` escape hatch (a CI compile check that
should never be flashed). See
[07-deployment-view/esp-flashing.md → "Provide the Geolocation API key"](07-deployment-view/esp-flashing.md#provide-the-geolocation-api-key-one-time-before-first-build)
and [08-crosscutting-concepts/auth.md → "Third-party API keys: Geolocation"](08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).

> A module whose **boot-time** lookup failed transiently (flaky Wi-Fi,
> not a missing key) can self-recover: the firmware's deferred-retry
> path attaches a fresh fix to a later heartbeat and duckdb-service
> patches the `(0, 0)` row (issue #89). That path needs a key baked in —
> it does nothing for a keyless build.

**Cause 2 — Google rotated its CA and the firmware pins the wrong root
(fixed in `longhorn` / OTA seq 3).** If the key _is_ baked in but the
module _still_ sits at `(0, 0)` on **every** boot/heartbeat (and no
`[heartbeat] patched … lat/lng` ever appears in `duckdb-service` logs),
the Google Geolocation TLS handshake is failing peer verification. The
firmware pins a specific Google Trust Services root; `www.googleapis.com`
rotated its served chain from `GTS Root R1` (RSA) to `GTS Root R4` (ECC),
so a binary that trusted only R1 rejected every handshake → `(0, 0)`.
Isolate it from the prod box (the key is never printed):

```bash
# 1) Is the key/quota OK?  200 + a {"location":…} body = key is fine.
curl -sX POST "https://www.googleapis.com/geolocation/v1/geolocate?key=$(tr -d '[:space:]' < ESP32-CAM/GEO_API_KEY)" \
  -H 'Content-Type: application/json' --data '{"considerIp":true}'
# 2) Which root does the chain use now?  (the last 's:'/'i:' line)
echo | openssl s_client -connect www.googleapis.com:443 -servername www.googleapis.com 2>/dev/null | grep -E ' s:| i:'
```

**Fix.** The geolocation call now pins `hf::tls::kGoogleApisCaBundlePem`
(GTS Root R1 **+** R4), so it verifies against either chain. Rebuild and
re-flash / OTA (`longhorn` already carries it). If Google rotates to a
_new_ root again, add that root's PEM to the bundle in
[`ESP32-CAM/lib/tls_roots/tls_roots.h`](../ESP32-CAM/lib/tls_roots/tls_roots.h)
and bump the firmware — see [ADR-010](09-architecture-decisions/adr-010-esp-firmware-tls-trust-model.md)
and the chapter-11 lesson "Pinned `GTS Root R1` for geolocation".

---

## Useful commands reference

```bash
# Find COM port (Windows)
Get-PnpDevice -Class Ports | Select-Object Status, FriendlyName

# Watch all service logs (filter out health-check noise)
docker compose logs -f --tail=20 duckdb-service image-service | grep -v "GET /health"

# Check ARP table for new devices on LAN
arp -a

# Verify firewall rules for HiveHive ports (Windows)
Get-NetFirewallRule -DisplayName "HiveHive*" | Select-Object DisplayName, Enabled, Action
```
