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

## Ground-truth note

Per-hole occupancy labels are still sparse. The block geometry also varies across
field units (some captures show a wider block than the canonical 4×4), so labels
must be tied to a specific fixture image before they can drive a per-hole test.
