import glob
import json
import os
import random
import time

import requests as http_requests
from flask import Flask, jsonify, request, send_from_directory
from pydantic import ValidationError

from services.discord import send_discord_message
from services.duckdb import DuckDBService
from services.module_id import ModuleId
from services.sidecar import LogSidecarEnvelope
from services.upload_pipeline import UploadPipeline, UploadRequest

app = Flask(__name__)

UPLOAD_FOLDER = os.getenv("IMAGE_STORE_PATH", "/data/images")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

DUCKDB_SERVICE_URL = os.getenv("DUCKDB_SERVICE_URL", "http://duckdb-service:8000")
duckdb_service = DuckDBService()


def test_duckdb(retries: int = 20, delay: float = 0.5):
    for i in range(retries):
        try:
            print("Testing DuckDB service…")
            print("DuckDB health:", duckdb_service.health())
            return True
        except Exception as e:
            if i == retries - 1:
                print("DuckDB connection failed:", e)
                return False
            time.sleep(delay)


def stub_classify() -> dict:
    """Return dummy classification values. Replace with MaskRCNN later."""
    return {
        "black_masked_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "leafcutter_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "orchard_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "resin_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
    }


def _send_discord(content: str) -> None:
    """Indirection so tests can monkeypatch `app.send_discord_message` and
    have the pipeline pick up the replacement at call time."""
    send_discord_message(content)


upload_pipeline = UploadPipeline(
    upload_folder=UPLOAD_FOLDER,
    duckdb_service=duckdb_service,
    send_discord=_send_discord,
    classify=stub_classify,
)


@app.get("/health")
def health():
    """Liveness probe. Returns 200 once the Flask app is ready to serve.

    Does not verify downstream DuckDB connectivity — image-service can
    still queue uploads even if the DB is briefly unavailable. Use
    duckdb-service's /health for that check.
    """
    return jsonify({"ok": True, "service": "image-service"}), 200


@app.post("/upload")
def upload_image():
    mac = request.form.get("mac") or request.args.get("mac")
    battery = request.form.get("battery") or request.args.get("battery")
    if not mac:
        return jsonify({"error": "Missing parameter: mac"}), 400
    if not battery:
        return jsonify({"error": "Missing parameter: battery"}), 400
    try:
        battery = int(battery) if battery else None
    except ValueError:
        return jsonify({"error": "battery must be an integer"}), 400
    if not (0 <= battery <= 100):
        return jsonify({"error": "battery must be between 0 and 100"}), 400
    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400
    image = request.files["image"]
    if image.filename == "":
        return jsonify({"error": "No selected file"}), 400

    # Canonicalise the inbound mac via ``ModuleId``. Accepts the legacy
    # colon/dash forms too. Everything downstream (sidecar, duckdb-service
    # POSTs) sees the canonical 12-hex-char string.
    try:
        canonical_mac = ModuleId.model_validate(mac).root
    except ValidationError:
        return jsonify({"error": "invalid mac format"}), 400

    result = upload_pipeline.run(
        UploadRequest(
            mac=canonical_mac,
            battery=battery,
            image=image,
            logs_raw=request.form.get("logs"),
        )
    )
    return jsonify(
        {
            "message": f"Image {result.filename} uploaded successfully",
            "mac": canonical_mac,
            "battery": battery,
            "classification": result.classification,
        }
    ), 200


@app.get("/modules/<mac>/logs")
def get_module_logs(mac: str):
    """
    Returns the most recent ESP telemetry entries for a module, newest-first.
    Reads the .log.json sidecar files written by /upload.

    Backward-compatible: tolerates both the new envelope format and the
    legacy flat format (`_mac`, `_received_at`, `_image` at top level)
    written by older versions of /upload. All entries are returned in the
    new envelope shape.
    """
    try:
        limit = int(request.args.get("limit", 10))
    except ValueError:
        limit = 10
    limit = max(1, min(limit, 100))

    pattern = os.path.join(UPLOAD_FOLDER, "*.log.json")
    entries = []
    for path in glob.glob(pattern):
        try:
            st = os.stat(path)
        except OSError:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        envelope = LogSidecarEnvelope.from_disk(data)
        if envelope is None or str(envelope.mac) != str(mac):
            continue
        entries.append((st.st_mtime, envelope.model_dump()))

    entries.sort(key=lambda t: t[0], reverse=True)
    return jsonify([e[1] for e in entries[:limit]]), 200


@app.get("/images")
def list_images():
    """List all uploaded images, optionally filtered by ?module_id=, proxied from duckdb-service."""
    module_id = request.args.get("module_id")
    try:
        resp = http_requests.get(
            f"{DUCKDB_SERVICE_URL}/image_uploads",
            params={"module_id": module_id} if module_id else {},
            timeout=5,
        )
        return jsonify(resp.json()), resp.status_code
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.delete("/images/<path:filename>")
def delete_image(filename):
    """Delete an image's DB record then its on-disk file.

    Wire shape (closes #30):
      * 2xx from duckdb → row gone, remove the file, return 200.
      * 404 from duckdb → row already gone; remove the file if still
        present (idempotent cleanup) and return 404.
      * Any other non-2xx from duckdb (3xx redirect, 4xx other than
        404, 5xx) → leave the file in place and forward the upstream
        status. A retry by the caller sees a consistent file+row pair
        instead of an orphaned row pointing at a deleted file.
      * Network/timeout exception → 502, file untouched.
    """
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    try:
        resp = http_requests.delete(
            f"{DUCKDB_SERVICE_URL}/image_uploads/{filename}", timeout=5
        )
    except Exception as e:
        print(
            f"[delete_image] duckdb-service unreachable for {filename}: {e}",
            flush=True,
        )
        return jsonify({"error": "duckdb-service unreachable"}), 502

    if resp.status_code == 404:
        if os.path.isfile(file_path):
            os.remove(file_path)
        return jsonify({"error": "Image not found"}), 404

    if not (200 <= resp.status_code < 300):
        print(
            f"[delete_image] duckdb-service returned {resp.status_code} for {filename}: {resp.text[:200]}",
            flush=True,
        )
        return (
            jsonify({"error": f"duckdb-service returned {resp.status_code}"}),
            resp.status_code,
        )

    if os.path.isfile(file_path):
        os.remove(file_path)
    return jsonify({"message": "Image deleted"}), 200


@app.get("/images/<path:filename>")
def serve_image(filename):
    """Serve an image file from the upload folder."""
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    if not os.path.isfile(file_path):
        return jsonify({"error": "Image not found"}), 404
    return send_from_directory(UPLOAD_FOLDER, filename)


if __name__ == "__main__":
    test_duckdb()
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=4444, debug=debug)
