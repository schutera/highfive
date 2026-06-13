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

> **Find your LAN IP:** `ipconfig` on Windows (look for the WLAN or Ethernet adapter), `ip addr` on Linux/Mac. For a dev module you write this IP — not `localhost` — into `DEV_SERVER_HOST` before building (see "Point a dev module at a local stack"), because the ESP32 is a separate device on the network and `localhost` would resolve to the module itself.

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

Two dimensions vary between boards: the **form factor** (how you connect
it) and the **USB-serial chip** (which Windows driver it needs). Identify
both before flashing — a "completely new board" that won't enumerate is
almost always one of the chip rows below, not a firmware problem.

**Form factor**

| Board                          | How to connect                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ESP32-CAM-MB** (motherboard) | Micro-USB port, plug straight into the PC. Identified by the "ESP32-CAM-MB" label + micro-USB connector. No external adapter.                           |
| **Bare ESP32-CAM**             | No USB port. Needs a separate USB-to-TTL adapter (FTDI FT232 or CH340, **3.3 V logic**) wired to GND, 5 V, U0T→RX, U0R→TX, plus IO0→GND for flash mode. |

**USB-serial chip → Windows driver** (check Device Manager → Ports, or
`Get-PnpDevice` — the chip name shows in the device description)

| Chip on the board / adapter        | Windows driver                                       | If it doesn't enumerate                                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CH340 / CH341**                  | Usually already installed (most MB boards ship this) | Install the WCH CH340 VCP driver.                                                                                                                                                                             |
| **CP2102 / CP210x** (Silicon Labs) | Inbox on Win11; else Silicon Labs CP210x VCP         | Windows Update driver search.                                                                                                                                                                                 |
| **FTDI FT232R** (and clones)       | **Not inbox** — FTDI VCP driver, from Windows Update | Device shows as `FT232R USB UART` with a **warning/Error** and **no COM port**. See the fix in [troubleshooting.md → "New board enumerates but no COM port appears"](../troubleshooting.md). Needs **admin**. |

> Different units of the _same_ board model can carry different chips —
> don't assume "MB board = CH340". The FT232R case is the one that bites
> on a fresh Windows machine, because its driver is the only one not
> shipped with Windows.

### Verify flash voltage before flashing (GPIO12 / SD-card trap)

The ESP32 reads **GPIO12 (MTDI) at reset** to set the internal flash
regulator: **low/floating → 3.3 V** (correct for the AI-Thinker board's
flash chip), **high → 1.8 V**. The board's **micro-SD slot shares
GPIO12** (HS2_DATA2), so **an inserted SD card can pull GPIO12 high at
reset**, browning out the flash at 1.8 V. Symptoms: ROM `flash read err`,
endless boot loops before any firmware banner, `esptool` erases that
claim success in "0.0 seconds", and **`MD5 of file does not match data in
flash`** on upload.

Check the strap with a read-only `esptool` probe before flashing:

```powershell
$PORT = "COM13"   # set to your board's port (Device Manager -> Ports)
# Use whichever Python has esptool — find it with: py -3.12 -m esptool version
py -3.12 -m esptool --port $PORT --baud 115200 flash-id
```

> esptool v4+ accepts both `flash-id` (hyphen) and the legacy `flash_id`
> (underscore); other docs here use the underscore form via `esptool.py
<cmd>` — they're equivalent, not typos.

The output line **`Flash voltage set by a strapping pin: 3.3V`** is what
you want. If it says **`1.8V`**, eject any micro-SD card (and disconnect
anything wired to GPIO12) and re-probe — it must read 3.3 V before you
erase or flash. Full symptom/fix:
[troubleshooting.md → "flash read err / boot loop / MD5 mismatch"](../troubleshooting.md).

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

