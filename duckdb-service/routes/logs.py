"""Internal admin-gated server-log tail for duckdb-service (#171).

Returns this service's own recent stdout/stderr (the `log_ring` tee). The
backend's `GET /api/admin/logs?service=duckdb-service` proxies here, forwarding
the `X-Admin-Key` machine credential. The route is auth-gated because the
service's port is published on the dev host (`:8002`) and logs can leak request
metadata. See ADR-021.
"""

import hmac
import os

from flask import Blueprint, jsonify, request

from services.log_ring import get_recent

logs_bp = Blueprint("logs", __name__)

SERVICE_NAME = "duckdb-service"
_DEV_FALLBACK_KEY = "hf_dev_key_2026"
_LINES_CAP = 1000
_LINES_DEFAULT = 200


def _resolve_key() -> str:
    # Mirror backend/src/auth.ts: env HIGHFIVE_API_KEY (trimmed) or the public
    # dev fallback. Both services resolve the same value, so the backend's
    # forwarded X-Admin-Key matches.
    return (os.getenv("HIGHFIVE_API_KEY") or "").strip() or _DEV_FALLBACK_KEY


@logs_bp.get("/logs")
def get_logs():
    provided = request.headers.get("X-Admin-Key", "")
    if not hmac.compare_digest(provided, _resolve_key()):
        return jsonify({"error": "unauthorized"}), 401

    try:
        n = int(request.args.get("lines", _LINES_DEFAULT))
    except (TypeError, ValueError):
        n = _LINES_DEFAULT
    n = max(1, min(n, _LINES_CAP))

    lines, truncated = get_recent(n)
    return jsonify(
        {"service": SERVICE_NAME, "lines": lines, "truncated": truncated}
    ), 200
