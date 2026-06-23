# Real ESP32-CAM nest-block captures (hole detection, #165)

Real captures from deployed modules, kept as detection fixtures so the
`HoleDetector` (`image-service/services/hole_detection.py`) is exercised against
genuine input, not just the synthetic `dev-tools/mock_*.jpg`.

| File                     | Resolution | Notes                                  |
| ------------------------ | ---------- | -------------------------------------- |
| `block_warm_1024.jpg`    | 1024×768   | Warm/indoor white balance, slight blur |
| `block_tungsten_640.jpg` | 640×480    | Tungsten cast, visible wood cracks     |
| `block_daylight_640.jpg` | 640×480    | Cooler daylight, off-centre framing    |

## Why they matter (what they exposed)

These captures revealed that the mock-tuned `HoughCircles` parameters find **too
few circles** on real input (the tiny top-row holes are ~8 px and contrast is far
lower than the synthetic mock). The original detector then _fabricated_ a fixed
grid and reported 16 wood-sampled "sealed" snips — confident garbage on the
public dashboard. The fix: a quorum gate (`_MIN_CIRCLES_QUORUM`) that degrades to
**no detection** instead of fabricating. `test_real_capture_never_fabricates_a_full_sealed_grid`
pins that safety floor.

## Known limitation / follow-up

There is **no single Hough configuration** that fits both the high-contrast
synthetic mocks and these low-contrast real captures (strict params miss the real
holes; loose params explode into false circles on the mock and on wood cracks).
Robust real-image detection needs:

1. a candidate-selection / 4×4 grid-fitting stage (reject crack/shadow circles,
   fill the regular lattice), and
2. a larger **labelled** real-capture corpus (per-hole empty/sealed ground truth)
   to calibrate and regression-test the empty-vs-sealed heuristic.

Until then the detector degrades honestly on real captures rather than guessing.
See ADR-026 and the module docstring.

## Labelling workflow (recalibration loop)

To recalibrate against reality instead of the mocks:

1. Drop a real **4×4** capture here (ideally straight from a module, so the
   resolution/optics match production — not a phone photo).
2. Copy `*.labels.example.json` to `<image>.labels.json` and fill in `grid` and
   the list of `sealed` holes as 1-based `[row, col]` (row 1 = top, col 1 =
   left). Everything not listed is treated as empty.
3. Run the harness from the repo root:

   ```
   python dev-tools/calibrate_holes.py            # report per image
   python dev-tools/calibrate_holes.py --overlay  # also draw detected circles
   ```

   It prints, per capture, whether detection fired, how many holes it kept, and
   predicted-vs-labelled sealed counts. `--overlay` writes `<image>_overlay.png`
   so you can see exactly where circles landed vs the real holes.

4. Tune `image-service/services/hole_detection.py` (Hough params, quorum,
   grid-fitting, the empty/sealed thresholds) until every capture fires and
   `pred_sealed == truth_sealed`, then promote the best captures into the
   regression test.

A handful of labelled captures spanning the lighting/white-balance range
(warm/tungsten/daylight) is enough to start. Until they exist the detector
degrades to no-detection on real input rather than guessing.

## Ground-truth note

The block geometry varies across field units — some captures show a **wider**
block than the canonical 4×4 — so labels must be tied to a specific fixture image
(and that image's actual grid) before they can drive a test.
