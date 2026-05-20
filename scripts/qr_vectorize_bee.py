"""Vectorise the B/W HiveHive HighFive.png (bee in hex frame) into pure
SVG paths. Iterates over (threshold, simplification epsilon, min-area)
triples, generates SVG + re-rasterised PNG + diff per attempt, and
reports IoU + path-count so the best parameter set can be picked.

The strategy:
  1. Threshold the source to a binary mask (THRESH_BINARY_INV: dark
     pixels → foreground).
  2. Find ALL contours with RETR_TREE so we get full nesting depth
     (the bee body and its internal stripes are level 2 and 3 contours,
     not just outer/hole pairs as RETR_CCOMP would give).
  3. Simplify each contour with cv2.approxPolyDP (Douglas-Peucker).
  4. Sort polygons by nesting depth, fill alternating black/white
     (level 0 = black, level 1 = white, level 2 = black, …), drawn
     outer-to-inner so inner shapes paint over the enclosing fill.
     This is the only correct fill rule for a binary image whose
     foreground contains both annular rings (the hex frame) AND
     distinct shapes nested inside them (the bee body, stripes,
     antennae).
  5. Emit an SVG with one <polygon> per contour.
  6. Re-rasterise the SVG into a PIL image (via Pillow polygon fills,
     no cairosvg dep).
  7. IoU(original_binary, rendered_binary) → quality metric.

NOTE: re-running `sweep()` overwrites assets/HighFive_vectorised.svg
with whatever the next sweep picks as best. Regenerate deliberately,
not as a side effect of tuning unrelated code. F01 in
qr_experiment.py consumes this asset and silently produces a wrong
inset if the polygon contract drifts.

Usage (PowerShell)
------------------
    python scripts\\qr_vectorize_bee.py
        # runs the parameter sweep, writes attempts to
        # scripts/qr_output/vec_attempts/, and copies the winner to
        # assets/HighFive_vectorised.svg
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "assets" / "HighFive.png"
OUT_DIR = REPO_ROOT / "scripts" / "qr_output" / "vec_attempts"
# The winning vectorisation lands in assets/ as a committed asset so
# qr_experiment.py's F01 design picks it up directly. Parameter-sweep
# attempts stay in qr_output/ (gitignored).
BEST_DST = REPO_ROOT / "assets" / "HighFive_vectorised.svg"


def vectorise(src_path: Path,
              threshold: int = 127,
              epsilon_px: float = 1.0,
              min_area: int = 8):
    """Return (svg_string, rendered_png, iou, n_paths).

    Uses RETR_TREE to get full nested-contour hierarchy, then fills each
    polygon according to its nesting depth — even level = black,
    odd = white — drawn outer-to-inner so inner shapes paint over the
    enclosing fill. This is the only correct fill rule for binary images
    whose foreground contains both annular rings (like the hex frame)
    AND distinct shapes inside those rings (the bee parts)."""
    bgr = cv2.imread(str(src_path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise SystemExit(f"could not read {src_path}")

    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)
    original_mask = (binary > 0)

    contours, hierarchy = cv2.findContours(
        binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE
    )
    if hierarchy is None:
        hierarchy = np.zeros((1, 0, 4), dtype=np.int32)
    h_array = hierarchy[0]

    nodes = []
    for i, cnt in enumerate(contours):
        if abs(cv2.contourArea(cnt)) < min_area:
            continue
        simplified = cv2.approxPolyDP(cnt, epsilon_px, closed=True)
        if len(simplified) < 3:
            continue
        # Walk parent chain to compute nesting depth
        level = 0
        p = h_array[i][3]
        while p != -1:
            level += 1
            p = h_array[p][3]
        nodes.append((simplified, level))

    nodes.sort(key=lambda n: n[1])  # outer levels first

    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'shape-rendering="geometricPrecision">',
        '<rect width="100%" height="100%" fill="white"/>',
    ]
    rendered = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(rendered)

    for simplified, level in nodes:
        is_black = (level % 2 == 0)
        colour_int = 0 if is_black else 255
        colour_svg = "black" if is_black else "white"
        pts = " ".join(f"{p[0][0]},{p[0][1]}" for p in simplified)
        parts.append(f'<polygon points="{pts}" fill="{colour_svg}"/>')
        d.polygon([(int(p[0][0]), int(p[0][1])) for p in simplified],
                  fill=colour_int)

    parts.append("</svg>")
    svg = "\n".join(parts)

    rendered_mask = (np.array(rendered) < 128)
    inter = np.logical_and(original_mask, rendered_mask).sum()
    union = np.logical_or(original_mask, rendered_mask).sum()
    iou = inter / union if union else 0.0

    return svg, rendered, iou, len(nodes)


def sweep():
    """Iterate over parameter triples, save every attempt, log metrics,
    pick the best by IoU + path-count tradeoff."""
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Side-by-side helper
    original = cv2.imread(str(SRC))
    if original is None:
        raise SystemExit(f"could not read {SRC}")
    h, w = original.shape[:2]

    sweep_grid = []
    for threshold in (100, 127, 160):
        for epsilon in (0.3, 0.8, 1.5, 2.5):
            for min_area in (4, 12):
                sweep_grid.append((threshold, epsilon, min_area))

    results = []
    for i, (thr, eps, ma) in enumerate(sweep_grid):
        svg, rendered, iou, n_paths = vectorise(SRC, thr, eps, ma)
        tag = f"t{thr:03d}_e{eps:.1f}_a{ma:02d}"
        (OUT_DIR / f"{tag}.svg").write_text(svg, encoding="utf-8")
        rendered.convert("RGB").save(OUT_DIR / f"{tag}.png")

        # side-by-side
        sbs = Image.new("RGB", (w * 2 + 10, h), (200, 200, 200))
        sbs.paste(Image.open(SRC).convert("RGB"), (0, 0))
        sbs.paste(rendered.convert("RGB"), (w + 10, 0))
        sbs.save(OUT_DIR / f"{tag}_sbs.png")

        results.append((tag, iou, n_paths, thr, eps, ma))
        print(f"  {tag}: IoU={iou:.4f}  paths={n_paths}")

    # Rank: prefer highest IoU but penalize wildly excessive path counts
    # (~laser-cutter friendliness). Score = iou - 0.0005 * n_paths.
    results.sort(key=lambda r: r[1] - 0.0005 * r[2], reverse=True)
    print()
    print("Top 5 by IoU - small-path-count penalty:")
    for tag, iou, np_, thr, eps, ma in results[:5]:
        print(f"  {tag}: IoU={iou:.4f}  paths={np_}  "
              f"(thr={thr} eps={eps} min_area={ma})")

    best_tag, *_ = results[0]
    best_svg = (OUT_DIR / f"{best_tag}.svg").read_text(encoding="utf-8")
    BEST_DST.write_text(best_svg, encoding="utf-8")
    print()
    print(f"Best SVG copied to: {BEST_DST}")
    print(f"Side-by-side comparison: {OUT_DIR / (best_tag + '_sbs.png')}")
    return best_tag


if __name__ == "__main__":
    sweep()
