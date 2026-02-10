from flask import Blueprint, jsonify

# Blueprint erstellen
result_route = Blueprint("result", __name__, url_prefix="/debug")

from services.state import circles_array

@result_route.get("/result")
def get_result():
    return jsonify({"circles": circles_array}), 200