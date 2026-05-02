from flask import Blueprint, jsonify, request

from db.connection import lock, get_conn

heartbeats_bp = Blueprint("heartbeats", __name__)


def _to_int(value, default=None):
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


@heartbeats_bp.post("/heartbeat")
def post_heartbeat():
    """Tiny liveness ping from the ESP — fired hourly. Stores a row in
    module_heartbeats; the dashboard derives lastSeenAt from this table
    so a module that hasn't uploaded an image since noon still shows
    online if it's been heartbeating."""
    if request.is_json:
        data = request.get_json(silent=True) or {}
    else:
        data = request.form.to_dict()

    mac = (data.get("mac") or data.get("esp_id") or "").strip()
    if not mac:
        return jsonify({"error": "missing mac"}), 400

    battery = _to_int(data.get("battery"))
    rssi = _to_int(data.get("rssi"))
    uptime_ms = _to_int(data.get("uptime_ms"))
    free_heap = _to_int(data.get("free_heap"))
    fw_version = (data.get("fw_version") or "")[:40] or None

    print(
        f"[heartbeat] mac={mac} battery={battery} rssi={rssi} "
        f"uptime_ms={uptime_ms} free_heap={free_heap} fw={fw_version}"
    )

    with lock:
        con = get_conn()
        con.execute(
            """
            INSERT INTO module_heartbeats
              (module_id, battery, rssi, uptime_ms, free_heap, fw_version)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            [mac, battery, rssi, uptime_ms, free_heap, fw_version],
        )

    return jsonify({"ok": True}), 200


@heartbeats_bp.get("/heartbeats/<module_id>")
def get_heartbeats(module_id):
    """Return the latest N heartbeats for a module, newest first."""
    limit = _to_int(request.args.get("limit"), default=50) or 50
    limit = max(1, min(limit, 500))

    with lock:
        con = get_conn()
        rows = con.execute(
            """
            SELECT received_at, battery, rssi, uptime_ms, free_heap, fw_version
              FROM module_heartbeats
             WHERE module_id = ?
             ORDER BY received_at DESC
             LIMIT ?
            """,
            [module_id, limit],
        ).fetchall()

    return jsonify({
        "heartbeats": [
            {
                "received_at": r[0].isoformat() if r[0] else None,
                "battery": r[1],
                "rssi": r[2],
                "uptime_ms": r[3],
                "free_heap": r[4],
                "fw_version": r[5],
            }
            for r in rows
        ]
    })


@heartbeats_bp.get("/heartbeats_summary")
def get_heartbeats_summary():
    """Latest heartbeat per module — used to compute lastSeenAt on the
    /modules list endpoint without N+1 queries."""
    with lock:
        con = get_conn()
        rows = con.execute(
            """
            SELECT module_id,
                   MAX(received_at) AS last_seen,
                   ARG_MAX(battery, received_at) AS battery,
                   ARG_MAX(rssi, received_at) AS rssi,
                   ARG_MAX(uptime_ms, received_at) AS uptime_ms,
                   ARG_MAX(free_heap, received_at) AS free_heap,
                   ARG_MAX(fw_version, received_at) AS fw_version
              FROM module_heartbeats
          GROUP BY module_id
            """
        ).fetchall()

    return jsonify({
        "summary": {
            r[0]: {
                "last_seen": r[1].isoformat() if r[1] else None,
                "battery": r[2],
                "rssi": r[3],
                "uptime_ms": r[4],
                "free_heap": r[5],
                "fw_version": r[6],
            }
            for r in rows
        }
    })
