import os
import time
import random
from datetime import datetime
from flask import Flask, jsonify, request
import duckdb
import requests

from services.duckdb import DuckDBService
from services.discord import send_discord_message

app = Flask(__name__)

UPLOAD_FOLDER = os.getenv("IMAGE_STORE_PATH", "/data/images")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

DB_PATH = os.getenv("DUCKDB_PATH", "./data/app.duckdb")
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
    conn = duckdb.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(
        """
        UPDATE module_configs
        SET battery_level = ?,
            first_online = ?,
            image_count = image_count + 1
        WHERE id = ?
        """,
        (battery, datetime.now().strftime("%Y-%m-%d"), module_id),
    )
    conn.commit()
    conn.close()


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

    # Check if this is the module's first upload
    is_first_upload = False
    try:
        conn = duckdb.connect(DB_PATH)
        count = conn.execute(
            """
            SELECT COUNT(*) FROM daily_progress dp
            JOIN nest_data nd ON dp.nest_id = nd.nest_id
            WHERE nd.module_id = ?
            """,
            (mac,),
        ).fetchone()[0]
        conn.close()
        is_first_upload = count == 0
    except Exception:
        pass

    # Save image to volume
    file_path = os.path.join(UPLOAD_FOLDER, image.filename)
    image.save(file_path)

    # Run classification stub (replace with MaskRCNN later)
    classification = stub_classify()

    # Post results to DuckDB service
    payload = {"modul_id": mac, "classification": classification}
    url = "http://duckdb-service:8000/add_progress_for_module"
    requests.post(url, json=payload)

    # Update module battery and online status
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
        "classification": classification,
    }), 200


if __name__ == "__main__":
    test_duckdb()
    debug = os.getenv("DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=4444, debug=debug)
