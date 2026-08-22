"""Unit tests for services.image_guard (2026-08 audit, for #228)."""

from __future__ import annotations

import io
import struct

import cv2
import numpy as np
import pytest

from services.image_guard import InvalidImageError, probe_jpeg


def _real_jpeg_bytes(height: int = 32, width: int = 48) -> bytes:
    """A small, valid, real JPEG — encoded on the fly so the test has no
    binary fixture to keep in sync."""
    img = np.zeros((height, width, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def _hand_built_jpeg(
    height: int,
    width: int,
    *,
    with_app0: bool = True,
    with_dht_before_sof: bool = False,
) -> bytes:
    """Build JPEG bytes by hand: SOI [+ APP0] [+ DHT] SOF0(height, width).

    Mirrors the byte layout `probe_jpeg` is documented to parse, without
    depending on a real encoder — lets the oversized-dimension and
    DHT-before-SOF cases exist without a multi-gigapixel real image.
    """
    out = bytearray(b"\xff\xd8")  # SOI
    if with_app0:
        # APP0 "JFIF" segment: FF E0, len=16, "JFIF\0" + 9 bytes of filler.
        out += b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    if with_dht_before_sof:
        # Minimal-shaped DHT segment (FF C4) the prober must skip, not
        # mistake for a SOF marker (C0-CF minus C4/C8/CC).
        out += b"\xff\xc4" + struct.pack(">H", 6) + b"\x00\x00\x00\x00"
    # SOF0: FF C0, len=17 (2 + 1 precision + 2 h + 2 w + 1 ncomp + 3*3 comp),
    # precision=8, height, width, 3 components x 3 bytes each.
    sof_payload = (
        bytes([8])
        + struct.pack(">H", height)
        + struct.pack(">H", width)
        + bytes([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0])
    )
    out += b"\xff\xc0" + struct.pack(">H", 2 + len(sof_payload)) + sof_payload
    return bytes(out)


# --------------------------- valid JPEGs ---------------------------


def test_real_jpeg_returns_declared_dimensions():
    h, w = probe_jpeg(io.BytesIO(_real_jpeg_bytes(height=32, width=48)))
    assert (h, w) == (32, 48)


def test_hand_built_sof0_parses_dimensions():
    h, w = probe_jpeg(io.BytesIO(_hand_built_jpeg(480, 640)))
    assert (h, w) == (480, 640)


def test_dht_before_sof_is_skipped_not_mistaken_for_sof():
    h, w = probe_jpeg(io.BytesIO(_hand_built_jpeg(480, 640, with_dht_before_sof=True)))
    assert (h, w) == (480, 640)


def test_stream_position_is_zero_after_success():
    stream = io.BytesIO(_real_jpeg_bytes())
    stream.seek(5)  # simulate a caller that already read a bit
    probe_jpeg(stream)
    assert stream.tell() == 0


# --------------------------- rejections ---------------------------


def test_missing_soi_is_rejected():
    with pytest.raises(InvalidImageError, match="SOI"):
        probe_jpeg(io.BytesIO(b"not a jpeg at all"))


def test_png_bytes_are_rejected():
    png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00"
        b"\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    with pytest.raises(InvalidImageError):
        probe_jpeg(io.BytesIO(png))


def test_truncated_stream_is_rejected():
    truncated = _real_jpeg_bytes()[:10]
    with pytest.raises(InvalidImageError):
        probe_jpeg(io.BytesIO(truncated))


def test_empty_stream_is_rejected():
    with pytest.raises(InvalidImageError, match="SOI"):
        probe_jpeg(io.BytesIO(b""))


def test_dimension_over_default_cap_is_rejected():
    with pytest.raises(InvalidImageError, match="exceeds MAX_IMAGE_DIM"):
        probe_jpeg(io.BytesIO(_hand_built_jpeg(20000, 20000)))


def test_zero_sized_frame_is_rejected():
    with pytest.raises(InvalidImageError, match="zero-sized"):
        probe_jpeg(io.BytesIO(_hand_built_jpeg(0, 640)))


def test_stream_position_is_zero_after_failure():
    stream = io.BytesIO(b"not a jpeg")
    with pytest.raises(InvalidImageError):
        probe_jpeg(stream)
    assert stream.tell() == 0


# --------------------------- segment-count bound ---------------------------


def test_excessive_segments_without_sof_is_rejected_not_looped_forever():
    """Senior-review P1: the `_MAX_SEGMENTS` bound had zero coverage — a
    future refactor from the bounded `for` loop to an unbounded `while True`
    would pass every other test in this file. Craft a stream with more
    empty APP1 segments than the bound and confirm it's rejected quickly
    rather than looping until the stream is exhausted."""
    import services.image_guard as image_guard_mod

    # Each empty APP1 segment is 4 bytes: FF E1 00 02 (marker + length=2,
    # i.e. zero-byte payload). One more than the bound guarantees the loop
    # cannot find a SOF marker before hitting the cap.
    empty_app1 = b"\xff\xe1\x00\x02"
    body = empty_app1 * (image_guard_mod._MAX_SEGMENTS + 1)
    with pytest.raises(InvalidImageError, match="exceeded"):
        probe_jpeg(io.BytesIO(b"\xff\xd8" + body))


def test_segment_count_at_the_bound_still_finds_a_later_sof():
    """The bound must not be off-by-one against a legitimate (if unusual)
    header with exactly `_MAX_SEGMENTS` segments before SOF."""
    import services.image_guard as image_guard_mod

    empty_app1 = b"\xff\xe1\x00\x02"
    # One fewer filler segment than the cap, then a real SOF0 — the SOF
    # itself is segment number `_MAX_SEGMENTS`, still within the bound.
    body = (
        empty_app1 * (image_guard_mod._MAX_SEGMENTS - 1)
        + _hand_built_jpeg(480, 640, with_app0=False)[2:]
    )  # strip the leading SOI (already provided below)
    h, w = probe_jpeg(io.BytesIO(b"\xff\xd8" + body))
    assert (h, w) == (480, 640)


# --------------------------- MAX_IMAGE_DIM env override ---------------------------


def test_max_image_dim_env_override_is_honoured(monkeypatch):
    monkeypatch.setenv("MAX_IMAGE_DIM", "10")
    with pytest.raises(InvalidImageError, match="exceeds MAX_IMAGE_DIM=10"):
        probe_jpeg(io.BytesIO(_real_jpeg_bytes(height=32, width=48)))


def test_max_image_dim_env_override_allows_larger_within_bound(monkeypatch):
    monkeypatch.setenv("MAX_IMAGE_DIM", "5000")
    h, w = probe_jpeg(io.BytesIO(_hand_built_jpeg(4500, 4500)))
    assert (h, w) == (4500, 4500)


def test_explicit_max_dim_argument_overrides_env(monkeypatch):
    monkeypatch.setenv("MAX_IMAGE_DIM", "10000")
    with pytest.raises(InvalidImageError, match="exceeds MAX_IMAGE_DIM=20"):
        probe_jpeg(io.BytesIO(_real_jpeg_bytes(height=32, width=48)), max_dim=20)


def test_max_image_dim_env_non_integer_falls_back_to_default(monkeypatch):
    """Senior-review round 3 P2: this fallback branch (and the `<= 0` one
    below) had no test — a bogus `MAX_IMAGE_DIM` now silently sets both
    `probe_jpeg`'s cap AND `hole_detection.py`'s derived OpenCV ceiling to
    the 4096 default, with no error surfaced to the operator. Pin the
    fallback value explicitly so a future change to the default doesn't
    silently change this behaviour too."""
    from services.image_guard import _DEFAULT_MAX_IMAGE_DIM, max_image_dim_from_env

    monkeypatch.setenv("MAX_IMAGE_DIM", "not-a-number")
    assert max_image_dim_from_env() == _DEFAULT_MAX_IMAGE_DIM


def test_max_image_dim_env_non_positive_falls_back_to_default(monkeypatch):
    from services.image_guard import _DEFAULT_MAX_IMAGE_DIM, max_image_dim_from_env

    monkeypatch.setenv("MAX_IMAGE_DIM", "0")
    assert max_image_dim_from_env() == _DEFAULT_MAX_IMAGE_DIM

    monkeypatch.setenv("MAX_IMAGE_DIM", "-100")
    assert max_image_dim_from_env() == _DEFAULT_MAX_IMAGE_DIM
