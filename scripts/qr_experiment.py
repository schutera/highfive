"""QR-code design experiments for the HiveHive module sticker (issue #13).

Encodes a target URL into a QR matrix once, then renders that matrix
through many cosmetic variants — each one emits both a PNG (for desktop
decoder round-trips) and a laser-cutter-ready SVG (single fill colour,
no strokes, vector shapes). Every variant is round-tripped through
pyzbar, OpenCV's QRCodeDetector, and pyzxing (if Java is available) so
we know which designs survive strict decoders vs. which are phone-only.

Two design eras live here:

The 'option_*' batch (5 entries) was the first round — colour and
brand-inset experiments. Kept because option_3_honeycomb and
option_5_hex_inset proved scanner-safe and the bee-inset variant is
the brand-fit reference.

The 'D##' batch (15 entries) is the laser-cut creative round — pattern
variation across module shapes, decorative frames, and bee accents.
Every D## design is monochrome and laser-suitable (single fill colour
in the SVG, no images, vector shapes that translate cleanly to either
through-cut or surface-etch operations).

Usage (PowerShell)
------------------
    python -m pip install -r scripts\\requirements-qr.txt
    python scripts\\qr_experiment.py
    python scripts\\qr_experiment.py "https://example.com/foo"
    Start-Process explorer.exe scripts\\qr_output

Outputs land in scripts/qr_output/ (gitignored).
"""

from __future__ import annotations

import contextlib
import io
import logging
import math
import re
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOGO_PATH = REPO_ROOT / "docs" / "_images" / "HiveHive_Logo.png"
# Pure-vector bee-in-hex-frame logo (produced by qr_vectorize_bee.py from
# assets/HighFive.png). Checked-in artifact so F01 emits its bee inset
# as polygons immediately on clone, no need to re-run the vectoriser.
HIGHFIVE_VECTOR_SVG = REPO_ROOT / "assets" / "HighFive_vectorised.svg"
OUTPUT_DIR = REPO_ROOT / "scripts" / "qr_output"
DEFAULT_URL = "https://highfive.schutera.com/dashboard"

BRAND_ORANGE = (243, 146, 0)
BRAND_DARK = (26, 26, 26)
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)

PITCH = 16
QUIET_MODULES = 4

# Hex circumradius for pointy-top hexes — flat-to-flat distance equals
# PITCH, so adjacent filled modules merge into a solid block (required
# for line-scan decoders; first-round bug was hexes that left tiny gaps).
HEX_RADIUS = PITCH / math.sqrt(3)

INSET_MODULES = 13  # bee inset width in QR modules for option_5


# ---------------------------------------------------------------------------
# Base QR
# ---------------------------------------------------------------------------

def make_matrix(data: str, ec_level: str = "H"):
    import segno
    qr = segno.make(data, error=ec_level, boost_error=False)
    matrix = [[int(m) for m in row] for row in qr.matrix]
    return matrix, qr.version


def finder_pattern_cells(n: int) -> set[tuple[int, int]]:
    """Return the (row, col) of every module belonging to a finder pattern."""
    cells: set[tuple[int, int]] = set()
    for r0, c0 in ((0, 0), (0, n - 7), (n - 7, 0)):
        for dr in range(7):
            for dc in range(7):
                cells.add((r0 + dr, c0 + dc))
    return cells


# ---------------------------------------------------------------------------
# Renderer: writes PIL PNG and SVG simultaneously
# ---------------------------------------------------------------------------

def _to_hex(color) -> str:
    if isinstance(color, str):
        return color
    return "#{:02x}{:02x}{:02x}".format(*color[:3])


class Renderer:
    """Dual-output canvas — every shape call appends to both PIL (for the
    PNG validation pass) and an SVG string list (for the laser cutter)."""

    def __init__(self, n_modules: int, pitch: int = PITCH,
                 quiet: int = QUIET_MODULES, bg=WHITE):
        from PIL import Image, ImageDraw
        self.n = n_modules
        self.pitch = pitch
        self.quiet_px = quiet * pitch
        self.size = n_modules * pitch + 2 * self.quiet_px
        self._bg = bg

        self.img = Image.new("RGB", (self.size, self.size), bg)
        self.draw = ImageDraw.Draw(self.img)

        self._svg: list[str] = [
            f'<svg xmlns="http://www.w3.org/2000/svg" '
            f'width="{self.size}" height="{self.size}" '
            f'viewBox="0 0 {self.size} {self.size}" '
            f'shape-rendering="crispEdges">',
            f'<rect width="100%" height="100%" fill="{_to_hex(bg)}"/>',
        ]

    # ---- module-coordinate helpers ----

    def center(self, row: int, col: int) -> tuple[float, float]:
        return (self.quiet_px + col * self.pitch + self.pitch / 2,
                self.quiet_px + row * self.pitch + self.pitch / 2)

    def top_left(self, row: int, col: int) -> tuple[float, float]:
        return (self.quiet_px + col * self.pitch,
                self.quiet_px + row * self.pitch)

    # ---- background / shapes ----

    def fill_background(self, color) -> None:
        self.draw.rectangle([(0, 0), (self.size, self.size)], fill=color)
        self._svg[1] = f'<rect width="100%" height="100%" fill="{_to_hex(color)}"/>'

    def rect(self, x: float, y: float, w: float, h: float, fill) -> None:
        self.draw.rectangle([(x, y), (x + w, y + h)], fill=fill)
        self._svg.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
            f'fill="{_to_hex(fill)}"/>'
        )

    def rounded_rect(self, x: float, y: float, w: float, h: float,
                     radius: float, fill) -> None:
        self.draw.rounded_rectangle([(x, y), (x + w, y + h)],
                                    radius=radius, fill=fill)
        self._svg.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" '
            f'rx="{radius:.2f}" ry="{radius:.2f}" fill="{_to_hex(fill)}"/>'
        )

    def circle(self, cx: float, cy: float, r: float, fill) -> None:
        self.draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=fill)
        self._svg.append(
            f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="{r:.2f}" '
            f'fill="{_to_hex(fill)}"/>'
        )

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, fill) -> None:
        self.draw.ellipse([(cx - rx, cy - ry), (cx + rx, cy + ry)], fill=fill)
        self._svg.append(
            f'<ellipse cx="{cx:.2f}" cy="{cy:.2f}" rx="{rx:.2f}" ry="{ry:.2f}" '
            f'fill="{_to_hex(fill)}"/>'
        )

    def polygon(self, points, fill) -> None:
        self.draw.polygon([(float(x), float(y)) for x, y in points], fill=fill)
        pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in points)
        self._svg.append(f'<polygon points="{pts}" fill="{_to_hex(fill)}"/>')

    def hex(self, cx: float, cy: float, r: float, fill, pointy: bool = True) -> None:
        offset = -30 if pointy else 0
        pts = [(cx + r * math.cos(math.radians(60 * k + offset)),
                cy + r * math.sin(math.radians(60 * k + offset)))
               for k in range(6)]
        self.polygon(pts, fill)

    # ---- save ----

    def save(self, png_path: Path, svg_path: Path | None = None) -> None:
        png_path.parent.mkdir(parents=True, exist_ok=True)
        self.img.save(png_path)
        if svg_path is not None:
            svg = "\n".join(self._svg + ["</svg>"])
            svg_path.write_text(svg, encoding="utf-8")


