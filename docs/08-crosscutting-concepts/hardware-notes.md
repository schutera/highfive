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

## Wi-Fi constraints

- **2.4 GHz only.** The ESP32 does not support 5 GHz Wi-Fi. If your
  router uses one SSID for both bands (band steering), the ESP should
  be steered to 2.4 GHz automatically — but aggressive steering can
  reject it. Test with a phone hotspot pinned to 2.4 GHz to isolate.
- **SSID is case-sensitive** and special characters matter. Copy-paste
  from your device's Wi-Fi settings rather than retyping.

## Server URLs

The Init/Upload base URLs in the config form must use the host
machine's **LAN IP** (e.g. `192.168.178.25`), **not** `localhost`.
The ESP32 is a separate device on the network — `localhost` resolves
to the ESP32 itself.

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

## Factory reset

Hold the **IO0** button for **5 seconds** while the board is powered.
The configuration is cleared and the `ESP32-Access-Point` reopens.
Do not press RST during the hold — that enters flash mode instead.

## Onboarding skill

For a guided, interactive setup session, invoke `/esp32-onboarding`.
The skill walks through all seven phases (server stack check, hardware
identification, flashing, serial capture, AP configuration,
registration verification, dashboard confirmation).
