# ESP32-CAM hardware notes

Quick reference for anyone working on or debugging the edge modules.
For procedural setup, see
[../07-deployment-view/esp-flashing.md](../07-deployment-view/esp-flashing.md).
For symptom-based diagnosis, see
[../troubleshooting.md](../troubleshooting.md).

## Access point

| Setting  | Value                                                 |
| -------- | ----------------------------------------------------- |
| SSID     | `ESP32-Access-Point`                                  |
| Password | `esp-12345`                                           |
| Source   | `HOST_SSID` / `HOST_PASSWORD` in `ESP32-CAM/host.cpp` |

Old documentation (now removed) called it `HiveHive-Access-Point`. It
never had that name in the code.

## Browser requirement for the config form

The form at `http://192.168.4.1` requires **Chrome or Firefox**.
Brave and some mobile browsers silently fail to submit the session
token, causing the form to reload blank after Save. There is no error
message — the form just looks like nothing happened.

## Camera flash LED — capture stays dark

On the AI-Thinker board the bright **GPIO4** status LED doubles as the
camera flash. Capture is deliberately **dark**: the `Uploading` liveness
pulse is fired from `ESP32-CAM/client.cpp`'s `postImage` **after** the
frame is grabbed (`esp_camera_fb_get()` returns), not before it. The LED
is therefore off during the capture instant — saves energy and stops
flashing the operator on every shot. The brief ~50 ms upload blink is
preserved (it now marks the start of upload, just after the dark
capture). Earlier firmware set the pulse on `captureAndUpload` entry,
which lit the LED while the camera grabbed the frame.

## USB-serial chip varies per board (Windows driver)

The USB-serial chip is **not the same on every board**, and that decides
which Windows driver is needed:

| Chip          | Driver on Windows                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CH340 / CH341 | Usually already installed (most MB boards)                                                                                                                    |
| CP2102/CP210x | Inbox on Win11, else Silicon Labs VCP                                                                                                                         |
| FTDI FT232R   | **Not inbox** — pulled from Windows Update; needs **admin** to install. Until bound, the device shows as `FT232R USB UART` with an error and **no COM port**. |

Don't assume "ESP32-CAM-MB ⇒ CH340" — different units of the same model
ship different chips. The full chip→driver matrix and the fix for the
no-COM-port FTDI case live in
[../07-deployment-view/esp-flashing.md](../07-deployment-view/esp-flashing.md)
and [../troubleshooting.md](../troubleshooting.md).

## Flash voltage strap (GPIO12) — keep the SD slot empty when flashing

