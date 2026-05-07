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

# Verify the macro landed as a C string literal (not as a token, and
# not as a doubly-quoted "\"name\"" thanks to a quoting-arms-race fail).
# The merged binary should contain VERSION exactly once near the
# strings table; the literal escaped form must NOT appear. Caveat:
# if VERSION ever takes a value that coincides with a quoted byte
# sequence already present in vendored library .rodata, the absent-
# literal check would false-positive. Bee-name pool is safe today;
# revisit if the naming convention ever changes.
if grep -aFq "\"${VERSION}\"" "${BUILD_DIR}/ESP32-CAM.ino.bin"; then
  echo "ERROR: firmware contains literal \\\"${VERSION}\\\" — quote-escaping doubled" >&2
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
ARDUINO_DATA_DIR="${ARDUINO_DATA_DIR:-$HOME/.arduino15}"
ESPTOOL="$(find "${ARDUINO_DATA_DIR}/packages/esp32/tools/esptool_py" -name esptool.py 2>/dev/null | head -1)"
BOOT_APP0="$(find "${ARDUINO_DATA_DIR}/packages/esp32/hardware/esp32" -name boot_app0.bin 2>/dev/null | head -1)"
if [ -z "${ESPTOOL}" ] || [ -z "${BOOT_APP0}" ]; then
  echo "ERROR: could not locate esptool.py or boot_app0.bin under ${ARDUINO_DATA_DIR}." >&2
  echo "       Run: arduino-cli core install esp32:esp32@2.0.17" >&2
  exit 1
fi
python3 "${ESPTOOL}" --chip esp32 merge_bin \
  -o "${BUILD_DIR}/ESP32-CAM.ino.merged.bin" \
  --flash_mode dio --flash_freq 80m --flash_size 4MB \
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
