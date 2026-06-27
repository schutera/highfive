# ADR-028: ML inference is server-side only — the ESP runs no models

## Status

Accepted

## Context

The hole-detection pipeline now runs a learned **YOLO26n-seg** model
([ADR-027](adr-027-hole-detection-model.md)), and more learned components are on
the roadmap (a per-hole empty/sealed classifier — ADR-027 future work; anomaly /
hatching-prediction models, #116/#117). Where that inference runs — on the
ESP32-CAM in the field, or centrally on the server — is an architectural fork
worth fixing **explicitly**, before someone wires a model into firmware.

The ESP32-CAM is a deliberately thin field node: it captures a JPEG
(`esp_camera_fb_get`) and uploads it, plus an hourly heartbeat. It ships **no ML
code today** and runs on a tight watchdog budget (capture + upload + heartbeat in
~10–25 s, [ADR-007](adr-007-esp-reliability-breaker-and-daily-reboot.md)) with
only ~80 KB free heap in steady state. On-device inference (esp-dl /
TFLite-Micro) would contend with that budget, bloat the OTA binary, and — most
importantly — pin the model to the **firmware-release cadence**
([ADR-008](adr-008-firmware-ota-partition-and-rollback.md)): every retrain would
need a fleet OTA (forward-only, no field rollback) instead of a server redeploy.

The model is also already centralized: it is baked into the `image-service` image
(`image-service/models/hole_detector.onnx`), trained and re-exported via
`dev-tools/ml_hole_detection/`, and runs against the **stored** upload — not the
live frame — so it can be re-run over the whole image history
(`scripts/backfill_detections.py`).

## Decision

**All AI/ML inference is server-side. The ESP firmware runs no models.**

- The ESP32-CAM only **captures and uploads** images (and telemetry). It performs
  no detection, classification, or neural inference on-device. No `esp-dl`,
  TFLite-Micro, or model weights ship in the firmware.
- Every learned component — the YOLO26n-seg hole detector today, the future
  empty/sealed classifier, and any anomaly/phenology models — runs **centrally**
  in the Python services (`image-service` for image models), against the stored
  upload, behind the lean `onnxruntime` (no torch/ultralytics in the service
  image). Models are versioned in the repo and updated by a **server redeploy**,
  never a fleet OTA.
- **UI surfacing of detections, when shown, is an overlay drawn on the original
  image in the Admin view** — not a new public-facing artifact. The existing
  per-nest snip crops ([ADR-026](adr-026-hole-detection-snips.md)) remain the
  public, no-auth mechanism (a crop leaks no garden/house background, #154); any
  *new* detection visualization (boxes / masks / labels over the full frame)
  belongs in the **authenticated Admin view** as an overlay, where showing the
  full capture is acceptable.

## Consequences

- **Firmware stays thin and OTA-light.** No model weights or inference runtime in
  the ESP binary; the watchdog budget and heap headroom are unaffected. A model
  improvement is a server redeploy, decoupled from the irreversible, forward-only
  firmware OTA path.
- **Models iterate freely.** Retrain → re-export ONNX → redeploy `image-service`,
  and `backfill_detections.py` re-scores the entire image history — none of which
  is possible if inference were frozen into field firmware.
- **The ESP keeps uploading full frames** (already the case): server-side
  inference needs the image, so on-device cropping/inference is explicitly out of
  scope. Bandwidth/storage stay a server concern.
- **Detection visualization is Admin-only, as an overlay.** Public per-nest
  imagery stays the cropped snips (no background leak, #154); richer box/mask
  overlays render on the full image inside the authenticated Admin view — keeping
  the privacy rule intact.
- If on-device inference is ever genuinely required (e.g. a capture-gating "is a
  nest block even in frame?" check to avoid wasted uploads), it must **supersede
  this ADR** with a new one stating the trade-off — it is not something to add ad
  hoc.
