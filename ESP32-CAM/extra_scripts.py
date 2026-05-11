"""PlatformIO pre-build hook: inject FIRMWARE_VERSION and GEO_API_KEY.

Mirrors what ``build.sh`` passes to ``arduino-cli`` via ``--build-property``,
so both build paths agree on the build-time macros. The fallback in
``esp_init.h`` only fires for raw Arduino IDE compiles that don't go through
either path.

Wired into ``[env:esp32cam]`` via ``extra_scripts = pre:extra_scripts.py``.

``GEO_API_KEY`` source order:
1. ``GEO_API_KEY`` environment variable (CI / production builds).
2. ``ESP32-CAM/GEO_API_KEY`` file (``.gitignored``, local-dev convenience).
3. Empty string (Arduino IDE / unconfigured builds). The firmware's
   runtime guard in ``getGeolocation`` will then skip the HTTPS call
   and log a clear message instead of issuing a broken request.

Only the *length* of the key is printed at build time, never the value.
"""

import os
from pathlib import Path

Import("env")  # noqa: F821 — provided by PlatformIO at script-eval time

project_dir = Path(env["PROJECT_DIR"])  # noqa: F821

version_file = project_dir / "VERSION"
version = (
    version_file.read_text(encoding="utf-8").strip()
    if version_file.exists()
    else "dev-unset"
)

geo_key_file = project_dir / "GEO_API_KEY"
# Both sources are .strip()'d so a trailing newline (common when a CI
# secret is written via `echo "$KEY" > file`) cannot land in the macro
# and silently break the request.
geo_key = (
    (os.environ.get("GEO_API_KEY") or "").strip()
    or (geo_key_file.read_text(encoding="utf-8").strip() if geo_key_file.exists() else "")
)

env.Append(  # noqa: F821
    CPPDEFINES=[
        ("FIRMWARE_VERSION", env.StringifyMacro(version)),       # noqa: F821
        ("GEO_API_KEY",      env.StringifyMacro(geo_key)),       # noqa: F821
    ]
)

print(f"[extra_scripts] FIRMWARE_VERSION={version}")
print(f"[extra_scripts] GEO_API_KEY len={len(geo_key)}")
