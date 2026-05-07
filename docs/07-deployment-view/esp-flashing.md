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

Click **Save Configuration**. The module reboots, joins your Wi-Fi, registers itself with the server, and starts uploading images. It will appear on the dashboard at `http://localhost:5173/dashboard` within a minute.

---

## Verifying a successful setup

```bash
# Check registered modules (replace with your LAN IP or use localhost)
curl http://localhost:8002/modules
```

Your module should appear with its MAC address as ID, the name you gave it, battery level, and `"status": "online"`.

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

## Reconfiguration (re-open the captive portal)

To re-enter setup mode without re-flashing:

- Temporarily change your WiFi password (or take the SSID offline) so the module cannot join.
- After **three consecutive failed joins (~90 s)**, the firmware clears the `configured` flag in NVS and the `ESP32-Access-Point` reopens automatically.
- Reconnect to the AP and walk the captive portal again.
- The previously-saved WiFi password remains in SPIFFS across this fallback (only the `configured` flag flips); leave the password field blank to keep it, or type a new one to overwrite.

> The historical "hold IO0 for 5 seconds while powered" trigger is unreliable on standard ESP32-CAM hardware because GPIO0 is also the boot strap pin. Tracked in [issue #56](https://github.com/schutera/highfive/issues/56). Use the WiFi-fail path above.

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

---

For the firmware design, file layout, and runtime behaviour see
[../05-building-block-view/esp32cam.md](../05-building-block-view/esp32cam.md)
and [../06-runtime-view/esp-reliability.md](../06-runtime-view/esp-reliability.md).
