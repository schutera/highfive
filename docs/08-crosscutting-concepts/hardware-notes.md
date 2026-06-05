# ESP32-CAM hardware notes

Quick reference for anyone working on or debugging the edge modules.
For procedural setup, see
[../07-deployment-view/esp-flashing.md](../07-deployment-view/esp-flashing.md).
For symptom-based diagnosis, see
[../troubleshooting.md](../troubleshooting.md).

## Access point

| Setting  | Value                           |
| -------- | ------------------------------- |
| SSID     | `ESP32-Access-Point`            |
| Password | `esp-12345`                     |
| Source   | `ESP32-CAM/host.cpp` lines 9–10 |

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

## Wi-Fi constraints

- **2.4 GHz only.** The ESP32 does not support 5 GHz Wi-Fi. If your
  router uses one SSID for both bands (band steering), the ESP should
  be steered to 2.4 GHz automatically — but aggressive steering can
  reject it. Test with a phone hotspot pinned to 2.4 GHz to isolate.
- **SSID is case-sensitive** and special characters matter. Copy-paste
  from your device's Wi-Fi settings rather than retyping.

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
firmware auto-falls back to AP mode on its own.

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
