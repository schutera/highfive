from flask import Blueprint, jsonify
from db.connection import DB_PATH

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def health():
    return jsonify(ok=True, db=DB_PATH), 200