# ---------------------------------------------------------------------------
# Bee silhouette helper (D14 frame, D15 accents)
# ---------------------------------------------------------------------------

def draw_bee_silhouette(r: Renderer, cx: float, cy: float,
                        size: float, color) -> None:
    """Stylised bee as 5 primitives — body ellipse + two wings + head circle.

    `size` is the body length. The wings extend upward and outward.
    """
    body_rx = size / 2
    body_ry = size / 2 * 0.55
    r.ellipse(cx, cy, body_rx, body_ry, color)

    head_r = size * 0.13
    r.circle(cx - body_rx - head_r * 0.4, cy, head_r, color)

    wing_rx = size * 0.27
    wing_ry = size * 0.18
    r.ellipse(cx - size * 0.12, cy - body_ry * 0.7, wing_rx, wing_ry, color)
    r.ellipse(cx + size * 0.18, cy - body_ry * 0.7, wing_rx, wing_ry, color)


# ---------------------------------------------------------------------------
# Designs — module-shape variants
# ---------------------------------------------------------------------------

def _foreach_filled(matrix):
    n = len(matrix)
    for row in range(n):
        for col in range(n):
            if matrix[row][col]:
                yield row, col


def design_D01_classic(matrix, r: Renderer) -> None:
    """Baseline: stock square modules. Reference for every other design."""
    for row, col in _foreach_filled(matrix):
        x, y = r.top_left(row, col)
        r.rect(x, y, r.pitch, r.pitch, BLACK)


def design_D02_circles(matrix, r: Renderer) -> None:
    """Solid circles per module — radius = PITCH/2 so orthogonal neighbours
    meet at one point; diagonal neighbours leave small gaps (acceptable
    because decoders sample at module centres, not edges)."""
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        r.circle(cx, cy, r.pitch / 2, BLACK)


def design_D03_diamonds(matrix, r: Renderer) -> None:
    """45-degree rotated squares. The diamond's circumradius must overlap
    the neighbouring module's centre, otherwise adjacent filled cells
    only touch at one vertex and decoders read inter-module white as a
    boundary. half=PITCH*0.75 guarantees orthogonal overlap."""
    half = r.pitch * 0.75
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        r.polygon(
            [(cx, cy - half), (cx + half, cy),
             (cx, cy + half), (cx - half, cy)],
            BLACK,
        )


def design_D04_rounded_squares(matrix, r: Renderer) -> None:
    """Squircle modules — squares with rounded corners. Reads softer than
    D01, still merges cleanly between filled neighbours."""
    radius = r.pitch * 0.3
    for row, col in _foreach_filled(matrix):
        x, y = r.top_left(row, col)
        r.rounded_rect(x, y, r.pitch, r.pitch, radius, BLACK)


def design_D05_teardrops(matrix, r: Renderer) -> None:
    """Honey-drop modules — circle bottom + pointed top. Modules pointing
    down look like honey drops. Likely to fail strict decoders because
    the asymmetry breaks adjacent-module continuity."""
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        half = r.pitch / 2
        # Pointed top + half-circle bottom as an approximated polygon
        pts = [(cx, cy - half * 1.05)]
        for k in range(13):
            angle = math.pi * (1 + k / 12)  # sweep from π to 2π = bottom semicircle
            pts.append((cx + half * math.cos(angle),
                        cy + half * math.sin(angle)))
        r.polygon(pts, BLACK)


def design_D06_plus(matrix, r: Renderer) -> None:
    """Cross / plus-sign modules. Bars run module-edge to module-edge so
    horizontal and vertical neighbours' bars merge into long lines."""
    bar = r.pitch * 0.55
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        half = r.pitch / 2
        # Horizontal bar (full pitch wide) + vertical bar
        r.rect(cx - half, cy - bar / 2, r.pitch, bar, BLACK)
        r.rect(cx - bar / 2, cy - half, bar, r.pitch, BLACK)


