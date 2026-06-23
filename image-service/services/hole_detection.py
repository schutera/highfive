"""Hole detection + per-nest snip extraction for the image-service (issue #165).

Replaces the random ``stub_classify`` with a real, OpenCV-based detector that:

1. **Locates** the nest holes on an uploaded capture (``cv2.HoughCircles``),
   snapping detections to a 4x4 grid (4 bee types x 4 nest replicates). When
   detection is too weak it falls back to a normalized fixed grid (the
   resolution-independent successor to the stale hand-measured
   ``dev-tools/circle.txt``).
2. **Labels** each hole's bee type *by measured diameter* — rows are ordered by
   their median radius ascending and mapped onto the canonical bee-type order
   (``blackmasked`` 2 mm < ``resin`` 3 mm < ``leafcutter`` 6 mm <
   ``orchard`` 9 mm, mirroring ``homepage/src/types/index.ts``'s ``BEE_TYPES``).
   Doing it by diameter rather than by absolute y-position is what makes the
   labelling robust to camera pose / block orientation drift across modules.
3. **Classifies** each hole empty vs sealed with a brightness+texture heuristic:
   an empty hole is a dark, smooth void; a sealed one is a brighter and/or
   textured plug. ``sealed = (brightness_ratio >= R) OR (std >= S)`` so a
   shadowed-but-textured plug and a bright-smooth plug are both caught.
4. **Crops** a tight per-hole snip (JPEG bytes). The crop is the privacy
   mechanism (issue #154): a snip shows only the hole, no garden/house
   background, so per-nest imagery can stay on the public dashboard without auth.

Everything is computed in **normalized coordinates** (fractions of the image
dimensions) so the same logic works at VGA (640x480), UXGA (1600x1200), or the
791x528 mock fixtures.

Graceful degradation is a hard contract (issue #165 acceptance criterion): any
failure here returns an empty :class:`DetectionResult` (no snips, empty
classification) rather than raising, so ``/upload`` never 500s on a detection
problem. The caller (``UploadPipeline``) treats an empty classification as
"leave the existing behaviour"."""

from __future__ import annotations

from dataclasses import dataclass, field

# OpenCV / numpy are heavy native deps; import defensively so a misconfigured
# image without them degrades to "no detection" instead of crashing import of
# the whole image-service.
try:
    import cv2
    import numpy as np

    _CV_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only on a broken install
    _CV_AVAILABLE = False


# ---- Canonical bee-type order, ascending by hole diameter -----------------
#
# Mirrors `homepage/src/types/index.ts` BEE_TYPES (2/3/6/9 mm) and the
# `BEE_TYPE_MAP` keys in `duckdb-service/models/progress.py`. The wire keys
# below are what `POST /add_progress_for_module` expects; the row with the
# smallest measured radius maps to index 0 (`black_masked_bee`).
BEE_TYPES_BY_SIZE: tuple[str, ...] = (
    "black_masked_bee",  # 2 mm
    "resin_bee",  # 3 mm
    "leafcutter_bee",  # 6 mm
    "orchard_bee",  # 9 mm
)

MAX_NESTS_PER_TYPE = 4  # matches duckdb-service TARGET_NESTS_PER_TYPE

# Wire-key -> canonical DB bee type. Inverse of duckdb-service's `BEE_TYPE_MAP`
# (`duckdb-service/models/progress.py`); duplicated here the same way `ModuleId`
# is, since image-service can't import duckdb-service. The classification dict
# keeps the wire keys (the `/add_progress_for_module` contract); snip rows store
# the DB key so `nest_detections.bee_type` matches `nest_data.beeType`.
BEE_TYPE_WIRE_TO_DB: dict[str, str] = {
    "black_masked_bee": "blackmasked",
    "resin_bee": "resin",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
}

# ---- Detection tuning -----------------------------------------------------
#
# All radii / distances are fractions of the image WIDTH so the detector is
# resolution-robust. Calibrated against the 791x528 mock fixtures
# (`dev-tools/mock_fully_filled.jpg`, `mock_not_filled.png`) which produce a
# clean 12-circle (3x4) grid; real UXGA captures rescale the same fractions.
_HOUGH_DP = 1.2
_HOUGH_PARAM1 = 120
_HOUGH_PARAM2 = 40  # accumulator threshold; lower = more (false) circles
_MIN_DIST_FRAC = 0.12
_MIN_RADIUS_FRAC = 0.05
_MAX_RADIUS_FRAC = 0.095
_MEDIAN_BLUR_KSIZE = 5

# Below this many detected circles we don't trust the adaptive grid and fall
# back to the fixed normalized lattice.
_MIN_CIRCLES_FOR_GRID = 4

