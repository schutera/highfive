#!/usr/bin/env python3
"""Convert the annotator's COCO export into a YOLO dataset for training (#165).

Step 1 of the training pipeline (step 2 is ``train.py`` — see the README).

The `digitalsreeni-image-annotator` exports a single-class (`hole`) COCO JSON
(absolute bboxes + SAM polygons). Ultralytics can't train on COCO directly — it
needs per-image YOLO ``.txt`` labels + a ``data.yaml`` + an
``images|labels/{train,val}`` layout. Producing that is the ONLY transform here:

    COCO polygons  ->  normalized YOLO labels  +  deterministic 80/20 split

**No content is changed** — every labelled hole is carried through 1:1. There is
no ROI / fixture filtering: hand-clean the labels in the annotator before
exporting (the model then learns to ignore the wing/fixture holes on its own).

Label type:
  --task seg  (default): polygon labels ``0 x1 y1 … xN yN`` from the SAM masks
                         (instance segmentation — mask-tight snips).
  --task detect:         bbox labels ``0 cx cy w h``.

Usage (from the repo root):

    python dev-tools/ml_hole_detection/prepare_dataset.py --coco <export>/annotations.json
    python dev-tools/ml_hole_detection/prepare_dataset.py --coco ... --out dataset/holes_seg --task seg
    python dev-tools/ml_hole_detection/prepare_dataset.py --coco ... --overlay overlays   # QA: draw every label on its image

Images are resolved by ``file_name`` next to the COCO json (recursively) or under
``--captures``. The train/val split is a deterministic ~20% by filename CRC, so
re-running on the same export always lands the same way.
"""

from __future__ import annotations

import argparse
import json
import shutil
import zlib
from pathlib import Path

try:
    import cv2
    import numpy as np
except Exception:  # pragma: no cover - environment hint
    print("This tool needs opencv-python-headless + numpy: pip install -r requirements.txt")
    raise

HERE = Path(__file__).resolve().parent
DEFAULT_OUT = HERE / "dataset" / "holes_seg"
DEFAULT_CAPTURES = HERE.parent / "real_captures"
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff")

_BOX_COLOR = (0, 200, 0)
_POLY_COLOR = (0, 165, 255)
_TEXT_COLOR = (0, 0, 255)


def _clamp01(v: float) -> float:
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def _poly_px(seg, w: int, h: int):
    """COCO polygon (flat [x1,y1,…] absolute) -> (N,2) float32 pixel array, or None."""
    if isinstance(seg, list) and seg and isinstance(seg[0], list) and len(seg[0]) >= 6:
        return np.array(seg[0], dtype=np.float32).reshape(-1, 2)
    return None


def _find_image(stem: str, search_dirs: list[Path]) -> Path | None:
    for d in search_dirs:
        if not d.is_dir():
            continue
        for ext in IMAGE_EXTS:
            direct = d / f"{stem}{ext}"
            if direct.is_file():
                return direct
        for ext in IMAGE_EXTS:
            hit = next(iter(d.rglob(f"{stem}{ext}")), None)
            if hit is not None:
                return hit
    return None