def design_D07_hexagons(matrix, r: Renderer) -> None:
    """Pointy-top hexagons. Flat-to-flat = PITCH so horizontal neighbours
    meet flush; vertical neighbours overlap slightly. Same family as the
    first-round option_3_honeycomb (proven scanner-safe)."""
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        r.hex(cx, cy, HEX_RADIUS, BLACK, pointy=True)


def design_D08_octagons(matrix, r: Renderer) -> None:
    """Regular octagonal modules — close to circles but with straight
    edges, which laser cutters tend to render more cleanly."""
    rad = r.pitch / 2 * 1.05
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        pts = [(cx + rad * math.cos(math.radians(45 * k + 22.5)),
                cy + rad * math.sin(math.radians(45 * k + 22.5)))
               for k in range(8)]
        r.polygon(pts, BLACK)


def design_D09_triangles_alt(matrix, r: Renderer) -> None:
    """Alternating up/down equilateral triangles depending on (row+col)
    parity. Risky for decoders — module centroids shift slightly."""
    half = r.pitch / 2
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        if (row + col) % 2 == 0:
            r.polygon([(cx, cy - half), (cx + half, cy + half),
                       (cx - half, cy + half)], BLACK)
        else:
            r.polygon([(cx, cy + half), (cx + half, cy - half),
                       (cx - half, cy - half)], BLACK)


def design_D10_starhex(matrix, r: Renderer) -> None:
    """Hexagram (six-pointed star) modules — two overlapping triangles.
    Looks ornate, may break decoders that need solid blocks."""
    rad = r.pitch / 2 * 1.05
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        for offset_deg in (0, 60):
            pts = [
                (cx + rad * math.cos(math.radians(120 * k + offset_deg)),
                 cy + rad * math.sin(math.radians(120 * k + offset_deg)))
                for k in range(3)
            ]
            r.polygon(pts, BLACK)


def design_D11_inverted_hex(matrix, r: Renderer) -> None:
    """Hex modules but inverted — white hexes on a black background.
    Tests reader tolerance for negative-polarity QR codes."""
    r.fill_background(BLACK)
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        r.hex(cx, cy, HEX_RADIUS, WHITE, pointy=True)


def design_D12_hex_grout(matrix, r: Renderer) -> None:
    """Hex modules deliberately shrunk to leave visible white grout —
    pushes the design toward 'real honeycomb' look. Risk: too much grout
    and decoders lose the module continuity."""
    shrunk = HEX_RADIUS * 0.82
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        r.hex(cx, cy, shrunk, BLACK, pointy=True)


# ---------------------------------------------------------------------------
# Designs — frame / decoration variants (quiet-zone-only additions)
# ---------------------------------------------------------------------------

def design_D13_honeycomb_tile_band(matrix, r: Renderer) -> None:
    """Square QR with small honeycomb cells tiled in the expanded quiet
    zone. Hexes whose bounding circle intersects the protected QR +
    4-module standard quiet zone are skipped, so the scannable region
    stays pristine."""
    design_D01_classic(matrix, r)

    qr_top_left = r.quiet_px
    qr_extent_px = r.n * r.pitch
    # Protected square: QR core + 4 modules quiet zone on each side
    protected_min = qr_top_left - 4 * r.pitch
    protected_max = qr_top_left + qr_extent_px + 4 * r.pitch

    # Hex tile pitch — three-modules-wide cells look intentional, not chaotic
    tile_radius = r.pitch * 1.4
    flat_to_flat = tile_radius * math.sqrt(3)
    col_pitch = flat_to_flat
    row_pitch = tile_radius * 1.5

    cols = int(r.size / col_pitch) + 2
    rows = int(r.size / row_pitch) + 2

    for row in range(-1, rows):
        for col in range(-1, cols):
            cx = col * col_pitch + (row % 2) * col_pitch / 2
            cy = row * row_pitch
            # Skip any hex that would intrude on the protected square.
            if (cx + tile_radius > protected_min
                    and cx - tile_radius < protected_max
                    and cy + tile_radius > protected_min
                    and cy - tile_radius < protected_max):
                continue
            # Skip any hex that would extend outside the canvas
            if (cx - tile_radius < 0 or cx + tile_radius > r.size
                    or cy - tile_radius < 0 or cy + tile_radius > r.size):
                continue
            r.hex(cx, cy, tile_radius * 0.85, BLACK, pointy=True)


def design_D14_bee_companion(matrix, r: Renderer) -> None:
    """Classic QR placed in the bottom portion of the canvas; a stylised
    bee silhouette etched in the top portion. Since the Renderer is
    square, the QR sits below centre and the bee floats above. Decoder
    sees a normal QR with extra quiet zone on top."""
    qr_extent_px = r.n * r.pitch
    bee_band_h = r.size - qr_extent_px - 8 * r.pitch
    # Re-stamp the QR at the canvas bottom (top_left helpers assume the
    # QR sits at the standard quiet offset; we override here).
    qr_x = (r.size - qr_extent_px) / 2
    qr_y = r.size - r.quiet_px - qr_extent_px / 2 - qr_extent_px / 2

    # Override default top_left for this design — paint QR at custom anchor.
    for row, col in _foreach_filled(matrix):
        x = qr_x + col * r.pitch
        y = qr_y + row * r.pitch
        r.rect(x, y, r.pitch, r.pitch, BLACK)

    # Bee in the top band, centred horizontally
    bee_cx = r.size / 2
    bee_cy = bee_band_h / 2 + r.pitch
    bee_size = min(bee_band_h * 0.7, qr_extent_px * 0.55)
    draw_bee_silhouette(r, bee_cx, bee_cy, bee_size, BLACK)


