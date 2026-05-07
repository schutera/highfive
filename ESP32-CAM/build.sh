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

echo "Compiling ESP32-CAM firmware..."
echo "  FQBN:    ${FQBN}"
echo "  Sketch:  ${SKETCH_DIR}"
echo "  Output:  ${BUILD_DIR}"
echo "  Version: ${VERSION}"
echo ""

arduino-cli compile \
  --fqbn "${FQBN}" \
  --output-dir "${BUILD_DIR}" \
  --libraries "${SKETCH_DIR}/lib" \
  --build-property "build.extra_flags=-DFIRMWARE_VERSION=\"${VERSION}\"" \
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
  BUILT_AT="$(date -Iseconds)"
  cat > "${HOMEPAGE_PUBLIC}/firmware.json" <<JSON
{"version":"${VERSION}","md5":"${MD5}","built_at":"${BUILT_AT}"}
JSON
  echo ""
  echo "Copied firmware.bin to ${HOMEPAGE_PUBLIC}/"
  echo "Wrote manifest:    ${HOMEPAGE_PUBLIC}/firmware.json (version=${VERSION})"
fi
