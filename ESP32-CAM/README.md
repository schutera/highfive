# ESP32-CAM Firmware & Image Uploader

This software turns an ESP32-CAM module into a simple image-capturing device that periodically takes a photo and uploads it to a server via an HTTP POST request. After flashing the firmware, the device can be configured through a built-in Wi-Fi access point and web interface.

---

# Instructions

## Usage

When powered on, the ESP32-CAM starts its own Wi-Fi access point:

- **SSID:** `ESP32-Access-Point`  
- **Password:** `esp-12345`

After connecting to the access point, open the configuration page under:  
**http://192.168.4.1**

A web form allows setting:
- Wi-Fi SSID & password  
- Server base URL  
- Endpoint path  
- Camera settings (resolution selectable via dropdown)

More camera configuration options will be added in future versions.

### Network Requirements & Examples
- The ESP32-CAM **must** connect to a **2.4 GHz** Wi-Fi network.
- A **server URL** and an **endpoint path** are both required; all other fields have defaults.
- The final upload URL is constructed by combining the two.

**Example:**
- Server: `https://example.com`  
- Endpoint: `upload`  
→ Final upload URL: `https://example.com/upload`

### Camera Settings
Images are captured in JPEG format.  
Resolution is chosen from a dropdown in the configuration form.

Supported resolutions:
- QVGA (320 × 240)  
- VGA (640 × 480)  
- QXGA (800 × 600)  
- SXGA (1280 × 1024)  
- UXGA (1600 × 1200)

Defaults exist for all configuration fields, and only Wi-Fi credentials plus server+endpoint are required. All other fields are optional.

---

## Firmware Update

The latest firmware binaries (**firmware.bin**) can be downloaded from the [releases page](https://github.com/paulgrbr/hivehive-esp32/releases).

Flashing the firmware can be done in the browser using the [ESPWebTool](https://esptool.spacehuhn.com/)

**Requirements and notes:**
- Use **Google Chrome** or **Microsoft Edge**; other browsers do not support Web Serial.
- This is a **preliminary flashing solution**. A smoother and more integrated flashing experience will be added later.
- Always download the latest `firmware.bin`.

**Flashing process (detailed):**
1. Download the newest `firmware.bin` from the Releases section.  
2. Open the [ESPWebTool](https://esptool.spacehuhn.com/) in Chrome/Edge.  
3. Click **Connect** and select the serial port of your ESP32-CAM (usually shows up as USB-Serial).  
4. Choose **Flash Firmware** and select the downloaded `firmware.bin`.  
5. Start the flashing process and wait until the tool reports success.  
6. Restart the ESP32-CAM after flashing completes.

---

## Developer Instructions

### Prerequisites
- **[Arduino IDE](https://github.com/espressif/arduino-esp32)** with ESP32 drivers installed
- USB adapter for flashing
- A 2.4 GHz Wi-Fi network

### Compiling & Flashing From Arduino IDE
1. Open the project in Arduino IDE.  
2. Select the correct ESP32 board and serial port.  
3. Compile and upload the firmware.  
4. Open the Serial Monitor under **Tools → Serial Monitor**.  
5. Set the baud rate to **115200** to view runtime logs, upload attempts, errors, and debug output.

After flashing, the ESP32-CAM will begin its capture-and-upload cycle whenever it receives power.

---

## Project Layout

```
ESP32-CAM/
├── ESP32-CAM.ino          Arduino sketch entrypoint (setup, loop)
├── client.cpp / .h        Image upload + multipart construction
├── esp_init.cpp / .h      WiFi / camera / config bootstrap
├── host.cpp / .h          Setup-mode access point + config web UI
├── logbuf.cpp / .h        On-device telemetry ring buffer
├── lib/                   Pure C++ helpers, host-testable
│   └── url/               URL parsing
├── test/                  PlatformIO native unit tests (no hardware)
│   └── test_native_url/
└── platformio.ini         Build config: esp32cam (firmware) + native (tests)
```

The `lib/` directory holds pure C++ modules with no Arduino dependencies, so
they can be unit-tested on the host. The Arduino-IDE workflow keeps working —
PlatformIO is added alongside, not as a replacement.

### Native unit tests (no hardware)

Install PlatformIO once:

```bash
pip install platformio
```

Then from the repository root:

```bash
make test-esp-native
# Equivalent to: cd ESP32-CAM && python -m platformio test -e native
# Or (if 'pio' is on PATH):  cd ESP32-CAM && pio test -e native
```

Tests live under `ESP32-CAM/test/test_native_*/` and run in seconds. They
exist so that parser, telemetry-builder, and log-buffer regressions can be
caught in CI without flashing a physical device.

### Building the firmware via PlatformIO (optional)

```bash
cd ESP32-CAM && python -m platformio run -e esp32cam
```

The `esp32cam` env in `platformio.ini` is the source of truth for library
versions. If you add a library via Arduino IDE, please mirror it under
`lib_deps` so that other contributors and CI get the same build.

---
