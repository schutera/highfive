#!/usr/bin/env bash
set -euo pipefail

SKETCH_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SKETCH_DIR}/build"
FQBN="esp32:esp32:esp32cam"

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

# GEO_API_KEY is the Google Geolocation API key used by getGeolocation in
# esp_init.cpp. Sourced from env var first, then a .gitignored file (so
# local dev doesn't have to export it every shell). Missing key is NOT
# fatal: the firmware's runtime guard logs a clear message and skips the
# HTTPS call. We never print the value — only its length — so this script
# can run in CI without leaking the secret into build logs.
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

echo "Compiling ESP32-CAM firmware..."
echo "  FQBN:    ${FQBN}"
echo "  Sketch:  ${SKETCH_DIR}"
echo "  Output:  ${BUILD_DIR}"
echo "  Version: ${VERSION}"
if [ -n "${GEO_API_KEY}" ]; then
  echo "  GeoKey:  set (len=${#GEO_API_KEY})"
else
  echo "  GeoKey:  <unset>"
  # First-boot side effect: with the geolocation fields left at their
  # 0.0f defaults, the module reports (lat=0, lng=0, acc=0) on its
  # first heartbeat and the homepage map plots it at Null Island in
  # the Gulf of Guinea until an operator corrects it. Loud on stderr
  # so the message survives a `> build.log` redirect. See
  # docs/08-crosscutting-concepts/auth.md "Third-party API keys".
  echo "" >&2
  echo "WARNING: GEO_API_KEY is unset. Firmware will skip the Google" >&2
  echo "         Geolocation call at first boot and report (0, 0, 0)," >&2
  echo "         which plots the module at Null Island on the dashboard." >&2
  echo "         Set GEO_API_KEY or write ESP32-CAM/GEO_API_KEY for a" >&2
  echo "         release build intended to reach an operator's map view." >&2
  echo "" >&2
fi
echo ""

# OTA partition layout (#26). min_spiffs gives two ~1.9 MB app slots
# (app0/app1) so ArduinoOTA/HTTPUpdate have somewhere to write the new
# binary. Mirrors platformio.ini's board_build.partitions = min_spiffs.csv
# so both build paths emit byte-identical partitions.bin.
arduino-cli compile \
  --fqbn "${FQBN}" \
  --output-dir "${BUILD_DIR}" \
  --libraries "${SKETCH_DIR}/lib" \
  --build-property "build.extra_flags=-DFIRMWARE_VERSION=\"${VERSION}\" -DGEO_API_KEY=\"${GEO_API_KEY}\"" \
  # no .csv here — arduino-cli takes the preset name; platformio.ini
  # uses min_spiffs.csv because PIO's lookup requires the .csv suffix.
  --build-property "build.partitions=min_spiffs" \
  "${SKETCH_DIR}"

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
ARDUINO_DATA_DIR="${ARDUINO_DATA_DIR:-$HOME/.arduino15}"
# boot_app0 is core-version-pinned (lives under the core install dir).
# esptool_py is shipped as a separate tool by arduino-cli; only one
# version is installed per core, but if the user has multiple cores
# installed there could be multiple esptool_py versions. We pick the
# highest by sort -V; merge_bin's CLI is stable across the 4.x line so
# this is safe.
ESPTOOL_DIR="$(find "${ARDUINO_DATA_DIR}/packages/esp32/tools/esptool_py" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V -r | head -1)"
ESPTOOL="${ESPTOOL_DIR}/esptool.py"
BOOT_APP0="${ARDUINO_DATA_DIR}/packages/esp32/hardware/esp32/${ESP32_CORE_VERSION}/tools/partitions/boot_app0.bin"
if [ ! -f "${ESPTOOL}" ] || [ ! -f "${BOOT_APP0}" ]; then
  echo "ERROR: missing arduino-cli toolchain pieces:" >&2
  echo "       esptool   ${ESPTOOL} (exists: $([ -f "${ESPTOOL}" ] && echo yes || echo NO))" >&2
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

python3 "${ESPTOOL}" --chip esp32 merge_bin \
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
  cat > "${HOMEPAGE_PUBLIC}/firmware.json" <<JSON
{"version":"${VERSION}","md5":"${MD5}","built_at":"${BUILT_AT}","app_md5":"${APP_MD5}","app_size":${APP_SIZE}}
JSON
  echo ""
  echo "Copied firmware.bin     to ${HOMEPAGE_PUBLIC}/ (${MD5})"
  echo "Copied firmware.app.bin to ${HOMEPAGE_PUBLIC}/ (${APP_MD5}, ${APP_SIZE} bytes)"
  echo "Wrote manifest:           ${HOMEPAGE_PUBLIC}/firmware.json (version=${VERSION})"
fi