# ---- Empty vs sealed heuristic --------------------------------------------
#
# An empty hole is a dark, smooth void; a sealed plug is brighter and/or
# textured. Either signal alone marks "sealed" (logical OR) so a shadowed but
# textured plug (low brightness, high std) and a bright smooth plug are both
# classified sealed. Calibrated on the mocks: sealed holes have std ~39-54 and
# brightness ratio ~0.5-0.7; empty holes are (0, 0).
_SEALED_BRIGHTNESS_RATIO = 0.6  # hole_mean / wood_median above this => sealed
_SEALED_TEXTURE_STD = 20.0  # inner-disk std above this => sealed
_INNER_DISK_FRAC = 0.55  # sample brightness/texture within r * this

# ---- Fixed-grid fallback (replaces stale dev-tools/circle.txt) ------------
#
# Normalized 4x4 lattice of hole centres + radius, as fractions of (width,
# height) and width respectively. Used only when HoughCircles fails to find a
# usable set. These are approximate (the laser-cut block roughly fills the
# central frame) and SHOULD be recalibrated against a real capture from a
# representative module; see docs/05-building-block-view/image-service.md.
_FALLBACK_X_FRACS = (0.30, 0.44, 0.58, 0.72)  # 4 columns (nests)
_FALLBACK_Y_FRACS = (0.22, 0.42, 0.62, 0.82)  # 4 rows (bee types, top->bottom)
_FALLBACK_RADIUS_FRAC = 0.06

_SNIP_PAD = 1.25  # crop box = radius * this, so the snip frames the hole
_SNIP_JPEG_QUALITY = 85


@dataclass
class Snip:
    """One cropped nest hole plus its detection metadata.

    ``bbox`` is normalized ``(x, y, w, h)`` in [0, 1] relative to the source
    image, so consumers can re-derive pixel coordinates at any resolution.
    """

    bee_type: str  # wire key, e.g. "leafcutter_bee"
    nest_index: int  # 1-based
    bbox: tuple[float, float, float, float]
    state: str  # "empty" | "sealed"
    confidence: float  # 0-1; how strongly the sealed/empty call was made
    jpeg: bytes


@dataclass
class DetectionResult:
    """Output of :meth:`HoleDetector.detect`.

    ``classification`` keeps the *existing* wire contract shape consumed by
    ``POST /add_progress_for_module`` — ``{bee_type: {"1": 0|1, ...}}`` — so
    only the values become real; the contract is unchanged. Empty when
    detection produced nothing (the graceful-degradation path).
    """

    classification: dict[str, dict[str, int]] = field(default_factory=dict)
    snips: list[Snip] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.classification)


