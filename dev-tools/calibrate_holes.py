#!/usr/bin/env python3
"""Calibration + evaluation harness for the hole detector (#165).

Runs ``HoleDetector`` over every labelled real capture in
``dev-tools/real_captures/`` and reports how well detection matches ground
truth, so recalibration is *measured* rather than eyeballed. This is the turnkey
loop for the "use real captures, not mocks" route: drop a capture + a
``<image>.labels.json`` next to it (see ``*.labels.example.json``), tune the
detector, re-run this, watch the numbers move.

Usage (from the repo root, with opencv-python-headless + numpy installed):

    python dev-tools/calibrate_holes.py
    python dev-tools/calibrate_holes.py --overlay   # also write *_overlay.png

What it reports per image:
  * whether HoughCircles cleared the quorum (i.e. detection even fired),
  * raw circle count and the number of holes the grid step kept,
  * predicted-sealed vs labelled-sealed counts (aggregate accuracy),
  * with --overlay, an image with detected circles + state drawn on top, so a
    human can see *where* detection landed vs the real holes.

Per-cell (row,col) accuracy is intentionally NOT computed yet: on the current
real captures detection doesn't reliably produce a full 4x4, so a positional
match would be noise. Aggregate counts + the overlay are the honest signals
until detection is robust enough for a per-cell grid; extend then.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "image-service"))

try:
    import cv2
except Exception:  # pragma: no cover
    print("opencv-python-headless is required: pip install opencv-python-headless numpy")
    raise

from services.hole_detection import HoleDetector  # noqa: E402

CAPTURES_DIR = Path(__file__).resolve().parent / "real_captures"


def _load_labels(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"  ! could not read {path.name}: {exc}")
        return None
    return data


def _overlay(image_path: Path, detector: HoleDetector) -> None:
    """Write <stem>_overlay.png with the detector's raw circles drawn on."""
    bgr = cv2.imread(str(image_path))
    if bgr is None:
        return
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    circles = detector._find_circles(gray, gray.shape[1])
    if circles is not None:
        for x, y, r in circles:
            cv2.circle(bgr, (int(x), int(y)), int(r), (0, 0, 255), 2)
    out = image_path.with_name(f"{image_path.stem}_overlay.png")
    cv2.imwrite(str(out), bgr)
    print(f"  overlay -> {out.name} ({0 if circles is None else len(circles)} circles)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Hole-detector calibration harness")
    parser.add_argument(
        "--overlay", action="store_true", help="write <image>_overlay.png per capture"
    )
    args = parser.parse_args()

    detector = HoleDetector()
    label_files = sorted(CAPTURES_DIR.glob("*.labels.json"))
    if not label_files:
        print(
            "No '*.labels.json' files in dev-tools/real_captures/.\n"
            "Copy a '*.labels.example.json' to '<image>.labels.json' and fill it in."
        )
        return 0

    total_imgs = correct_aggregate = 0
    for lf in label_files:
        labels = _load_labels(lf)
        if labels is None:
            continue
        image_path = CAPTURES_DIR / labels.get("image", lf.name.replace(".labels.json", ""))
        if not image_path.exists():
            print(f"  ! image missing for {lf.name}: {image_path.name}")
            continue

        sealed_truth = labels.get("sealed", [])
        res = detector.detect(str(image_path))
        pred_sealed = sum(1 for s in res.snips if s.state == "sealed")

        total_imgs += 1
        match = "—"
        if res.ok:
            ok_count = pred_sealed == len(sealed_truth)
            correct_aggregate += int(ok_count)
            match = "OK " if ok_count else "MISS"
        print(
            f"{image_path.name:26} fired={res.ok!s:5} holes={len(res.snips):2} "
            f"pred_sealed={pred_sealed:2} truth_sealed={len(sealed_truth):2} [{match}]"
        )
        if args.overlay:
            _overlay(image_path, detector)

    print(
        f"\n{total_imgs} labelled capture(s); "
        f"aggregate-sealed-count correct on {correct_aggregate}/{total_imgs} "
        f"that produced a detection."
    )
    print(
        "Goal: every capture fires (detection clears the quorum) AND "
        "pred_sealed == truth_sealed. Use --overlay to see where circles land."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
