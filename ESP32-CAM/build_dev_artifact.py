"""Dev-only firmware-artifact generator.

`build.sh` is the canonical release path: it uses `arduino-cli` to produce
both the merged `firmware.bin` (web installer) and the app-only
`firmware.app.bin` (OTA), and writes the `firmware.json` manifest with
md5 + size for both.

In a dev environment without `arduino-cli` installed, this script takes
the PIO build's existing `firmware.bin` (which IS the app-only image —
PIO does not produce a merged binary) and writes JUST the OTA-relevant
artifacts: `homepage/public/firmware.app.bin` and a `firmware.json`
manifest carrying `version`, `app_md5`, `app_size`. The merged
`firmware.bin` field is left empty / matched to the app binary; the
web installer path is not exercised by this script. T2 (HTTP boot-pull
OTA) is the only flow this serves.

Usage (from repo root or ESP32-CAM/):
    python ESP32-CAM/build_dev_artifact.py

Reads VERSION from `ESP32-CAM/VERSION`. Reads PIO output from
`ESP32-CAM/.pio/build/esp32cam/firmware.bin` (run `pio run -e esp32cam`
first if missing). Writes `homepage/public/firmware.app.bin` and
`homepage/public/firmware.json`.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PIO_OUT = HERE / ".pio" / "build" / "esp32cam" / "firmware.bin"
VERSION_FILE = HERE / "VERSION"
HOMEPAGE_PUBLIC = REPO / "homepage" / "public"


def main() -> int:
    if not PIO_OUT.exists():
        print(
            f"ERROR: {PIO_OUT} not found. Run `pio run -e esp32cam` first.",
            file=sys.stderr,
        )
        return 1
    if not VERSION_FILE.exists():
        print(f"ERROR: {VERSION_FILE} not found.", file=sys.stderr)
        return 1

    version = VERSION_FILE.read_text(encoding="utf-8").strip()
    if not version:
        print(f"ERROR: {VERSION_FILE} is empty.", file=sys.stderr)
        return 1

    HOMEPAGE_PUBLIC.mkdir(parents=True, exist_ok=True)
    dst_app = HOMEPAGE_PUBLIC / "firmware.app.bin"
    shutil.copyfile(PIO_OUT, dst_app)

    app_bytes = dst_app.read_bytes()
    app_md5 = hashlib.md5(app_bytes).hexdigest()
    app_size = len(app_bytes)

    # Delete any pre-existing merged `firmware.bin` left over from a
    # previous `build.sh` run. The web installer reads `firmware.bin`
    # (merged: bootloader + partitions + boot_app0 + app) and trusts
    # the manifest's `md5` field to integrity-check it. We do NOT
    # produce a merged binary from PIO output, so if we left a stale
    # release-built `firmware.bin` on disk paired with this dev
    # manifest, the wizard would happily flash old bootloader bytes
    # onto a fresh module. Removing the file forces a loud 404 in the
    # wizard instead. Re-run `build.sh` if you need a real merged
    # release artifact.
    merged = HOMEPAGE_PUBLIC / "firmware.bin"
    if merged.exists():
        merged.unlink()
        print(f"Removed stale {merged} (release path needs `bash ESP32-CAM/build.sh`)")

    # Manifest omits the `md5` field that points at the merged image.
    # `app_md5` is the OTA-path integrity check; the web installer
    # path is not exercised by this dev script. The wizard reads
    # `md5` to verify the merged download — leaving it absent makes
    # the failure mode "wizard reports missing field" rather than
    # "wizard silently flashes the wrong bytes against a fake hash".
    manifest = {
        "version": version,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "app_md5": app_md5,
        "app_size": app_size,
    }
    (HOMEPAGE_PUBLIC / "firmware.json").write_text(
        json.dumps(manifest), encoding="utf-8"
    )

    print(f"Wrote {dst_app} ({app_size} bytes)")
    print(f"Wrote {HOMEPAGE_PUBLIC / 'firmware.json'}")
    print(f"  version={version} app_md5={app_md5} app_size={app_size}")
    print("  (dev manifest — no merged firmware.bin; web installer disabled)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
