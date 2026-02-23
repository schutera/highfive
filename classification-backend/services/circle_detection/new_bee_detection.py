import cv2
import numpy as np
from dataclasses import dataclass


EXPECTED_W, EXPECTED_H = 791, 528

REGIONS = [
    ("black_masked_bee", 1, (44, 28, 208, 192)),
    ("black_masked_bee", 2, (44, 192, 208, 356)),
    ("black_masked_bee", 3, (44, 356, 208, 520)),
    ("resin_bee", 1, (236, 28, 400, 192)),
    ("resin_bee", 2, (236, 192, 400, 356)),
    ("resin_bee", 3, (236, 356, 400, 520)),
    ("leafcutter_bee", 1, (420, 28, 584, 192)),
    ("leafcutter_bee", 2, (420, 192, 584, 356)),
    ("leafcutter_bee", 3, (420, 356, 584, 520)),
    ("orchard_bee", 1, (591, 28, 755, 192)),
    ("orchard_bee", 2, (591, 192, 755, 356)),
    ("orchard_bee", 3, (591, 356, 755, 520)),
]

COL_ORDER = ["black_masked_bee", "resin_bee", "leafcutter_bee", "orchard_bee"]


@dataclass
class Thresholds:
    v_black: int = 55
    s_green: int = 35
    green_score: int = 10


