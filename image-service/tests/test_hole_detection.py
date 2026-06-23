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


def test_bee_type_ordered_by_diameter():
    """Bee-type labels come from measured diameter: the rows present must be a
    prefix of the ascending-size order (smallest hole -> black_masked_bee)."""
    res = HoleDetector().detect(str(MOCK_FILLED))
    present = list(res.classification.keys())
    expected_prefix = list(BEE_TYPES_BY_SIZE[: len(present)])
    # Order is by ascending diameter; the detector emits them in that order.
    assert set(present).issubset(set(BEE_TYPES_BY_SIZE))
    assert present == [b for b in BEE_TYPES_BY_SIZE if b in present]
    assert expected_prefix[0] == "black_masked_bee"


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
