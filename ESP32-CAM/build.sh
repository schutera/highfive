#!/usr/bin/env bash
set -euo pipefail

SKETCH_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SKETCH_DIR}/build"
# FlashMode=dio is load-bearing for PSRAM (#163). The bare FQBN takes the core's
# global default build.boot=qio, which links the qio_qspi precompiled libs +
# a qio bootloader — but we flash in dio mode (FLASH_MODE=dio below), and that
# lib/flash-mode mismatch makes esp_psram_init() fail at boot (PSRAM: found=0,
# degraded VGA capture). The boards.txt FlashMode.dio menu sets BOTH
# build.flash_mode=dio AND build.boot=dio, so the dio_qspi libs + dio bootloader
# match the dio flash — exactly what the pio build (board JSON flash_mode=dio)
# does, which is why pio always reported found=1. Verified on bench (COM13,
# AI-Thinker, ESP32-D0WD-V3): qio_qspi -> found=0, dio_qspi -> found=1.
FQBN="esp32:esp32:esp32cam:FlashMode=dio"

# VERSION is the single writer for the firmware version macro. Same value
# is injected into the firmware binary as -DFIRMWARE_VERSION and written
# into the homepage manifest, so boot log + telemetry + heartbeat + OTA
# manifest all agree. Fail loudly if the file is missing — we do NOT want
# a release build silently tagged "dev-unset".
if [ ! -f "${SKETCH_DIR}/VERSION" ]; then
  echo "ERROR: ${SKETCH_DIR}/VERSION not found — refusing to build a release without a version." >&2
  exit 1
fi
VERSION="$(cat "${SKETCH_DIR}/VERSION")"

# SEQUENCE is the single writer for the OTA sequence-number macro
# (issue #83). Same file-then-macro pattern as VERSION; injected as
# -DFIRMWARE_SEQUENCE and emitted into firmware.json so the new
# `shouldOtaUpdate` (lib/ota_version/) can refuse downgrades unless
# allow_downgrade is set. Fail loud on absence — a release build that
# defaulted SEQUENCE to 0 would refuse every OTA from a properly-built
# fleet (the runtime check is `manifest.sequence > current_sequence`).
if [ ! -f "${SKETCH_DIR}/SEQUENCE" ]; then
  echo "ERROR: ${SKETCH_DIR}/SEQUENCE not found — refusing to build a release without an OTA sequence." >&2
  exit 1
fi
SEQUENCE="$(tr -d '[:space:]' < "${SKETCH_DIR}/SEQUENCE")"
if ! [[ "${SEQUENCE}" =~ ^[0-9]+$ ]] || [ "${SEQUENCE}" -lt 1 ]; then
  echo "ERROR: SEQUENCE must be a positive integer; got '${SEQUENCE}'." >&2
  exit 1
fi

# Best-effort drift warning: if a previously-published firmware.json
# exists with a HIGHER sequence than the one we're about to publish,
# the new manifest would be a downgrade that the freshly-flashed
# fleet refuses. Loud on stderr so the operator can choose to bump
# SEQUENCE or set allow_downgrade in the next manifest publish.
HOMEPAGE_PUBLIC_PRECHECK="${SKETCH_DIR}/../homepage/public"
if [ -f "${HOMEPAGE_PUBLIC_PRECHECK}/firmware.json" ]; then
  OLD_SEQ="$(grep -oE '"sequence"[[:space:]]*:[[:space:]]*[0-9]+' "${HOMEPAGE_PUBLIC_PRECHECK}/firmware.json" | grep -oE '[0-9]+$' || true)"
  if [ -n "${OLD_SEQ}" ] && [ "${SEQUENCE}" -lt "${OLD_SEQ}" ]; then
    echo "" >&2
    echo "WARNING: SEQUENCE=${SEQUENCE} is LOWER than the previously-published" >&2
    echo "         manifest's sequence=${OLD_SEQ}. New firmware will refuse to" >&2
    echo "         flash this manifest unless allow_downgrade is also set." >&2
    echo "         See docs/07-deployment-view/esp-flashing.md 'How to" >&2
    echo "         deliberately roll back' for the supported procedure." >&2
    echo "" >&2
  fi
