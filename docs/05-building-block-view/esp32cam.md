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
- Sends an hourly heartbeat to `duckdb-service`
  (`POST /modules/<mac>/heartbeat`) carrying battery, RSSI,
  uptime, free heap, and `fw_version`. The wire shape is
  [`HeartbeatSnapshot`](../08-crosscutting-concepts/api-contracts.md)
  in `@highfive/contracts` —
  [ADR-004](../09-architecture-decisions/adr-004-heartbeat-snapshot-in-contracts.md).
- Attaches a JSON `logs` field with firmware version, uptime, free
  heap, RSSI, last reset reason, last HTTP codes, and the last ~2 KB
  of the on-device circular log buffer
- Runs the reliability stack — circuit breaker, daily reboot, camera
  PWDN recovery, and a 60 s task watchdog — see
  [esp-reliability](../06-runtime-view/esp-reliability.md) and
  [ADR-007](../09-architecture-decisions/adr-007-esp-reliability-breaker-and-daily-reboot.md)

## File layout

| Path                                | Role                                  |
| ----------------------------------- | ------------------------------------- |
| `ESP32-CAM/ESP32-CAM.ino`           | Arduino entry point                   |
| `ESP32-CAM/host.cpp`                | Access-point + config form (lines 9–10 hold AP credentials) |
| `ESP32-CAM/client.cpp`              | Wi-Fi join, upload loop, heartbeat sender |
| `ESP32-CAM/esp_init.{cpp,h}`        | NVS-backed configuration; `FIRMWARE_VERSION` macro |
| `ESP32-CAM/logbuf.cpp`              | On-device circular log buffer (consumes `lib/ring_buffer/`) |
| `ESP32-CAM/VERSION`                 | Single-line bee-species version (see [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md)) |
| `ESP32-CAM/build.sh`                | Reads `VERSION` to tag built artifacts |
| `ESP32-CAM/lib/url/`                | Pure C++ URL helpers (host-testable)  |
| `ESP32-CAM/lib/ring_buffer/`        | Pure C++ ring buffer (host-testable)  |
| `ESP32-CAM/lib/telemetry/`          | Pure C++ telemetry JSON builder (host-testable) |
| `ESP32-CAM/lib/form_query/`         | Pure C++ URL-form parser (host-testable) |
| `ESP32-CAM/test/test_native_*/`     | Unity host tests (38 tests)           |
| `ESP32-CAM/platformio.ini`          | `esp32cam` (firmware) and `native` (host tests) envs |

The host-testable split is documented in
[ADR-002](../09-architecture-decisions/adr-002-esp-host-testable-lib.md).

## Configuration model

The first boot opens an access point named `ESP32-Access-Point`
(password `esp-12345`), serves a config form at
`http://192.168.4.1`, and persists the user's input to NVS. On
subsequent boots the device reads NVS and goes straight to the upload
loop. Holding `IO0` for 7 seconds factory-resets and reopens the AP.

See [esp-flashing.md](../07-deployment-view/esp-flashing.md) for the
full setup walkthrough.

## Known constraints and risks

- **2.4 GHz Wi-Fi only.** No 5 GHz support.
- **No OTA today.** Firmware updates require physical USB access. Tracked
  in [issue #26](https://github.com/schutera/highfive/issues/26).
- **Hardcoded Google Maps key** at `esp_init.cpp:362`. Tracked in
  [issue #18](https://github.com/schutera/highfive/issues/18). Listed
  in [11-risks-and-technical-debt](../11-risks-and-technical-debt/README.md).