# ---------------------------------------------------------------------------
# Helpers reused by the E-series drafts
# ---------------------------------------------------------------------------

def _paint_classic_qr_at(matrix, r: Renderer, qr_x: float, qr_y: float) -> None:
    """Stamp a square-module QR at an arbitrary (top-left) canvas position."""
    for row, col in _foreach_filled(matrix):
        r.rect(qr_x + col * r.pitch, qr_y + row * r.pitch,
               r.pitch, r.pitch, BLACK)


def _paint_hex_qr_at(matrix, r: Renderer, qr_x: float, qr_y: float) -> None:
    """Stamp a hex-module QR (D07 family) at an arbitrary canvas position."""
    for row, col in _foreach_filled(matrix):
        cx = qr_x + col * r.pitch + r.pitch / 2
        cy = qr_y + row * r.pitch + r.pitch / 2
        r.hex(cx, cy, HEX_RADIUS, BLACK, pointy=True)


def _paint_truehex_tiles(r: Renderer, skip_rects, tile_radius: float | None = None) -> None:
    """Tile a true row-staggered honeycomb across the canvas, skipping any
    tile whose bounding circle would intersect any skip rectangle
    (x0, y0, x1, y1)."""
    if tile_radius is None:
        tile_radius = r.pitch * 1.0
    flat_to_flat = tile_radius * math.sqrt(3)
    row_pitch = tile_radius * 1.5

    n_rows = int(r.size / row_pitch) + 2
    n_cols = int(r.size / flat_to_flat) + 2

    for row_i in range(-1, n_rows):
        for col_i in range(-1, n_cols):
            cx = col_i * flat_to_flat + (row_i % 2) * flat_to_flat / 2
            cy = row_i * row_pitch
            if (cx - tile_radius < 0 or cx + tile_radius > r.size
                    or cy - tile_radius < 0 or cy + tile_radius > r.size):
                continue
            blocked = False
            for x0, y0, x1, y1 in skip_rects:
                if (cx + tile_radius > x0 and cx - tile_radius < x1
                        and cy + tile_radius > y0 and cy - tile_radius < y1):
                    blocked = True
                    break
            if blocked:
                continue
            r.hex(cx, cy, tile_radius * 0.85, BLACK, pointy=True)


def design_D15_bee_accents(matrix, r: Renderer) -> None:
    """Hexagon modules + tiny bee silhouettes in the quiet zone near
    each finder pattern. Honeycomb feel from the modules + branded
    accents from the bees, both fully laser-suitable."""
    design_D07_hexagons(matrix, r)

    # Three bees floating in the quiet zone near the finders
    bee_size = r.pitch * 3
    margin = r.quiet_px / 2
    finder_offsets = [
        (margin, margin),                         # top-left
        (r.size - margin, margin),                # top-right
        (margin, r.size - margin),                # bottom-left
    ]
    for cx, cy in finder_offsets:
        draw_bee_silhouette(r, cx, cy, bee_size, BLACK)


# ---------------------------------------------------------------------------
# Designs — E-series: truehex aesthetic combined with a simple bee shape.
# All E-series designs use a STANDARD square QR core for scannability;
# the truehex visual lives in the decorated quiet zone. E05 is the one
# exception: it applies a SMALL stagger to the QR modules themselves,
# small enough that enlarged hex modules still cover the unstaggered
# sample points the decoder expects.
# ---------------------------------------------------------------------------

def design_E01_truehex_bee_above(matrix, r: Renderer) -> None:
    """Square QR at the bottom, true-honeycomb tile filling the upper
    quiet zone, simple bee silhouette etched above the QR."""
    qr_extent_px = r.n * r.pitch
    qr_x = (r.size - qr_extent_px) / 2
    qr_y = r.size - r.quiet_px - qr_extent_px

    bee_x0 = r.size * 0.20
    bee_y0 = r.quiet_px * 0.3
    bee_x1 = r.size * 0.80
    bee_y1 = qr_y - r.pitch * 3

    qr_protected = (qr_x - 4 * r.pitch, qr_y - 4 * r.pitch,
                    qr_x + qr_extent_px + 4 * r.pitch,
                    qr_y + qr_extent_px + 4 * r.pitch)
    bee_protected = (bee_x0, bee_y0, bee_x1, bee_y1)

    _paint_truehex_tiles(r, [qr_protected, bee_protected])
    _paint_classic_qr_at(matrix, r, qr_x, qr_y)
    draw_bee_silhouette(r,
                        (bee_x0 + bee_x1) / 2, (bee_y0 + bee_y1) / 2,
                        min(bee_x1 - bee_x0, bee_y1 - bee_y0) * 0.85,
                        BLACK)


def design_E02_truehex_bee_below(matrix, r: Renderer) -> None:
    """Same as E01 but the bee sits below the QR — slightly different
    visual weight (QR at top, bee anchoring the sticker bottom)."""
    qr_extent_px = r.n * r.pitch
    qr_x = (r.size - qr_extent_px) / 2
    qr_y = r.quiet_px

    bee_x0 = r.size * 0.20
    bee_y0 = qr_y + qr_extent_px + r.pitch * 3
    bee_x1 = r.size * 0.80
    bee_y1 = r.size - r.quiet_px * 0.3

    qr_protected = (qr_x - 4 * r.pitch, qr_y - 4 * r.pitch,
                    qr_x + qr_extent_px + 4 * r.pitch,
                    qr_y + qr_extent_px + 4 * r.pitch)
    bee_protected = (bee_x0, bee_y0, bee_x1, bee_y1)

    _paint_truehex_tiles(r, [qr_protected, bee_protected])
    _paint_classic_qr_at(matrix, r, qr_x, qr_y)
    draw_bee_silhouette(r,
                        (bee_x0 + bee_x1) / 2, (bee_y0 + bee_y1) / 2,
                        min(bee_x1 - bee_x0, bee_y1 - bee_y0) * 0.85,
                        BLACK)