fi

# GEO_API_KEY is the Google Geolocation API key used by getGeolocation in
# esp_init.cpp. Sourced from env var first, then a .gitignored file (so
# local dev doesn't have to export it every shell). A missing key is
# FATAL for this release path (see the GeoKey check below): build.sh
# produces the web-installer firmware.bin an operator flashes, and a
# keyless binary reports (0,0,0) and never appears on the dashboard map.
# Set HF_ALLOW_NO_GEO_KEY=1 to build keyless on purpose (a compile check
# that is never flashed). The local `pio run -e esp32cam` smoke env does
# not require the key (CI may still pass GEO_API_KEY to it as a secret on
# main; that's the pipeline's choice, not build.sh's). We never print the
# value directly — only its length. The one place it could leak is the
# `arduino-cli compile --verbose` output (the resolved g++ lines embed
# -DGEO_API_KEY="<key>"), so that pipeline pipes through a sed redactor
# before stdout/tee — see the compile invocation below. Net: this script
# runs in CI and writes build/compile.log without leaking the secret.
# Strip ALL whitespace from both sources (not just outer) so the env-var
# and file paths cannot diverge on a stray trailing newline (the common
# shape of a CI secret written via `echo "$KEY" > file`) OR an embedded
# space pasted from a wrapped-line email. Google API keys contain no
# internal whitespace, so deleting all whitespace is harmless on any
# valid input. extra_scripts.py mirrors this byte-for-byte via
# re.sub(r'[ \t\n\v\f\r]+', '', ...) so the two builders converge on
# identical macro values from any byte sequence either could see.
GEO_API_KEY="$(printf '%s' "${GEO_API_KEY:-}" | tr -d '[:space:]')"
if [ -z "${GEO_API_KEY}" ] && [ -f "${SKETCH_DIR}/GEO_API_KEY" ]; then
  GEO_API_KEY="$(tr -d '[:space:]' < "${SKETCH_DIR}/GEO_API_KEY")"
fi

# DEV_SERVER_HOST (optional): point a dev module at a LAN stack instead of the
# production backend baked into firmware_defaults.h. Sourced from env var
# first, then a .gitignored file — same pattern as GEO_API_KEY above. When set,
# compose the init/upload URLs from the LAN-dev host ports (8002 = duckdb-
# service, 8000 = image-service) and inject them as -DHF_INIT_URL_DEFAULT /
# -DHF_UPLOAD_URL_DEFAULT, overriding the production #ifndef defaults in
# firmware_defaults.h. Absent => no flags, production URLs apply. The `\"`
# escapes produce a single layer of C-string quote bytes, matching the
# GEO_API_KEY/FIRMWARE_VERSION quoting; extra_scripts.py mirrors this via
# env.StringifyMacro. See docs/07-deployment-view/esp-flashing.md.
DEV_SERVER_HOST="$(printf '%s' "${DEV_SERVER_HOST:-}" | tr -d '[:space:]')"
if [ -z "${DEV_SERVER_HOST}" ] && [ -f "${SKETCH_DIR}/DEV_SERVER_HOST" ]; then
  DEV_SERVER_HOST="$(tr -d '[:space:]' < "${SKETCH_DIR}/DEV_SERVER_HOST")"
fi
DEV_URL_FLAGS=""
if [ -n "${DEV_SERVER_HOST}" ]; then
  DEV_URL_FLAGS=" -DHF_INIT_URL_DEFAULT=\"http://${DEV_SERVER_HOST}:8002/new_module\" -DHF_UPLOAD_URL_DEFAULT=\"http://${DEV_SERVER_HOST}:8000/upload\""
fi

echo "Compiling ESP32-CAM firmware..."
echo "  FQBN:     ${FQBN}"
echo "  Sketch:   ${SKETCH_DIR}"
echo "  Output:   ${BUILD_DIR}"
echo "  Version:  ${VERSION}"
echo "  Sequence: ${SEQUENCE}"
if [ -n "${DEV_SERVER_HOST}" ]; then
  echo "  DevHost: ${DEV_SERVER_HOST} (init :8002, upload :8000 — LAN dev override)"
