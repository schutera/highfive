import os
from pathlib import Path
from flask import Flask, jsonify, request
import sys
import duckdb
from datetime import datetime

from routes.preview import preview_route, push_frame
from routes.dashboard import dashboard_route
from routes.result import result_route
from services.aws import AWSClient
from services.state import bee_json_state
from services.circle_detection.detect_circle import detect_circles
from services.circle_detection.new_bee_detection import (
    crop_12_classify_and_montage,
    results_to_bee_json,
    encode_bee_json_binary,
)

from services.duckdb import DuckDBService
import requests

# Load .env
debug = os.getenv("DEBUG", "false").lower() == "true"

app = Flask(__name__)

if debug:
    app.register_blueprint(preview_route)
    app.register_blueprint(dashboard_route)
    app.register_blueprint(result_route)

app.config["UPLOAD_FOLDER"] = os.path.abspath(
    "classification-backend/services/circle_detection/images"
)
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)

s3 = AWSClient()
duckdb_service = DuckDBService()

import time


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

def updateModule(id, battery):
    DB_PATH = os.getenv("DUCKDB_PATH", "./data/app.duckdb")
    conn = duckdb.connect(DB_PATH)
    cur = conn.cursor()

    now = datetime.now()
    formatted_date = now.strftime("%Y-%m-%d")

    cur.execute(
        """
        UPDATE module_configs
        SET battery_level = ?,
        first_online = ?
        WHERE id = ?
        """,
        (battery, formatted_date, id)
    )

    conn.commit()
    conn.close()


@app.post("/upload")
def upload_image():
    mac = request.form.get("mac") or request.args.get("mac")
    battery = request.form.get("battery") or request.args.get("battery")

    if not mac:
        return jsonify({"error": "Missing parameter: mac"}), 400

    if not battery:
        return jsonify({"error": "Missing parameter: battery"}), 400

    try:
        battery = float(battery)
    except ValueError:
        return jsonify({"error": "battery must be a float"}), 400

    if not (0 <= battery <= 1):
        return jsonify({"error": "battery must be between 0 and 1"}), 400

    if "image" not in request.files:
        return jsonify({"error": "No image file provided"}), 400

    image = request.files["image"]
    if image.filename == "":
        return jsonify({"error": "No selected file"}), 400

    file_path = os.path.join(app.config["UPLOAD_FOLDER"], image.filename)
    image.save(file_path)

    # ---------------------------
    # RUN CLASSIFICATION
    # ---------------------------
    results, montage = crop_12_classify_and_montage(file_path)
    bee_json = results_to_bee_json(results)
    bee_binary = encode_bee_json_binary(bee_json)

    if not isinstance(bee_json, dict):
        return {"error": "bee_json is not a dict"}

    payload = {
        "modul_id": mac,
        "classification": bee_binary.get("classification", bee_binary),
    }

    url = "http://duckdb-service:8000/add_progress_for_module"
    response = requests.post(url, json=payload)

    bee_json_state.clear()
    bee_json_state.update(bee_json)

    # debug preview
    if debug:
        push_frame(montage)

    # upload original image
    s3.upload("validation", file_path, delete=True)

    updateModule(mac, battery * 100) # * 100 becaudse db has battery level as INTEGER

    return (
        jsonify(
            {
                "message": f"Image {image.filename} uploaded successfully",
                "mac": mac,
                "battery": battery,
                "classification": bee_json,
            }
        ),
        200,
    )

if __name__ == "__main__":
    test_duckdb()
    app.run(host="0.0.0.0", port=4444, debug=debug)