> **Required for any release build.** The Google Geolocation API key
> used by the firmware's first-boot WiFi-AP lookup is **build-time
> injected** — it is no longer hardcoded. `ESP32-CAM/build.sh` (the
> path that produces the web-installer `firmware.bin` an operator
> flashes) now **errors and exits** when no key is found — a keyless
> binary compiles cleanly, but the runtime guard skips the lookup and
> every module reports `(0, 0, 0)`, so it plots at Null Island in the
> Gulf of Guinea and is filtered out of the dashboard map (i.e. the
> module never appears anywhere the operator can see it). Failing the
> build is cheaper than shipping that.
>
> **Escape hatch:** set `HF_ALLOW_NO_GEO_KEY=1` to build a keyless
> binary on purpose — a CI compile check that is never flashed. The
> `pio run -e esp32cam` smoke env stays keyless without this flag,
> because it is a compile-only gate (not a release path) and produces
> a binary that is never flashed.
>
> **Coordinate generalization (ADR-020 / #145):** the firmware rounds the
> Google fix to ~1 km (2 dp) the moment it parses it (`hf::roundCoord` in
> `ESP32-CAM/lib/geolocation/`), so a newly onboarded module registers and
> reports an already-coarsened location — the precise fix never leaves the
> device. The server rounds independently too, so this changes nothing an
> operator sees beyond the module pin being deliberately ~1 km imprecise.

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
logged). `build.sh` likewise echoes `GeoKey: set (len=<N>)` when the
key is found and aborts with a self-describing `ERROR:` when it is
not. To run a CI compile check without a key on purpose, set the
escape hatch first:

```powershell
# Windows / PowerShell — keyless compile check, never flashed
$env:HF_ALLOW_NO_GEO_KEY = "1"; bash ESP32-CAM/build.sh
```

```bash
# Linux / macOS — keyless compile check, never flashed
HF_ALLOW_NO_GEO_KEY=1 bash ESP32-CAM/build.sh
```