else
  echo "  DevHost: <unset> (production URLs baked in)"
fi
if [ -n "${GEO_API_KEY}" ]; then
  echo "  GeoKey:  set (len=${#GEO_API_KEY})"
else
  echo "  GeoKey:  <unset>"
  # build.sh is the path that produces the web-installer firmware.bin an
  # operator actually flashes (homepage Step 2 serves it). A keyless build
  # leaves the geolocation fields at their 0.0f defaults, so the module
  # reports (lat=0, lng=0, acc=0) on its first heartbeat and the homepage
  # map plots it at Null Island — i.e. the module never appears anywhere
  # the operator can see it. Shipping that is the "new modules don't show
  # up on the dashboard" failure, so a missing key here is FATAL by default.
  #
  # Escape hatch: HF_ALLOW_NO_GEO_KEY=1 builds keyless on purpose — for a CI
  # compile check that is never flashed to a real device. The pio smoke
  # env (`pio run -e esp32cam`) stays keyless without this flag because it
  # is a compile-only gate, not a release path. Loud on stderr so the
  # message survives a `> build.log` redirect. See
  # docs/07-deployment-view/esp-flashing.md and
  # docs/08-crosscutting-concepts/auth.md "Third-party API keys".
  if [ "${HF_ALLOW_NO_GEO_KEY:-}" = "1" ]; then
    echo "" >&2
    echo "WARNING: GEO_API_KEY is unset but HF_ALLOW_NO_GEO_KEY=1 is set —" >&2
    echo "         building a keyless binary on purpose. It reports (0, 0, 0)" >&2
    echo "         and must NOT be flashed to a device meant to appear on the" >&2
    echo "         dashboard map." >&2
    echo "" >&2
  else
    echo "" >&2
    echo "ERROR: GEO_API_KEY is unset. A release build flashed to an operator" >&2
    echo "       would skip the Google Geolocation call and report (0, 0, 0)," >&2
    echo "       so the module never appears on the dashboard map." >&2
    echo "       Fix: export GEO_API_KEY=... or write ESP32-CAM/GEO_API_KEY" >&2
    echo "       (gitignored). To build keyless on purpose (CI compile check," >&2
    echo "       never flashed), re-run with HF_ALLOW_NO_GEO_KEY=1." >&2
    echo "       See docs/07-deployment-view/esp-flashing.md." >&2
    echo "" >&2
    exit 1
  fi
fi
echo ""

# OTA partition layout (#26). min_spiffs gives two ~1.9 MB app slots
# (app0/app1) so ArduinoOTA/HTTPUpdate have somewhere to write the new
# binary. Mirrors platformio.ini's board_build.partitions = min_spiffs.csv
# so both build paths emit byte-identical partitions.bin. arduino-cli
# takes the preset name without .csv; platformio.ini needs the .csv suffix
# because PIO resolves the framework's built-in from tools/partitions/.
# App macros go into compiler.{c,cpp}.extra_flags, NOT build.extra_flags (#163).
# In the ESP32 core, boards.txt carries the PSRAM defines in build.defines
# (-DBOARD_HAS_PSRAM -mfix-esp32-psram-cache-issue
# -mfix-esp32-psram-cache-strategy=memw), but the compile recipe never references
# {build.defines} directly — it reaches the compiler only because platform.txt
# threads it *through* the default build.extra_flags (... {build.defines} ...).
# Overriding build.extra_flags to inject our macros therefore silently dropped
# BOARD_HAS_PSRAM (and -DESP32, CORE_DEBUG_LEVEL, ARDUINO_USB_CDC_ON_BOOT).
# compiler.{c,cpp}.extra_flags are empty by default and appended by the recipe
# alongside build.extra_flags, so they add our macros without clobbering the
# board's build.defines. Set both c and cpp so .c lib files and the .ino/.cpp
# sketch units all see the macros. (NB: restoring BOARD_HAS_PSRAM was necessary
# but did NOT by itself fix PSRAM: found=0 — the FlashMode=dio FQBN above is the
# actual found=0 fix. See the #163 lesson in chapter 11.)
# --verbose dumps the resolved g++ command lines; the post-compile guards below
# grep compile.log to prove BOARD_HAS_PSRAM reached g++ and the dio_qspi libs
# were linked.
#
# mkdir the output dir first: `tee` opens compile.log at pipeline startup,
# concurrently with arduino-cli — on a fresh clone (or after `rm -rf build/`)
# the dir doesn't exist yet and `tee` aborts the whole build under pipefail
# before arduino-cli's --output-dir would have created it.
mkdir -p "${BUILD_DIR}"
arduino-cli compile \
  --fqbn "${FQBN}" \
  --output-dir "${BUILD_DIR}" \
  --libraries "${SKETCH_DIR}/lib" \
  --verbose \
  --build-property "compiler.c.extra_flags=-DFIRMWARE_VERSION=\"${VERSION}\" -DGEO_API_KEY=\"${GEO_API_KEY}\" -DFIRMWARE_SEQUENCE=${SEQUENCE}${DEV_URL_FLAGS}" \
  --build-property "compiler.cpp.extra_flags=-DFIRMWARE_VERSION=\"${VERSION}\" -DGEO_API_KEY=\"${GEO_API_KEY}\" -DFIRMWARE_SEQUENCE=${SEQUENCE}${DEV_URL_FLAGS}" \
  --build-property "build.partitions=min_spiffs" \
  "${SKETCH_DIR}" 2>&1 \
  | sed -E 's/(GEO_API_KEY=)[^[:space:]]*/\1<redacted>/g' \
  | tee "${BUILD_DIR}/compile.log"

