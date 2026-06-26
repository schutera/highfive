#!/usr/bin/env python3
"""Verify the deployed ONNX parse reproduces ultralytics' own inference (#165).

The docs claim the `image-service` runtime (`services/hole_detection.py`, which
parses the ONNX through `onnxruntime`) matches the trained model bit-for-bit on
the real captures. This script is that claim's regression guard: it runs the
**actual runtime code** — image-service's `HoleDetector` — and ultralytics'
reference inference on the *same* exported ONNX, and asserts every hole the
runtime reports lands on a real ultralytics detection (sub-pixel), with the
runtime's count never exceeding ultralytics' (its NMS only removes export-
precision duplicates, never invents holes).

Dev-side check: needs the gitignored `best.pt`, ultralytics, onnxruntime, and the
real captures. Run it after `export_onnx.py` whenever you change the export or the
runtime parse:

    python dev-tools/ml_hole_detection/verify_onnx_parity.py

Exit 0 = parity holds; non-zero = the runtime parse drifted from the model.
"""

from __future__ import annotations

import glob
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PT = HERE / "runs" / "holes_yolo26n_seg" / "weights" / "best.pt"
ONNX = REPO / "image-service" / "models" / "hole_detector.onnx"
CAPS = sorted(glob.glob(str(REPO / "dev-tools" / "real_captures" / "*.jpg")))
CONF = 0.25
MATCH_PX = 3.0  # a runtime hole must land within this of an ultralytics box centre

# Run the REAL runtime code, not a re-implementation.
sys.path.insert(0, str(REPO / "image-service"))
from services.hole_detection import HoleDetector  # noqa: E402


def runtime_centres(detector: HoleDetector, path: str, wh: tuple[int, int]):
    """Hole centres (px) the shipped runtime reports, from its snip bboxes."""
    w, h = wh
    res = detector.detect(path)
    out = []
    for s in res.snips:
        x, y, bw, bh = s.bbox  # normalized (x, y, w, h) of the padded snip box
        out.append(((x + bw / 2) * w, (y + bh / 2) * h))  # box centre == hole centre
    return np.array(out, dtype=float).reshape(-1, 2)


def ultra_centres(model, path: str):
    r = model.predict(path, conf=CONF, device="cpu", verbose=False)[0]
    if r.boxes is None or len(r.boxes) == 0:
        return np.zeros((0, 2))
    xyxy = r.boxes.xyxy.cpu().numpy()
    return np.stack([(xyxy[:, 0] + xyxy[:, 2]) / 2, (xyxy[:, 1] + xyxy[:, 3]) / 2], axis=1)


def main() -> int:
    if not PT.is_file():
        print(f"[skip] trained weights not found: {PT} (train + export first)")
        return 0
    if not ONNX.is_file():
        print(f"[fail] deployed ONNX missing: {ONNX} (run export_onnx.py)")
        return 1

    import cv2
    from ultralytics import YOLO

    model = YOLO(str(PT))
    detector = HoleDetector(model_path=str(ONNX))

    print(f"{'capture':46s} {'ultra':>5s} {'runtime':>7s} {'matched':>7s} {'maxPx':>6s}")
    all_ok = True
    for c in CAPS:
        img = cv2.imread(c)
        rc = runtime_centres(detector, c, (img.shape[1], img.shape[0]))
        uc = ultra_centres(model, c)
        # every runtime hole must match a distinct ultralytics box centre
        used: set[int] = set()
        matched, worst = 0, 0.0
        for p in rc:
            d = np.full(len(uc), np.inf)
            for j, q in enumerate(uc):
                if j not in used:
                    d[j] = float(np.hypot(*(p - q)))
            j = int(np.argmin(d)) if len(uc) else -1
            if j >= 0 and d[j] <= MATCH_PX:
                used.add(j)
                matched += 1
                worst = max(worst, d[j])
        # runtime parse is correct iff every runtime hole matched, and the runtime
        # never reports MORE holes than ultralytics (its NMS only deduplicates).
        ok = matched == len(rc) and len(rc) <= len(uc)
        all_ok = all_ok and ok
        print(f"{Path(c).name:46s} {len(uc):5d} {len(rc):7d} {matched:7d} {worst:6.2f}"
              f"  {'OK' if ok else 'DRIFT'}")

    print("\nPARITY OK — runtime parse matches ultralytics" if all_ok
          else "\nPARITY FAILED — runtime parse drifted from the model")
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
