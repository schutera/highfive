---
name: esp32-onboarding
description: Interactive guided setup for a HiveHive ESP32-CAM module — flashing firmware, configuring Wi-Fi and server URLs, verifying registration, and troubleshooting connectivity issues.
user_invocable: true
---

# ESP32-CAM Onboarding

Work through the phases below **in order**, checking success at each step before proceeding. If a step fails, diagnose it before moving on — don't skip ahead.

---

## Phase 1 — Verify the server stack

Check all four services are healthy before touching the hardware.

```bash
docker compose logs --tail=5   # confirms services are running
```

Then check health endpoints. First find the host's LAN IP (not localhost — the ESP32 is a separate device):

- Windows: `ipconfig` → WLAN or Ethernet adapter
- Linux/Mac: `ip addr`

```
http://<LAN-IP>:3002/api/health  → {"status":"ok"}
http://<LAN-IP>:8000/health      → ok
http://<LAN-IP>:8002/health      → ok
```

If a service is down: `docker compose up --build`. Confirm `.env` exists at the repo root with `DEBUG=true` and `DUCKDB_SERVICE_URL=http://duckdb-service:8000`.

**Windows only:** ports 8000 and 8002 need inbound firewall rules. If services are healthy but modules never appear, add them now (admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "HiveHive image-service" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "HiveHive duckdb-service" -Direction Inbound -Protocol TCP -LocalPort 8002 -Action Allow -Profile Any
```

---

## Phase 2 — Identify the hardware variant

Ask the user to describe or photograph the board.

**ESP32-CAM-MB** (micro-USB port + "ESP32-CAM-MB" label) → built-in CH340, no extra adapter needed.

**Bare ESP32-CAM** (no USB port) → needs FTDI USB-to-TTL adapter (3.3 V), wired: GND↔GND, 5V↔5V, FTDI-TX→U0R, FTDI-RX→U0T, IO0→GND for flash mode.

---

## Phase 3 — Flash firmware

Install PlatformIO if needed:

```bash
pip install platformio
```

Find the COM port:

- Windows: Device Manager → Ports → "USB-SERIAL CH340 (COMx)"
- Linux/Mac: `/dev/ttyUSB0` or `/dev/cu.usbserial-*`

**Targeting a local dev stack?** The server URLs are baked in at build time (the captive portal no longer asks for them). For a production build, skip this — the firmware defaults to `https://highfive.schutera.com/...`. To point the module at your LAN `docker compose` stack, write the host's LAN IP (host only — no scheme, no port, no path) to the gitignored `ESP32-CAM/DEV_SERVER_HOST` **before** flashing, or export `DEV_SERVER_HOST`:

```bash
# Linux/Mac — from repo root
printf '%s' "192.168.1.50" > ESP32-CAM/DEV_SERVER_HOST
```

```powershell
# Windows / PowerShell — from repo root
"192.168.1.50" | Out-File -NoNewline -Encoding ascii ESP32-CAM\DEV_SERVER_HOST
```

The build (`build.sh` / `extra_scripts.py`) injects `http://<host>:8002/new_module` (duckdb-service) and `http://<host>:8000/upload` (image-service). Same pattern as `GEO_API_KEY`. See [esp-flashing.md → "Point a dev module at a local stack"](../../../docs/07-deployment-view/esp-flashing.md).

Enter flash mode (ESP32-CAM-MB):

1. Hold **IO0** (BOOT) button
2. Press and release **RST** while holding IO0
3. Release IO0

Flash:

```bash
cd ESP32-CAM
pio run -e esp32cam --target upload --upload-port <port>
```

After success: press **RST** once (no IO0) to boot normally. Watch the serial monitor for the boot banner — the LED stays silent in AP mode and during steady-state operation (it's the camera-flash GPIO; constant signalling would be obnoxious). Brief LED pulses appear only on WiFi-join failure (3×) or per image upload (1×).

**Multiple Python versions (Windows):** if `python -m platformio` fails, call with the explicit path:

```bash
& "C:\Users\<you>\AppData\Local\Programs\Python\Python311\python.exe" -m platformio run -e esp32cam --target upload --upload-port COM9
```

---

## Phase 4 — Capture boot log

Confirm what state the board is in before configuring.

```python
import serial, time
s = serial.Serial('<port>', 115200, timeout=0.5, rtscts=False, dsrdtr=False)
s.setRTS(False); s.setDTR(False)
# Press RST on the board now
deadline = time.time() + 15
buf = b''
while time.time() < deadline:
    data = s.read(256)
    if data: buf += data
s.close()
open('esp_log.txt', 'wb').write(buf)
```

Check `esp_log.txt`. A healthy unconfigured board shows:

```
-- ESP not yet configured. Opening ESP access point...
---- AccessPoint IP: 192.168.4.1
```

**Red flag — watchdog crash:** if you see `task_wdt: Task watchdog got triggered` and the board reboots every ~44 s, the firmware is outdated. Reflash from the current repo — the bug is fixed in `host.cpp`.

---

## Phase 5 — Configure via access point

**Browser:** Chrome or Firefox only. Brave and some mobile browsers silently break the config form's session-token submission (form reloads blank after Save).

1. Connect to Wi-Fi: **`ESP32-Access-Point`** / password **`esp-12345`**
2. Open **http://192.168.4.1**
3. Fill in the form — **Wi-Fi credentials only**:

| Field          | Value                                                                     |
| -------------- | ------------------------------------------------------------------------- |
| Wi-Fi SSID     | Your **2.4 GHz** network name — copy-paste, don't retype (case-sensitive) |
| Wi-Fi Password | Your network password                                                     |

There are no other fields. Module name, server URLs, and camera settings are assigned under the hood (see Phase 3 — server URLs are baked in at build time, not entered here). See [ADR-018](../../../docs/09-architecture-decisions/adr-018-captive-portal-wifi-only.md).

4. Click **Save Configuration** — you should see "Configuration saved successfully."

The board reboots and connects to your Wi-Fi. The access point disappears.

**Key constraints:**

- ESP32 is **2.4 GHz only** — router must have a 2.4 GHz band available
- The ESP32 and the server must be on the **same LAN** — not one on a phone hotspot and the other on the home router
- For a dev module, the server's **LAN IP** (not `localhost`) goes into `DEV_SERVER_HOST` **before flashing** (Phase 3), not into the form — there is no URL field

**Reconfigure = re-flash.** There is no factory-reset button. Re-flashing erases the saved config (full chip erase, `eraseAll: true` in `homepage/src/components/setup/flashEsp.ts`'s `flashEsp`), so the module boots straight back into this Wi-Fi-only setup page. To change the server a module talks to, set `DEV_SERVER_HOST`, re-build, and re-flash (Phase 3). The "moved to a new network" case needs no re-flash: cause three consecutive failed Wi-Fi joins (e.g. save wrong credentials) and the module auto-reopens the access point after ~90 s (`WIFI_FAIL_AP_FALLBACK_THRESH` in `ESP32-CAM/ESP32-CAM.ino`).

---

## Phase 6 — Verify registration

```bash
# Check the module appeared
curl http://localhost:8002/modules

# Watch live traffic
docker compose logs -f duckdb-service image-service | grep -v "GET /health"
```

A successful registration produces `POST /new_module` in duckdb-service logs, then `POST /upload` as images arrive.

If the module joined Wi-Fi (visible in router admin) but nothing appears in logs → Windows Firewall (see Phase 1).

If the module is not visible in the router admin at all → Wi-Fi join failed (wrong SSID/password, 5 GHz band, or different network than server).

---

## Phase 7 — Confirm on dashboard

Open **http://localhost:5173/dashboard**

The new module should appear with its name, battery level, location, and status `online`.

---

## Quick reference — known gotchas

| Issue                                         | Fix                                                       |
| --------------------------------------------- | --------------------------------------------------------- |
| AP called "HiveHive-Access-Point" in old docs | Actual name is `ESP32-Access-Point`, pw `esp-12345`       |
| Form saves blank after Submit                 | Use Chrome or Firefox, not Brave                          |
| Board crashes every ~44 s in AP mode          | Outdated firmware — reflash from current repo             |
| Module on network but not registering         | Check Windows Firewall (ports 8000, 8002)                 |
| Module never joins Wi-Fi                      | 2.4 GHz only; case-sensitive SSID; same network as server |
| `python -m platformio` not found              | Multiple Python versions — use explicit path              |
