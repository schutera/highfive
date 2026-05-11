# ESP32-CAM module (`ESP32-CAM/`)

C++17 firmware on the AI-Thinker ESP32-CAM, built with PlatformIO
against the Arduino framework. One module = one deployed unit. After
configuration, the device runs fully unattended.

For procedural setup (flashing, Wi-Fi config, factory reset) see
[07-deployment-view/esp-flashing.md](../07-deployment-view/esp-flashing.md).
For the reliability layers (watchdogs, recovery) see
[06-runtime-view/esp-reliability.md](../06-runtime-view/esp-reliability.md).
For setup gotchas (browser, Wi-Fi band, firewall) see
[08-crosscutting-concepts/hardware-notes.md](../08-crosscutting-concepts/hardware-notes.md).

## What the firmware does

After initial configuration the device operates fully automatically:

- Connects to the configured Wi-Fi network on boot
- Registers itself as a new module if not already known to the server
- Captures images at the configured interval and uploads them to
  `image-service` via multipart `POST /upload`
- Sends an hourly **telemetry heartbeat** to `duckdb-service` at
  `POST /heartbeat` (firmware-direct; `sendHeartbeat` in
  `client.cpp`, `heartbeat` route in `routes/heartbeats.py`)
  carrying mac, battery, RSSI,
  uptime_ms, free_heap, fw_version. The wire shape is
  [`HeartbeatSnapshot`](../08-crosscutting-concepts/api-contracts.md)
  in `@highfive/contracts` —
  [ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).
  This is **not** the same endpoint as `POST /modules/<mac>/heartbeat`
  (the post-upload aggregate, fired by `image-service` after every
  upload). See the [glossary](../12-glossary/README.md) entries.
- Attaches a JSON `logs` field with firmware version, uptime, free
  heap, RSSI, last reset reason, last HTTP codes, and the last ~2 KB
  of the on-device circular log buffer
- Runs the reliability stack — circuit breaker, daily reboot, camera
  PWDN recovery, and a 60 s task watchdog — see
  [esp-reliability](../06-runtime-view/esp-reliability.md) and
  [ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md)

## File layout

| Path                            | Role                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ESP32-CAM/ESP32-CAM.ino`       | Arduino entry point                                                                                                   |
| `ESP32-CAM/host.cpp`            | Access-point + config form (lines 9–10 hold AP credentials)                                                           |
| `ESP32-CAM/client.cpp`          | Wi-Fi join, upload loop, heartbeat sender                                                                             |
| `ESP32-CAM/esp_init.{cpp,h}`    | NVS-backed configuration; `FIRMWARE_VERSION` macro                                                                    |
| `ESP32-CAM/logbuf.cpp`          | On-device circular log buffer (consumes `lib/ring_buffer/`)                                                           |
| `ESP32-CAM/VERSION`             | Single-line bee-species version (see [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md)) |
| `ESP32-CAM/build.sh`            | Reads `VERSION` to tag built artifacts                                                                                |
| `ESP32-CAM/lib/url/`            | Pure C++ URL helpers (host-testable)                                                                                  |
| `ESP32-CAM/lib/ring_buffer/`    | Pure C++ ring buffer (host-testable)                                                                                  |
| `ESP32-CAM/lib/telemetry/`      | Pure C++ telemetry JSON builder (host-testable)                                                                       |
| `ESP32-CAM/lib/form_query/`     | Pure C++ URL-form parser (host-testable)                                                                              |
| `ESP32-CAM/test/test_native_*/` | Unity host tests (38 tests)                                                                                           |
| `ESP32-CAM/platformio.ini`      | `esp32cam` (firmware) and `native` (host tests) envs                                                                  |

The host-testable split is documented in
[ADR-002](../09-architecture-decisions/adr-002-esp-host-testable-lib.md).

## Configuration model

The first boot opens an access point named `ESP32-Access-Point`
(password `esp-12345`), serves a config form at
`http://192.168.4.1`, and persists the user's input to NVS. On
subsequent boots the device reads NVS and goes straight to the upload
loop. The captive portal reopens automatically after three
consecutive WiFi-join failures (auto-AP-fallback) so a typo'd
password is recoverable in-band. From a reachable AP, factory reset
is exposed via the captive portal at `http://192.168.4.1` (collapsed
"Factory reset (advanced)" section), which calls `POST /factory_reset`
and reboots into AP mode. For STA-locked boards (joined a working
SSID, want to move to a different one), the cable path is
`pio run -t erase` over serial.

See [esp-flashing.md](../07-deployment-view/esp-flashing.md) for the
full setup walkthrough.

## Known constraints and risks

- **2.4 GHz Wi-Fi only.** No 5 GHz support.
- **No OTA today.** Firmware updates require physical USB access. Tracked
  in [issue #26](https://github.com/schutera/highfive/issues/26).
- **Google Geolocation API key is build-time injected**, not hardcoded.
  `esp_init.cpp`'s `getGeolocation` reads the `GEO_API_KEY` macro
  supplied by `extra_scripts.py` (PlatformIO) or `build.sh`
  (`arduino-cli`); raw Arduino IDE builds fall back to an empty
  string and the runtime guard skips the Google call. Source order
  and rotation procedure: [auth.md "Third-party API keys:
  Geolocation"](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).
  Background on the leak that prompted the change:
  [chapter 11 lessons-learned "Third-party API keys belong in
  build-time macros, not source"](../11-risks-and-technical-debt/README.md#third-party-api-keys-belong-in-build-time-macros-not-source-issue-18).
