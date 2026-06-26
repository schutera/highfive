"""Hole detection + per-nest snip extraction for the image-service (#165, ADR-027).

Runs the **learned YOLO26n-seg** detector (single class ``hole``), exported to
ONNX and executed through the lean ``onnxruntime`` — no torch/ultralytics in the
service image. The classical ``HoughCircles`` detector this replaces could not
find holes on real ESP captures (one fixed radius band, no block ROI); the model
locates every hole — empty or filled equally — across the warm/tungsten/daylight/
dark range and both block geometries. Training + export pipeline and how the ONNX
is regenerated: ``dev-tools/ml_hole_detection/`` and
``docs/05-building-block-view/hole-detection-model.md``.

The detector does four things:

1. **Locate** every nest hole with the ONNX model. The exported graph is
   end2end (YOLO26 is NMS-free): ``output0`` is ``[1, 300, 4+1+1+32]`` =
   ``[x1, y1, x2, y2, conf, cls, *mask_coeffs]`` in letterboxed-640 px. We read
   only the box columns (snips are rectangular crops), un-letterbox to source
   pixels, drop sub-``_CONF_THRES`` rows, and apply one conservative NMS pass
   (``_NMS_IOU``) to remove export-precision duplicate boxes. Verified
   bit-for-bit against ultralytics' own inference on the real captures.
2. **Label** each hole's bee type *by measured diameter*: holes are clustered
   into rows, rows ordered by median radius ascending and mapped onto the
   canonical bee-type order (``black_masked_bee`` < ``resin_bee`` <
   ``leafcutter_bee`` < ``orchard_bee``). Diameter-driven labelling is robust to
   camera pose / block orientation (the block mounts large-on-top *or*
   small-on-top); nest index is left-to-right within a row. Unlike the old
   detector there is **no fixed 4-per-row cap** — the real blocks are irregular
   (rows of 7/5/5/4 = 21 holes, or 4x4 = 16), so every detected hole is kept.
3. **Crop** a tight per-hole snip (JPEG bytes). The crop is the privacy
   mechanism (#154): a snip shows only the hole, no garden/house background, so
   per-nest imagery stays on the public dashboard without auth.
4. **Defer classification.** The model localizes; it does not call empty vs
   sealed. Each snip's ``state`` is ``"undetermined"`` and the aggregate
   ``classification`` dict is left empty, so ``UploadPipeline`` keeps using the
   stub for the progress bars while the *snips* become real. A learned
   empty/sealed classifier is future work (ADR-027).

Everything downstream of the box is in **normalized coordinates** (fractions of
the image dimensions) so the same logic works at VGA (640x480), UXGA, or any
resolution.

Graceful degradation is a hard contract (#165 acceptance criterion): any failure
here — missing onnxruntime/OpenCV, an absent/corrupt model, an unreadable image,
zero detections — returns an empty :class:`DetectionResult` (no snips) rather
than raising, so ``/upload`` never 500s on a detection problem. The caller
(``UploadPipeline``) treats an empty classification as "leave existing behaviour".
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# onnxruntime / OpenCV / numpy are heavy native deps; import defensively so a
# misconfigured image without them degrades to "no detection" instead of
# crashing import of the whole image-service.
try:
    import cv2
    import numpy as np
    import onnxruntime as ort

    _RUNTIME_AVAILABLE = True
except Exception:  # pragma: no cover - exercised only on a broken install
    _RUNTIME_AVAILABLE = False


# ---- Canonical bee-type order, ascending by hole diameter -----------------
#
# Mirrors `homepage/src/types/index.ts` BEE_TYPES (2/3/6/9 mm) and the
# `BEE_TYPE_MAP` keys in `duckdb-service/models/progress.py`. The wire keys below
# are what `POST /add_progress_for_module` and the snip rows expect; the row with
# the smallest measured radius maps to index 0 (`black_masked_bee`).
BEE_TYPES_BY_SIZE: tuple[str, ...] = (
    "black_masked_bee",  # 2 mm
    "resin_bee",  # 3 mm
    "leafcutter_bee",  # 6 mm
    "orchard_bee",  # 9 mm
)

NUM_BEE_TYPES = 4  # one row of holes per bee type (4 species)

# Wire-key -> canonical DB bee type. Inverse of duckdb-service's `BEE_TYPE_MAP`
# (`duckdb-service/models/progress.py`); duplicated here the same way `ModuleId`
# is, since image-service can't import duckdb-service. Snip rows store the DB key
# so `nest_detections.bee_type` matches `nest_data.beeType`.
BEE_TYPE_WIRE_TO_DB: dict[str, str] = {
    "black_masked_bee": "blackmasked",
    "resin_bee": "resin",
    "leafcutter_bee": "leafcutter",
    "orchard_bee": "orchard",
}

# Snip state when the model only localizes (no empty/sealed call yet). Must be in
# duckdb-service `routes/detections.py::_VALID_STATES` and the `NestSnip.state`
# union in `contracts/src/index.ts`, or the snip row is dropped / unrenderable.
STATE_UNDETERMINED = "undetermined"

# ---- Model + inference tuning ---------------------------------------------
#
# The ONNX is baked into the image at build time (Dockerfile copies models/);
# HOLE_MODEL_PATH overrides for a volume-mounted model. Regenerate it with
# `dev-tools/ml_hole_detection/export_onnx.py` after retraining.
_DEFAULT_MODEL_PATH = (
    Path(__file__).resolve().parents[1] / "models" / "hole_detector.onnx"
)
_MODEL_PATH = os.getenv("HOLE_MODEL_PATH") or str(_DEFAULT_MODEL_PATH)
# onnxruntime defaults to every core; cap it — this box runs four services and
# the upload path is once-per-module-per-day, so a 50 ms -> 100 ms inference is
# irrelevant but a core spike is not. Override with HOLE_MODEL_THREADS.
_NUM_THREADS = max(1, int(os.getenv("HOLE_MODEL_THREADS", "2")))

_IMGSZ = 640  # the model's fixed square input; captures are letterboxed to it
_CONF_THRES = 0.25  # min detection confidence (matches the validated export)
_NMS_IOU = 0.7  # dedupe export-precision duplicate boxes; provably never merges
#                 distinct neighbours (their box IoU is < 0.6 on the real blocks)
_PAD_VALUE = 114  # letterbox fill, matching ultralytics

_SNIP_PAD = 1.25  # crop half-extent = radius * this, so the snip frames the hole
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
    state: str  # "empty" | "sealed" | "undetermined"
    confidence: float  # 0-1; model detection confidence for this hole
    jpeg: bytes


@dataclass
class DetectionResult:
    """Output of :meth:`HoleDetector.detect`.

    ``classification`` keeps the *existing* wire contract shape consumed by
    ``POST /add_progress_for_module`` — ``{bee_type: {"1": 0|1, ...}}``. The
    learned detector only localizes (no empty/sealed call yet), so it leaves this
    empty: the pipeline then keeps the stub for the progress bars while the
    ``snips`` become real. ``ok`` stays False on the localize-only path by design.
    """

    classification: dict[str, dict[str, int]] = field(default_factory=dict)
    snips: list[Snip] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return bool(self.classification)


class HoleDetector:
    """Detects nest holes and extracts per-nest snips from a capture.

    The ONNX session is loaded once (lazily, on first ``detect``) and reused; a
    single instance is safe to share across requests. A missing/broken model or
    runtime degrades to no-detection rather than raising.
    """

    def __init__(self, model_path: str | None = None):
        self._model_path = model_path or _MODEL_PATH
        self._session = None
        self._load_failed = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, image_path: str) -> DetectionResult:
        """Run the full pipeline on ``image_path``.

        Never raises: any failure (missing runtime/model, unreadable image,
        inference error) returns an empty :class:`DetectionResult` so ``/upload``
        stays a 200. See the module docstring's graceful-degradation contract.
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
        if not _RUNTIME_AVAILABLE:
            print(
                "[hole_detection] onnxruntime/OpenCV not available; skipping detection",
                flush=True,
            )
            return DetectionResult()

        session = self._session_or_none()
        if session is None:
            return DetectionResult()

        bgr = cv2.imread(image_path)
        if bgr is None:
            print(f"[hole_detection] could not read image {image_path}", flush=True)
            return DetectionResult()

        h, w = bgr.shape[:2]
        dets = self._infer(session, bgr)  # (N, 4): cx, cy, r, conf  (source px)
        if dets.shape[0] == 0:
            print(
                f"[hole_detection] model found no holes in {image_path}; "
                "degrading to no-detection",
                flush=True,
            )
            return DetectionResult()

        holes = self._assign_to_grid(dets)
        if not holes:
            return DetectionResult()

        snips: list[Snip] = []
        for bee_type, nest_index, (x, y, r), conf in holes:
            jpeg = self._crop_snip(bgr, x, y, r, w, h)
            if not jpeg:
                continue
            snips.append(
                Snip(
                    bee_type=bee_type,
                    nest_index=nest_index,
                    bbox=self._normalized_bbox(x, y, r, w, h),
                    state=STATE_UNDETERMINED,
                    confidence=round(float(conf), 3),
                    jpeg=jpeg,
                )
            )

        # Localize-only: leave `classification` empty so the pipeline keeps the
        # stub for the progress bars; the snips above are the real output.
        return DetectionResult(classification={}, snips=snips)

    def _session_or_none(self):
        """Lazily build and cache the onnxruntime session; None if unavailable."""
        if self._session is not None:
            return self._session
        if self._load_failed:
            return None
        if not os.path.isfile(self._model_path):
            print(
                f"[hole_detection] model not found at {self._model_path}; "
                "skipping detection",
                flush=True,
            )
            self._load_failed = True
            return None
        try:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = _NUM_THREADS
            opts.inter_op_num_threads = 1
            self._session = ort.InferenceSession(
                self._model_path, opts, providers=["CPUExecutionProvider"]
            )
            self._input_name = self._session.get_inputs()[0].name
            print(
                f"[hole_detection] loaded model {self._model_path} "
                f"({_NUM_THREADS} threads)",
                flush=True,
            )
            return self._session
        except Exception as exc:  # noqa: BLE001 - degrade on a broken model
            print(
                f"[hole_detection] failed to load model {self._model_path}: {exc!r}",
                flush=True,
            )
            self._load_failed = True
            return None

    def _infer(self, session, bgr):
        """Run the ONNX model on one image; return (N, 4) of cx, cy, r, conf in
        source pixels, deduped. Mirrors the dev-tools parity probe exactly."""
        blob, scale, pad_left, pad_top = self._letterbox(bgr)
        out0 = session.run(None, {self._input_name: blob})[0][0]  # (300, 38)
        keep = out0[:, 4] >= _CONF_THRES
        rows = out0[keep]
        if rows.shape[0] == 0:
            return np.zeros((0, 4), dtype=np.float32)

        boxes = rows[:, :4].astype(np.float32).copy()  # x1, y1, x2, y2 (letterboxed)
        h, w = bgr.shape[:2]
        boxes[:, [0, 2]] = ((boxes[:, [0, 2]] - pad_left) / scale).clip(0, w)
        boxes[:, [1, 3]] = ((boxes[:, [1, 3]] - pad_top) / scale).clip(0, h)
        scores = rows[:, 4].astype(np.float32)

        keep_idx = self._nms(boxes, scores, _NMS_IOU)
        boxes, scores = boxes[keep_idx], scores[keep_idx]

        cx = (boxes[:, 0] + boxes[:, 2]) / 2.0
        cy = (boxes[:, 1] + boxes[:, 3]) / 2.0
        r = (boxes[:, 2] - boxes[:, 0] + boxes[:, 3] - boxes[:, 1]) / 4.0
        return np.stack([cx, cy, r, scores], axis=1)

    def _letterbox(self, bgr):
        """Resize-with-padding to the model's square input; return the NCHW blob
        plus the scale and left/top pad needed to map boxes back to source px."""
        h, w = bgr.shape[:2]
        scale = min(_IMGSZ / h, _IMGSZ / w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        resized = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR)
        canvas = np.full((_IMGSZ, _IMGSZ, 3), _PAD_VALUE, dtype=np.uint8)
        top, left = (_IMGSZ - nh) // 2, (_IMGSZ - nw) // 2
        canvas[top : top + nh, left : left + nw] = resized
        blob = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
        blob = np.transpose(blob, (2, 0, 1))[None]  # NCHW
        return np.ascontiguousarray(blob), scale, left, top

    @staticmethod
    def _nms(boxes, scores, iou_thres: float):
        """Greedy NMS by descending score; returns kept indices. Used only to
        drop near-duplicate boxes (IoU >= iou_thres) the end2end export can emit
        for one hole — distinct neighbours overlap far less, so they survive."""
        order = scores.argsort()[::-1]
        keep: list[int] = []
        while order.size:
            i = int(order[0])
            keep.append(i)
            if order.size == 1:
                break
            rest = order[1:]
            ious = np.array([_iou(boxes[i], boxes[j]) for j in rest])
            order = rest[ious < iou_thres]
        return keep

    def _assign_to_grid(self, dets):
        """Cluster detections into rows, label by diameter, index by x.

        ``dets`` is an (N, 4) array of ``(cx, cy, r, conf)``. Rows are formed by
        clustering on ``y``; each row is ordered by ``x`` (nest index). Rows are
        sorted by their *median radius ascending* and mapped onto
        :data:`BEE_TYPES_BY_SIZE`, so the bee-type label is driven by measured
        hole diameter (resolution- and orientation-robust), not absolute
        position. No per-row cap: the real blocks are irregular (7/5/5/4, 4x4),
        so every detected hole in the four size-rows is kept.

        Returns a list of ``(bee_type, nest_index, (x, y, r), conf)``.
        """
        rows = self._cluster_rows(dets)
        # Order rows by measured diameter ascending -> bee type ascending.
        rows.sort(key=lambda row: float(np.median([c[2] for c in row])))

        # The real blocks have exactly four size-rows (one per bee type). If
        # y-clustering ever splits one into a 5th, the slice below keeps the four
        # smallest-radius rows and drops the rest — log it so the silent drop is
        # visible rather than reading as a clean (but wrong) relabelling.
        if len(rows) > NUM_BEE_TYPES:
            print(
                f"[hole_detection] clustered {len(rows)} rows (> {NUM_BEE_TYPES} "
                f"bee types); keeping the {NUM_BEE_TYPES} smallest-radius rows",
                flush=True,
            )

        holes: list[tuple[str, int, tuple[int, int, int], float]] = []
        for row_idx, row in enumerate(rows[:NUM_BEE_TYPES]):
            bee_type = BEE_TYPES_BY_SIZE[row_idx]
            ordered = sorted(row, key=lambda c: c[0])  # by x -> nest index
            for nest_idx, (x, y, r, conf) in enumerate(ordered, start=1):
                holes.append(
                    (bee_type, nest_idx, (int(x), int(y), int(r)), float(conf))
                )
        return holes

    def _cluster_rows(self, dets):
        """Greedy 1-D clustering of detections into rows by their y-coordinate."""
        ordered = sorted((tuple(float(v) for v in c) for c in dets), key=lambda c: c[1])
        median_r = float(np.median([c[2] for c in dets])) or 1.0
        row_gap = median_r * 1.2  # a new row starts when y jumps more than this

        rows: list[list[tuple[float, float, float, float]]] = []
        current: list[tuple[float, float, float, float]] = []
        last_y: float | None = None
        for c in ordered:
            if last_y is not None and (c[1] - last_y) > row_gap:
                rows.append(current)
                current = []
            current.append(c)
            last_y = c[1]
        if current:
            rows.append(current)
        return rows

    def _crop_snip(self, bgr, x: int, y: int, r: int, width: int, height: int) -> bytes:
        pad = int(r * _SNIP_PAD)
        x0, y0 = max(0, x - pad), max(0, y - pad)
        x1, y1 = min(width, x + pad), min(height, y + pad)
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


def _iou(a, b) -> float:
    """IoU of two (x1, y1, x2, y2) boxes."""
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / ua) if ua > 0 else 0.0
