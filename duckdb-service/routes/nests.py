from flask import Blueprint, jsonify

from db.repository import query_all

nests_bp = Blueprint("nests", __name__)


@nests_bp.get("/nests")
def get_nests():
    nests = query_all("SELECT * FROM nest_data")
    return jsonify(nests=nests), 200
