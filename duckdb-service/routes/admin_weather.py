"""Admin endpoint for triggering the one-shot weather backfill.

Internal only — the backend's ``POST /api/admin/weather/backfill``
is the public boundary and gates the route with ``X-Admin-Key``.
See ADR-017 and ``services/weather_worker.py``'s
``run_weather_backfill`` for the work this dispatches.
"""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from services.weather_worker import run_weather_backfill


admin_weather_bp = Blueprint("admin_weather", __name__)


@admin_weather_bp.post("/admin/weather/backfill")
def post_weather_backfill():
    days_raw = request.args.get("days")
    days: int | None = None
    if days_raw is not None:
        try:
            days = int(days_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "'days' must be an integer"}), 400
        # Cap matches `docs/api-reference.md` §1.8. The lower bound
        # rejects 0/negative so a runaway operator script can't ask
        # for an empty window and silently no-op.
        if days < 1 or days > 36500:
            return jsonify({"error": "'days' must be in [1, 36500]"}), 400

    result = run_weather_backfill(days=days)
    return jsonify(result), 200
