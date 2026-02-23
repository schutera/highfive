import os
from pathlib import Path
from flask import Flask, jsonify, request

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
duckdb = DuckDBService()

import time


def test_duckdb(retries: int = 20, delay: float = 0.5):
    for i in range(retries):
        try:
            print("Testing DuckDB service…")
            print("DuckDB health:", duckdb.health())
            return True
        except Exception as e:
            if i == retries - 1:
                print("DuckDB connection failed:", e)
                return False
            time.sleep(delay)


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
    # Elias -> hier mit 1 (filled) und 0 (unfilled)
    # Das ist der Output
    #     {
    #     "classification": {
    #         "black_masked_bee": {
    #             "1": 1,
    #             "2": 1,
    #             "3": 1
    #         },
    #         "leafcutter_bee": {
    #             "1": 0,
    #             "2": 0,
    #             "3": 1
    #         },
    #         "orchard_bee": {
    #             "1": 0,
    #             "2": 0,
    #             "3": 0
    #         },
    #         "resin_bee": {
    #             "1": 1,
    #             "2": 0,
    #             "3": 1
    #         }
    #     }
    # }

    bee_binary = encode_bee_json_binary(bee_json)
    payload = {"modul_id": "hive-001", "classification": bee_binary["classification"]}
    url = "http://127.0.0.1:8000/add_progress_for_module"
    requests.post(url, json=payload)

    bee_json_state.clear()
    bee_json_state.update(bee_json)

    # debug preview
    if debug:
        push_frame(montage)

    # upload original image
    s3.upload("validation", file_path, delete=True)

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


@app.post("/sample_classification")
def sample_classification():
    file_path = (
        "/Users/eliaspfeiffer/Developer/highfive/mock-hive/mock_fully_filled.jpg"
    )

    results, montage = crop_12_classify_and_montage(file_path)
    bee_json = results_to_bee_json(results)
    bee_binary = encode_bee_json_binary(bee_json)

    if not isinstance(bee_json, dict):
        return {"error": "bee_json is not a dict"}

    payload = {
        "modul_id": "hive-001",
        "classification": bee_binary.get("classification", bee_binary),
    }

    url = "http://127.0.0.1:8000/add_progress_for_module"
    response = requests.post(url, json=payload)

    return {"sent_payload": payload, "backend_status": response.status_code}


if __name__ == "__main__":
    test_duckdb()
    app.run(host="0.0.0.0", port=4444, debug=debug)
