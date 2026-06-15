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

### Admin login "succeeds" but every admin action still 401s (cookie not set)

The admin session is an `HttpOnly` cookie set by `POST /api/admin/login`
(#142 / ADR-019). If the cookie never sticks, the SPA looks logged-in for a
moment but `DELETE`/`PATCH`/`/logs` calls return `401`. Three usual causes:

- **`Secure` cookie over plain http.** In production the cookie is `Secure`, so
  it is silently dropped unless the page is served over HTTPS. It is set
  non-`Secure` only when `NODE_ENV` is a dev token (`''`/`development`/`test`,
  see `backend/src/env.ts`). A prod-mode backend behind plain http will never
  store the cookie — terminate TLS (host-Nginx) first.
- **`Access-Control-Allow-Origin: *` with credentials.** Browsers refuse to send
  or store a cookie on a credentialed cross-origin request whose ACAO is `*`.
  The backend uses an explicit origin (prod) or reflects the request origin
  (dev); if you customise CORS, never pair `*` with `credentials: true`.
- **Missing `credentials: 'include'`.** The homepage client sets this on every
  request; a hand-rolled `fetch`/`curl` must opt in (`curl -c jar -b jar …`) or
  the cookie is neither stored nor replayed.

For scripts/CI, skip the cookie entirely and send the machine credential:
`-H "X-Admin-Key: $HIGHFIVE_API_KEY"`.

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

### Bulk-deleting a module's images (cleanup after a capture-loop flood) — and the Windows parallel-`curl` trap

**Symptom / task.** A module sent thousands of images (e.g. a stuck capture loop) and you need to delete all but a known-good handful, for **one** module only. There is **no bulk-delete endpoint** — you loop the per-file admin route `DELETE /api/images/<filename>` (it removes the DuckDB row _and_ the on-disk file; idempotent — an already-gone file returns `404`, which is success).

**Two gotchas this earns:**

1. **Matching gallery screenshots to server rows: filename is LOCAL time, `uploaded_at` is UTC.** The firmware names files in device-local time (`createFileName` in `ESP32-CAM/client.cpp`, TZ `CET-1CEST` set in `ESP32-CAM/esp_init.cpp`), so `esp_capture_20260613_120013.jpg` (12:00:13 CEST) is the same image the admin gallery shows as `uploaded_at` `10:00:14` UTC — a 1–2 h offset. Match on **date + filename**, not on the displayed clock. (Older rows may also carry a `<mac>_` filename prefix; the convention changed mid-history — never strip/assume it, read the real `filename` from `GET /api/images`.)
2. **On Windows, do NOT fan out parallel `curl.exe` processes** (e.g. `xargs -P 8`). They return HTTP `000` (connection-level failure) and delete **nothing** — silent no-op. Use a **single** `curl` process with connection keep-alive, reading a `-K` config file of `url = "…"` lines. One process, reused TLS connection, reliable, ~10–20 req/s. (The duckdb writer serialises on a lock anyway, so parallelism buys nothing.)

**Recipe (PowerShell).** Build the keep-list, derive the delete-list from the public listing, then drive one keep-alive `curl`:

```powershell
$mac = "b0696ef23a08"
$key = "<HIGHFIVE_API_KEY>"   # prod admin key; sent as X-Admin-Key, never logged
$base = "https://highfive.schutera.com"
# 1. Pull the full row list (public read; omit limit = all rows)
curl.exe -s "$base/api/images?module_id=$mac" -o images.json
# 2. In a scratch .py: load images.json, subtract your keep-set of filenames,
#    write one `url = "https://.../api/images/<filename>"` line per delete
#    into cfg.txt, prefixed by:  request = "DELETE"  /  header = "X-Admin-Key: <key>"
# 3. One process, connection reuse, capture status per request:
curl.exe -s -K cfg.txt -o $null -w "%{http_code}`n" --retry 2 | Sort-Object | Group-Object
# 4. Verify: total must equal your keep count
curl.exe -s "$base/api/images?module_id=$mac&limit=1"
```

Expect only `200` (deleted) and `404` (already gone) — any `000`/`5xx` means the run isn't reaching the server, stop and investigate. **The UI count self-corrects:** the dashboard/admin "IMAGES" value is the live `real_image_count` ([`backend/src/database.ts`](../backend/src/database.ts)'s `fetchAndAssemble`), not the increment-only `module_configs.image_count`, so it drops as you delete — no separate counter fix needed.

---

## ESP32-CAM hardware

### Do I need an FTDI adapter to flash?

Only if you have a **bare ESP32-CAM board** (no USB port). The **ESP32-CAM-MB** variant has a built-in USB-serial chip and a micro-USB port — plug it directly into your PC. You can identify it by the "ESP32-CAM-MB" label on the board and the micro-USB connector. The built-in chip is usually a CH340, but some units ship a CP210x or an FTDI FT232R — which one matters for the **Windows driver**, see the next two entries and the [chip→driver table in esp-flashing.md](07-deployment-view/esp-flashing.md).

### New board enumerates but no COM port appears (FTDI FT232R)

**Symptom.** You plug in a new board and no `COMx` shows up. Device Manager (or `Get-PnpDevice -PresentOnly | ? { $_.InstanceId -match 'VID_0403' }`) lists an **`FT232R USB UART`** with a warning triangle / `Error` status, and `esptool ... flash-id` fails with "could not open port / port doesn't exist".

**Root cause.** The board's USB-serial chip is an **FTDI FT232R** (`VID_0403&PID_6001`), and the FTDI VCP driver is **not shipped with Windows** (unlike CH340/CP210x, which are inbox or auto-pulled). With no driver bound, Windows assigns no COM port. The previous board "just worked" because it was a CH340, whose driver was already installed.

**Fix (needs admin).** Get the FTDI driver bound so the COM-port child device is created:

```powershell
# From an ADMIN PowerShell. Re-scan + force a driver (re)bind for the device.
pnputil /scan-devices
$inst = (Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0403&PID_6001' }).InstanceId
Disable-PnpDevice -InstanceId $inst -Confirm:$false; Start-Sleep 2; Enable-PnpDevice -InstanceId $inst -Confirm:$false
```

Then confirm a COM port now exists (any shell):

```powershell
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_0403' } | Select-Object Status, Class, FriendlyName
# Expect a second row: Class=Ports, FriendlyName='USB Serial Port (COMxx)'
```

If `pnputil`/disable-enable doesn't pull it (offline, or WU driver search disabled), open **Device Manager → the FT232R device → Update driver → Search automatically** (needs internet; Windows Update hosts the FTDI driver), or install the FTDI VCP driver from <https://ftdichip.com/drivers/vcp-drivers/>. There is no `winget` package for it.

### `flash read err` / endless boot loop / esptool `MD5 ... does not match` (flash at 1.8 V — SD card on GPIO12)

**Symptom.** A board boot-loops with ROM messages like `flash read err, 1000` / `ets_main.c 371`, or repeated `***ERROR*** A stack overflow in task` / `TG1WDT_SYS_RESET` **before any firmware banner prints**. `esptool erase-flash` claims success in "0.0 seconds" (a real erase takes ~14 s for 4 MB), and `pio run -t upload` fails verification with **`A fatal error occurred: MD5 of file does not match data in flash!`**.

**Root cause.** The ESP32 reads **GPIO12 at reset** to set the flash regulator (low/floating → 3.3 V, high → 1.8 V). The micro-SD slot shares GPIO12, so **an inserted SD card pulls it high**, running the 3.3 V flash chip at 1.8 V. Flash reads/writes are then unreliable — hence the ROM read errors, fake erases, and MD5 mismatches.

**Fix.** Eject the micro-SD card (and disconnect anything wired to GPIO12), then confirm the strap with a read-only probe:

```powershell
$PORT = "COM13"   # your board's port
py -3.12 -m esptool --port $PORT --baud 115200 flash-id
# Must report: Flash voltage set by a strapping pin: 3.3V   (not 1.8V)
# (esptool v4+ also accepts the legacy `flash_id` spelling.)
```

Once it reads **3.3 V**, erase + flash succeed normally (the erase now takes real seconds, and the upload's `Hash of data verified.`). Hardware background: [hardware-notes.md → "Flash voltage strap"](08-crosscutting-concepts/hardware-notes.md).

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

### Serial shows `-- PSRAM: found=0` on a `build.sh` / OTA binary (but `pio` builds report `found=1`)

The board has working PSRAM, but a `build.sh`-built binary boots with it off
and `initEspCamera` falls back to `FRAMESIZE_VGA` + `CAMERA_FB_IN_DRAM` +
`jpeg_quality 15` (degraded ~10–13 KB frames). `pio run -e esp32cam` on the same
board is fine (`found=1`, ~22–37 KB frames). Root cause: the `build.sh` FQBN
omitted `FlashMode=dio`, so arduino-cli took the core default `build.boot=qio`
and linked the `qio_qspi` precompiled libs + bootloader — but `build.sh` flashes
in **dio** mode (`FLASH_MODE=dio`). That `qio` libs / `dio` flash mismatch makes
`esp_psram_init()` fail at boot. pio pins `flash_mode=dio` → `dio_qspi`, so it
always worked. Fix (already in `build.sh`): FQBN
`esp32:esp32:esp32cam:FlashMode=dio`, which sets both `build.flash_mode=dio` and
`build.boot=dio` → `dio_qspi` libs matching the dio flash. Confirm the build
linked the right memory_type:

```powershell
Select-String -Path ESP32-CAM/build/compile.log -Pattern '/dio_qspi' | Select-Object -First 1   # expect a hit
Select-String -Path ESP32-CAM/build/compile.log -Pattern '/qio_qspi' | Select-Object -First 1   # expect NOTHING
```

`build.sh` now aborts the build unless `dio_qspi` was linked (and `-DBOARD_HAS_PSRAM`
reached g++ — a separate, also-required guard). Note: a clean compile-flag audit is
**not** sufficient proof — restoring `-DBOARD_HAS_PSRAM` alone did not fix `found=0`;
only flashing the release binary and reading `-- PSRAM: found=1` over serial does.
Full background:
[risks ch. 11 → "`build.sh` release binaries ran without PSRAM"](11-risks-and-technical-debt/README.md#lessons-learned)
(#163).

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

### Bluetooth mouse/keyboard drops when joining the module's Wi-Fi (laptop freezes at Step 3)

**Symptom:** you click `ESP32-Access-Point` in the laptop's Wi-Fi list, and
your Bluetooth mouse and keyboard immediately stop responding ("the computer
froze"). The OS password prompt is on screen, but you have no working input
device to type `esp-12345` into it, so setup wizard **Step 3** can never
complete.

**Cause:** most laptops use a **combo Wi-Fi + Bluetooth card sharing a single
2.4 GHz radio** (Intel AX2xx, Realtek, …). The ESP softAP is 2.4 GHz-only
(`WiFi.softAP(HOST_SSID, HOST_PASSWORD, 1, 0)` in `ESP32-CAM/host.cpp`), so
when the card switches to 2.4 GHz to join the AP it starves the Bluetooth
side and BT HID peripherals drop. This is a host-side radio-coexistence
quirk — **not** a firmware bug and not a crash; the machine is fine, you just
lose input. The ESP32 has no 5 GHz radio, so there is no firmware-side fix.

**Fix (recommended): pair from your phone.** A phone has its own radio and a
touchscreen, so the coexistence fight and the BT peripherals are out of the
loop entirely:

1. Phone → Settings → Wi-Fi → `ESP32-Access-Point`, password `esp-12345`.
2. Open `http://192.168.4.1` in **Chrome or Firefox** (not Brave — it
   silently breaks the form).
3. Fill the form (home 2.4 GHz Wi-Fi SSID + password) → Save Configuration.

**Fix (stay on the laptop):** use a **wired USB** or the **built-in**
keyboard/trackpad — a 2.4 GHz USB dongle has the same shared-radio problem,
so it must be wired or built-in. Joining via a saved `netsh wlan` profile
also avoids typing into the OS popup:

```powershell
$AP = "ESP32-Access-Point"
netsh wlan connect name="$AP"
```

(if the profile does not exist yet, add it once with
`netsh wlan add profile filename="esp32-ap.xml"` — see
[08-crosscutting-concepts/hardware-notes.md](08-crosscutting-concepts/hardware-notes.md)
"Host-side Wi-Fi/Bluetooth radio coexistence").

The setup wizard Step 3 now surfaces the phone-first path inline. Related: #137.

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

### Module registered to production instead of my local dev stack

The server URL is **baked at build time, not set in the captive portal** — the `192.168.4.1` page only takes Wi-Fi SSID + password (ADR-018), so there is no "localhost/server" field. A firmware built **without** `DEV_SERVER_HOST` bakes the production URLs, so the module registers to `https://highfive.schutera.com` no matter which Wi-Fi you give it.

**Prevent it (clean dev flash):** flash with `make flash-dev`, which sets `HF_DEV_BUILD=1` and **hard-fails if `DEV_SERVER_HOST` is unset** — so a dev flash can never silently bake production URLs. It registers the module to your dev stack from first boot, and `pio run -t upload` preserves Wi-Fi between iterations (see [Clean dev flash](07-deployment-view/esp-flashing.md#clean-dev-flash-that-never-touches-production-make-flash-dev)):

```powershell
$env:DEV_SERVER_HOST = "192.168.1.50"   # your PC's LAN IP, reachable from the ESP (not localhost)
make flash-dev PORT=COM9
```

**Fix an already-flashed (or already-strayed) module without rebuilding:** retarget it over USB serial (issue #156). Open an interactive monitor, press **RST**, and type `set-server 192.168.1.50` when `[serial] dev console ready` appears — it rewrites `/config.json` and re-runs `loadConfig` so **this** boot's registration goes to the dev stack (see [Retarget without rebuilding](07-deployment-view/esp-flashing.md#retarget-a-flashed-module-without-rebuilding-usb-serial)):

```powershell
pio device monitor -e esp32cam -p COM9   # press RST, then type: set-server 192.168.1.50
```

**A module already registered to the wrong server keeps reappearing there on its next boot/heartbeat until it is retargeted or re-flashed** — so delete the stray module from that server's `/admin` **after** the retargeted firmware is confirmed running against the dev stack, never before, or the next registration just recreates it.

Find your LAN IP: `ipconfig` (Windows, look at WLAN/Ethernet adapter), `ip addr` (Linux/Mac).

### `make flash-dev` fails with `'HF_DEV_BUILD' is not recognized` / `Der Befehl "HF_DEV_BUILD" ... konnte nicht gefunden werden`

On Windows, GNU `make` runs recipe lines through **cmd.exe**, not `sh`. A recipe written as `VAR=1 some-command` (a bash inline env-var prefix) makes cmd.exe try to run a program literally named `HF_DEV_BUILD=1`, which fails. The `flash-dev` target sets the variable as a target-specific **exported make variable** (`flash-dev: export HF_DEV_BUILD := 1`) precisely so it works under both shells; if you hit this error you are on an older Makefile — `git pull`.

Make-free fallback (sets the env var the PowerShell way, then calls `pio` directly):

```powershell
$PORT = "COM13"
$env:HF_DEV_BUILD = "1"
cd ESP32-CAM ; pio run -e esp32cam -t upload --upload-port $PORT ; cd ..
Remove-Item Env:\HF_DEV_BUILD
```

`DEV_SERVER_HOST` must still be set (env var or `ESP32-CAM/DEV_SERVER_HOST` file) or the build hard-fails by design. **Lesson** (general): never use a bash `VAR=val cmd` prefix in a Makefile recipe that must run on Windows — use a target-specific `export`.

### Verifying the dev stack reachability during ESP testing (don't trust a host-side LAN-IP probe)

Two traps when checking whether the ESP can reach your `docker compose` stack, both observed during #156 hardware testing:

- **`curl http://localhost:8002/health` works but `curl http://<your-LAN-IP>:8002/health` times out _from the same PC_ — yet the ESP reaches `<LAN-IP>:8002` fine.** This is Docker Desktop (WSL2 backend) port-publishing: the host loopback-to-own-LAN-IP hairpin isn't wired up, but inbound traffic from a real LAN device (the ESP) is forwarded normally. So a failing host-side LAN-IP probe does **not** mean the stack is unreachable — confirm with the ESP's own serial log (`heartbeat HTTP/1.1 200 OK`, `upload responded with status: 200`) or `curl localhost`. The authoritative check is server-side: `curl -s http://localhost:8002/modules` and look for your module's `last_seen_at` advancing.
- **Use `curl.exe`, not PowerShell `Invoke-WebRequest`/`Invoke-RestMethod`, for these probes.** `Invoke-*` honour the WinINET system proxy and will time out against `localhost`/LAN hosts if a proxy is configured; `curl.exe -s --noproxy "*"` bypasses it. (If you must use `Invoke-*`, pass `-Proxy ''` / `-NoProxy` on PS 6+.)

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

## Module was online, then greys out and reboot-loops after the `longhorn` OTA

**Symptom.** A module that heartbeated reliably starts going grey on the
dashboard. Server-side, its `/heartbeats/<id>` history shows every heartbeat
at a tiny `uptime_ms` (~15–20 s, i.e. a fresh boot each time) and nginx logs
show repeated `POST /new_module` (sent only from `setup()`) — i.e. it is
**reboot-looping**, roughly every 25–30 minutes, then goes silent.

**Cause.** The `longhorn` geolocation fix (above) made the googleapis TLS
handshake _succeed_ where it used to fail-fast — but the geolocation
`HTTPClient` call had **no timeout**, so the now-completing call (or a stalled
handshake; the ESP32 default handshake timeout is 120 s) can block past the
60 s task watchdog and reboot the device. The 30-min cadence is the loop's
geolocation deferred-retry. Full write-up: chapter-11 lesson "A fix that makes
a failing network call _succeed_ exposes the now-longer path".

**Isolate it (server-side, no serial needed).**

```bash
# Tiny uptime_ms on consecutive heartbeats = boot loop (run on the prod host)
curl -s "http://127.0.0.1:8000/heartbeats/<module_id>?limit=12" | python3 -m json.tool
# Repeated /new_module from one IP in a short window = repeated boots
grep -hE "POST /new_module" /var/log/nginx/access.log* | tail
```

**Fix.** `carpenter` / OTA seq 4 bounds the handshake/connect/read timeouts
and adds a free-heap preflight in `attemptGeolocation`. **Flash one module via
serial first** and confirm from the boot log (`esp_reset_reason` + the
issue-#42 breadcrumb) before OTA-ing the fleet. Do not roll back to `mining`
(`allow_downgrade:false`; seq only moves forward).

> **Note:** there is no real battery sensing. Pre-`carpenter` firmware sent
> `random(1,100)`; `carpenter`+ omits battery from the heartbeat entirely and
> sends a `0` sentinel only on upload (for `module_configs.battery_level`, which
> the `/upload` endpoint requires). Either way it is **not** a real charge
> level — don't diagnose power problems from it.

### The "possible reboot loop" banner / heartbeat diagnostics don't appear on the dashboard (#172)

**Symptom.** A module is reboot-looping (per the server-side check above) but
opening it on the dashboard shows only the hatch panels — no `latest
heartbeat` / `hb fails` block and no red **"possible reboot loop"** banner,
even after the module has reported a non-zero `last_hb_fail_count`.

**Cause.** The whole **Telemetry** section that hosts `HeartbeatDiagnostics`
is **admin-gated** (`adminMode &&` in
`homepage/src/components/ModulePanel.tsx`). It is an operator surface, not part
of the public dashboard, so it is hidden until admin mode is on.

**Fix.** Open the dashboard with `?admin=1`:

```powershell
Start-Process chrome -ArgumentList '--incognito','http://localhost:5173/dashboard?admin=1'
```

`isAdminMode()` sets a `hf_admin` sessionStorage flag, so the flag persists for
the rest of that browser session (and resets when an incognito window closes).
Then open the module, expand **Telemetry**, and the `hb fails` row + banner
render. No admin key is needed for the heartbeat fields themselves; the
per-upload logs below them still prompt for it. CLI equivalent to confirm the
underlying data without the UI:

```powershell
$mac = "000000000002"
(curl.exe -s http://localhost:8002/heartbeats_summary | ConvertFrom-Json).summary.$mac |
  Select-Object last_hb_fail_code,last_hb_fail_count
```

> **Bench-testing note.** You cannot make a real board _accumulate_ a streak by
> resetting it with `scripts/esp_reset.py` / `scripts/esp_capture.py` or the RST
> button — those are EN-pin (`POWERON_RESET`) resets that wipe `RTC_NOINIT`. The
> streak only survives software reboots (`ESP.restart()`). To exercise the
> banner from real hardware, inject the fields via the duckdb-service
> `/heartbeat` endpoint, or trigger a watchdog reboot. See
> [chapter 11](11-risks-and-technical-debt/README.md) → "`RTC_NOINIT` survives
> `ESP.restart()` but **not** the bench RTS/EN reset".
>
> **Reproducing the cross-reboot carry on hardware (validated).** Temporarily
> set `kNoContactRebootMs` in
> [`ESP32-CAM/lib/loop_health/loop_health.h`](../ESP32-CAM/lib/loop_health/loop_health.h)
> to ~`60UL * 1000UL` and flash. Then `docker compose stop duckdb-service`: the
> board can't reach the server, so the liveness watchdog reboots it every
> ~90 s — a clean `ESP.restart()` (`reset_reason=3` in the boot banner, **not**
> `rst:0x1 POWERON_RESET`), so the streak climbs across reboots. After a few,
> `docker compose start duckdb-service`; the next boot heartbeat carries the
> accumulated `last_hb_fail_count` (e.g. `4`) and the server clears it on the
> `200`. **Revert the constant and reflash afterwards.** Do not drive the
> reboots with `esp_reset.py`/RST — those are EN resets that wipe the streak.

---

## Bulk ESP↔stack transfers stall on Windows + Docker Desktop (OTA download **and** image upload)

**Symptom — two faces of one bug.**

- **OTA download:** while bench-testing the HTTP boot-pull OTA
  ([manual-tests-ota.md T2](10-quality-requirements/manual-tests-ota.md)),
  serial shows `[OTA] update available: … -> … seq=N` then ~120 s later
  `[OTA] binary read deadline exceeded at 7001/1155744` (byte count varies,
  always ≈ one TCP window).
- **Image upload:** the module registers and heartbeats fine, captures a
  real frame, but the upload dies mid-body — serial shows
  `[HTTP] body write failed at 28937/40104 bytes` /
  `Data error. Could not send the complete image` /
  `upload failure streak: 1/5`, and the module's `imageCount` stays 0. The
  failure offset varies run-to-run (~29–32 KB of a ~40 KB JPEG) but always
  lands after roughly one TCP window.

In both cases small request/response flows (manifest fetch, `/new_module`
registration, `/heartbeat`) work, and the same transfer from the **host**
(`curl` to `localhost` _or_ to the host's own LAN IP) is instant — which is
why the stack looks healthy.

> **Correction (#154 bench session):** an earlier version of this entry
> claimed "client→host bulk (uploads) are unaffected." That is **wrong** —
> a ~40 KB image upload from a real Wi-Fi-connected ESP stalls at ~one
> window exactly like the OTA download. Only _small_ POSTs survive; anything
> over ~one receive-window stalls in **either** direction. The host can't
> reproduce it because host→own-LAN-IP short-circuits via loopback and never
> exercises the forwarder's slow-remote-client path.

**Cause.** Docker Desktop's default Windows **NAT networking** (gvisor/vpnkit
port-forwarder) does not sustain a bulk TCP stream to/from a **slow remote
Wi-Fi client**: one receive-window of data moves, then the window updates to
the slow client are not relayed and the stream stalls. Linux/macOS dev stacks
don't show it; production doesn't (host-nginx serves/terminates directly, no
forwarder in the path).

**Fix (recommended) — WSL2 mirrored networking.** Removes the forwarder
entirely; containers share the host's interfaces, so a remote Wi-Fi client
talks to them as it would to any host service. Fixes **both** the upload and
the OTA download in one shot (needs Windows 11 + WSL ≥ 2.0):

```powershell
# 1) Add networkingMode=mirrored to %USERPROFILE%\.wslconfig. DO NOT blindly
#    overwrite — an existing .wslconfig often holds [wsl2] memory/processor/
#    swap limits. Create it only if absent; otherwise edit by hand.
$cfg = "$env:USERPROFILE\.wslconfig"
if (Test-Path $cfg) {
  Write-Host "Existing .wslconfig found — add 'networkingMode=mirrored' under its [wsl2] section by hand:"
  notepad $cfg
} else {
  "[wsl2]`nnetworkingMode=mirrored" | Out-File -Encoding ascii $cfg   # ASCII = no BOM
}

# 2) Quit Docker Desktop, cycle WSL, relaunch Docker Desktop:
Get-Process "Docker Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
wsl --shutdown
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# 3) Confirm the mode once the engine is back:
wsl wslinfo --networking-mode    # must print: mirrored
```

> **Mandatory after switching modes: fully recreate the containers.**
> Resumed containers keep **stale port proxies** under the new networking
> mode — symptom: `localhost:8000`/`localhost:8002` (and the ESP) get
> connection-refused even though `docker compose ps` shows them healthy.
> `docker compose restart` is **not** enough; you must:
>
> ```bash
> docker compose down && docker compose up -d
> ```
>
> Then verify all four answer: `curl localhost:3002/api/health`,
> `localhost:8000/health`, `localhost:8002/health`, `localhost:5173`.

Reverting is symmetric: delete `~/.wslconfig` (or the `networkingMode` line),
`wsl --shutdown`, restart Docker Desktop, `docker compose down && up -d`.

**Fix (alternative, no WSL/Docker restart) — native stepping-stone for OTA
only.** Take Docker out of just the OTA download path by serving
`homepage/public/` from a native process on port `55555` (already has the
"HiveHive ArduinoOTA" inbound allow rule):

```powershell
# Native server: serves GET /firmware.json + /firmware.app.bin from
# homepage/public, and proxies POST /new_module + /heartbeat to
# localhost:8002 (any static server + proxy works; this is the script
# used in PR #161's bench validation — not in the repo, an ad-hoc artifact).
python c:\tmp\hf_bench_ota_server.py   # listens on 0.0.0.0:55555
```

```bash
# Stepping-stone build whose INIT_URL points at the native server.
cd ESP32-CAM
PLATFORMIO_BUILD_FLAGS='-DHF_INIT_URL_DEFAULT=\"http://<LAN-IP>:55555/new_module\" -DHF_UPLOAD_URL_DEFAULT=\"http://<LAN-IP>:8000/upload\"' \
  pio run -e esp32cam -t upload --upload-port COM9
```

This only rescues the OTA download (the `<LAN-IP>:8000` upload still goes
through Docker, so it does **not** fix the image-upload stall — use mirrored
networking for that).

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