def design_E03_hexqr_with_bee_above(matrix, r: Renderer) -> None:
    """Hexagon-module QR (D07 family, hex shapes at square-grid centres)
    + simple bee silhouette above. No quiet-zone tile pattern; the
    honeycomb feel comes from the QR modules themselves. Will FAIL zxing
    like D07 but is the cleanest 'honeycomb QR + bee' read."""
    qr_extent_px = r.n * r.pitch
    qr_x = (r.size - qr_extent_px) / 2
    qr_y = r.size - r.quiet_px - qr_extent_px

    _paint_hex_qr_at(matrix, r, qr_x, qr_y)

    bee_cx = r.size / 2
    bee_cy = qr_y / 2
    bee_size = min(qr_y * 0.7, qr_extent_px * 0.55)
    draw_bee_silhouette(r, bee_cx, bee_cy, bee_size, BLACK)


def design_E04_truehex_bee_corner(matrix, r: Renderer) -> None:
    """Square QR top-left, truehex tile fill, small bee tucked into the
    bottom-right corner. Asymmetric sticker layout — more 'product label'
    than centred QR."""
    qr_extent_px = r.n * r.pitch
    qr_x = r.quiet_px
    qr_y = r.quiet_px

    bee_size = qr_extent_px * 0.35
    bee_cx = r.size - r.quiet_px - bee_size / 2
    bee_cy = r.size - r.quiet_px - bee_size / 2

    qr_protected = (qr_x - 4 * r.pitch, qr_y - 4 * r.pitch,
                    qr_x + qr_extent_px + 4 * r.pitch,
                    qr_y + qr_extent_px + 4 * r.pitch)
    bee_protected = (bee_cx - bee_size * 0.7, bee_cy - bee_size * 0.5,
                     bee_cx + bee_size * 0.7, bee_cy + bee_size * 0.5)

    _paint_truehex_tiles(r, [qr_protected, bee_protected])
    _paint_classic_qr_at(matrix, r, qr_x, qr_y)
    draw_bee_silhouette(r, bee_cx, bee_cy, bee_size, BLACK)


def design_E05_subtle_stagger_with_bee(matrix, r: Renderer) -> None:
    """The most ambitious — apply a SMALL vertical stagger (0.15*PITCH)
    to odd columns and enlarge the hex modules so they still cover the
    decoder's grid-aligned sample points. The QR modules themselves wave
    slightly, hinting at honeycomb lattice without breaking scanning.
    Bee silhouette above. May fail strict decoders."""
    qr_extent_px = r.n * r.pitch
    qr_x = (r.size - qr_extent_px) / 2
    qr_y = r.size - r.quiet_px - qr_extent_px

    stagger_y = r.pitch * 0.15
    hex_r = HEX_RADIUS * 1.18  # enlarged so 8-px-ish sample still inside

    for row, col in _foreach_filled(matrix):
        cx = qr_x + col * r.pitch + r.pitch / 2
        cy = qr_y + row * r.pitch + r.pitch / 2
        if col % 2 == 1:
            cy += stagger_y
        r.hex(cx, cy, hex_r, BLACK, pointy=True)

    bee_cx = r.size / 2
    bee_cy = qr_y / 2
    bee_size = min(qr_y * 0.7, qr_extent_px * 0.55)
    draw_bee_silhouette(r, bee_cx, bee_cy, bee_size, BLACK)


# ---------------------------------------------------------------------------
# Designs — F-series: laser-clean inset of the B/W HighFive bee+hex logo.
# ---------------------------------------------------------------------------

_VECTOR_POLY_TAG_RE = re.compile(r"<polygon\b([^/>]*)/?>", re.IGNORECASE)
_VECTOR_POLY_POINTS_RE = re.compile(r'\bpoints\s*=\s*"([^"]+)"', re.IGNORECASE)
_VECTOR_POLY_FILL_RE = re.compile(r'\bfill\s*=\s*"([^"]+)"', re.IGNORECASE)


_BLACK_FILLS = {"black", "#000", "#000000"}
_WHITE_FILLS = {"white", "#fff", "#ffffff"}


def _classify_fill(fill: str) -> tuple[int, int, int]:
    """Map an SVG fill string to BLACK or WHITE, the only two colours
    F01's inset uses. Accepts both named colours (`black`, `white`) and
    short/long hex codes, so an Inkscape re-save of the vectorised
    asset (which rewrites `fill="black"` → `fill="#000000"`) does not
    silently flip every polygon to WHITE. Anything else raises so
    drift is caught instead of producing a wrong inset."""
    key = fill.strip().lower()
    if key in _BLACK_FILLS:
        return BLACK
    if key in _WHITE_FILLS:
        return WHITE
    raise RuntimeError(
        f"unrecognised fill {fill!r} in {HIGHFIVE_VECTOR_SVG.name}. "
        "F01 only handles black/white. If the asset was re-saved with a "
        "different colour palette, regenerate via "
        "`python scripts/qr_vectorize_bee.py`."
    )


