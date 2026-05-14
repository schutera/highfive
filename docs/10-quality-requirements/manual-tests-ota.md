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

**What it proves**: the dashboard's **Firmware** pill (rendered in
`ModulePanel.tsx`'s module-detail header, sourced from
`Module.latestHeartbeat.fwVersion`) updates within seconds of the new
slot reaching the boot heartbeat — not after the full warm-up and
mark-valid completion. ADR-008 trades off "brief flicker if rollback
happens" against "fast post-flash refresh"; this test confirms the
first half.

**Steps**: implicit in T2. The boot heartbeat at the start of T2's
post-OTA boot fires _before_ `esp_ota_mark_app_valid_cancel_rollback()`
at the end of `setup()` — visible as the `uptime_ms ≈ 7–13 s` row in
the heartbeat output AND as a refreshed **Firmware <bee-name>** pill
on the dashboard's module-detail panel (open the module card on the
map). If the slot rolls back (T4), the next clean boot's heartbeat
corrects the displayed version automatically.

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

**Expected behaviour — heartbeat schema.** `duckdb-service`'s
`module_heartbeats` table stores `module_id, battery, rssi,
uptime_ms, free_heap, fw_version` and `received_at` (set by
`duckdb-service/routes/heartbeats.py`'s `post_heartbeat`). The
`/heartbeats/<id>` GET returns the same fields minus `module_id`
(it's in the URL). The table below is excerpted from
`Invoke-RestMethod -Uri http://localhost:8002/heartbeats/e89fa9f23a08?limit=10`
during the round-3 manual run on `192.168.178.121`; the
`received_at` ISO timestamps are abbreviated to time-only and only
the six T4-cycle rows are shown — the actual response carries full
`2026-05-14T14:15:29.xxxxxx` and ten rows by default:

```
received_at         fw_version  uptime_ms
14:15:29 UTC        mining          6998   <- cycle 2 boot 3 — heartbeat fired
14:15:20 UTC        mining          7106   <- cycle 2 boot 2 — heartbeat fired
14:15:10 UTC        mining          6888   <- cycle 2 boot 1 — heartbeat fired
14:14:44 UTC        mining          7109   <- cycle 1 boot 3 — heartbeat fired
14:14:34 UTC        mining          7184   <- cycle 1 boot 2 — heartbeat fired
14:14:24 UTC        mining          8162   <- cycle 1 boot 1 — heartbeat fired
```

Annotations are derived, not from the table: each visible row IS a
heartbeat (boots that fired their boot-heartbeat call). The boot
that triggers rollback fires `esp_ota_mark_app_invalid_rollback_and_reboot()`
at the top of `setup()` BEFORE the heartbeat path runs, so it
produces no row at all — those "phantom" boots are inferred from
the gap timing, not visible in the table. Same for the leafcutter
slot's brief life between rollback and the next OTA download: its
`httpOtaCheckAndApply` runs before `sendHeartbeat:boot`, so the
re-OTA happens without ever surfacing a leafcutter heartbeat.

The 3-then-gap-then-3 cadence is the rollback signal: each cycle
shows three mining heartbeats whose `esp_reset_reason()` was SW
(boot 1, first boot of new OTA slot — clean SW reboot from the
explicit `ESP.restart()` after `Update.end()` in
`ESP32-CAM/ota.cpp`'s `httpOtaCheckAndApply`) followed by PANIC
(boots 2 and 3, after `abort()`). Boot 4 of each cycle (not visible)
crosses
`HF_OTA_MAX_PENDING_BOOTS = 3`, fires the rollback, and the
~26 s wall-clock gap captures the rollback + leafcutter boot +
re-OTA + new mining slot boot — only that new boot's heartbeat is
recorded, starting the next cycle.

**Expected behaviour — serial log.** This block predicts the
patterns `python scripts\esp_capture.py COM9 90` will emit during a
T4 cycle — the exact log strings come from the `Serial` /
`logf` calls in `ESP32-CAM/ESP32-CAM.ino`'s `forceRollbackIfPendingTooLong`
and the surrounding setup() flow. A run that does NOT show
`[OTA] faulty-boot N/3` followed eventually by
`[OTA] threshold reached — forcing rollback` is a regression
(rollback isn't firing). Capture verbatim during your own bench run
if you want a literal trace; the strings to grep for are:

```
[BOOT] fw=mining reset_reason=3 boot_count=N  <- first mining boot; rr=3 = ESP_RST_SW, doesn't count
[STAGE] sendHeartbeat:boot took=...
abort() was called at PC ... on core 1
Rebooting...
[BOOT] fw=mining reset_reason=4 boot_count=N+1  <- rr=4 = ESP_RST_PANIC, counts
[OTA] faulty-boot 1/3 (reset_reason=4)
...
[BOOT] fw=mining reset_reason=4 boot_count=N+2
[OTA] faulty-boot 2/3 (reset_reason=4)
...
[BOOT] fw=mining reset_reason=4 boot_count=N+3
[OTA] faulty-boot 3/3 (reset_reason=4)
[OTA] threshold reached — forcing rollback
Rebooting...
[BOOT] fw=leafcutter reset_reason=3  <- rolled back; SW because it's the rollback's ESP.restart
```

The `[OTA] faulty-boot N/3 (reset_reason=N)` line is emitted by
`forceRollbackIfPendingTooLong`'s `logf` in
`ESP32-CAM/ESP32-CAM.ino`; the `[OTA] threshold reached` line
immediately precedes the rollback call. A run that does NOT show
both lines is a regression — the counter is not incrementing.

Observed total latency from first `mining` heartbeat to recovered
`leafcutter` slot: ~4 boots × ~10 s ≈ 40–60 s. Reproducible every
run.

The rollback is forced by the app, NOT by the ROM bootloader:
Arduino-ESP32's prebuilt bootloader ships with
`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=n` and never transitions a
slot out of `ESP_OTA_IMG_NEW`. Neither
`esp_ota_mark_app_valid_cancel_rollback()` nor any
`esp_ota_get_state_partition()`-based check is load-bearing for
recovery. Full design context in
[../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md](../09-architecture-decisions/adr-008-firmware-ota-partition-and-rollback.md);
lessons-learned in
[../11-risks-and-technical-debt/README.md](../11-risks-and-technical-debt/README.md)
"OTA rollback isn't bootloader-driven on Arduino-ESP32".

**Cleanup (mandatory before commit)**: revert the `abort();` edit,
reset VERSION to the actual release name, rebuild + regenerate manifest,
restart Vite, reset the module. Confirm the heartbeat returns to the
release name with full uptime growing past 30 s.

### T4 alternative: USB-bypass for marginal-RSSI bench runs

If the module's WiFi RSSI is weaker than ~-75 dBm, the 1.16 MB OTA
download in step 5 above is unreliable — TCP timeouts mid-stream
leave the inactive slot unwritten and the test never gets past
`leafcutter`. The state-free counter can still be exercised
without depending on the OTA pipe by USB-flashing the
abort-instrumented binary directly:

```powershell
"bumblebee" | Out-File -NoNewline -Encoding ascii c:\Users\<you>\VSCode\highfive\ESP32-CAM\VERSION
cd c:\Users\<you>\VSCode\highfive\ESP32-CAM
# (with `abort();` already inserted before mark-valid in setup())
pio run -e esp32cam -t upload --upload-port COM##
python $env:USERPROFILE\.platformio\packages\tool-esptoolpy\esptool.py --chip esp32 --port COM## erase_region 0xe000 0x2000
```

The `erase_region` call clears the `otadata` partition so the
bootloader picks the freshly-flashed `app0`. Watch with
`python scripts\esp_capture.py COM## 60` and grep for `faulty-boot N/3`
and `threshold reached — forcing rollback`. This proves the
**firmware-side rollback logic** (reset-reason gate, NVS counter,
threshold check, and `esp_ota_mark_app_invalid_rollback_and_reboot()`
call). It does NOT prove the bootloader actually flips slots,
because the `erase_region` step wipes the OTA-validity record —
in this test setup the rollback call returns `ESP_FAIL` ("no
previously-valid slot to roll back to"), the firmware falls through
per its commented behaviour, and the bricked slot keeps cycling.
A production-deployed module retains the previous slot's VALID
record and the call therefore completes the bootloader flip.

Verified on `fix/esp-ota-round1-fixes`, round-2 manual test run
on `192.168.178.121`. Serial excerpt:

```
[BOOT] fw=bumblebee reset_reason=4 boot_count=152
[BOOT] last_stage_before_reboot=setup:ota_mark_valid
[OTA] faulty-boot 3/3 (reset_reason=4)
[OTA] threshold reached — forcing rollback
```

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
