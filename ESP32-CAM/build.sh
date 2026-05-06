#!/usr/bin/env bash
set -euo pipefail

SKETCH_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${SKETCH_DIR}/build"
FQBN="esp32:esp32:esp32cam"

# Read once and reuse below: the same value is injected into the firmware
# binary as -DFIRMWARE_VERSION and written into the homepage manifest, so
# boot log + telemetry + heartbeat + OTA manifest all agree.
VERSION="$(cat "${SKETCH_DIR}/VERSION" 2>/dev/null || echo dev)"

echo "Compiling ESP32-CAM firmware..."
echo "  FQBN:    ${FQBN}"
echo "  Sketch:  ${SKETCH_DIR}"
echo "  Output:  ${BUILD_DIR}"
echo "  Version: ${VERSION}"
echo ""

arduino-cli compile \
  --fqbn "${FQBN}" \
  --output-dir "${BUILD_DIR}" \
  --build-property "build.extra_flags=-DFIRMWARE_VERSION=\"\\\"${VERSION}\\\"\"" \
  "${SKETCH_DIR}"

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