class DatasetWriter:
    """Writes a YOLO v5+ dataset (detect or segment) with a deterministic split.

    Copies each image into ``images/<split>/`` and writes
    ``labels/<split>/<stem>.txt`` (one line per hole). ``data.yaml`` is written on
    ``finalize()`` so the folder feeds ``YOLO.train(data=…)`` directly. Split =
    CRC of the filename (~20% val) so the same export reproduces the same split.
    """

    def __init__(self, root: Path, task: str):
        self.root = root
        self.task = task
        self.n_img = self.n_val = self.n_lbl = 0

    def _label_line(self, inst: dict, w: int, h: int) -> str:
        if self.task == "seg":
            poly = inst.get("poly")
            if poly is None or len(poly) < 3:
                x, y, bw, bh = inst["bbox"]  # fallback: bbox as a 4-point polygon
                poly = [(x, y), (x + bw, y), (x + bw, y + bh), (x, y + bh)]
            coords = " ".join(
                f"{_clamp01(px / w):.6f} {_clamp01(py / h):.6f}" for px, py in poly
            )
            return f"0 {coords}"
        x, y, bw, bh = inst["bbox"]
        return (
            f"0 {_clamp01((x + bw / 2) / w):.6f} {_clamp01((y + bh / 2) / h):.6f} "
            f"{_clamp01(bw / w):.6f} {_clamp01(bh / h):.6f}"
        )

    def add(self, img_path: Path, instances: list[dict], w: int, h: int) -> None:
        split = "val" if zlib.crc32(img_path.name.encode()) % 5 == 0 else "train"
        img_out = self.root / "images" / split / img_path.name
        lbl_out = self.root / "labels" / split / f"{img_path.stem}.txt"
        img_out.parent.mkdir(parents=True, exist_ok=True)
        lbl_out.parent.mkdir(parents=True, exist_ok=True)
        if not img_out.exists():
            shutil.copy2(img_path, img_out)
        lines = [self._label_line(inst, w, h) for inst in instances]
        lbl_out.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")
        self.n_img += 1
        self.n_lbl += len(lines)
        self.n_val += split == "val"

    def add_raw(self, img_path: Path, label_text: str) -> None:
        """Copy an image + its already-YOLO-format label verbatim into the split.

        Used when re-splitting an annotator YOLO export (which dumps everything
        into ``train`` with an empty ``val`` — Ultralytics rejects that). The
        labels are already normalized YOLO, so nothing is re-derived."""
        split = "val" if zlib.crc32(img_path.name.encode()) % 5 == 0 else "train"
        img_out = self.root / "images" / split / img_path.name
        lbl_out = self.root / "labels" / split / f"{img_path.stem}.txt"
        img_out.parent.mkdir(parents=True, exist_ok=True)
        lbl_out.parent.mkdir(parents=True, exist_ok=True)
        if not img_out.exists():
            shutil.copy2(img_path, img_out)
        lbl_out.write_text(label_text, encoding="utf-8")
        self.n_img += 1
        self.n_lbl += sum(1 for ln in label_text.splitlines() if ln.strip())
        self.n_val += split == "val"

    def finalize(self) -> None:
        (self.root / "data.yaml").write_text(
            f"path: {self.root.resolve().as_posix()}\n"
            "train: images/train\nval: images/val\nnc: 1\nnames: [hole]\n",
            encoding="utf-8",
        )
        print(
            f"\nYOLO dataset -> {self.root}\n"
            f"  {self.n_img} images ({self.n_val} val), {self.n_lbl} hole labels, "
            f"data.yaml written ({self.task})"
        )


def _overlay(img_path: Path, instances: list[dict], out_dir: Path) -> None:
    img = cv2.imread(str(img_path))
    if img is None:
        return
    for i, inst in enumerate(instances, start=1):
        poly = inst.get("poly")
        if poly is not None and len(poly) >= 3:
            cv2.polylines(img, [poly.astype(np.int32)], True, _POLY_COLOR, 2)
        x, y, bw, bh = inst["bbox"]
        cv2.rectangle(img, (int(x), int(y)), (int(x + bw), int(y + bh)), _BOX_COLOR, 2)
        cv2.putText(img, str(i), (int(x), max(0, int(y) - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, _TEXT_COLOR, 1, cv2.LINE_AA)
    out_dir.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_dir / f"{img_path.stem}_overlay.png"), img)


