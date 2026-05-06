"""PlatformIO pre-build hook: inject FIRMWARE_VERSION from VERSION file.

Mirrors what ``build.sh`` passes to ``arduino-cli`` via ``--build-property``,
so both build paths agree on the firmware version macro. The fallback in
``esp_init.h`` only fires for raw Arduino IDE compiles that don't go through
either path.

Wired into ``[env:esp32cam]`` via ``extra_scripts = pre:extra_scripts.py``.
"""

from pathlib import Path

Import("env")  # noqa: F821 — provided by PlatformIO at script-eval time

version_file = Path(env["PROJECT_DIR"]) / "VERSION"  # noqa: F821
version = (
    version_file.read_text(encoding="utf-8").strip()
    if version_file.exists()
    else "dev-unset"
)

env.Append(  # noqa: F821
    CPPDEFINES=[("FIRMWARE_VERSION", env.StringifyMacro(version))]  # noqa: F821
)

print(f"[extra_scripts] FIRMWARE_VERSION={version}")
