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
   (`app0`, `app1`) plus a smaller SPIFFS. SPIFFS holds only
   `/config.json` (a few hundred bytes), so the smaller filesystem
   is harmless. The directive is set in two places —
   `board_build.partitions = min_spiffs.csv` in
   [`ESP32-CAM/platformio.ini`](../../ESP32-CAM/platformio.ini)'s
   `[env:esp32cam]` for the PlatformIO path (the `.csv` suffix causes
   PlatformIO to resolve the framework's built-in `min_spiffs.csv`
   from `tools/partitions/`; without the suffix the lookup fails in CI
   where the framework directory is not pre-cached), and a second
   `--build-property "build.partitions=min_spiffs"` argument to
   `arduino-cli compile` in [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh)
   for the release path. Both resolve to the same framework partition
   table; CI's `pio run -e esp32cam` and the release builder produce
   the same `partitions.bin`.

2. **Two-slot rollback enabled, gated on full setup completion.** The
   firmware calls `esp_ota_mark_app_valid_cancel_rollback()` at the
   very end of `setup()` — after WiFi join, OTA check, registration,
   boot heartbeat, camera init, and the camera warm-up loop. An
   earlier draft (round 1) fired the call immediately after
   `initNewModuleOnServer`, on the argument that `recoverCamera()`
   (per ADR-007) handles camera-init failures in software. Round-2
   review caught that `recoverCamera()` only addresses soft NULL-frame
   stalls; a driver-level panic or null-deref in
   `initEspCamera`/`configure_camera_sensor` would brick the slot
   permanently if mark-valid had already fired. The threshold is "every
   stage that can panic has succeeded." The call is a no-op on non-OTA
   boots (bootloader's `ESP_OTA_IMG_VALID` state) so we can call it
   unconditionally without branching on partition state.

3. **Dual-binary publish, single manifest.** Each build of
   [`ESP32-CAM/build.sh`](../../ESP32-CAM/build.sh) writes both
   `homepage/public/firmware.bin` (merged, for the web installer) and
   `homepage/public/firmware.app.bin` (app-only, for HTTP OTA). The
   `homepage/public/firmware.json` manifest was previously
   `{version, md5, built_at}`; this PR **adds** two fields —
   `app_md5` (MD5 of the app-only bin) and `app_size` (byte length
   of the app-only bin) — to the same file. One source of truth, two
   consumers. The manifest parser in
   [`ESP32-CAM/lib/ota_version/`](../../ESP32-CAM/lib/ota_version/)'s
   `parseOtaManifest` ignores fields it doesn't need, so the web
   installer can grow its own fields without affecting the OTA path
   and vice versa. `build.sh` also asserts `firmware.app.bin` is
   strictly smaller than `firmware.bin` before writing the manifest,
   so a refactor that crosses the two `cp` sources fails the build
   loudly rather than producing a manifest that points at the wrong
   bytes.

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
- Remote OTA pull at every boot. `httpOtaCheckAndApply` runs in
  `setup()`, so the manifest fetch fires on every reset — the daily
  reboot from ADR-007, the 5-consecutive-failure circuit breaker's
  `ESP.restart()`, a WDT-induced reset, and power-on. The cost is one
  HTTP GET per boot to `/firmware.json` (manifest body < 256 bytes
  today); the binary fetch only happens when the manifest's `version`
  differs from compiled-in `FIRMWARE_VERSION`. We deliberately do not
  carry an extra in-`loop()` periodic check — that would add a
  rate-limit concern to the backend that the boot-only cadence
  doesn't.
- Auto-rollback for bricked binaries. A bad firmware push that panics
  or watchdog-fires before `esp_ota_mark_app_valid_cancel_rollback()`
  at the end of `setup()` reverts to the previous slot without an
  operator visit. The gate covers WiFi join, registration, camera
  init, and the camera warm-up loop. The pre-mark-valid breadcrumb in
  the next telemetry sidecar tells us which stage failed.

**Costs:**

- **One-way migration.** Every existing module in the field must be
  USB-reflashed once with the new partition layout before it can
  receive HTTP OTA updates. There is no over-the-air migration path
  — the bootloader's partition table lives at flash offset `0x8000`,
  and OTA writes to the app slot, not there. The chapter-11 entry
  ["OTA migration is one-way"](../11-risks-and-technical-debt/README.md)
  exists to keep the next person from forgetting this.
- **Tighter SPIFFS.** ~128 KB instead of ~1.4 MB. Fine today
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
- **Firmware-side DoS bounds.** `httpOtaCheckAndApply` in
  [`ESP32-CAM/ota.cpp`](../../ESP32-CAM/ota.cpp) caps the manifest
  body at `kManifestMaxBytes = 1024` bytes and the binary at
  `manifest.app_size` bytes (rejected if it doesn't match the
  `Content-Length` response header, and `Content-Length: 0` causes an
  immediate skip). A malicious or runaway server cannot force the device
  to allocate unbounded heap or spin in a download loop — the
  `kOtaBinaryDeadlineMs = 120 s` wall-clock deadline is the secondary
  bound against a drip-feeding connection.
- **No API key in firmware.** Keeps the rotation story simple but
  means the OTA endpoints inherit the homepage's public surface.
  Acceptable for the threat model today (same as the merged bin);
  revisit if the homepage's security posture changes.

**Implicit coupling to revisit:**

- **`INIT_URL` host = OTA host.** `httpOtaCheckAndApply` derives the
  manifest URL from `esp_config.INIT_URL`'s host. Today
  `INIT_URL` (the backend endpoint, served on the same hostname as
  the homepage via host-nginx) and the OTA origin coincide. The
  captive portal stores `INIT_URL` and `UPLOAD_URL` as separate
  fields, leaving room for a future split (e.g. `api.highfive.…` vs
  `highfive.…`). If those ever diverge from the homepage's hostname,
  this coupling breaks silently. A captive-portal-stored
  "homepage / OTA origin" field is the right long-term fix; for now,
  the coupling is documented here and called out by name in
  [`ESP32-CAM/ota.cpp`](../../ESP32-CAM/ota.cpp)'s
  `httpOtaCheckAndApply` so a future change to the captive-portal
  schema doesn't lose this invariant.
- **Plain HTTP, MD5 integrity, no signature.** The OTA download path
  uses `WiFiClient` (not `WiFiClientSecure`) so it can only fetch
  over HTTP — the threat model is therefore "anyone on the network
  path between the homepage origin and the module can MITM the
  firmware". Acceptable for a home / lab deployment where the
  homepage and modules share the same LAN; not acceptable for a
  module on a hostile guest network. A follow-up ADR (TLS +
  code-signed updates) should be filed before the second deployment
  topology lands, not after.

**Forecloses:**

- Going back to a single-app-slot layout. Every committed module is
  now on `min_spiffs`; reverting would require another USB-reflash
  sweep across the fleet.
- Per-module firmware variants via the same `firmware.json` manifest.
  The manifest is global — every module pulls the same version. If
  we ever want canary releases or per-region pinning, that's a
  manifest shape change (probably keyed by module-ID prefix) and a
  follow-up ADR.