Full mechanism, source order, and rotation procedure:
[`docs/08-crosscutting-concepts/auth.md` → "Third-party API keys:
Geolocation"](../08-crosscutting-concepts/auth.md#third-party-api-keys-geolocation).
The leak that prompted this design: [chapter 11 lessons-learned →
"Third-party API keys belong in build-time macros, not source"](../11-risks-and-technical-debt/README.md#third-party-api-keys-belong-in-build-time-macros-not-source-issue-18).

The maintainer issues the key from the project's Google Cloud
Console (restricted to the Geolocation API). Ask in the issue
tracker if you need access for a personal fork.

### Point a dev module at a local stack (`DEV_SERVER_HOST`)

> **Skip this for production builds.** Without it, the firmware bakes
> in the production server URLs (`https://highfive.schutera.com/new_module`
> for registration and `https://highfive.schutera.com/upload` for image
> upload) — the `#ifndef` defaults in
> [`ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`](../../ESP32-CAM/lib/firmware_defaults/firmware_defaults.h).
> The captive portal no longer has URL fields (see "Configuring a
> module" below), so a dev module that should talk to your LAN stack
> must be told at **build time**.

The server URLs are build-time injected, exactly like the Geolocation
key above. Write the LAN host or IP of the machine running
`docker compose` to the gitignored `ESP32-CAM/DEV_SERVER_HOST` file —
host only, no scheme, no port, no path:

```powershell
# Windows / PowerShell — from repo root
"192.168.1.50" | Out-File -NoNewline -Encoding ascii ESP32-CAM\DEV_SERVER_HOST
```

```bash
# Linux / macOS — from repo root
printf '%s' "192.168.1.50" > ESP32-CAM/DEV_SERVER_HOST
```

Or set the env var in the shell where you run `pio` / `build.sh`:

```bash
export DEV_SERVER_HOST="192.168.1.50"
```

The build (`ESP32-CAM/build.sh` and `ESP32-CAM/extra_scripts.py`) then
composes and injects
`-DHF_INIT_URL_DEFAULT="http://<host>:8002/new_module"` and
`-DHF_UPLOAD_URL_DEFAULT="http://<host>:8000/upload"` — port `8002` is
the duckdb-service host port, `8000` is the image-service host port (see
the service map in the root `CLAUDE.md`). When the file/env is absent
the firmware falls back to the production `#ifndef` defaults in
`firmware_defaults.h`. The under-the-hood URL fallback (used when the
saved `/config.json` has no `INIT_URL` / `UPLOAD_URL` — i.e. on every
fresh setup) is applied by `ESP32-CAM/esp_init.cpp`'s `loadConfig`.

This is plain HTTP on purpose: dev-box services do not terminate TLS,
so the LAN URLs stay `http://` while production stays `https://`. The
rationale for moving URLs off the form and into the build is
[ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md).

### Flash

```bash
cd ESP32-CAM
pio run -e esp32cam --target upload --upload-port <port>
```

Find the port: **Device Manager → Ports** on Windows — the entry names the chip (`USB-SERIAL CH340`, `Silicon Labs CP210x`, or `USB Serial Port` for FTDI), with its `COMx` in parentheses; `/dev/ttyUSB0` or `/dev/cu.usbserial-*` on Linux/Mac. If no `COMx` appears at all, the USB-serial driver isn't bound — see the "Hardware variants" driver table above.

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

The captive portal asks for **Wi-Fi credentials only** — SSID and
password. Everything else (module name, server URLs, camera settings)
is assigned under the hood, so there is nothing else to type
([ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md)).

| Field          | Value                                                                 |
| -------------- | --------------------------------------------------------------------- |
| Wi-Fi SSID     | Your 2.4 GHz network name (case-sensitive — copy-paste, don't retype) |
| Wi-Fi Password | Your network password                                                 |

Under the hood, after you save:

- **Module name** is auto-derived from the MAC
  (`ESP32-CAM/esp_init.cpp`'s `generateModuleName` →
  `hf::moduleNameFromMac`) — no field, no typos, no same-batch
  collisions.
- **Server URLs** are the compiled-in defaults: production
  (`https://highfive.schutera.com/...`) unless this firmware was built
  with `DEV_SERVER_HOST` set, in which case the LAN
  `http://<host>:8002/new_module` and `http://<host>:8000/upload` are
  used (see "Point a dev module at a local stack" above). To change the
  server a module talks to, re-build with the right `DEV_SERVER_HOST`
  and re-flash — there is no URL field on the form.
- **Camera settings** come from the production fallbacks in
  `ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`.

> **2.4 GHz only.** The ESP32 does not support 5 GHz. If your router shows a single SSID for both bands (band steering), the ESP32 should be assigned to 2.4 GHz automatically — but if it fails to connect, check your router's band-steering settings.

> **Same network.** The ESP32 must be on the same LAN as the server. If you configure it to join a phone hotspot while the server runs on your home router, the module cannot reach the server.

> **Capture cadence is hardcoded.** The shipping firmware captures once on first boot plus once daily at noon local time (`TZ_EU_CENTRAL` — `CET`/`CEST` — configured in `ESP32-CAM/esp_init.cpp`'s `configTzTime` call). There is no operator-configurable interval field on the form; an earlier `Capture Interval (ms)` knob was dead-weight (stored but never read) and was removed when issue #65 was resolved. If operator-configurable cadence is later wanted, the wiring would touch `ESP32-CAM/ESP32-CAM.ino`'s `loop` and interact with ADR-007's daily-reboot logic — a separate feature PR.

Click **Save Configuration**. The module reboots, joins your Wi-Fi, registers itself with the server, and starts uploading images. It will appear on the dashboard at `http://localhost:5173/dashboard` within a minute.

> **The config page now closes itself.** After you save, the page
> (served by `ESP32-CAM/host.cpp`'s `sendConfigForm`) posts a
> `hivehive-config-saved` message back to the setup wizard
> (`window.opener.postMessage`) and calls `window.close()` after a
> short delay. The wizard
> (`homepage/src/components/setup/useSetupWizard.ts`) listens for that
> message and auto-advances to the verification step, so you land back
> in the wizard without clicking through — no manual navigation. If
> your browser blocks `window.close()` or `postMessage` (some in-app
> and privacy-hardened browsers do), the page stays open with a "this
> page will close and take you back to setup — if it doesn't, switch
> back to the HiveHive tab" banner; switch tabs manually and use the
> de-emphasized **"I've finished configuring"** fallback link on
> wizard Step 4 (`Step4Configure.tsx`) to advance.

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

## Reconfiguration (re-flash)

**Reconfigure by re-flashing.** There is no factory-reset button. The
web-installer flash performs a full chip erase (`eraseAll: true` in
[`homepage/src/components/setup/flashEsp.ts`](../../homepage/src/components/setup/flashEsp.ts)'s
`flashEsp`), which wipes the NVS `configured` flag and the SPIFFS
`/config.json`. So after **any** (re)flash — web installer or
`pio run -t upload` — the module boots straight into its Wi-Fi setup
page (`ESP32-Access-Point`); re-enter Wi-Fi credentials there. To point
a module at a different server, set `DEV_SERVER_HOST` (or build the
production default), re-build, and re-flash — the URLs are baked in, not
on the form.

> **Already in AP mode and just want to re-enter Wi-Fi?** You don't have
> to re-flash for that — connect to `ESP32-Access-Point`, open
> <http://192.168.4.1>, and save the correct credentials. Re-flash is
> the path when you need to **clear** a saved config (wrong Wi-Fi that
> the board keeps retrying, or a server-URL change).

The "moved to a new network" case needs no re-flash: the module
auto-reopens its setup access point after `WIFI_FAIL_AP_FALLBACK_THRESH`
consecutive failed Wi-Fi joins
(`ESP32-CAM/ESP32-CAM.ino`). The least disruptive way to force that from
STA mode without a serial cable: reconnect to `ESP32-Access-Point`, open
`http://192.168.4.1`, and save intentionally wrong Wi-Fi credentials —
the board fails the threshold number of joins (~90 s total) and reopens
the AP automatically.

> The captive-portal **Factory reset** route was removed in
> [ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md):
> re-flash now erases config as a side effect, so the form button was
> dead weight. The earlier "hold IO0 for 5 seconds" procedure was already removed in #40 (unreachable on the AI Thinker ESP32-CAM-MB — GPIO0 is a strap pin).
> See chapter 11 "Lessons learned" for both post-mortems.

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
pio run -e esp32cam_ota -t upload --upload-port $MODULE
```

Note the `_ota` env suffix — `[env:esp32cam]` itself stays USB-only so
`pio run -e esp32cam -t upload --upload-port COM9` keeps working for
rapid dev iteration. The OTA-specific `upload_flags` (fixed callback
port for the Windows Firewall rule) live only on `[env:esp32cam_ota]`,
which inherits everything else from `esp32cam` via PlatformIO's
`extends`.

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

> **Cutting a release for the whole fleet?** Use the canonical
> end-to-end runbook: [firmware-release.md](firmware-release.md). It
> covers the full sequence (build → republish the frontend image →
> commit → `prod-<codename>` tag → verify), the gitignored-artifact
> publish step, and the `main`-vs-`production` branch model. The two
> paragraphs below are the firmware-side mechanics it builds on.

Bump `ESP32-CAM/VERSION` (per [ADR-006](../09-architecture-decisions/adr-006-bee-name-firmware-versioning.md)
the value is the next bee-species name), **and** bump
`ESP32-CAM/SEQUENCE` (PR II / issue #83) to the next integer. The
sequence number is the operator-controlled ordering signal that
prevents accidental downgrades — see
[ADR-008's "Sequence + allow_downgrade addendum"](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md#sequence--allow_downgrade-addendum-pr-ii-83)
for the comparator semantics. Then:

```bash
cd ESP32-CAM
bash build.sh
# Then deploy the updated homepage/public/* artifacts to the host.
```

`build.sh` runs unmodified on Linux, macOS, and Windows 11 + Git Bash;
the script auto-detects `%LOCALAPPDATA%/Arduino15`, `esptool.exe`, and
the right Python interpreter (rejecting the MS Store stub at
`python3.exe`) so no env overrides are needed on Windows (#99).

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
app-side counter in `forceRollbackIfPendingTooLong` (top of `setup()`)
accumulates one tick per faulty reboot and, after
`HF_OTA_MAX_PENDING_BOOTS = 3` consecutive panic/WDT/brownout cycles,
calls `esp_ota_mark_app_invalid_rollback_and_reboot()` to force the
bootloader to revert to the previous slot. Total recovery latency
≈ 30–60 s. No operator action needed. Arduino-ESP32's prebuilt
bootloader does NOT perform this rollback on its own (see
[ADR-008](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md)
for the full story); the app-side check is what's load-bearing.

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

**The one-time migration also re-formats SPIFFS.** The default and
the `min_spiffs` partition tables put SPIFFS at different offsets, so
the firmware's `SPIFFS.begin(true)` auto-formats on the mismatch.
Result: `/config.json` is wiped, the module boots into AP mode after
the migration flash, and the operator has to re-onboard via the
captive portal (Wi-Fi SSID/password only — server URLs are baked in at
build time, see ADR-018). Plan for this on deployed modules — schedule
the migration during an onboarding visit rather than from a remote
office.

After that one-time USB flash, every subsequent update can be OTA.
Symptom of trying to OTA-push to an un-migrated module: the upload
fails before the binary stream completes, or `Update.begin()` rejects
the image because there is no OTA slot to write to. The module keeps
booting the old firmware and the **Firmware** pill on the dashboard's
module-detail panel
([`homepage/src/components/ModulePanel.tsx`](../../homepage/src/components/ModulePanel.tsx))
never advances past the pre-OTA bee-name. See
[../11-risks-and-technical-debt/README.md](../11-risks-and-technical-debt/README.md)
"OTA migration is one-way".

### How to deliberately roll back a fleet (PR II / issue #83)

The new sequence-aware comparator refuses any OTA where
`manifest.sequence <= current.sequence` UNLESS the manifest also
declares `allow_downgrade: true`. This is the safety net against
accidental downgrades described in
[ADR-008's addendum](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md#sequence--allow_downgrade-addendum-pr-ii-83).
Sometimes you _need_ to downgrade — a freshly-flashed `carpenter`
seq=2 is panicking in the field and you want every module back on
the known-good `mason` seq=1.

> **Note for developers.** Binaries built without `build.sh` or
> `pio run` carry `FIRMWARE_SEQUENCE=0` (the Arduino-IDE fallback in
> `esp_init.h`) and **refuse every OTA regardless of
> `allow_downgrade`**. The rollback procedure below applies to
> properly-built fleet binaries only. To OTA a hand-compiled dev
> binary, USB-reflash a sequenced release first.

**Procedure:**

1. Build the rollback target normally — checkout the older commit,
   `bash ESP32-CAM/build.sh` (it will refuse to bump SEQUENCE
   _backwards_ in the file itself; that's OK, we're going to edit
   the manifest by hand).
2. The output `homepage/public/firmware.json` will declare
   `"sequence": 1`, `"allow_downgrade": false`. Open it and flip
   the flag to `true`:

   ```json
   {"version":"mason","sequence":1,"allow_downgrade":true, ...}
   ```

3. Deploy `homepage/public/*` as normal. On each module's next
   daily-reboot HTTP-OTA poll, the new `shouldOtaUpdate` sees
   `mason != carpenter`, `seq=1 <= current seq=2`, but
   `allow_downgrade=true` → flash proceeds. Watch the dashboard's
   firmware pill update as modules roll back over the next ~24h.
4. **CRITICAL: as soon as the rollback wave completes, run
   `bash ESP32-CAM/build.sh` again to publish a regular manifest
   (`allow_downgrade: false`) over the top of the hand-edited one.**
   Leaving `allow_downgrade: true` in the published manifest means
   ANY subsequent operator typo on SEQUENCE can re-trigger a
   downgrade. The flag is meant for a single, deliberate publish.

**Symptom you got it right:** the next regular release (bumped
SEQUENCE, new bee name, default `allow_downgrade: false`) flashes
the fleet forward as usual.

**Symptom you got it wrong (left flag set):** a future "this isn't
a real release, just a hot-fix" manifest accidentally lower-
sequenced still gets accepted. Worst case: an attacker who can MITM
your manifest URL can serve any previous binary they prefer. Until
the TLS+signing follow-up ADR lands, the manifest is unsigned and
this flag is the only thing standing between an attacker and a
forced downgrade.

---

For the firmware design, file layout, and runtime behaviour see
[../05-building-block-view/esp32cam.md](../05-building-block-view/esp32cam.md)
and [../06-runtime-view/esp-reliability.md](../06-runtime-view/esp-reliability.md).
