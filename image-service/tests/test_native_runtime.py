"""Non-skipping guard that the native detection stack imports on every CI cell.

The other hole-detection tests `pytest.importorskip("onnxruntime")` /
`("cv2")` (see `test_hole_detection.py`), and `hole_detection.py` swallows a
failed native import into `_RUNTIME_AVAILABLE = False` so the upload path
degrades instead of 500-ing. Both are correct for production resilience — but
together they mean a *broken* native-dep resolution would make every
detection test **skip**, and the lane would still go green.

That is exactly the failure the Python-version matrix (ADR-028) exists to
catch: `numpy` and `onnxruntime` are floated to `>=` lower bounds so each
matrix cell (3.10 … 3.14) resolves its own wheel, and the whole point is to
prove that resolved wheel actually *imports and runs* on that interpreter. A
test that self-skips when the import fails proves nothing.

This test never skips. If the floated stack fails to import on any cell,
`_RUNTIME_AVAILABLE` is False and this assertion turns the cell red — not
yellow. The model-inference assertions in `test_hole_detection.py` then cover
the "imports but is subtly broken at runtime" case, since they no longer skip
once the import succeeds.
"""

from __future__ import annotations

from services.hole_detection import _RUNTIME_AVAILABLE


def test_native_runtime_available() -> None:
    assert _RUNTIME_AVAILABLE is True, (
        "onnxruntime / OpenCV / numpy failed to import — the floated native-dep "
        "resolution (numpy>=2.0.0, onnxruntime>=1.23.2; see "
        "image-service/requirements.txt and ADR-028) produced an install that "
        "does not import on this Python version. This is the regression the "
        "3.10–3.14 CI matrix exists to catch."
    )