GPIO12 (MTDI) is read **at reset** to set the flash regulator: low/floating
→ 3.3 V (correct for this board's flash chip), high → 1.8 V. The on-board
**micro-SD slot shares GPIO12**, so **an inserted SD card pulls it high**
and browns the flash out at 1.8 V — producing ROM `flash read err`, boot
loops before any firmware banner, `esptool` erases that "succeed" in 0.0 s,
and `MD5 ... does not match` on upload. Confirm with a read-only probe
before flashing — `esptool ... flash-id` prints `Flash voltage set by a
strapping pin: 3.3V` (must not be `1.8V`). Eject the SD card and re-probe
if it reads 1.8 V. Symptom/fix:
[../troubleshooting.md](../troubleshooting.md).

## Wi-Fi constraints

- **2.4 GHz only.** The ESP32 does not support 5 GHz Wi-Fi. If your
  router uses one SSID for both bands (band steering), the ESP should
  be steered to 2.4 GHz automatically — but aggressive steering can
  reject it. Test with a phone hotspot pinned to 2.4 GHz to isolate.
- **SSID is case-sensitive** and special characters matter. Copy-paste
  from your device's Wi-Fi settings rather than retyping.

## Host-side Wi-Fi/Bluetooth radio coexistence (onboarding, #137)

The softAP is **2.4 GHz-only** (`WiFi.softAP(HOST_SSID, HOST_PASSWORD, 1, 0)`
in `ESP32-CAM/host.cpp` — channel 1, 2.4 GHz band). Most laptops use a
**combo Wi-Fi + Bluetooth card sharing a single 2.4 GHz radio/antenna**
(Intel AX2xx, Realtek, …). When the card switches to 2.4 GHz to associate
with the ESP AP, it can starve the Bluetooth side and **drop a Bluetooth
mouse/keyboard** — which reads as a "freeze" and blocks the user from
typing the AP password (`esp-12345`), dead-ending the setup wizard at
Step 3.

This is a **host-side radio quirk, not a firmware bug** — the ESP32 has no
5 GHz radio to move the AP to, so there is no firmware fix. Mitigations:

- **Pair from a phone (recommended).** A phone has its own radio + a
  touchscreen, so the coexistence fight and the BT peripherals are out of
  the loop. The setup wizard Step 3 now surfaces this as the default path
  (`homepage/src/components/setup/Step3WiFi.tsx`).
- **On the laptop:** use a **wired USB** or the **built-in**
  keyboard/trackpad (a 2.4 GHz USB dongle has the same shared-radio
  problem — must be wired or built-in). Joining via a saved
  `netsh wlan add profile` profile also avoids typing into the OS popup.

Symptom + fix also in [../troubleshooting.md](../troubleshooting.md).

## Server URLs

Operators no longer enter server URLs — the config form is Wi-Fi-only and
production modules reach `https://highfive.schutera.com` baked in at build
time. **Developers** targeting a local stack set the host machine's **LAN
IP** (e.g. `192.168.178.25`), **not** `localhost`, in the gitignored
`ESP32-CAM/DEV_SERVER_HOST` build file (see
[esp-flashing.md](../07-deployment-view/esp-flashing.md) and
[ADR-018](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md)).
`localhost` would resolve to the ESP32 itself — it is a separate device on
the network.

The ESP32 and the server must be on the **same LAN**. A common
mistake is configuring the module to join a phone hotspot while the
server runs on the home router.

For the clean dev-flash path (`make flash-dev`, which refuses to bake
production by accident) and the no-rebuild USB-serial retarget
(`set-server`), see
[esp-flashing.md](../07-deployment-view/esp-flashing.md) and the
[ADR-018 amendment](../09-architecture-decisions/adr-018-captive-portal-wifi-only.md#amendment-issue-156-developer-usb-serial-server-override).

## Developer USB-serial console (issue #156)

A developer-only command console runs over the USB serial line — `set-server`,
`clear-server`, `show-config`, `reopen-portal` (see
[esp-flashing.md → Retarget without rebuilding](../07-deployment-view/esp-flashing.md#retarget-a-flashed-module-without-rebuilding-usb-serial)).
It is **not** on the captive portal; it needs the cable.

Two hardware gotchas when driving it:

- **The boot window is brief.** Commands typed by hand may miss the
  pre-registration window. Use `scripts/esp_reset.py` / `scripts/esp_capture.py`
  to reset the board and have the command **already buffered** in the UART, or
  paste it the instant the `[serial] dev console ready` hint appears.
- **DTR/RTS must stay deasserted** or opening the monitor pulls `EN` low and
  holds the ESP in reset (an apparently-silent serial line). `platformio.ini`
  sets `monitor_rts = 0` / `monitor_dtr = 0`; the `scripts/esp_*.py` helpers do
  the same. A raw `pyserial` session that asserts them will keep the board
  reset.

## Windows Firewall

On a Windows host, ports **8000** (image-service) and **8002**
(duckdb-service) need inbound TCP allow rules so LAN devices (ESP32
modules) can reach the services. One-time, in an **admin** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "HiveHive image-service (8000)" -Direction Inbound -Protocol TCP -LocalPort 8000 -Action Allow -Profile Any
New-NetFirewallRule -DisplayName "HiveHive duckdb-service (8002)" -Direction Inbound -Protocol TCP -LocalPort 8002 -Action Allow -Profile Any
```

## Reconfigure or reset a module

There is no in-firmware factory-reset control — the captive portal is
Wi-Fi-only. To reconfigure (new SSID, changed password, or a full
wipe), **re-flash** the module: flashing does a full chip erase, which
clears the saved config (the NVS `configured` flag and SPIFFS
`/config.json`), so the module reopens its Wi-Fi setup page at
<http://192.168.4.1> on the next boot. Re-flash via the homepage setup
wizard (Step 2) or the standalone web installer.

If you only need to move the module to a different network you can skip
the re-flash: cause three consecutive failed WiFi joins and the
firmware auto-falls back to AP mode on its own. With a USB cable
attached, `reopen-portal` on the developer serial console does the same
**immediately and without erasing Wi-Fi** (it flips the NVS `configured`
flag and restarts; Wi-Fi creds live in SPIFFS, so the portal reopens
prefilled) — handy for retargeting a module's server without a full wipe.

> The IO0-hold procedure listed in older revisions was unreachable on
> AI Thinker ESP32-CAM-MB — GPIO0 is a strap pin, holding it LOW at
> boot enters UART download mode rather than running the firmware
> reset code. Removed in #40; see chapter 11 "Lessons learned" for the
> post-mortem.

## Onboarding skill

For a guided, interactive setup session, invoke `/esp32-onboarding`.
The skill walks through all seven phases (server stack check, hardware
identification, flashing, serial capture, AP configuration,
registration verification, dashboard confirmation).
