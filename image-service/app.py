import os
import time
import random
import json
import glob
from datetime import datetime
from flask import Flask, jsonify, request
from requests import RequestException

from services.duckdb import DuckDBService
from services.discord import send_discord_message

app = Flask(__name__)

UPLOAD_FOLDER = os.getenv("IMAGE_STORE_PATH", "/data/images")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

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
        battery = int(battery)
    except ValueError:
        return jsonify({"error": "battery must be an integer"}), 400

    if not (0 <= battery <= 100):
        return jsonify({"error": "battery must be between 0 and 100"}), 400

    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    image = request.files["image"]
    if image.filename == "":
        return jsonify({"error": "No selected file"}), 400

    # Check if this is the module's first upload via duckdb-service.
    # Tolerate transient duckdb-service failures: if we can't determine the
    # count, assume "not first" so we don't spam Discord on flaky network.
    is_first_upload = False
    try:
        count = duckdb_service.get_progress_count(mac)
        is_first_upload = count == 0
    except RequestException:
        pass

    # Save image to volume
    file_path = os.path.join(UPLOAD_FOLDER, image.filename)
    image.save(file_path)

    # Persist optional ESP telemetry beside the image
    logs_raw = request.form.get("logs")
    if logs_raw:
        try:
            # Parse so the sidecar is valid JSON even if ESP sends garbage
            logs_obj = json.loads(logs_raw)
        except ValueError:
            logs_obj = {"raw": logs_raw, "parse_error": True}
        logs_obj["_mac"] = mac
        logs_obj["_received_at"] = datetime.now().isoformat(timespec="seconds")
        logs_obj["_image"] = image.filename
        try:
            with open(file_path + ".log.json", "w", encoding="utf-8") as f:
                json.dump(logs_obj, f, ensure_ascii=False)
        except OSError as exc:
            print(f"[logs] failed to write sidecar for {image.filename}: {exc}")

    # Run classification stub (replace with MaskRCNN later)
    classification = stub_classify()

    # Post results to DuckDB service
    payload = {"modul_id": mac, "classification": classification}
    try:
        duckdb_service.add_progress_for_module(payload)
    except RequestException:
        pass

    # Update module battery and online status via duckdb-service heartbeat.
    # Tolerate transient failures: a missed heartbeat shouldn't fail the upload.
    try:
        duckdb_service.heartbeat(mac, battery)
    except RequestException:
        pass

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
        "classification": classification,
    }), 200


@app.get("/modules/<mac>/logs")
def get_module_logs(mac: str):
    """
    Returns the most recent ESP telemetry entries for a module, newest-first.
    Reads the .log.json sidecar files written by /upload.
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
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        if str(data.get("_mac")) != str(mac):
            continue
        entries.append((st.st_mtime, data))

    entries.sort(key=lambda t: t[0], reverse=True)
    return jsonify([e[1] for e in entries[:limit]]), 200


if __name__ == "__main__":
    test_duckdb()
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=4444, debug=debug)