# Post-compile guard. The contract: FIRMWARE_VERSION must land in the
# binary as a plain C string of the bee name (e.g. the bytes "carpenter"),
# NOT as a string whose content is itself wrapped in literal quote bytes
# (e.g. the bytes "\"carpenter\""). The latter happens whenever the
# --build-property quoting picks up an extra layer — for example a
# refactor that re-introduces shell-style escaping (\" or \\\")
# assuming arduino-cli does shell-quote stripping. It does not; it
# passes property values verbatim into argv. The 1-layer form below
# (\"${VERSION}\") is the correct level for arduino-cli.
#
# Caveat: if VERSION ever takes a value that coincides with a quoted
# byte sequence already present in vendored library .rodata, the
# absent-literal check would false-positive. Bee-name pool is safe
# today; revisit if the naming convention changes.
if grep -aFq "\"${VERSION}\"" "${BUILD_DIR}/ESP32-CAM.ino.bin"; then
  echo "ERROR: firmware contains literal \\\"${VERSION}\\\" — FIRMWARE_VERSION over-escaped (extra layer of quote bytes in the C string content)" >&2
  exit 1
fi
if ! grep -aFq "${VERSION}" "${BUILD_DIR}/ESP32-CAM.ino.bin"; then
  echo "ERROR: firmware does not contain ${VERSION} — FIRMWARE_VERSION was not injected" >&2
  exit 1
fi
echo "Verified: FIRMWARE_VERSION=${VERSION} is in the binary as a plain string."

# PSRAM guard 1/2 — the compile-time define (#163). build.extra_flags carries
# {build.defines} (-DBOARD_HAS_PSRAM + the two psram cache-fix flags) from
# boards.txt; if a future refactor overrides build.extra_flags again it silently
# drops them. Necessary but NOT sufficient (see guard 2). Assert it reached g++.
if ! grep -q -- '-DBOARD_HAS_PSRAM' "${BUILD_DIR}/compile.log"; then
  echo "ERROR: -DBOARD_HAS_PSRAM never reached the compiler — release binary would run without PSRAM (issue #163)" >&2
  exit 1
fi
echo "Verified: -DBOARD_HAS_PSRAM reached the compiler."

