# HiveHive ESP32-CAM Module — Setup & Deployment

HiveHive edge modules are based on the ESP32-CAM. They capture images and upload them to the server for processing and analysis.

---

## Prerequisites — verify the server stack first

Before touching the hardware, make sure the server is running and reachable.

```bash
docker compose up --build   # from the repo root
```

Check all four services are healthy (substitute your machine's LAN IP):

| Check                             | Expected response |
| --------------------------------- | ----------------- |
| `http://localhost:5173`           | Dashboard loads   |
| `http://<LAN-IP>:3002/api/health` | `{"status":"ok"}` |
| `http://<LAN-IP>:8000/health`     | `ok`              |
| `http://<LAN-IP>:8002/health`     | `ok`              |

> **Find your LAN IP:** `ipconfig` on Windows (look for the WLAN or Ethernet adapter), `ip addr` on Linux/Mac. Use this IP — not `localhost` — when configuring the module, because the ESP32 is a separate device on the network.

> **Windows Firewall:** ports 8000 and 8002 must accept inbound TCP connections from LAN devices. If modules register on the network but never appear on the dashboard, run this once in an **admin** PowerShell:
>
> ```powershell
> New-NetFirewallRule -DisplayName "HiveHive image-service" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Any
> New-NetFirewallRule -DisplayName "HiveHive duckdb-service" -Direction Inbound -Protocol TCP -LocalPort 8002 -Action Allow -Profile Any
> ```

---

## Flashing firmware onto a blank ESP32-CAM

Skip this section if the module already runs HiveHive firmware (it will open the `ESP32-Access-Point` Wi-Fi network on boot).

### Hardware variants

**ESP32-CAM-MB (motherboard)** — identified by a micro-USB port and "ESP32-CAM-MB" printed on the board. Has a built-in CH340 USB-serial chip. **No FTDI adapter needed.**

**Bare ESP32-CAM** — no USB port. Requires a separate USB-to-TTL adapter (FTDI FT232 or CH340, 3.3 V logic) wired to GND, 5 V, U0T→RX, U0R→TX, plus IO0→GND for flash mode.

### Install PlatformIO

```bash
pip install platformio
```

If you have multiple Python versions on the same machine and `python -m platformio` fails, call the interpreter explicitly:

```bash
# Windows example — find yours with: where python
& "C:\Users\<you>\AppData\Local\Programs\Python\Python311\python.exe" -m platformio ...
```

### Enter flash mode (ESP32-CAM-MB)

1. Hold the **IO0** (or **BOOT**) button on the MB board.
2. While holding IO0, press and release **RST**.
3. Release IO0.

The chip is now waiting for firmware.

### Provide the Geolocation API key (one-time, before first build)

> **Skip this and your modules will plot at Null Island in the
> Gulf of Guinea on the dashboard.** The Google Geolocation API key
> used by the firmware's first-boot WiFi-AP lookup is **build-time
> injected** — it is no longer hardcoded. Without a key, the
> firmware compiles cleanly and the runtime guard skips the lookup,
> but every module reports `(0, 0, 0)` to the backend.

Write the key to the gitignored `ESP32-CAM/GEO_API_KEY` file once
(it's listed in the repo root `.gitignore` next to `secrets.h`):

```powershell
# Windows / PowerShell — from repo root
"AIza<your-google-geolocation-api-key>" | Out-File -NoNewline -Encoding ascii ESP32-CAM\GEO_API_KEY
```

```bash
# Linux / macOS — from repo root
printf '%s' "AIza<your-google-geolocation-api-key>" > ESP32-CAM/GEO_API_KEY
```

Or set the env var in the shell where you run `pio` /
`build.sh`:

```bash
export GEO_API_KEY="AIza<your-google-geolocation-api-key>"
```

Either source survives in `extra_scripts.py`'s pre-build hook,
which prints `[extra_scripts] GEO_API_KEY len=<N>` so you can
confirm the value reached the build (the value itself is **never**
logged). Full mechanism, source order, and rotation procedure:
[`docs/08-crosscutting-concepts/auth.md` → "Third-party API keys:
Geolocation"](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).
The leak that prompted this design: [chapter 11 lessons-learned →
"Third-party API keys belong in build-time macros, not source"](../11-risks-and-technical-debt/README.md#third-party-api-keys-belong-in-build-time-macros-not-source-issue-18).

The maintainer issues the key from the project's Google Cloud
Console (restricted to the Geolocation API). Ask in the issue
tracker if you need access for a personal fork.

### Flash

```bash
cd ESP32-CAM
pio run -e esp32cam --target upload --upload-port <port>
```

Find the port: **Device Manager → Ports → USB-SERIAL CH340 (COMx)** on Windows; `/dev/ttyUSB0` or `/dev/cu.usbserial-*` on Linux/Mac.

### Boot normally after flashing

Press **RST** once (without IO0). The module boots and opens the configuration access point — verify by opening your phone's WiFi list and looking for `ESP32-Access-Point`. The on-board LED stays silent in AP mode (the LED is the camera-flash GPIO; steady-state signalling would be obnoxious). See [the LED legend in chapter 06](../06-runtime-view/esp-reliability.md#led-legend) for the brief failure / upload pulses the LED does emit during normal operation.

---

## Initial setup — configuring a module for the first time

### 1. Connect to the module's access point

| Setting       | Value                |
| ------------- | -------------------- |
| Wi-Fi network | `ESP32-Access-Point` |
| Password      | `esp-12345`          |

> **Browser:** use **Chrome or Firefox**. Brave and some other mobile browsers silently fail to submit the configuration form due to session-token handling — the form will appear to reload blank after you click Save.

### 2. Open the configuration page

Navigate to **http://192.168.4.1**

### 3. Fill in the configuration form

| Field                   | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| Module Name             | Any label, e.g. `hive-01`                                             |
| Wi-Fi SSID              | Your 2.4 GHz network name (case-sensitive — copy-paste, don't retype) |
| Wi-Fi Password          | Your network password                                                 |
| Initialization Base URL | `http://<LAN-IP>:8002`                                                |
| Initialization Endpoint | `/new_module`                                                         |
| Upload Base URL         | `http://<LAN-IP>:8000`                                                |
| Upload Endpoint         | `/upload`                                                             |

> **2.4 GHz only.** The ESP32 does not support 5 GHz. If your router shows a single SSID for both bands (band steering), the ESP32 should be assigned to 2.4 GHz automatically — but if it fails to connect, check your router's band-steering settings.

> **Same network.** The ESP32 must be on the same LAN as the server. If you configure it to join a phone hotspot while the server runs on your home router, the module cannot reach the server.

> **Capture cadence is hardcoded.** The shipping firmware captures once on first boot plus once daily at noon local time (`TZ_EU_CENTRAL` — `CET`/`CEST` — configured in `ESP32-CAM/esp_init.cpp`'s `configTzTime` call). There is no operator-configurable interval field on the form; an earlier `Capture Interval (ms)` knob was dead-weight (stored but never read) and was removed when issue #65 was resolved. If operator-configurable cadence is later wanted, the wiring would touch `ESP32-CAM/ESP32-CAM.ino`'s `loop` and interact with ADR-007's daily-reboot logic — a separate feature PR.

Click **Save Configuration**. The module reboots, joins your Wi-Fi, registers itself with the server, and starts uploading images. It will appear on the dashboard at `http://localhost:5173/dashboard` within a minute.

---

## Verifying a successful setup

```bash
# Check registered modules (replace with your LAN IP or use localhost)
curl http://localhost:8002/modules
```

Your module should appear with its MAC address as ID, the name you gave it, and a battery level. (The 3-valued `Module.status` enum that the dashboard renders is computed by the backend from `lastSeenAt` — duckdb-service's direct `/modules` does not surface a `status` field; see `docs/08-crosscutting-concepts/api-contracts.md` for the derivation rule.)

---

## Reading serial output

The serial monitor is useful for diagnosing connection issues.

### Interactive monitor (works on most setups)

```bash
# PlatformIO
pio device monitor --port <port> --baud 115200

# Windows with explicit Python path
& "C:\...\python.exe" -m platformio device monitor --port COM9 --baud 115200
```

Press **RST** after starting the monitor to see the full boot log.

### File capture (if the interactive monitor shows nothing)

Some MB board variants receive data but don't echo it to the terminal due to control-line behaviour. Capture to a file instead:

```python
import serial, time

s = serial.Serial('COM9', 115200, timeout=0.5, rtscts=False, dsrdtr=False)
s.setRTS(False)
s.setDTR(False)
# Press RST on the board now
deadline = time.time() + 20
buf = b''
while time.time() < deadline:
    data = s.read(256)
    if data:
        buf += data
s.close()
open('esp_log.txt', 'wb').write(buf)
```

Then open `esp_log.txt` to read the boot log.

---

## Reconfiguration (factory reset)

To clear the saved configuration and re-enter setup mode:

- **From AP mode** (`ESP32-Access-Point` visible): connect to it, open <http://192.168.4.1>, expand **Factory reset (advanced)**, tick the confirmation checkbox, and click **Factory reset**. The module reboots and reopens the AP.
- **From STA mode** (joined WiFi): cause three consecutive failed joins to trigger the auto-AP-fallback, then follow the AP-mode steps. The least disruptive way: reconnect to `ESP32-Access-Point`, open `http://192.168.4.1`, and save intentionally wrong WiFi credentials — the board will fail three times (~90 s total) and reopen the AP automatically. Or, with a serial cable: `pio run -t erase && pio run -t upload`.

> The legacy "hold IO0 for 5 seconds" procedure was removed in #40 — GPIO0 is a strap pin, the procedure was unreachable on AI Thinker ESP32-CAM-MB boards. See chapter 11 "Lessons learned" for the post-mortem.

---

## Firmware update

### Via PlatformIO (recommended)

Enter flash mode (IO0 + RST as above), then:

```bash
cd ESP32-CAM
pio run -e esp32cam --target upload --upload-port <port>
```

### Via web installer

Connect the module via USB, open **http://\<hivehive-server\>/web-installer** in **Chrome or Edge** (Web Serial API required), and follow the on-screen instructions.

## Updating a deployed module (OTA)

Once a module has been flashed once with an OTA-capable firmware
(see "First-time OTA migration" below), subsequent updates need no
USB cable. See
[../06-runtime-view/ota-update-flow.md](../06-runtime-view/ota-update-flow.md)
for the runtime sequence and
[../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md)
for the design.

### LAN push (ArduinoOTA)

Push from the developer's machine while on the same network as the
module. The module advertises itself as `hivehive-<12hex-module-id>`
via mDNS.

```powershell
$MODULE = "192.168.1.50"   # your module's IP

cd ESP32-CAM
pio run -e esp32cam -t upload --upload-port $MODULE
```

If PlatformIO times out the module may be mid-loop — wait up to 30 s
and retry (`loop()`'s `ArduinoOTA.handle()` is polled between the
existing 30 s sleeps).

> **Windows + Docker:** if the upload fails with "No response from the
> ESP" even though the serial monitor shows `[OTA] LAN update start`,
> Windows Firewall is blocking espota's callback port. Run the two
> commands in the **"ArduinoOTA LAN push fails on Windows"** entry of
> [docs/troubleshooting.md](../troubleshooting.md) once per developer
> machine. `platformio.ini` is already configured with a fixed callback
> port (`upload_flags = --host_port=55555`) so the single firewall rule
> covers every subsequent push.

### Boot-time HTTP pull

Bump `ESP32-CAM/VERSION` (per [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md)
the value is the next bee-species name), then:

```bash
cd ESP32-CAM
bash build.sh
# Then deploy the updated homepage/public/* artifacts to the host.
```

`build.sh` writes both `homepage/public/firmware.bin` (merged, for
the web installer) and `homepage/public/firmware.app.bin` (app-only,
for the OTA fetch), plus a `firmware.json` manifest carrying both
md5s. The next daily reboot of each module (ADR-007) picks up the
new version from `/firmware.json`, downloads `/firmware.app.bin`,
flashes the inactive OTA slot, and restarts. The dashboard's
`Module.latestHeartbeat.fwVersion` reflects the new version once
the post-flash boot's heartbeat completes — the boot heartbeat fires
before camera init and before the rollback gate, so the new version
briefly appears on the dashboard even while the slot is still pending
verify. If camera init panics and the slot rolls back, the next boot's
heartbeat corrects the displayed version automatically.

If the new firmware fails to reach the
`esp_ota_mark_app_valid_cancel_rollback()` call at the very end of
`setup()` — because any setup stage panics or watchdog-fires — the
ESP32 bootloader reverts to the previous slot on the next reset. No
operator action needed.
Operator-visible: the dashboard keeps reporting the **old** version
on that module, and the next telemetry sidecar carries a breadcrumb
naming which setup stage the new firmware died in.

### First-time OTA migration (one-way, USB-only)

A module that has never been flashed with an OTA-capable binary uses
the ESP32 default partition table — single app slot, no OTA slots.
That module **cannot** receive the new partition layout over the air,
because the bootloader reads partition information from flash offset
`0x8000` and the OTA path writes to the app slot only.

The first flash of an OTA-capable binary must therefore arrive via:

- USB + `pio run -t upload` (the "Via PlatformIO" path above), **or**
- The web installer's merged `firmware.bin` (the "Via web installer"
  path above) — which flashes bootloader + partitions + app together
  and so includes the new partition table.

After that one-time USB flash, every subsequent update can be OTA.
Symptom of trying to OTA-push to an un-migrated module: the upload
fails before the binary stream completes, or completes but the
module fails to boot the new image and the bootloader reverts. See
[../11-risks-and-technical-debt/README.md](../11-risks-and-technical-debt/README.md)
"OTA migration is one-way".

---

For the firmware design, file layout, and runtime behaviour see
[../05-building-block-view/esp32cam.md](../05-building-block-view/esp32cam.md)
and [../06-runtime-view/esp-reliability.md](../06-runtime-view/esp-reliability.md).
