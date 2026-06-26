"""Tests for the learned YOLO26n-seg hole detector (#165, ADR-027).

Exercises the real ONNX model (committed at ``image-service/models/``) on the
committed real ESP captures (``dev-tools/real_captures/``). The detector must:

* locate every hole on a real capture and crop a non-empty snip for each,
* label bee type by *measured diameter* (orientation-robust) and index nests
  left-to-right, with **no fixed 4-per-row cap** (real blocks are 7/5/5/4 = 21
  holes or 4x4 = 16),
* mark each snip ``state="undetermined"`` and leave ``classification`` empty —
  the model localizes; empty/sealed is deferred (so the pipeline keeps the stub
  for the progress bars while the snips are real),
* and NEVER raise — a missing/corrupt image or model degrades to an empty
  result so ``/upload`` stays a 200 (issue #165 acceptance criterion).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.hole_detection import (
    BEE_TYPES_BY_SIZE,
    STATE_UNDETERMINED,
    DetectionResult,
    HoleDetector,
)

# The detector's native deps (onnxruntime + OpenCV + numpy) are runtime deps;
# skip cleanly if absent rather than erroring the whole module.
pytest.importorskip("onnxruntime")
pytest.importorskip("cv2")
import numpy as np  # noqa: E402  (after importorskip, like the contract above)

_REPO = Path(__file__).resolve().parents[2]
_REAL = _REPO / "dev-tools" / "real_captures"
_MODEL = _REPO / "image-service" / "models" / "hole_detector.onnx"

# The model is committed; skip (don't error) if a checkout somehow lacks it.
pytestmark = pytest.mark.skipif(
    not _MODEL.is_file(), reason=f"model artifact missing: {_MODEL}"
)

# Two committed captures covering both real geometries and lighting extremes:
#   tungsten 640 -> the irregular 7/5/5/4 block (21 holes)
#   warm 1024    -> the 4x4 block (16 holes), mounted large-holes-on-top
BLOCK_7554 = _REAL / "block_tungsten_640.jpg"
BLOCK_4X4 = _REAL / "block_warm_1024.jpg"


def _snips_by_type(res: DetectionResult) -> dict[str, list]:
    out: dict[str, list] = {}
    for s in res.snips:
        out.setdefault(s.bee_type, []).append(s)
    return out


@pytest.mark.parametrize(
    "path,lo,hi",
    [
        # Deterministic model, but allow +-2 for onnxruntime/platform FP jitter.
        # The floor is the load-bearing assertion: recall, not fabrication.
        pytest.param(BLOCK_7554, 19, 23, id="block_7554_21holes"),
        pytest.param(BLOCK_4X4, 14, 18, id="block_4x4_16holes"),
    ],
)
def test_model_locates_all_holes(path: Path, lo: int, hi: int):
    if not path.exists():  # committed, but stay defensive
        pytest.skip(f"missing fixture {path}")
    res = HoleDetector().detect(str(path))

    # Found roughly the right number of holes, every one a real crop in-frame.
    assert lo <= len(res.snips) <= hi, f"{path.name}: {len(res.snips)} snips"
    for s in res.snips:
        assert len(s.jpeg) > 0
        assert all(0.0 <= v <= 1.0 for v in s.bbox)


def test_localize_only_state_and_classification():
    """The model localizes: every snip is ``undetermined`` and the aggregate
    classification is empty (so ``ok`` is False and the pipeline keeps the stub
    for the progress bars while the snips become real)."""
    res = HoleDetector().detect(str(BLOCK_7554))
    assert res.snips
    assert {s.state for s in res.snips} == {STATE_UNDETERMINED}
    assert res.classification == {}
    assert res.ok is False


def test_species_are_ascending_size_prefix_with_contiguous_nests():
    """Bee-type keys are a contiguous ascending-size prefix, and within each type
    the nest indices are 1..N with no gaps (left-to-right, no per-row cap)."""
    res = HoleDetector().detect(str(BLOCK_7554))
    by_type = _snips_by_type(res)

    present = [b for b in BEE_TYPES_BY_SIZE if b in by_type]
    # contiguous-ascending-size prefix (no skipped species in the middle)
    assert present == list(BEE_TYPES_BY_SIZE[: len(present)])
    assert present[0] == "black_masked_bee"

    for snips in by_type.values():
        idx = sorted(s.nest_index for s in snips)
        assert idx == list(range(1, len(idx) + 1)), idx


def test_bee_type_ordering_follows_measured_diameter():
    """Mean snip box area increases with bee-type size — proof the labelling is
    diameter-driven (the larger species' crops are larger), not position-driven."""
    res = HoleDetector().detect(str(BLOCK_7554))
    by_type = _snips_by_type(res)
    areas = []
    for b in BEE_TYPES_BY_SIZE:
        if b in by_type:
            areas.append(float(np.mean([s.bbox[2] * s.bbox[3] for s in by_type[b]])))
    assert areas == sorted(areas), f"box areas not ascending by species: {areas}"


def test_assign_to_grid_labels_by_diameter_not_position():
    """Unit test of the assignment logic (no model): feed two rows whose vertical
    order DISAGREES with their diameter order — the physically-TOP row has the
    LARGER holes — and assert the small-radius row is the smallest bee regardless
    of sitting at the bottom. A position-driven impl would fail this."""
    big_r, small_r = 40, 20
    top_y, bottom_y = 100, 320  # gap >> median_r*1.2 so they cluster as 2 rows
    dets = np.array(
        [(x, top_y, big_r, 0.9) for x in (100, 200, 300, 400)]
        + [(x, bottom_y, small_r, 0.9) for x in (100, 200, 300, 400)],
        dtype=float,
    )

    holes = HoleDetector()._assign_to_grid(dets)
    by_radius: dict[int, set[str]] = {}
    for bee_type, _nest_idx, (_x, _y, r), _conf in holes:
        by_radius.setdefault(r, set()).add(bee_type)

    # Smallest holes -> smallest bee, even though they're the BOTTOM row.
    assert by_radius[small_r] == {"black_masked_bee"}
    # Larger of the two -> the next size up (resin), even though it's the TOP.
    assert by_radius[big_r] == {"resin_bee"}


def test_assign_to_grid_keeps_all_holes_in_an_irregular_row():
    """A 7-hole row must keep all 7 nests (the old detector capped rows at 4 and
    silently dropped 3 holes of the real 7/5/5/4 block)."""
    dets = np.array([(x * 30, 100, 10, 0.9) for x in range(1, 8)], dtype=float)
    holes = HoleDetector()._assign_to_grid(dets)
    assert len(holes) == 7
    assert sorted(n for _b, n, _xyz, _c in holes) == [1, 2, 3, 4, 5, 6, 7]


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


def test_missing_model_degrades_without_raising():
    """A misconfigured HOLE_MODEL_PATH degrades to no-detection, never a 500."""
    det = HoleDetector(model_path=str(_REAL / "does-not-exist.onnx"))
    res = det.detect(str(BLOCK_7554))
    assert not res.ok
    assert res.snips == []
