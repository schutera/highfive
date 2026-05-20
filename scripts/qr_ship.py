"""Post-process a candidate from qr_experiment.py into laser-cutter
deliverables for the HiveHive module sticker (issue #13).

Inputs:
    scripts/qr_output/<NAME>.svg   — produced by qr_experiment.py

Outputs (also in scripts/qr_output/):
    <NAME>_40mm.svg                — standalone, physical size 40 mm,
                                      ready to import into any laser
                                      slicer that respects SVG mm units.
    <NAME>_in_module.svg           — HiveModule-Laserfile_CapsuleWall_v2.svg
                                      with the QR design embedded in the
                                      top-right A4 corner at 40 mm.

Usage (PowerShell)
------------------
    python scripts\\qr_ship.py            # ships F01 into the v2 module SVG
    python scripts\\qr_ship.py D14_bee_companion
    python scripts\\qr_ship.py F01_honeycomb_highfive assets\\HiveModule-Laserfile_CapsuleWall_v7.svg
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "scripts" / "qr_output"
# The module wall geometry has gone v2 → v3 → v4 → v5 → v6 in DXF, but
# the only SVG export in assets/ is the v2 one. SVG is what we need
# (string-level XML injection); when later revisions get exported to
# SVG, override via the second positional CLI arg.
MODULE_SVG = REPO_ROOT / "assets" / "HiveModule-Laserfile_CapsuleWall_v2.svg"

# A4 landscape, FreeCAD's export uses 10 SVG units per mm.
MM_TO_SVG = 10
TARGET_MM = 40
# Top-right corner placement on the 297 × 210 mm page, with 10 mm margin.
PAGE_W_MM = 297
PAGE_H_MM = 210
MARGIN_MM = 10
EMBED_X_MM = PAGE_W_MM - TARGET_MM - MARGIN_MM
EMBED_Y_MM = MARGIN_MM


def ship_40mm(name: str) -> Path:
    """Rewrite scripts/qr_output/<name>.svg with physical 40 mm size."""
    src = OUTPUT_DIR / f"{name}.svg"
    if not src.exists():
        raise SystemExit(f"missing {src} — run qr_experiment.py first")
    dst = OUTPUT_DIR / f"{name}_40mm.svg"

    svg = src.read_text(encoding="utf-8")
    # Replace pixel width/height on the root <svg> while keeping the
    # viewBox so all internal coordinates still resolve.
    svg = re.sub(r'width="\d+(?:\.\d+)?"', f'width="{TARGET_MM}mm"', svg, count=1)
    svg = re.sub(r'height="\d+(?:\.\d+)?"', f'height="{TARGET_MM}mm"', svg, count=1)
    dst.write_text(svg, encoding="utf-8")
    return dst


def embed_in_module(name: str, module_svg: Path = MODULE_SVG) -> Path:
    """Drop the QR design (as a transformed <g>) into the FreeCAD module
    laser file at (EMBED_X_MM, EMBED_Y_MM) on the A4 page."""
    qr_src = OUTPUT_DIR / f"{name}.svg"
    if not qr_src.exists():
        raise SystemExit(f"missing {qr_src} — run qr_experiment.py first")
    if not module_svg.exists():
        raise SystemExit(f"missing {module_svg}")

    qr_svg = qr_src.read_text(encoding="utf-8")
    module_svg_text = module_svg.read_text(encoding="utf-8")

    # Pull viewBox dimensions of the QR SVG so we can compute the scale.
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', qr_svg)
    if not m:
        raise SystemExit("could not find viewBox on QR SVG")
    qr_w, qr_h = float(m.group(1)), float(m.group(2))

    # Strip the QR SVG's own <svg>...</svg> wrapper so we can inject its
    # children into the module SVG as a <g>.
    qr_inner = re.sub(r'^<\?xml[^>]*\?>\s*', '', qr_svg)
    qr_inner = re.sub(r'^<svg[^>]*>\s*', '', qr_inner)
    qr_inner = re.sub(r'\s*</svg>\s*$', '', qr_inner)

    # Scale + translate the QR group: 1 QR-pixel → (TARGET_MM/qr_w) mm
    # → MM_TO_SVG units per mm.
    scale = (TARGET_MM / qr_w) * MM_TO_SVG
    embed_x_svg = EMBED_X_MM * MM_TO_SVG
    embed_y_svg = EMBED_Y_MM * MM_TO_SVG

    qr_group = (
        f'\n<!-- QR sticker design "{name}" embedded by qr_ship.py -->\n'
        f'<g transform="translate({embed_x_svg},{embed_y_svg}) '
        f'scale({scale})" id="hivehive-qr-{name}">\n'
        f'{qr_inner}\n'
        f'</g>\n'
    )

    # Inject just before the module SVG's closing </svg>.
    if module_svg_text.count("</svg>") < 1:
        raise SystemExit("module SVG has no </svg> closing tag")
    embedded = module_svg_text.rsplit("</svg>", 1)
    embedded = embedded[0] + qr_group + "</svg>" + embedded[1]

    dst = OUTPUT_DIR / f"{name}_in_module.svg"
    dst.write_text(embedded, encoding="utf-8")
    return dst


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else "F01_honeycomb_highfive"
    module_svg = Path(sys.argv[2]) if len(sys.argv) > 2 else MODULE_SVG
    standalone = ship_40mm(name)
    embedded = embed_in_module(name, module_svg)
    print(f"Standalone 40 mm SVG:   {standalone}")
    print(f"Embedded into module:   {embedded}")
    print()
    print(f"Place sticker on the module wall by opening")
    print(f"  {embedded}")
    print(f"in InkScape / your laser slicer. The QR is at "
          f"({EMBED_X_MM}mm, {EMBED_Y_MM}mm) on the A4 page; drag the "
          f"group to the actual capsule-wall face you want it on.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
