# ADR-027: Hole detection — learned YOLO26n-seg model, DINO+SAM labelling

## Status

Accepted. Supersedes the OpenCV `HoughCircles` **detector** of
[ADR-026](adr-026-hole-detection-snips.md) (ADR-026's snip storage/serving
architecture still stands).

## Context

ADR-026's `HoughCircles` detector cannot find holes on real ESP32-CAM captures: a
single fixed radius band only covers the largest hole row, there is no block ROI,
and one band can't span the real ~4–22 px radius range — so every real capture
degraded to no-detection and the feature did nothing (see
[chapter 11 → Lessons learned](../11-risks-and-technical-debt/README.md)).
Constraints: `image-service` runs **CPU-only** on a 7.7 GB host, single-threaded
Flask, one upload per module per day (nginx 60 s timeout). Real blocks vary
(4×4 = 16 holes and irregular 7/5/5/4 = 21 holes; either mount orientation;
warm/tungsten/daylight/dark lighting). Options weighed: tune the classical
detector (rejected — proven mis-fit); run Grounding-DINO/SAM **live** in prod
(rejected — +~2–3 GB torch/transformers, RAM + latency risk); or label with
DINO+SAM and train a small detector to run in prod (chosen).

## Decision

Label holes (single class `hole`) in the open-source `digitalsreeni-image-annotator`
(Grounding-DINO + SAM 2.1), hand-cleaning fixture holes; convert + 80/20-split the
export with `prepare_dataset.py`; train an Ultralytics **YOLO26n-seg** instance
segmenter offline under `dev-tools/ml_hole_detection/`, then **export it to an
end2end ONNX** (`export_onnx.py`) that `image-service` runs behind the existing
`HoleDetector().detect()` seam through the lean **`onnxruntime`** — torch and
ultralytics (the training stack) never enter the service image. The model
_localizes_ holes (one snip per detected hole); the empty-vs-sealed call is
deferred, so each snip is `state = "undetermined"` (a neutral badge) and the
`classification` dict is left empty (the species progress bars keep the stub).
Process, flowcharts, and commands:
[05-building-block-view/hole-detection-model.md](../05-building-block-view/hole-detection-model.md).

## Consequences

- (+) Works on real captures: held-out mask mAP50 0.993, recall 0.97, across the
  lighting range and both block geometries; no fixture false positives (learned
  from the cleaned labels, so **no inference-time ROI is needed**).
- (+) Small + fast in prod: the committed ONNX is ~11 MB and infers in ~50 ms on
  CPU (`onnxruntime`, 2 threads) — three orders of magnitude under the nginx 60 s
  ceiling, so it fits the CPU-only / 7.7 GB host.
- (+) Lean service image: only `onnxruntime` + the ONNX ship; torch/ultralytics
  stay in the dev-only training venv. The ONNX parse is verified bit-for-bit
  against ultralytics on the real captures.
- (+) Retrainable: more field captures → re-run `prepare_dataset.py` → `train.py`
  → `export_onnx.py` → rebuild the image; per-epoch val loss + early stopping
  make convergence measurable.
- (−) Adds an offline ML toolchain (torch/ultralytics) and a labelling step. The
  `.pt` weights are a gitignored build output; the deployed `.onnx` (~11 MB) is
  committed at `image-service/models/` so the image is reproducible with no
  download step.
- (−) Empty-vs-sealed classification is **deferred**: the model only localizes,
  so snips are `undetermined` and the species progress bars still run on the
  stub. A learned classifier is the next step.