def _ensure_expected_size(img, expected_w=EXPECTED_W, expected_h=EXPECTED_H):
    h, w = img.shape[:2]
    if (w, h) == (expected_w, expected_h):
        return img, 1.0, 1.0

    sx = expected_w / float(w)
    sy = expected_h / float(h)

    # Keep aspect ratio by scaling to fit, then pad/crop to exact expected size
    s = min(sx, sy)
    new_w = int(round(w * s))
    new_h = int(round(h * s))
    resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

    canvas = np.zeros((expected_h, expected_w, 3), dtype=resized.dtype)
    x0 = max(0, (expected_w - new_w) // 2)
    y0 = max(0, (expected_h - new_h) // 2)

    x1 = min(expected_w, x0 + new_w)
    y1 = min(expected_h, y0 + new_h)

    canvas[y0:y1, x0:x1] = resized[0:(y1 - y0), 0:(x1 - x0)]
    return canvas, s, s


def _hough_one_circle(gray):
    h, w = gray.shape[:2]
    m = min(h, w)
    min_r = max(10, int(m * 0.22))
    max_r = int(m * 0.48)

    g = cv2.medianBlur(gray, 5)
    circles = cv2.HoughCircles(
        g,
        cv2.HOUGH_GRADIENT,
        dp=1.2,
        minDist=m * 0.8,
        param1=120,
        param2=40,
        minRadius=min_r,
        maxRadius=max_r,
    )
    if circles is None:
        return None

    circles = np.uint16(np.around(circles[0, :]))
    cx0, cy0 = w / 2.0, h / 2.0

    def score(c):
        cx, cy, r = c
        dist = (cx - cx0) ** 2 + (cy - cy0) ** 2
        return (int(r) * 100000) - int(dist)

    x, y, r = map(int, max(circles, key=score))
    return x, y, r


def _contour_circle(gray):
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=1)

    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None

    c = max(cnts, key=cv2.contourArea)
    (x, y), r = cv2.minEnclosingCircle(c)
    return int(x), int(y), int(r)


def _classify_filled_hsv(bgr, x, y, r, t: Thresholds, inner_shrink=0.80):
    h, w = bgr.shape[:2]
    x = int(np.clip(x, 0, w - 1))
    y = int(np.clip(y, 0, h - 1))
    r = int(max(3, r))
    r_in = max(3, int(r * inner_shrink))

    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.circle(mask, (x, y), r_in, 255, -1)

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    S = hsv[:, :, 1]
    V = hsv[:, :, 2]

    meanS = cv2.mean(S, mask=mask)[0]
    meanV = cv2.mean(V, mask=mask)[0]

    B, G, R = cv2.split(bgr)
    meanR = cv2.mean(R, mask=mask)[0]
    meanG = cv2.mean(G, mask=mask)[0]
    meanB = cv2.mean(B, mask=mask)[0]
    green_score = meanG - (meanR + meanB) / 2.0

    if meanV < t.v_black:
        status = "unfilled"
    else:
        status = "filled" if (meanS >= t.s_green or green_score >= t.green_score) else "unfilled"

    metrics = {
        "meanV": float(meanV),
        "meanS": float(meanS),
        "green_score": float(green_score),
        "meanR": float(meanR),
        "meanG": float(meanG),
        "meanB": float(meanB),
    }
    return status, metrics


def detect_one_circle(img_bgr, thresholds=Thresholds(), overlay=True):
    img = img_bgr.copy()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    det = _hough_one_circle(gray)
    if det is None:
        det = _contour_circle(gray)

    if det is None:
        h, w = gray.shape[:2]
        det = (w // 2, h // 2, int(min(h, w) * 0.35))

    x, y, r = det
    status, metrics = _classify_filled_hsv(img, x, y, r, thresholds)

    color = (0, 255, 0) if status == "filled" else (0, 0, 255)
    cv2.circle(img, (x, y), r, color, 2)
    cv2.circle(img, (x, y), 2, (255, 0, 0), 3)

    if overlay:
        txt = f"{status}"
        cv2.putText(img, txt, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2, cv2.LINE_AA)
        cv2.putText(img, txt, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)

    result = {"x": int(x), "y": int(y), "radius": int(r), "status": status, **metrics}
    return result, img


def _pad_to_same(images, pad_value=0):
    hs = [im.shape[0] for im in images]
    ws = [im.shape[1] for im in images]
    H, W = max(hs), max(ws)
    out = []
    for im in images:
        h, w = im.shape[:2]
        out.append(
            cv2.copyMakeBorder(
                im, 0, H - h, 0, W - w,
                cv2.BORDER_CONSTANT, value=(pad_value, pad_value, pad_value)
            )
        )
    return out


def crop_12_classify_and_montage(image_path, thresholds=Thresholds(), draw_labels=True):
    img0 = cv2.imread(image_path)
    if img0 is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    img, _, _ = _ensure_expected_size(img0, EXPECTED_W, EXPECTED_H)
    H, W = img.shape[:2]

    pos = {(lab, i): (i - 1, COL_ORDER.index(lab)) for lab in COL_ORDER for i in (1, 2, 3)}
    slots = [[None for _ in range(4)] for _ in range(3)]
    results = []

    for label, idx, (x0, y0, x1, y1) in REGIONS:
        x0c, y0c = max(0, x0), max(0, y0)
        x1c, y1c = min(W, x1), min(H, y1)

        crop = img[y0c:y1c, x0c:x1c].copy()
        det, annotated = detect_one_circle(crop, thresholds=thresholds, overlay=True)

        status = det["status"]
        if draw_labels:
            cv2.putText(annotated, f'{label}: {idx}', (6, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(annotated, f'{label}: {idx}', (6, 38), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 0), 1, cv2.LINE_AA)

        results.append({
            "label": label,
            "index": idx,
            "bbox": (x0, y0, x1, y1),
            "circle": {"x": det["x"], "y": det["y"], "radius": det["radius"]},
            "status": status,
            "metrics": {k: det[k] for k in ("meanV", "meanS", "green_score", "meanR", "meanG", "meanB")},
        })

        r, c = pos[(label, idx)]
        slots[r][c] = annotated

    flat = [slots[r][c] for r in range(3) for c in range(4)]
    if any(im is None for im in flat):
        raise RuntimeError("Montage slots incomplete.")

    flat = _pad_to_same(flat, pad_value=0)
    it = iter(flat)
    rows = [cv2.hconcat([next(it) for _ in range(4)]) for _ in range(3)]
    montage = cv2.vconcat(rows)

    return results, montage

import json

def results_to_bee_json(results):
    """
    Convert flat results list into nested JSON:
    Bee -> index (1,2,3) -> status
    """
    out = {}

    for r in results:
        bee = r["label"]
        idx = str(r["index"])
        status = r["status"]

        if bee not in out:
            out[bee] = {}

        out[bee][idx] = status

    return out

def encode_bee_json_binary(bee_json):
    out = {}
    for bee, holes in bee_json.items():
        out[bee] = {}
        for idx, status in holes.items():
            out[bee][idx] = 1 if str(status).lower() == "filled" else 0
    return out

# Testrun
# if __name__ == "__main__":
#     thresholds = Thresholds()

#     results, montage = crop_12_classify_and_montage(
#         "mock_not_filled.png",
#         thresholds=thresholds,
#         draw_labels=True
#     )

#     cv2.imwrite("montage.png", montage)

#     bee_json = results_to_bee_json(results)

#     print(json.dumps(bee_json, indent=2))