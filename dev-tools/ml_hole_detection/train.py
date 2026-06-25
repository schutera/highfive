#!/usr/bin/env python3
"""Train the YOLO26 nest-hole segmenter on the labelled capture set (#165).

Trains a single-class (`hole`) **instance-segmentation** model from the dataset
built by ``prepare_dataset.py`` (hand-cleaned COCO → YOLO-seg polygons). Mixed
block geometries (21-hole and 16-hole blocks) train one general "hole" segmenter.

Augmentation (the requested set) is on by default and label-safe because the
class is geometry-independent:
  * geometric — rotation (--degrees), zoom (--scale), translation, shear,
    perspective, horizontal + vertical flip (the block mounts either way).
  * photometric — brightness (--hsv_v), colour temperature (--hsv_h = hue),
    saturation (--hsv_s), plus mosaic.
  * contrast — Ultralytics auto-applies an albumentations pipeline (CLAHE /
    brightness-contrast / blur) when ``albumentations`` is installed, so
    ``pip install albumentations`` enables it; the captures also already span
    warm/tungsten/daylight/dark, i.e. real contrast variety is in the data.

Train/val split is the deterministic ~80/20 baked into the dataset by the
builder (reproducible by filename CRC). Per-epoch **train and val losses**
(seg/box/cls) are logged to ``runs/<name>/results.csv`` and plotted in
``results.png`` — validation runs every epoch.

Requirements (NOT in the repo's services — run in a PyTorch env, e.g. your
annotator's venv). YOLO26 needs a recent Ultralytics (the annotator pins
8.3.27 = YOLO11-era); deps are pinned in this folder's requirements.txt:

    pip install -r dev-tools/ml_hole_detection/requirements.txt

Usage (from the repo root):

    python dev-tools/ml_hole_detection/train.py                        # YOLO26n-seg, auto GPU/CPU
    python dev-tools/ml_hole_detection/train.py --epochs 200 --device 0
    python dev-tools/ml_hole_detection/train.py --model yolo11n-seg.pt # no-upgrade fallback

Output: ``runs/<name>/weights/best.pt`` (drops in behind ``image-service``'s
``HoleDetector().detect()`` seam) + per-epoch losses + final val metrics.
"""

from __future__ import annotations

import argparse
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE / "dataset" / "holes_seg" / "data.yaml"


def main() -> int:
    ap = argparse.ArgumentParser(description="Train the YOLO26 nest-hole segmenter")
    ap.add_argument("--data", type=Path, default=DEFAULT_DATA, help="dataset data.yaml")
    ap.add_argument(
        "--model", default="yolo26n-seg.pt",
        help="pretrained weights (yolo26n-seg = latest segment nano; yolo11n-seg = no-upgrade fallback)",
    )
    ap.add_argument("--epochs", type=int, default=300, help="max epochs (early-stop usually hits first)")
    ap.add_argument(
        "--patience", type=int, default=40,
        help="early-stop: stop after this many epochs with no val improvement",
    )
    ap.add_argument("--imgsz", type=int, default=640, help="native capture size is 640x480")
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument(
        "--device", default=None,
        help="'cpu', a CUDA index like '0', or omit to auto-select GPU-if-present",
    )
    ap.add_argument("--project", default=str(HERE / "runs"))
    ap.add_argument("--name", default="holes_yolo26n_seg")
    # --- Augmentation (requested: flip / rotate / zoom / brightness / contrast / colour temp) ---
    # Single class "hole", so every geometric transform is label-safe (no orientation-
    # dependent class to break). Tuned for the real captures: mild perspective tilt, both
    # block mount orientations, and the warm/tungsten/daylight/dark lighting spread.
    ap.add_argument("--degrees", type=float, default=15.0, help="rotation: max degrees")
    ap.add_argument("--scale", type=float, default=0.5, help="zoom: +/- gain fraction")
    ap.add_argument("--translate", type=float, default=0.1, help="max translation fraction")
    ap.add_argument("--shear", type=float, default=5.0, help="shear degrees")
    ap.add_argument("--perspective", type=float, default=0.0005, help="perspective distortion")
    ap.add_argument("--fliplr", type=float, default=0.5, help="horizontal flip prob")
    ap.add_argument("--flipud", type=float, default=0.5, help="vertical flip prob (block mounts either way)")
    ap.add_argument("--hsv_h", type=float, default=0.03, help="hue jitter ~ colour temperature")
    ap.add_argument("--hsv_s", type=float, default=0.6, help="saturation jitter")
    ap.add_argument("--hsv_v", type=float, default=0.4, help="value/brightness jitter")
    ap.add_argument("--mosaic", type=float, default=1.0, help="mosaic prob (helps small datasets)")
    args = ap.parse_args()

    if not args.data.is_file():
        raise SystemExit(
            f"data.yaml not found: {args.data}\n"
            "Build it first:\n"
            "  python dev-tools/ml_hole_detection/prepare_dataset.py --coco <export>/annotations.json"
        )

    try:
        from ultralytics import YOLO
    except ImportError:
        raise SystemExit(
            "ultralytics is not installed. In a PyTorch env:  "
            "pip install -r dev-tools/ml_hole_detection/requirements.txt"
        )

    try:
        model = YOLO(args.model)
    except Exception as exc:  # old ultralytics won't know yolo26* -> hint the upgrade
        raise SystemExit(
            f"Could not load model '{args.model}': {exc!r}\n"
            "YOLO26 needs a recent Ultralytics: pip install -U ultralytics "
            "(or pass --model yolo11n-seg.pt to stay on the older release)."
        )

    model.train(
        data=str(args.data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        device=args.device,
        project=args.project,
        name=args.name,
        patience=args.patience,
        # Validation each epoch + curves. Ultralytics logs per-epoch train AND val
        # losses (seg/box/cls) to results.csv and plots them in results.png.
        val=True,
        plots=True,
        # Augmentation
        degrees=args.degrees,
        scale=args.scale,
        translate=args.translate,
        shear=args.shear,
        perspective=args.perspective,
        fliplr=args.fliplr,
        flipud=args.flipud,
        hsv_h=args.hsv_h,
        hsv_s=args.hsv_s,
        hsv_v=args.hsv_v,
        mosaic=args.mosaic,
    )
    # Training already validates every epoch (val=True) and saves best.pt at the
    # peak — no extra model.val() (it would re-run on the global Ultralytics
    # runs_dir, which the annotator install points elsewhere).
    out = Path(args.project) / args.name
    print(f"\ntraining done. per-epoch train/val losses: {out / 'results.csv'}")
    print(f"curves: {out / 'results.png'}  |  best weights: {out / 'weights' / 'best.pt'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