class HoleDetector:
    """Detects nest holes and extracts per-nest snips from a capture.

    Stateless and pure aside from reading the image off disk; safe to share a
    single instance across requests.
    """

    def detect(self, image_path: str) -> DetectionResult:
        """Run the full pipeline on ``image_path``.

        Never raises: any failure (missing OpenCV, unreadable image, OpenCV
        error) returns an empty :class:`DetectionResult` so ``/upload`` stays a
        200. See the module docstring's graceful-degradation contract.
        """
        try:
            return self._detect(image_path)
        except Exception as exc:  # noqa: BLE001 - degrade, never 500 the upload
            print(
                f"[hole_detection] detection failed for {image_path}: {exc!r}",
                flush=True,
            )
            return DetectionResult()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _detect(self, image_path: str) -> DetectionResult:
        if not _CV_AVAILABLE:
            print(
                "[hole_detection] OpenCV not available; skipping detection", flush=True
            )
            return DetectionResult()

        bgr = cv2.imread(image_path)
        if bgr is None:
            print(f"[hole_detection] could not read image {image_path}", flush=True)
            return DetectionResult()

        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        h, w = gray.shape[:2]
        wood_median = float(np.median(gray)) or 1.0

        circles = self._find_circles(gray, w)
        if circles is None or len(circles) < _MIN_CIRCLES_FOR_GRID:
            holes = self._fallback_grid(w, h)
        else:
            holes = self._assign_to_grid(circles)

        if not holes:
            return DetectionResult()

        snips: list[Snip] = []
        classification: dict[str, dict[str, int]] = {}
        for bee_type, nest_index, (x, y, r) in holes:
            state, confidence = self._classify_hole(gray, x, y, r, wood_median)
            jpeg = self._crop_snip(bgr, x, y, r, w, h)
            bbox = self._normalized_bbox(x, y, r, w, h)
            snips.append(
                Snip(
                    bee_type=bee_type,
                    nest_index=nest_index,
                    bbox=bbox,
                    state=state,
                    confidence=round(confidence, 3),
                    jpeg=jpeg,
                )
            )
            classification.setdefault(bee_type, {})[str(nest_index)] = (
                1 if state == "sealed" else 0
            )

        return DetectionResult(classification=classification, snips=snips)

    def _find_circles(self, gray, width: int):
        """Return an (N, 3) int array of ``(x, y, r)`` or None."""
        blurred = cv2.medianBlur(gray, _MEDIAN_BLUR_KSIZE)
        found = cv2.HoughCircles(
            blurred,
            cv2.HOUGH_GRADIENT,
            dp=_HOUGH_DP,
            minDist=max(1, int(width * _MIN_DIST_FRAC)),
            param1=_HOUGH_PARAM1,
            param2=_HOUGH_PARAM2,
            minRadius=max(1, int(width * _MIN_RADIUS_FRAC)),
            maxRadius=max(1, int(width * _MAX_RADIUS_FRAC)),
        )
        if found is None:
            return None
        return np.round(found[0]).astype(int)

    def _assign_to_grid(self, circles) -> list[tuple[str, int, tuple[int, int, int]]]:
        """Cluster detected circles into rows, label by diameter, index by x.

        Rows are formed by clustering on ``y``; each row is then ordered by
        ``x`` (nest index). Rows are sorted by their *median radius ascending*
        and mapped onto :data:`BEE_TYPES_BY_SIZE`, so the bee-type label is
        driven by measured hole diameter (resolution- and orientation-robust),
        not by absolute position.
        """
        rows = self._cluster_rows(circles)
        # Order rows by measured diameter ascending -> bee type ascending.
        rows.sort(key=lambda row: float(np.median([c[2] for c in row])))

        holes: list[tuple[str, int, tuple[int, int, int]]] = []
        for row_idx, row in enumerate(rows[:MAX_NESTS_PER_TYPE]):
            bee_type = BEE_TYPES_BY_SIZE[row_idx]
            ordered = sorted(row, key=lambda c: c[0])  # by x -> nest index
            for nest_idx, (x, y, r) in enumerate(ordered[:MAX_NESTS_PER_TYPE], start=1):
                holes.append((bee_type, nest_idx, (int(x), int(y), int(r))))
        return holes

    def _cluster_rows(self, circles) -> list[list[tuple[int, int, int]]]:
        """Greedy 1-D clustering of circles into rows by their y-coordinate."""
        ordered = sorted(
            (tuple(int(v) for v in c) for c in circles), key=lambda c: c[1]
        )
        median_r = float(np.median([c[2] for c in circles])) or 1.0
        row_gap = median_r * 1.2  # a new row starts when y jumps more than this

        rows: list[list[tuple[int, int, int]]] = []
        current: list[tuple[int, int, int]] = []
        last_y: int | None = None
        for c in ordered:
            if last_y is not None and (c[1] - last_y) > row_gap:
                rows.append(current)
                current = []
            current.append(c)
            last_y = c[1]
        if current:
            rows.append(current)
        return rows

    def _fallback_grid(
        self, width: int, height: int
    ) -> list[tuple[str, int, tuple[int, int, int]]]:
        """Place holes on the normalized fixed lattice (detection too weak)."""
        radius = max(1, int(width * _FALLBACK_RADIUS_FRAC))
        holes: list[tuple[str, int, tuple[int, int, int]]] = []
        for row_idx, yf in enumerate(_FALLBACK_Y_FRACS):
            bee_type = BEE_TYPES_BY_SIZE[row_idx]
            for nest_idx, xf in enumerate(_FALLBACK_X_FRACS, start=1):
                x = int(xf * width)
                y = int(yf * height)
                holes.append((bee_type, nest_idx, (x, y, radius)))
        return holes

    def _classify_hole(
        self, gray, x: int, y: int, r: int, wood_median: float
    ) -> tuple[str, float]:
        """Return ``("sealed"|"empty", confidence)`` for one hole."""
        rr = max(1, int(r * _INNER_DISK_FRAC))
        disk = gray[max(0, y - rr) : y + rr, max(0, x - rr) : x + rr]
        if disk.size == 0:
            return "empty", 0.0
        disk = disk.astype("float32")
        mean = float(disk.mean())
        std = float(disk.std())
        brightness_ratio = mean / wood_median
        texture_score = std / _SEALED_TEXTURE_STD

        sealed = (
            brightness_ratio >= _SEALED_BRIGHTNESS_RATIO or std >= _SEALED_TEXTURE_STD
        )
        # Confidence: how far past (or short of) the decision the stronger
        # signal sits, clamped to [0, 1].
        signal = max(brightness_ratio / _SEALED_BRIGHTNESS_RATIO, texture_score)
        confidence = max(0.0, min(1.0, signal if sealed else 1.0 - signal))
        return ("sealed" if sealed else "empty"), confidence

    def _crop_snip(self, bgr, x: int, y: int, r: int, width: int, height: int) -> bytes:
        pad = int(r * _SNIP_PAD)
        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(width, x + pad)
        y1 = min(height, y + pad)
        crop = bgr[y0:y1, x0:x1]
        if crop.size == 0:
            return b""
        ok, buf = cv2.imencode(
            ".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), _SNIP_JPEG_QUALITY]
        )
        return buf.tobytes() if ok else b""

    def _normalized_bbox(
        self, x: int, y: int, r: int, width: int, height: int
    ) -> tuple[float, float, float, float]:
        pad = r * _SNIP_PAD
        x0 = max(0.0, (x - pad) / width)
        y0 = max(0.0, (y - pad) / height)
        bw = min(1.0, (x + pad) / width) - x0
        bh = min(1.0, (y + pad) / height) - y0
        return (round(x0, 4), round(y0, 4), round(bw, 4), round(bh, 4))
