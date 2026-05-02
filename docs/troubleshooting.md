# HiveHive Troubleshooting Guide

Symptom-based guide covering the most common issues during initial hardware setup and ongoing operation. For the full hardware setup walkthrough see [esp-deployment.md](esp-deployment.md).

---

## Server stack

### Root URLs return 404 / "Cannot GET /"

**Normal behaviour.** The backend and Flask services have no root route. Use the health endpoints instead:

| Service | Health check URL | Expected |
|---------|-----------------|----------|
| backend | `http://localhost:3002/api/health` | `{"status":"ok"}` |
| image-service | `http://localhost:8000/health` | `ok` |
| duckdb-service | `http://localhost:8002/health` | `ok` |
| homepage | `http://localhost:5173` | Dashboard loads |

### A service fails to start or exits immediately

```bash
docker compose logs <service-name>   # e.g. duckdb-service
```

The most common cause is a missing or malformed `.env` file at the repo root. It must contain at minimum:

```env
DEBUG=true
DUCKDB_SERVICE_URL=http://duckdb-service:8000
```

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

Also look in the serial log for lines like `WIFI CONNECTED` or WiFi error codes.

### Factory reset to re-enter configuration

Hold the **IO0** button for **7 seconds** while the board is powered. The configuration is cleared and the `ESP32-Access-Point` reopens. Do not press RST during the hold.

---

## Module joins Wi-Fi but never appears on the dashboard

### ESP and server are on different networks

The ESP32 must be able to reach the server's IP. A common mistake is configuring the module to join a phone hotspot while the server runs on the home router — those are separate networks.

**Rule:** the Initialization Base URL and Upload Base URL you enter in the config form must use the server's **LAN IP** on the **same network** the ESP32 will join.

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

Your module should appear with its MAC-derived ID, name, battery level, and `"status": "online"`.

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
