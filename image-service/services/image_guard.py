"""JPEG magic-byte + dimension probe (2026-08 audit, for #228).

`/upload` is internet-reachable and credential-free (see the module
docstring in `app.py`), and until this guard existed the pipeline never
inspected the uploaded bytes before saving them and handing them to
`cv2.imread` — a same-origin stored-HTML risk (a `.html`/`.svg` upload
served back with a sniffed Content-Type) and a decompression-bomb risk (a
crafted JPEG with a huge SOF-declared frame OOM-killing the single-process
service). `probe_jpeg` rejects both classes before any byte reaches disk
or a decoder.

Deliberately pure Python, no Flask/OpenCV imports — mirrors `paths.py`'s
style so it's cheap to unit test and cannot itself become a resource-
exhaustion vector (it never decodes pixel data, only walks JPEG header
segments).
"""

from __future__ import annotations

import os

_SOI = b"\xff\xd8"

# Start-Of-Frame markers that carry frame dimensions. These share the
# 0xC0-0xCF numeric range with three markers that are NOT SOF and must be
# skipped like any other segment: 0xC4 (DHT, huffman tables), 0xC8
# (JPG, reserved/unused), 0xCC (DAC, arithmetic-coding conditioning).
_SOF_MARKERS = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}

# Markers with no length field / no payload to skip.
_NO_LENGTH_MARKERS = frozenset({0x01, *range(0xD0, 0xD8)})  # TEM, RSTn

_EOI = 0xD9

_DEFAULT_MAX_IMAGE_DIM = 4096

# A real JPEG header carries a handful of segments (APP0/APP1/DQT/DHT/...)
# before SOF — real fleet captures (`ESP32-CAM/client.cpp`) stay under 10.
# A hand-crafted file that strings together thousands of tiny segments
# without ever reaching SOF is itself hostile; bound the work rather than
# let it loop until MAX_CONTENT_LENGTH's 5 MB request cap is exhausted.
_MAX_SEGMENTS = 1000


class InvalidImageError(Exception):
    """Raised when a stream is not a plausible, in-bounds JPEG.

    ``reason`` is safe to put directly in a 400 response body: every
    message is a fixed description, with at most bounded 16-bit integers
    (declared width/height, `MAX_IMAGE_DIM`) interpolated in — never raw
    attacker-supplied bytes or arbitrary-length strings.
    """

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def max_image_dim_from_env() -> int:
    """Read ``MAX_IMAGE_DIM`` at call time (not import time) so tests can
    override it with a plain ``monkeypatch.setenv`` — no module reload
    needed. Real fleet frames cap at UXGA 1600x1200
    (`ESP32-CAM/esp_init.cpp::getResolutionFromString`), so the 4096
    default leaves 2x+ headroom on the long edge.

    Public (not module-private) because `services/hole_detection.py`
    derives its own `OPENCV_IO_MAX_IMAGE_PIXELS` ceiling from this same
    value (2026-08 audit, for #228 — a second hardcoded copy of the cap
    silently drifted from this one the moment an operator raised
    `MAX_IMAGE_DIM` without knowing hole_detection.py had its own)."""
    raw = os.getenv("MAX_IMAGE_DIM")
    if not raw:
        return _DEFAULT_MAX_IMAGE_DIM
    try:
        value = int(raw)
    except ValueError:
        return _DEFAULT_MAX_IMAGE_DIM
    return value if value > 0 else _DEFAULT_MAX_IMAGE_DIM


def probe_jpeg(stream, *, max_dim: int | None = None) -> tuple[int, int]:
    """Validate ``stream`` is a JPEG within ``max_dim`` and return ``(h, w)``.

    Walks JPEG header segments to find the first SOF marker and reads its
    declared dimensions — never decodes pixel data, so a crafted SOF
    claiming a huge frame is rejected before any decoder (``cv2.imread``)
    would allocate a buffer for it. Raises :class:`InvalidImageError` for
    anything that isn't a well-formed, in-bounds JPEG header (missing SOI,
    truncated segments, oversized dimensions).

    ``stream`` is read from position 0 regardless of where the caller left
    it, and is always left seeked back to position 0 on return — success or
    failure — so a caller that still wants to persist the full upload bytes
    (e.g. via ``FileStorage.save()``) can do so unconditionally.
    """
    if max_dim is None:
        max_dim = max_image_dim_from_env()
    stream.seek(0)
    try:
        return _probe(stream, max_dim)
    finally:
        stream.seek(0)


def _probe(stream, max_dim: int) -> tuple[int, int]:
    if stream.read(2) != _SOI:
        raise InvalidImageError("not a JPEG (missing SOI marker)")

    for _ in range(_MAX_SEGMENTS):
        marker_id = _read_marker_id(stream)

        if marker_id in _SOF_MARKERS:
            return _read_sof_dimensions(stream, max_dim)
        if marker_id in _NO_LENGTH_MARKERS:
            continue
        if marker_id == _EOI:
            raise InvalidImageError("reached end-of-image before any SOF marker")

        _skip_segment(stream)

    raise InvalidImageError(
        f"exceeded {_MAX_SEGMENTS} header segments without finding a SOF marker"
    )


def _read_marker_id(stream) -> int:
    """Consume one marker's leading 0xFF (+ any 0xFF fill bytes) and
    return its code byte. Raises on a truncated stream or a byte where a
    marker was expected."""
    b = stream.read(1)
    if not b:
        raise InvalidImageError("truncated stream (expected a marker)")
    if b != b"\xff":
        raise InvalidImageError("malformed segment (expected a marker)")
    while b == b"\xff":
        b = stream.read(1)
        if not b:
            raise InvalidImageError("truncated stream (expected a marker code)")
    return b[0]


def _read_sof_dimensions(stream, max_dim: int) -> tuple[int, int]:
    seg_len = _read_u16(stream, "SOF segment length")
    # A syntactically valid SOF is at least 8 bytes: the 2-byte length
    # field itself + precision(1) + height(2) + width(2) + num
    # components(1), with zero component entries following (senior-review
    # P2 — this was off by one; harmless in practice since the payload
    # read below is hardcoded to 5 bytes regardless of `seg_len`, but the
    # bound should still match the format it's validating).
    if seg_len < 8:
        raise InvalidImageError("SOF segment too short")
    payload = stream.read(5)  # precision(1) + height(2) + width(2)
    if len(payload) != 5:
        raise InvalidImageError("truncated SOF payload")
    height = (payload[1] << 8) | payload[2]
    width = (payload[3] << 8) | payload[4]
    if height <= 0 or width <= 0:
        raise InvalidImageError("SOF declares a zero-sized frame")
    if height > max_dim or width > max_dim:
        raise InvalidImageError(
            f"frame {width}x{height} exceeds MAX_IMAGE_DIM={max_dim}"
        )
    return height, width


def _skip_segment(stream) -> None:
    seg_len = _read_u16(stream, "segment length")
    if seg_len < 2:
        raise InvalidImageError("invalid segment length")
    body = stream.read(seg_len - 2)
    if len(body) != seg_len - 2:
        raise InvalidImageError("truncated segment body")


def _read_u16(stream, what: str) -> int:
    raw = stream.read(2)
    if len(raw) != 2:
        raise InvalidImageError(f"truncated {what}")
    return (raw[0] << 8) | raw[1]
