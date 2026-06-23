"""Tests for the OpenCV hole detector (#165).

Calibrated against the repo's mock fixtures (`dev-tools/mock_fully_filled.jpg`,
`mock_not_filled.png`), which render a clean grid of nest holes — fully sealed
plugs vs empty voids respectively. The detector must:

* find every hole and crop a non-empty snip,
* call every hole "sealed" on the filled mock and "empty" on the unfilled one,
* keep the existing classification wire-shape (``{bee_type: {"1": 0|1}}``),
* and NEVER raise — a missing/corrupt image degrades to an empty result so
  ``/upload`` stays a 200 (issue #165 acceptance criterion).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from services.hole_detection import BEE_TYPES_BY_SIZE, DetectionResult, HoleDetector

_DEV_TOOLS = Path(__file__).resolve().parents[2] / "dev-tools"
MOCK_FILLED = _DEV_TOOLS / "mock_fully_filled.jpg"
MOCK_EMPTY = _DEV_TOOLS / "mock_not_filled.png"

# OpenCV is a runtime dependency of the detector; skip cleanly if it is absent
# in a given environment rather than erroring the whole module.
cv2 = pytest.importorskip("cv2")


def test_filled_mock_all_sealed():
    res = HoleDetector().detect(str(MOCK_FILLED))
    assert res.ok
    assert len(res.snips) >= 12
    states = [s.state for s in res.snips]
    assert set(states) == {"sealed"}, states
    # Every snip has real JPEG bytes and a normalized bbox in [0, 1].
    for s in res.snips:
        assert len(s.jpeg) > 0
        assert all(0.0 <= v <= 1.0 for v in s.bbox)


def test_empty_mock_all_empty():
    res = HoleDetector().detect(str(MOCK_EMPTY))
    assert res.ok
    assert len(res.snips) >= 12
    assert {s.state for s in res.snips} == {"empty"}


def test_classification_keeps_wire_shape():
    """Values become real, but the shape ``{bee_type: {nest: 0|1}}`` is the
    same contract ``add_progress_for_module`` already consumes."""
    res = HoleDetector().detect(str(MOCK_FILLED))
    assert res.classification
    for bee_type, nests in res.classification.items():
        assert bee_type in BEE_TYPES_BY_SIZE
        assert all(v in (0, 1) for v in nests.values())
        assert all(k.isdigit() for k in nests)


def test_bee_type_follows_diameter_not_position():
    """The load-bearing design claim: bee type is driven by *measured diameter*,
    not by where the row sits in the frame. Feed two rows whose vertical order
    DISAGREES with their diameter order — the physically-TOP row (small y) has
    the LARGER holes, the bottom row the smaller — and assert the small-radius
    row is labelled the smallest bee (`black_masked_bee`) regardless of being at
    the bottom. A position-driven implementation would label the top row first
    and fail this."""
    big_r, small_r = 40, 20
    top_y, bottom_y = 100, 320  # gap >> median_r*1.2 so they cluster as 2 rows
    circles = np.array(
        [(x, top_y, big_r) for x in (100, 200, 300, 400)]
        + [(x, bottom_y, small_r) for x in (100, 200, 300, 400)],
        dtype=int,
    )

    holes = HoleDetector()._assign_to_grid(circles)
    by_radius: dict[int, set[str]] = {}
    for bee_type, _nest_idx, (_x, _y, r) in holes:
        by_radius.setdefault(r, set()).add(bee_type)

    # Smallest holes -> smallest bee, even though they're the BOTTOM row.
    assert by_radius[small_r] == {"black_masked_bee"}
    # Largest of the two -> the next size up (resin), even though it's the TOP.
    assert by_radius[big_r] == {"resin_bee"}


def test_classification_keys_are_in_ascending_size_order():
    """The emitted bee-type keys are a contiguous ascending-size prefix."""
    res = HoleDetector().detect(str(MOCK_FILLED))
    present = list(res.classification.keys())
    assert present == [b for b in BEE_TYPES_BY_SIZE if b in present]
    assert present[0] == "black_masked_bee"


def test_missing_image_degrades_to_empty_result():
    res = HoleDetector().detect("/no/such/file.jpg")
    assert isinstance(res, DetectionResult)
    assert not res.ok
    assert res.snips == []


def test_corrupt_image_degrades_without_raising(tmp_path: Path):
    bad = tmp_path / "corrupt.jpg"
    bad.write_bytes(b"not a real jpeg")
    res = HoleDetector().detect(str(bad))
    assert not res.ok
    assert res.snips == []


# Real ESP captures (low-res, blurry, low-contrast) — the regression that pins
# the silent-fabrication fix. With the mock-tuned strict Hough params these find
# too few circles, so the detector MUST degrade to no-detection rather than
# fabricate a full grid of wood-sampled "sealed" snips (the bug these fixtures
# exposed). When the detector is recalibrated for real captures (follow-up),
# this asserts the safety floor: it must never confidently emit a full 16-hole
# all-"sealed" result on input it cannot actually read.
_REAL = _DEV_TOOLS / "real_captures"
_REAL_CAPTURES = [
    _REAL / "block_warm_1024.jpg",
    _REAL / "block_tungsten_640.jpg",
    _REAL / "block_daylight_640.jpg",
]


@pytest.mark.parametrize("path", _REAL_CAPTURES, ids=lambda p: p.name)
def test_real_capture_never_fabricates_a_full_sealed_grid(path: Path):
    if not path.exists():  # fixtures are committed, but stay defensive
        pytest.skip(f"missing fixture {path}")
    res = HoleDetector().detect(str(path))
    # The bug: 16 fabricated snips, all "sealed", over plain wood. Forbid it.
    fabricated_full_sealed = len(res.snips) >= 16 and all(
        s.state == "sealed" for s in res.snips
    )
    assert not fabricated_full_sealed, (
        f"{path.name}: detector fabricated a full all-sealed grid "
        f"({len(res.snips)} snips) on an unreadable real capture"
    )
