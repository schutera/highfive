import os
import time
import random
from datetime import datetime
from flask import Flask, jsonify, request, send_from_directory
import requests as http_requests

from services.duckdb import DuckDBService
from services.discord import send_discord_message

app = Flask(__name__)

UPLOAD_FOLDER = os.getenv("IMAGE_STORE_PATH", "/data/images")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

DUCKDB_SERVICE_URL = os.getenv("DUCKDB_SERVICE_URL", "http://127.0.0.1:8000")
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


def update_module(module_id: str, battery: int):
    try:
        http_requests.post(
            f"{DUCKDB_SERVICE_URL}/update_module_status",
            json={"module_id": module_id, "battery": battery},
            timeout=5,
        )
    except Exception as e:
        print(f"Warning: failed to update module: {e}")


def stub_classify() -> dict:
    """Return dummy classification values. Replace with MaskRCNN later."""
    return {
        "black_masked_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "leafcutter_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "orchard_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
        "resin_bee": {str(i): random.choice([0, 1]) for i in range(1, 5)},
    }


@app.post("/upload")
def upload_image():
    mac = request.form.get("mac") or request.args.get("mac")
    battery = request.form.get("battery") or request.args.get("battery")

    if not mac:
        return jsonify({"error": "Missing parameter: mac"}), 400
    try:
        battery = int(battery) if battery else None
    except ValueError:
        battery = None

    if battery is not None and not (0 <= battery <= 100):
        battery = None

    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    image = request.files["image"]
    if image.filename == "":
        return jsonify({"error": "No selected file"}), 400

    # Check if this is the module's first upload via duckdb-service
    is_first_upload = False
    try:
        resp = http_requests.get(
            f"{DUCKDB_SERVICE_URL}/image_uploads",
            params={"module_id": mac},
            timeout=5,
        )
        if resp.ok:
            is_first_upload = len(resp.json().get("images", [])) == 0
    except Exception:
        pass

    # Save image with module prefix for traceability
    safe_filename = f"{mac}_{image.filename}"
    file_path = os.path.join(UPLOAD_FOLDER, safe_filename)
    image.save(file_path)

    # Record upload via duckdb-service
    try:
        http_requests.post(
            f"{DUCKDB_SERVICE_URL}/record_image",
            json={"module_id": mac, "filename": safe_filename},
            timeout=5,
        )
    except Exception as e:
        print(f"Warning: failed to record image upload: {e}")

    # Classification disabled until real model is integrated
    # classification = stub_classify()
    # payload = {"modul_id": mac, "classification": classification}
    # http_requests.post(f"{DUCKDB_SERVICE_URL}/add_progress_for_module", json=payload)

    # Update module battery and online status
    if battery is not None:
        update_module(mac, battery)

    if is_first_upload:
        send_discord_message(
            f"📸 **First image received!**\n"
            f"Module **{mac}** just sent its first photo.\n"
            f"**Battery:** {battery}%\n"
            f"**File:** {image.filename}"
        )

    return jsonify({
        "message": f"Image {image.filename} uploaded successfully",
        "mac": mac,
        "battery": battery,
    }), 200


@app.get("/images")
def list_images():
    """List all uploaded images, proxied from duckdb-service."""
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
    """Delete an image file and its DB record."""
    file_path = os.path.join(UPLOAD_FOLDER, filename)
    # Delete DB record via duckdb-service
    try:
        resp = http_requests.delete(
            f"{DUCKDB_SERVICE_URL}/image_uploads/{filename}", timeout=5
        )
        if resp.status_code == 404:
            return jsonify({"error": "Image not found"}), 404
    except Exception as e:
        print(f"Warning: failed to delete image record: {e}")
    # Delete file
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