# PSRAM guard 2/2 — the memory_type must match the flash mode (#163). This is the
# guard that actually catches the bug that shipped: -DBOARD_HAS_PSRAM alone is not
# enough. The ESP32 core links precompiled libs + a bootloader from
# {compiler.sdk.path}/{build.memory_type}, where build.memory_type={build.boot}_qspi.
# The bare FQBN defaults to build.boot=qio -> qio_qspi libs, but we flash in dio
# mode (FLASH_MODE=dio) — that lib/flash-mode mismatch makes esp_psram_init() fail
# at boot (found=0, degraded VGA). The FlashMode=dio FQBN above pins build.boot=dio
# -> dio_qspi, matching the flash mode (and matching pio, which always reported
# found=1). Bench-proven on COM13 (AI-Thinker, ESP32-D0WD-V3): qio_qspi -> found=0,
# dio_qspi -> found=1. Assert the dio_qspi libs were linked and qio_qspi was not.
if ! grep -aq -- '/dio_qspi' "${BUILD_DIR}/compile.log" || grep -aq -- '/qio_qspi' "${BUILD_DIR}/compile.log"; then
  echo "ERROR: build did not link the dio_qspi memory_type (expected dio_qspi to match the dio flash mode; a qio_qspi link makes PSRAM init fail at boot — issue #163)" >&2
  exit 1
fi
echo "Verified: linked dio_qspi memory_type (matches dio flash mode)."

# Build the single merged binary for web flashing. arduino-cli (unlike the
# old Arduino IDE flow) does NOT produce ESP32-CAM.ino.merged.bin on its
# own — only the app, bootloader, and partitions as separate .bin files.
# Stitch them ourselves via esptool merge_bin, plus the boot_app0.bin from
# the ESP32 core (the OTA selector). Standard ESP32 (Wrover-class) layout:
# 0x1000 bootloader / 0x8000 partitions / 0xe000 boot_app0 / 0x10000 app.
#
# We pin to esp32:esp32@2.0.17 (the version esp-flashing.md tells
# contributors to install) so a later/older core appearing on the box
# doesn't silently get used. If the pinned tools are missing, fail loudly
# rather than guess: a wrong-core merge produces a binary that boots on
# some AI Thinker units and bricks others.
ESP32_CORE_VERSION="${ESP32_CORE_VERSION:-2.0.17}"
# Cross-platform default for arduino-cli's data directory: Windows
# stores it under %LOCALAPPDATA%/Arduino15; macOS under
# ~/Library/Arduino15; Linux under ~/.arduino15. Honour an explicit
# ARDUINO_DATA_DIR override first (CI sets this), else probe in that
# order. The :- defaults are required because set -u is on (line 2).
if [ -z "${ARDUINO_DATA_DIR:-}" ]; then
  if [ -n "${LOCALAPPDATA:-}" ] && [ -d "${LOCALAPPDATA}/Arduino15" ]; then
    ARDUINO_DATA_DIR="${LOCALAPPDATA}/Arduino15"
  elif [ -d "${HOME}/Library/Arduino15" ]; then
    ARDUINO_DATA_DIR="${HOME}/Library/Arduino15"
  else
    ARDUINO_DATA_DIR="${HOME}/.arduino15"
  fi
fi
# boot_app0 is core-version-pinned (lives under the core install dir).
# esptool_py is shipped as a separate tool by arduino-cli; only one
# version is installed per core, but if the user has multiple cores
# installed there could be multiple esptool_py versions. We pick the
# highest by sort -V; merge_bin's CLI is stable across the 4.x line so
# this is safe. The `|| true` is required because `set -o pipefail`
# would otherwise abort the script when the esptool_py directory
# doesn't exist (Windows user has arduino-cli but not the esp32 core)
# — find exits 1, pipefail propagates, and the helpful error message
# below never fires. Empty result flows into the ESPTOOL existence
# check.
ESPTOOL_DIR="$(find "${ARDUINO_DATA_DIR}/packages/esp32/tools/esptool_py" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V -r | head -1 || true)"
# arduino-cli ships esptool.py on Linux/macOS and (typically) both
# esptool.exe and esptool.py on Windows. Prefer the .exe when present:
# it bundles a matching Python interpreter and esptool module, whereas
# .py depends on the system Python having a compatible `esptool`
# module installed — on a box where pip installs a newer esptool, the
# vendored 4.5.1 esptool.py crashes with `module 'esptool' has no
# attribute '_main'`. On Linux/macOS there is no .exe so the loop
# falls through to .py with no behaviour change. The existence check
# below catches the "core not installed" case.
ESPTOOL=""
for candidate in "${ESPTOOL_DIR}/esptool.exe" "${ESPTOOL_DIR}/esptool.py"; do
  if [ -f "${candidate}" ]; then
    ESPTOOL="${candidate}"
    break
  fi