def _run_coco(coco_path: Path, captures: Path, writer: DatasetWriter, overlay_dir) -> list[tuple[str, int]]:
    data = json.loads(coco_path.read_text(encoding="utf-8"))
    images = {im["id"]: im for im in data.get("images", [])}
    anns_by_image: dict[int, list[dict]] = {}
    for ann in data.get("annotations", []):
        anns_by_image.setdefault(ann["image_id"], []).append(ann)
    search_dirs = [coco_path.parent, captures]
    rows: list[tuple[str, int]] = []
    missing = 0
    for img_id, meta in images.items():
        name = Path(meta.get("file_name", "")).name
        img_path = _find_image(Path(name).stem, search_dirs)
        if img_path is None:
            print(f"  ! image file not found for '{name}' — skipped")
            missing += 1
            continue
        w, h = int(meta["width"]), int(meta["height"])
        instances = []
        for ann in anns_by_image.get(img_id, []):
            bbox = ann.get("bbox")
            if not (isinstance(bbox, (list, tuple)) and len(bbox) == 4):
                continue
            instances.append({"bbox": tuple(float(v) for v in bbox), "poly": _poly_px(ann.get("segmentation"), w, h)})
        writer.add(img_path, instances, w, h)
        if overlay_dir is not None:
            _overlay(img_path, instances, overlay_dir)
        rows.append((img_path.name, len(instances)))
    if missing:
        print(f"[!] {missing} COCO image(s) had no matching file and were skipped")
    return rows


def _run_yolo(yolo_dir: Path, writer: DatasetWriter) -> list[tuple[str, int]]:
    """Re-split an existing YOLO export (e.g. the annotator's all-in-train one) into
    train/val. Labels are copied verbatim — they're already normalized YOLO."""
    img_root = yolo_dir / "images"
    if img_root.is_dir():
        imgs = sorted(p for p in img_root.rglob("*") if p.suffix.lower() in IMAGE_EXTS)
    else:
        imgs = sorted(
            p for p in yolo_dir.rglob("*")
            if p.suffix.lower() in IMAGE_EXTS and "labels" not in [x.lower() for x in p.parts]
        )
    if not imgs:
        raise SystemExit(f"no images found under {yolo_dir} (expected an images/ subdir)")
    lbl_root = yolo_dir / "labels"
    rows: list[tuple[str, int]] = []
    for img in imgs:
        lbl = next(iter(lbl_root.rglob(f"{img.stem}.txt")), None) if lbl_root.is_dir() else None
        text = lbl.read_text(encoding="utf-8") if lbl and lbl.is_file() else ""
        writer.add_raw(img, text)
        rows.append((img.name, sum(1 for ln in text.splitlines() if ln.strip())))
    return rows


def main() -> int:
    p = argparse.ArgumentParser(description="Build a split YOLO dataset from an annotator export")
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--coco", type=Path, help="annotator COCO export (annotations.json)")
    src.add_argument("--yolo", type=Path, help="annotator YOLO export dir (re-split into train/val)")
    p.add_argument("--out", type=Path, default=DEFAULT_OUT, help="dataset output dir")
    p.add_argument("--task", choices=("seg", "detect"), default="seg", help="label type (COCO input only)")
    p.add_argument("--captures", type=Path, default=DEFAULT_CAPTURES, help="extra dir to resolve images (COCO)")
    p.add_argument("--overlay", type=Path, default=None, help="draw every label on its image here (QA; COCO)")
    args = p.parse_args()

    writer = DatasetWriter(args.out, args.task)
    if args.yolo is not None:
        if not args.yolo.is_dir():
            raise SystemExit(f"YOLO export dir not found: {args.yolo}")
        rows = _run_yolo(args.yolo, writer)
    else:
        if not args.coco.is_file():
            raise SystemExit(f"COCO file not found: {args.coco}")
        rows = _run_coco(args.coco, args.captures, writer, args.overlay)

    writer.finalize()
    rows.sort()
    counts = [c for _, c in rows]
    zero = [n for n, c in rows if c == 0]
    print(f"{len(rows)} images, {sum(counts)} holes (min {min(counts, default=0)}, max {max(counts, default=0)})")
    if zero:
        print(f"[!] {len(zero)} image(s) with NO labels: {', '.join(zero)}")
    if args.overlay is not None and args.coco is not None:
        print(f"QA overlays -> {args.overlay}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
