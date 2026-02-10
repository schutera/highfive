import threading
import time
from io import BytesIO

from flask import Blueprint, Response
from PIL import Image

preview_route = Blueprint("preview", __name__, url_prefix="/debug")

FPS = 5  # streaming framerate

# Shared global last frame
_last_frame = None
_lock = threading.Lock()


def push_frame(img_bgr):
    global _last_frame
    # convert BGR → RGB
    img_rgb = Image.fromarray(img_bgr[:, :, ::-1])
    with _lock:
        _last_frame = img_rgb


def _jpeg_bytes(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=80, optimize=True)
    return buf.getvalue()


def _frame_generator():
    global _last_frame
    w, h = 640, 360

    while True:
        with _lock:
            frame = _last_frame

        if frame is None:
            # fallback grey/black placeholder
            frame = Image.new("RGB", (w, h), (10, 10, 10))

        yield _jpeg_bytes(frame)
        time.sleep(1.0 / FPS)


@preview_route.get("/preview")
def index():
    return (
        "<!doctype html><meta charset='utf-8'>"
        "<body style='margin:0;display:flex;justify-content:center;"
        "align-items:center;height:100vh;background:#111;'>"
        "<img src='/debug/stream' style='max-width:100%;max-height:100%;"
        "object-fit:contain;border:3px solid #444;border-radius:8px;"
        "background:#000;'/>"
        "</body>"
    )


@preview_route.get("/stream")
def stream():
    boundary = "frame"
    gen = _frame_generator()

    def multipart():
        for jpg in gen:
            yield (
                b"--" + boundary.encode() + b"\r\n"
                b"Content-Type: image/jpeg\r\n"
                b"Content-Length: "
                + str(len(jpg)).encode()
                + b"\r\n\r\n"
                + jpg
                + b"\r\n"
            )

    return Response(
        multipart(), mimetype=f"multipart/x-mixed-replace; boundary={boundary}"
    )