done
BOOT_APP0="${ARDUINO_DATA_DIR}/packages/esp32/hardware/esp32/${ESP32_CORE_VERSION}/tools/partitions/boot_app0.bin"
if [ -z "${ESPTOOL}" ] || [ ! -f "${BOOT_APP0}" ]; then
  echo "ERROR: missing arduino-cli toolchain pieces:" >&2
  if [ -z "${ESPTOOL}" ]; then
    echo "       esptool   not found under ${ESPTOOL_DIR:-<empty>} (tried esptool.exe then esptool.py)" >&2
  else
    echo "       esptool   ${ESPTOOL} (exists: yes)" >&2
  fi
  echo "       boot_app0 ${BOOT_APP0} (exists: $([ -f "${BOOT_APP0}" ] && echo yes || echo NO))" >&2
  echo "       Run: arduino-cli core install esp32:esp32@${ESP32_CORE_VERSION}" >&2
  exit 1
fi

# Flash params for the AI Thinker ESP32-CAM. 80m is the trickiest of the
# three: nominally fine on standard 4MB/dio modules, but a small fraction
# of older AI Thinker units in the wild ship 40MHz-rated flash and won't
# boot from an 80MHz image. Override via env vars if you're cutting a
# release for one of those units. (Proper fix: derive these from the
# FQBN's boards.txt — left as a follow-up.)
FLASH_MODE="${FLASH_MODE:-dio}"
FLASH_FREQ="${FLASH_FREQ:-80m}"
FLASH_SIZE="${FLASH_SIZE:-4MB}"

# FLASH_MODE must stay dio (#163). The FQBN pins FlashMode=dio, which compiles
# the bootloader + links the dio_qspi libs; merging the image with a non-dio
# flash header would re-create the exact qio/dio mismatch that broke PSRAM
# (the dio_qspi guard above can't catch a divergence here — it only sees the
# link, not the merge header). FLASH_FREQ/FLASH_SIZE are safe to override
# (frequency/size don't touch memory_type); flash MODE is not.
if [ "${FLASH_MODE}" != "dio" ]; then
  echo "ERROR: FLASH_MODE=${FLASH_MODE} but the FQBN pins FlashMode=dio — a non-dio merge header re-creates the PSRAM-breaking qio/dio mismatch (issue #163). Leave FLASH_MODE=dio." >&2
  exit 1
fi

# Resolve a working interpreter. On Linux/macOS this is python3. On
# Windows-from-python.org it is `python`. We MUST validate each
# candidate by actually running `--version` because Windows ships an
# MS Store stub at python3.exe that is on PATH (so `command -v` finds
# it) but exits non-zero with "Python wurde nicht gefunden" when
# invoked. Probing with --version catches the stub. If ESPTOOL is the
# Windows .exe we invoke it directly and skip Python entirely.
if [[ "${ESPTOOL}" == *.exe ]]; then
  MERGE_CMD=( "${ESPTOOL}" )
else
  PYTHON=""
  for candidate in python3 python; do
    candidate_path="$(command -v "${candidate}" || true)"
    if [ -n "${candidate_path}" ] && "${candidate_path}" --version >/dev/null 2>&1; then
      PYTHON="${candidate_path}"
      break
    fi
  done
  if [ -z "${PYTHON}" ]; then
    echo "ERROR: no working python3/python interpreter found on PATH." >&2
    echo "       Tried: python3, python (in that order). Each was either" >&2
    echo "       absent or failed --version (the Microsoft Store stub at" >&2
    echo "       python3.exe is a known offender: on PATH but exits non-zero" >&2
    echo "       with 'Python wurde nicht gefunden')." >&2
    echo "       On Windows, install Python from python.org and ensure it" >&2
    echo "       is on PATH ahead of the MS Store alias." >&2
    exit 1
  fi
  MERGE_CMD=( "${PYTHON}" "${ESPTOOL}" )
