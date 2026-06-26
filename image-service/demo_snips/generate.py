#!/usr/bin/env python3
"""Generate the synthetic demo nest snips used by the #166 time-lapse seed.

Deterministic (seeded) so reruns are byte-stable. NOT real captures and NOT
model output — a hand-drawn `empty -> undetermined -> sealed` progression for one
leafcutter hole so a freshly-seeded dev stack / Playwright run has frames to
scrub. See README.md. Run: ``python image-service/demo_snips/generate.py``.
"""

import math
import os
import random

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.dirname(os.path.abspath(__file__))
SIZE = 200


def _wood_bg() -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), (196, 170, 132))
    d = ImageDraw.Draw(img)
    for x in range(0, SIZE, 3):
        shade = 150 + int(20 * math.sin(x / 7.0))
        d.line([(x, 0), (x, SIZE)], fill=(shade + 30, shade, shade - 25), width=1)
    return img.filter(ImageFilter.GaussianBlur(0.6))


def _base(img: Image.Image):
    d = ImageDraw.Draw(img)
    cx = cy = SIZE // 2
    r = 78
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(120, 100, 74), width=6)
    return cx, cy, r


def empty(seed: int) -> Image.Image:
    random.seed(seed)
    img = _wood_bg()
    cx, cy, r = _base(img)
    d = ImageDraw.Draw(img)
    ri = r - 8
    for rr in range(ri, 0, -1):
        t = rr / ri
        v = int(18 + 30 * t)
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(v, v - 4, v - 8))
    return img.filter(ImageFilter.GaussianBlur(0.8))


def undetermined(seed: int) -> Image.Image:
    img = empty(seed)
    random.seed(seed)
    cx, cy, r = SIZE // 2, SIZE // 2, 78
    d = ImageDraw.Draw(img)
    for _ in range(140):
        a = random.uniform(0, 2 * math.pi)
        rad = random.uniform(0, r - 30)
        x = cx + rad * math.cos(a)
        y = cy + rad * math.sin(a)
        g = (random.randint(90, 130), random.randint(95, 135), random.randint(60, 90))
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=g)
    return img.filter(ImageFilter.GaussianBlur(0.7))


def sealed(seed: int, fullness: float = 1.0) -> Image.Image:
    random.seed(seed)
    img = _wood_bg()
    cx, cy, r = _base(img)
    d = ImageDraw.Draw(img)
    ri = int((r - 10) * fullness)
    d.ellipse([cx - ri, cy - ri, cx + ri, cy + ri], fill=(150, 148, 110))
    for _ in range(420):
        a = random.uniform(0, 2 * math.pi)
        rad = random.uniform(0, ri)
        x = cx + rad * math.cos(a)
        y = cy + rad * math.sin(a)
        base_g = random.randint(120, 185)
        col = (base_g - 20, base_g, random.randint(80, 120))
        s = random.uniform(3, 7)
        d.ellipse([x - s, y - s, x + s, y + s], fill=col)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], fill=(180, 178, 140))
    return img.filter(ImageFilter.GaussianBlur(0.6))


FRAMES = {
    "demo-garten12-leaf1-2026-06-01.jpg": lambda: empty(1),
    "demo-garten12-leaf1-2026-06-08.jpg": lambda: empty(2),
    "demo-garten12-leaf1-2026-06-15.jpg": lambda: undetermined(3),
    "demo-garten12-leaf1-2026-06-22.jpg": lambda: sealed(4, 0.85),
    "demo-garten12-leaf1-2026-06-26.jpg": lambda: sealed(5, 1.0),
}


def main() -> None:
    for name, make in FRAMES.items():
        path = os.path.join(OUT, name)
        make().save(path, "JPEG", quality=85)
        print("wrote", name)


if __name__ == "__main__":
    main()
