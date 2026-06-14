# ADR-018: Captive portal is Wi-Fi-credentials-only; identity / URLs / camera defaulted in firmware; reconfigure by re-flash

## Status

Accepted

## Context

The captive portal served at `http://192.168.4.1` while a module is in
setup (AP) mode is the only UI a field operator touches during
onboarding. Over time it accreted every configurable knob the firmware
has: module name, the two server URLs (each split into base / port /
endpoint since #79, [ADR-010](adr-010-esp-firmware-tls-trust-model.md)),
camera resolution / flip / brightness / saturation, and — added when
issue #40 moved factory reset off the GPIO0 strap pin — a "Factory
reset (advanced)" disclosure with a confirm checkbox and a dedicated
`/factory_reset` route.

Every one of those fields is a decision the operator should not be
making in the field:

- **Module name** is derivable from the MAC with zero operator input
  (`hf::moduleNameFromMac`, the #91/#92/#93/#94 collision fix), so a
  free-text field just invites typos and same-batch collisions.
- **Server URLs** are constant for production (`highfive.schutera.com`)
  and constant-per-developer for a LAN stack — neither value belongs in
  a per-module form the operator retypes on every onboard.
- **Camera settings** have one correct production value each
  (`ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`); the form
  prefilled a _different_ "form fallback" than the production reader
  used, which surprised operators (the vertical-flip `0`-prefill that
  shipped flipped-`1` firmware is documented in chapter 11's
  "Dual-reader asymmetry").
- **Factory reset on the form** is dead weight now that re-flash erases
  config (see Decision): two routes (`/factory_reset` plus its
  confirm-checkbox JS), a session-token contract, and a banner, all to
  do what a re-flash now does as a side effect.

This is a **restore**, not a new idea. A Wi-Fi-only form existed
historically (commit `59523d3`, 2026-03-30, "streamline setup flow").
Complexity crept back in via `ad9ee17`, and the factory-reset
disclosure arrived in `8c1be9c` (issue #40). The lesson — "advanced
knobs do not belong on the operator-facing form" — was relearned each
time. This ADR records the re-simplification so the next person who
reaches for "just add one field to the captive portal" finds the
recorded reason not to.

The precedent for build-time-injected configuration already exists:
the Google Geolocation API key is injected as a `-D` macro at build
time from a gitignored file or env var, never hardcoded and never on
the form (issue #18, chapter 11 "Third-party API keys belong in
build-time macros, not source"). Server URLs fit the same mould.

## Decision

The captive portal asks for **Wi-Fi SSID and password only**. Every
other value is defaulted under the hood:

- **Module name** — auto-derived from the MAC by
  `ESP32-CAM/esp_init.cpp`'s `generateModuleName`, which delegates to
  `hf::moduleNameFromMac`.
- **Camera settings** — the production fallbacks in
  `ESP32-CAM/lib/firmware_defaults/firmware_defaults.h`
  (`hf::defaults::kResolutionProductionFallback` and siblings).
- **Server URLs** — baked in at build time, mirroring the
  `GEO_API_KEY` pattern. The production defaults
  (`https://highfive.schutera.com/new_module` and `/upload`) live as
  `#ifndef`-guarded `HF_INIT_URL_DEFAULT` / `HF_UPLOAD_URL_DEFAULT`
  macros in `firmware_defaults.h`. A developer points a module at a
  local LAN stack by writing the gitignored file
  `ESP32-CAM/DEV_SERVER_HOST` (host/IP only, e.g. `192.168.1.50`) or
  exporting the `DEV_SERVER_HOST` env var; `ESP32-CAM/build.sh` and
  `ESP32-CAM/extra_scripts.py` then compose and inject
  `-DHF_INIT_URL_DEFAULT="http://<host>:8002/new_module"` and
  `-DHF_UPLOAD_URL_DEFAULT="http://<host>:8000/upload"` (8002 =
  duckdb-service host port, 8000 = image-service host port). When the
  saved `/config.json` carries no `INIT_URL` / `UPLOAD_URL`,
  `ESP32-CAM/esp_init.cpp`'s `loadConfig` applies these compiled-in
  defaults.

**Reconfigure is done by re-flashing.** The web-installer flash now
performs a full chip erase (`eraseAll: true` in
`homepage/src/components/setup/flashEsp.ts`'s `flashEsp`), which wipes
the NVS `configured` flag and the SPIFFS `/config.json`. After any
(re)flash the module therefore boots straight into its Wi-Fi setup
page. The `/factory_reset` route and its "Factory reset (advanced)"
disclosure are removed from `ESP32-CAM/host.cpp`'s `sendConfigForm` and
`runAccessPoint`. The "moved to a new network" case is still covered
without a re-flash: the module auto-reopens its setup access point
after `WIFI_FAIL_AP_FALLBACK_THRESH` consecutive failed Wi-Fi joins
(`ESP32-CAM/ESP32-CAM.ino`).

## Consequences

**Enables.** A field operator types exactly two values (SSID +
password) and nothing else — no URL retyping, no camera knobs, no
chance of a name-collision typo on a same-batch deploy. The onboarding
form, its JS validator, and the `/save` handler shrink to one
contract (Wi-Fi credentials), removing the URL-triple validation and
the factory-reset confirm-checkbox half of the old `/save`-plus-
`/factory_reset` surface.

**Costs.** Pointing a module at a non-production stack is now a
build-time action, not a field action. A developer must write
`ESP32-CAM/DEV_SERVER_HOST` (or export `DEV_SERVER_HOST`) **before**
building/flashing; there is no longer a form field to redirect a
flashed module at a different server. This is the intended trade-off —
the same one `GEO_API_KEY` already makes — and is documented in
[`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md).
The gitignored `DEV_SERVER_HOST` file joins `GEO_API_KEY` in the repo
root `.gitignore`.

**Forecloses.** There is no in-field way to change a module's server
URLs or camera settings without a re-flash. For a fleet whose server
host genuinely changes, that means a re-flash visit (or an OTA of a
firmware built against the new default) rather than a captive-portal
edit. Given the production host is stable and a re-flash already erases
config, this is acceptable.

**Reconfigure semantics.** Re-flash is now the supported reset path:
there is no factory-reset button anywhere. The legacy "hold IO0 for 5
seconds" GPIO0-strap procedure was already removed in issue #40
(chapter 11 "GPIO0 is a strap pin"); this ADR removes the captive-
portal factory-reset route that replaced it. The
`scripts/check-stale-reset-prose.sh` gate from #40 still guards against
"hold this button at boot" prose reappearing.

**Migration.** Existing modules keep their saved `/config.json` URLs
until they are re-flashed; `loadConfig`'s compiled-in defaults only
apply when those keys are absent (or after a re-flash erases them). No
forced re-onboard is triggered by shipping this firmware via OTA — the
saved URLs continue to work — but the next USB/web-installer flash of
any module erases its config and reopens the Wi-Fi-only setup page.

## Amendment (issue #156): developer USB-serial server override

The "Forecloses" cost above — _there is no in-field way to change a
module's server URLs without a re-flash_ — bit the on-hardware
verification of #145: a default build silently baked the production URLs,
the module registered itself to `highfive.schutera.com`, and there was no
way to redirect it to the dev stack without a rebuild + reflash. Worse,
the stray module left a "dead body" in the production admin that
reappeared on every boot until reflashed. This amendment restores a
developer retargeting path **without reopening the operator-facing form
decision this ADR made.**

**The captive-portal FORM stays Wi-Fi-only.** The decision above is
unchanged: a field operator still types exactly SSID + password. The
override is an **out-of-band developer side channel over the USB cable a
developer already has attached** — never a form field, so the "advanced
knobs do not belong on the operator-facing form" lesson still holds.

- **Serial console** (`ESP32-CAM/serial_console.cpp`, parser in
  `ESP32-CAM/lib/serial_cmd/`). Over USB serial a developer can type
  `set-server <host>` (composes the same `http://<host>:8002/new_module`
  - `:8000/upload` URLs `build.sh` bakes — convention pinned by
    `test_native_serial_cmd`), `set-server <init> <upload>` (verbatim, for
    https / custom ports), `clear-server` (revert to baked default),
    `show-config`, and `reopen-portal`. The writes go to
    `NETWORK.INIT_URL` / `NETWORK.UPLOAD_URL` in `/config.json`, which
    `loadConfig` has always read — only the writer was removed by this ADR,
    now restored out-of-band.
- **Boot window before registration.** `ESP32-CAM/ESP32-CAM.ino`'s
  `setup()` opens a short serial window after `loadConfig` and **before**
  `initNewModuleOnServer`, so a `set-server` re-runs `loadConfig` and the
  module's _first_ registration this boot goes to the dev stack — it never
  has to register to production first. The window costs a field boot
  nothing (it is gated on `Serial.available()`; no USB host → fall
  straight through).
- **Wi-Fi-preserving re-entry.** `reopen-portal` flips the NVS
  `configured` flag and restarts — the same mechanism as the 3-Wi-Fi-fail
  auto-fallback. Because Wi-Fi creds live in SPIFFS `/config.json` (not
  NVS), the portal reopens **prefilled, without erasing Wi-Fi**, so a
  stray configured module can be retargeted without a full chip erase.
- **`saveConfig` is now read-modify-write.** `ESP32-CAM/host.cpp`'s
  `saveConfig` previously rebuilt `/config.json` from scratch, which would
  silently drop an out-of-band `INIT_URL`/`UPLOAD_URL` on the next Wi-Fi
  save. It now preserves all keys it does not own (pure mutation in
  `ESP32-CAM/lib/config_json/`, regression-pinned by
  `test_native_config_json`). This is on-disk key preservation, **not** a
  re-introduction of operator-editable URL fields.

**Clean dev flash (the primary path).** For a developer iterating on
firmware, the serial override is the _correction_ path; the _clean_ path
is `make flash-dev`, which builds with `HF_DEV_BUILD=1`. That flag makes
`build.sh` / `extra_scripts.py` hard-fail when `DEV_SERVER_HOST` is unset,
so a dev flash can never silently bake production URLs (the #145 trap).
`pio run -t upload` does not erase NVS/SPIFFS, so Wi-Fi survives between
dev firmware iterations. See
[`docs/07-deployment-view/esp-flashing.md`](../07-deployment-view/esp-flashing.md).
