"""PlatformIO pre-build hook: inject FIRMWARE_VERSION, FIRMWARE_SEQUENCE, GEO_API_KEY.

Mirrors what ``build.sh`` passes to ``arduino-cli`` via ``--build-property``,
so both build paths agree on the build-time macros. The fallback in
``esp_init.h`` only fires for raw Arduino IDE compiles that don't go through
either path.

NOTE (chapter-11 follow-up): this is the third macro injected through both
this script and ``build.sh``. The duplication is intentional for now — see
``docs/11-risks-and-technical-debt/README.md`` for the eventual consolidation
into ``build_macros.{sh,py}``. Don't add a fourth without consolidating.

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
import re
from pathlib import Path

Import("env")  # noqa: F821 — provided by PlatformIO at script-eval time

project_dir = Path(env["PROJECT_DIR"])  # noqa: F821


def _strip_all_whitespace(value: str) -> str:
    """Mirror ``build.sh``'s ``tr -d '[:space:]'`` for ASCII whitespace.

    ``str.strip()`` only removes outer whitespace, but ``build.sh`` strips
    ALL whitespace from both env-var and file sources. If the two paths
    diverged on a key with embedded whitespace (a stray space pasted from
    a wrapped-line email, a tab from clipboard tooling), the same source
    file would produce two binaries with different keys baked in
    depending on which builder ran. The character class
    ``[ \\t\\n\\v\\f\\r]`` matches POSIX ``[:space:]`` byte-for-byte —
    the same six bytes ``tr -d '[:space:]'`` removes — so the two paths
    converge on identical output for any byte sequence either could
    encounter.

    Python's ``\\s`` (without ``re.ASCII``) would additionally match
    Unicode whitespace such as NBSP (U+00A0) and U+2028/2029, which
    ``tr`` would leave alone — that asymmetry is deliberately avoided
    here so ``len()`` reported at build time matches what bash would
    have produced from the same input.
    """
    return re.sub(r"[ \t\n\v\f\r]+", "", value)


version_file = project_dir / "VERSION"
version = (
    version_file.read_text(encoding="utf-8").strip()
    if version_file.exists()
    else "dev-unset"
)

# SEQUENCE (#83): operator-bumped monotonic integer. Read from
# `ESP32-CAM/SEQUENCE`. The Arduino-IDE fallback (no SEQUENCE file at
# all) emits ``0``; `hf::shouldOtaUpdate` carries an explicit
# `current_sequence == 0 → refuse` guard so a dev binary cannot
# auto-OTA to a properly-built fleet release. Full rationale in
# ``esp_init.h``'s `FIRMWARE_SEQUENCE` block.
#
# Loud-fail on a present-but-malformed SEQUENCE file. Mirrors the
# `build.sh` policy exactly: a dev who ran `pio run -e esp32cam`
# against a `SEQUENCE` file containing `abc` or `-1` would otherwise
# silently get a `FIRMWARE_SEQUENCE=0` firmware that refuses every
# OTA from a properly-built fleet — diagnosable, but the loud-fail
# behaviour is the better default (round-1 senior-review P2:
# "two builders, two policies").
sequence_file = project_dir / "SEQUENCE"
if sequence_file.exists():
    try:
        sequence = int(_strip_all_whitespace(sequence_file.read_text(encoding="utf-8")))
    except ValueError as exc:
        # Use Exit() so the PIO log surfaces the cause; print first so
        # the operator sees what was wrong, then abort the build.
        print(
            f"[extra_scripts] ERROR: {sequence_file} is not a valid integer: {exc}"
        )
        Exit(1)  # noqa: F821 — PIO global
    if sequence < 1:
        print(
            f"[extra_scripts] ERROR: SEQUENCE must be >= 1; got {sequence} from {sequence_file}"
        )
        Exit(1)  # noqa: F821
else:
    sequence = 0

geo_key_file = project_dir / "GEO_API_KEY"
geo_key = (
    _strip_all_whitespace(os.environ.get("GEO_API_KEY") or "")
    or (_strip_all_whitespace(geo_key_file.read_text(encoding="utf-8")) if geo_key_file.exists() else "")
)

env.Append(  # noqa: F821
    CPPDEFINES=[
        ("FIRMWARE_VERSION",  env.StringifyMacro(version)),       # noqa: F821
        ("FIRMWARE_SEQUENCE", str(sequence)),
        ("GEO_API_KEY",       env.StringifyMacro(geo_key)),       # noqa: F821
    ]
)

print(f"[extra_scripts] FIRMWARE_VERSION={version}")
print(f"[extra_scripts] FIRMWARE_SEQUENCE={sequence}")
print(f"[extra_scripts] GEO_API_KEY len={len(geo_key)}")
