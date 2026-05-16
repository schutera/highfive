# Manual tests for field-reliability bundle (PR II — #89, #49, #83)

> **Status: not yet executed.** Round-2 senior-review P1: this
> runbook was written from code-reading during PR II authoring; no
> module has been physically reset, no `firmware.json` has been hand-
> edited, no `python scripts/esp_capture.py` has been run. Every
> `Expected serial output` block below is the **predicted** behaviour
> based on the source code, not observed evidence. The next operator
> to run a hardware iteration should re-verify each `Expected` block
> and check off the test in the PR body. CLAUDE.md "Verifying UI
> claims, wire shapes, and component-test fixtures" applies — pin
> the observed result against the prediction before treating any of
> these as "done".

Five manual tests gate the field-reliability bundle. They cannot be
automated without a real ESP32-CAM on a LAN — they live here so the
next person can re-run them after firmware churn and have a single
document to copy the commands from. T1–T3 cover the OTA sequence-
aware downgrade refusal (#83); T4–T5 cover the geolocation retry +
heartbeat-side recovery (#89). The dashboard map filter (#49) is
covered by the homepage smoke test in the PR body.

Sibling file: [`manual-tests-ota.md`](manual-tests-ota.md) covers the
original OTA happy-path tests (T1–T6 of the #26 bundle). The tests
in _this_ file are layered on top — they assume the prerequisites of
that file are already satisfied (firmware flashed, WLAN profile
configured, dev stack up).

## Setup once per dev machine

Same as [`manual-tests-ota.md`'s "Setup once per dev machine"](manual-tests-ota.md#setup-once-per-dev-machine).
Additionally, you'll need a way to temporarily break the module's
internet connectivity for T5 (a captive-portal access point, or
unplugging the home router's WAN cable for 30 s).

## T1 — Sequence-aware OTA no-op (#83 happy path)

**What it proves**: with the same SEQUENCE on both ends, the new
firmware sees no update opportunity. (Pre-#83, this scenario worked
the same way — the test is here to pin the comparator log line so
T2/T3 below can be distinguished from a generic "no update".)

**Steps**:

1. Flash a dev module to the PR-II firmware via USB:
   ```powershell
   $MODULE_PORT = "COM9"
   cd c:\Users\<you>\VSCode\highfive\ESP32-CAM
   pio run -e esp32cam --target upload --upload-port $MODULE_PORT
   ```
2. Re-publish `firmware.json` without bumping anything:
   ```powershell
   bash ESP32-CAM/build.sh
   ```
3. Wait for the next daily-reboot HTTP-OTA poll (or reset the module
   via `python scripts/esp_reset.py --port $MODULE_PORT`).

**Expected serial output**:

```
[OTA] no update: current=mason seq=1, manifest=mason seq=1 allow_downgrade=0
```

The `seq=1` on both sides plus `allow_downgrade=0` is the diagnostic:
T2/T3 below should show different numbers.

## T2 — Sequence-aware OTA downgrade refusal (#83 core fix)

**What it proves**: a manifest claiming a LOWER sequence is refused
without an explicit override. This is the pingpong scenario from
chapter-11 "OTA `shouldOtaUpdate` accepts downgrades" closed at the
firmware level.

**Steps**:

1. After T1, hand-edit `homepage/public/firmware.json` to declare
   `sequence: 0` while keeping the module at SEQUENCE=1:
   ```json
   {"version":"leafcutter","sequence":0,"allow_downgrade":false,"app_md5":"...","app_size":...}
   ```
   (Keep the `app_md5` and `app_size` pointing at a real `firmware.app.bin`
   so the parse succeeds — we want the _comparator_ to refuse, not
   the parser to reject.)
2. Reset the module.

**Expected serial output**:

```
[OTA] no update: current=mason seq=1, manifest=leafcutter seq=0 allow_downgrade=0
```

Module stays on `mason`. **The firmware does NOT download
`firmware.app.bin`**, and the dashboard's Firmware pill remains
`mason`.

## T3 — Deliberate rollback with allow_downgrade (#83 escape hatch)

**What it proves**: the `allow_downgrade: true` operator override
works. This is the supported procedure documented in
[`docs/07-deployment-view/esp-flashing.md` "How to deliberately roll
back a fleet"](../07-deployment-view/esp-flashing.md#how-to-deliberately-roll-back-a-fleet-pr-ii--issue-83).

**Steps**:

1. After T2, edit `homepage/public/firmware.json` again — same
   sequence=0, but flip the flag:
   ```json
   {"version":"leafcutter","sequence":0,"allow_downgrade":true,"app_md5":"...","app_size":...}
   ```
2. Reset the module.

**Expected serial output**:

```
[OTA] update available: mason seq=1 -> leafcutter seq=0 (... bytes, md5=..., allow_downgrade=1)
```

…followed by the normal download + flash flow. After reboot the
module reports `leafcutter` to the dashboard.

**Critical follow-up**: re-publish a regular manifest
(`bash ESP32-CAM/build.sh` produces one with
`allow_downgrade: false`) over the top of the hand-edited one.
Leaving `allow_downgrade: true` on the homepage is the exact foot-
gun the runbook warns about.

## T4 — Geolocation boot retry success (#89 happy path)

**What it proves**: under normal home-WiFi conditions, the first
boot retry attempt succeeds and the module registers with a plausible
location. (Pre-#89, this also worked first-time — the test pins the
new log line "success on attempt 1" so T5 below can be distinguished
from a fluke.)

**Steps**:

1. Factory-reset the module to clear any cached config (jumper +
   reboot per [`esp-flashing.md` "Reconfiguration"](../07-deployment-view/esp-flashing.md#reconfiguration-factory-reset)).
2. Re-onboard via the captive portal.
3. Capture the boot serial:
   ```powershell
   python scripts/esp_capture.py --port COM9 --seconds 60 > t4.log
   ```

**Expected**:

- Serial contains `[getGeolocation] success on attempt 1 (lat=... lng=... acc=...)`.
- Dashboard shows the module at the correct location (within Google's
  geolocation accuracy radius — typically ~30 m for residential WiFi).
- No "Location pending" pill in the side-list.

## T5 — Geolocation boot retry fails, heartbeat recovers (#89 core fix)

**What it proves**: when boot-time geolocation cannot get a fix, the
module still registers (at the (0,0) sentinel), the dashboard flags
it with the "Location pending" pill, and the heartbeat-side recovery
patches the location once a fix lands. This is the central #89 fix.

**Steps**:

1. Factory-reset the module.
2. **Before** powering it back on, break the module's path to
   `googleapis.com`. Options:
   - Block egress at the router (firewall rule to drop traffic to
     `googleapis.com`). Most reliable.
   - Unplug the home router's WAN cable for 30 s, time the reboot so
     the module's getGeolocation fires during the outage. Less
     reliable — the second and third retry attempts (after 2 s and
     8 s elapsed) may catch the WAN coming back up.
3. Re-onboard via the captive portal. The captive-portal POST itself
   uses local LAN, so it works fine with WAN down.
4. Capture the boot serial:
   ```powershell
   python scripts/esp_capture.py --port COM9 --seconds 60 > t5-boot.log
   ```
5. Restore WAN connectivity.
6. Wait 30 minutes (the `HF_GEOLOCATION_DEFERRED_RETRY_MS` cadence).
7. Capture the next-heartbeat serial:
   ```powershell
   python scripts/esp_monitor.py --port COM9 --seconds 120 > t5-recovery.log
   ```

**Expected boot serial (t5-boot.log)**:

- `[getGeolocation] attempt 1 failed — backing off 2000ms`
- `[getGeolocation] attempt 2 failed — backing off 6000ms`
- (third attempt fires, also fails because WAN still down)
- `[getGeolocation] 3 attempts exhausted — no plausible fix this boot`
- `[setup] no plausible geolocation fix this boot — armed deferred retry`
- Module still registers (`initNewModuleOnServer` runs) at (0,0).

**Expected dashboard state immediately after t5-boot**:

- Module appears in the side-list (with the "Location pending"
  pill).
- **No** marker for the module on the map (it's at (0,0); the
  `hasPlausibleLocation` filter excludes it).
- Map default-centers on Bodensee (`[47.78, 9.61]`) instead of the
  Gulf of Guinea.

**Expected recovery serial (t5-recovery.log)**:

- `[getGeolocation] deferred retry SUCCESS (lat=... lng=... acc=...) — will report on next heartbeat`
- Next heartbeat: `[heartbeat] carrying recovered geolocation fix lat=... lng=... acc=...`

**Expected dashboard state ~5 minutes after t5-recovery** (allow time
for the next dashboard refresh):

- Module's "Location pending" pill is gone.
- Marker appears on the map at the correct location.

**Note on the duckdb-service-side print**: the heartbeat endpoint
prints `[heartbeat] patched module_configs lat/lng for <mac> from
(0,0) -> (...) acc=...` on success. Visible in
`docker compose logs duckdb-service` — useful as a server-side
confirmation.

## Re-running

The whole bundle should be re-run after any change to:

- `ESP32-CAM/esp_init.cpp::getGeolocation` or `attemptGeolocation`
- `ESP32-CAM/esp_init.cpp::tickGeolocationDeferredRetry` and the
  deferred-retry globals
- `ESP32-CAM/client.cpp::sendHeartbeat` (heartbeat body)
- `ESP32-CAM/lib/ota_version/` (parser or comparator)
- `duckdb-service/routes/heartbeats.py` (geolocation patch path)
- `homepage/src/lib/location.ts::hasPlausibleLocation` (the
  rule definition itself)

Document the run in the PR body before merging.
