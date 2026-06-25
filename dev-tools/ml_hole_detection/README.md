# Hole-detection model — labelling → training pipeline (#165)

Trains the ML model that locates **nest holes** in ESP32-CAM block captures (every hole,
**empty or filled**), so `image-service` can crop a per-nest snip from each. It replaces the
classical `HoughCircles` detector ([`image-service/services/hole_detection.py`](../../image-service/services/hole_detection.py))
that could not find holes on real captures (single fixed radius band, no block ROI — see the
chapter-11 lesson).

**Architecture, rationale, and process flowcharts** live in arc42 →
[`docs/05-building-block-view/hole-detection-model.md`](../../docs/05-building-block-view/hole-detection-model.md).
**This file is the hands-on runbook** (an agent can run the pipeline top to bottom from here).

## Pipeline (run order)

```
label (annotator)  →  prepare_dataset.py (split)  →  train.py  →  best.pt  →  export_onnx.py  →  image-service ONNX
```

All commands are run from this folder (`dev-tools/ml_hole_detection/`).

### 0. One-time setup — venv

```powershell
cd dev-tools\ml_hole_detection
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# Optional GPU (much faster training): run the CUDA `--index-url` line from requirements.txt.
.\.venv\Scripts\python.exe -c "import torch; print('cuda', torch.cuda.is_available())"
```

### 1. Label the captures

Label with **digitalsreeni-image-annotator** — an open-source PyQt6 app with
**Grounding DINO + SAM 2.1** AI-assisted labelling:
<https://github.com/bnsreenu/digitalsreeni-image-annotator>. Single class `hole`; hand-clean any
fixture/wing holes (outside the nest block). **Export COCO JSON** (recommended) or **YOLO (v5+)**.

### 2. Build the split dataset

```powershell
# from a COCO export (default = seg / polygon labels from the SAM masks):
.\.venv\Scripts\python.exe prepare_dataset.py --coco <export>\annotations.json

# …or from a YOLO export (re-splits it — see the note below):
.\.venv\Scripts\python.exe prepare_dataset.py --yolo <export>\YOLO
```

Writes `dataset/holes_seg/` — `images|labels/{train,val}` + `data.yaml` (`nc: 1, names: [hole]`),
deterministic ~80/20 split by filename CRC (same export → same split). `--task detect` writes
bboxes instead of polygons; `--overlay DIR` also draws every label on its image for a QA check.

> **What the prep step does / what it modifies.** Ultralytics can't train on COCO directly, and
> the annotator's **YOLO export puts _all_ images in `train` with an empty `val`** — Ultralytics
> then errors `val: Error loading data from .../images/val`. `prepare_dataset.py` only
> **reformats + adds the train/val split** — _no content change_, every labelled hole carried
> 1:1, no ROI / fixture filtering (the model learns to ignore fixture holes from the cleaned
> labels). Upstream request to split on export: digitalsreeni-image-annotator#83.

### 3. Train

```powershell
.\.venv\Scripts\python.exe train.py                       # YOLO26n-seg, auto GPU/CPU
.\.venv\Scripts\python.exe train.py --model yolo11n-seg.pt   # no-upgrade fallback
```

Trains **YOLO26n-seg** (latest Ultralytics — NMS-free, faster CPU inference, strong small-object
recall for the ~8 px top-row holes) on `dataset/holes_seg/data.yaml`. Early-stops on val plateau
(`--patience 40`). Output: `runs/<name>/weights/best.pt` + metrics.

### 4. Export to ONNX (deploy)

```powershell
.\.venv\Scripts\python.exe export_onnx.py
# → image-service\models\hole_detector.onnx ; then rebuild the image:
#   docker compose up -d --build image-service
```

`image-service` runs the model as **ONNX through the lean `onnxruntime`** (no torch/ultralytics in
the service image). `export_onnx.py` converts `best.pt` to an end2end ONNX (opset 19, NMS-free) and
copies it to the committed `image-service/models/hole_detector.onnx`. The service's
`HoleDetector().detect()` parse is verified bit-for-bit against ultralytics on the real captures.
Run this (and rebuild the image) after every retraining you intend to ship.

- **Augmentation** (on by default, all CLI-overridable, all label-safe for a single
  geometry-independent class): rotation `--degrees`, zoom `--scale`, translation, shear,
  perspective, horizontal **and** vertical flip (`--flipud` — the block mounts either way),
  brightness `--hsv_v`, colour temperature `--hsv_h` (hue), saturation `--hsv_s`, mosaic.
  **Contrast** comes from the auto-applied `albumentations` pipeline (CLAHE / brightness-contrast).
- **Validation** runs every epoch: per-epoch **train + val losses** (seg/box/cls) land in
  `runs/<name>/results.csv` and are plotted in `results.png`.

## Current model

YOLO26n-seg on the 97-capture hand-cleaned set (two block geometries — 21-hole 7/5/5/4 and
16-hole 4×4), early-stopped at epoch 176/216, ~6 min on an RTX 4070. Held-out (20 val imgs,
405 holes): **Box mAP50 0.993 / mAP50-95 0.905**, **Mask mAP50 0.993 / mAP50-95 0.67**, recall
0.97. Finds every hole on unseen captures across warm/dark/daylight, no fixture false positives.

> Split caveat: the `b0696…` captures are a dense time-lapse, so a random split can put
> near-duplicate frames in both train and val — making val loss slightly optimistic. For a
> stricter measure, hold out a contiguous time block or a whole separate module.

## Layout

```
dev-tools/ml_hole_detection/
├── README.md            # this runbook
├── prepare_dataset.py   # annotator COCO|YOLO export → split YOLO dataset (no ROI)
├── train.py             # Ultralytics YOLO26n-seg training (run in the venv)
├── export_onnx.py       # best.pt → image-service/models/hole_detector.onnx (deploy)
├── requirements.txt     # tooling deps (opencv/numpy + ultralytics/albumentations) — dev only
├── dataset/holes_seg/   # built dataset (gitignored — images/labels not committed)
├── runs/                # Ultralytics training output incl. best.pt (gitignored)
└── .venv/               # local virtualenv (gitignored)
```

## Runtime integration (done — ADR-027)

The model is live in `image-service`: `export_onnx.py` deploys the ONNX, and
`HoleDetector().detect(path) -> DetectionResult` runs it via `onnxruntime`, emitting one `Snip`
per detected hole with `state = "undetermined"` and an empty `classification` (the progress bars
keep the stub — empty/sealed is deferred). The snip plumbing (duckdb `nest_detections`, backend
`/api/snips` + `/api/modules/:id/snips`, `contracts` `NestSnip`, homepage `NestSnipGrid`) is
reused unchanged. **Next:** a learned empty/sealed classifier. Details:
[`docs/05-building-block-view/hole-detection-model.md`](../../docs/05-building-block-view/hole-detection-model.md).
