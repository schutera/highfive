#!/usr/bin/env python3
"""Export the trained YOLO26n-seg weights to the ONNX the image-service runs (#165).

The training stack (ultralytics + torch) is **dev-only**; production inference
runs the exported ``.onnx`` through the lean ``onnxruntime`` (see ADR-027). This
script is the bridge: it converts ``best.pt`` to an end2end ONNX graph and copies
it to ``image-service/models/hole_detector.onnx``, the path the service loads.

YOLO26 is NMS-free, so the exported graph already emits the top-300 deduped
detections as ``output0`` of shape ``[1, 300, 4+1+1+32]`` =
``[x1, y1, x2, y2, conf, cls, *mask_coeffs]`` in letterboxed-640 pixels — no NMS
node, no dense-anchor decode needed at runtime. This end2end head is a **YOLO26**
property, NOT a generic seg-export one: a non-end2end model (e.g. the
``train.py --model yolo11n-seg.pt`` fallback) would emit the dense
``[1, 37, 8400]`` head the runtime parser can't read — so this script asserts
``output0 == [1, 300, 38]`` after export and aborts on mismatch. ``image-service``
reads only the box columns (it crops rectangular snips), parses them in ~50 ms on
CPU, and applies one conservative NMS pass (IoU 0.7) to drop export-precision
duplicate boxes. The runtime parse is verified bit-for-bit against ultralytics'
own inference on the real captures by the committed ``verify_onnx_parity.py``.

Usage (from the repo root, in the training venv — see requirements.txt):

    python dev-tools/ml_hole_detection/export_onnx.py
    python dev-tools/ml_hole_detection/export_onnx.py --weights runs/<name>/weights/best.pt

Run this after every retraining that you intend to ship, then rebuild the
image-service image so the new ``hole_detector.onnx`` is baked in.
"""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_WEIGHTS = HERE / "runs" / "holes_yolo26n_seg" / "weights" / "best.pt"
SERVICE_MODEL = REPO / "image-service" / "models" / "hole_detector.onnx"
IMGSZ = 640
OPSET = 19  # 12 works but warns on aten::index advanced-indexing; 19 is clean


def main() -> int:
    ap = argparse.ArgumentParser(description="Export YOLO26n-seg best.pt to the service ONNX")
    ap.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS, help="trained .pt weights")
    ap.add_argument("--out", type=Path, default=SERVICE_MODEL, help="destination .onnx in image-service")
    ap.add_argument("--imgsz", type=int, default=IMGSZ)
    ap.add_argument("--opset", type=int, default=OPSET)
    args = ap.parse_args()

    if not args.weights.is_file():
        raise SystemExit(
            f"weights not found: {args.weights}\n"
            "Train first:  python dev-tools/ml_hole_detection/train.py"
        )

    try:
        from ultralytics import YOLO
    except ImportError:
        raise SystemExit(
            "ultralytics is not installed. In the training venv:  "
            "pip install -r dev-tools/ml_hole_detection/requirements.txt"
        )

    model = YOLO(str(args.weights))
    print(f"exporting {args.weights}  (task={model.task}, names={model.names})")
    onnx_path = Path(
        model.export(format="onnx", imgsz=args.imgsz, opset=args.opset,
                     simplify=True, dynamic=False)
    )

    # Contract guard: image-service/services/hole_detection.py parses the YOLO26
    # NMS-free *end2end* head — output0 = [1, 300, 4+1+1+32] = [1, 300, 38]. That
    # shape IS the runtime contract; YOLO26 exports it by default (no `nms=` flag
    # needed). A non-end2end model — e.g. train.py's `--model yolo11n-seg.pt`
    # fallback — would instead emit the dense [1, 37, 8400] head, which the
    # runtime parser silently misreads. Fail loudly here rather than overwrite the
    # deployed model with one the service can't run.
    import onnxruntime as ort

    out0 = (
        ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        .get_outputs()[0]
        .shape
    )
    if list(out0) != [1, 300, 38]:
        raise SystemExit(
            f"export produced output0={list(out0)}, expected [1, 300, 38] (YOLO26 "
            "end2end head). image-service's onnxruntime parser only supports that "
            "shape — a yolo11n-seg / non-end2end model is not runtime-compatible. "
            "Aborting before overwriting the deployed model at "
            f"{args.out}."
        )
    print(f"verified end2end head: output0={list(out0)}")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(onnx_path, args.out)
    size_mb = args.out.stat().st_size / 1e6
    print(f"\nexported   : {onnx_path}")
    print(f"deployed -> : {args.out}  ({size_mb:.1f} MB)")
    print("Rebuild the image-service image to bake in the new model:")
    print("  docker compose up -d --build image-service")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
