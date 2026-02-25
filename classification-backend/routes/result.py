from flask import Blueprint, jsonify

# Blueprint erstellen
result_route = Blueprint("result", __name__, url_prefix="/debug")

from services.state import bee_json_state

@result_route.get("/result")
def get_result():
    return jsonify({"classification": bee_json_state}), 200