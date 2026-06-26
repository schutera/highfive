# ADR-026: Hole detection — OpenCV HoughCircles + per-nest snips, no ML yet

## Status

Accepted

## Context

`image-service`'s `stub_classify()` returned **random** `0/1` per nest, and
those random values fed the sealed-% progress bars users already see
(issue #165, phase 2 of the engagement story #154). We needed real per-nest
empty/sealed values and per-nest imagery on the **public** dashboard — without
authentication, which #154 explicitly rules out.

Constraints and prior art:

- The nesting block is laser-cut and the camera mount fixed, so hole geometry is
  near-deterministic — but camera pose varies per module and captures arrive at
  VGA (640×480) or UXGA (1600×1200), never the 791×528 of the stale hand-measured
  `dev-tools/circle.txt`.
- Showing a full frame leaks garden/house background → would force auth. A
  **cropped** snip of just the hole shows no background, so it can stay public.
- The long-planned MaskRCNN/ML pipeline (#112) is not ready, and the stored
  snips are exactly the labelled patches needed to bootstrap it later.

## Decision

Detect holes on upload with **OpenCV `HoughCircles`** (headless), snap detections
to a 4×4 grid — all in **normalized coordinates** so the same logic works at any
resolution. When too few circles are found (below a quorum) the detector returns
**no detection** and the pipeline falls back to the stub; it does **not**
fabricate a fixed grid. (An earlier cut did fabricate one, which on real
low-contrast captures produced 16 wood-sampled "sealed" snips — see Consequences
and chapter 11.) Bee type is assigned **by measured hole diameter** (rows ordered by
median radius → the canonical ascending-size order), not by absolute position, so
labelling survives pose/orientation drift. Empty vs sealed is a **binary
brightness+texture heuristic** (`sealed = brightness_ratio ≥ R OR std ≥ S`):
an empty hole is a dark smooth void, a sealed plug is brighter and/or textured.
Each hole is cropped to a JPEG **snip**; snips are stored with full history in a
new `nest_detections` table (sole writer = duckdb-service, ADR-001) and served
publicly via `/api/snips/:filename`. The existing `POST /add_progress_for_module`
contract is **unchanged** — only the values become real. Detection degrades
gracefully: any failure yields no snips and falls back to the stub, so `/upload`
never 500s. No ML model ships here.

## Consequences

- **Real dashboard data, public per-nest imagery, zero new auth.** The sealed-%
  bars stop being random; the 4×4 snip grid (`NestSnipGrid`) shows cropped holes.
- **Resolution- and pose-robust without per-module calibration**, because both
  the diameter-based labelling and the fallback grid are relative/normalized.
- **New runtime dependency:** `opencv-python-headless` + `numpy` in image-service,
  and a `libglib2.0-0` system package in the container (headless still links
  glib). Slightly larger image; CPU-only inference is negligible vs ESP latency.
- **Full detection history retained** (`nest_detections` is append-only, folded
  to latest-per-nest on read), which directly enables the phase-3 time-lapse
  (#166) and gives the future ML model (#112) labelled training crops.
- **The heuristic is approximate.** The smallest top-row holes remain hard
  (#155/#12); they degrade to whatever the brightness/texture call yields rather
  than failing. When the real model lands it replaces only the `HoleDetector`
  internals — the storage, serving, and wire shapes stay.
- **Real captures aren't reliably readable yet.** Real ESP fixtures
  (`dev-tools/real_captures/`) showed the mock-tuned params find too few circles,
  and there is no single Hough config that fits both the high-contrast mocks and
  the low-contrast real images. The detector therefore **degrades to no-detection**
  on real captures today (honest blank, not a fabricated grid). Robust real-image
  detection — a grid-fitting / candidate-selection stage plus a labelled
  real-capture corpus for the empty/sealed heuristic — is follow-up work. The
  earlier fixed-grid fabrication was removed because it turned a detection miss
  into confident garbage on the public dashboard (chapter 11 lesson).
