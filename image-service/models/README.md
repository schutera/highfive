# image-service models

`hole_detector.onnx` — the learned **YOLO26n-seg** nest-hole detector (single
class `hole`), exported from the training pipeline and run by
[`services/hole_detection.py`](../services/hole_detection.py) through
`onnxruntime` (CPU). It **localizes** every nest hole on an ESP32-CAM block
capture so the upload pipeline can crop a per-nest snip from each. See
[ADR-027](../../docs/09-architecture-decisions/adr-027-hole-detection-model.md)
and the pipeline chapter
[`docs/05-building-block-view/hole-detection-model.md`](../../docs/05-building-block-view/hole-detection-model.md).

## Why the artifact is committed here

The training stack (ultralytics + torch) is **dev-only**; the service ships only
this ~11 MB ONNX plus the lean `onnxruntime`. Baking the model into the image (the
`Dockerfile` `COPY . .` carries `models/`) makes the service reproducible across
docker / CI / localhost / prod with no download step. `HOLE_MODEL_PATH` overrides
the path for a volume-mounted model.

## Provenance / how to regenerate

|                  |                                                                                   |
| ---------------- | --------------------------------------------------------------------------------- |
| Architecture     | YOLO26n-seg, single class `hole`, input 640×640 (letterboxed)                     |
| Export           | end2end / NMS-free graph, opset 19 (`output0 = [1,300,38]`)                       |
| Held-out metrics | Box mAP50 0.993, Mask mAP50 0.993, recall 0.97 (20 val images)                    |
| Source weights   | `dev-tools/ml_hole_detection/runs/holes_yolo26n_seg/weights/best.pt` (gitignored) |

Regenerate after any retraining you intend to ship:

```powershell
# in the dev-tools training venv (see dev-tools/ml_hole_detection/requirements.txt)
python dev-tools/ml_hole_detection/export_onnx.py
docker compose up -d --build image-service
```

`export_onnx.py` writes the ONNX here; the rebuild bakes it into the image. The
`onnxruntime` parse in `services/hole_detection.py` is verified bit-for-bit
against ultralytics' own inference on the real captures (dev-tools parity probe).
