# Manual tests for OTA (#26)

Four manual tests gate the OTA feature. They cannot be automated
without a real ESP32-CAM on a LAN — they live here so the next person
can re-run them after firmware churn and have a single document to
copy the commands from. All four were exercised end-to-end on
`fix/esp-ota-round1-fixes` against a `192.168.178.121` AI Thinker
ESP32-CAM-MB; the relevant evidence (heartbeat history rows, serial
boot logs) is captured inline as "expected output". A test that does
not produce its expected output is a regression — open an issue.

## Setup once per dev machine

PowerShell commands; Linux/macOS equivalents in
[../07-deployment-view/esp-flashing.md](../07-deployment-view/esp-flashing.md).

**Firewall + WLAN profile** (only needed for T6 — admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "HiveHive ArduinoOTA" -Direction Inbound -Protocol TCP -LocalPort 55555 -Action Allow -Profile Any
Set-NetConnectionProfile -InterfaceAlias "WLAN" -NetworkCategory Private
```

The WLAN profile change is required: on Public profile, Windows
silently drops inbound TCP from LAN devices to user processes (espota's
callback) even with explicit Allow rules in place.

**Bring up the dev stack** (so the dev OTA proxy on duckdb-service is
serving `/firmware.json` and `/firmware.app.bin` for T2/T3/T4):

```powershell
cd c:\Users\<you>\VSCode\highfive
docker compose up -d --build
```

Verify `HIGHFIVE_DEV_OTA_PROXY=true` is set on the `duckdb-service`
container (compose default) — the routes only register when it is.

## T6 — ArduinoOTA LAN push

**What it proves**: a developer with USB cable + same LAN can push a
new build to a deployed module without unscrewing the enclosure.

**Steps**:

```powershell
$MODULE = "192.168.178.121"   # your module's IP
cd c:\Users\<you>\VSCode\highfive\ESP32-CAM
pio run -e esp32cam_ota -t upload --upload-port $MODULE
```

Note the `_ota` env suffix — `[env:esp32cam]` itself stays USB-only
so `pio run -e esp32cam -t upload --upload-port COM9` keeps working
for USB iteration.

**Expected output**:

```
Uploading: [============================================================] 100% Done...
[INFO]: Waiting for result...
[INFO]: Success
========================= [SUCCESS] Took ~40 s =========================
```

If you see `[ERROR]: No response from the ESP`, two likely causes:

1. Firewall rule missing or WLAN profile is Public. Re-check the setup
   step above.
2. The current firmware has `delay(30000)` instead of the polling
   loop, so `ArduinoOTA.handle()` runs only once per 30 s and espota
   gives up before the OK reply lands. The fix shipped in
   `235f324 fix(esp): poll ArduinoOTA.handle() during the inter-capture sleep`;
   a regression of that block would resurrect this symptom.

A post-OTA heartbeat with low `uptime_ms` confirms mark-valid passed:

```powershell
Invoke-RestMethod -Uri "http://localhost:8002/heartbeats/e89fa9f23a08" |
  Select-Object -ExpandProperty heartbeats | Select-Object -First 1
```

## T2 — HTTP boot-pull OTA

**What it proves**: a module that has joined WiFi and registered will
download a newer firmware on boot, flash the inactive slot, and run
the new code on next reset. This is the production OTA path — every
ADR-007 daily reboot exercises it.

**Steps**:

1. Bump VERSION to the next bee species name:
   ```powershell
   "leafcutter" | Out-File -NoNewline -Encoding ascii c:\Users\<you>\VSCode\highfive\ESP32-CAM\VERSION
   ```
2. Build the app binary and dev manifest (no `arduino-cli` required):
   ```powershell
   cd c:\Users\<you>\VSCode\highfive\ESP32-CAM
   pio run -e esp32cam
   python build_dev_artifact.py
   ```
   The script copies `.pio/build/esp32cam/firmware.bin` to
   `homepage/public/firmware.app.bin` and writes
   `homepage/public/firmware.json`. **The merged `firmware.bin` (web
   installer) is _not_ produced by this script** — only the OTA pair.
   For a full release artifact set, run `bash ESP32-CAM/build.sh`
   (requires `arduino-cli`).
3. Restart Vite so it indexes the new `public/` entries:
   ```powershell
   docker compose restart homepage
   ```
4. Trigger a module reset:
   ```powershell
   python scripts\esp_reset.py COM9
   ```
   (`scripts/esp_reset.py` toggles RTS to drive EN low briefly. The
   same logic is inline in `scripts/esp_capture.py` for combined
   reset-and-capture runs. See `scripts/README.md`.)

**Expected output**:

```powershell
Invoke-RestMethod -Uri "http://localhost:8002/heartbeats/e89fa9f23a08" |
  Select-Object -ExpandProperty heartbeats | Select-Object -First 3 |
  Format-Table received_at, fw_version, uptime_ms
```

```
received_at                fw_version uptime_ms
-----------                ---------- ---------
2026-05-14T11:30:21.565999 leafcutter     12713  <-- post-OTA boot, new slot
2026-05-14T11:23:38.214545 carpenter       7763  <-- previous boot, old slot
```

And in `docker compose logs duckdb-service`:

```
[heartbeat] mac=... fw=leafcutter ...
172.18.0.1 - - "GET /firmware.json HTTP/1.1" 200
172.18.0.1 - - "GET /firmware.app.bin HTTP/1.1" 200
```

## T3 — Boot-heartbeat fwVersion appears before mark-valid

**What it proves**: the dashboard's `fwVersion` panel updates within
seconds of the new slot reaching the boot heartbeat — not after the
full warm-up and mark-valid completion. ADR-008 trades off "brief
flicker if rollback happens" against "fast post-flash refresh"; this
test confirms the first half.

**Steps**: implicit in T2. The boot heartbeat at the start of T2's
post-OTA boot fires _before_ `esp_ota_mark_app_valid_cancel_rollback()`
at the end of `setup()` — visible as the `uptime_ms ≈ 7–13 s` row in
the heartbeat output. If the slot rolls back (T4), the next clean
boot's heartbeat corrects the displayed version automatically.

## T4 — Bricked-firmware rollback

**What it proves**: a firmware that panics before mark-valid is
recovered by the bootloader switching to the previous slot. No
operator visit needed.

**Steps**:

1. Edit `ESP32-CAM/ESP32-CAM.ino`: insert `abort();` _immediately
   before_ `esp_ota_mark_app_valid_cancel_rollback();` near the end
   of `setup()`. The comment block above the call is the right
   anchor.
2. Bump VERSION to a new bee species name:
   ```powershell
   "mining" | Out-File -NoNewline -Encoding ascii c:\Users\<you>\VSCode\highfive\ESP32-CAM\VERSION
   ```
3. Build + regenerate manifest:
   ```powershell
   cd c:\Users\<you>\VSCode\highfive\ESP32-CAM
   pio run -e esp32cam
   python build_dev_artifact.py
   ```
4. Restart Vite:
   ```powershell
   docker compose restart homepage
   ```
5. Trigger module reset:
   ```powershell
   python scripts\esp_reset.py COM9
   ```

**Expected behaviour** (observed live during the round-2 manual run on
`fix/esp-ota-round1-fixes` against module `192.168.178.121`):

```
received_at         fw_version  uptime_ms   pv_boots after this boot
2026-05-14T12:45:30 leafcutter      6926    0  (mark-valid reset)  <- ROLLBACK FIRED
2026-05-14T12:45:00 mining          7000    3  (boot 3 triggers rollback — no heartbeat from this boot)
2026-05-14T12:44:50 mining          7000    2
2026-05-14T12:44:40 mining          7000    1
2026-05-14T12:44:00 leafcutter     12200    0  <- pre-T4 stable state
```

The state-free counter at the top of `setup()` (`forceRollbackIfPendingTooLong`)
increments `Preferences("ota").pv_boots` on every boot. The reset to 0
happens inside the `esp_ota_mark_app_valid_cancel_rollback()` block at
the end of `setup()` — so a slot whose setup never reaches the end
(e.g. `abort();` before mark-valid) leaves the counter monotonic.
Boot 3 crosses `HF_OTA_MAX_PENDING_BOOTS = 3`,
`esp_ota_mark_app_invalid_rollback_and_reboot()` fires before the
heartbeat, and the next reset is into the previous valid slot.

Observed latency from first `mining` boot to recovered `leafcutter`
boot: ~3 cycles × ~10 s/cycle ≈ 30–45 s in the round-2 run
(reproduces every time once the firmware in BOTH slots carries the
state-free counter — the OLDER round-1 firmware with a state-gated
check looped indefinitely). The rollback is forced by the app, NOT
by the ROM bootloader: Arduino-ESP32's prebuilt bootloader ships
with `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=n` and never transitions
a slot out of `ESP_OTA_IMG_NEW`, so neither
`esp_ota_mark_app_valid_cancel_rollback()` nor any
`esp_ota_get_state_partition()`-based check is load-bearing for
recovery. See
[../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md).

**Cleanup (mandatory before commit)**: revert the `abort();` edit,
reset VERSION to the actual release name, rebuild + regenerate manifest,
restart Vite, reset the module. Confirm the heartbeat returns to the
release name with full uptime growing past 30 s.

## Dev-only infrastructure used by T2/T3/T4

- `duckdb-service/routes/dev_ota_proxy.py` — registers `/firmware.json`
  and `/firmware.app.bin` only when `HIGHFIVE_DEV_OTA_PROXY=true`.
  Proxies to homepage:5173 (Vite dev). Production homepage runs nginx
  and serves these from disk directly — the proxy stays unregistered.
- `homepage/vite.config.ts` — `server.allowedHosts: ['homepage', 'localhost']`
  lets the proxy reach Vite. Required by Vite ≥5; inert in production
  (nginx, not Vite).
- `ESP32-CAM/build_dev_artifact.py` — generates `firmware.app.bin` +
  `firmware.json` from PIO output without invoking `arduino-cli`. Use
  for T2/T4 dev iteration. The release path stays `build.sh`.
- `scripts/esp_reset.py` / `esp_capture.py` / `esp_monitor.py` —
  pyserial helpers for resetting the chip and capturing serial output
  without a physical button press or the interactive `pio device monitor`.
  See [`scripts/README.md`](../../scripts/README.md).
