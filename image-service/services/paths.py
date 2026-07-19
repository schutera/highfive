"""Filesystem containment + upload-filename hygiene (2026-07 audit, for #202).

Two trust-boundary rules enforced here:

1. A client-supplied filename must never resolve outside its base folder
   (`safe_child_path` — the write/delete twin of the containment
   `send_from_directory` already gives the read paths).
2. A client-supplied upload filename is normalized to one safe path
   component and deduplicated instead of silently overwriting an
   existing capture (`sanitize_upload_filename` + `reserve_filename`).

Fleet grammar (see `ESP32-CAM/client.cpp`'s `createFileName`):
``esp_capture_YYYYMMDD_hhmmss.jpg`` or, without NTP time,
``esp_capture_unknown_<millis>.jpg``. The sanitizer's allowlist is a
strict superset of that alphabet, so every firmware-produced name
passes through byte-identical — only hostile or exotic names change.
"""

from __future__ import annotations

import os
import re

_DISALLOWED = re.compile(r"[^A-Za-z0-9._-]")

# Generous cap; fleet names are ~30 chars. Keeps a hostile kilobyte-long
# name from becoming a filesystem-limit error deep in the pipeline.
_MAX_NAME_LEN = 120


def safe_child_path(base_dir: str, name: str) -> str | None:
    """Join ``name`` under ``base_dir`` with realpath containment.

    Returns the absolute resolved path iff it stays strictly inside
    ``base_dir``; ``None`` for traversal (``../``), absolute paths, or
    the base directory itself.
    """
    root = os.path.realpath(base_dir)
    candidate = os.path.realpath(os.path.join(root, name))
    if candidate == root or not candidate.startswith(root + os.sep):
        return None
    return candidate


def sanitize_upload_filename(raw: str | None, *, fallback: str = "upload.jpg") -> str:
    """Normalize a client-supplied filename to a single safe path component.

    basename (both separator styles) → allowlist to ``[A-Za-z0-9._-]``
    (others become ``_``) → no leading dots → length cap (keeps the
    tail, preserving the extension) → ``fallback`` when nothing usable
    remains.
    """
    name = (raw or "").replace("\\", "/")
    name = os.path.basename(name)
    name = _DISALLOWED.sub("_", name).lstrip(".")
    if len(name) > _MAX_NAME_LEN:
        name = name[-_MAX_NAME_LEN:].lstrip(".")
    if not name or set(name) <= {"_", ".", "-"}:
        return fallback
    return name


def reserve_filename(directory: str, filename: str) -> str:
    """Atomically reserve a non-colliding name in ``directory``.

    On collision appends ``-1``, ``-2``, … before the extension. Fleet
    filenames carry no module identity (second-resolution timestamps
    only), so two modules capturing in the same second used to silently
    overwrite each other — reservation turns that into two files.

    Atomic on purpose: the name is claimed by creating an empty
    placeholder with ``O_CREAT | O_EXCL`` (the caller's subsequent save
    overwrites it). A check-then-write dedupe would race under the
    threaded Flask server — two concurrent uploads could both see "no
    collision" and clobber each other, which is exactly the scenario
    this exists to prevent (review-caught).
    """
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        stem, ext = filename, ""
    candidate = filename
    n = 0
    while True:
        try:
            fd = os.open(
                os.path.join(directory, candidate),
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            )
        except FileExistsError:
            n += 1
            candidate = f"{stem}-{n}.{ext}" if dot else f"{stem}-{n}"
            continue
        os.close(fd)
        return candidate