def _point_in_pointy_hex(px: float, py: float,
                         cx: float, cy: float, r: float) -> bool:
    """Return True if (px, py) is inside a pointy-top regular hexagon
    centred at (cx, cy) with circumradius r. Used by F01 to define a
    hexagonal exclusion zone for the bee inset — QR modules whose
    centres fall inside this zone are skipped so the hex frame meets a
    smooth hexagonal margin rather than the rectangular-with-poking-
    triangles boundary the old square white-padding rect produced."""
    dx = abs(px - cx)
    dy = abs(py - cy)
    if dx > r * math.sqrt(3) / 2:
        return False
    if dx / math.sqrt(3) + dy > r:
        return False
    return True


def _load_highfive_vector_polygons():
    """Read HighFive_vectorised.svg and return (polys, src_w, src_h).
    polys is a list of (points, fill_str) where points are (x, y) floats
    in the source SVG's coordinate space.

    Returns None ONLY if the asset file is absent or has no parseable
    viewBox. The only caller, design_F01_honeycomb_with_highfive_inset,
    hard-raises on None — there is no PNG fallback. Raises RuntimeError
    if the asset is present but parses to zero polygons after the
    corner filter (drift detection — see the empty-list guard below).

    Polygons that include a vertex at one of the source image's four
    corners are filtered out. The source HighFive.png has a black
    background outside the hex frame; a faithful vectorisation captures
    those background triangles as separate corner polygons. For F01 we
    want only the bee + hex-frame and a transparent canvas around them,
    so the corner triangles are discarded here. The standalone
    HighFive_vectorised.svg stays faithful — the filter only applies
    when F01 loads the polygons."""
    if not HIGHFIVE_VECTOR_SVG.exists():
        return None
    text = HIGHFIVE_VECTOR_SVG.read_text(encoding="utf-8")
    m = re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', text)
    if not m:
        return None
    src_w, src_h = float(m.group(1)), float(m.group(2))

    polys = []
    for tag_match in _VECTOR_POLY_TAG_RE.finditer(text):
        attrs = tag_match.group(1)
        pts_match = _VECTOR_POLY_POINTS_RE.search(attrs)
        fill_match = _VECTOR_POLY_FILL_RE.search(attrs)
        if not pts_match or not fill_match:
            continue
        pts = []
        for pair in pts_match.group(1).split():
            x_str, y_str = pair.split(",")
            pts.append((float(x_str), float(y_str)))
        polys.append((pts, fill_match.group(1).lower()))

    edge_tol = 1.0
    def _has_corner_vertex(pts):
        for x, y in pts:
            at_left = x < edge_tol
            at_right = x > src_w - 1 - edge_tol
            at_top = y < edge_tol
            at_bottom = y > src_h - 1 - edge_tol
            if (at_left or at_right) and (at_top or at_bottom):
                return True
        return False

    polys = [(pts, fill) for pts, fill in polys if not _has_corner_vertex(pts)]

    # Hard guard: F01 expects at least the outer hex frame, inner hex
    # frame, and the bee body to come through. If the polygon list is
    # empty after filtering, the SVG asset has drifted (renamed,
    # re-saved by another tool, polygon syntax changed, …) and
    # silently rendering F01 with no inset would corrupt the QR design.
    if not polys:
        raise RuntimeError(
            f"{HIGHFIVE_VECTOR_SVG} parsed 0 polygons after corner filter. "
            "The asset has drifted from the contract qr_experiment.py "
            "expects. Re-run scripts/qr_vectorize_bee.py to regenerate it."
        )
    return polys, src_w, src_h


