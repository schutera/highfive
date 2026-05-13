# ADR-008: Firmware OTA — partition layout, two-slot rollback, dual-binary publish

## Status

Accepted. Closes [#26](https://github.com/schutera/highfive/issues/26).
Pairs with [ADR-006](adr-006-bee-name-firmware-versioning.md) (which
defines the version-string shape that the OTA version-compare reads)
and [ADR-007](adr-007-esp-reliability-breaker-and-daily-reboot.md)
(whose daily-reboot path provides the natural cadence for HTTP OTA
pull).

## Context

Field-deployed ESP32-CAM modules cannot be reflashed without physical
access — USB + GPIO0 strap pin. Every firmware fix that needs to reach
deployed hardware otherwise requires a site visit. Issue #26 was filed
after the onboarding session in #17 made the cost concrete.

Four coupled questions had to be answered together:

1. **Partition layout.** The ESP32 default `boards.txt` partition table
   for `esp32cam` has a single ~1.9 MB app slot and no OTA slots —
   OTA is structurally impossible. A different partition table is
   required, and changing the partition table itself cannot be done
   over the air (the bootloader reads it from a fixed flash offset
   that OTA does not touch). So the migration is one-way and the
   first OTA-capable binary must arrive via USB or the existing web
   installer's merged-bin flash.
2. **Rollback policy.** ESP32 supports a "pending verify → mark valid"
   bootloader handshake: the bootloader runs a freshly-flashed slot
   once, and if the firmware doesn't explicitly mark itself valid it
   reverts on the next reset. Skipping the mark-valid call entirely is
   the simplest path; gating it on application invariants protects
   against a binary that bricks the boot path.
3. **Binary shape published to clients.** The web installer flashes a
   **merged** `.bin` (bootloader + partition table + boot_app0 + app)
   — that is what gives an unprovisioned module its first state. The
   HTTP OTA library on-device (`Update.write()`) expects the
   **app-only** `.bin` (just the application image, ~1 MB). One build
   has to produce both artifacts, and one manifest has to feed both
   consumers.
4. **Auth on the OTA download endpoint.** The merged `firmware.bin` is
   already served unauthenticated from `homepage/public/` so the web
   installer can fetch it. The app-only `.bin` is the same artifact
   factored differently. Adding API-key auth to the OTA path would
   leave the merged bin still public (couldn't change that without
   breaking the web installer) and would bake `HIGHFIVE_API_KEY` into
   firmware — which means key rotation requires reflash, the exact
   problem OTA exists to avoid.

## Decision

Four coupled choices, made together so they actually compose:

1. **Partition layout: `min_spiffs`.** Two ~1.9 MB OTA app slots
   (`app0`, `app1`) plus ~192 KB SPIFFS. SPIFFS holds only
   `/config.json` (a few hundred bytes), so the smaller filesystem
   is harmless. The directive is set in two places — `board_build.partitions = min_spiffs`
   in [`ESP32-CAM/platformio.ini`](../../ESP32-CAM/platformio.ini)'s
   `[env:esp32cam]` for the PlatformIO path, and a second
   `--build-property "build.partitions=min_spiffs"` argument to
   `arduino-cli compile` in [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh)
   for the release path. The two must match byte-for-byte; CI's
   `pio run -e esp32cam` and the release builder both produce the
   same partition table.

2. **Two-slot rollback enabled, gated on WiFi + registration.** The
   firmware calls `esp_ota_mark_app_valid_cancel_rollback()` once
   `setupWifiConnection` has returned and `initNewModuleOnServer`
   has succeeded — the two pieces the device cannot recover from on
   its own. Camera-init failures are deliberately not in the gate
   because `recoverCamera()` (per ADR-007) handles them in software;
   blocking the rollback decision on a recoverable failure mode would
   bounce the unit between two equally-broken slots. The call is a
   no-op on non-OTA boots (the bootloader's `ESP_OTA_IMG_VALID` state)
   so we can call it unconditionally without branching on partition
   state.

3. **Dual-binary publish, single manifest.** Each build of
   [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh) writes both
   `homepage/public/firmware.bin` (merged, for the web installer) and
   `homepage/public/firmware.app.bin` (app-only, for HTTP OTA). The
   `homepage/public/firmware.json` manifest now carries five fields:
   `version`, `md5` (merged bin), `built_at`, `app_md5`, `app_size`.
   One source of truth, two consumers, no manifest drift risk. The
   manifest parser in
   [`ESP32-CAM/lib/ota_version/`](../../ESP32-CAM/lib/ota_version/)'s
   `parseOtaManifest` ignores fields it doesn't need, so the web
   installer can grow its own fields without affecting the OTA path
   and vice versa.

4. **Public download endpoint, no API key in firmware.** The OTA
   firmware fetches `http://<homepage host>/firmware.json` and
   `/firmware.app.bin` with no auth headers. Same exposure as
   `firmware.bin`. The threat model is symmetric — anyone who can hit
   the homepage can already download the merged binary and inspect
   it; adding the API key to the OTA path doesn't reduce that, and
   subtracts the operational headache of reflashing every field unit
   when the key rotates.

The pieces are wired in [`ESP32-CAM/ota.cpp`](../../ESP32-CAM/ota.cpp)
(`hf::httpOtaCheckAndApply`) called from the new
`setup:http_ota_check` stage in
[`ESP32-CAM/ESP32-CAM.ino`](../../ESP32-CAM/ESP32-CAM.ino)'s
`setup()` between WiFi-up and `getGeolocation`. The Phase-1 LAN-push
path is `ArduinoOTA.begin()` from the same setup stage, with
`ArduinoOTA.handle()` polled from `loop()` next to the existing
watchdog feed.

## Consequences

**Enables:**

- LAN push from the developer's PlatformIO via
  `pio run -e esp32cam -t upload --upload-port=<module-ip>`. No USB
  cable, no GPIO0 strap. Hostname is `hivehive-<12hex-module-id>` so
  `pio device list` distinguishes modules on the same LAN.
- Remote OTA pull on every daily reboot (ADR-007). The cadence is
  free — we already reboot once a day — so we don't carry an extra
  hourly check in `loop()` and the cost is one extra HTTP GET per
  module per day to `/firmware.json`.
- Auto-rollback for bricked binaries. A bad firmware push that fails
  WiFi join or registration on the first boot reverts to the previous
  slot without an operator visit. The pre-mark-valid breadcrumb in
  the next telemetry sidecar tells us which stage failed.

**Costs:**

- **One-way migration.** Every existing module in the field must be
  USB-reflashed once with the new partition layout before it can
  receive HTTP OTA updates. There is no over-the-air migration path
  — the bootloader's partition table lives at flash offset `0x8000`,
  and OTA writes to the app slot, not there. The chapter-11 entry
  ["OTA migration is one-way"](../11-risks-and-technical-debt/README.md)
  exists to keep the next person from forgetting this.
- **Tighter SPIFFS.** ~192 KB instead of ~1.4 MB. Fine today
  (`/config.json` < 1 KB) but caps any future use of SPIFFS for
  larger fixtures or sample images. If we ever need more, the next
  step is `min_spiffs (large APPS)` or a custom partitions.csv.
- **No CDN, no integrity beyond MD5.** The OTA download uses MD5 for
  integrity (`Update.setMD5()`); it does not verify a signature. Anyone
  who can MITM the firmware origin (we serve over HTTP today, not HTTPS)
  can push arbitrary firmware. The merged bin has the same property
  through the web installer. Documented separately; not blocking for
  the deployment topology where the homepage is on the same LAN as
  the modules. A signed-update story belongs in a follow-up ADR if
  we ever expose modules to networks we don't control.
- **No API key in firmware.** Keeps the rotation story simple but
  means the OTA endpoints inherit the homepage's public surface.
  Acceptable for the threat model today (same as the merged bin);
  revisit if the homepage's security posture changes.

**Forecloses:**

- Going back to a single-app-slot layout. Every committed module is
  now on `min_spiffs`; reverting would require another USB-reflash
  sweep across the fleet.
- Per-module firmware variants via the same `firmware.json` manifest.
  The manifest is global — every module pulls the same version. If
  we ever want canary releases or per-region pinning, that's a
  manifest shape change (probably keyed by module-ID prefix) and a
  follow-up ADR.