fi

"${MERGE_CMD[@]}" --chip esp32 merge_bin \
  -o "${BUILD_DIR}/ESP32-CAM.ino.merged.bin" \
  --flash_mode "${FLASH_MODE}" --flash_freq "${FLASH_FREQ}" --flash_size "${FLASH_SIZE}" \
  0x1000  "${BUILD_DIR}/ESP32-CAM.ino.bootloader.bin" \
  0x8000  "${BUILD_DIR}/ESP32-CAM.ino.partitions.bin" \
  0xe000  "${BOOT_APP0}" \
  0x10000 "${BUILD_DIR}/ESP32-CAM.ino.bin"

echo ""
echo "Build artifacts:"
ls -lh "${BUILD_DIR}"/ESP32-CAM.ino.bin "${BUILD_DIR}"/ESP32-CAM.ino.merged.bin

# Copy merged binary for web flashing + write a sidecar manifest the wizard
# reads to display the version. Each release is named after a bee species —
# bump VERSION when you cut a new firmware build.
HOMEPAGE_PUBLIC="${SKETCH_DIR}/../homepage/public"
if [ -d "${HOMEPAGE_PUBLIC}" ]; then
  cp "${BUILD_DIR}/ESP32-CAM.ino.merged.bin" "${HOMEPAGE_PUBLIC}/firmware.bin"
  MD5="$(md5sum "${HOMEPAGE_PUBLIC}/firmware.bin" | awk '{print $1}')"
  # App-only binary for HTTP OTA (#26). HTTPUpdate / Update.write
  # expects the application image alone — not the merged bootloader +
  # partitions + app blob the web installer flashes. Publish both so
  # one manifest serves both consumers; the OTA fetch path reads
  # `app_md5`/`app_size`, the web installer keeps reading `md5`.
  cp "${BUILD_DIR}/ESP32-CAM.ino.bin" "${HOMEPAGE_PUBLIC}/firmware.app.bin"
  APP_MD5="$(md5sum "${HOMEPAGE_PUBLIC}/firmware.app.bin" | awk '{print $1}')"
  APP_SIZE="$(stat -c%s "${HOMEPAGE_PUBLIC}/firmware.app.bin")"
  MERGED_SIZE="$(stat -c%s "${HOMEPAGE_PUBLIC}/firmware.bin")"
  # Sanity invariant: the merged image (bootloader + partitions +
  # boot_app0 + app) must strictly exceed the app-only image. If they
  # cross — e.g. a future refactor swaps the two `cp` sources, or
  # esptool's merge output changes — the OTA path would consume
  # bootloader bytes as if they were the app and brick every module
  # on its next OTA boot. Loud build failure is cheaper than a fleet
  # bricking.
  if [ "${APP_SIZE}" -ge "${MERGED_SIZE}" ]; then
    echo "ERROR: firmware.app.bin (${APP_SIZE}) >= firmware.bin (${MERGED_SIZE}) — the two artifacts may be crossed" >&2
    exit 1
  fi
  BUILT_AT="$(date -Iseconds)"
  # `allow_downgrade` is emitted explicitly as `false` so the
  # happy-path manifest is a positive declaration of the safe default
  # rather than relying on the parser's "absent → false" branch. An
  # operator publishing a deliberate rollback flips it to `true` by
  # hand (see esp-flashing.md "How to deliberately roll back").
  cat > "${HOMEPAGE_PUBLIC}/firmware.json" <<JSON
{"version":"${VERSION}","md5":"${MD5}","built_at":"${BUILT_AT}","app_md5":"${APP_MD5}","app_size":${APP_SIZE},"sequence":${SEQUENCE},"allow_downgrade":false}
JSON
  echo ""
  echo "Copied firmware.bin     to ${HOMEPAGE_PUBLIC}/ (${MD5})"
  echo "Copied firmware.app.bin to ${HOMEPAGE_PUBLIC}/ (${APP_MD5}, ${APP_SIZE} bytes)"
  echo "Wrote manifest:           ${HOMEPAGE_PUBLIC}/firmware.json (version=${VERSION}, sequence=${SEQUENCE})"
fi