def design_F01_honeycomb_with_highfive_inset(matrix, r: Renderer) -> None:
    """Hex-module QR (option_3 family) + B/W HighFive bee-in-hex-frame
    inset at centre, emitted as pure-vector polygons surrounded by a
    HEXAGONAL exclusion zone. QR modules whose centres fall inside the
    zone are skipped so the bee frame meets the surrounding honeycomb
    along a clean hex boundary rather than a square padding rectangle.
    Laser-cutter clean end-to-end.

    Requires assets/HighFive_vectorised.svg. If that asset is missing
    or has drifted from the polygon contract, this hard-errors rather
    than silently producing a non-laser-clean fallback — a base64-PNG
    embed with a stretched aspect ratio is worse than no output at all
    for a design the user intends to ship to a laser cutter."""
    vec = _load_highfive_vector_polygons()
    if vec is None:
        raise RuntimeError(
            f"{HIGHFIVE_VECTOR_SVG} not found. "
            "Run `python scripts/qr_vectorize_bee.py` to (re)generate it "
            "before running this experiment."
        )
    polys, src_w, src_h = vec

    inset_w_px = INSET_MODULES * r.pitch                     # 13 * 16 = 208
    inset_top_left = ((r.n - INSET_MODULES) // 2) * r.pitch + r.quiet_px

    # Fit the bee+frame bounding box into the inset square, preserving
    # aspect ratio, centred.
    scale = min(inset_w_px / src_w, inset_w_px / src_h)
    bbox_w, bbox_h = src_w * scale, src_h * scale
    offset_x = inset_top_left + (inset_w_px - bbox_w) / 2
    offset_y = inset_top_left + (inset_w_px - bbox_h) / 2

    # Hexagonal exclusion zone — pointy-top hex centred on the inset,
    # circumradius chosen so a pointy-top hex enclosing the bee
    # bounding box plus a 5% halo fits. Modules whose centres fall
    # inside this hex are not rendered, so the canvas's white
    # background shows through as a clean halo around the frame.
    inset_cx = inset_top_left + inset_w_px / 2
    inset_cy = inset_top_left + inset_w_px / 2
    exclusion_r = max(bbox_h / 2, bbox_w / math.sqrt(3)) * 1.05

    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        if _point_in_pointy_hex(cx, cy, inset_cx, inset_cy, exclusion_r):
            continue
        r.hex(cx, cy, HEX_RADIUS, BLACK, pointy=True)

    for pts, fill in polys:
        transformed = [
            (offset_x + px * scale, offset_y + py * scale)
            for px, py in pts
        ]
        colour = _classify_fill(fill)
        r.polygon(transformed, colour)


# ---------------------------------------------------------------------------
# Designs — first-round colour & inset variants (kept for reference)
# ---------------------------------------------------------------------------

def render_honeycomb(matrix, png_path: Path, svg_path: Path,
                     fg=BRAND_DARK, bg=WHITE,
                     finder_fg=None) -> None:
    r = Renderer(len(matrix), bg=bg)
    finders = finder_pattern_cells(r.n) if finder_fg else set()
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        colour = finder_fg if (row, col) in finders else fg
        r.hex(cx, cy, HEX_RADIUS, colour, pointy=True)
    r.save(png_path, svg_path)


def render_true_hex_grid(matrix, png_path: Path, svg_path: Path) -> None:
    r = Renderer(len(matrix))
    for row, col in _foreach_filled(matrix):
        cx, cy = r.center(row, col)
        if col % 2 == 1:
            cy += r.pitch / 2
        r.hex(cx, cy, HEX_RADIUS, BRAND_DARK, pointy=True)
    r.save(png_path, svg_path)


def render_hex_with_inset(matrix, png_path: Path, svg_path: Path) -> None:
    """Brand-fit reference — hex modules + orange finders + logo inset.
    Not laser-friendly (uses raster logo image)."""
    from PIL import Image, ImageDraw
    render_honeycomb(matrix, png_path, svg_path,
                     fg=BRAND_DARK, bg=WHITE, finder_fg=BRAND_ORANGE)

    img = Image.open(png_path).convert("RGBA")
    n = len(matrix)
    quiet_px = QUIET_MODULES * PITCH
    inset_w_px = INSET_MODULES * PITCH
    inset_top_left = ((n - INSET_MODULES) // 2) * PITCH + quiet_px

    pad = 4
    ImageDraw.Draw(img).rectangle(
        [(inset_top_left - pad, inset_top_left - pad),
         (inset_top_left + inset_w_px + pad,
          inset_top_left + inset_w_px + pad)],
        fill=WHITE + (255,),
    )
    logo = Image.open(LOGO_PATH).convert("RGBA")
    logo_scaled = logo.resize((inset_w_px, inset_w_px), Image.LANCZOS)
    img.paste(logo_scaled, (inset_top_left, inset_top_left), logo_scaled)
    img.convert("RGB").save(png_path)


def render_plain(matrix, png_path: Path, svg_path: Path) -> None:
    r = Renderer(len(matrix))
    design_D01_classic(matrix, r)
    r.save(png_path, svg_path)


def render_halftone(url: str, png_path: Path, version: int = 5) -> None:
    """amzqr — image-encoded QR. PNG only, no SVG (amzqr emits raster)."""
    try:
        from amzqr import amzqr
    except ImportError as e:
        raise RuntimeError(
            "amzqr is not installed. Run "
            "`python -m pip install -r scripts\\requirements-qr.txt`."
        ) from e
    png_path.parent.mkdir(parents=True, exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()):
        amzqr.run(
            words=url, version=version, level="H",
            picture=str(LOGO_PATH), colorized=True,
            save_name=png_path.name, save_dir=str(png_path.parent),
        )


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

def _try_zbar(image_path: Path) -> str:
    try:
        from pyzbar.pyzbar import decode
        from PIL import Image
    except ImportError as e:
        return f"skip ({e.name} not installed)"
    try:
        results = decode(Image.open(image_path))
    except Exception as e:
        return f"error: {e}"
    if not results:
        return "FAIL"
    return f"ok: {results[0].data.decode('utf-8', errors='replace')[:30]}..."


def _try_opencv(image_path: Path) -> str:
    try:
        import cv2
    except ImportError:
        return "skip (opencv not installed)"
    img = cv2.imread(str(image_path))
    if img is None:
        return f"error: imread None"
    detector = cv2.QRCodeDetector()
    data, _points, _ = detector.detectAndDecode(img)
    if not data:
        return "FAIL"
    return f"ok: {data[:30]}..."


_zxing_reader = None
_zxing_unavailable_reason: str | None = None


def _zxing_setup_once() -> None:
    """Probe pyzxing + java once. After this call, _zxing_reader is set
    to a usable BarCodeReader OR _zxing_unavailable_reason is a short
    string explaining why decoding will be skipped."""
    global _zxing_reader, _zxing_unavailable_reason
    if _zxing_reader is not None or _zxing_unavailable_reason is not None:
        return
    try:
        from pyzxing import BarCodeReader
    except ImportError:
        _zxing_unavailable_reason = "pyzxing not installed"
        return
    if shutil.which("java") is None and shutil.which("java.exe") is None:
        _zxing_unavailable_reason = "java not on PATH"
        return
    _zxing_reader = BarCodeReader()


def _try_zxing(image_path: Path) -> str:
    _zxing_setup_once()
    if _zxing_unavailable_reason:
        return f"skip ({_zxing_unavailable_reason})"
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            result = _zxing_reader.decode(str(image_path))
    except Exception as e:
        return f"error: {str(e)[:30]}"
    if not result:
        return "FAIL"
    payload = result[0].get("parsed") if isinstance(result, list) else None
    if isinstance(payload, bytes):
        payload = payload.decode("utf-8", errors="replace")
    if payload:
        return f"ok: {payload[:30]}..."
    return "FAIL"


def validate(image_path: Path) -> dict[str, str]:
    return {
        "zbar":   _try_zbar(image_path),
        "opencv": _try_opencv(image_path),
        "zxing":  _try_zxing(image_path),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

# (name, design-fn, extra_quiet_modules beyond the standard 4)
# Frame designs need extra canvas around the QR so the decoration sits
# outside the 4-module quiet zone the scanner relies on.
DESIGN_FUNCS = [
    ("D01_classic",          design_D01_classic,         0),
    ("D02_circles",          design_D02_circles,         0),
    ("D03_diamonds",         design_D03_diamonds,        0),
    ("D04_rounded_squares",  design_D04_rounded_squares, 0),
    ("D05_teardrops",        design_D05_teardrops,       0),
    ("D06_plus",             design_D06_plus,            0),
    ("D07_hexagons",         design_D07_hexagons,        0),
    ("D08_octagons",         design_D08_octagons,        0),
    ("D09_triangles_alt",    design_D09_triangles_alt,   0),
    ("D10_starhex",          design_D10_starhex,         0),
    ("D11_inverted_hex",     design_D11_inverted_hex,    0),
    ("D12_hex_grout",        design_D12_hex_grout,       0),
    ("D13_honeycomb_band",   design_D13_honeycomb_tile_band,  6),
    ("D14_bee_companion",    design_D14_bee_companion,        8),
    ("D15_bee_accents",      design_D15_bee_accents,     0),
    # E-series: truehex aesthetic + simple bee silhouette
    ("E01_truehex_bee_above",     design_E01_truehex_bee_above,        10),
    ("E02_truehex_bee_below",     design_E02_truehex_bee_below,        10),
    ("E03_hexqr_with_bee_above",  design_E03_hexqr_with_bee_above,     10),
    ("E04_truehex_bee_corner",    design_E04_truehex_bee_corner,       10),
    ("E05_subtle_stagger_bee",    design_E05_subtle_stagger_with_bee,  10),
    # F-series: HighFive bee+hex-frame logo overlay (laser-clean B/W)
    ("F01_honeycomb_highfive",    design_F01_honeycomb_with_highfive_inset, 0),
]


def _run_candidate(name: str, png: Path, svg: Path | None,
                   render_fn) -> tuple[str, dict[str, str]]:
    """Render a single candidate, then validate. A render exception
    surfaces in the dedicated render column. A validate exception is
    written into each of the three decoder columns (rather than
    collapsed into the render column) so the table row still aligns
    and the reader can see rendering succeeded — even though every
    decoder column is reporting the same crash."""
    try:
        if svg is None:
            render_fn(png)
        else:
            render_fn(png, svg)
    except Exception as e:
        return (name, {"render": f"error: {e}"})
    try:
        return (name, validate(png))
    except Exception as e:
        msg = f"validate-crashed: {e}"
        return (name, {"zbar": msg, "opencv": msg, "zxing": msg})


def main() -> int:
    # pyzxing logs every decode failure at root.ERROR. Silence it here
    # (not at module import) so the script is a clean library citizen
    # if anything ever reuses make_matrix, Renderer, or validate.
    logging.getLogger().setLevel(logging.CRITICAL)

    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    matrix, version = make_matrix(url, ec_level="H")
    n = len(matrix)
    print(f"URL: {url}")
    print(f"QR  : version={version}, modules={n}x{n}, ECC=H")
    print(f"Out : {OUTPUT_DIR}\n")

    rows: list[tuple[str, dict[str, str]]] = []

    # First round (kept for reference): option_* candidates.
    legacy = [
        ("option_0_plain",
         lambda png, svg: render_plain(matrix, png, svg)),
        ("option_3_honeycomb",
         lambda png, svg: render_honeycomb(matrix, png, svg)),
        ("option_3_truehex",
         lambda png, svg: render_true_hex_grid(matrix, png, svg)),
        ("option_5_hex_inset",
         lambda png, svg: render_hex_with_inset(matrix, png, svg)),
    ]
    for name, fn in legacy:
        png = OUTPUT_DIR / f"{name}.png"
        svg = OUTPUT_DIR / f"{name}.svg"
        rows.append(_run_candidate(name, png, svg, fn))

    # Halftone is render-only via amzqr (no SVG); kept as a control.
    halftone_png = OUTPUT_DIR / "option_4_halftone.png"
    rows.append(_run_candidate(
        "option_4_halftone", halftone_png, None,
        lambda p: render_halftone(url, p, version=version),
    ))

    # Laser-cut creative batch.
    for name, fn, extra_quiet in DESIGN_FUNCS:
        png = OUTPUT_DIR / f"{name}.png"
        svg = OUTPUT_DIR / f"{name}.svg"
        def _render(p, s, _fn=fn, _q=extra_quiet):
            r = Renderer(n, quiet=QUIET_MODULES + _q)
            _fn(matrix, r)
            r.save(p, s)
        rows.append(_run_candidate(name, png, svg, _render))

    # Print the result table
    name_w = max((len(n) for n, _ in rows), default=22)
    print(f"{'candidate':<{name_w}}  {'zbar':<38} {'opencv':<38} {'zxing':<38}")
    print("-" * (name_w + 2 + 38 * 3 + 2))
    for name, r in rows:
        if "render" in r:
            print(f"{name:<{name_w}}  {r['render']}")
            continue
        print(f"{name:<{name_w}}  "
              f"{r.get('zbar', ''):<38} "
              f"{r.get('opencv', ''):<38} "
              f"{r.get('zxing', ''):<38}")

    print()
    print(f"PNGs (for visual inspection) and SVGs (laser-cutter ready) at:")
    print(f"  {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
